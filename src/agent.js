// The agent loop: ask Claude, run the tools it calls, feed the results back, repeat.
import Anthropic from "@anthropic-ai/sdk";
import {
  getConfig,
  apiKey,
  getConversation,
  saveConversation,
  createConversation,
  newId,
} from "./store.js";
import { toolDefinitions, systemPrompt, executeTool, validateInput, needsApproval } from "./tools.js";

const MAX_TURNS = Number(process.env.AGENT_MAX_TURNS || 80); // model calls per run
const MAX_TOKENS = 64_000;
// Models that can hand a declined request to another model on the server.
const FALLBACK_MODELS = new Set([
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-fable-5-2",
  "claude-fable-5-1",
  "claude-sonnet-5-5",
]);

// Live state of each conversation: who is listening, and what is in flight.
const runs = new Map();

function runState(id) {
  if (!runs.has(id)) {
    runs.set(id, { running: false, abort: null, listeners: new Set(), partial: [], approvals: new Map() });
  }
  return runs.get(id);
}

function emit(id, event) {
  const run = runState(id);
  // Keep the in-flight streamed text so a page opened mid-answer can catch up.
  if (event.type === "delta") run.partial.push(event);
  if (event.type === "assistant" || event.type === "reset") run.partial = [];
  for (const listener of run.listeners) listener(event);
}

export function subscribe(id, listener) {
  const run = runState(id);
  run.listeners.add(listener);
  return () => run.listeners.delete(listener);
}

export function liveState(id) {
  const run = runState(id);
  return {
    running: run.running,
    partial: run.partial,
    approvals: [...run.approvals.values()].map((a) => a.info),
  };
}

export const isRunning = (id) => runState(id).running;
export const awaitingApproval = (id) => runState(id).approvals.size > 0;

export function stopRun(id) {
  runState(id).abort?.abort();
}

export function resolveApproval(id, approvalId, decision) {
  const pending = runState(id).approvals.get(approvalId);
  if (!pending) return false;
  pending.resolve(decision);
  return true;
}

function requestParams(cfg, conv, tools) {
  const betas = ["compact-2026-01-12"];
  const params = {
    model: cfg.model,
    max_tokens: MAX_TOKENS,
    system: systemPrompt(cfg),
    tools,
    messages: conv.messages,
    thinking: { type: "adaptive", display: "summarized" },
    output_config: { effort: cfg.effort },
    cache_control: { type: "ephemeral" },
    // Long conversations are summarised on the server instead of overflowing.
    context_management: { edits: [{ type: "compact_20260112" }] },
    betas,
  };
  if (FALLBACK_MODELS.has(cfg.model)) {
    betas.push("server-side-fallback-2026-07-01");
    params.fallbacks = "default";
  }
  if (cfg.mcpServers.length) {
    betas.push("mcp-client-2025-11-20");
    params.mcp_servers = cfg.mcpServers.map((s) => ({
      type: "url",
      name: s.name,
      url: s.url,
      ...(s.token ? { authorization_token: s.token } : {}),
    }));
  }
  return params;
}

function describeError(err) {
  if (err instanceof Anthropic.AuthenticationError) return "The Anthropic API key was rejected. Check it under Settings.";
  if (err instanceof Anthropic.PermissionDeniedError) return `The API key is not allowed to do this: ${err.message}`;
  if (err instanceof Anthropic.RateLimitError) return "Anthropic's rate limit was reached. Wait a minute and try again.";
  if (err instanceof Anthropic.BadRequestError) return `Anthropic rejected the request: ${err.message}`;
  if (err instanceof Anthropic.APIConnectionError) return "Could not reach Anthropic. Check the internet connection.";
  if (err instanceof Anthropic.APIError) return `Anthropic returned an error (${err.status ?? "no status"}): ${err.message}`;
  return err.message || String(err);
}

// Asks the user (through the page) whether a tool call may run.
function askApproval(conv, run, call) {
  if (getConfig().approvalMode === "auto" || conv.allowed.includes(call.name)) return Promise.resolve("allow");
  if (run.abort.signal.aborted) return Promise.resolve("deny");
  const info = { id: newId(), toolUseId: call.id, name: call.name, input: call.input };
  return new Promise((resolve) => {
    const finish = (decision) => {
      run.approvals.delete(info.id);
      run.abort.signal.removeEventListener("abort", onAbort);
      emit(conv.id, { type: "approval_done", id: info.id, decision });
      resolve(decision);
    };
    const onAbort = () => finish("deny");
    run.abort.signal.addEventListener("abort", onAbort, { once: true });
    run.approvals.set(info.id, { info, resolve: finish });
    emit(conv.id, { type: "approval", approval: info });
  });
}

async function runTool(conv, run, call) {
  const result = (content, is_error = false) => ({
    type: "tool_result",
    tool_use_id: call.id,
    content,
    ...(is_error ? { is_error: true } : {}),
  });
  if (run.abort.signal.aborted) return result("Cancelled by the user.", true);

  const problem = validateInput(call.name, call.input);
  if (problem) return result(JSON.stringify({ INVALID_JSON: JSON.stringify(call.input), problem }), true);

  if (needsApproval(call.name, call.input)) {
    const decision = await askApproval(conv, run, call);
    if (decision === "always" && !conv.allowed.includes(call.name)) conv.allowed.push(call.name);
    if (decision === "deny") {
      return result(
        run.abort.signal.aborted ? "Cancelled by the user." : "The user declined this action. Do not retry it another way; ask what they would like instead.",
        true,
      );
    }
  }
  try {
    return result(await executeTool(call.name, call.input, { signal: run.abort.signal }));
  } catch (err) {
    return result(`Error: ${err.message}`, true);
  }
}

async function loop(conv, run) {
  const cfg = getConfig();
  const key = apiKey(cfg);
  const client = new Anthropic(key ? { apiKey: key } : {});
  const tools = await toolDefinitions(cfg);
  let badInputRetries = 0;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    if (run.abort.signal.aborted) return;

    const stream = client.beta.messages.stream(requestParams(cfg, conv, tools), { signal: run.abort.signal });
    stream.on("streamEvent", (event) => {
      if (event.type === "content_block_start" && /tool_use$/.test(event.content_block.type)) {
        emit(conv.id, { type: "delta", kind: "tool", text: event.content_block.name });
      } else if (event.type === "content_block_delta") {
        if (event.delta.type === "text_delta") emit(conv.id, { type: "delta", kind: "text", text: event.delta.text });
        if (event.delta.type === "thinking_delta") emit(conv.id, { type: "delta", kind: "thinking", text: event.delta.thinking });
      }
    });

    let message;
    try {
      message = await stream.finalMessage();
      badInputRetries = 0;
    } catch (err) {
      if (run.abort.signal.aborted) return;
      // A tool input that could not be parsed, or a dropped connection: ask again.
      if (err instanceof Anthropic.APIError || badInputRetries++ >= 2) throw err;
      emit(conv.id, { type: "reset" });
      continue;
    }

    conv.usage.input += message.usage?.input_tokens ?? 0;
    conv.usage.output += message.usage?.output_tokens ?? 0;
    conv.messages.push({ role: "assistant", content: message.content });
    saveConversation(conv);
    emit(conv.id, { type: "assistant", content: message.content });

    if (message.stop_reason === "refusal") {
      emit(conv.id, { type: "notice", text: "The model declined to continue with this request." });
      return;
    }
    // A long server-side step (web search and the like) paused; asking again resumes it.
    if (message.stop_reason === "pause_turn") continue;

    const calls = message.content.filter((block) => block.type === "tool_use");
    if (!calls.length) {
      if (message.stop_reason === "max_tokens") {
        emit(conv.id, { type: "notice", text: "The reply hit the length limit and was cut off. Ask it to continue." });
      }
      return;
    }

    const results = [];
    for (const call of calls) {
      // An input cut off at the length limit can look valid, so never run it.
      const result =
        message.stop_reason === "max_tokens"
          ? { type: "tool_result", tool_use_id: call.id, is_error: true, content: "This tool call was cut off at the output limit and did not run. Try again with a smaller input, split into steps." }
          : await runTool(conv, run, call);
      results.push(result);
      emit(conv.id, { type: "tool_result", result });
    }
    conv.messages.push({ role: "user", content: results });
    saveConversation(conv);
  }
  emit(conv.id, { type: "notice", text: `Stopped after ${MAX_TURNS} steps. Say "continue" to keep going.` });
}

// Starts a run in the background and returns at once. Progress goes out through emit().
export function startRun(id, text, { keepTitle = false } = {}) {
  const run = runState(id);
  if (run.running) throw new Error("The agent is still working in this conversation.");
  const conv = getConversation(id);
  if (!conv) throw new Error("Conversation not found.");

  if (!conv.messages.length && !keepTitle) conv.title = text.replace(/\s+/g, " ").slice(0, 60) || "New chat";
  conv.messages.push({ role: "user", content: text });
  saveConversation(conv);

  run.running = true;
  run.abort = new AbortController();
  emit(id, { type: "user", text, title: conv.title });
  emit(id, { type: "status", running: true });

  const done = loop(conv, run)
    .catch((err) => {
      console.error(`Run failed in conversation ${id}:`, err);
      emit(id, { type: "error", text: describeError(err) });
    })
    .finally(() => {
      run.running = false;
      run.partial = [];
      saveConversation(conv);
      emit(id, { type: "status", running: false, usage: conv.usage });
    });
  return { conversation: conv, done };
}

// A scheduled job runs in its own new conversation, with no one watching.
export function runJob(job) {
  const conv = createConversation({ title: `⏰ ${job.name}`, source: "schedule", jobId: job.id });
  const text = `[Scheduled job "${job.name}", started automatically at ${new Date().toString()}. No one is watching live. Do the task, then finish with a short report of what you did and anything that needs the user's attention.]\n\n${job.prompt}`;
  const { done } = startRun(conv.id, text, { keepTitle: true });
  return { conversation: conv, done };
}

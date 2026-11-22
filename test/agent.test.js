import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startMockApi, say, call } from "./mock-api.js";

const script = [];
let mock, store, agent, tools;

before(async () => {
  mock = await startMockApi(script);
  process.env.AGENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "agent-test-"));
  process.env.ANTHROPIC_BASE_URL = mock.url;
  process.env.ANTHROPIC_API_KEY = "test-key";
  store = await import("../src/store.js");
  agent = await import("../src/agent.js");
  tools = await import("../src/tools.js");
  store.initStore();
});
after(() => mock.server.close());

const lastResult = (conv) => conv.messages.findLast((m) => Array.isArray(m.content) && m.content[0]?.type === "tool_result").content[0];

test("runs a tool the model asks for and feeds the result back", async () => {
  store.saveConfig({ approvalMode: "auto" });
  script.push(call("bash", { command: "echo hello > note.txt && cat note.txt" }), say("Done."));
  const conv = store.createConversation();
  const events = [];
  agent.subscribe(conv.id, (e) => events.push(e));
  await agent.startRun(conv.id, "make a note").done;

  const saved = store.getConversation(conv.id);
  assert.equal(saved.title, "make a note");
  assert.deepEqual(saved.messages.map((m) => m.role), ["user", "assistant", "user", "assistant"]);
  assert.match(lastResult(saved).content, /hello/);
  assert.match(lastResult(saved).content, /exit code 0/);
  assert.equal(fs.readFileSync(path.join(store.WORKSPACE, "note.txt"), "utf8"), "hello\n");
  assert.ok(events.some((e) => e.type === "delta" && e.kind === "text"));
  assert.equal(events.at(-1).type, "status");
  assert.equal(events.at(-1).running, false);

  const request = mock.requests.at(-1);
  assert.equal(request.body.model, "claude-opus-5-5");
  assert.equal(request.body.fallbacks, "default");
  assert.match(request.headers["anthropic-beta"], /compact-2026-01-12/);
  assert.match(request.headers["anthropic-beta"], /server-side-fallback-2026-07-01/);
  assert.ok(request.body.tools.some((t) => t.type === "web_search_20260209"));
  // The second request carries the tool result back.
  assert.equal(request.body.messages.at(-1).content[0].type, "tool_result");
});

test("in ask mode a risky tool waits, and a refusal is reported to the model", async () => {
  store.saveConfig({ approvalMode: "ask" });
  script.push(call("bash", { command: "touch should-not-exist.txt" }), say("Understood."));
  const conv = store.createConversation();
  agent.subscribe(conv.id, (e) => {
    if (e.type === "approval") {
      assert.equal(agent.awaitingApproval(conv.id), true);
      agent.resolveApproval(conv.id, e.approval.id, "deny");
    }
  });
  await agent.startRun(conv.id, "try it").done;
  const result = lastResult(store.getConversation(conv.id));
  assert.equal(result.is_error, true);
  assert.match(result.content, /declined/);
  assert.equal(fs.existsSync(path.join(store.WORKSPACE, "should-not-exist.txt")), false);
});

test("'always allow' is remembered for the conversation; reading never asks", async () => {
  script.push(call("bash", { command: "echo one" }), call("bash", { command: "echo two" }), call("str_replace_based_edit_tool", { command: "view", path: "." }), say("ok"));
  const conv = store.createConversation();
  let asked = 0;
  agent.subscribe(conv.id, (e) => {
    if (e.type === "approval") {
      asked++;
      agent.resolveApproval(conv.id, e.approval.id, "always");
    }
  });
  await agent.startRun(conv.id, "go").done;
  assert.equal(asked, 1);
  assert.deepEqual(store.getConversation(conv.id).allowed, ["bash"]);
});

test("bad tool input is returned as an error instead of being run", async () => {
  store.saveConfig({ approvalMode: "auto" });
  script.push(call("memory", { action: "explode" }), say("ok"));
  const conv = store.createConversation();
  await agent.startRun(conv.id, "go").done;
  const result = lastResult(store.getConversation(conv.id));
  assert.equal(result.is_error, true);
  assert.match(result.content, /INVALID_JSON/);
});

test("stopping a run cancels the waiting tool and leaves a valid history", async () => {
  store.saveConfig({ approvalMode: "ask" });
  script.push(call("bash", { command: "echo never" }));
  const conv = store.createConversation();
  agent.subscribe(conv.id, (e) => e.type === "approval" && agent.stopRun(conv.id));
  await agent.startRun(conv.id, "go").done;
  const saved = store.getConversation(conv.id);
  assert.equal(saved.messages.at(-1).role, "user");
  assert.match(lastResult(saved).content, /Cancelled/);
  assert.equal(agent.isRunning(conv.id), false);
});

test("files cannot leave the workspace", async () => {
  assert.throws(() => tools.safePath("../outside.txt"), /outside the workspace/);
  assert.throws(() => tools.safePath("/etc/passwd"), /outside the workspace/);
  fs.symlinkSync("/etc", path.join(store.WORKSPACE, "sneaky"));
  assert.throws(() => tools.safePath("sneaky/passwd"), /outside the workspace/);
  assert.equal(tools.safePath("a/b.txt"), path.join(fs.realpathSync(store.WORKSPACE), "a/b.txt"));
  const out = await tools.executeTool("str_replace_based_edit_tool", { command: "create", path: "a/b.txt", file_text: "x\ny\n" });
  assert.match(out, /Wrote/);
  await tools.executeTool("str_replace_based_edit_tool", { command: "str_replace", path: "a/b.txt", old_str: "y", new_str: "z" });
  assert.equal(fs.readFileSync(path.join(store.WORKSPACE, "a/b.txt"), "utf8"), "x\nz\n");
});

test("secrets are only filled in for their own host", () => {
  const secrets = { KEY: { value: "s3cret", host: "api.example.com" } };
  assert.equal(tools.fillSecrets("Bearer {{secret:KEY}}", "api.example.com", secrets), "Bearer s3cret");
  assert.equal(tools.fillSecrets("{{secret:KEY}}", "v2.api.example.com", secrets), "s3cret");
  assert.throws(() => tools.fillSecrets("{{secret:KEY}}", "evil.com", secrets), /only be sent to/);
  assert.throws(() => tools.fillSecrets("{{secret:KEY}}", "evilapi.example.com.evil.com", secrets), /only be sent to/);
  assert.throws(() => tools.fillSecrets("{{secret:NOPE}}", "api.example.com", secrets), /No secret/);
});

test("the shell does not see the agent's own API key", async () => {
  const out = await tools.executeTool("bash", { command: 'echo "key=[$ANTHROPIC_API_KEY]"' });
  assert.match(out, /key=\[\]/);
});

test("memory and skills appear in the system prompt", () => {
  store.addMemory("The user writes mystery novels.");
  store.saveSkill({ name: "Weekly Report", description: "How to build the weekly report", content: "1. ..." });
  const prompt = tools.systemPrompt();
  assert.match(prompt, /mystery novels/);
  assert.match(prompt, /weekly-report: How to build/);
});

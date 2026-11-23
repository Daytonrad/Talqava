// Memory and context: ranked search, spaces, what goes into the prompt, and
// summaries of long conversations for local models.
import { test } from "node:test";
import assert from "node:assert/strict";
import { OpenAICompatibleModel, conversationSearchTool, memoryTool, rank, selectMemory, systemPrompt } from "../../src/core/index.ts";
import type { Conversation, ConversationSummary, MemoryEntry, Message, SearchScope } from "../../src/core/index.ts";
import { MemoryConversations, MemoryNotes } from "../memory-stores.ts";
import { startMockChat } from "../mock-openai.ts";
import type { ChatReply } from "../mock-openai.ts";

const entry = (id: string, text: string, space?: string): MemoryEntry => ({ id, text, createdAt: "2026-01-01T00:00:00Z", ...(space ? { space } : {}) });
const inChat = (extra: Partial<Conversation> = {}) => ({ signal: new AbortController().signal, conversation: { id: "c1", ...extra } as Conversation });

test("search matches words in any order and form, best match first", () => {
  const notes = ["We agreed the price is $40 a month.", "The dog is called Biscuit.", "Pricing for the annual plan was discussed; prices go up in March.", "Nothing to do with it."];
  const found = rank("annual pricing", notes, (n) => n).map((r) => r.item);
  assert.equal(found[0], notes[2]); // both words, in other forms and another order
  assert.ok(found.includes(notes[0])); // "price" is found by "pricing"
  assert.ok(!found.includes(notes[1]) && !found.includes(notes[3]));
  assert.deepEqual(rank("the of and", notes, (n) => n), []); // filler words alone find nothing
});

test("a conversation sees General's memory and its own space's, never another space's", async () => {
  const all = [entry("g", "The user prefers short answers."), entry("a", "Acme's launch is in May.", "acme"), entry("b", "Birch owes an invoice.", "birch")];
  assert.deepEqual(selectMemory(all, "acme", "").shown.map((e) => e.id), ["g", "a"]);
  assert.deepEqual(selectMemory(all, undefined, "").shown.map((e) => e.id), ["g"]);

  const prompt = systemPrompt({ agentName: "T", setting: "here", environment: [], memory: selectMemory(all, "acme", "").shown, space: { id: "acme", name: "Acme" }, skills: [] });
  assert.match(prompt, /\(Acme\) Acme's launch/);
  assert.match(prompt, /\(general\) The user prefers/);
  assert.doesNotMatch(prompt, /Birch/);
});

test("when memory outgrows the prompt, what fits the conversation is shown and the rest is one search away", async () => {
  const many = Array.from({ length: 300 }, (_, i) => entry(`m${i}`, `Note ${i}: the supplier for part ${i} is company number ${i}, and nothing else of interest.`));
  many.splice(40, 0, entry("vet", "The cat Miso sees the vet every October."));
  const { shown, hidden } = selectMemory(many, undefined, "when is the cat due at the vet?");
  assert.ok(hidden > 0 && shown.length < many.length);
  assert.ok(shown.some((e) => e.id === "vet"), "the relevant entry is shown though it is old");
  assert.ok(shown.some((e) => e.id === "m299"), "the newest entries are shown too");
  assert.match(systemPrompt({ agentName: "T", setting: "here", environment: [], memory: shown, hiddenMemory: hidden, skills: [] }), /more entries are saved but not listed/);

  // The memory tool finds what is not listed.
  const notes = new MemoryNotes();
  notes.items = many;
  assert.match(String(await memoryTool(notes).run({ action: "search", query: "supplier part 123" }, inChat())), /\[m123\]/);
});

test("the memory tool saves to the chat's space, can save to General, and updates in place", async () => {
  const notes = new MemoryNotes();
  const tool = memoryTool(notes);
  await tool.run({ action: "add", text: "Acme wants weekly reports." }, inChat({ space: "acme" }));
  await tool.run({ action: "add", text: "The user is based in Leeds.", scope: "general" }, inChat({ space: "acme" }));
  assert.deepEqual(notes.items.map((e) => e.space), ["acme", undefined]);

  const out = String(await tool.run({ action: "update", id: notes.items[0].id, text: "Acme wants monthly reports." }, inChat({ space: "acme" })));
  assert.match(out, /Updated/);
  assert.equal(notes.items[0].text, "Acme wants monthly reports.");
  assert.equal(notes.items.length, 2);
  // Another space cannot find Acme's entry.
  assert.match(String(await tool.run({ action: "search", query: "reports" }, inChat({ space: "birch" }))), /Nothing saved/);
});

test("searching past conversations is kept to the chat's space", async () => {
  let seen: SearchScope | undefined;
  const store = new MemoryConversations();
  store.search = async (_q?: string, _l?: number, scope?: SearchScope) => ((seen = scope), []);
  await conversationSearchTool(store).run({ query: "pricing" }, inChat({ id: "c9", space: "acme" }));
  assert.deepEqual(seen, { space: "acme", exclude: "c9" });
});

test("a local model gets a summary of the older part of a long conversation, which is reused and then extended", async () => {
  const script: ChatReply[] = [];
  const mock = await startMockChat(script);
  const kept = new Map<string, ConversationSummary>();
  const model = new OpenAICompatibleModel({ providerId: "local", providerName: "Test runner", baseUrl: mock.url, model: "tiny", contextTokens: 3000, maxTokens: 500, summaries: { get: (k) => kept.get(k), set: (k, v) => void kept.set(k, v) } });
  const callbacks = { onText() {}, onThinking() {}, onToolStart() {} };
  const turn = (i: number): Message[] => [
    { role: "user", content: `Question ${i}: ${"tell me more about the harbour plan. ".repeat(20)}` },
    { role: "assistant", content: [{ type: "text", text: `Answer ${i}: ${"the harbour plan has many parts. ".repeat(20)}` }] } as Message,
  ];
  const messages: Message[] = [{ role: "user", content: "My budget is 4,200 pounds and the deadline is 9 June." }, { role: "assistant", content: [{ type: "text", text: "Noted." }] } as Message];
  for (let i = 0; i < 8; i++) messages.push(...turn(i));
  messages.push({ role: "user", content: "What was my budget?" });
  const ask = () => model.call({ system: "You are T.", messages, tools: [], hostedTools: [], mcpServers: [], signal: new AbortController().signal }, callbacks);

  try {
    // 1. Too long: the model is first asked for a summary, then for the reply.
    script.push({ text: "<think>hmm</think>The user's budget is 4,200 pounds; deadline 9 June. They asked about the harbour plan.", usage: { prompt_tokens: 50, completion_tokens: 10 } }, { text: "4,200 pounds." });
    const reply = await ask();
    assert.equal(mock.requests.length, 2);
    assert.equal(mock.requests[0].body.stream, false);
    assert.match(mock.requests[0].body.messages[1].content, /Question 0/);
    const sent = JSON.stringify(mock.requests[1].body.messages);
    assert.match(sent, /Summary so far:\]\\nThe user's budget is 4,200 pounds/);
    assert.doesNotMatch(sent, /<think>/);
    assert.doesNotMatch(sent, /Question 0:/); // the older turns are in the summary, not sent whole
    assert.match(sent, /What was my budget\?/); // the latest message is whole
    assert.doesNotMatch(sent, /shortened to fit/); // nothing was cut off mid-text
    assert.deepEqual(reply.usage, { input: 150, output: 30 }); // the summary's cost is counted
    // The roles still take turns, and no tool result is left without its call.
    const roles = mock.requests[1].body.messages.map((m: { role: string }) => m.role);
    assert.ok(roles.every((r: string, i: number) => i === 0 || r !== roles[i - 1]), roles.join(","));

    // 2. The next message reuses the summary: one request, no new summary.
    messages.push({ role: "assistant", content: [{ type: "text", text: "4,200 pounds." }] } as Message, { role: "user", content: "And the deadline?" });
    script.push({ text: "9 June." });
    await ask();
    assert.equal(mock.requests.length, 3);
    assert.match(JSON.stringify(mock.requests[2].body.messages), /Summary so far/);

    // 3. Much later it outgrows the model again: the summary is extended, from the old summary and the new part.
    for (let i = 8; i < 16; i++) messages.push(...turn(i));
    messages.splice(-16, 0, { role: "assistant", content: [{ type: "text", text: "9 June." }] } as Message);
    messages.push({ role: "user", content: "Remind me of both." });
    script.push({ text: "Budget 4,200 pounds, deadline 9 June, long talk about the harbour plan." }, { text: "4,200 pounds and 9 June." });
    await ask();
    assert.equal(mock.requests.length, 5);
    assert.match(mock.requests[3].body.messages[1].content, /Summary so far:\nThe user's budget is 4,200 pounds/);
    assert.match(JSON.stringify(mock.requests[4].body.messages), /long talk about the harbour plan/);

    // 4. If the summary cannot be made, the conversation is shortened as before instead of failing.
    kept.clear();
    script.push({ status: 500 }, { text: "ok" });
    await ask();
    assert.match(JSON.stringify(mock.requests.at(-1)!.body.messages), /shortened to fit/);
  } finally {
    mock.server.close();
  }
});

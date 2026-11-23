// The local edition: file storage, the shell and file tools, and a full run through them.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Conversation, ToolResult } from "../../src/core/index.ts";
import { startMockApi, say, call } from "../mock-api.ts";
import type { Reply } from "../mock-api.ts";

const script: Reply[] = [];
let mock: Awaited<ReturnType<typeof startMockApi>>;
let store: typeof import("../../src/local/store.ts");
let tools: typeof import("../../src/local/tools.ts");
let app: typeof import("../../src/local/server.ts");
const context = { signal: new AbortController().signal, conversation: {} as Conversation };

before(async () => {
  mock = await startMockApi(script);
  // Set before the local modules load, because they read these once at start-up.
  process.env.TALQAVA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "talqava-test-"));
  process.env.ANTHROPIC_BASE_URL = mock.url;
  process.env.ANTHROPIC_API_KEY = "test-key";
  store = await import("../../src/local/store.ts");
  tools = await import("../../src/local/tools.ts");
  app = await import("../../src/local/server.ts");
  store.initStore();
});
after(() => mock.server.close());

test("a run uses the real shell in the workspace and saves to disk", async () => {
  store.saveConfig({ approvalMode: "auto" });
  script.push(call("bash", { command: "echo hello > note.txt && cat note.txt" }), say("Done."));
  const conversation = store.conversations.create();
  await (await app.engine.startRun(conversation.id, "make a note")).done;

  const saved = store.conversations.get(conversation.id)!;
  const result = (saved.messages[2].content as ToolResult[])[0];
  assert.match(String(result.content), /hello/);
  assert.match(String(result.content), /exit code 0/);
  assert.equal(fs.readFileSync(path.join(store.WORKSPACE, "note.txt"), "utf8"), "hello\n");
  assert.equal(store.conversations.list()[0].title, "make a note");

  const names = mock.requests.at(-1)!.body.tools.map((t: { name: string }) => t.name);
  for (const name of ["bash", "str_replace_based_edit_tool", "memory", "skill", "schedule", "http_request", "web_search", "web_fetch"]) {
    assert.ok(names.includes(name), `${name} is offered`);
  }
  assert.match(mock.requests.at(-1)!.body.system, /running on the user's own machine/);
});

test("which local tools ask first", () => {
  assert.equal(tools.bashTool.needsApproval({ command: "ls" }), true);
  assert.equal(tools.editorTool.needsApproval({ command: "view", path: "." }), false);
  assert.equal(tools.editorTool.needsApproval({ command: "create", path: "a" }), true);
  assert.equal(tools.bashTool.validate({}), "missing command");
  assert.equal(tools.editorTool.validate({ command: "view" }), "missing command or path");
});

test("files cannot leave the workspace", async () => {
  assert.throws(() => tools.safePath("../outside.txt"), /outside the workspace/);
  assert.throws(() => tools.safePath("/etc/passwd"), /outside the workspace/);
  fs.symlinkSync("/etc", path.join(store.WORKSPACE, "sneaky"));
  assert.throws(() => tools.safePath("sneaky/passwd"), /outside the workspace/);
  assert.equal(tools.safePath("a/b.txt"), path.join(fs.realpathSync(store.WORKSPACE), "a/b.txt"));
  assert.match(String(await tools.editorTool.run({ command: "create", path: "a/b.txt", file_text: "x\ny\n" }, context)), /Wrote/);
  await tools.editorTool.run({ command: "str_replace", path: "a/b.txt", old_str: "y", new_str: "z" }, context);
  assert.equal(fs.readFileSync(path.join(store.WORKSPACE, "a/b.txt"), "utf8"), "x\nz\n");
});

test("the shell does not see the agent's own API key or password", async () => {
  process.env.TALQAVA_PASSWORD = "hunter2";
  const out = await tools.bashTool.run({ command: 'echo "key=[$ANTHROPIC_API_KEY] pw=[$TALQAVA_PASSWORD]"' }, context);
  delete process.env.TALQAVA_PASSWORD;
  assert.match(String(out), /key=\[\] pw=\[\]/);
});

test("memory, skills and jobs are kept in files", async () => {
  const entry = store.memory.add("The user writes mystery novels.");
  store.skills.save({ name: "Weekly Report", description: "How to build the weekly report", content: "1. ..." });
  assert.match(tools.localPrompt(), /mystery novels/);
  assert.match(tools.localPrompt(), /weekly-report: How to build/);
  store.memory.remove(entry.id);
  assert.throws(() => store.memory.remove(entry.id), /No memory entry/);

  const job = await app.jobs.create({ name: "digest", prompt: "do it", schedule: "every 1h" });
  assert.equal(JSON.parse(fs.readFileSync(path.join(store.DATA, "jobs.json"), "utf8"))[0].id, job.id);
  assert.equal(fs.statSync(path.join(store.DATA, "config.json")).mode & 0o777, 0o600);
});

test("spaces keep a client's memory and chats apart, and memory can be edited and moved", async () => {
  const acme = store.spaces.create("Acme");
  const birch = store.spaces.create("Birch");
  assert.throws(() => store.spaces.create("acme"), /already a space/);
  assert.throws(() => store.spaces.create("General"), /General is already there/);

  const general = store.memory.add("The user likes plain language.");
  const fact = store.memory.add("Acme's contract renews in March.", acme.id);
  assert.equal(store.memory.add("Acme's contract renews in March.", acme.id).id, fact.id); // saying it twice saves it once
  assert.throws(() => store.memory.add("x", "nope"), /No such space/);
  assert.throws(() => store.memory.add("y".repeat(2000)), /too long for one memory/);
  // No overall cap: far more than the old two-page limit can be saved.
  for (let i = 0; i < 60; i++) store.memory.add(`Birch fact ${i}: ${"detail ".repeat(30)}`, birch.id);

  // A chat in Acme is given General's and Acme's memory, not Birch's.
  const inAcme = tools.localPrompt(undefined, undefined, [], { space: acme.id, title: "renewal", messages: [] } as unknown as Conversation);
  assert.match(inAcme, /\(Acme\) Acme's contract renews in March/);
  assert.match(inAcme, /plain language/);
  assert.doesNotMatch(inAcme, /Birch fact/);
  assert.doesNotMatch(tools.localPrompt(), /contract renews/);

  // Editing and moving an entry.
  assert.equal(store.memory.update(fact.id, { text: "Acme's contract renews in April." }).text, "Acme's contract renews in April.");
  assert.equal(store.memory.update(fact.id, { space: null }).space, undefined);
  assert.match(tools.localPrompt(), /renews in April/);
  store.memory.update(fact.id, { space: acme.id });

  // Past chats: Acme's chat finds Acme's and General's, not Birch's; General finds all.
  const chat = (title: string, text: string, space?: string) => {
    const c = store.conversations.create({ title, ...(space ? { space } : {}) });
    c.messages.push({ role: "user", content: text });
    store.conversations.save(c);
    return c;
  };
  const a = chat("Acme pricing", "We settled what Acme is charged: 900 a month.", acme.id);
  chat("Birch pricing", "Birch is charged 400 a month.", birch.id);
  chat("General pricing", "My usual charge is 500 a month.");
  const titles = (scope?: { space?: string; exclude?: string }) => store.conversations.search("charges per month", 8, scope).map((h) => h.conversation).sort();
  assert.deepEqual(titles({ space: acme.id }), ["Acme pricing", "General pricing"]);
  assert.deepEqual(titles(), ["Acme pricing", "Birch pricing", "General pricing"]);
  assert.deepEqual(titles({ space: acme.id, exclude: a.id }), ["General pricing"]);

  // Removing a space deletes its memory and moves its chats to General.
  store.spaces.remove(acme.id);
  assert.ok(!store.memory.list().some((e) => e.space === acme.id));
  assert.equal(store.conversations.get(a.id)!.space, undefined);
  store.spaces.remove(birch.id);
  store.memory.remove(general.id);
});

test("a local model gets the page reader instead of Claude's hosted tools, and old settings move to provider refs", async () => {
  const fs = await import("node:fs");
  const file = path.join(store.DATA, "config.json");
  const old = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(file, JSON.stringify({ ...old, model: "claude-sonnet-5-5", providers: undefined }));
  assert.equal(store.getConfig().model, "anthropic/claude-sonnet-5-5");
  assert.deepEqual(store.getConfig().providers.map((p) => p.id), ["anthropic", "local"]);

  const claude = await tools.localRunSpec(app.jobs)({} as Conversation);
  assert.equal(claude.model.ref, "anthropic/claude-sonnet-5-5");
  assert.deepEqual(claude.hostedTools.map((t) => (t as { name: string }).name), ["web_search", "web_fetch"]);
  assert.ok(!claude.tools.some((t) => t.name === "read_page"));

  // A connector that cannot be reached is mentioned to the model, not allowed to stop the run.
  store.saveConfig({ model: "local/llama3.1", mcpServers: [{ name: "x", url: "http://127.0.0.1:65530/mcp" }] });
  const spec = await tools.localRunSpec(app.jobs)({} as Conversation);
  assert.equal(spec.model.kind, "openai");
  assert.equal(spec.model.label, "llama3.1 on Local model runner");
  assert.deepEqual(spec.model.prices, { input: 0, output: 0 });
  assert.deepEqual(spec.hostedTools, []);
  assert.deepEqual(spec.mcpServers, []);
  assert.match(spec.system, /These connectors could not be reached[^\n]*x:/);
  assert.deepEqual(spec.budget, { steps: 40, spend: 1 });
  assert.ok(spec.tools.some((t) => t.name === "read_page"));
  // Every tool can be described to a model other than Claude.
  for (const tool of spec.tools) assert.ok(tool.portable, `${tool.name} has no portable schema`);

  const shown = store.publicConfig();
  assert.ok(!JSON.stringify(shown).includes("test-key"));
  store.saveConfig({ model: "anthropic/claude-opus-5-5", mcpServers: [] });
});

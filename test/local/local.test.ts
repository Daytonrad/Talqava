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
  process.env.CREWLINGS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "crewlings-test-"));
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

test("the shell does not see the agent's own API key", async () => {
  const out = await tools.bashTool.run({ command: 'echo "key=[$ANTHROPIC_API_KEY]"' }, context);
  assert.match(String(out), /key=\[\]/);
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

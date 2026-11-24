// Stage 3: connectors from this machine, core quests, and checks that send a
// bot back to fix its work instead of letting it declare victory.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import { fitToContext } from "../../src/core/models/openai.ts";
import { startMockApi, say, call } from "../mock-api.ts";
import type { Reply } from "../mock-api.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const lastText = (body: any): string => {
  const last = body.messages.at(-1);
  return typeof last.content === "string" ? last.content : "";
};
const firstText = (body: any): string => (typeof body.messages[0].content === "string" ? body.messages[0].content : "");

// The stand-in model plays each quest: a first attempt that is not good enough, then a fix.
let researchLinks = 1;
async function reply(body: any): Promise<Reply> {
  const asked = lastText(body);
  const task = firstText(body);
  const fixing = asked.startsWith("[The quest's check failed") || asked.startsWith("[This quest is now handed");
  const last = body.messages.at(-1);
  if (Array.isArray(last.content) && last.content[0]?.type === "tool_result") return say("Done.");
  if (task.startsWith("Add tests for")) {
    const expected = fixing ? 2 : 3; // the first test is wrong, so the test command fails
    return call("str_replace_based_edit_tool", {
      command: "create",
      path: "add.test.mjs",
      file_text: `import test from "node:test";\nimport assert from "node:assert";\nimport { add } from "./add.mjs";\ntest("adds", () => assert.equal(add(1, 1), ${expected}));\n`,
    });
  }
  if (task.startsWith("Write the changelog")) {
    const hashes = [...task.matchAll(/^- ([0-9a-f]{7,}) /gm)].map((m) => m[1]);
    const covered = fixing ? hashes : hashes.slice(0, 1);
    return call("str_replace_based_edit_tool", { command: "create", path: "CHANGELOG.md", file_text: `# 1.1.0\n\n${covered.map((h) => `- A change (${h})`).join("\n")}\n` });
  }
  if (task.startsWith("Triage the open issues")) return say(fixing ? "#3 is a bug. #12 is a feature request." : "#3 is a bug.");
  if (task.startsWith("Research this question")) {
    const n = asked.startsWith("[This quest is now handed") ? 3 : researchLinks;
    return say(`Use a queue. Sources: ${["https://a.example/one", "https://b.example/two", "https://c.example/three"].slice(0, n).join(", ")}`);
  }
  return say("ok");
}

let mock: Awaited<ReturnType<typeof startMockApi>>;
let github: http.Server;
let store: typeof import("../../src/local/store.ts");
let runner: typeof import("../../src/local/quests.ts");
let templates: typeof import("../../src/local/templates.ts");
let connectors: typeof import("../../src/local/connectors.ts");
let repo: string;
const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();

before(async () => {
  mock = await startMockApi(reply);
  // A stand-in for GitHub's API: two open issues and one pull request (which is not an issue).
  github = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url?.startsWith("/repos/acme/app/issues")) {
      res.end(JSON.stringify([
        { number: 3, title: "Crash on empty input", created_at: "2026-11-01T00:00:00Z", comments: 2, labels: [], body: "It crashes." },
        { number: 12, title: "Add dark mode", created_at: "2026-11-02T00:00:00Z", comments: 0, labels: [{ name: "idea" }], body: "" },
        { number: 120, title: "A pull request", created_at: "2026-11-03T00:00:00Z", comments: 0, labels: [], body: "", pull_request: {} },
      ]));
    } else res.end("[]");
  });
  await new Promise<void>((r) => github.listen(0, "127.0.0.1", r));
  process.env.TALQAVA_GITHUB_API = `http://127.0.0.1:${(github.address() as AddressInfo).port}`;
  process.env.TALQAVA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "talqava-stage3-"));
  process.env.ANTHROPIC_BASE_URL = mock.url;
  process.env.ANTHROPIC_API_KEY = "test-key";
  store = await import("../../src/local/store.ts");
  await import("../../src/local/server.ts");
  runner = await import("../../src/local/quests.ts");
  templates = await import("../../src/local/templates.ts");
  connectors = await import("../../src/local/connectors.ts");
  store.initStore();
  // These tests script each reply the agent gets, so the check before a task starts (one extra model call) is off; it has its own test.
  store.saveConfig({ checkFirst: false });

  // A bot that may change files without asking, and one that researches.
  fs.mkdirSync(path.join(store.DATA, "crew"), { recursive: true });
  fs.writeFileSync(path.join(store.DATA, "crew", "fixer.yaml"), "name: Fixer\ntype: maker\ninstructions: Fix things.\npowers: [files, shell]\napprovals: run-everything\n");
  fs.writeFileSync(path.join(store.DATA, "crew", "seeker.yaml"), "name: Seeker\ntype: scout\ninstructions: Find things.\npowers: [memory]\nmodel: anthropic/claude-haiku-5-5\n");

  repo = fs.mkdtempSync(path.join(os.tmpdir(), "talqava-s3repo-"));
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  git("config", "user.email", "dev@example.com");
  git("config", "user.name", "Dev");
  fs.writeFileSync(path.join(repo, "add.mjs"), "export const add = (a, b) => a + b;\n");
  git("add", ".");
  git("commit", "-q", "-m", "First version");
  git("tag", "v1.0.0");
  fs.writeFileSync(path.join(repo, "README.md"), "# app\n");
  git("add", ".");
  git("commit", "-q", "-m", "Add a readme");
  fs.writeFileSync(path.join(repo, "sub.mjs"), "export const sub = (a, b) => a - b;\n");
  git("add", ".");
  git("commit", "-q", "-m", "Add subtraction");
  store.saveConfig({ projects: [repo] });
});
after(async () => {
  await connectors.closeConnectors();
  mock.server.close();
  github.close();
});

const bot = async (id: string) => (await import("../../src/local/crew.ts")).loadCrew(repo).bots.find((b) => b.id === id)!;
/** Waits until the quest is finished and checked (or has used up its tries). */
async function settled(id: string) {
  for (let i = 0; i < 400; i++) {
    const q = runner.questStore.get(id)!;
    if (q.status === "done" && !q.checking && q.check && (q.check.passed || q.template!.tries >= q.template!.maxTries)) return q;
    await sleep(25);
  }
  throw new Error("quest did not settle");
}

test("the five core quests are valid, and inputs are filled in", () => {
  const all = templates.loadTemplates();
  assert.deepEqual(all.map((t) => t.id).sort(), ["add-tests", "changelog", "morning-report", "research", "triage"]);
  const addTests = all.find((t) => t.id === "add-tests")!;
  assert.throws(() => templates.resolveInputs(addTests, {}), /needs: File to test/);
  assert.deepEqual(templates.resolveInputs(addTests, { file: "src/a.ts" }), { file: "src/a.ts", command: "npm test" });
  assert.equal(templates.fill("Add tests for {{file}} {{unknown}}", { file: "x" }), "Add tests for x ");
});

test("the check rules: exact issue numbers, distinct sources", async () => {
  const { missingFrom, linkedSources } = await import("../../src/local/checks.ts");
  assert.deepEqual(missingFrom("see #120 and abc1234", ["#12", "#120", "abc1234"]), ["#12"]);
  assert.deepEqual(linkedSources("https://a.example/x, https://www.a.example/x/ and (https://b.example/y)."), ["a.example/x", "b.example/y"]);
});

test("a failed test command sends the bot back; the quest counts as done only when the tests pass", async () => {
  const template = templates.findTemplate("add-tests");
  const quest = await runner.quests.startTemplate({ template, bot: await bot("fixer"), given: { file: "add.mjs", command: "node --test" }, project: repo });
  assert.equal(quest.title, "Add tests for a file: add.mjs");
  const done = await settled(quest.id);
  assert.equal(done.check!.passed, true);
  assert.equal(done.template!.tries, 1);
  const checks = runner.journal.read(quest.id).filter((e) => e.type === "check").map((e) => e.passed);
  assert.deepEqual(checks, [false, true]);
  const conversation = store.conversations.get(quest.id)!;
  const feedback = conversation.messages.find((m) => typeof m.content === "string" && m.content.startsWith("[The quest's check failed"))!;
  assert.match(String(feedback.content), /`node --test` passes: failed/);
  // The user's own repository is untouched until they keep the changes.
  assert.ok(!fs.existsSync(path.join(repo, "add.test.mjs")));
});

test("the changelog must cover every commit since the last tag", async () => {
  const template = templates.findTemplate("changelog");
  const quest = await runner.quests.startTemplate({ template, bot: await bot("fixer"), given: {}, project: repo });
  assert.equal(quest.template!.inputs.since, "v1.0.0");
  assert.equal(quest.template!.mustMention.length, 2);
  const done = await settled(quest.id);
  assert.equal(done.check!.passed, true);
  assert.equal(done.template!.tries, 1);
  assert.deepEqual(done.check!.items.map((i) => i.label), ["Changed CHANGELOG.md", "Covers all 2 gathered items"]);
});

test("triage gathers the open issues from GitHub and must cover each one", async () => {
  const template = templates.findTemplate("triage");
  const quest = await runner.quests.startTemplate({ template, bot: await bot("fixer"), given: { repo: "acme/app" } });
  assert.deepEqual(quest.template!.mustMention, ["#3", "#12"]); // the pull request is not an issue
  const done = await settled(quest.id);
  assert.equal(done.check!.passed, true);
  assert.equal(done.template!.tries, 1);
});

test("a quest that keeps failing its check can be handed to Claude, which finishes it", async () => {
  researchLinks = 1;
  const template = templates.findTemplate("research");
  const quest = await runner.quests.startTemplate({ template, bot: await bot("seeker"), given: { question: "Which queue?" } });
  const failed = await settled(quest.id);
  assert.equal(failed.check!.passed, false);
  assert.equal(failed.template!.tries, 2); // sent back twice, then it stops trying
  assert.match(failed.check!.items[0].detail!, /^1 found/);

  await runner.quests.escalate(quest.id, "anthropic/claude-sonnet-5-5");
  const done = await settled(quest.id);
  assert.equal(done.check!.passed, true);
  assert.equal(done.modelOverride, "anthropic/claude-sonnet-5-5");
  assert.equal(mock.requests.at(-1)!.body.model, "claude-sonnet-5-5");
});

test("connectors run from this machine: read-only tools run freely, others ask, failures are reported", async () => {
  const fixture = path.join(import.meta.dirname, "../fixtures/demo-mcp.ts");
  const { tools, problems } = await connectors.connectorTools([
    { name: "demo", url: "", command: process.execPath, args: [fixture] },
    { name: "gone", url: "http://127.0.0.1:65530/mcp" },
  ]);
  assert.deepEqual(tools.map((t) => t.name).sort(), ["demo__echo", "demo__fail", "demo__save_note"]);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^gone: /);
  const echo = tools.find((t) => t.name === "demo__echo")!;
  assert.equal(echo.needsApproval({ text: "x" }), false);
  assert.equal(tools.find((t) => t.name === "demo__save_note")!.needsApproval({ note: "x" }), true);
  // Every model can be given the tool: it has a plain JSON schema.
  assert.deepEqual((echo.portable!.parameters as any).required, ["text"]);
  const context = { signal: new AbortController().signal, conversation: {} as never };
  assert.equal(await echo.run({ text: "hello" }, context), "echo: hello");
  await assert.rejects(Promise.resolve(tools.find((t) => t.name === "demo__fail")!.run({}, context)), /failed on purpose/);
});

test("a long conversation is shortened to fit a small model, keeping the task and every tool result", () => {
  const big = "x".repeat(20_000);
  const messages: any[] = [
    { role: "system", content: "You are a bot." },
    { role: "user", content: "THE TASK: add tests." },
  ];
  for (let i = 0; i < 12; i++) {
    messages.push({ role: "assistant", content: null, tool_calls: [{ id: `c${i}`, type: "function", function: { name: "bash", arguments: "{}" } }] });
    messages.push({ role: "tool", tool_call_id: `c${i}`, content: big });
  }
  const fitted = fitToContext(messages, 32_000);
  assert.equal(fitted.length, messages.length);
  assert.equal(fitted[1].content, "THE TASK: add tests.");
  assert.match(fitted[0].content!, /The task itself is the first message/);
  assert.match(fitted[3].content!, /characters shortened to fit/);
  assert.equal(fitted.at(-1)!.content, big); // the latest steps stay whole
  assert.ok(Math.ceil(fitted.reduce((n, m) => n + (m.content?.length ?? 0), 0) / 3.5) < 40_000);
  // A short conversation is left alone.
  const short = messages.slice(0, 2);
  assert.equal(fitToContext(short, 32_000), short);
});

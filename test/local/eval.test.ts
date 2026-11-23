// The quest test suite itself, run against the stand-in model: it scores the
// core quests, saves a baseline, and fails a run that scores worse.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { startMockApi, say, call } from "../mock-api.ts";
import type { Reply } from "../mock-api.ts";

let triageCoversAll = true;
async function reply(body: any): Promise<Reply> {
  const last = body.messages.at(-1);
  if (Array.isArray(last.content) && last.content[0]?.type === "tool_result") return say("Done.");
  const task = typeof body.messages[0].content === "string" ? body.messages[0].content : "";
  if (task.startsWith("Write the changelog")) {
    const hashes = [...task.matchAll(/^- ([0-9a-f]{7,}) /gm)].map((m) => m[1]);
    return call("str_replace_based_edit_tool", { command: "create", path: "CHANGELOG.md", file_text: `# 1.1.0\n\n${hashes.map((h) => `- A change (${h})`).join("\n")}\n` });
  }
  if (task.startsWith("Add tests for")) {
    return call("str_replace_based_edit_tool", {
      command: "create",
      path: "src/slug.test.mjs",
      file_text: `import test from "node:test";\nimport assert from "node:assert";\nimport { slug } from "./slug.mjs";\ntest("slug", () => assert.equal(slug("Hello World"), "hello-world"));\n`,
    });
  }
  if (task.startsWith("Triage the open issues")) return say(triageCoversAll ? "#4 bug, #7 feature, #9 question, #11 docs." : "#4 bug, #7 feature.");
  if (task.startsWith("Write the morning report")) return say("The tests workflow is failing on main. #8 has waited 12 days for lee.");
  return say("ok");
}

let mock: Awaited<ReturnType<typeof startMockApi>>;
const baselines = fs.mkdtempSync(path.join(os.tmpdir(), "talqava-baselines-"));
before(async () => {
  mock = await startMockApi(reply);
});
after(() => mock.server.close());

function runSuite(extra: string[] = []): Promise<{ code: number; output: string; result: any }> {
  const json = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "talqava-evalout-")), "result.json");
  const child = spawn(process.execPath, [path.join(import.meta.dirname, "../../evals/run.ts"), "--model", "anthropic/claude-opus-5-5", "--quests", "changelog,add-tests,triage,morning-report", "--minutes", "1", ...extra], {
    env: { ...process.env, NODE_TEST_CONTEXT: "", ANTHROPIC_BASE_URL: mock.url, ANTHROPIC_API_KEY: "test-key", TALQAVA_EVAL_JSON: json, TALQAVA_EVAL_BASELINES: baselines },
  });
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  return new Promise((resolve) => child.on("close", (code) => resolve({ code: code ?? -1, output, result: fs.existsSync(json) ? JSON.parse(fs.readFileSync(json, "utf8")) : null })));
}

test("the suite runs four core quests on its fixtures, checks each, and saves a baseline", { timeout: 120_000 }, async () => {
  const { code, output, result } = await runSuite(["--save"]);
  assert.equal(code, 0, output);
  assert.equal(result.score, 4);
  assert.deepEqual(result.results.map((r: any) => [r.quest, r.passed, r.tries]), [
    ["changelog", true, 0],
    ["add-tests", true, 0],
    ["triage", true, 0],
    ["morning-report", true, 0],
  ]);
  assert.match(output, /Score: 4 of 4 \(no baseline yet\)/);
  assert.ok(fs.existsSync(path.join(baselines, "anthropic_claude-opus-5-5.json")));
});

test("a run that scores worse than the baseline fails, so the release does not ship", { timeout: 120_000 }, async () => {
  triageCoversAll = false; // the model now misses two issues, every time
  const { code, output, result } = await runSuite();
  assert.equal(code, 1, output);
  assert.equal(result.results.find((r: any) => r.quest === "triage").passed, false);
  assert.match(result.results.find((r: any) => r.quest === "triage").detail, /Missing: #9, #11/);
  assert.match(output, /Worse than the baseline: this release should not ship/);
});

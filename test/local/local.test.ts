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
  assert.throws(() => store.spaces.create("acme"), /already a project/);
  assert.throws(() => store.spaces.create("General"), /General is already there/);

  const general = store.memory.add("The user likes plain language.");
  const fact = store.memory.add("Acme's contract renews in March.", acme.id);
  assert.equal(store.memory.add("Acme's contract renews in March.", acme.id).id, fact.id); // saying it twice saves it once
  assert.throws(() => store.memory.add("x", "nope"), /No such project/);
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

test("the marketplace lists ready-made bots with their instructions, and adding one makes it the person's own", async () => {
  const market = await import("../../src/local/marketplace.ts");
  const crew = await import("../../src/local/crew.ts");
  const { bots, problems } = market.loadMarketplace();
  assert.deepEqual(problems, []);
  assert.ok(bots.length >= 9);
  for (const { bot, listing } of bots) {
    // Every listing says what the bot is for, and what it will and will not do.
    assert.ok(listing.summary.length > 20 && listing.category && listing.by, bot.id);
    assert.ok(listing.will.length && listing.wont.length, bot.id);
    assert.ok(bot.instructions.length > 200, bot.id);
    assert.equal(bot.approvals, "ask", bot.id); // marketplace bots ask before changing anything
    assert.ok(!bot.powers.includes("api"), bot.id); // none can call outside services
    assert.ok(!bot.powers.includes("shell") || listing.category === "Engineering", bot.id); // and only engineers can run commands
  }
  // A marketplace bot does not share a name with a starter bot, so adding it never replaces one.
  const starters = new Set(crew.loadCrew().bots.map((b) => b.id));
  assert.ok(bots.every(({ bot }) => !starters.has(bot.id)));

  assert.equal(market.onTeam("proofreader"), false);
  const added = market.addMarketBot("proofreader");
  assert.equal(added.source, "personal");
  assert.equal(added.name, "Proofreader");
  assert.deepEqual(added.character, { legend: "Aa", texture: "lines", color: "violet", shape: "round", eyes: "specs", top: "none" });
  // No two marketplace bots look alike.
  assert.equal(new Set(bots.map(({ bot }) => JSON.stringify(bot.character))).size, bots.length);
  assert.equal(market.onTeam("proofreader"), true);
  // The copy is the person's to edit, and adding again leaves their edits alone.
  crew.saveBot("proofreader", { ...added, instructions: "My own version." });
  assert.equal(market.addMarketBot("proofreader").instructions, "My own version.");
  assert.throws(() => market.addMarketBot("no-such-bot"), /no bot called/);
  crew.removeBot("proofreader");
});

test("bots have a team group and a monthly budget that warns at 80% and stops new work at 100%", async () => {
  const crew = await import("../../src/local/crew.ts");
  const spend = await import("../../src/local/spend.ts");
  const quests = await import("../../src/local/quests.ts");
  // Starter bots are grouped by the work they do; a bot's own file can say otherwise.
  assert.equal(crew.findBot("pip").group, "Research");
  assert.equal(crew.findBot("rivet").group, "Engineering");
  const saver = crew.saveBot("saver", { name: "Saver", type: "scout", instructions: "Look things up.", powers: ["memory"], group: "Sales", monthly: 2 });
  assert.equal(saver.group, "Sales");
  assert.equal(saver.monthly, 2);

  // Spend is counted once per quest as its cost grows, per calendar month.
  const nov = new Date(2026, 10, 15);
  spend.recordSpend("q1", "saver", 0.5, nov);
  spend.recordSpend("q1", "saver", 1.2, nov); // the same quest, further on: only the difference is added
  spend.recordSpend("q2", "saver", 0.3, nov);
  let budgets = spend.monthlyBudgets([saver], nov);
  assert.equal(budgets.bots.saver.spent, 1.5);
  assert.equal(budgets.bots.saver.state, "ok");
  assert.equal(budgets.resets, "2026-12-01");
  assert.equal(spend.budgetBlock(saver, nov), null);

  spend.recordSpend("q2", "saver", 0.5, nov); // 1.7 of 2: past 80%
  assert.equal(spend.monthlyBudgets([saver], nov).bots.saver.state, "warned");
  assert.equal(spend.budgetBlock(saver, nov), null);

  spend.recordSpend("q3", "saver", 0.4, nov); // 2.1 of 2
  assert.equal(spend.monthlyBudgets([saver], nov).bots.saver.state, "stopped");
  assert.match(spend.budgetBlock(saver, nov)!, /Saver has reached its monthly budget \(\$2\.10 of \$2\.00\)/);
  // The next month starts from nothing.
  assert.equal(spend.budgetBlock(saver, new Date(2026, 11, 1)), null);

  // The limit for all bots together stops every bot, even one with room of its own.
  store.saveConfig({ monthlyBudget: 2 });
  const other = crew.findBot("pip");
  assert.match(spend.budgetBlock(other, nov)!, /all bots/);
  store.saveConfig({ monthlyBudget: undefined });
  assert.equal(spend.budgetBlock(other, nov), null);

  // A bot over its budget starts no new quest.
  spend.recordSpend("q4", "saver", 5); // this month
  await assert.rejects(quests.quests.start({ bot: crew.findBot("saver"), text: "anything" }), /reached its monthly budget/);
  crew.removeBot("saver");
});

test("an organization puts bots in roles on a chart, and a team joins with its reporting lines", async () => {
  const { orgs, reportsOf, rolePrompt } = await import("../../src/local/orgs.ts");
  const market = await import("../../src/local/marketplace.ts");
  const crew = await import("../../src/local/crew.ts");
  // The first organization holds every bot, each reporting to the person.
  const first = orgs.active();
  assert.ok(first.members.some((m) => m.bot === "pip" && m.manager === null && m.department === "Research"));

  const acme = orgs.create("Acme", "Sell more umbrellas.");
  assert.equal(orgs.active().id, acme.id);
  assert.deepEqual(orgs.active().members, []);
  assert.throws(() => orgs.create("acme"), /already an organization/);

  // A team from the marketplace arrives lead first, with its reporting lines.
  assert.deepEqual(market.loadTeams().map((t) => t.id).sort(), ["engineering-team", "finance-team", "marketing-team", "research-team", "sales-team", "starter-company", "support-team"]);
  market.addTeam("marketing-team");
  let org = orgs.active();
  assert.deepEqual(reportsOf(org, "head-of-marketing").map((m) => m.bot).sort(), ["content-writer", "seo-researcher", "social-drafter"]);
  assert.equal(org.members.find((m) => m.bot === "head-of-marketing")!.manager, null); // no chief of staff here yet
  assert.equal(org.members.find((m) => m.bot === "content-writer")!.title, "Content Writer");

  // Roles can be changed, but the chart stays a tree.
  orgs.setMember(org.id, { bot: "pip", title: "Researcher", department: "Marketing", manager: "seo-researcher" });
  assert.throws(() => orgs.setMember(org.id, { bot: "head-of-marketing", manager: "pip" }), /above that bot/);
  assert.throws(() => orgs.setMember(org.id, { bot: "pip", manager: "pip" }), /cannot report to itself/);
  assert.throws(() => orgs.setMember(org.id, { bot: "pip", manager: "rivet" }), /must be a member/);

  // Each bot is told its place: who it answers to, and who it may hand work to.
  const head = rolePrompt(crew.findBot("head-of-marketing"));
  assert.match(head, /Head of Marketing in the Marketing department of Acme/);
  assert.match(head, /Sell more umbrellas/);
  assert.match(head, /Quill \(Content Writer\)/);
  assert.match(head, /assign_task/);
  assert.match(rolePrompt(crew.findBot("content-writer")), /You report to Mira, the Head of Marketing/);
  assert.match(rolePrompt(crew.findBot("content-writer")), /Nobody reports to you/);
  assert.equal(rolePrompt(crew.findBot("rivet")), ""); // not on this chart

  // Taking a manager off the chart moves its reports up.
  org = orgs.removeMember(org.id, "seo-researcher");
  assert.equal(org.members.find((m) => m.bot === "pip")!.manager, "head-of-marketing");

  // The run a lead gets includes the hand-off tool; a bot with no reports does not get it.
  const runFor = async (botId: string) => (await tools.localRunSpec(app.jobs)({ id: "0".repeat(16), bot: botId, messages: [] } as unknown as Conversation)).tools.map((t) => t.name);
  assert.ok((await runFor("head-of-marketing")).includes("assign_task"));
  assert.ok(!(await runFor("content-writer")).includes("assign_task"));
});

test("a task handed to a bot runs on its own, and its report comes back into the chat that assigned it", { timeout: 20_000 }, async () => {
  const { orgs } = await import("../../src/local/orgs.ts");
  const quests = await import("../../src/local/quests.ts");
  const org = orgs.active();
  const chat = store.conversations.create();
  // The chat's agent hands the job to Pip; both then answer (in either order), and the report is delivered.
  script.push(call("assign_task", { to: "Pip", task: "Find the answer to the question and report it." }), say("The answer is 42."), say("The answer is 42."), say("Pip found that the answer is 42."));
  await (await app.engine.startRun(chat.id, "ask Pip for the answer")).done;

  const child = () => quests.questStore.list().find((q) => q.parent?.id === chat.id)!;
  assert.equal(child().bot.id, "pip");
  assert.equal(child().depth, 1);
  // Wait for Pip to finish and for its report to be delivered and answered.
  for (let i = 0; i < 150 && !(child().parent!.delivered && !app.engine.isRunning(chat.id) && store.conversations.get(chat.id)!.messages.length >= 6); i++) await new Promise((r) => setTimeout(r, 50));
  const messages = store.conversations.get(chat.id)!.messages;
  const report = messages.find((m) => typeof m.content === "string" && m.content.startsWith("[Report from Pip"))!;
  assert.match(String(report.content), /Find the answer to the question/);
  assert.match(String(report.content), /finished\]\nThe answer is 42\./);
  assert.match(JSON.stringify(messages.at(-1)), /Pip found that the answer is 42/);
  // Pip was told who assigned the task and that it cannot see the chat.
  assert.match(String(store.conversations.get(child().id)!.messages[0].content), /Assigned by .* on the user's behalf/);

  // A bot may assign only to its own direct reports.
  const asPip = { signal: new AbortController().signal, conversation: { id: child().id, messages: [] } as unknown as Conversation };
  await assert.rejects(Promise.resolve(tools.assignTool.run({ to: "Rivet", task: "Do something long enough." }, asPip)), /Nobody reports to you|only to/);
  assert.ok(org.members.length > 0);
});

test("a chat can be pinned, and the list says so", () => {
  const chat = store.conversations.create({ title: "Keep me handy" });
  assert.equal(store.conversations.list().find((c) => c.id === chat.id)!.pinned, false);
  const before = store.conversations.get(chat.id)!.updatedAt;
  store.conversations.save({ ...store.conversations.get(chat.id)!, pinned: true }, { touch: false });
  const listed = store.conversations.list().find((c) => c.id === chat.id)!;
  assert.equal(listed.pinned, true);
  assert.equal(listed.updatedAt, before); // pinning does not make the chat look newly used
  store.conversations.remove(chat.id);
  assert.equal(store.conversations.get(chat.id), null);
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

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
  // These tests script each reply the agent gets, so the check before a task starts (one extra model call) is off; it has its own test.
  store.saveConfig({ checkFirst: false });
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
  assert.equal(added.name, "Editor");
  assert.equal(added.title, "Editor");
  assert.equal(added.character.legend, "ED");
  assert.equal(added.character.color, "violet");
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
  assert.equal(crew.findBot("rivet").group, "Operations");
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
  assert.deepEqual(market.loadTeams().map((t) => t.id).sort(), ["development-team", "engineering-team", "finance-team", "marketing-team", "operations-team", "people-team", "research-team", "sales-team", "starter-company", "support-team"]);
  market.addTeam("marketing-team");
  let org = orgs.active();
  assert.deepEqual(reportsOf(org, "head-of-marketing").map((m) => m.bot).sort(), ["content-writer", "designer", "paid-ads-specialist", "seo-researcher", "social-drafter"]);
  assert.equal(org.members.find((m) => m.bot === "head-of-marketing")!.manager, null); // no general manager here yet
  assert.equal(org.members.find((m) => m.bot === "content-writer")!.title, "Content Writer");

  // Roles can be changed, but the chart stays a tree.
  orgs.setMember(org.id, { bot: "pip", title: "Researcher", department: "Marketing", manager: "seo-researcher" });
  assert.throws(() => orgs.setMember(org.id, { bot: "head-of-marketing", manager: "pip" }), /above that bot/);
  assert.throws(() => orgs.setMember(org.id, { bot: "pip", manager: "pip" }), /cannot report to itself/);
  assert.throws(() => orgs.setMember(org.id, { bot: "pip", manager: "rivet" }), /must be a member/);

  // Each bot is told its place: who it answers to, and who it may hand work to.
  const head = rolePrompt(crew.findBot("head-of-marketing"));
  assert.match(head, /Head of Marketing in the Marketing group of Acme/);
  assert.match(head, /You lead the Marketing group/);
  assert.match(head, /Sell more umbrellas/);
  assert.match(head, /- Content Writer: /);
  assert.match(head, /assign_task/);
  assert.match(rolePrompt(crew.findBot("content-writer")), /You report to the Head of Marketing\./);
  assert.match(rolePrompt(crew.findBot("content-writer")), /Nobody takes tasks from you/);
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
  script.push(call("assign_task", { to: "Research Analyst", task: "Find the answer to the question and report it." }), say("The answer is 42."), say("The answer is 42."), say("Pip found that the answer is 42."));
  await (await app.engine.startRun(chat.id, "ask Pip for the answer")).done;

  const child = () => quests.questStore.list().find((q) => q.parent?.id === chat.id)!;
  assert.equal(child().bot.id, "pip");
  assert.equal(child().depth, 1);
  // Wait for Pip to finish and for its report to be delivered and answered.
  for (let i = 0; i < 150 && !(child().parent!.delivered && !app.engine.isRunning(chat.id) && store.conversations.get(chat.id)!.messages.length >= 6); i++) await new Promise((r) => setTimeout(r, 50));
  const messages = store.conversations.get(chat.id)!.messages;
  const report = messages.find((m) => typeof m.content === "string" && m.content.startsWith("[Report from Research Analyst"))!;
  assert.match(String(report.content), /Find the answer to the question/);
  assert.match(String(report.content), /finished\]\nThe answer is 42\./);
  assert.match(JSON.stringify(messages.at(-1)), /Pip found that the answer is 42/);
  // Pip was told who assigned the task and that it cannot see the chat.
  assert.match(String(store.conversations.get(child().id)!.messages[0].content), /Assigned by .* on the user's behalf/);

  // A bot may assign only to its own direct reports.
  const asPip = { signal: new AbortController().signal, conversation: { id: child().id, messages: [] } as unknown as Conversation };
  await assert.rejects(Promise.resolve(tools.assignTool.run({ to: "Rivet", task: "Do something long enough." }, asPip)), /Nobody takes tasks from you|only to/);
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

test("a structure sets who may hand work to whom; anyone may ask anyone; the organization remembers", async () => {
  const { orgs, assignableBy, rolePrompt, assignRule } = await import("../../src/local/orgs.ts");
  const { STRUCTURES } = await import("../../src/local/structures.ts");
  const { orgMemory, orgMemoryPrompt } = await import("../../src/local/orgmemory.ts");
  const market = await import("../../src/local/marketplace.ts");
  const crew = await import("../../src/local/crew.ts");
  // Every structure explains itself: a philosophy for the person and guidance for the agents.
  for (const s of STRUCTURES) assert.ok(s.name && s.summary && s.bestFor && s.watchOut && (s.id === "custom" || (s.philosophy.length > 80 && s.guidance.length > 80)), s.id);

  let org = orgs.create("Devco", "Ship software.", "team");
  market.addTeam("development-team");
  org = orgs.active();
  const of = (id: string) => org.members.find((m) => m.bot === id)!;
  assert.equal(of("lead-developer").manager, null);
  for (const id of ["frontend-developer", "backend-developer", "mobile-developer", "functional-analyst", "qa-tester"]) assert.equal(of(id).manager, "lead-developer", id);

  // Work follows the lines: a lead hands work to everyone below it; a specialist with nobody below hands nothing out.
  const { requestableBy, groupOf } = await import("../../src/local/orgs.ts");
  assert.equal(assignRule(org), "reports");
  const names = (id: string) => assignableBy(orgs.active(), id).map((m) => m.bot).sort();
  assert.deepEqual(names("lead-developer"), ["backend-developer", "frontend-developer", "functional-analyst", "mobile-developer", "qa-tester"]);
  assert.deepEqual(names("frontend-developer"), []);
  assert.match(rolePrompt(crew.findBot("frontend-developer")), /work follows its lines/);
  assert.match(rolePrompt(crew.findBot("frontend-developer")), /ask_colleague/);
  // Everyone below, not only direct reports: put the tester under the back-end developer.
  orgs.setMember(org.id, { bot: "qa-tester", manager: "backend-developer" });
  assert.ok(names("lead-developer").includes("qa-tester"));
  assert.deepEqual(names("backend-developer"), ["qa-tester"]);
  // The structure's name changes no rule and moves no line.
  for (const structure of ["hierarchical", "flat", "matrix", "functional"]) {
    orgs.update(org.id, { structure });
    assert.deepEqual(names("backend-developer"), ["qa-tester"], structure);
    assert.equal(orgs.active().members.find((m) => m.bot === "frontend-developer")!.manager, "lead-developer", structure);
  }
  // A dotted line: someone on it may hand work too.
  orgs.setMember(org.id, { bot: "frontend-developer", also: "functional-analyst" });
  assert.deepEqual(names("functional-analyst"), ["frontend-developer"]);
  assert.match(rolePrompt(crew.findBot("frontend-developer")), /Your project lead is the Requirements Analyst/);
  // The chart must stay a tree.
  assert.throws(() => orgs.setMember(org.id, { bot: "lead-developer", manager: "frontend-developer" }), /above that bot/);

  // Groups: the team's department is a group led by its lead; a new group, its lead, renaming and removing it.
  org = orgs.active();
  const engineering = groupOf(org, "frontend-developer")!;
  assert.equal(engineering.lead, "lead-developer");
  org = orgs.addGroup(org.id, { name: "Mobile", lead: "mobile-developer", goal: "Ship the app", budget: 40 });
  const mobile = org.groups.find((g) => g.name === "Mobile")!;
  assert.equal(org.members.find((m) => m.bot === "mobile-developer")!.department, "Mobile");
  assert.equal(mobile.budget, 40);
  assert.match(rolePrompt(crew.findBot("mobile-developer")), /You lead the Mobile group/);
  assert.match(rolePrompt(crew.findBot("mobile-developer")), /Ship the app/);
  // Another group's lead takes requests; the lead's own reports are handed work instead.
  assert.ok(requestableBy(org, "frontend-developer").some((m) => m.bot === "mobile-developer"));
  assert.ok(!requestableBy(org, "lead-developer").some((m) => m.bot === "mobile-developer"));
  org = orgs.updateGroup(org.id, mobile.id, { name: "Apps" });
  assert.equal(org.members.find((m) => m.bot === "mobile-developer")!.department, "Apps");
  assert.throws(() => orgs.removeGroup(org.id, mobile.id), /Choose the group to move it to/);
  org = orgs.removeGroup(org.id, mobile.id, engineering.id);
  assert.equal(org.members.find((m) => m.bot === "mobile-developer")!.department, engineering.name);
  assert.ok(!org.groups.some((g) => g.id === mobile.id));
  assert.throws(() => orgs.addGroup(org.id, { name: engineering.name }), /already a group/);

  // A position is separate from its agent: another agent takes the job, and every line and the group stay.
  orgs.setMember(org.id, { bot: "backend-developer", responsibilities: "The orders API and its database." });
  if (!market.onTeam("technical-writer")) market.addMarketBot("technical-writer");
  if (orgs.active().members.some((m) => m.bot === "technical-writer")) orgs.removeMember(org.id, "technical-writer");
  org = orgs.swapAgent(org.id, "backend-developer", "technical-writer");
  const swapped = org.members.find((m) => m.bot === "technical-writer")!;
  assert.equal(swapped.manager, "lead-developer");
  assert.equal(swapped.responsibilities, "The orders API and its database.");
  assert.equal(org.members.find((m) => m.bot === "qa-tester")!.manager, "technical-writer");
  assert.ok(!org.members.some((m) => m.bot === "backend-developer"));
  assert.match(rolePrompt(crew.findBot("technical-writer")), /responsible for, in the owner's words: The orders API/);
  org = orgs.swapAgent(org.id, "technical-writer", "backend-developer");

  // The owner's philosophy is told to every agent.
  orgs.update(org.id, { philosophy: "Whoever is closest to the customer decides." });
  assert.match(rolePrompt(crew.findBot("qa-tester")), /Whoever is closest to the customer decides/);

  // Memory: the organization's shelf is seen by all, a department's by its members, an agent's by itself.
  orgMemory.add({ org: org.id, shelf: "org", text: "The fiscal year starts in April.", by: "You" });
  orgMemory.add({ org: org.id, shelf: "agent", key: "backend-developer", text: "The orders API is versioned under /v2.", by: "Back-End Developer" });
  orgMemory.logTask(orgs.active(), "backend-developer", "Add an orders endpoint", "Added GET /v2/orders with tests.");
  const back = orgMemoryPrompt(orgs.active(), "backend-developer", "orders");
  assert.match(back, /fiscal year starts in April/);
  assert.match(back, /\/v2/);
  assert.match(back, /Add an orders endpoint/);
  const front = orgMemoryPrompt(orgs.active(), "frontend-developer", "orders");
  assert.match(front, /fiscal year/);
  assert.doesNotMatch(front, /versioned under/);
  // Only what fits the budget is listed, the best matches first; the rest is counted.
  for (let i = 0; i < 40; i++) orgMemory.add({ org: org.id, shelf: "org", text: `Policy ${i}: ${"filler words about something unrelated ".repeat(6)}`, by: "You" });
  const tight = orgMemoryPrompt(orgs.active(), "frontend-developer", "when does the fiscal year start");
  assert.match(tight, /fiscal year starts in April/);
  assert.match(tight, /more entries are saved but not listed/);
  assert.ok(tight.length < 4500);
});

test("an agent's question to a colleague is answered on a small budget, and the answer comes back", { timeout: 20_000 }, async () => {
  const { orgs } = await import("../../src/local/orgs.ts");
  const quests = await import("../../src/local/quests.ts");
  const chat = store.conversations.create();
  script.push(call("ask_colleague", { to: "QA Engineer", question: "Which test command does the team use for the orders service?" }), say("Asked."), say("We use npm test."), say("The team uses npm test."));
  await (await app.engine.startRun(chat.id, "find out which test command the team uses")).done;
  const child = () => quests.questStore.list().find((q) => q.parent?.id === chat.id)!;
  assert.equal(child().bot.id, "qa-tester");
  assert.equal(child().kind, "question");
  for (let i = 0; i < 150 && !(child().parent!.delivered && !app.engine.isRunning(chat.id) && store.conversations.get(chat.id)!.messages.length >= 6); i++) await new Promise((r) => setTimeout(r, 50));
  const messages = store.conversations.get(chat.id)!.messages;
  const reply = messages.find((m) => typeof m.content === "string" && m.content.startsWith("[Report from QA Engineer"))!;
  assert.match(String(reply.content), /answered\]/);
  // The one answering works on a few steps, cannot hand work on, and still has the shared memory.
  const spec = await tools.localRunSpec(app.jobs)(store.conversations.get(child().id)!);
  assert.equal(spec.budget!.steps, 3);
  // It runs lean: a short prompt about who it is and what the organization knows, not the whole working prompt.
  assert.ok(spec.system.length < 2600, `question prompt is ${spec.system.length} characters`);
  assert.match(spec.system, /A colleague has put a question to you/);
  assert.doesNotMatch(spec.system, /# Skills|# How you work/);
  const names = spec.tools.map((t) => t.name);
  assert.ok(names.includes("team_memory") && !names.includes("assign_task") && !names.includes("ask_colleague"));
  // Even in a hierarchy, where it may hand work to no one, a specialist can ask a colleague.
  const asQa = (await tools.localRunSpec(app.jobs)({ id: "1".repeat(16), bot: "qa-tester", messages: [] } as unknown as Conversation)).tools.map((t) => t.name);
  assert.ok(asQa.includes("ask_colleague") && !asQa.includes("assign_task"));
  // Leaving the name out lists who can be asked.
  const listed = await tools.askTool.run({ to: "", question: "Who is here?" }, { signal: new AbortController().signal, conversation: { id: chat.id, messages: [] } as unknown as Conversation });
  assert.match(String(listed), /Lead Developer/);
});

test("an example is copied onto the chart for the kind of business, layers deep, and never redraws it", async () => {
  const { orgs, requestableBy, rolePrompt, groupOf } = await import("../../src/local/orgs.ts");
  const market = await import("../../src/local/marketplace.ts");
  const crew = await import("../../src/local/crew.ts");
  const { INDUSTRIES, STRUCTURES, seatsFor } = await import("../../src/local/structures.ts");
  const listed = new Map(market.loadMarketplace().bots.map((m) => [m.bot.id, m]));
  // Every structure that is offered behaves differently: no two share the same pair of rules and chart.
  assert.ok(!STRUCTURES.some((s) => s.id === "divisional"));
  const general = INDUSTRIES[0];
  const shapes = STRUCTURES.filter((s) => s.id !== "custom").map((s) => `${s.assign}/${s.request}/${seatsFor(s.id, general).map((x) => `${x.bot}<${x.manager}`).join()}`);
  assert.equal(new Set(shapes).size, shapes.length);
  for (const s of STRUCTURES) assert.ok(s.businesses.length >= 3 && s.tieBreak.length > 10, s.id);
  // Every chart, for every kind of business, seats real agents, each once, with a lead before its reports and a lead that is marked as one.
  for (const industry of INDUSTRIES) {
    assert.ok(industry.recommended.length && industry.recommended.every((id) => STRUCTURES.some((s) => s.id === id)), industry.id);
    for (const s of STRUCTURES) {
      const seen = new Set<string>();
      for (const seat of seatsFor(s.id, industry)) {
        assert.ok(listed.has(seat.bot), `${industry.id}/${s.id}: ${seat.bot}`);
        assert.ok(!seen.has(seat.bot), `${industry.id}/${s.id}: ${seat.bot} twice`);
        assert.ok(seat.manager === null || seen.has(seat.manager), `${industry.id}/${s.id}: ${seat.bot} before its lead`);
        if (seat.also) assert.ok(seen.has(seat.also) || seatsFor(s.id, industry).some((x) => x.bot === seat.also), `${industry.id}/${s.id}: ${seat.bot} project lead`);
        seen.add(seat.bot);
      }
    }
    // Only a software business is staffed with developers.
    const all = STRUCTURES.flatMap((s) => seatsFor(s.id, industry).map((x) => x.bot));
    assert.equal(all.includes("frontend-developer"), industry.id === "software", industry.id);
  }
  // Every marketplace role says what it is measured on, decides and must escalate; whoever it reports to is a lead.
  for (const { bot, listing } of listed.values()) {
    assert.ok(bot.governance.kpis.length && bot.governance.decides.length && bot.governance.escalates.length, bot.id);
    if (listing.reportsTo) assert.ok(listed.get(listing.reportsTo)?.bot.lead, `${bot.id} reports to ${listing.reportsTo}`);
  }

  const org = orgs.create("Layers Inc", "", "flat");
  orgs.setMember(org.id, { bot: "margo" }); // an agent the person already had
  const depthOf = (o: ReturnType<typeof orgs.active>, bot: string): number => {
    const m = o.members.find((x) => x.bot === bot)!;
    return m.manager ? 1 + depthOf(o, m.manager) : 1;
  };
  const of = (bot: string) => orgs.active().members.find((m) => m.bot === bot)!;

  // Copying the hierarchy example: a general manager holds the line, the chief of staff is staff to the owner, and the agent the person had stays.
  market.buildStructure(org.id, "hierarchical", "general");
  assert.equal(of("general-manager").manager, null);
  assert.equal(of("chief-of-staff").manager, null);
  assert.ok(!orgs.active().members.some((m) => m.manager === "chief-of-staff"));
  assert.equal(of("head-of-finance").manager, "general-manager");
  assert.equal(depthOf(orgs.active(), "bookkeeper"), 3);
  assert.equal(orgs.active().members.length, seatsFor("hierarchical", general).length + 1);
  assert.ok(of("margo"));
  // Copying another example adds what is missing and redraws nothing: the heads keep their general manager.
  const before = orgs.active().members.length;
  market.buildStructure(org.id, "functional");
  assert.equal(of("head-of-finance").manager, "general-manager");
  assert.equal(orgs.active().members.length, before);
  // Requests go to the leads of other groups; a specialist may request too, but hands nothing out.
  assert.ok(requestableBy(orgs.active(), "head-of-sales").some((m) => m.bot === "head-of-finance"));
  assert.ok(requestableBy(orgs.active(), "bookkeeper").some((m) => m.bot === "head-of-sales"));
  assert.ok(!requestableBy(orgs.active(), "bookkeeper").some((m) => m.bot === "account-executive" || m.bot === "head-of-finance"));
  const asBookkeeper = (await tools.localRunSpec(app.jobs)({ id: "2".repeat(16), bot: "bookkeeper", messages: [] } as unknown as Conversation)).tools.map((t) => t.name);
  assert.ok(asBookkeeper.includes("escalate") && asBookkeeper.includes("request_work") && !asBookkeeper.includes("assign_task"));
  assert.match(rolePrompt(crew.findBot("bookkeeper")), /your manager decides/i);

  // On an empty chart, an example is copied exactly: a matrix's project lead on dotted lines.
  const matrix = orgs.create("Matrix Inc", "", "flat");
  market.buildStructure(matrix.id, "matrix", "general");
  assert.equal(orgs.active().members.length, seatsFor("matrix", general).length);
  assert.equal(of("content-writer").manager, "head-of-marketing");
  assert.equal(of("content-writer").also, "project-manager");
  // Outcome teams mix specialties: winning customers takes a writer, a researcher and an account executive.
  const teams = orgs.create("Teams Inc", "", "flat");
  market.buildStructure(teams.id, "team", "general");
  assert.equal(of("account-executive").manager, "head-of-marketing");
  assert.equal(of("account-executive").department, "Win customers");
  assert.equal(of("invoice-chaser").department, "Keep customers");
  assert.equal(groupOf(orgs.active(), "account-executive")!.lead, "head-of-marketing");
  // Another kind of business is staffed differently: a restaurant group gets scheduling and purchasing.
  const food = orgs.create("Food Inc", "", "flat");
  market.buildStructure(food.id, "hierarchical", "hospitality");
  assert.equal(orgs.active().industry, "hospitality");
  assert.equal(of("scheduling-coordinator").manager, "head-of-operations");
  assert.equal(of("food-safety-coordinator").manager, "head-of-operations");
  assert.equal(of("menu-analyst").department, "Finance");
  assert.ok(!orgs.active().members.some((m) => m.bot === "account-executive"));

  // The approval limit is told to every agent.
  orgs.update(food.id, { approvalLimit: 500 });
  assert.match(rolePrompt(crew.findBot("menu-analyst")), /above \$500 needs the owner's approval/);
  // A role is told what it is measured on and what it must escalate.
  const { botPrompt } = await import("../../src/core/index.ts");
  assert.match(botPrompt(crew.findBot("accounts-payable")), /You must take to your lead[^.]*Changed supplier bank details/);
});

test("work is requested across departments and a decision is escalated to a lead", { timeout: 20_000 }, async () => {
  const { orgs } = await import("../../src/local/orgs.ts");
  const market = await import("../../src/local/marketplace.ts");
  const quests = await import("../../src/local/quests.ts");
  const org = orgs.create("Requests Ltd", "", "functional");
  market.buildStructure(org.id, "functional", "general");
  const asBot = (bot: string, id: string) => ({ signal: new AbortController().signal, conversation: { id, bot, messages: [] } as unknown as Conversation });
  const chat = store.conversations.create({ bot: "bookkeeper" });
  script.push(say("Accepted: here is the list."), say("Thanks."), say("Decided: option one."), say("Understood."));
  // The bookkeeper may ask the head of sales for work, but not a salesperson directly, nor its own head.
  await assert.rejects(Promise.resolve(tools.requestTool.run({ to: "Account Executive", request: "Send me the list of deals closing this month." }, asBot("bookkeeper", chat.id))), /only from/);
  const sent = await tools.requestTool.run({ to: "Head of Sales", request: "Send me the list of deals closing this month.", why: "Cash forecast, by Friday." }, asBot("bookkeeper", chat.id));
  assert.match(String(sent), /Requested from Head of Sales/);
  const request = quests.questStore.list().find((q) => q.parent?.id === chat.id && q.bot.id === "head-of-sales")!;
  assert.match(String(store.conversations.get(request.id)!.messages[0].content), /not an order from your lead/);
  // An escalation goes to the agent's own lead and is decided on a small budget.
  const raised = await tools.escalateTool.run({ issue: "Two bills for the same order; which do we pay?", options: "Pay the first; hold both.", recommendation: "Hold both." }, asBot("bookkeeper", chat.id));
  assert.match(String(raised), /Escalated to Head of Finance/);
  const decision = quests.questStore.list().find((q) => q.parent?.id === chat.id && q.kind === "decision")!;
  assert.equal(decision.bot.id, "head-of-finance");
  // A head who reports to the owner is told to put the decision to the owner.
  assert.match(String(await tools.escalateTool.run({ issue: "Budget is short for the quarter.", options: "Cut; borrow.", recommendation: "Cut." }, asBot("head-of-finance", store.conversations.create({ bot: "head-of-finance" }).id))), /Needs your decision/);
  for (let i = 0; i < 100 && quests.questStore.list().some((q) => q.parent?.id === chat.id && (q.status === "running" || !q.parent.delivered)); i++) await new Promise((r) => setTimeout(r, 50));
});

test("examples differ in size, copying never shrinks a chart, and Git reports its repositories", async () => {
  const { orgs } = await import("../../src/local/orgs.ts");
  const market = await import("../../src/local/marketplace.ts");
  const { INDUSTRIES, seatsFor } = await import("../../src/local/structures.ts");
  // A flat organization is the smallest; a hierarchy adds a layer of management.
  for (const industry of INDUSTRIES) {
    const size = (id: string) => seatsFor(id, industry).length;
    assert.ok(size("flat") <= 8 && size("flat") < size("functional") && size("functional") < size("hierarchical"), industry.id);
    assert.ok(seatsFor("flat", industry).every((seat) => seat.manager === null));
  }
  const org = orgs.create("Sizes Co", "", "flat");
  const count = () => orgs.active().members.length;
  market.buildStructure(org.id, "hierarchical", "general");
  const big = count();
  // Copying a smaller example removes nothing.
  market.buildStructure(org.id, "flat");
  assert.equal(count(), big);
  assert.ok(orgs.active().members.some((m) => m.bot === "general-manager"));
  // Starting over is the owner's choice: clear the chart, then copy an example, and the count is exactly the example's.
  orgs.setMember(org.id, { bot: "pip" });
  orgs.clear(org.id);
  market.buildStructure(org.id, "functional");
  assert.equal(count(), seatsFor("functional", INDUSTRIES[0]).length);
  assert.ok(!orgs.active().members.some((m) => m.bot === "pip"));
  // Clearing keeps the agents on the team.
  assert.equal(orgs.clear(org.id).members.length, 0);
  assert.ok((await import("../../src/local/crew.ts")).loadCrew().bots.some((b) => b.id === "head-of-finance"));
  market.buildStructure(org.id, "functional");

  // Deleting an organization removes its chart; another becomes the open one, and the last one cannot be deleted.
  const spare = orgs.create("Spare Co", "", "flat");
  assert.equal(orgs.active().id, spare.id);
  orgs.remove(spare.id);
  assert.ok(!orgs.list().orgs.some((o) => o.id === spare.id));
  assert.notEqual(orgs.active().id, spare.id);
  orgs.setActive(org.id);

  // A ready-made team can be added to a chart even when its agents are already on the person's team but not on this chart.
  for (const bot of ["lead-developer", "frontend-developer", "backend-developer", "mobile-developer", "functional-analyst", "qa-tester"]) if (!market.onTeam(bot)) market.addMarketBot(bot);
  for (const bot of ["lead-developer", "frontend-developer", "backend-developer", "mobile-developer", "functional-analyst", "qa-tester"]) if (orgs.active().members.some((m) => m.bot === bot)) orgs.removeMember(org.id, bot);
  const beforeTeam = count();
  market.addTeam("development-team");
  assert.equal(count(), beforeTeam + 6);
  assert.equal(orgs.active().members.find((m) => m.bot === "lead-developer")!.manager, null);
  for (const bot of ["frontend-developer", "backend-developer", "mobile-developer", "functional-analyst", "qa-tester"]) assert.equal(orgs.active().members.find((m) => m.bot === bot)!.manager, "lead-developer", bot);
  // Adding it again changes nothing; taking it off again leaves the rest of the chart alone.
  market.addTeam("development-team");
  assert.equal(count(), beforeTeam + 6);
  orgs.removeTeam(org.id, "lead-developer");
  assert.equal(count(), beforeTeam);

  // Minus on a lead can take its whole team off the chart; the agents stay on the person's team.
  assert.ok(orgs.active().members.some((m) => m.manager === "head-of-finance"));
  const before = count();
  const team = orgs.active().members.filter((m) => m.manager === "head-of-finance").length + 1;
  orgs.removeTeam(org.id, "head-of-finance");
  assert.equal(count(), before - team);
  assert.ok(!orgs.active().members.some((m) => m.bot === "head-of-finance" || m.bot === "bookkeeper"));
  assert.ok((await import("../../src/local/crew.ts")).loadCrew().bots.some((b) => b.id === "bookkeeper"));
  // Plus puts an agent back, under whoever was chosen.
  orgs.setMember(org.id, { bot: "bookkeeper", manager: "head-of-sales" });
  assert.equal(orgs.active().members.find((m) => m.bot === "bookkeeper")!.manager, "head-of-sales");

  // Git: a connected repository is described; a bad address is refused before git is run.
  const { gitIntegration, cloneRepository, listIntegrations } = await import("../../src/local/integrations.ts");
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "talqava-int-"));
  const { execFileSync } = await import("node:child_process");
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", ...args], { cwd: repo });
  git("init", "-q");
  fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
  git("add", ".");
  git("commit", "-qm", "First commit");
  fs.writeFileSync(path.join(repo, "a.txt"), "two\n");
  store.saveConfig({ projects: [fs.realpathSync(repo), "/no/such/folder"] });
  const info = await gitIntegration();
  assert.equal(info.installed, true);
  assert.equal(info.state, "connected");
  const [found, gone] = info.repos;
  assert.equal(found.found, true);
  assert.equal(found.lastCommit!.subject, "First commit");
  assert.equal(found.uncommitted, 1);
  assert.equal(found.github, null);
  assert.equal(gone.found, false);
  assert.ok((await listIntegrations()).integrations.some((i) => i.id === "git"));
  for (const bad of ["", "not a url; rm -rf /", "file:///etc/passwd", "--upload-pack=touch /tmp/x", "https://example.com/../../x"]) await assert.rejects(cloneRepository(bad), /web address/);
  store.saveConfig({ projects: [] });
});

test("GitHub is connected through the web with a code; a connected repository can be removed", async () => {
  const http = await import("node:http");
  const { startGithubSignIn, pollGithubSignIn, disconnectRepository, gitIntegration } = await import("../../src/local/integrations.ts");
  // A stand-in for github.com: hands out a code, says "pending" once, then gives a token.
  let polls = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const fields = Object.fromEntries(new URLSearchParams(body));
      const send = (data: unknown) => (res.setHeader("content-type", "application/json"), res.end(JSON.stringify(data)));
      if (req.url === "/login/device/code") return send(fields.client_id === "Ov23liTestClient" ? { device_code: "dev-123", user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", interval: 1, expires_in: 900 } : { error: "incorrect_client_credentials" });
      if (req.url === "/login/oauth/access_token") return send(fields.device_code === "dev-123" && ++polls > 1 ? { access_token: "gho_testtoken", token_type: "bearer" } : { error: "authorization_pending" });
      if (req.url === "/user") return send(req.headers.authorization === "Bearer gho_testtoken" ? { login: "octo-owner", id: 7 } : {});
      if (req.url?.startsWith("/user/orgs")) return send([{ login: "talqava", description: "The company" }]);
      if (req.url?.startsWith("/user/repos")) return send([{ full_name: "octo-owner/notes", private: true, clone_url: "https://github.com/octo-owner/notes.git", description: null, pushed_at: "2026-11-01T00:00:00Z" }]);
      if (req.url?.startsWith("/orgs/talqava/repos")) return send([{ full_name: "talqava/app", private: true, clone_url: "https://github.com/talqava/app.git", description: "The product", pushed_at: "2026-11-20T00:00:00Z" }]);
      res.statusCode = 404;
      res.end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const at = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const keep = { web: process.env.TALQAVA_GITHUB_WEB, api: process.env.TALQAVA_GITHUB_API };
  process.env.TALQAVA_GITHUB_WEB = at;
  process.env.TALQAVA_GITHUB_API = at;
  try {
    // Without the app's Client ID there is nothing to sign in through, and it says what to do.
    store.saveConfig({ githubClientId: "", secrets: {} });
    await assert.rejects(startGithubSignIn(), /one-time set-up/);
    assert.equal((await gitIntegration()).github.canSignIn, false);
    store.saveConfig({ githubClientId: "Ov23liTestClient" });
    const started = await startGithubSignIn();
    assert.equal(started.code, "ABCD-1234");
    assert.match(started.url, /github\.com\/login\/device/);
    assert.ok(!JSON.stringify(started).includes("dev-123")); // the device code stays on the server
    assert.deepEqual(await pollGithubSignIn(), { done: false, wait: 1 });
    assert.deepEqual(await pollGithubSignIn(), { done: true, login: "octo-owner" });
    // The token is saved for api.github.com only, and the sign-in is over.
    assert.deepEqual(store.getConfig().secrets.GITHUB_TOKEN, { value: "gho_testtoken", host: "api.github.com" });
    await assert.rejects(pollGithubSignIn(), /No sign-in is under way/);
    assert.equal((await gitIntegration()).github.tokenSaved, true);
    // The person chooses whose repositories to bring in: their own, or a company they belong to.
    const { githubAccounts, githubRepos, autoSetupGit, removeGitIntegration } = await import("../../src/local/integrations.ts");
    assert.deepEqual((await githubAccounts()).accounts.map((a) => `${a.kind}:${a.login}`), ["personal:octo-owner", "company:talqava"]);
    assert.deepEqual((await githubRepos("octo-owner")).repos.map((r) => r.name), ["octo-owner/notes"]);
    assert.deepEqual((await githubRepos("talqava")).repos.map((r) => r.name), ["talqava/app"]);
    await assert.rejects(githubRepos("no-such-company"), /may need to allow this app/);
    await assert.rejects(githubRepos("../etc"), /Choose an account/);
    // Set-up reports the connection; it never signs in by itself.
    assert.match((await autoSetupGit()).steps.map((x) => x.title).join(" | "), /Connected to GitHub as octo-owner/);
    // Removing the integration disconnects every repository and forgets the sign-in; folders stay.
    const kept = fs.mkdtempSync(path.join(os.tmpdir(), "talqava-keep-"));
    store.saveConfig({ projects: [kept] });
    assert.deepEqual(removeGitIntegration(true), { repositories: 1, deleted: 0 });
    assert.ok(fs.existsSync(kept));
    assert.deepEqual(store.getConfig().projects, []);
    assert.equal(store.getConfig().secrets.GITHUB_TOKEN, undefined);
    assert.match((await autoSetupGit()).steps.map((x) => `${x.state}:${x.title}`).join(" | "), /action:Connect GitHub/);
  } finally {
    process.env.TALQAVA_GITHUB_WEB = keep.web ?? "";
    process.env.TALQAVA_GITHUB_API = keep.api ?? "";
    if (keep.web === undefined) delete process.env.TALQAVA_GITHUB_WEB;
    if (keep.api === undefined) delete process.env.TALQAVA_GITHUB_API;
    server.close();
    store.saveConfig({ githubClientId: "", secrets: {} });
  }

  // Removing a repository: a folder the person connected is left alone; a copy the app made can be deleted with it.
  const mine = fs.mkdtempSync(path.join(os.tmpdir(), "talqava-mine-"));
  const copy = path.join(store.DATA, "repos", "copied-repo");
  fs.mkdirSync(copy, { recursive: true });
  fs.writeFileSync(path.join(copy, "a.txt"), "x");
  store.saveConfig({ projects: [mine, copy] });
  assert.deepEqual(disconnectRepository(mine, true), { deleted: false });
  assert.ok(fs.existsSync(mine));
  assert.deepEqual(disconnectRepository(copy, true), { deleted: true });
  assert.ok(!fs.existsSync(copy));
  assert.deepEqual(store.getConfig().projects, []);
  assert.throws(() => disconnectRepository("/somewhere/else"), /not connected/);
});

test("whatever the owner built, copying examples never removes or redraws it, and an old organization converts with groups", async () => {
  const { orgs, groupOf } = await import("../../src/local/orgs.ts");
  const market = await import("../../src/local/marketplace.ts");
  const { INDUSTRIES, STRUCTURES } = await import("../../src/local/structures.ts");
  const org = orgs.create("Owner Co", "", "functional");
  for (const bot of ["dusk", "ember", "margo", "pip", "rivet", "tally"]) orgs.setMember(org.id, { bot });
  for (const bot of ["lead-developer", "frontend-developer", "backend-developer", "qa-tester", "head-of-finance", "bookkeeper", "competitor-watch"]) {
    if (!market.onTeam(bot)) market.addMarketBot(bot);
    orgs.setMember(org.id, { bot, manager: bot === "frontend-developer" || bot === "backend-developer" || bot === "qa-tester" ? "lead-developer" : bot === "bookkeeper" ? "head-of-finance" : null });
  }
  // The owner's own lines, including one no example would draw.
  orgs.setMember(org.id, { bot: "pip", manager: "qa-tester" });
  const lines = () => new Map(orgs.active().members.map((m) => [m.bot, m.manager]));
  const mine = lines();
  for (const industry of INDUSTRIES) {
    for (const st of STRUCTURES.filter((x) => x.id !== "custom")) {
      market.buildStructure(org.id, st.id, industry.id);
      const now = lines();
      for (const [bot, manager] of mine) assert.equal(now.get(bot), manager, `${industry.id}/${st.id}: ${bot} kept its line`);
    }
  }
  // An organization stored the old way (no groups) is converted once: departments become groups, led by their heads.
  const fs2 = await import("node:fs");
  const path2 = await import("node:path");
  const file = path2.join(store.DATA, "orgs.json");
  const stored = JSON.parse(fs2.readFileSync(file, "utf8"));
  const old = stored.orgs.find((o: { id: string }) => o.id === org.id);
  delete old.groups;
  delete old.model;
  fs2.writeFileSync(file, JSON.stringify(stored));
  const converted = orgs.list().orgs.find((o) => o.id === org.id)!;
  assert.equal(converted.model, 2);
  assert.ok(converted.groups.length > 0);
  for (const m of converted.members) assert.ok(converted.groups.some((g) => g.name === m.department), m.bot);
  assert.equal(groupOf(converted, "bookkeeper")!.lead, "head-of-finance");
  for (const [bot, manager] of mine) assert.equal(converted.members.find((m) => m.bot === bot)!.manager, manager, bot);
});

test("Talqava is an MCP server: another AI app can see the team, assign a task and read memory", { timeout: 30_000 }, async () => {
  const http = await import("node:http");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  // A stand-in for the running Talqava app.
  const seen: { method: string; url: string; body: unknown }[] = [];
  const appStandIn = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : null;
      seen.push({ method: req.method!, url: req.url!, body });
      const send = (d: unknown) => (res.setHeader("content-type", "application/json"), res.end(JSON.stringify(d)));
      if (req.url === "/api/crew") return send({ bots: [{ id: "head-of-marketing", name: "Head of Marketing", title: "Head of Marketing", group: "Marketing", instructions: "I lead marketing. More." }, { id: "bookkeeper", name: "Bookkeeper", title: "Bookkeeper", group: "Finance", instructions: "I keep the books in order." }] });
      if (req.url === "/api/orgs") return send({ active: "o1", orgs: [{ id: "o1", name: "Acme", mission: "Sell umbrellas.", structure: "functional", members: [{ bot: "head-of-marketing", title: "Head of Marketing", department: "Marketing", manager: null }, { bot: "bookkeeper", title: "Bookkeeper", department: "Finance", manager: null }] }] });
      if (req.url === "/api/quests" && req.method === "POST") return send({ id: "abcdef0123456789", title: "Plan a campaign", status: "running", bot: { id: "head-of-marketing", name: "Head of Marketing" }, steps: 0, cost: 0, approvals: [] });
      if (req.url === "/api/quests/abcdef0123456789") return send({ id: "abcdef0123456789", title: "Plan a campaign", status: "done", bot: { id: "head-of-marketing", name: "Head of Marketing" }, steps: 4, cost: 0.12, approvals: [] });
      if (req.url === "/api/conversations/abcdef0123456789") return send({ messages: [{ role: "user", content: "Plan a campaign" }, { role: "assistant", content: [{ type: "text", text: "Here is the plan: three emails." }] }] });
      if (req.url === "/api/orgs/o1/memory" && req.method === "GET") return send([{ id: "m1", text: "Our fiscal year starts in April.", shelf: "org", key: "" }]);
      if (req.url === "/api/orgs/o1/memory" && req.method === "POST") return send({ id: "m2" });
      res.statusCode = 404;
      send({ error: "not found" });
    });
  });
  await new Promise<void>((r) => appStandIn.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(appStandIn.address() as { port: number }).port}`;
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(import.meta.dirname, "../../src/local/mcp.ts")], env: { ...(process.env as Record<string, string>), TALQAVA_APP_URL: url } }));
  try {
    const say = async (name: string, args: Record<string, unknown> = {}) => {
      const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
      return { text: r.content[0].text, isError: Boolean(r.isError) };
    };
    assert.deepEqual((await client.listTools()).tools.map((t) => t.name), ["talqava_team", "talqava_assign_task", "talqava_task", "talqava_tasks", "talqava_memory"]);
    const who = await say("talqava_team");
    assert.match(who.text, /Acme — Sell umbrellas\./);
    assert.match(who.text, /- Head of Marketing \(Marketing; works for the owner\): I lead marketing\./);
    // A task goes to the named agent through the app, and its result can be read back.
    const assigned = await say("talqava_assign_task", { agent: "head of marketing", task: "Plan a three-email campaign for the spring sale." });
    assert.match(assigned.text, /Task id: abcdef0123456789/);
    assert.deepEqual(seen.find((x) => x.method === "POST" && x.url === "/api/quests")!.body, { bot: "head-of-marketing", text: "Plan a three-email campaign for the spring sale." });
    assert.match((await say("talqava_task", { id: "abcdef0123456789" })).text, /finished · 4 steps · \$0\.12[\s\S]*three emails/);
    // An agent that does not exist is refused with the names that do; a bad id never reaches the app.
    const wrong = await say("talqava_assign_task", { agent: "Chief Wizard", task: "Do something long enough." });
    assert.ok(wrong.isError && /Head of Marketing, Bookkeeper/.test(wrong.text));
    assert.ok((await say("talqava_task", { id: "../../etc/passwd" })).isError);
    assert.match((await say("talqava_memory", { action: "search", text: "fiscal year" })).text, /starts in April/);
    assert.match((await say("talqava_memory", { action: "add", text: "We close on Sundays." })).text, /Remembered/);
  } finally {
    await client.close();
    appStandIn.close();
  }

  // Adding Talqava to Claude's settings keeps everything else in that file.
  const { mcpIntegration, mcpLaunch } = await import("../../src/local/mcpintegration.ts");
  const info = mcpIntegration();
  assert.equal(info.id, "mcp");
  assert.match(info.launch.args[0], /src[\\/]local[\\/]mcp\.ts$/);
  assert.equal(JSON.parse(info.snippet).mcpServers.talqava.command, mcpLaunch().command);
  assert.equal(info.tools.length, 5);

  // In a pretend home folder: Claude's settings keep what they had, gain one entry, and lose only that entry again.
  const { setClaudeDesktop } = await import("../../src/local/mcpintegration.ts");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "talqava-home-"));
  const keepHome = process.env.HOME;
  process.env.HOME = home;
  try {
    assert.throws(() => setClaudeDesktop(true), /does not seem to be installed/);
    const dir = path.join(home, "Library", "Application Support", "Claude");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "claude_desktop_config.json");
    fs.writeFileSync(file, JSON.stringify({ preferences: { theme: "dark" }, mcpServers: { other: { command: "x" } } }));
    if (process.platform === "darwin") {
      assert.equal(setClaudeDesktop(true).added, true);
      let now = JSON.parse(fs.readFileSync(file, "utf8"));
      assert.deepEqual(now.preferences, { theme: "dark" });
      assert.deepEqual(Object.keys(now.mcpServers).sort(), ["other", "talqava"]);
      assert.match(now.mcpServers.talqava.args[0], /mcp\.ts$/);
      assert.ok(fs.existsSync(`${file}.before-talqava`));
      assert.equal(mcpIntegration().claude.added, true);
      setClaudeDesktop(false);
      now = JSON.parse(fs.readFileSync(file, "utf8"));
      assert.deepEqual(Object.keys(now.mcpServers), ["other"]);
    }
  } finally {
    process.env.HOME = keepHome;
  }
});

test("the library: dropped documents are read into the organization's database and agents find only what they may use", { timeout: 30_000 }, async () => {
  const { orgs } = await import("../../src/local/orgs.ts");
  const market = await import("../../src/local/marketplace.ts");
  const { library, libraryFolder, syncLibrary, passagesOf, libraryTool, libraryPrompt, removeLibrary } = await import("../../src/local/library.ts");
  const org0 = orgs.create("Library Co", "", "functional");
  market.buildStructure(org0.id, "functional", "general");
  const org = () => orgs.active();
  const root = libraryFolder(org0.id);

  // A stored (uncompressed) zip, which is what a .docx is.
  const zip = (files: Record<string, string>) => {
    const local: Buffer[] = [];
    const central: Buffer[] = [];
    let offset = 0;
    for (const [name, text] of Object.entries(files)) {
      const data = Buffer.from(text);
      const head = Buffer.alloc(30);
      head.writeUInt32LE(0x04034b50, 0);
      head.writeUInt16LE(20, 4);
      head.writeUInt32LE(data.length, 18);
      head.writeUInt32LE(data.length, 22);
      head.writeUInt16LE(name.length, 26);
      local.push(head, Buffer.from(name), data);
      const entry = Buffer.alloc(46);
      entry.writeUInt32LE(0x02014b50, 0);
      entry.writeUInt32LE(data.length, 20);
      entry.writeUInt32LE(data.length, 24);
      entry.writeUInt16LE(name.length, 28);
      entry.writeUInt32LE(offset, 42);
      central.push(entry, Buffer.from(name));
      offset += 30 + name.length + data.length;
    }
    const dir = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(Object.keys(files).length, 8);
    end.writeUInt16LE(Object.keys(files).length, 10);
    end.writeUInt32LE(dir.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...local, dir, end]);
  };
  // A one-page PDF.
  const pdf = (line: string) => {
    const stream = `BT /F1 12 Tf 20 100 Td (${line}) Tj ET`;
    const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>", `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
    let out = "%PDF-1.4\n";
    const at: number[] = [];
    objects.forEach((o, i) => (at.push(out.length), (out += `${i + 1} 0 obj\n${o}\nendobj\n`)));
    const xref = out.length;
    out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${at.map((n) => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(out);
  };

  // Uploading puts the file in the folder it was sent to; dropping one into the folder by hand works the same.
  assert.deepEqual(await library.add(org(), "Refund policy.pdf", pdf("Refunds are accepted within thirty days of purchase.")), { path: "Everyone/Refund policy.pdf" });
  await library.add(org(), "Handbook.docx", zip({ "word/document.xml": "<w:document><w:body><w:p><w:r><w:t>Holiday requests go to the Head of People.</w:t></w:r></w:p><w:p><w:r><w:t>Expenses &amp; receipts are due monthly.</w:t></w:r></w:p></w:body></w:document>" }));
  await library.add(org(), "price list.csv", Buffer.from("item,price\nUmbrella,24\nRaincoat,60\n"), "Finance");
  fs.writeFileSync(path.join(root, "Sales", "pitch notes.md"), "# Pitch\n\nLead with the lifetime guarantee. Never discount below ten percent.\n");
  fs.writeFileSync(path.join(root, "Everyone", "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 13, 0, 1, 2, 3]));
  assert.deepEqual(await syncLibrary(org()), { added: 2, updated: 0, removed: 0 });
  // Nothing has changed, so nothing is read again.
  assert.deepEqual(await syncLibrary(org()), { added: 0, updated: 0, removed: 0 });
  assert.ok(fs.existsSync(path.join(DATA_FOR_TEST(), "organizations", org0.id, "organization.db")));

  const docs = library.list(org());
  assert.deepEqual(docs.map((d) => d.path), ["Everyone/Handbook.docx", "Everyone/Refund policy.pdf", "Everyone/logo.png", "Finance/price list.csv", "Sales/pitch notes.md"]);
  const by = (p: string) => docs.find((d) => d.path === p)!;
  assert.equal(by("Everyone/Refund policy.pdf").problem, "");
  assert.equal(by("Everyone/Handbook.docx").problem, "");
  assert.ok(by("Everyone/Refund policy.pdf").readable && by("Everyone/Handbook.docx").readable);
  assert.equal(by("Everyone/logo.png").readable, false);
  // The folder decides who may use a file: Everyone, or one department.
  assert.deepEqual(by("Everyone/Refund policy.pdf").access, { everyone: true, private: false, departments: [], agents: [] });
  assert.deepEqual(by("Finance/price list.csv").access, { everyone: false, private: false, departments: ["Finance"], agents: [] });

  // The person searches everything; words match in other forms ("refund" finds "Refunds").
  assert.equal(library.search(org(), null, "refund")[0].name, "Refund policy.pdf");
  assert.match(library.search(org(), null, "holiday request")[0].text, /Head of People/);
  assert.match(library.search(org(), null, "expenses receipts")[0].text, /Expenses & receipts/);
  assert.equal(library.search(org(), null, "logo")[0].name, "logo.png"); // a file with no text is found by its name
  // An agent finds only what is shared with it or its department.
  assert.equal(library.search(org(), "bookkeeper", "umbrella price")[0].name, "price list.csv");
  assert.deepEqual(library.search(org(), "content-writer", "umbrella price"), []);
  assert.equal(library.search(org(), "account-executive", "lifetime guarantee")[0].name, "pitch notes.md");
  assert.deepEqual(library.search(org(), "bookkeeper", "lifetime guarantee"), []);
  assert.equal(library.search(org(), "bookkeeper", "refunds")[0].name, "Refund policy.pdf");
  assert.throws(() => library.read(org(), "content-writer", by("Finance/price list.csv").id), /not one you may use/);
  assert.match(library.read(org(), "bookkeeper", by("Finance/price list.csv").id).text, /Raincoat,60/);

  // The person can change who may use one document: here, one named agent as well as Finance.
  library.setAccess(org(), by("Finance/price list.csv").id, { everyone: false, departments: ["Finance"], agents: ["content-writer"] });
  assert.equal(library.search(org(), "content-writer", "umbrella price")[0].name, "price list.csv");
  assert.deepEqual(library.search(org(), "account-executive", "umbrella price"), []);
  library.setAccess(org(), by("Finance/price list.csv").id, null); // back to what its folder says
  assert.deepEqual(library.search(org(), "content-writer", "umbrella price"), []);

  // A long document is cut into passages and read a stretch at a time.
  const long = Array.from({ length: 40 }, (_, i) => `Section ${i + 1}. ${"The quick brown fox jumps over the lazy dog. ".repeat(8)}`).join("\n\n");
  assert.ok(passagesOf(long).every((p) => p.length <= 900) && passagesOf(long).length > 10);
  await library.add(org(), "long report.txt", Buffer.from(long));
  const report = library.list(org()).find((d) => d.name === "long report.txt")!;
  const first = library.read(org(), null, report.id);
  assert.ok(first.to < first.parts && first.text.length <= 6900);
  assert.match(library.read(org(), null, report.id, first.to + 1).text, /Section/);

  // The agents' tool: it speaks as the agent in the conversation, and is told the library exists.
  const tool = libraryTool(() => "bookkeeper");
  const ctx = { signal: new AbortController().signal, conversation: { id: "x".repeat(16), messages: [] } as unknown as Conversation };
  assert.match(String(await tool.run({ action: "search", query: "raincoat" }, ctx)), /price list\.csv · part 1/);
  assert.match(String(await tool.run({ action: "search", query: "lifetime guarantee" }, ctx)), /Nothing in the library matches/);
  assert.doesNotMatch(String(await tool.run({ action: "list" }, ctx)), /pitch notes/);
  assert.match(libraryPrompt(org(), "bookkeeper"), /documents the owner has put in the organization's library/);
  const asBookkeeper = (await tools.localRunSpec(app.jobs)({ id: "3".repeat(16), bot: "bookkeeper", messages: [] } as unknown as Conversation));
  assert.ok(asBookkeeper.tools.some((t) => t.name === "library"));
  assert.match(asBookkeeper.system, /The organization's library/);

  // A changed file is read again; a deleted one is forgotten, whether removed in the app or from the folder.
  fs.writeFileSync(path.join(root, "Sales", "pitch notes.md"), "# Pitch\n\nLead with free delivery.\n");
  assert.deepEqual(await syncLibrary(org()), { added: 0, updated: 1, removed: 0 });
  assert.deepEqual(library.search(org(), null, "lifetime guarantee"), []);
  assert.equal(library.search(org(), null, "free delivery")[0].name, "pitch notes.md");
  await library.remove(org(), report.id);
  assert.ok(!fs.existsSync(path.join(root, "Everyone", "long report.txt")));
  fs.rmSync(path.join(root, "Everyone", "logo.png"));
  assert.equal((await syncLibrary(org())).removed, 1);
  assert.equal(library.stats(org()).documents, 4);
  // A file name cannot climb out of the library.
  assert.match((await library.add(org(), "../../escape.txt", Buffer.from("x"))).path, /^Everyone\/escape\.txt$/);
  removeLibrary(org0.id);
  assert.ok(!fs.existsSync(root));
});
const DATA_FOR_TEST = () => store.DATA;

test("a task that is waiting on its own hand-offs is not reported upward as finished; its real report is", { timeout: 30_000 }, async () => {
  const { orgs } = await import("../../src/local/orgs.ts");
  const market = await import("../../src/local/marketplace.ts");
  const quests = await import("../../src/local/quests.ts");
  const org = orgs.create("Chain Co", "", "team");
  market.buildStructure(org.id, "team", "software");
  const leadBot = (await import("../../src/local/crew.ts")).findBot("lead-developer");
  // The lead hands a part to the front-end developer, who asks a colleague a question and ends its turn to wait.
  // Then the answer comes back, the developer writes its real report, and only that reaches the lead.
  // The three runs overlap, so each is answered by who is asking and how far it has got, not by order.
  mock.route = (body) => {
    const system = JSON.stringify(body.system);
    const said = JSON.stringify(body.messages);
    if (/A colleague has put a question to you/.test(system)) return say("It calls POST /signup.");
    if (/the Front-End Developer in the user's organization/.test(system)) {
      if (/Report from Back-End Developer/.test(said)) return say("REAL REPORT: the sign-up page has two problems.");
      if (/tool_result/.test(said)) return say("I have asked the back-end developer and am waiting for the answer.");
      return call("ask_colleague", { to: "Back-End Developer", question: "Which endpoint does the sign-up page call?" });
    }
    if (/the Lead Developer in the user's organization/.test(system)) {
      if (/Report from Front-End Developer/.test(said)) return say("Combined result: two problems on the sign-up page.");
      if (/tool_result/.test(said)) return say("Handed to the front-end developer; waiting.");
      return call("assign_task", { to: "Front-End Developer", task: "Review the sign-up page and list the problems you find." });
    }
    return undefined;
  };
  const root = await quests.quests.start({ bot: leadBot, text: "Review the sign-up flow as a team." });
  const all = () => quests.questStore.list().filter((q) => (q.root ?? q.id) === root.id);
  const settled = () => all().length >= 3 && all().every((q) => q.status !== "running" && q.status !== "waiting" && (!q.parent || q.parent.delivered)) && !app.engine.isRunning(root.id);
  for (let i = 0; i < 300 && !settled(); i++) await new Promise((r) => setTimeout(r, 50));
  mock.route = undefined;
  assert.ok(settled(), `the chain finished: ${all().map((q) => `${q.bot.id}:${q.status}:${q.parent?.delivered}`).join(" ")}`);
  const texts = store.conversations.get(root.id)!.messages.filter((m) => typeof m.content === "string").map((m) => String(m.content));
  const reports = texts.filter((t) => t.startsWith("[Report from Front-End Developer"));
  // Exactly one report from the developer reached the lead, and it is the real one, not "I am waiting".
  assert.equal(reports.length, 1);
  assert.match(reports[0], /REAL REPORT/);
  assert.doesNotMatch(reports[0], /am waiting/);
  // Every task in the chain knows which task it came from, so they share one budget and one total.
  assert.equal(all().length, 3);
  assert.ok(all().every((q) => q.root === root.id));
  assert.equal(quests.chainSize(root.id), 3);
});

test("a task may ask three colleagues at most, never the same question twice, and shares one budget with its hand-offs", { timeout: 30_000 }, async () => {
  const { orgs } = await import("../../src/local/orgs.ts");
  const quests = await import("../../src/local/quests.ts");
  const org = orgs.active();
  assert.ok(org.members.length > 6);
  const chat = store.conversations.create({ bot: "lead-developer" });
  const ctx = { signal: new AbortController().signal, conversation: { id: chat.id, bot: "lead-developer", messages: [] } as unknown as Conversation };
  for (let i = 0; i < 12; i++) script.push(say(`Answer ${i}.`));
  const names = org.members.map((m) => m.bot).filter((id) => id !== "lead-developer");
  await tools.askTool.run({ to: names[0], question: "What is the deadline for the spring release, exactly?" }, ctx);
  // The same question to someone else is polling, and is refused.
  await assert.rejects(Promise.resolve(tools.askTool.run({ to: names[1], question: "What is the deadline for the spring release, exactly?" }, ctx)), /same question/);
  await tools.askTool.run({ to: names[1], question: "Which customers are waiting on the export feature?" }, ctx);
  await tools.askTool.run({ to: names[2], question: "Is the staging server free on Thursday afternoon?" }, ctx);
  // A fourth is refused, whoever it is for.
  await assert.rejects(Promise.resolve(tools.askTool.run({ to: names[3], question: "Who approved the new pricing page copy?" }, ctx)), /already asked 3 colleagues/);
  assert.equal(quests.questStore.list().filter((q) => q.parent?.id === chat.id && q.kind === "question").length, 3);
  for (let i = 0; i < 200 && quests.questStore.list().some((q) => q.parent?.id === chat.id && (q.status === "running" || !q.parent.delivered)); i++) await new Promise((r) => setTimeout(r, 50));

  // The shared budget: once a task and its hand-offs have cost the budget for one task, nothing more is handed on.
  const leadBot = (await import("../../src/local/crew.ts")).findBot("lead-developer");
  script.push(say("Started."));
  const root = await quests.quests.start({ bot: leadBot, text: "A task whose budget is about to be used up." });
  for (let i = 0; i < 100 && app.engine.isRunning(root.id); i++) await new Promise((r) => setTimeout(r, 50));
  const conversation = store.conversations.get(root.id)!;
  store.conversations.save({ ...conversation, usage: { ...conversation.usage, cost: quests.chainBudget() + 0.01 } }, { touch: false });
  assert.equal(quests.chainOver(root.id), true);
  const asRoot = { signal: new AbortController().signal, conversation: { id: root.id, messages: [] } as unknown as Conversation };
  await assert.rejects(Promise.resolve(tools.assignTool.run({ to: "Front-End Developer", task: "Something long enough to be a task." }, asRoot)), /used the whole budget for one task/);
  await assert.rejects(Promise.resolve(tools.askTool.run({ to: "Back-End Developer", question: "Anything at all, long enough?" }, asRoot)), /used the whole budget for one task/);
});

test("a task about the repository gets the only connected one; an agent is told when none is attached", async () => {
  const leadBot = (await import("../../src/local/crew.ts")).findBot("lead-developer");
  const quests = await import("../../src/local/quests.ts");
  // With repositories connected but none attached, the agent is told which exist and to stop and ask, not to hand out work.
  store.saveConfig({ projects: ["/somewhere/alpha-app", "/somewhere/beta-site"] });
  script.push(say("ok"));
  const none = await quests.quests.start({ bot: leadBot, text: "Review our repository." });
  for (let i = 0; i < 100 && app.engine.isRunning(none.id); i++) await new Promise((r) => setTimeout(r, 50));
  const spec = await tools.localRunSpec(app.jobs)(store.conversations.get(none.id)!);
  assert.match(spec.system, /No repository is attached to this task\. The owner has connected alpha-app, beta-site/);
  assert.match(spec.system, /Every step costs the owner money/);
  store.saveConfig({ projects: [] });
});

test("cost saving is the owner's switch: off uses their model for everything, on matches the model to the work", async () => {
  const crew = await import("../../src/local/crew.ts");
  const lead = crew.findBot("lead-developer");
  const cfg = { ...store.getConfig(), model: "anthropic/claude-opus-5-5", effort: "high" as const };
  // Off (the default): every kind of work runs on the owner's model. Only a quick question thinks less hard.
  assert.deepEqual(tools.costModel({ ...cfg, savings: undefined }, lead, "manager"), { ref: "anthropic/claude-opus-5-5", effort: "high" });
  assert.deepEqual(tools.costModel({ ...cfg, savings: "off" }, lead, "member"), { ref: "anthropic/claude-opus-5-5", effort: "high" });
  assert.deepEqual(tools.costModel({ ...cfg, savings: "off" }, lead, "question"), { ref: "anthropic/claude-opus-5-5", effort: "low" });
  // On: a manager keeps the owner's model, a member doing its part gets the mid-size one, a question the small one.
  const on = { ...cfg, savings: "balanced" as const };
  assert.deepEqual(tools.costModel(on, lead, "manager"), { ref: "anthropic/claude-opus-5-5", effort: "high" });
  assert.deepEqual(tools.costModel(on, lead, "member"), { ref: "anthropic/claude-sonnet-5-5", effort: "medium" });
  assert.deepEqual(tools.costModel(on, lead, "question"), { ref: "anthropic/claude-haiku-5-5", effort: "low" });
  // An agent given a model of its own keeps it, and so does a task handed to a named model.
  assert.equal(tools.costModel(on, { ...lead, model: "local/qwen3:8b" }, "member").ref, "local/qwen3:8b");
  assert.equal(tools.costModel(on, lead, "member", "anthropic/claude-fable-5-2").ref, "anthropic/claude-fable-5-2");
  // A model that is already the cheaper kind, or from another provider, is left alone.
  assert.equal(tools.costModel({ ...on, model: "anthropic/claude-sonnet-5-5" }, lead, "member").ref, "anthropic/claude-sonnet-5-5");
});

test("OpenRouter: sign in through the web, models with their prices, a model for the team, and removing it", async () => {
  const or = await import("../../src/local/openrouter.ts");
  const http = await import("node:http");
  const seen: { url: string; body: any; headers: Record<string, unknown> }[] = [];
  const standIn = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    seen.push({ url: req.url ?? "", body: raw ? JSON.parse(raw) : null, headers: req.headers });
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url === "/api/v1/auth/keys") return res.end(JSON.stringify({ key: "sk-or-v1-testkey0123456789" }));
    if (req.url?.startsWith("/api/v1/models")) {
      return res.end(JSON.stringify({ data: [
        { id: "anthropic/claude-sonnet-5.5", name: "Anthropic: Claude Sonnet 5.5", context_length: 1000000, pricing: { prompt: "0.000002", completion: "0.00001" }, supported_parameters: ["tools", "tool_choice"] },
        { id: "some/free-model:free", name: "Some Free Model", context_length: 64000, pricing: { prompt: "0", completion: "0" }, supported_parameters: ["tools"] },
        { id: "some/no-tools", name: "No Tools", context_length: 8000, pricing: { prompt: "0.000001", completion: "0.000001" }, supported_parameters: ["temperature"] },
        { id: "openrouter/auto", name: "Auto Router", context_length: 2000000, pricing: { prompt: "-1", completion: "-1" }, supported_parameters: ["tools"] },
      ] }));
    }
    if (req.url === "/api/v1/key") return res.end(JSON.stringify({ data: { label: "Talqava Agents", usage: 1.5, limit: 10, limit_remaining: 8.5, is_free_tier: false } }));
    res.end("{}");
  });
  await new Promise<void>((r) => standIn.listen(0, "127.0.0.1", r));
  const address = `http://127.0.0.1:${(standIn.address() as import("node:net").AddressInfo).port}`;
  process.env.TALQAVA_OPENROUTER_API = `${address}/api/v1`;
  try {
    // Starting: the browser is sent to openrouter.ai with a fingerprint of a secret, and asked to come back to this app on localhost.
    const { url } = or.startOpenRouterSignIn("http://127.0.0.1:8788");
    const asked = new URL(url);
    assert.equal(asked.origin + asked.pathname, "https://openrouter.ai/auth");
    assert.equal(asked.searchParams.get("callback_url"), "http://localhost:8788/api/integrations/openrouter/callback");
    assert.equal(asked.searchParams.get("code_challenge_method"), "S256");
    assert.match(asked.searchParams.get("code_challenge")!, /^[\w-]{43}$/);
    // A made-up state is refused, and the real one works once.
    await assert.rejects(or.finishOpenRouterSignIn("code-1", "not-the-state"), /expired or was already used/);
    await or.finishOpenRouterSignIn("code-1", asked.searchParams.get("state"));
    const exchange = seen.find((x) => x.url === "/api/v1/auth/keys")!;
    assert.equal(exchange.body.code, "code-1");
    assert.equal(exchange.body.code_challenge_method, "S256");
    // The secret sent now matches the fingerprint sent before.
    const crypto = await import("node:crypto");
    assert.equal(crypto.createHash("sha256").update(exchange.body.code_verifier).digest("base64url"), asked.searchParams.get("code_challenge"));
    await assert.rejects(or.finishOpenRouterSignIn("code-1", asked.searchParams.get("state")), /expired or was already used/);
    assert.equal(store.getConfig().providers.find((p) => p.id === "openrouter")?.apiKey, "sk-or-v1-testkey0123456789");

    // Models: dollars per token become dollars per million; models without tools, and routers with no fixed price, are left out.
    const info = await or.openrouterIntegration();
    assert.equal(info.state, "connected");
    assert.deepEqual(info.models.map((m) => m.id), ["anthropic/claude-sonnet-5.5", "some/free-model:free"]);
    assert.deepEqual(info.models[0].prices, { input: 2, output: 10 });
    assert.equal(info.models[0].contextTokens, 1000000);
    assert.equal(info.models[1].free, true);
    assert.equal(info.account?.remaining, 8.5);
    assert.equal(info.suggested[0]?.id, "anthropic/claude-sonnet-5.5");

    // Choosing a model for the team: the main model becomes it, with its own prices and attribution headers.
    await assert.rejects(or.useOpenRouterModel("some/no-tools"), /does not list/);
    await or.useOpenRouterModel("anthropic/claude-sonnet-5.5");
    assert.equal(store.getConfig().model, "openrouter/anthropic/claude-sonnet-5.5");
    const { resolveModel } = await import("../../src/local/models.ts");
    const model = resolveModel();
    assert.equal(model.label, "anthropic/claude-sonnet-5.5 on OpenRouter");
    assert.deepEqual(model.prices, { input: 2, output: 10 });

    // Removing: the key is forgotten and the team goes back to Claude.
    or.removeOpenRouter();
    assert.equal(store.getConfig().model, "anthropic/claude-opus-5-5");
    assert.equal(store.getConfig().providers.some((p) => p.id === "openrouter"), false);
    await assert.rejects(or.saveOpenRouterKey("not-a-key"), /starts with sk-or-/);
  } finally {
    delete process.env.TALQAVA_OPENROUTER_API;
    standIn.close();
  }
});

test("a task is checked before it starts: work on code with no repository is caught, for free", async () => {
  const { needsFor, aboutCode } = await import("../../src/local/preflight.ts");
  const crew = await import("../../src/local/crew.ts");
  const lead = crew.findBot("lead-developer");
  store.saveConfig({ projects: [] });
  // Code work with no repository connected: one need, which the person may skip.
  const needs = needsFor({ bot: lead, text: "Review our GitHub repository for bugs" });
  assert.deepEqual(needs.map((n) => [n.id, n.canSkip]), [["repository", true]]);
  // Ordinary business work is not held up, and the team instruction added to team tasks does not count.
  for (const text of ["Plan our spring sale campaign", "Draft a follow-up email to a prospect", "Commit to a budget for the new branch office"]) assert.equal(aboutCode(text), false, text);
  assert.equal(needsFor({ bot: lead, text: "Plan our spring sale campaign\n\n[This task is for your whole team (the Engineering team), not for you alone. Split it into parts and hand each part to the right member of your team with assign_task.]" }).length, 0);
  // With a repository given, nothing is missing; with several connected and none given, the person chooses.
  assert.equal(needsFor({ bot: lead, text: "Refactor the sign-up code", project: "/some/repo" }).length, 0);
  store.saveConfig({ projects: ["/a/one", "/a/two"] });
  assert.equal(needsFor({ bot: lead, text: "Refactor the sign-up code" })[0].id, "choose-repository");
  store.saveConfig({ projects: [] });
  // A model with no key cannot be skipped past.
  const saved = store.getConfig();
  store.saveConfig({ model: "openrouter/some/model", providers: [...saved.providers.filter((p) => p.id !== "openrouter"), { id: "openrouter", kind: "openai", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" }] });
  assert.deepEqual(needsFor({ bot: { ...lead, model: undefined }, text: "Plan a campaign" }).map((n) => [n.id, n.canSkip]), [["model-key", false]]);
  store.saveConfig({ model: saved.model, providers: saved.providers });
});

test("the library works like a file manager: folders, moves that keep settings, private files no agent sees, and Deleted", { timeout: 30_000 }, async () => {
  const { orgs } = await import("../../src/local/orgs.ts");
  const market = await import("../../src/local/marketplace.ts");
  const { library, libraryFolder, syncLibrary, libraryTool, GENERAL_AGENT } = await import("../../src/local/library.ts");
  const org0 = orgs.create("Files Co", "", "functional");
  market.buildStructure(org0.id, "functional", "general");
  const org = () => orgs.active();
  const root = libraryFolder(org0.id);
  const by = (p: string) => library.list(org()).find((d) => d.path === p)!;

  // Folders at any depth; a name cannot climb out of the library.
  library.makeFolder(org(), "", "Clients");
  library.makeFolder(org(), "Clients", "Acme");
  assert.throws(() => library.makeFolder(org(), "Clients", "Acme"), /already something called/);
  assert.throws(() => library.makeFolder(org(), "../..", "Escape"), /not a folder in the library/);
  assert.ok(library.folders(org()).some((f) => f.path === "Clients/Acme"));
  // Uploading into a folder, and a dropped folder's own sub-folders.
  await library.add(org(), "contract.txt", Buffer.from("The Acme contract renews every March."), "Clients/Acme");
  await library.add(org(), "Notes/call.txt", Buffer.from("Acme asked about bulk pricing."), "Clients/Acme");
  assert.ok(by("Clients/Acme/contract.txt") && by("Clients/Acme/Notes/call.txt"));

  // Private: the owner finds it, no agent does, the general chat agent included; and a folder's setting covers what is inside.
  library.setAccess(org(), by("Clients/Acme/contract.txt").id, { private: true });
  assert.equal(library.search(org(), null, "renews march")[0].name, "contract.txt");
  assert.deepEqual(library.search(org(), "bookkeeper", "renews march"), []);
  assert.deepEqual(library.search(org(), GENERAL_AGENT, "renews march"), []);
  assert.throws(() => library.read(org(), GENERAL_AGENT, by("Clients/Acme/contract.txt").id), /not one you may use/);
  const asChat = libraryTool(() => null);
  const ctx = { signal: new AbortController().signal, conversation: { id: "y".repeat(16), messages: [] } as unknown as Conversation };
  assert.doesNotMatch(String(await asChat.run({ action: "list" }, ctx)), /contract\.txt/);
  library.setFolderAccess(org(), "Clients", { private: true });
  assert.equal(by("Clients/Acme/Notes/call.txt").access.private, true);
  assert.equal(by("Clients/Acme/Notes/call.txt").accessFrom, "Clients");
  assert.deepEqual(library.search(org(), GENERAL_AGENT, "bulk pricing"), []);
  library.setFolderAccess(org(), "Clients", null);
  assert.equal(library.search(org(), GENERAL_AGENT, "bulk pricing")[0].name, "call.txt");

  // Moving and renaming keep a file's settings and its text; a folder cannot go inside itself.
  await library.move(org(), [{ kind: "folder", path: "Clients/Acme" }], "");
  assert.equal(by("Acme/contract.txt").access.private, true);
  assert.ok(by("Acme/Notes/call.txt").passages > 0);
  await assert.rejects(library.move(org(), [{ kind: "folder", path: "Acme" }], "Acme/Notes"), /cannot go inside itself/);
  await library.move(org(), [{ kind: "file", path: "Acme/contract.txt" }], "Acme", "Acme contract 2027.txt");
  assert.equal(by("Acme/Acme contract 2027.txt").access.private, true);
  // A move made in Finder is recognised by the file's contents, so its setting stays too.
  fs.renameSync(path.join(root, "Acme", "Acme contract 2027.txt"), path.join(root, "Everyone", "moved.txt"));
  await syncLibrary(org());
  assert.equal(by("Everyone/moved.txt").access.private, true);

  // Deleting goes to Deleted; restoring brings it back with its setting; Delete forever removes it.
  await library.remove(org(), [{ kind: "folder", path: "Acme" }, { kind: "file", path: "Everyone/moved.txt" }]);
  assert.ok(!fs.existsSync(path.join(root, "Acme")));
  assert.equal(library.list(org()).filter((d) => d.path.startsWith("Acme/") || d.path === "Everyone/moved.txt").length, 0);
  const deleted = library.deleted(org());
  assert.deepEqual(deleted.map((t) => t.name).sort(), ["Acme", "moved.txt"]);
  await library.restore(org(), deleted.find((t) => t.name === "moved.txt")!.id);
  assert.equal(by("Everyone/moved.txt").access.private, true);
  assert.equal(library.purge(org(), "all").removed, 1);
  assert.deepEqual(library.deleted(org()), []);
  orgs.remove(org0.id);
});

test("before starting, an agent checks it has what the task needs, asks the owner if not, and everything is in the audit log", { timeout: 30_000 }, async () => {
  const quests = await import("../../src/local/quests.ts");
  const crew = await import("../../src/local/crew.ts");
  const { readAudit } = await import("../../src/local/audit.ts");
  store.saveConfig({ checkFirst: true });
  // Replies left over from earlier tests would be taken as the check's answer.
  script.length = 0;
  (mock as { route?: unknown }).route = undefined;
  try {
    // A clean copy: earlier tests may have pointed this agent at a model that is no longer there.
    const bot = { ...crew.findBot("pip"), model: undefined };
    // Something essential is missing: the agent asks instead of starting.
    script.push(say('{"ready": false, "missing": ["Which market to research"], "questions": ["Which country should I look at?"], "plan": "Compare prices"}'));
    const asked = await quests.quests.start({ bot, text: "Research our competitors' prices." });
    assert.equal(asked.status, "asking");
    const conv = store.conversations.get(asked.id)!;
    assert.equal(conv.messages.length, 2);
    assert.match(JSON.stringify(conv.messages[1].content), /Which country should I look at\?/);
    assert.ok((conv.usage.cost ?? 0) > 0, "the check's cost is on the task");
    // The owner's reply starts the task, with the task, the questions and the answer all in front of the agent.
    script.push(say("Done: prices for Canada compared."));
    await app.engine.startRun(asked.id, "Canada, please.");
    for (let i = 0; i < 50 && quests.questStore.get(asked.id)?.status !== "done"; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(quests.questStore.get(asked.id)?.status, "done");
    assert.equal(quests.questStore.get(asked.id)?.note, undefined);
    // Ready: it starts at once.
    script.push(say('{"ready": true, "missing": [], "questions": [], "plan": "Write it"}'), say("Here is the summary."));
    const started = await quests.quests.start({ bot, text: "Summarize our refund policy." });
    for (let i = 0; i < 50 && quests.questStore.get(started.id)?.status !== "done"; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(quests.questStore.get(started.id)?.status, "done");
    // A muddled answer never blocks work.
    script.push(say("I am not sure what you mean."), say("Done anyway."));
    const muddled = await quests.quests.start({ bot, text: "Tidy the notes." });
    assert.notEqual(muddled.status, "asking");
    for (let i = 0; i < 50 && quests.questStore.get(muddled.id)?.status === "running"; i++) await new Promise((r) => setTimeout(r, 20));

    // The audit log has the task, the check, the question, the run and its cost; secrets never appear in it.
    const log = readAudit({ limit: 200 }).entries;
    assert.ok(log.some((e) => e.task === asked.id && /Asked the owner/.test(e.action) && /Which country/.test(e.detail ?? "")));
    assert.ok(log.some((e) => e.task === started.id && /has what it needs/.test(e.action)));
    assert.ok(log.some((e) => e.task === asked.id && e.kind === "spend"));
    const { audit, redact } = await import("../../src/local/audit.ts");
    audit({ actor: "owner", actorName: "You", kind: "settings", action: "Changed settings", detail: JSON.stringify(redact({ apiKey: "sk-ant-api03-secretsecretsecret", budget: 2 })) });
    const last = readAudit({ limit: 1 }).entries[0];
    assert.doesNotMatch(JSON.stringify(last), /secretsecret/);
    assert.match(last.detail ?? "", /"budget":2/);
    assert.ok(readAudit({ q: "country", limit: 50 }).entries.length >= 1);
  } finally {
    store.saveConfig({ checkFirst: false });
  }
});


test("agents start from the library passages that match their task (never private ones) and can read every saved skill", { timeout: 30_000 }, async () => {
  const { orgs } = await import("../../src/local/orgs.ts");
  const market = await import("../../src/local/marketplace.ts");
  const { library, libraryPrompt } = await import("../../src/local/library.ts");
  const org0 = orgs.create("Knowledge Co", "", "functional");
  market.buildStructure(org0.id, "functional", "general");
  const org = () => orgs.active();
  try {
    await library.add(org(), "shipping.txt", Buffer.from("Orders ship within two working days from the Leeds warehouse."));
    await library.add(org(), "salaries.txt", Buffer.from("Salary bands for the Leeds warehouse staff."));
    library.setAccess(org(), library.list(org()).find((d) => d.name === "salaries.txt")!.id, { private: true });
    const prompt = libraryPrompt(org(), "bookkeeper", "How fast do orders ship from the Leeds warehouse?");
    assert.match(prompt, /ship within two working days/);
    assert.doesNotMatch(prompt, /Salary bands/);
    // Without a task to match, only the note that the library exists.
    assert.doesNotMatch(libraryPrompt(org(), "bookkeeper"), /two working days/);

    // A saved skill: an agent without the skills ability still gets a tool to read it.
    await store.skills.save({ name: "refund-steps", description: "How we handle refunds", content: "1. Check the receipt. 2. Refund within 30 days." });
    const spec = await tools.localRunSpec(app.jobs)({ id: "7".repeat(16), bot: "bookkeeper", messages: [], usage: { input: 0, output: 0 } } as unknown as Conversation);
    const skill = spec.tools.find((t) => t.name === "skill");
    assert.ok(skill, "the agent can read skills");
    assert.match(String(await skill!.run({ name: "refund-steps" }, context)), /Refund within 30 days/);
    assert.match(spec.system, /refund-steps/);
  } finally {
    orgs.remove(org0.id);
  }
});

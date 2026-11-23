// Quests: a bot sent to do one job. The runner starts them, keeps several going
// at once, writes every step to a journal on disk, and picks interrupted quests
// back up when the app starts again. Quests on code get their own branch.
import fs from "node:fs";
import path from "node:path";
import type { Bot, Engine, RunEvent } from "../core/index.ts";
import { DATA, WORKSPACE, conversations, getConfig, readJson, writeJson } from "./store.ts";
import { feedback, runChecks } from "./checks.ts";
import { budgetBlock, recordSpend } from "./spend.ts";
import { loadCrew } from "./crew.ts";
import { orgs } from "./orgs.ts";
import { orgMemory } from "./orgmemory.ts";
import type { CheckResult } from "./checks.ts";
import type { QuestCheck, QuestTemplate } from "./templates.ts";
import { fill, resolveInputs } from "./templates.ts";
import { gitLog, githubIssues, githubReport, githubSlug } from "./gather.ts";
import { acceptCopy, changes, prepareCopy, undoCopy } from "./git.ts";
import type { Changes, QuestCopy } from "./git.ts";

export type QuestStatus = "running" | "waiting" | "done" | "stopped" | "failed" | "budget";

export interface Quest {
  /** The same id as the quest's conversation. */
  id: string;
  title: string;
  /** The bot as it was when the quest started, so a later edit to its file cannot change a quest under way. */
  bot: Bot;
  status: QuestStatus;
  /** The repository the quest works on, if any. */
  project?: string;
  copy?: QuestCopy;
  /** What became of the quest's changes. */
  outcome?: "accepted" | "undone" | "no-changes";
  steps: number;
  resumedAt?: string;
  note?: string;
  /** For a core quest: what it is, what it was given, and how its result is checked. */
  template?: { id: string; name: string; check: QuestCheck; inputs: Record<string, string>; mustMention: string[]; tries: number; maxTries: number };
  /** The latest check of the result, and whether one is running now. */
  check?: CheckResult;
  checking?: boolean;
  /** A model chosen for this quest after it started, e.g. when handed to Claude. */
  modelOverride?: string;
  /** How many files a finished code quest changed, so a quest with none is not shown as waiting for review. */
  changedFiles?: number;
  /** For a task handed down the org chart: the conversation (a manager's quest, or a chat) its report goes back to. */
  parent?: { id: string; by: string; delivered: boolean };
  /** A question from a colleague rather than a task: answered briefly, from what the agent knows. */
  kind?: "question" | "decision";
  /** The task the person assigned that this one descends from (its own id for that task itself). A task and everything handed on from it share one budget. */
  root?: string;
  /** How many hand-offs deep this quest is: 0 for one the person sent. */
  depth?: number;
  createdAt: string;
  updatedAt: string;
}

/** How a report from a hand-off starts, so the window can show it as a report rather than something the person typed. */
export const REPORT_MARK = "[Report from ";

/** The budget a task shares with everything handed on from it: the budget per task in Settings. */
export const chainBudget = () => getConfig().budget.spend ?? 1;
/**
 * The task the person assigned that a task descends from. Tasks record it when they start; for one
 * made before that was recorded, it is found by following who handed it on.
 */
export function rootOf(quest: Quest): string {
  if (quest.root) return quest.root;
  let at = quest;
  for (let steps = 0; steps < 12 && at.parent; steps++) {
    const from = questStore.get(at.parent.id);
    if (!from) break;
    at = from;
  }
  return at.root ?? at.id;
}
/** A task and everything handed on from it. */
export const chainOf = (rootId: string) => questStore.list().filter((q) => rootOf(q) === rootId);
/** What a task and everything handed on from it have cost so far. */
export function chainCost(rootId: string): number {
  return chainOf(rootId).reduce((sum, q) => sum + (conversations.get(q.id)?.usage.cost ?? 0), 0);
}
export const chainOver = (rootId: string) => chainCost(rootId) >= chainBudget();
/** How many tasks came from one task, itself included. */
export const chainSize = (rootId: string) => chainOf(rootId).length;
/** Hand-offs may go this many levels down the chart, and a conversation may have this many open at once. */
export const MAX_DEPTH = 5;
export const MAX_OPEN_HANDOFFS = 8;

/** Quests that may run at the same time. */
export const MAX_RUNNING = 6;

const QUEST_DIR = () => path.join(DATA, "quests");
const JOURNAL_DIR = () => path.join(DATA, "journals");
export const WORKTREE_DIR = () => path.join(DATA, "worktrees");
const questFile = (id: string) => {
  if (!/^[a-f0-9]{16}$/.test(id)) throw new Error("Bad quest id");
  return path.join(QUEST_DIR(), `${id}.json`);
};
const journalFile = (id: string) => path.join(JOURNAL_DIR(), `${id}.jsonl`);

export class QuestStore {
  get(id: string): Quest | null {
    try {
      return readJson<Quest | null>(questFile(id), null);
    } catch {
      return null;
    }
  }

  save(quest: Quest) {
    fs.mkdirSync(QUEST_DIR(), { recursive: true });
    quest.updatedAt = new Date().toISOString();
    writeJson(questFile(quest.id), quest);
  }

  list(): Quest[] {
    let names: string[] = [];
    try {
      names = fs.readdirSync(QUEST_DIR()).filter((name) => name.endsWith(".json"));
    } catch {}
    return names
      .map((name) => this.get(name.replace(/\.json$/, "")))
      .filter((q): q is Quest => Boolean(q))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  remove(id: string) {
    fs.rmSync(questFile(id), { force: true });
    fs.rmSync(journalFile(id), { force: true });
  }
}

/** Every step of a quest, one JSON line each, written as it happens. */
export const journal = {
  append(id: string, event: RunEvent | { type: string; [key: string]: unknown }) {
    fs.mkdirSync(JOURNAL_DIR(), { recursive: true });
    fs.appendFileSync(journalFile(id), `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, { mode: 0o600 });
  },
  read(id: string): ({ at: string; type: string } & Record<string, any>)[] {
    let text = "";
    try {
      text = fs.readFileSync(journalFile(id), "utf8");
    } catch {
      return [];
    }
    // A line cut off by a crash is skipped; everything before it is kept.
    return text.split("\n").flatMap((line) => {
      try {
        return line ? [JSON.parse(line)] : [];
      } catch {
        return [];
      }
    });
  },
  /** Tool calls that had started, so a resumed quest does not repeat them blindly. */
  started(id: string): Set<string> {
    return new Set(this.read(id).filter((e) => e.type === "tool_start").map((e) => String(e.id)));
  },
};

export const questStore = new QuestStore();

/** The bot as its file says today (a quest keeps the bot as it was at the start), so a raised budget counts at once. */
const asItIsNow = (bot: Bot): Bot => loadCrew().bots.find((b) => b.id === bot.id) ?? bot;

export class QuestRunner {
  #engine!: Engine;
  /** Why each running quest will end, learned from its events. */
  #ending = new Map<string, QuestStatus>();
  #stopping = new Set<string>();

  attach(engine: Engine) {
    this.#engine = engine;
  }

  running(): Quest[] {
    return questStore.list().filter((q) => q.status === "running" || q.status === "waiting");
  }

  async start({ bot, text, project, title, template, parent, kind }: { bot: Bot; text: string; project?: string; title?: string; template?: Quest["template"]; parent?: { id: string; by: string }; kind?: "question" | "decision" }): Promise<Quest> {
    if (this.running().length >= MAX_RUNNING) throw new Error(`${MAX_RUNNING} quests are already under way. Wait for one to finish, or stop one.`);
    // A bot that has used its month's budget starts nothing new.
    const blocked = budgetBlock(bot);
    if (blocked) throw new Error(blocked);
    const conversation = await conversations.create({ title: (title ?? text).replace(/\s+/g, " ").slice(0, 80), source: "quest" });
    const now = new Date().toISOString();
    const quest: Quest = { id: conversation.id, title: conversation.title, bot, status: "running", steps: 0, createdAt: now, updatedAt: now, ...(template ? { template } : {}), ...(kind ? { kind } : {}) };
    quest.root = quest.id;
    if (parent) {
      quest.parent = { ...parent, delivered: false };
      const from = questStore.get(parent.id);
      quest.depth = (from?.depth ?? 0) + 1;
      // Handed on from a task: it belongs to that task's chain. Handed on from a chat: it starts a chain of its own.
      if (from) quest.root = from.root ?? from.id;
    }
    if (project) {
      quest.project = project;
      // Only bots that can change files get a branch and working copy of their own.
      if (!kind && bot.powers.some((p) => p === "files" || p === "shell")) quest.copy = await prepareCopy(project, quest.id, WORKTREE_DIR());
    }
    questStore.save(quest);
    journal.append(quest.id, { type: "quest_start", bot: bot.id, title: quest.title, project: project ?? null, branch: quest.copy?.branch ?? null });
    try {
      await this.#engine.startRun(quest.id, text, { keepTitle: true });
    } catch (err) {
      this.#set(quest.id, { status: "failed", note: (err as Error).message });
      throw err;
    }
    return questStore.get(quest.id)!;
  }

  /**
   * Starts a core quest: fills in its inputs, gathers what it needs (commits,
   * issues, builds), and remembers what its result must cover for the check.
   */
  async startTemplate({ template, bot, given, project }: { template: QuestTemplate; bot: Bot; given: Record<string, unknown>; project?: string }): Promise<Quest> {
    if (template.repository === "required" && !project) throw new Error(`${template.name} works on a repository. Choose one at the top first.`);
    const inputs = resolveInputs(template, given);
    let gathered = { text: "", mustMention: [] as string[] };
    if (template.gather === "git-log") {
      const log = await gitLog(project!, inputs.since);
      inputs.since = log.since;
      gathered = log;
    } else if (template.gather === "github-issues" || template.gather === "github-report") {
      const slug = inputs.repo || (await githubSlug(project)) || "";
      inputs.repo = slug;
      gathered = template.gather === "github-issues" ? await githubIssues(slug) : await githubReport(slug, Math.max(1, Number(inputs.days) || 7));
    }
    const text = fill(template.prompt, { ...inputs, gathered: gathered.text }).trim();
    const first = template.inputs.map((i) => inputs[i.id]).find(Boolean);
    return this.start({
      bot,
      text,
      project,
      title: first ? `${template.name}: ${first}` : template.name,
      template: { id: template.id, name: template.name, check: template.check, inputs, mustMention: gathered.mustMention, tries: 0, maxTries: 2 },
    });
  }

  /** Checks a finished core quest. A failed check goes back to the bot while it has tries left. */
  async #check(id: string) {
    const quest = questStore.get(id);
    const conversation = quest?.template ? await conversations.get(id) : null;
    if (!quest?.template || !conversation) return;
    this.#set(id, { checking: true });
    let result: CheckResult;
    try {
      result = await runChecks({
        check: quest.template.check,
        conversation,
        copy: quest.outcome ? undefined : quest.copy,
        workspace: WORKSPACE,
        inputs: quest.template.inputs,
        mustMention: quest.template.mustMention,
      });
    } catch (err) {
      result = { passed: false, items: [{ label: "Check", passed: false, detail: (err as Error).message }], at: new Date().toISOString() };
    }
    journal.append(id, { type: "check", passed: result.passed, items: result.items });
    const { tries, maxTries } = quest.template;
    if (!result.passed && tries < maxTries) {
      // Not done: tell the bot what failed and let it fix it.
      this.#set(id, { checking: false, check: result, template: { ...quest.template, tries: tries + 1 } });
      await this.#engine.startRun(id, feedback(result, maxTries - tries), { keepTitle: true }).catch((err) => this.#set(id, { note: (err as Error).message }));
      return;
    }
    this.#set(id, { checking: false, check: result });
  }

  /** Hands a quest to another model (usually Claude), continuing where it stopped, with fresh tries. */
  async escalate(id: string, model: string) {
    const quest = questStore.get(id);
    if (!quest) throw new Error("Quest not found.");
    if (quest.status === "running" || quest.status === "waiting" || quest.checking) throw new Error("The quest is still under way.");
    if (quest.outcome) throw new Error("This quest's changes were already dealt with.");
    const failed = quest.check?.items.filter((i) => !i.passed) ?? [];
    this.#set(id, { modelOverride: model, ...(quest.template ? { template: { ...quest.template, tries: 0 } } : {}) });
    journal.append(id, { type: "escalate", model });
    const message = [
      `[This quest is now handed to ${model}, a stronger model, to finish.]`,
      failed.length ? `The last check failed:\n${failed.map((i) => `- ${i.label}${i.detail ? `: ${i.detail}` : ""}`).join("\n")}` : "",
      "Read what has been done so far, then finish the quest properly.",
    ]
      .filter(Boolean)
      .join("\n\n");
    await this.#engine.startRun(id, message, { keepTitle: true });
  }

  stop(id: string) {
    this.#stopping.add(id);
    this.#engine.stop(id);
  }

  /** Called by the engine for every event: keeps the journal and the quest's status. */
  /**
   * Sends the reports of finished hand-offs back to the conversation that
   * assigned them, as one message, once all of its hand-offs have stopped and
   * it is not busy itself. The manager (or the chat's agent) then carries on.
   */
  async deliverReports(parentId: string) {
    if (this.#engine.isRunning(parentId)) return; // it gets them when its own turn ends
    const all = questStore.list();
    const children = all.filter((q) => q.parent?.id === parentId && !q.parent.delivered);
    if (!children.length || children.some((q) => q.status === "running" || q.status === "waiting")) return;
    // A child that is still waiting for its own hand-offs has only said "I have asked, I am waiting": that is not
    // its report. Its report goes up when its own reports have come in and it has finished again.
    if (children.some((child) => all.some((q) => q.parent?.id === child.id && (!q.parent.delivered || q.status === "running" || q.status === "waiting")))) return;
    for (const child of children) this.#set(child.id, { parent: { ...child.parent!, delivered: true } });
    const reports = children.reverse().map((child) => {
      const said = [...(conversations.get(child.id)?.messages ?? [])].reverse().find((m) => m.role === "assistant" && Array.isArray(m.content) && m.content.some((b) => b.type === "text" && b.text.trim()));
      const text = said && Array.isArray(said.content) ? said.content.map((b) => (b.type === "text" ? b.text : "")).join("\n").trim() : "";
      const how = { done: "finished", stopped: "was stopped", failed: `failed${child.note ? `: ${child.note}` : ""}`, budget: "stopped at its budget" }[child.status as string] ?? child.status;
      return `${REPORT_MARK}${child.bot.name} · ${child.title} · ${child.status === "done" && child.kind === "question" ? "answered" : child.status === "done" && child.kind === "decision" ? "decided" : how}]\n${text || "(It left no report.)"}`;
    });
    const parentQuest = questStore.get(parentId);
    const next = parentQuest
      ? "Check these reports against what you asked for. Then assign follow-up work if something is missing, or put them together and give your own report."
      : "Tell the user what came back, in your own words, and say plainly if a report failed or left something out.";
    try {
      await this.#engine.startRun(parentId, `${reports.join("\n\n")}\n\n[${next}]`, { keepTitle: true });
    } catch (err) {
      for (const child of children) this.#set(child.id, { note: `Its report could not be delivered: ${(err as Error).message}` });
    }
  }

  onEvent(id: string, event: RunEvent) {
    // When any conversation stops, reports that were waiting for it can go in.
    if (event.type === "status" && !event.running) setTimeout(() => this.deliverReports(id).catch(() => {}), 50);
    const quest = questStore.get(id);
    if (!quest) return;
    journal.append(id, event);
    // What the quest has cost so far counts towards its bot's month. A bot that
    // reaches its monthly budget part-way is stopped; its work so far is kept.
    if (event.type === "assistant" || event.type === "status") {
      recordSpend(id, quest.bot.id, conversations.get(id)?.usage.cost ?? 0);
      if (event.type === "assistant" && budgetBlock(asItIsNow(quest.bot))) {
        this.#ending.set(id, "budget");
        this.#engine.stop(id);
      }
      // A task and everything handed on from it share one budget. When it is used up, the hand-offs stop;
      // the task itself carries on within its own limit, so it can still report what was found.
      if (event.type === "assistant" && quest.parent && rootOf(quest) !== id && chainOver(rootOf(quest))) {
        this.#ending.set(id, "budget");
        this.#set(id, { note: "The task it belongs to used its whole budget of $" + chainBudget().toFixed(2) + ", counting everything handed on." });
        this.#engine.stop(id);
      }
    }
    switch (event.type) {
      case "status":
        if (event.running) {
          this.#ending.delete(id);
          this.#stopping.delete(id);
          this.#set(id, { status: "running" });
        } else {
          const status = this.#stopping.has(id) ? "stopped" : (this.#ending.get(id) ?? "done");
          this.#ending.delete(id);
          this.#stopping.delete(id);
          this.#set(id, { status });
          // The organization keeps a line about each task an agent finishes, so later work can build on it.
          if (status === "done" && !quest.kind) {
            const said = [...(conversations.get(id)?.messages ?? [])].reverse().find((m) => m.role === "assistant" && Array.isArray(m.content) && m.content.some((b) => b.type === "text" && b.text.trim()));
            const report = said && Array.isArray(said.content) ? said.content.map((b) => (b.type === "text" ? b.text : "")).join(" ").trim() : "";
            try {
              orgMemory.logTask(orgs.active(), quest.bot.id, quest.title, report);
            } catch {}
          }
          // A task handed down the chart reports back to whoever assigned it.
          if (quest.parent && !quest.parent.delivered) setTimeout(() => this.deliverReports(quest.parent!.id).catch(() => {}), 80);
          if (quest.copy && !quest.outcome) {
            changes(quest.copy)
              .then((c) => this.#set(id, { changedFiles: c.files.length }))
              .catch(() => {});
          }
          // A core quest that finished is checked before it counts as done.
          if (status === "done" && quest.template) {
            this.#check(id).catch((err) => this.#set(id, { checking: false, note: `Could not check the result: ${(err as Error).message}` }));
          }
        }
        break;
      case "approval":
        this.#set(id, { status: "waiting" });
        break;
      case "approval_done":
        if (quest.status === "waiting") this.#set(id, { status: "running" });
        break;
      case "assistant":
        this.#set(id, { steps: quest.steps + 1 });
        break;
      case "notice":
        if (event.text.startsWith("Stopped at its budget")) this.#ending.set(id, "budget");
        break;
      case "error":
        this.#ending.set(id, "failed");
        this.#set(id, { note: event.text });
        break;
      case "resumed":
        this.#set(id, { resumedAt: new Date().toISOString() });
        break;
    }
  }

  #set(id: string, patch: Partial<Quest>) {
    const quest = questStore.get(id);
    if (quest) questStore.save({ ...quest, ...patch });
  }

  /** At start-up: picks up every quest that was under way when the app last closed. */
  async resumeAll(): Promise<string[]> {
    const resumed: string[] = [];
    for (const quest of this.running()) {
      try {
        const run = await this.#engine.resumeRun(quest.id, journal.started(quest.id));
        if (run) resumed.push(quest.id);
        else this.#set(quest.id, { status: "done" });
      } catch (err) {
        this.#set(quest.id, { status: "failed", note: `Could not resume: ${(err as Error).message}` });
      }
    }
    return resumed;
  }

  #closable(id: string): Quest & { copy: QuestCopy } {
    const quest = questStore.get(id);
    if (!quest) throw new Error("Quest not found.");
    if (!quest.copy) throw new Error("This quest did not work on a repository, so there are no changes to review.");
    if (quest.outcome) throw new Error("This quest's changes were already dealt with.");
    if (quest.status === "running" || quest.status === "waiting") throw new Error("The quest is still under way. Stop it or wait for it to finish first.");
    return quest as Quest & { copy: QuestCopy };
  }

  async changes(id: string): Promise<Changes> {
    const quest = questStore.get(id);
    if (!quest?.copy || quest.outcome) return { files: [], diff: "", truncated: false };
    return changes(quest.copy);
  }

  /** Keeps the quest's changes as a commit on its own branch. */
  async accept(id: string): Promise<{ branch: string | null }> {
    const quest = this.#closable(id);
    const branch = await acceptCopy(quest.copy, `${quest.title}\n\nTask by ${quest.bot.name === quest.bot.title ? quest.bot.name : `${quest.bot.name} (${quest.bot.title})`} in Talqava Agents.`);
    this.#set(id, { outcome: branch ? "accepted" : "no-changes" });
    journal.append(id, { type: "quest_accept", branch });
    return { branch };
  }

  /** Throws away everything the quest changed. */
  async undo(id: string) {
    const quest = this.#closable(id);
    await undoCopy(quest.copy);
    this.#set(id, { outcome: "undone" });
    journal.append(id, { type: "quest_undo" });
  }
}

export const quests = new QuestRunner();

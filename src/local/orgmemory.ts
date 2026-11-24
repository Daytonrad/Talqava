// What an organization remembers. Three shelves: the whole organization's
// (policies, decisions, facts about the business), each department's (how
// that department does its work), and each agent's own (what it has learned
// and a short record of the work it finished). An agent sees its own shelf,
// its department's and the organization's. Only what bears on the task in
// hand is put in its prompt; the rest is one search away, so memory can grow
// large without every task paying for all of it.
import path from "node:path";
import { defineTool, rank } from "../core/index.ts";
import type { Tool } from "../core/index.ts";
import { DATA, newId, readJson, writeJson } from "./store.ts";
import { memberOf, orgs } from "./orgs.ts";
import type { Org } from "./orgs.ts";

export type Shelf = "org" | "dept" | "agent";

export interface OrgMemoryEntry {
  id: string;
  org: string;
  shelf: Shelf;
  /** The department's name, or the agent's id. Empty for the organization's shelf. */
  key: string;
  text: string;
  /** Who saved it: an agent's name, or "You". */
  by: string;
  /** A note someone chose to save, or a line the app keeps about a finished task. */
  kind: "note" | "log";
  createdAt: string;
  updatedAt?: string;
}

/** How much organization memory goes in a prompt, in characters. */
export const ORG_MEMORY_BUDGET = 3200;
const ENTRY_LIMIT = 800;
/** Finished-task lines kept per agent; older ones are dropped. */
const LOG_LIMIT = 60;

const file = () => path.join(DATA, "org-memory.json");
const read = () => readJson<OrgMemoryEntry[]>(file(), []);
const save = (entries: OrgMemoryEntry[]) => writeJson(file(), entries);
const tidyText = (text: unknown) => String(text ?? "").replace(/\s+\n/g, "\n").trim().slice(0, ENTRY_LIMIT);

export const orgMemory = {
  list(orgId: string): OrgMemoryEntry[] {
    return read().filter((e) => e.org === orgId);
  },

  /** What an agent may see: the organization's shelf, its department's and its own. */
  visibleTo(org: Org, botId: string | null): OrgMemoryEntry[] {
    const me = botId ? memberOf(org, botId) : null;
    return this.list(org.id).filter((e) => e.shelf === "org" || (!botId ? true : (e.shelf === "dept" && e.key === me?.department) || (e.shelf === "agent" && e.key === botId)));
  },

  add(entry: { org: string; shelf: Shelf; key?: string; text: unknown; by: string; kind?: "note" | "log" }): OrgMemoryEntry {
    const text = tidyText(entry.text);
    if (!text) throw new Error("Say what to remember.");
    const all = read();
    const made: OrgMemoryEntry = { id: newId().slice(0, 8), org: entry.org, shelf: entry.shelf, key: entry.shelf === "org" ? "" : String(entry.key ?? ""), text, by: entry.by, kind: entry.kind ?? "note", createdAt: new Date().toISOString() };
    all.push(made);
    // An agent's record of finished work is kept to its latest lines.
    const logs = all.filter((e) => e.kind === "log" && e.org === made.org && e.key === made.key);
    const drop = new Set(logs.slice(0, Math.max(0, logs.length - LOG_LIMIT)).map((e) => e.id));
    save(all.filter((e) => !drop.has(e.id)));
    return made;
  },

  update(orgId: string, id: string, text: unknown): OrgMemoryEntry {
    const all = read();
    const entry = all.find((e) => e.id === id && e.org === orgId);
    if (!entry) throw new Error("There is no such entry.");
    const next = tidyText(text);
    if (!next) throw new Error("Say what to remember.");
    entry.text = next;
    entry.updatedAt = new Date().toISOString();
    save(all);
    return entry;
  },

  remove(orgId: string, id: string) {
    const all = read();
    if (!all.some((e) => e.id === id && e.org === orgId)) throw new Error("There is no such entry.");
    save(all.filter((e) => !(e.id === id && e.org === orgId)));
  },

  /** Forgets everything an organization remembered, when the organization is deleted. */
  purge(orgId: string) {
    save(read().filter((e) => e.org !== orgId));
  },

  /** Keeps a line about a task an agent finished: what it was, and how its report began. */
  logTask(org: Org, botId: string, title: string, report: string) {
    if (!memberOf(org, botId)) return;
    const line = `${new Date().toISOString().slice(0, 10)} · ${title.replace(/\s+/g, " ").slice(0, 120)}${report ? ` → ${report.replace(/\s+/g, " ").slice(0, 260)}` : ""}`;
    this.add({ org: org.id, shelf: "agent", key: botId, text: line, by: "Talqava", kind: "log" });
  },
};

const shelfName = (e: OrgMemoryEntry) => (e.shelf === "org" ? "organization" : e.shelf === "dept" ? `${e.key} department` : e.kind === "log" ? "your past work" : "your notes");

/**
 * The part of the prompt that carries organization memory. Everything, when it
 * fits the budget. Otherwise notes that match the task come first, then the
 * newest, and the rest are counted so the agent knows to search.
 */
export function orgMemoryPrompt(org: Org, botId: string | null, about: string, budget = ORG_MEMORY_BUDGET): string {
  const visible = orgMemory.visibleTo(org, botId);
  if (!visible.length) return "";
  const size = (e: OrgMemoryEntry) => e.text.length + 30;
  let shown = visible;
  if (visible.reduce((n, e) => n + size(e), 0) > budget) {
    const picked = new Set<OrgMemoryEntry>();
    let used = 0;
    const take = (e: OrgMemoryEntry, limit: number) => {
      if (picked.has(e) || used + size(e) > limit) return;
      picked.add(e);
      used += size(e);
    };
    const notes = visible.filter((e) => e.kind === "note");
    for (const { item } of rank(about, visible, (e) => e.text)) take(item, budget * 0.65);
    for (const e of [...notes].reverse()) take(e, budget * 0.9);
    for (const e of [...visible].reverse()) take(e, budget);
    shown = visible.filter((e) => picked.has(e));
  }
  const hidden = visible.length - shown.length;
  return [
    "# What the organization remembers",
    "Shared memory, kept across every task and seen by your colleagues: the organization's, your department's, and your own notes and past work. Read it before you start. Save what a colleague would need later with team_memory (a decision and its reason, a fact about the business, how a job is done here), one fact per entry, and correct an entry that has gone out of date.",
    shown.map((e) => `- [${e.id}] (${shelfName(e)}) ${e.text}`).join("\n"),
    ...(hidden ? [`${hidden} more ${hidden === 1 ? "entry is" : "entries are"} saved but not listed. Search with team_memory before asking a colleague or the user for something the organization may already know.`] : []),
  ].join("\n\n");
}

/** The tool agents use to read and write organization memory. `who` says which agent is calling (null for the general chat agent). */
export function teamMemoryTool(who: (conversationId: string) => { id: string; name: string } | null): Tool {
  return defineTool<{ action: "add" | "update" | "remove" | "search"; text?: string; id?: string; shelf?: "mine" | "department" | "organization"; query?: string }>({
    name: "team_memory",
    description:
      "The organization's shared memory, kept across tasks and agents. Shelves: \"organization\" (seen by every agent: policies, decisions, facts about the business), \"department\" (seen by your department: how work is done here), \"mine\" (your own notes). Save durable facts, one per entry, in a sentence or two; update an entry when the fact changes; remove one that is wrong. Search looks through everything you may see, including entries not listed at the start.",
    properties: {
      action: { type: "string", enum: ["add", "update", "remove", "search"] },
      text: { type: "string", description: "For add and update: the fact to remember." },
      id: { type: "string", description: "For update and remove: the id of the entry." },
      shelf: { type: "string", enum: ["mine", "department", "organization"], description: "For add: where to keep it. Defaults to your department." },
      query: { type: "string", description: "For search: a few words about what you are looking for." },
    },
    required: ["action"],
    async run(input, { conversation }) {
      const org = orgs.active();
      const me = who(conversation.id);
      const member = me ? memberOf(org, me.id) : null;
      const mine = orgMemory.visibleTo(org, me?.id ?? null);
      if (input.action === "search") {
        const found = rank(input.query ?? "", mine, (e) => e.text).slice(0, 12);
        return found.length ? found.map(({ item }) => `- [${item.id}] (${shelfName(item)}) ${item.text}`).join("\n") : "Nothing saved matches that.";
      }
      if (input.action === "add") {
        const shelf: Shelf = !member || input.shelf === "organization" ? "org" : input.shelf === "mine" ? "agent" : "dept";
        const entry = orgMemory.add({ org: org.id, shelf, key: shelf === "dept" ? member!.department : shelf === "agent" ? me!.id : "", text: input.text, by: me?.name ?? "Talqava" });
        return `Remembered (id ${entry.id}) for ${shelf === "org" ? "the whole organization" : shelf === "dept" ? `the ${entry.key} department` : "yourself"}.`;
      }
      if (!mine.some((e) => e.id === input.id)) throw new Error("There is no such entry among those you can see.");
      if (input.action === "update") return `Updated (id ${orgMemory.update(org.id, input.id!, input.text).id}).`;
      orgMemory.remove(org.id, input.id!);
      return "Removed.";
    },
  });
}

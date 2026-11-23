// Organizations. An organization puts bots into roles: each member has a title,
// a department and a manager, which makes an org chart with the person at the
// top. Work follows the chart: a manager may hand tasks to its direct reports,
// and their reports come back up to it (see assign_task in tools.ts).
// A bot's own file says what it can do; the organization says where it sits.
import path from "node:path";
import type { Bot } from "../core/index.ts";
import { DATA, newId, readJson, writeJson } from "./store.ts";
import { loadCrew } from "./crew.ts";

export interface Member {
  /** The bot's id (its file name). */
  bot: string;
  /** Its job title here, e.g. "Head of Research". */
  title: string;
  department: string;
  /** The bot it reports to, or null when it reports straight to the person. */
  manager: string | null;
}

export interface Org {
  id: string;
  name: string;
  /** What the organization is for, in a sentence. Every member is told it. */
  mission: string;
  members: Member[];
  createdAt: string;
}

interface OrgFile {
  active: string;
  orgs: Org[];
}

const file = () => path.join(DATA, "orgs.json");
const clean = (text: unknown, max: number) => String(text ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const titleFor = (bot: Bot) => `${bot.type.charAt(0).toUpperCase()}${bot.type.slice(1)}`;

function read(): OrgFile {
  const data = readJson<OrgFile | null>(file(), null);
  if (data?.orgs?.length) return data;
  // The first organization holds every bot there is, each reporting to the person.
  const first: Org = {
    id: newId(),
    name: "My organization",
    mission: "",
    members: loadCrew().bots.map((bot) => ({ bot: bot.id, title: titleFor(bot), department: bot.group, manager: null })),
    createdAt: new Date().toISOString(),
  };
  const made = { active: first.id, orgs: [first] };
  writeJson(file(), made);
  return made;
}

const save = (data: OrgFile) => writeJson(file(), data);

function find(data: OrgFile, id: string): Org {
  const org = data.orgs.find((o) => o.id === id);
  if (!org) throw new Error("No such organization.");
  return org;
}

/** Members whose bot still exists; a manager that is gone is replaced by the person. */
function tidy(org: Org): Org {
  const bots = new Set(loadCrew().bots.map((b) => b.id));
  const members = org.members.filter((m) => bots.has(m.bot));
  const here = new Set(members.map((m) => m.bot));
  return { ...org, members: members.map((m) => (m.manager && !here.has(m.manager) ? { ...m, manager: null } : m)) };
}

export const orgs = {
  list(): { active: string; orgs: Org[] } {
    const data = read();
    return { active: data.active, orgs: data.orgs.map(tidy) };
  },

  active(): Org {
    const data = read();
    return tidy(data.orgs.find((o) => o.id === data.active) ?? data.orgs[0]);
  },

  setActive(id: string) {
    const data = read();
    find(data, id);
    data.active = id;
    save(data);
  },

  create(name: unknown, mission: unknown = ""): Org {
    const data = read();
    const named = clean(name, 50);
    if (!named) throw new Error("An organization needs a name.");
    if (data.orgs.some((o) => o.name.toLowerCase() === named.toLowerCase())) throw new Error(`There is already an organization called "${named}".`);
    const org: Org = { id: newId(), name: named, mission: clean(mission, 300), members: [], createdAt: new Date().toISOString() };
    data.orgs.push(org);
    data.active = org.id;
    save(data);
    return org;
  },

  update(id: string, patch: { name?: unknown; mission?: unknown }): Org {
    const data = read();
    const org = find(data, id);
    if (patch.name !== undefined) {
      const named = clean(patch.name, 50);
      if (!named) throw new Error("An organization needs a name.");
      if (data.orgs.some((o) => o.id !== id && o.name.toLowerCase() === named.toLowerCase())) throw new Error(`There is already an organization called "${named}".`);
      org.name = named;
    }
    if (patch.mission !== undefined) org.mission = clean(patch.mission, 300);
    save(data);
    return tidy(org);
  },

  remove(id: string) {
    const data = read();
    find(data, id);
    if (data.orgs.length === 1) throw new Error("This is your only organization. Create another before removing it.");
    data.orgs = data.orgs.filter((o) => o.id !== id);
    if (data.active === id) data.active = data.orgs[0].id;
    save(data);
  },

  /**
   * Puts a bot in a role, or changes its role. The manager must be a member,
   * and the chart must stay a tree: nobody may end up above its own manager.
   */
  setMember(id: string, input: { bot: unknown; title?: unknown; department?: unknown; manager?: unknown }): Org {
    const data = read();
    const org = find(data, id);
    const bot = loadCrew().bots.find((b) => b.id === input.bot);
    if (!bot) throw new Error("There is no such bot.");
    const existing = org.members.find((m) => m.bot === bot.id);
    const manager = input.manager === undefined ? (existing?.manager ?? null) : input.manager ? String(input.manager) : null;
    if (manager) {
      if (manager === bot.id) throw new Error("A bot cannot report to itself.");
      if (!org.members.some((m) => m.bot === manager)) throw new Error("Its manager must be a member of this organization.");
      // Walking up from the new manager must not come back to this bot.
      for (let at: string | null = manager, steps = 0; at; steps++) {
        if (at === bot.id || steps > org.members.length) throw new Error(`${bot.name} is above that bot in the chart, so it cannot report to it.`);
        at = org.members.find((m) => m.bot === at)?.manager ?? null;
      }
    }
    const member: Member = {
      bot: bot.id,
      title: clean(input.title ?? existing?.title, 50) || titleFor(bot),
      department: clean(input.department ?? existing?.department, 30) || bot.group,
      manager,
    };
    org.members = existing ? org.members.map((m) => (m.bot === bot.id ? member : m)) : [...org.members, member];
    save(data);
    return tidy(org);
  },

  /** Takes a bot off the chart. Its reports move up to its own manager. */
  removeMember(id: string, botId: string): Org {
    const data = read();
    const org = find(data, id);
    const leaving = org.members.find((m) => m.bot === botId);
    if (!leaving) throw new Error("That bot is not a member.");
    org.members = org.members.filter((m) => m.bot !== botId).map((m) => (m.manager === botId ? { ...m, manager: leaving.manager } : m));
    save(data);
    return tidy(org);
  },

  /** A new bot joins the active organization, reporting to the person, unless told where it goes. */
  welcome(bot: Bot, role: { title?: string; department?: string; manager?: string | null } = {}) {
    const org = this.active();
    if (org.members.some((m) => m.bot === bot.id)) return;
    const manager = role.manager && org.members.some((m) => m.bot === role.manager) ? role.manager : null;
    this.setMember(org.id, { bot: bot.id, title: role.title, department: role.department, manager });
  },
};

export const memberOf = (org: Org, botId: string) => org.members.find((m) => m.bot === botId);
export const reportsOf = (org: Org, botId: string | null) => org.members.filter((m) => m.manager === botId);

/** One line on what a bot does, for telling others who can help with what. */
export const oneLine = (bot: Bot) => (bot.instructions.split(/(?<=[.!?])\s/)[0] ?? "").slice(0, 160);

/**
 * What a member is told about its place: its title, who it answers to, and
 * who it may hand work to. Empty when the bot is not on the chart.
 */
export function rolePrompt(bot: Bot, org = orgs.active()): string {
  const me = memberOf(org, bot.id);
  if (!me) return "";
  const crew = new Map(loadCrew().bots.map((b) => [b.id, b]));
  const boss = me.manager ? memberOf(org, me.manager) : null;
  const reports = reportsOf(org, bot.id);
  const lines = [
    "# Your place in the organization",
    `You are the ${me.title} in the ${me.department} department of ${org.name}.${org.mission ? ` Its mission: ${org.mission}` : ""}`,
    boss ? `You report to ${crew.get(boss.bot)?.name ?? boss.bot}, the ${boss.title}. Your reports go to them.` : "You report directly to the user, who owns the organization.",
  ];
  if (reports.length) {
    lines.push(
      `These bots report to you. Hand a task to the one it fits with the assign_task tool, instead of doing their kind of work yourself:\n${reports
        .map((r) => `- ${crew.get(r.bot)?.name ?? r.bot} (${r.title}): ${crew.get(r.bot) ? oneLine(crew.get(r.bot)!) : ""}`)
        .join("\n")}`,
      "Give each task everything the bot needs to know: it does not see this conversation. After assigning, finish any work that does not depend on the result, then end your turn; each report arrives as a message. When all the reports are in, check them, put them together and report upward. You can only assign to your direct reports.",
    );
  } else {
    lines.push("Nobody reports to you, so you do the work yourself. If a task belongs to another department, say so in your report rather than doing it badly.");
  }
  return lines.join("\n\n");
}

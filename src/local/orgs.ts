// Organizations. An organization puts bots into roles: each member has a title,
// a department and a manager, which makes an org chart with the person at the
// top. Work follows the chart: a manager may hand tasks to its direct reports,
// and their reports come back up to it (see assign_task in tools.ts).
// A bot's own file says what it can do; the organization says where it sits.
import path from "node:path";
import type { Bot } from "../core/index.ts";
import { DATA, newId, readJson, writeJson } from "./store.ts";
import { loadCrew } from "./crew.ts";
import { ASSIGN_RULES, DEFAULT_INDUSTRY, DEFAULT_STRUCTURE, INDUSTRIES, REQUEST_RULES, STRUCTURES, industryOf, isAssignRule, structureOf } from "./structures.ts";
import type { AssignRule, RequestRule } from "./structures.ts";

export interface Member {
  /** The bot's id (its file name). */
  bot: string;
  /** Its job title here, e.g. "Head of Research". */
  title: string;
  department: string;
  /** The bot it reports to, or null when it reports straight to the person. */
  manager: string | null;
  /** A second lead (a project lead, the dotted line of a matrix) who may also hand it tasks. */
  also?: string | null;
  /** Seated by setting a structure up, rather than added by the person. Such a member leaves the chart when a later structure has no seat for it. */
  placed?: boolean;
}

export interface Org {
  id: string;
  name: string;
  /** What the organization is for, in a sentence. Every member is told it. */
  mission: string;
  /** How the organization is run (see structures.ts). */
  structure: string;
  /** For "Your own structure": the philosophy the person wrote, and who may hand work to whom. */
  philosophy?: string;
  assign?: AssignRule;
  /** The kind of business, which decides what a chart is staffed with (see INDUSTRIES). */
  industry: string;
  /** Spending or commitments above this many dollars need the person's approval. None means every one does. */
  approvalLimit?: number | null;
  members: Member[];
  createdAt: string;
}

interface OrgFile {
  active: string;
  orgs: Org[];
}

const file = () => path.join(DATA, "orgs.json");
const clean = (text: unknown, max: number) => String(text ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const titleFor = (bot: Bot) => bot.title;

function read(): OrgFile {
  const data = readJson<OrgFile | null>(file(), null);
  if (data?.orgs?.length) return data;
  // The first organization holds every bot there is, each reporting to the person.
  const first: Org = {
    id: newId(),
    name: "My organization",
    mission: "",
    structure: "flat",
    industry: DEFAULT_INDUSTRY,
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

/** Titles and departments the standard agents had in earlier versions. A member still carrying one is shown with the agent's current role. */
const RETIRED_TITLES = new Set(["scout", "scribe", "maker", "keeper", "counter", "spark", "research analyst", "communications manager", "software engineer", "operations manager", "knowledge manager", "business analyst", "data analyst", "strategy advisor"]);
const RETIRED_DEPARTMENTS = new Set(["writing", "money", "ideas", "communications", "strategy", "engineering", "finance", "operations", "research"]);

/** Members whose bot still exists; a manager that is gone is replaced by the person. */
function tidy(org: Org): Org {
  const crew = new Map(loadCrew().bots.map((b) => [b.id, b]));
  const bots = new Set(crew.keys());
  const members = org.members
    .filter((m) => bots.has(m.bot))
    .map((m) => {
      const bot = crew.get(m.bot)!;
      // Only a standard agent's old default is replaced; a title the person wrote is theirs.
      if (bot.source !== "starter" || !RETIRED_TITLES.has(m.title.toLowerCase()) || m.title === bot.title) return m;
      return { ...m, title: bot.title, department: RETIRED_DEPARTMENTS.has(m.department.toLowerCase()) ? bot.group : m.department };
    });
  const here = new Set(members.map((m) => m.bot));
  return {
    ...org,
    structure: structureOf(org.structure ?? "flat").id,
    industry: industryOf(org.industry).id,
    members: members.map((m) => ({ ...m, manager: m.manager && here.has(m.manager) ? m.manager : null, also: m.also && here.has(m.also) && m.also !== m.manager ? m.also : null })),
  };
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

  create(name: unknown, mission: unknown = "", structure: unknown = DEFAULT_STRUCTURE): Org {
    const data = read();
    const named = clean(name, 50);
    if (!named) throw new Error("An organization needs a name.");
    if (data.orgs.some((o) => o.name.toLowerCase() === named.toLowerCase())) throw new Error(`There is already an organization called "${named}".`);
    const org: Org = { id: newId(), name: named, mission: clean(mission, 300), structure: structureOf(String(structure ?? "")).id, industry: DEFAULT_INDUSTRY, members: [], createdAt: new Date().toISOString() };
    data.orgs.push(org);
    data.active = org.id;
    save(data);
    return org;
  },

  update(id: string, patch: { name?: unknown; mission?: unknown; structure?: unknown; philosophy?: unknown; assign?: unknown; industry?: unknown; approvalLimit?: unknown }): Org {
    const data = read();
    const org = find(data, id);
    if (patch.name !== undefined) {
      const named = clean(patch.name, 50);
      if (!named) throw new Error("An organization needs a name.");
      if (data.orgs.some((o) => o.id !== id && o.name.toLowerCase() === named.toLowerCase())) throw new Error(`There is already an organization called "${named}".`);
      org.name = named;
    }
    if (patch.mission !== undefined) org.mission = clean(patch.mission, 300);
    if (patch.structure !== undefined) {
      if (!STRUCTURES.some((s) => s.id === patch.structure)) throw new Error("There is no such structure.");
      org.structure = String(patch.structure);
    }
    if (patch.industry !== undefined) {
      if (!INDUSTRIES.some((i) => i.id === patch.industry)) throw new Error("There is no such kind of business.");
      org.industry = String(patch.industry);
    }
    if (patch.approvalLimit !== undefined) {
      const limit = patch.approvalLimit === null || patch.approvalLimit === "" ? null : Number(patch.approvalLimit);
      if (limit !== null && !(Number.isFinite(limit) && limit >= 0 && limit <= 1_000_000)) throw new Error("The approval limit is an amount in dollars.");
      org.approvalLimit = limit;
    }
    if (patch.philosophy !== undefined) org.philosophy = String(patch.philosophy ?? "").trim().slice(0, 1200);
    if (patch.assign !== undefined) {
      if (!isAssignRule(patch.assign)) throw new Error("Choose who may hand work to whom.");
      org.assign = patch.assign;
    }
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
  setMember(id: string, input: { bot: unknown; title?: unknown; department?: unknown; manager?: unknown; also?: unknown; placed?: boolean }): Org {
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
    const also = input.also === undefined ? (existing?.also ?? null) : input.also ? String(input.also) : null;
    if (also) {
      if (also === bot.id) throw new Error("An agent cannot be its own project lead.");
      if (!org.members.some((m) => m.bot === also)) throw new Error("Its project lead must be a member of this organization.");
    }
    const member: Member = {
      bot: bot.id,
      title: clean(input.title ?? existing?.title, 50) || titleFor(bot),
      department: clean(input.department ?? existing?.department, 30) || bot.group,
      manager,
      also: also && also !== manager ? also : null,
      ...((input.placed ?? existing?.placed) ? { placed: true } : {}),
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
    org.members = org.members.filter((m) => m.bot !== botId).map((m) => ({ ...m, manager: m.manager === botId ? leaving.manager : m.manager, also: m.also === botId ? null : m.also }));
    save(data);
    return tidy(org);
  },

  /** Takes everyone off the chart, to start over. The agents stay on the person's team. */
  clear(id: string): Org {
    const data = read();
    const org = find(data, id);
    org.members = [];
    save(data);
    return tidy(org);
  },

  /** Takes a lead and everyone beneath it off the chart: a whole team at once. */
  removeTeam(id: string, botId: string): Org {
    const data = read();
    const org = find(data, id);
    if (!org.members.some((m) => m.bot === botId)) throw new Error("That bot is not a member.");
    const going = new Set([botId]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const m of org.members) if (m.manager && going.has(m.manager) && !going.has(m.bot)) (going.add(m.bot), (grew = true));
    }
    org.members = org.members.filter((m) => !going.has(m.bot)).map((m) => ({ ...m, also: m.also && going.has(m.also) ? null : m.also }));
    save(data);
    return tidy(org);
  },

  /**
   * Redraws the chart the way a structure is usually drawn. Flat: everyone
   * reports to the person. Otherwise each department gets one lead (a member
   * whose title says so, else the one who already leads the most), the rest of
   * the department reports to it, and the leads report to the top: a chief of
   * staff or chief executive if there is one, else the person.
   */
  arrange(id: string, structure: string): Org {
    const data = read();
    const org = find(data, id);
    if (!STRUCTURES.some((s) => s.id === structure)) throw new Error("There is no such structure.");
    org.structure = structure;
    if (structure === "flat") {
      org.members = org.members.map((m) => ({ ...m, manager: null, also: null }));
    } else if (structure !== "custom") {
      // A role that is marked as a lead in its file leads its department; failing that, whoever already leads the most.
      const crew = new Map(loadCrew().bots.map((b) => [b.id, b]));
      const isLead = (m: Member) => crew.get(m.bot)?.lead === true;
      const leadsNow = (bot: string) => org.members.filter((m) => m.manager === bot).length;
      const top = org.members.find((m) => /^(general manager|chief executive|ceo|president|chief operating officer)\b/i.test(m.title)) ?? null;
      const departments = new Map<string, Member[]>();
      for (const m of org.members) if (m !== top) departments.set(m.department, [...(departments.get(m.department) ?? []), m]);
      for (const members of departments.values()) {
        const lead = [...members].sort((a, b) => Number(isLead(b)) - Number(isLead(a)) || leadsNow(b.bot) - leadsNow(a.bot))[0];
        const hasLead = members.length > 1 && (isLead(lead) || leadsNow(lead.bot) > 0);
        // A second lead in the same department (a lead developer under a head of engineering) keeps its own reports.
        const subLeads = new Set(members.filter((m) => m !== lead && isLead(m) && leadsNow(m.bot) > 0).map((m) => m.bot));
        for (const m of members) {
          if (m.manager && subLeads.has(m.manager) && m.bot !== lead.bot) continue;
          m.manager = hasLead && m !== lead ? lead.bot : (top?.bot ?? null);
        }
      }
      if (top) top.manager = null;
      if (structure !== "matrix") for (const m of org.members) m.also = null;
    }
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

/** Who may hand work to whom in this organization. */
export const assignRule = (org: Org): AssignRule => (org.structure === "custom" ? (org.assign ?? "reports") : structureOf(org.structure).assign);

/** The members an agent may hand a task to: its reports (direct and dotted-line), and more where the structure allows. */
export function assignableBy(org: Org, botId: string): Member[] {
  const rule = assignRule(org);
  if (rule === "anyone") return org.members.filter((m) => m.bot !== botId);
  const me = memberOf(org, botId);
  const mine = org.members.filter((m) => m.manager === botId || m.also === botId);
  if (rule !== "team" || !me) return mine;
  // Teammates: the others under the same lead (not the owner's whole top row, which is not a team).
  const mates = me.manager ? org.members.filter((m) => m.manager === me.manager && m.bot !== botId) : [];
  return [...new Set([...mine, ...mates])];
}

/** How work is requested across the chart in this organization. */
export const requestRule = (org: Org): RequestRule => (org.structure === "custom" ? "heads" : structureOf(org.structure).request);

/** Whether a member heads its department or team: nobody in the same department is above it. */
export const headsItsDepartment = (org: Org, m: Member) => !m.manager || memberOf(org, m.manager)?.department !== m.department;

/**
 * The members an agent may request work from, outside its own reports. They
 * accept or decline: a request is not an order. In a hierarchy only leads who
 * share a boss ask each other; elsewhere anyone asks the head of another
 * department or team; in a flat organization anyone asks anyone.
 */
export function requestableBy(org: Org, botId: string): Member[] {
  const me = memberOf(org, botId);
  if (!me) return [];
  const rule = requestRule(org);
  // Where anyone may hand work to anyone, there is nothing left to request.
  if (assignRule(org) === "anyone") return [];
  const others = org.members.filter((m) => m.bot !== botId && m.manager !== botId && m.also !== botId);
  if (rule === "anyone") return others;
  if (rule === "chain") return reportsOf(org, botId).length ? others.filter((m) => (m.manager ?? null) === (me.manager ?? null)) : [];
  return others.filter((m) => m.department !== me.department && headsItsDepartment(org, m));
}

/** What the organization says about spending and commitments. */
export const approvalWords = (org: Org) =>
  org.approvalLimit != null && org.approvalLimit > 0
    ? `Any spending, payment, order or commitment above $${org.approvalLimit} needs the owner's approval; say so and stop. Below that, your lead may approve it within its own decision rights. Nothing is ever paid, sent or signed by an agent.`
    : "Any spending, payment, order or commitment needs the owner's approval; say so and stop. Nothing is ever paid, sent or signed by an agent.";

/** The philosophy an organization runs by, as told to its agents. */
export function guidanceOf(org: Org): string {
  if (org.structure !== "custom") return structureOf(org.structure).guidance;
  const own = (org.philosophy ?? "").trim();
  return `${own ? `This organization runs by its own philosophy, written by its owner: ${own}` : "This organization has a structure of its owner's own design."} ${ASSIGN_RULES[assignRule(org)]} ${REQUEST_RULES[requestRule(org)]}`;
}

/** How many colleagues are named one by one before the rest are given as departments. Keeps the prompt small in a large organization. */
const NAMED_COLLEAGUES = 12;

/**
 * What a member is told about its place: its title, how the organization is
 * run, who it answers to, who it may hand work to and who else it can ask.
 * Only the colleagues near it are described; the rest are a name or a
 * department away, so a large organization does not fill every prompt.
 * Empty when the bot is not on the chart.
 */
export function rolePrompt(bot: Bot, org = orgs.active()): string {
  const me = memberOf(org, bot.id);
  if (!me) return "";
  const crew = new Map(loadCrew().bots.map((b) => [b.id, b]));
  const nameOf = (id: string) => crew.get(id)?.name ?? id;
  const named = (m: Member) => ((name) => (name.toLowerCase() === m.title.toLowerCase() ? name : `${name} (${m.title})`))(nameOf(m.bot));
  const the = (m: Member) => ((name) => (name.toLowerCase() === m.title.toLowerCase() ? `the ${name}` : `${name}, the ${m.title}`))(nameOf(m.bot));
  const boss = me.manager ? memberOf(org, me.manager) : null;
  const projectLead = me.also ? memberOf(org, me.also) : null;
  const canAssign = assignableBy(org, bot.id);
  const reports = org.members.filter((m) => m.manager === bot.id || m.also === bot.id);
  const mates = me.manager ? org.members.filter((m) => m.manager === me.manager && m.bot !== bot.id) : [];
  const lines = [
    "# Your place in the organization",
    `You are the ${me.title} in the ${me.department} department of ${org.name}.${org.mission ? ` Its mission: ${org.mission}` : ""}`,
    guidanceOf(org),
    `${boss ? `You report to ${the(boss)}. Your reports go to them.` : "You report directly to the user, who owns the organization."}${projectLead ? ` Your project lead is ${the(projectLead)}, who may also give you tasks.` : ""}`,
  ];
  if (reports.length) {
    lines.push(
      `These agents report to you. Hand a task to the one it fits with the assign_task tool, instead of doing their kind of work yourself:\n${reports.map((r) => `- ${named(r)}: ${crew.get(r.bot) ? oneLine(crew.get(r.bot)!) : ""}`).join("\n")}`,
    );
  }
  if (mates.length) lines.push(`Your teammates under the same lead: ${mates.map(named).join(", ")}.`);
  const others = canAssign.filter((m) => !reports.includes(m));
  if (others.length) lines.push(`You may also hand a task to ${others.length > NAMED_COLLEAGUES ? "any other member of the organization" : others.map(named).join(", ")} with assign_task.`);
  if (canAssign.length) {
    lines.push("Give each task everything the agent needs to know: it does not see this conversation. After assigning, finish any work that does not depend on the result, then end your turn; each report arrives as a message. When all the reports are in, check them, put them together and report upward.");
  } else {
    lines.push("Nobody takes tasks from you, so you do the work yourself. If a task belongs to another department, say so in your report rather than doing it badly.");
  }
  const rest = org.members.filter((m) => m.bot !== bot.id && m !== boss && m !== projectLead && !reports.includes(m) && !mates.includes(m));
  if (rest.length) {
    const directory =
      org.members.length <= NAMED_COLLEAGUES
        ? rest.map(named).join(", ")
        : [...new Set(rest.map((m) => m.department))].sort().map((d) => `${d} (${rest.filter((m) => m.department === d).length})`).join(", ");
    lines.push(`Other colleagues you can ask: ${directory}.`);
  }
  const peers = requestableBy(org, bot.id);
  if (peers.length) lines.push(`For work that belongs to another ${org.structure === "team" ? "team" : "department"}, use request_work: you may request it from ${peers.length > NAMED_COLLEAGUES ? "the head of that department" : peers.map(named).join(", ")}. They accept or decline; a request is not an order.`);
  lines.push(`${boss ? `When something is not yours to decide, or two leads want different things from you, use escalate to put it to ${the(boss)} with the options and your recommendation.` : "You report to the owner: when something is not yours to decide, stop and put it to the owner in your report under “Needs your decision”, with the options and your recommendation."} ${structureOf(org.structure).tieBreak}`);
  lines.push(approvalWords(org));
  if (org.members.length > 1) lines.push("You can put a short question to any colleague with ask_colleague and the answer comes back as a message. Ask when a colleague knows something you need; do not ask what you could look up in the organization's memory.");
  return lines.join("\n\n");
}

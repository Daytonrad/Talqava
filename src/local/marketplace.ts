// The bot marketplace: ready-made bots, each built for one job, that anyone can
// add to their team for free. For now the bots ship with the app, in the
// marketplace/ folder; each file is an ordinary bot file plus a "listing" block
// that says how it is shown. Adding one saves a copy as the person's own bot,
// which is theirs to edit.
import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { parseBot } from "../core/index.ts";
import type { Bot } from "../core/index.ts";
import { ROOT } from "./store.ts";
import { loadCrew, saveBot } from "./crew.ts";
import { orgs } from "./orgs.ts";
import { STRUCTURES, industryOf, seatsFor } from "./structures.ts";

export const MARKET_DIR = path.join(ROOT, "marketplace");
const TEAMS_FILE = "teams.yaml";

export interface Listing {
  category: string;
  by: string;
  summary: string;
  featured: boolean;
  will: string[];
  wont: string[];
  /** Where the bot sits when it joins an organization: its title, and the marketplace bot it reports to, if that one is a member. */
  title: string;
  reportsTo: string | null;
}

/** A ready-made team: a lead and the bots that report to it, added together. */
export interface Team {
  id: string;
  name: string;
  summary: string;
  department: string;
  bots: string[];
}

export interface MarketBot {
  bot: Bot;
  listing: Listing;
}

const lines = (value: unknown) => (Array.isArray(value) ? value.map((v) => String(v).trim()).filter(Boolean).slice(0, 6) : []);

/** Every bot in the marketplace, in name order. A file that cannot be read is left out and reported. */
export function loadMarketplace(): { bots: MarketBot[]; problems: string[] } {
  const bots: MarketBot[] = [];
  const problems: string[] = [];
  let names: string[] = [];
  try {
    names = fs.readdirSync(MARKET_DIR).filter((name) => /\.ya?ml$/.test(name) && name !== TEAMS_FILE).sort();
  } catch {}
  for (const name of names) {
    try {
      const text = fs.readFileSync(path.join(MARKET_DIR, name), "utf8");
      const bot = parseBot(name.replace(/\.ya?ml$/, ""), text, "starter");
      const raw = (parse(text) as { listing?: Record<string, unknown> }).listing ?? {};
      const summary = String(raw.summary ?? "").trim();
      if (!summary) throw new Error(`${name}: the listing needs a summary.`);
      const title = String(raw.title ?? bot.name).trim().slice(0, 50) || bot.name;
      bots.push({
        bot: { ...bot, title },
        listing: {
          category: String(raw.category ?? "Other").trim() || "Other",
          by: String(raw.by ?? "Talqava").trim() || "Talqava",
          summary,
          featured: raw.featured === true,
          will: lines(raw.will),
          wont: lines(raw.wont),
          title,
          reportsTo: typeof raw.reports_to === "string" && raw.reports_to.trim() ? raw.reports_to.trim() : null,
        },
      });
    } catch (err) {
      problems.push((err as Error).message);
    }
  }
  bots.sort((a, b) => a.bot.name.localeCompare(b.bot.name));
  return { bots, problems };
}

export function findMarketBot(id: string): MarketBot {
  const found = loadMarketplace().bots.find((m) => m.bot.id === id);
  if (!found) throw new Error(`The marketplace has no agent called "${id}".`);
  return found;
}

/** Whether the person already has a bot of this name on their team. */
export const onTeam = (id: string) => loadCrew().bots.some((b) => b.id === id);

/**
 * Adds a marketplace bot to the person's team: a copy saved as their own bot.
 * A bot they already have is left as it is, so their edits are never replaced.
 */
export function addMarketBot(id: string): Bot {
  const { bot, listing } = findMarketBot(id);
  const mine = loadCrew().bots.find((b) => b.id === id);
  if (mine) {
    // Already on the person's team: their own copy is left as it is, and it takes its place on this chart if it is not there.
    orgs.welcome(mine, { title: listing.title, department: listing.category, manager: listing.reportsTo });
    return mine;
  }
  // It joins the team group named after its marketplace category, and takes its place on the org chart.
  orgs.active(); // the organization exists before the bot does, so the bot arrives with its marketplace title
  const saved = saveBot(id, { name: bot.name, type: bot.type, title: listing.title, lead: bot.lead, governance: bot.governance, character: bot.character, instructions: bot.instructions, model: bot.model, powers: bot.powers, approvals: bot.approvals, budget: bot.budget, group: listing.category });
  orgs.welcome(saved, { title: listing.title, department: listing.category, manager: listing.reportsTo });
  return saved;
}

/** The ready-made teams. A team that names a bot the marketplace does not have is left out. */
export function loadTeams(): Team[] {
  let raw: unknown;
  try {
    raw = parse(fs.readFileSync(path.join(MARKET_DIR, TEAMS_FILE), "utf8"));
  } catch {
    return [];
  }
  const known = new Set(loadMarketplace().bots.map((m) => m.bot.id));
  return (Array.isArray(raw) ? raw : [])
    .map((t) => ({ id: String(t?.id ?? ""), name: String(t?.name ?? "").trim(), summary: String(t?.summary ?? "").trim(), department: String(t?.department ?? "").trim(), bots: Array.isArray(t?.bots) ? t.bots.map(String) : [] }))
    .filter((t) => /^[a-z0-9-]{1,40}$/.test(t.id) && t.name && t.bots.length && t.bots.every((b: string) => known.has(b)));
}

/**
 * Adds a whole team: every bot in it, lead first, so each one finds its
 * manager already on the chart. Bots the person already has keep their role.
 */
export function addTeam(id: string): Bot[] {
  const team = loadTeams().find((t) => t.id === id);
  if (!team) throw new Error(`The marketplace has no team called "${id}".`);
  const market = new Map(loadMarketplace().bots.map((m) => [m.bot.id, m]));
  // A bot is added after the one it reports to.
  const order = [...team.bots].sort((a, b) => Number(Boolean(market.get(a)!.listing.reportsTo)) - Number(Boolean(market.get(b)!.listing.reportsTo)));
  // The team's lead is the first one listed. It goes on first, so the others find it there.
  const lead = team.bots[0];
  const sequence = [lead, ...order.filter((botId) => botId !== lead)];
  const added = sequence.map((botId) => addMarketBot(botId));
  // Each member takes its place in the team: under whoever it usually reports to if that one is in this team, else under the team's lead.
  // An agent that was already on the chart somewhere else joins the team too, since adding the team is asking for exactly that.
  const org = orgs.active();
  for (const botId of sequence) {
    const { listing } = market.get(botId)!;
    const manager = listing.reportsTo && team.bots.includes(listing.reportsTo) ? listing.reportsTo : botId !== lead ? lead : null;
    if (botId === lead) continue; // the lead stays where it is: under the person, or wherever it was dropped
    const fresh = orgs.active().members.find((m) => m.bot === botId);
    if (!fresh) orgs.setMember(org.id, { bot: botId, title: listing.title, department: listing.category, manager });
    else if (fresh.manager !== manager) {
      try {
        orgs.setMember(org.id, { bot: botId, manager });
      } catch {
        // It is above its would-be lead on this chart; it is left where it is.
      }
    }
  }
  return added;
}

/**
 * Copies an example (a structure for a kind of business) onto an organization's chart: the positions it has that
 * the chart does not are added, with the example's reporting lines. It never removes, moves or redraws anything
 * the owner already has; on an empty chart the result is exactly the example. The agents' own files are untouched.
 */
export function buildStructure(orgId: string, structure: string, industry?: string, _exact = false): { added: string[] } {
  if (!STRUCTURES.some((s) => s.id === structure)) throw new Error("There is no such structure.");
  orgs.setActive(orgId);
  if (industry !== undefined) orgs.update(orgId, { industry });
  // An example is copied onto the chart: the positions it has that the chart does not get added, with the example's
  // lines where the manager is on the chart. Nothing the owner has is removed, moved or redrawn.
  orgs.update(orgId, { structure });
  const seatsOf = seatsFor(structure, industryOf(orgs.active().industry));
  const market = new Map(loadMarketplace().bots.map((m) => [m.bot.id, m]));
  const had = new Set(orgs.active().members.map((m) => m.bot));
  const added: string[] = [];
  for (const seat of seatsOf) {
    if (had.has(seat.bot)) continue;
    if (!onTeam(seat.bot) && market.has(seat.bot)) {
      addMarketBot(seat.bot);
      added.push(seat.bot);
    }
  }
  for (const seat of seatsOf) {
    if (had.has(seat.bot) || !onTeam(seat.bot)) continue;
    const listing = market.get(seat.bot)?.listing;
    const on = new Set(orgs.active().members.map((m) => m.bot));
    orgs.setMember(orgId, { bot: seat.bot, manager: seat.manager && on.has(seat.manager) ? seat.manager : null, title: listing?.title, department: seat.department ?? listing?.category, placed: true });
  }
  for (const seat of seatsOf) if (!had.has(seat.bot) && seat.also) try { orgs.setMember(orgId, { bot: seat.bot, also: seat.also }); } catch {}
  return { added };
}

/**
 * Drops a ready-made team (a pack) onto an organization's chart, where the owner put it: under a position (its lead
 * reports to that position), into a group (everyone joins it), or under the owner. Its members keep the lines the
 * pack gives them, and each keeps its own department's group unless dropped into a group. Nothing else on the chart
 * moves, and no empty group is left behind.
 */
export function addPack(orgId: string, teamId: string, where: { under?: unknown; group?: unknown } = {}) {
  const team = loadTeams().find((t) => t.id === teamId);
  if (!team) throw new Error(`The marketplace has no team called "${teamId}".`);
  orgs.setActive(orgId);
  const before = orgs.active();
  const under = where.under ? String(where.under) : null;
  if (under && !before.members.some((m) => m.bot === under)) throw new Error("That position is not on the chart.");
  if (under && team.bots.includes(under)) throw new Error("A team cannot report to one of its own members.");
  const group = String(where.group ?? "").trim().slice(0, 30) || null;
  const had = new Set((before.groups ?? []).map((g) => g.id));
  addTeam(teamId);
  const lead = team.bots[0];
  orgs.setMember(orgId, { bot: lead, manager: under, ...(group ? { department: group } : {}) });
  if (group) for (const botId of team.bots.slice(1)) orgs.setMember(orgId, { bot: botId, department: group });
  let org = orgs.active();
  for (const g of org.groups ?? []) if (!had.has(g.id) && !org.members.some((m) => m.department === g.name)) org = orgs.removeGroup(orgId, g.id);
  return { org, added: team.bots };
}

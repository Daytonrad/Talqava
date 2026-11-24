// The bot marketplace: ready-made bots, each built for one job, that anyone can
// add to their team for free. For now the bots ship with the app, in the
// marketplace/ folder; each file is an ordinary bot file plus a "listing" block
// that says how it is shown. Adding one saves a copy as the person's own bot,
// which is theirs to edit.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { parseBot } from "../core/index.ts";
import type { Bot } from "../core/index.ts";
import { DATA, ROOT, readJson, writeJson } from "./store.ts";
import { loadCrew, personalDir, saveBot } from "./crew.ts";
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
  /** The package label every listing carries (see the Marketplace spec). */
  version: string;
  /** What changed, newest first: "1.1.0: …". */
  changes: string[];
  licence: string;
  /** Made by Talqava, Verified (reviewed by Talqava) or Community. */
  trust: Trust;
}

export type Trust = "talqava" | "verified" | "community";

/** Licences a listing may be shared under: those on the approved licence list (legal/APPROVED_LICENSES.md). */
export const LISTING_LICENCES = ["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "CC-BY-4.0", "CC0-1.0"];
const VERSION = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/;
/** Compares two versions: negative when a is older than b. */
export const compareVersions = (a: string, b: string) => {
  const [x, y] = [a, b].map((v) => (VERSION.test(v) ? v.split(".").map(Number) : [0, 0, 0]));
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
};

/** Text in an agent's instructions that tries to take it over, hide what it does, or send data away. */
const HIDDEN_INSTRUCTIONS = [
  /ignore (all |any )?(previous|prior|earlier|other) (instructions|rules)/i,
  /(do not|don't|never) (tell|inform|show|let) the (user|owner|person)/i,
  /without (telling|asking|informing) the (user|owner|person)/i,
  /(send|post|upload|forward) [^.]{0,60}(https?:\/\/|to an? (outside|external) (address|server|url))/i,
  /(disable|turn off|bypass|skip) [^.]{0,30}(approval|ask(ing)? first|safety|limits?|budget)/i,
  /(reveal|print|show|send) [^.]{0,30}(api key|password|secret|token)/i,
];

/**
 * The automatic checks every listing passes before it is offered (the Marketplace spec, "Trust and safety").
 * Returns what is wrong, in plain words; an empty list means it may be offered.
 */
export function checkListing({ bot, listing }: MarketBot): string[] {
  const problems: string[] = [];
  const who = `${bot.name}:`;
  if (bot.approvals !== "ask") problems.push(`${who} a marketplace agent must ask before changing anything.`);
  if (bot.powers.includes("api")) problems.push(`${who} a marketplace agent may not call outside services with stored keys.`);
  if (bot.powers.includes("shell") && listing.category !== "Engineering") problems.push(`${who} only engineering roles may run commands.`);
  for (const re of HIDDEN_INSTRUCTIONS) if (re.test(bot.instructions)) problems.push(`${who} its instructions contain text that tries to override its rules or hide what it does ("${bot.instructions.match(re)![0]}").`);
  if (!LISTING_LICENCES.includes(listing.licence)) problems.push(`${who} its licence, ${listing.licence}, is not on the approved licence list.`);
  if (!VERSION.test(listing.version)) problems.push(`${who} its version must look like 1.0.0.`);
  if (!listing.will.length || !listing.wont.length) problems.push(`${who} the listing needs what it will and will not do.`);
  if (bot.budget?.spend === undefined || bot.budget.spend > 5) problems.push(`${who} it needs a spending limit per task of $5 or less.`);
  if (bot.instructions.length < 200) problems.push(`${who} its instructions are too short to say how it works.`);
  return problems;
}

/** A ready-made team: a lead and the bots that report to it, added together. */
export interface Team {
  id: string;
  name: string;
  summary: string;
  department: string;
  bots: string[];
  version: string;
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
      const by = String(raw.by ?? "Talqava").trim() || "Talqava";
      const version = String(raw.version ?? "1.0.0").trim();
      const entry: MarketBot = {
        bot: { ...bot, title },
        listing: {
          category: String(raw.category ?? "Other").trim() || "Other",
          by,
          summary,
          featured: raw.featured === true,
          will: lines(raw.will),
          wont: lines(raw.wont),
          title,
          reportsTo: typeof raw.reports_to === "string" && raw.reports_to.trim() ? raw.reports_to.trim() : null,
          version,
          changes: Array.isArray(raw.changes) ? raw.changes.map((c) => String(c).trim()).filter(Boolean).slice(0, 20) : [`${version}: first version`],
          licence: String(raw.licence ?? raw.license ?? "MIT").trim(),
          // Only Talqava's own listings are "Made by Talqava"; a listing says "verified" once Talqava has reviewed it.
          trust: by === "Talqava" ? "talqava" : raw.trust === "verified" ? "verified" : "community",
        },
      };
      // A listing that fails the automatic checks is not offered; the reason is reported.
      const failed = checkListing(entry);
      if (failed.length) throw new Error(failed.join(" "));
      bots.push(entry);
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

// ---------- what was installed, and which version ----------

/** Where an installed copy came from: the listing's version, and a fingerprint of the copy as installed, to tell whether the owner changed it. */
interface Installed {
  version: string;
  hash: string;
  at: string;
  /** The copy before the last update, so the update can be undone. */
  previous?: { version: string; hash: string; file: string } | null;
}
const installedFile = () => path.join(DATA, "marketplace-installed.json");
const readInstalled = () => readJson<Record<string, Installed>>(installedFile(), {});
const writeInstalled = (all: Record<string, Installed>) => writeJson(installedFile(), all);

/** A fingerprint of what an agent does: its instructions, powers, limits and rules. Its name, look and model are the owner's to change and are left out. */
export function fingerprint(bot: Bot): string {
  const what = { type: bot.type, lead: Boolean(bot.lead), instructions: bot.instructions.trim(), powers: [...bot.powers].sort(), approvals: bot.approvals, budget: bot.budget, governance: bot.governance ?? null };
  return crypto.createHash("sha256").update(JSON.stringify(what)).digest("hex").slice(0, 16);
}

export type InstallState = "available" | "current" | "update" | "differs";
export interface InstallStatus {
  state: InstallState;
  /** The version on the person's team, when known. */
  installed: string | null;
  /** The owner changed their copy since it was installed. */
  edited: boolean;
  /** An update can be undone. */
  canUndo: boolean;
}

/** Whether an agent is on the person's team, which version, and whether a newer one is offered. */
export function installStatus(entry: MarketBot, mine = loadCrew().bots.find((b) => b.id === entry.bot.id)): InstallStatus {
  if (!mine || mine.source !== "personal") return { state: "available", installed: null, edited: false, canUndo: false };
  const all = readInstalled();
  const record = all[entry.bot.id];
  const now = fingerprint(mine);
  if (!record) {
    // Added before versions were kept: if it matches the listing, it is that version; otherwise its origin is unknown.
    if (now === fingerprint(entry.bot)) {
      all[entry.bot.id] = { version: entry.listing.version, hash: now, at: new Date().toISOString() };
      writeInstalled(all);
      return { state: "current", installed: entry.listing.version, edited: false, canUndo: false };
    }
    return { state: "differs", installed: null, edited: true, canUndo: false };
  }
  const edited = now !== record.hash;
  const state: InstallState = compareVersions(record.version, entry.listing.version) < 0 ? "update" : "current";
  return { state, installed: record.version, edited, canUndo: Boolean(record.previous) };
}

function recordInstall(id: string, version: string, bot: Bot, previous: Installed["previous"] = null) {
  const all = readInstalled();
  all[id] = { version, hash: fingerprint(bot), at: new Date().toISOString(), previous };
  writeInstalled(all);
}

/**
 * Updates the person's copy of a marketplace agent to the listing's version. The previous copy is kept so the update
 * can be undone. The owner's choices (its model, look, title, group and monthly budget) are kept; what it does
 * (instructions, powers, limits, rules) comes from the new version.
 */
export function updateMarketBot(id: string): { version: string; replacedEdits: boolean } {
  const entry = findMarketBot(id);
  const mine = loadCrew().bots.find((b) => b.id === id && b.source === "personal");
  if (!mine) throw new Error(`The ${entry.bot.name} is not on your team. Add it first.`);
  const status = installStatus(entry, mine);
  if (status.state === "current" && !status.edited) return { version: entry.listing.version, replacedEdits: false };
  const file = path.join(personalDir(), `${id}.yaml`);
  const historyDir = path.join(DATA, "crew-history", id);
  fs.mkdirSync(historyDir, { recursive: true });
  const kept = path.join(historyDir, `${new Date().toISOString().replace(/[:.]/g, "-")}.yaml`);
  fs.copyFileSync(file, kept);
  const record = readInstalled()[id];
  const { bot } = entry;
  const saved = saveBot(id, { name: mine.name, type: bot.type, title: mine.title ?? entry.listing.title, lead: bot.lead, governance: bot.governance, character: mine.character, instructions: bot.instructions, model: mine.model, powers: bot.powers, approvals: bot.approvals, budget: bot.budget, group: mine.group, monthly: mine.monthly });
  recordInstall(id, entry.listing.version, saved, { version: record?.version ?? "unknown", hash: fingerprint(mine), file: kept });
  return { version: entry.listing.version, replacedEdits: status.edited };
}

/** Puts back the copy that was there before the last update. */
export function undoMarketUpdate(id: string): { version: string } {
  const record = readInstalled()[id];
  if (!record?.previous || !fs.existsSync(record.previous.file)) throw new Error("There is no update to undo for this agent.");
  fs.copyFileSync(record.previous.file, path.join(personalDir(), `${id}.yaml`));
  const all = readInstalled();
  all[id] = { version: record.previous.version, hash: record.previous.hash, at: new Date().toISOString(), previous: null };
  writeInstalled(all);
  return { version: record.previous.version };
}

// ---------- before you install ----------

export interface PreviewItem {
  id: string;
  title: string;
  department: string;
  /** "new": it is added; "have": it is already on the team and is left as it is. */
  state: "new" | "have";
  /** Who it reports to on the chart: a title, or null for the owner. */
  reportsTo: string | null;
  powers: string[];
  asksFirst: boolean;
  spendPerTask: number | null;
  steps: number;
}
export interface Preview {
  kind: "agent" | "team";
  name: string;
  version: string;
  by: string;
  trust: Trust;
  licence: string;
  items: PreviewItem[];
  /** What a task from every new agent would cost at most. */
  newSpendPerTask: number;
  wont: string[];
  needs: string[];
}

const titleOn = (botId: string | null, market: Map<string, MarketBot>) => {
  if (!botId) return null;
  const member = orgs.active().members.find((m) => m.bot === botId);
  return member?.title ?? market.get(botId)?.listing.title ?? null;
};

function previewItem(entry: MarketBot, reportsTo: string | null, market: Map<string, MarketBot>, crew: Set<string>): PreviewItem {
  const { bot, listing } = entry;
  return { id: bot.id, title: listing.title, department: listing.category, state: crew.has(bot.id) ? "have" : "new", reportsTo: titleOn(reportsTo, market), powers: bot.powers, asksFirst: bot.approvals === "ask", spendPerTask: bot.budget?.spend ?? null, steps: bot.budget?.steps ?? 0 };
}

/** What adding one agent would do, in plain terms, before anything changes. */
export function previewMarketBot(id: string): Preview {
  const entry = findMarketBot(id);
  const market = new Map(loadMarketplace().bots.map((m) => [m.bot.id, m]));
  const crew = new Set(loadCrew().bots.map((b) => b.id));
  const onChart = new Set(orgs.active().members.map((m) => m.bot));
  const manager = entry.listing.reportsTo && onChart.has(entry.listing.reportsTo) ? entry.listing.reportsTo : null;
  const item = previewItem(entry, manager, market, crew);
  return { kind: "agent", name: entry.bot.name, version: entry.listing.version, by: entry.listing.by, trust: entry.listing.trust, licence: entry.listing.licence, items: [item], newSpendPerTask: item.state === "new" ? (item.spendPerTask ?? 0) : 0, wont: entry.listing.wont, needs: [] };
}

/** What adding a team would do: every agent, where it goes, what it can do and what it may cost. */
export function previewTeam(id: string): Preview {
  const team = loadTeams().find((t) => t.id === id);
  if (!team) throw new Error(`The marketplace has no team called "${id}".`);
  const market = new Map(loadMarketplace().bots.map((m) => [m.bot.id, m]));
  const crew = new Set(loadCrew().bots.map((b) => b.id));
  const lead = team.bots[0];
  const items = team.bots.map((botId) => {
    const entry = market.get(botId)!;
    // As addTeam places them: under whoever they usually report to if that one is in the team, else under the lead.
    const manager = botId === lead ? null : entry.listing.reportsTo && team.bots.includes(entry.listing.reportsTo) ? entry.listing.reportsTo : lead;
    return previewItem(entry, manager, market, crew);
  });
  const wont = [...new Set(team.bots.flatMap((b) => market.get(b)!.listing.wont))].slice(0, 8);
  return { kind: "team", name: team.name, version: team.version, by: "Talqava", trust: "talqava", licence: "MIT", items, newSpendPerTask: items.filter((i) => i.state === "new").reduce((sum, i) => sum + (i.spendPerTask ?? 0), 0), wont, needs: [] };
}

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
  recordInstall(id, listing.version, saved);
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
    .map((t) => ({ id: String(t?.id ?? ""), name: String(t?.name ?? "").trim(), summary: String(t?.summary ?? "").trim(), department: String(t?.department ?? "").trim(), bots: Array.isArray(t?.bots) ? t.bots.map(String) : [], version: VERSION.test(String(t?.version ?? "")) ? String(t.version) : "1.0.0" }))
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

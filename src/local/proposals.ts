// Positions an agent proposes for the organization. An agent never changes the chart: it can only propose a
// position, with its reason, and the owner approves or declines it. Approving places the role exactly as a
// suggestion would be accepted; declining keeps the reason the owner gave, so the agent is not asked again.
import path from "node:path";
import { DATA, newId, readJson, writeJson } from "./store.ts";
import { orgs } from "./orgs.ts";
import { loadMarketplace } from "./marketplace.ts";
import { acceptSuggestion } from "./suggest.ts";
import { audit } from "./audit.ts";

export interface Proposal {
  id: string;
  org: string;
  /** The agent that proposed it. */
  by: string;
  byName: string;
  /** The marketplace role proposed. */
  bot: string;
  title: string;
  group: string;
  reportsTo: string | null;
  why: string;
  status: "open" | "approved" | "declined";
  /** The owner's reason for declining, if they gave one. */
  answer?: string;
  createdAt: string;
  decidedAt?: string;
}

/** Open proposals one organization may have at once, so agents cannot flood the owner. */
export const MAX_OPEN = 3;

const file = () => path.join(DATA, "proposals.json");
const read = () => readJson<Proposal[]>(file(), []);
const write = (all: Proposal[]) => writeJson(file(), all.slice(-200));

export const listProposals = (orgId: string) => read().filter((p) => p.org === orgId);

/** A marketplace role by its id or title, or the closest few to the words given. */
function findRole(wanted: string) {
  const catalog = loadMarketplace().bots;
  const w = wanted.trim().toLowerCase();
  const exact = catalog.find(({ bot, listing }) => bot.id === w || listing.title.toLowerCase() === w);
  if (exact) return { role: exact };
  const words = w.match(/[a-z]{3,}/g) ?? [];
  const close = catalog
    .map((m) => ({ m, hits: words.filter((x) => `${m.listing.title} ${m.listing.category}`.toLowerCase().includes(x)).length }))
    .filter((x) => x.hits)
    .sort((a, b) => b.hits - a.hits)
    .slice(0, 8)
    .map((x) => x.m.listing.title);
  return { close: close.length ? close : catalog.map((m) => m.listing.title) };
}

/** Records an agent's proposal for a new position. Throws, with what to do instead, when it cannot be made. */
export function propose(orgId: string, byId: string, input: { role?: unknown; why?: unknown; group?: unknown; reportsTo?: unknown }): Proposal {
  const org = orgs.list().orgs.find((o) => o.id === orgId);
  if (!org) throw new Error("There is no such organization.");
  const me = org.members.find((m) => m.bot === byId);
  if (!me) throw new Error("Only someone on the chart can propose a position.");
  const why = String(input.why ?? "").replace(/\s+/g, " ").trim();
  if (why.length < 20) throw new Error("Say why the organization needs this position: what work it would do that nobody does now, in a sentence or two.");
  const found = findRole(String(input.role ?? ""));
  if (!found.role) throw new Error(`There is no such role. Roles that can be proposed: ${found.close!.join(", ")}.`);
  const { bot, listing } = found.role;
  if (org.members.some((m) => m.bot === bot.id)) throw new Error(`${listing.title} is already on the chart. Hand it the work instead.`);
  const all = read();
  const mine = all.filter((p) => p.org === orgId);
  if (mine.some((p) => p.bot === bot.id && p.status === "open")) throw new Error(`${listing.title} has already been proposed and is waiting for the owner.`);
  const declined = mine.find((p) => p.bot === bot.id && p.status === "declined");
  if (declined) throw new Error(`The owner declined ${listing.title} already${declined.answer ? `: “${declined.answer}”` : ""}. Do not propose it again; work with the team there is.`);
  if (mine.filter((p) => p.status === "open").length >= MAX_OPEN) throw new Error(`${MAX_OPEN} proposals are already waiting for the owner. Say in your report what you would add, and why.`);
  // It reports to whoever proposed it unless another position on the chart is named.
  const named = String(input.reportsTo ?? "").trim().toLowerCase();
  const reportsTo = named ? (org.members.find((m) => m.bot === named || m.title.toLowerCase() === named)?.bot ?? byId) : byId;
  const group = String(input.group ?? "").trim().slice(0, 30) || org.members.find((m) => m.bot === reportsTo)?.department || listing.category;
  const p: Proposal = { id: newId(), org: orgId, by: byId, byName: me.title, bot: bot.id, title: listing.title, group, reportsTo, why: why.slice(0, 500), status: "open", createdAt: new Date().toISOString() };
  write([...all, p]);
  audit({ actor: byId, actorName: me.title, kind: "organization", action: `Proposed a new position: ${listing.title}`, detail: why });
  return p;
}

/** The owner's answer to a proposal. Approving places the position; declining keeps the owner's reason. */
export async function decide(orgId: string, id: string, decision: unknown, answer?: unknown): Promise<Proposal> {
  const all = read();
  const p = all.find((x) => x.id === id && x.org === orgId);
  if (!p) throw new Error("There is no such proposal.");
  if (p.status !== "open") throw new Error("That proposal has already been answered.");
  if (decision !== "approve" && decision !== "decline") throw new Error("Approve or decline it.");
  if (decision === "approve") await acceptSuggestion(orgId, { bot: p.bot, group: p.group, reportsTo: p.reportsTo });
  p.status = decision === "approve" ? "approved" : "declined";
  p.decidedAt = new Date().toISOString();
  const said = String(answer ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
  if (said) p.answer = said;
  write(all);
  audit({ actor: "owner", actorName: "You", kind: "organization", action: `${decision === "approve" ? "Approved" : "Declined"} the proposed position ${p.title}`, detail: `Proposed by ${p.byName}${said ? `. ${said}` : ""}` });
  return p;
}

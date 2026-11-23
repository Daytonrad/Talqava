// Suggested positions for an organization, from the owner's mission. Only ever proposals: the page shows each
// with its reason, and nothing is added until the owner accepts it. The model is asked once (no tools); when it
// cannot be reached, roles are matched to the mission's words instead, which costs nothing.
import { costOf } from "../core/index.ts";
import { resolveModel } from "./models.ts";
import { getConfig } from "./store.ts";
import { orgs } from "./orgs.ts";
import { loadMarketplace } from "./marketplace.ts";
import { audit } from "./audit.ts";

export interface Suggestion {
  /** The marketplace role's id. */
  bot: string;
  title: string;
  /** The group it would join. */
  group: string;
  /** Why it fits this organization, in a sentence. */
  why: string;
  /** Who it would report to: another suggestion or a position already on the chart, or null for the owner. */
  reportsTo: string | null;
}

export interface Suggestions {
  intro: string;
  positions: Suggestion[];
  /** "model" when the owner's model chose them; "words" when they were matched to the mission's words. */
  source: "model" | "words";
  cost: number;
}

const STOP = new Set("a an and are as at be by for from in into is it of on or our the their to we with you your that this run business company".split(" "));

/** Roles matched to the mission's words: a lead per area the mission touches, then a specialist or two. */
function byWords(mission: string, catalog: ReturnType<typeof loadMarketplace>["bots"], have: Set<string>, limit: number): Suggestion[] {
  const words = [...new Set(mission.toLowerCase().match(/[a-z]{3,}/g) ?? [])].filter((w) => !STOP.has(w));
  const scored = catalog
    .filter(({ bot }) => !have.has(bot.id))
    .map(({ bot, listing }) => {
      const text = `${listing.title} ${listing.category} ${listing.summary}`.toLowerCase();
      const hits = words.filter((w) => text.includes(w.replace(/s$/, ""))).length;
      return { bot, listing, score: hits * 2 + (bot.lead ? 1 : 0) };
    })
    .sort((a, b) => b.score - a.score || Number(Boolean(b.bot.lead)) - Number(Boolean(a.bot.lead)));
  // Without any word in common, a small business usually starts with someone for sales, operations and the money.
  const fallback = ["head-of-sales", "head-of-operations", "bookkeeper", "head-of-marketing"];
  const picked = scored[0]?.score >= 3 ? scored.slice(0, limit) : scored.filter((s) => fallback.includes(s.bot.id)).sort((a, b) => fallback.indexOf(a.bot.id) - fallback.indexOf(b.bot.id));
  return picked.slice(0, limit).map(({ bot, listing }) => ({ bot: bot.id, title: listing.title, group: listing.category, why: listing.summary, reportsTo: null }));
}

function parse(text: string): { intro?: string; positions?: { id?: string; group?: string; why?: string; reportsTo?: string | null }[] } | null {
  const match = /\{[\s\S]*\}/.exec(text);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

/**
 * Accepts one suggestion: the role joins the owner's team if it is not on it, and takes its position in the group
 * suggested, reporting to the one suggested when that one is on the chart (otherwise to the owner).
 */
export async function acceptSuggestion(orgId: string, s: { bot?: unknown; group?: unknown; reportsTo?: unknown }) {
  const { addMarketBot } = await import("./marketplace.ts");
  const id = String(s.bot ?? "");
  if (!loadMarketplace().bots.some((m) => m.bot.id === id)) throw new Error("There is no such role in the marketplace.");
  orgs.setActive(orgId);
  addMarketBot(id);
  const org = orgs.active();
  const manager = s.reportsTo && org.members.some((m) => m.bot === s.reportsTo) ? String(s.reportsTo) : null;
  const group = String(s.group ?? "").trim().slice(0, 30) || undefined;
  return orgs.setMember(orgId, { bot: id, manager, ...(group ? { department: group } : {}) });
}

/** Up to `limit` positions the organization could start with, or add next, for its mission. */
export async function suggestPositions(orgId: string, missionInput?: unknown, limit = 6): Promise<Suggestions> {
  const org = orgs.list().orgs.find((o) => o.id === orgId);
  if (!org) throw new Error("There is no such organization.");
  const mission = String(missionInput ?? org.mission ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
  if (!mission) throw new Error("Write the mission first: what the organization is for, in a sentence.");
  const catalog = loadMarketplace().bots;
  const byId = new Map(catalog.map((m) => [m.bot.id, m]));
  const have = new Set(org.members.map((m) => m.bot));
  const onChart = org.members.map((m) => `${m.bot} (${m.title}, ${m.department})`);
  const cfg = getConfig();
  try {
    const model = resolveModel({ ...cfg, effort: "low" });
    const system = [
      "You help a non-technical owner build an organization of AI agents, one position at a time. Suggest the few positions it should have next, for its mission.",
      "Pick only from this catalog of roles (id | title | group | what it does):",
      ...catalog.filter(({ bot }) => !have.has(bot.id)).map(({ bot, listing }) => `${bot.id} | ${listing.title} | ${listing.category} | ${listing.summary}`),
      "",
      onChart.length ? `Already on the chart: ${onChart.join("; ")}.` : "The chart is empty: only the owner.",
      "",
      `Suggest ${Math.min(3, limit)} to ${limit} positions, the most useful first. Fewer is better than padding: a small business needs few. Prefer a lead per area before specialists, and give a specialist its lead as reportsTo when that lead is suggested or already on the chart.`,
      'Answer with JSON only: {"intro": "one sentence on why this set fits the mission, in plain words", "positions": [{"id": "role id from the catalog", "group": "the group it joins", "why": "one short sentence for the owner", "reportsTo": "role id or null"}]}',
    ].join("\n");
    const reply = await model.call({ system, messages: [{ role: "user", content: `The mission: ${mission}` }], tools: [], hostedTools: [], mcpServers: [], signal: AbortSignal.timeout(60_000) }, { onText() {}, onThinking() {}, onToolStart() {} });
    const cost = reply.usage.cost ?? (model.prices ? costOf(model.prices, reply.usage) : 0);
    const data = parse(reply.content.map((b) => (b.type === "text" ? b.text : "")).join("\n"));
    const chosen = new Set<string>();
    const positions: Suggestion[] = [];
    for (const p of data?.positions ?? []) {
      const id = String(p.id ?? "");
      const role = byId.get(id);
      if (!role || have.has(id) || chosen.has(id)) continue;
      chosen.add(id);
      positions.push({ bot: id, title: role.listing.title, group: String(p.group ?? "").trim().slice(0, 30) || role.listing.category, why: String(p.why ?? role.listing.summary).slice(0, 240), reportsTo: p.reportsTo && (byId.has(String(p.reportsTo)) || have.has(String(p.reportsTo))) ? String(p.reportsTo) : null });
      if (positions.length >= limit) break;
    }
    // A specialist only reports to a suggestion that is also offered, or to someone already on the chart.
    for (const p of positions) if (p.reportsTo && !have.has(p.reportsTo) && !chosen.has(p.reportsTo)) p.reportsTo = null;
    audit({ actor: "system", actorName: "Talqava", kind: "organization", action: `Suggested ${positions.length} positions for ${org.name}`, detail: positions.map((p) => p.title).join(", "), cost });
    if (positions.length) return { intro: String(data?.intro ?? "").slice(0, 300), positions, source: "model", cost };
  } catch {
    // No model, or it could not be reached: match roles to the mission's words instead.
  }
  const positions = byWords(mission, catalog, have, limit);
  return { intro: "These roles match the words in your mission. Accept the ones you want; skip the rest.", positions, source: "words", cost: 0 };
}

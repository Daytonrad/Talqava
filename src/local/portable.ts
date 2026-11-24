// An organization as one readable file, to keep, share or move to another computer. It holds what the owner built:
// the organization's settings, its groups, its positions with their lines, and the agents of their own (the ones made
// or edited in this app) so it rebuilds identically elsewhere. It never holds keys or other settings, tasks or their
// history, the organization's memory, or the library's documents.
import fs from "node:fs";
import path from "node:path";
import { parse, stringify } from "yaml";
import { parseBot } from "../core/index.ts";
import { loadCrew, personalDir } from "./crew.ts";
import { orgs } from "./orgs.ts";
import { addMarketBot, loadMarketplace } from "./marketplace.ts";
import { audit } from "./audit.ts";

export const FORMAT = "talqava-organization";
export const VERSION = 1;
const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

interface Exported {
  format: string;
  version: number;
  exported?: string;
  organization: { name: string; mission?: string; philosophy?: string; approvalLimit?: number | null; structure?: string; industry?: string };
  groups: { name: string; lead?: string | null; goal?: string; budget?: number | null }[];
  positions: { agent: string; title: string; group: string; reportsTo?: string | null; alsoWorksWith?: string | null; responsibilities?: string }[];
  /** The owner's own agents, as their agent files. Agents that ship with the app or the marketplace are named only. */
  agents?: Record<string, string>;
}

/** The text of one of the owner's own agent files, or "" if there is none. */
function ownFile(id: string): string {
  try {
    return fs.readFileSync(path.join(personalDir(), `${id}.yaml`), "utf8");
  } catch {
    return "";
  }
}

/** The file name and text of an organization's export. */
export function exportOrg(orgId: string): { name: string; text: string } {
  const org = orgs.list().orgs.find((o) => o.id === orgId);
  if (!org) throw new Error("There is no such organization.");
  const crew = new Map(loadCrew().bots.map((b) => [b.id, b]));
  const agents: Record<string, string> = {};
  for (const m of org.members) {
    if (crew.get(m.bot)?.source !== "personal") continue;
    // Listed as personal but its file is gone: it is named only, like a marketplace agent.
    const own = ownFile(m.bot);
    if (own) agents[m.bot] = own;
  }
  const data: Exported = {
    format: FORMAT,
    version: VERSION,
    exported: new Date().toISOString().slice(0, 10),
    organization: {
      name: org.name,
      ...(org.mission ? { mission: org.mission } : {}),
      ...(org.philosophy ? { philosophy: org.philosophy } : {}),
      ...(org.approvalLimit != null ? { approvalLimit: org.approvalLimit } : {}),
      structure: org.structure,
      industry: org.industry,
    },
    groups: (org.groups ?? []).map((g) => ({ name: g.name, lead: g.leadChosen ? g.lead : null, ...(g.goal ? { goal: g.goal } : {}), ...(g.budget != null ? { budget: g.budget } : {}) })),
    positions: org.members.map((m) => ({ agent: m.bot, title: m.title, group: m.department, reportsTo: m.manager, ...(m.also ? { alsoWorksWith: m.also } : {}), ...(m.responsibilities ? { responsibilities: m.responsibilities } : {}) })),
    ...(Object.keys(agents).length ? { agents } : {}),
  };
  const head = `# ${org.name}: a Talqava organization, exported ${data.exported}.\n# Import it under Organization > Settings in Talqava. It holds the chart and the owner's own agents;\n# no keys, tasks, memory or library documents.\n`;
  return { name: `${org.name.replace(/[^\w\- ]+/g, "").trim() || "organization"}.talqava.yaml`, text: head + stringify(data, { lineWidth: 0 }) };
}

/**
 * Imports an exported organization as a new one (an organization of the same name gets a number after it). Agents it
 * brings that this app does not have are added; an agent of the owner's own with the same name is kept as it is, and
 * the import says so. Everything is checked before anything is written.
 */
export function importOrg(text: unknown): { org: ReturnType<typeof orgs.active>; added: string[]; kept: string[] } {
  const raw = String(text ?? "");
  if (!raw.trim()) throw new Error("Choose an exported organization file.");
  if (raw.length > 2_000_000) throw new Error("That file is too large to be an exported organization.");
  let data: Exported;
  try {
    data = parse(raw) as Exported;
  } catch {
    throw new Error("That file could not be read. Choose a file exported from Talqava.");
  }
  if (!data || data.format !== FORMAT) throw new Error("That is not an exported Talqava organization.");
  if (Number(data.version) > VERSION) throw new Error("That file comes from a newer version of Talqava. Update the app, then import it.");
  const positions = Array.isArray(data.positions) ? data.positions : [];
  const groups = Array.isArray(data.groups) ? data.groups : [];
  const agents = data.agents && typeof data.agents === "object" ? data.agents : {};

  // Check everything first: every position names an agent this app has, or one the file brings.
  const crew = new Map(loadCrew().bots.map((b) => [b.id, b]));
  const market = new Set(loadMarketplace().bots.map((m) => m.bot.id));
  const bring = new Map<string, string>();
  const kept: string[] = [];
  for (const [id, file] of Object.entries(agents)) {
    if (!ID.test(id) || typeof file !== "string" || file.length > 50_000) throw new Error(`The agent "${id}" in that file is not valid.`);
    try {
      parseBot(id, file, "personal");
    } catch (err) {
      throw new Error(`The agent "${id}" in that file is not valid: ${(err as Error).message}`);
    }
    if (crew.get(id)?.source !== "personal") bring.set(id, file);
    // The owner already has their own version: theirs stays. It is worth saying only when the two differ.
    else if (ownFile(id).trim() !== file.trim()) kept.push(id);
  }
  for (const p of positions) {
    const id = String(p?.agent ?? "");
    if (!ID.test(id)) throw new Error("A position in that file names no agent.");
    if (!crew.has(id) && !bring.has(id) && !market.has(id)) throw new Error(`That file needs the agent "${id}", which this app does not have and the file does not bring.`);
  }

  // Then write: the organization, the agents it brings, the marketplace agents it uses, and its chart.
  const name = String(data.organization?.name ?? "").trim().slice(0, 60) || "Imported organization";
  const taken = new Set(orgs.list().orgs.map((o) => o.name.toLowerCase()));
  let unique = name;
  for (let n = 2; taken.has(unique.toLowerCase()); n++) unique = `${name} (${n})`;
  const previous = orgs.active().id;
  const org = orgs.create(unique, data.organization?.mission ?? "", "custom");
  try {
    const o = data.organization ?? ({} as Exported["organization"]);
    orgs.update(org.id, { philosophy: o.philosophy, approvalLimit: o.approvalLimit ?? undefined, industry: o.industry });
    fs.mkdirSync(personalDir(), { recursive: true });
    for (const [id, file] of bring) fs.writeFileSync(path.join(personalDir(), `${id}.yaml`), file, { mode: 0o600 });
    const now = new Map(loadCrew().bots.map((b) => [b.id, b]));
    for (const p of positions) if (!now.has(p.agent)) addMarketBot(p.agent);
    orgs.replaceChart(org.id, {
      members: positions.map((p) => ({ bot: p.agent, title: p.title, department: p.group, manager: p.reportsTo ?? null, also: p.alsoWorksWith ?? null, ...(p.responsibilities ? { responsibilities: p.responsibilities } : {}) })),
      groups: groups.map((g) => ({ name: g.name, lead: g.lead ?? null, leadChosen: Boolean(g.lead), ...(g.goal ? { goal: g.goal } : {}), ...(g.budget != null ? { budget: g.budget } : {}) })),
    });
  } catch (err) {
    // A chart that does not hold together leaves nothing half-made behind.
    orgs.remove(org.id);
    orgs.setActive(previous);
    for (const id of bring.keys()) fs.rmSync(path.join(personalDir(), `${id}.yaml`), { force: true });
    throw err;
  }
  orgs.setActive(org.id);
  audit({ actor: "owner", actorName: "You", kind: "organization", action: `Imported the organization ${unique}`, detail: `${positions.length} positions, ${groups.length} groups${bring.size ? `; added ${bring.size} agents` : ""}${kept.length ? `; kept your own ${kept.join(", ")}` : ""}` });
  return { org: orgs.active(), added: [...bring.keys()], kept };
}

// The audit log: a record of every operation, kept on this computer. What the
// owner does in the app (each change they make), and what each agent does
// (each tool it uses, each approval it asks for, each failure, what a run cost).
// Lines are only ever added; a file over 10 MB is kept as audit-1.log and a new
// one is started. Secrets are never written: anything that looks like a key,
// token or password is replaced before the line is saved.
import fs from "node:fs";
import path from "node:path";
import { DATA } from "./store.ts";

export interface AuditEntry {
  at: string;
  /** "owner" for the person, an agent's id, "system" for the app itself. */
  actor: string;
  /** The agent's job title, or "You". */
  actorName: string;
  /** A short kind for filtering: task, tool, approval, problem, spend, settings, library, integration, organization, inbox, chat, other. */
  kind: string;
  /** What happened, in plain words. */
  action: string;
  /** More detail: the command run, the file touched, the setting changed. Never a secret. */
  detail?: string;
  /** The task or chat it belongs to. */
  task?: string;
  /** Dollars, where the operation cost money. */
  cost?: number;
  /** Whether it worked. */
  ok?: boolean;
}

const MAX_BYTES = 10_000_000;
const file = () => path.join(DATA, "audit.log");
const SECRET_KEYS = /key|token|secret|password|passwd|credential|authorization|cookie|code_verifier|^code$|^value$/i;

/** A copy of something with secrets hidden and long text shortened, fit for the log. */
export function redact(value: unknown, depth = 0): unknown {
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return value.length > 400 ? `${value.slice(0, 400)}…` : value.replace(/\b(sk-[a-z]{2,4}-[\w-]{8,}|gh[pousr]_[\w]{12,}|github_pat_[\w]{12,})\b/gi, "[hidden]");
  if (depth > 3) return "…";
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 30)) out[k] = SECRET_KEYS.test(k) && v !== "" && v != null && typeof v !== "boolean" ? "[hidden]" : redact(v, depth + 1);
    return out;
  }
  return String(value);
}

/** Adds one line to the log. Never throws: a full disk must not stop the work being recorded. */
export function audit(entry: Omit<AuditEntry, "at"> & { at?: string }) {
  try {
    fs.mkdirSync(DATA, { recursive: true });
    const line = JSON.stringify({ at: new Date().toISOString(), ...entry, detail: entry.detail ? String(redact(entry.detail)) : undefined });
    try {
      if (fs.statSync(file()).size > MAX_BYTES) fs.renameSync(file(), path.join(DATA, "audit-1.log"));
    } catch {}
    fs.appendFileSync(file(), `${line}\n`);
  } catch (err) {
    console.error("The audit log could not be written:", (err as Error).message);
  }
}

/** Entries, newest first, filtered by who, kind, words and time. */
export function readAudit({ limit = 500, actor, kind, q, since }: { limit?: number; actor?: string; kind?: string; q?: string; since?: string } = {}): { entries: AuditEntry[]; total: number } {
  const lines: string[] = [];
  for (const name of ["audit-1.log", "audit.log"]) {
    try {
      lines.push(...fs.readFileSync(path.join(DATA, name), "utf8").split("\n").filter(Boolean));
    } catch {}
  }
  const words = String(q ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const out: AuditEntry[] = [];
  let total = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    let e: AuditEntry;
    try {
      e = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (since && e.at < since) continue;
    if (actor && (actor === "agents" ? e.actor === "owner" || e.actor === "system" : e.actor !== actor)) continue;
    if (kind && (kind === "problem" ? e.ok !== false && e.kind !== "problem" : e.kind !== kind)) continue;
    if (words.length) {
      const text = `${e.actorName} ${e.action} ${e.detail ?? ""} ${e.kind}`.toLowerCase();
      if (!words.every((w) => text.includes(w))) continue;
    }
    total++;
    if (out.length < Math.min(5000, limit)) out.push(e);
  }
  return { entries: out, total };
}

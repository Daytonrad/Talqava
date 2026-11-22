// Scheduled jobs: "every 30m", "at 2026-12-01T09:00", or a 5-field cron line.
// Times are in the local time zone of the machine the agent runs on.
import crypto from "node:crypto";
import type { Job, JobStore } from "./types.ts";

const UNITS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };
const CRON_RANGES: [number, number][] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 6],
];

type Schedule =
  | { kind: "interval"; ms: number }
  | { kind: "once"; when: Date }
  | { kind: "cron"; sets: Set<number>[]; domAny: boolean; dowAny: boolean };

function parseCronField(field: string, [min, max]: [number, number]): Set<number> {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!match) throw new Error(`Bad cron field "${field}"`);
    const step = match[2] ? Number(match[2]) : 1;
    let [lo, hi]: (number | undefined)[] = match[1] === "*" ? [min, max] : match[1].split("-").map(Number);
    if (hi === undefined) hi = match[2] ? max : lo;
    if (max === 6 && lo === 7) lo = 0; // Sunday may be written as 7
    if (max === 6 && hi === 7) hi = lo === 0 ? 0 : 6;
    if (step < 1 || lo! < min || hi! > max || lo! > hi!) throw new Error(`Bad cron field "${field}"`);
    for (let v = lo!; v <= hi!; v += step) values.add(v);
  }
  return values;
}

export function parseSchedule(text: string): Schedule {
  const s = String(text).trim();
  let match = /^every\s+(\d+)\s*(m|h|d)\w*$/i.exec(s);
  if (match) {
    const ms = Number(match[1]) * UNITS[match[2].toLowerCase()];
    if (ms < 60_000) throw new Error("The shortest interval is 1 minute.");
    return { kind: "interval", ms };
  }
  match = /^at\s+(.+)$/i.exec(s);
  if (match) {
    const when = new Date(match[1]);
    if (Number.isNaN(when.getTime())) throw new Error(`Could not read the date "${match[1]}".`);
    return { kind: "once", when };
  }
  const fields = s.split(/\s+/);
  if (fields.length === 5) {
    const sets = fields.map((f, i) => parseCronField(f, CRON_RANGES[i]));
    return { kind: "cron", sets, domAny: fields[2] === "*", dowAny: fields[4] === "*" };
  }
  throw new Error(
    'Schedule must be "every 30m" / "every 2h" / "every 1d", "at 2026-12-01T09:00", or a 5-field cron line such as "0 9 * * 1-5".',
  );
}

/** The next time a schedule fires strictly after `after`, or null if it never will. */
export function nextRun(text: string, after = new Date()): Date | null {
  const sched = parseSchedule(text);
  if (sched.kind === "interval") return new Date(after.getTime() + sched.ms);
  if (sched.kind === "once") return sched.when > after ? sched.when : null;

  const [minutes, hours, doms, months, dows] = sched.sets;
  const t = new Date(after);
  t.setSeconds(0, 0);
  t.setMinutes(t.getMinutes() + 1);
  const limit = after.getTime() + 366 * UNITS.d * 4;
  while (t.getTime() < limit) {
    if (!months.has(t.getMonth() + 1)) {
      t.setMonth(t.getMonth() + 1, 1);
      t.setHours(0, 0, 0, 0);
      continue;
    }
    const domOk = doms.has(t.getDate());
    const dowOk = dows.has(t.getDay());
    // Standard cron: when both day fields are restricted, either may match.
    const dayOk = sched.domAny || sched.dowAny ? domOk && dowOk : domOk || dowOk;
    if (!dayOk) {
      t.setDate(t.getDate() + 1);
      t.setHours(0, 0, 0, 0);
      continue;
    }
    if (!hours.has(t.getHours())) {
      t.setHours(t.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!minutes.has(t.getMinutes())) {
      t.setMinutes(t.getMinutes() + 1);
      continue;
    }
    return t;
  }
  return null;
}

/** Scheduled jobs on top of whatever store the edition provides. */
export class JobBook {
  #store: JobStore;

  constructor(store: JobStore) {
    this.#store = store;
  }

  list() {
    return this.#store.list();
  }

  async create(input: { name?: string; prompt?: string; schedule?: string }): Promise<Job> {
    const name = String(input.name || "").trim();
    const prompt = String(input.prompt || "").trim();
    if (!name || !prompt) throw new Error("A scheduled job needs a name and a prompt.");
    const next = nextRun(String(input.schedule ?? ""));
    if (!next) throw new Error("That time is already in the past.");
    const job: Job = {
      id: crypto.randomBytes(8).toString("hex"),
      name,
      prompt,
      schedule: String(input.schedule).trim(),
      enabled: true,
      createdAt: new Date().toISOString(),
      nextRunAt: next.toISOString(),
      lastRunAt: null,
      lastConversationId: null,
    };
    await this.#store.saveAll([...(await this.#store.list()), job]);
    return job;
  }

  async update(id: string, patch: Partial<Job>): Promise<Job> {
    const jobs = await this.#store.list();
    const job = jobs.find((j) => j.id === id);
    if (!job) throw new Error(`No scheduled job with id ${id}.`);
    Object.assign(job, patch);
    if (patch.enabled === true) {
      const next = nextRun(job.schedule);
      if (!next) throw new Error("That one-time job has already passed.");
      job.nextRunAt = next.toISOString();
    }
    await this.#store.saveAll(jobs);
    return job;
  }

  async remove(id: string) {
    const jobs = await this.#store.list();
    if (!jobs.some((j) => j.id === id)) throw new Error(`No scheduled job with id ${id}.`);
    await this.#store.saveAll(jobs.filter((j) => j.id !== id));
  }

  /** Marks due jobs as fired, moves them to their next time, and returns them. */
  async takeDue(now = new Date()): Promise<Job[]> {
    const jobs = await this.#store.list();
    const due = jobs.filter((j) => j.enabled && j.nextRunAt && new Date(j.nextRunAt) <= now);
    if (!due.length) return [];
    for (const job of due) {
      const next = nextRun(job.schedule, now);
      job.lastRunAt = now.toISOString();
      job.nextRunAt = next ? next.toISOString() : null;
      if (!next) job.enabled = false; // a one-time job that has now run
    }
    await this.#store.saveAll(jobs);
    return due;
  }

  /** Checks for due jobs now and then every `intervalMs`. */
  start(runJob: (job: Job) => Promise<unknown>, intervalMs = 20_000): NodeJS.Timeout {
    const tick = async () => {
      try {
        for (const job of await this.takeDue()) {
          runJob(job).catch((err) => console.error(`Scheduled job "${job.name}" failed to start:`, err.message));
        }
      } catch (err) {
        console.error("Could not check scheduled jobs:", err);
      }
    };
    void tick();
    return setInterval(tick, intervalMs);
  }
}

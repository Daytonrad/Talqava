import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "agent-sched-"));
const store = await import("../src/store.js");
const { nextRun, parseSchedule, createJob, takeDueJobs } = await import("../src/scheduler.js");
store.initStore();

const at = (text) => new Date(text);
const local = (date) => `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()} ${date.getHours()}:${String(date.getMinutes()).padStart(2, "0")}`;

test("intervals", () => {
  assert.equal(nextRun("every 30m", at("2026-01-01T10:00:00")).getTime(), at("2026-01-01T10:30:00").getTime());
  assert.equal(nextRun("every 2 hours", at("2026-01-01T10:00:00")).getTime(), at("2026-01-01T12:00:00").getTime());
});

test("cron lines", () => {
  assert.equal(local(nextRun("0 9 * * *", at("2026-01-01T10:00:00"))), "2026-1-2 9:00");
  assert.equal(local(nextRun("*/15 * * * *", at("2026-01-01T10:07:00"))), "2026-1-1 10:15");
  // 2026-01-02 is a Friday; the next weekday 8:30 after Friday 9:00 is Monday.
  assert.equal(local(nextRun("30 8 * * 1-5", at("2026-01-02T09:00:00"))), "2026-1-5 8:30");
  assert.equal(local(nextRun("0 0 1 3 *", at("2026-01-02T09:00:00"))), "2026-3-1 0:00");
  assert.equal(local(nextRun("0 12 * * 0", at("2026-01-02T09:00:00"))), "2026-1-4 12:00");
});

test("one-time and invalid schedules", () => {
  assert.equal(nextRun("at 2030-05-01T09:00", at("2026-01-01T00:00:00")).getFullYear(), 2030);
  assert.equal(nextRun("at 2020-05-01T09:00", at("2026-01-01T00:00:00")), null);
  assert.throws(() => parseSchedule("whenever"), /Schedule must be/);
  assert.throws(() => parseSchedule("61 * * * *"), /Bad cron/);
  assert.throws(() => parseSchedule("every 10s"), /Schedule must be/);
});

test("due jobs fire once and move to their next time", () => {
  const job = createJob({ name: "digest", prompt: "do it", schedule: "every 1h" });
  assert.deepEqual(takeDueJobs(new Date()), []);
  const later = new Date(Date.now() + 2 * 3_600_000);
  assert.equal(takeDueJobs(later)[0].id, job.id);
  assert.deepEqual(takeDueJobs(later), []);
  assert.ok(new Date(store.listJobs()[0].nextRunAt) > later);
});

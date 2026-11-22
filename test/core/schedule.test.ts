import { test } from "node:test";
import assert from "node:assert/strict";
import { JobBook, nextRun, parseSchedule } from "../../src/core/index.ts";
import { MemoryJobs } from "../memory-stores.ts";

const at = (text: string) => new Date(text);
const local = (date: Date | null) =>
  date ? `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()} ${date.getHours()}:${String(date.getMinutes()).padStart(2, "0")}` : "never";

test("intervals", () => {
  assert.equal(nextRun("every 30m", at("2026-01-01T10:00:00"))!.getTime(), at("2026-01-01T10:30:00").getTime());
  assert.equal(nextRun("every 2 hours", at("2026-01-01T10:00:00"))!.getTime(), at("2026-01-01T12:00:00").getTime());
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
  assert.equal(nextRun("at 2030-05-01T09:00", at("2026-01-01T00:00:00"))!.getFullYear(), 2030);
  assert.equal(nextRun("at 2020-05-01T09:00", at("2026-01-01T00:00:00")), null);
  assert.throws(() => parseSchedule("whenever"), /Schedule must be/);
  assert.throws(() => parseSchedule("61 * * * *"), /Bad cron/);
  assert.throws(() => parseSchedule("every 10s"), /Schedule must be/);
});

test("due jobs fire once and move to their next time", async () => {
  const store = new MemoryJobs();
  const jobs = new JobBook(store);
  const job = await jobs.create({ name: "digest", prompt: "do it", schedule: "every 1h" });
  assert.deepEqual(await jobs.takeDue(new Date()), []);
  const later = new Date(Date.now() + 2 * 3_600_000);
  assert.equal((await jobs.takeDue(later))[0].id, job.id);
  assert.deepEqual(await jobs.takeDue(later), []);
  assert.ok(new Date(store.items[0].nextRunAt!) > later);
});

test("jobs can be paused, resumed and removed", async () => {
  const jobs = new JobBook(new MemoryJobs());
  const job = await jobs.create({ name: "digest", prompt: "do it", schedule: "0 9 * * *" });
  assert.equal((await jobs.update(job.id, { enabled: false })).enabled, false);
  assert.equal((await jobs.update(job.id, { enabled: true })).enabled, true);
  await jobs.remove(job.id);
  assert.deepEqual(await jobs.list(), []);
  await assert.rejects(jobs.remove(job.id), /No scheduled job/);
  await assert.rejects(jobs.create({ name: "", prompt: "x", schedule: "every 1h" }), /needs a name/);
});

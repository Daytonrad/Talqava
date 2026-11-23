// Monthly budgets for bots. What each bot's quests cost is added up per calendar
// month in a small ledger; a bot (or all bots together) that reaches its limit
// starts no new work until the limit is raised or the month turns. A warning is
// shown from 80%. Spend is estimated from list prices, as everywhere else.
import path from "node:path";
import type { Bot } from "../core/index.ts";
import { DATA, getConfig, readJson, writeJson } from "./store.ts";

interface Ledger {
  /** Dollars spent by each bot, by month ("2026-11"). */
  months: Record<string, Record<string, number>>;
  /** The cost already counted for each quest, so only what is new is added. */
  seen: Record<string, number>;
}

const file = () => path.join(DATA, "spend.json");
const read = (): Ledger => ({ months: {}, seen: {}, ...readJson<Partial<Ledger>>(file(), {}) });
export const monthKey = (now = new Date()) => `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
export const WARN_AT = 0.8;

/** Counts a quest's cost so far towards its bot's month. Safe to call as often as the cost changes. */
export function recordSpend(questId: string, botId: string, cost: number, now = new Date()) {
  if (!(cost > 0)) return;
  const ledger = read();
  const delta = cost - (ledger.seen[questId] ?? 0);
  if (delta <= 0) return;
  const month = (ledger.months[monthKey(now)] ??= {});
  month[botId] = Math.round(((month[botId] ?? 0) + delta) * 1e6) / 1e6;
  ledger.seen[questId] = cost;
  // Only the latest quests need remembering, and the last year of months.
  ledger.seen = Object.fromEntries(Object.entries(ledger.seen).slice(-1000));
  ledger.months = Object.fromEntries(Object.entries(ledger.months).sort().slice(-12));
  writeJson(file(), ledger);
}

export type BudgetState = "ok" | "warned" | "stopped";
export interface BudgetLine {
  spent: number;
  /** The limit in dollars, or null for none. */
  limit: number | null;
  state: BudgetState;
}

const line = (spent: number, limit: number | undefined | null): BudgetLine => ({
  spent,
  limit: limit ?? null,
  state: limit == null ? "ok" : spent >= limit ? "stopped" : spent >= limit * WARN_AT ? "warned" : "ok",
});

/** This month's spending: all bots together, and each bot. */
export function monthlyBudgets(bots: Bot[], now = new Date()): { month: string; resets: string; total: BudgetLine; bots: Record<string, BudgetLine> } {
  const month = read().months[monthKey(now)] ?? {};
  const total = Object.values(month).reduce((sum, n) => sum + n, 0);
  const resets = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return {
    month: monthKey(now),
    resets: `${resets.getFullYear()}-${String(resets.getMonth() + 1).padStart(2, "0")}-01`,
    total: line(total, getConfig().monthlyBudget),
    bots: Object.fromEntries(bots.map((bot) => [bot.id, line(month[bot.id] ?? 0, bot.monthly)])),
  };
}

const dollars = (n: number) => "$" + n.toFixed(2);

/** Why this bot may not start work now, or null if it may. */
export function budgetBlock(bot: Bot, now = new Date()): string | null {
  const budgets = monthlyBudgets([bot], now);
  const own = budgets.bots[bot.id];
  if (own.state === "stopped") return `${bot.name} has reached its monthly budget (${dollars(own.spent)} of ${dollars(own.limit!)}). Raise it on the bot's page, or wait until ${budgets.resets}.`;
  if (budgets.total.state === "stopped") return `Your bots have reached the monthly budget for all bots (${dollars(budgets.total.spent)} of ${dollars(budgets.total.limit!)}). Raise it on the team page, or wait until ${budgets.resets}.`;
  return null;
}

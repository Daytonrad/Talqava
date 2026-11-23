// Checking a quest's result. A bot does not get to say it is done: the app
// looks at what it actually did. A failed check goes back to the bot to fix.
import { spawn } from "node:child_process";
import { clip, BRAND } from "../core/index.ts";
import type { Conversation } from "../core/index.ts";
import { changes } from "./git.ts";
import type { QuestCopy } from "./git.ts";
import type { QuestCheck } from "./templates.ts";
import { fill } from "./templates.ts";

export interface CheckItem {
  label: string;
  passed: boolean;
  detail?: string;
}

export interface CheckResult {
  passed: boolean;
  items: CheckItem[];
  at: string;
}

export interface CheckContext {
  check: QuestCheck;
  conversation: Conversation;
  copy?: QuestCopy;
  /** Where a command check runs when the quest has no copy of a repository. */
  workspace: string;
  inputs: Record<string, string>;
  mustMention: string[];
  /** How long a command may run. */
  timeoutMs?: number;
}

/** Everything the bot wrote to the user in this quest. */
export function replyText(conversation: Conversation): string {
  return conversation.messages
    .filter((m) => m.role === "assistant" && Array.isArray(m.content))
    .flatMap((m) => (m.content as { type: string; text?: string }[]).filter((b) => b.type === "text").map((b) => b.text ?? ""))
    .join("\n");
}

/** Distinct sources linked in a text: the same page linked twice counts once. */
export function linkedSources(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/https?:\/\/[^\s)\]>"'`]+/g)) {
    try {
      const url = new URL(match[0].replace(/[.,;:!?]+$/, ""));
      found.add(`${url.hostname.replace(/^www\./, "")}${url.pathname.replace(/\/$/, "")}`);
    } catch {}
  }
  return [...found];
}

/** Which of the items a text leaves out. Issue numbers must match exactly (#12 is not #120). */
export function missingFrom(text: string, items: string[]): string[] {
  const lower = text.toLowerCase();
  return items.filter((item) => {
    if (/^#\d+$/.test(item)) return !new RegExp(`${item}(?!\\d)`).test(text);
    return !lower.includes(item.toLowerCase());
  });
}

function runCommand(command: string, cwd: string, timeoutMs: number): Promise<{ code: number | null; output: string }> {
  // Like the shell tool: no app keys or password in the environment.
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (new RegExp(`^(ANTHROPIC_|${BRAND.envPrefix}PASSWORD)`).test(key)) delete env[key];
  // The command runs on its own, not as part of whatever test run started the app.
  delete env.NODE_TEST_CONTEXT;
  return new Promise((resolve) => {
    const child = spawn("bash", ["-c", command], { cwd, env, detached: true });
    let output = "";
    const collect = (chunk: Buffer) => {
      if (output.length < 200_000) output += chunk;
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = setTimeout(() => {
      output += `\n[stopped: ran longer than ${Math.round(timeoutMs / 1000)} seconds]`;
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {}
    }, timeoutMs);
    child.on("error", (err) => (output += `\n[could not start: ${err.message}]`));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

export async function runChecks(ctx: CheckContext): Promise<CheckResult> {
  const { check } = ctx;
  const items: CheckItem[] = [];
  const reply = replyText(ctx.conversation);
  const changed = ctx.copy ? await changes(ctx.copy) : null;
  // What the bot produced: its reply plus every line it added to a file.
  const added = changed ? changed.diff.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).join("\n") : "";

  if (check.changed) {
    const files = changed?.files.map((f) => f.path) ?? [];
    const passed = check.changed === "any" ? files.length > 0 : files.includes(check.changed);
    items.push({
      label: check.changed === "any" ? "Changed files" : `Changed ${check.changed}`,
      passed,
      detail: passed ? files.join(", ") : changed ? `Changed: ${files.join(", ") || "nothing"}.` : "The quest had no repository to change.",
    });
  }
  if (check.covers) {
    const missing = missingFrom(`${reply}\n${added}`, ctx.mustMention);
    items.push({
      label: `Covers all ${ctx.mustMention.length} gathered item${ctx.mustMention.length === 1 ? "" : "s"}`,
      passed: missing.length === 0,
      detail: missing.length ? `Missing: ${missing.slice(0, 15).join(", ")}${missing.length > 15 ? ` and ${missing.length - 15} more` : ""}.` : undefined,
    });
  }
  if (check.links) {
    const sources = linkedSources(reply);
    items.push({
      label: `Cites at least ${check.links} sources`,
      passed: sources.length >= check.links,
      detail: `${sources.length} found${sources.length ? `: ${sources.slice(0, 6).join(", ")}` : ""}.`,
    });
  }
  // The command runs last, after the other checks have looked at the files.
  if (check.command) {
    const command = fill(check.command, ctx.inputs);
    const { code, output } = await runCommand(command, ctx.copy?.worktree ?? ctx.workspace, ctx.timeoutMs ?? 600_000);
    items.push({
      label: `\`${command}\` passes`,
      passed: code === 0,
      detail: clip(output.trim().split("\n").slice(-25).join("\n") || `exit code ${code}`, 3_000),
    });
  }
  return { passed: items.every((i) => i.passed), items, at: new Date().toISOString() };
}

/** What the bot is told when its check fails, so it fixes the work instead of stopping. */
export function feedback(result: CheckResult, triesLeft: number): string {
  const failed = result.items.filter((i) => !i.passed);
  return [
    "[The quest's check failed, so it is not done yet.]",
    ...failed.map((i) => `- ${i.label}: failed.${i.detail ? `\n${i.detail}` : ""}`),
    "",
    `Fix what failed, then finish again. Do not say the quest is done until the check passes. ${triesLeft === 1 ? "This is the last try." : `There are ${triesLeft} tries left.`} If it cannot pass, explain exactly why.`,
  ].join("\n");
}

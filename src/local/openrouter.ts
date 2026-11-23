// The OpenRouter integration: one account that reaches hundreds of models from
// many companies (Claude, GPT, Gemini, Llama, DeepSeek, Qwen and more), paid
// for from one balance. The person connects through openrouter.ai in their
// browser; OpenRouter hands back a key for this app, and nothing has to be
// copied by hand. Models are then chosen from a list that shows what each costs.
//
// Sign-in uses OpenRouter's OAuth with PKCE: the app makes a secret, sends only
// its fingerprint to openrouter.ai, and OpenRouter returns a one-time code to
// this app's own address on this computer, which is traded for the key along
// with the secret. Codes expire after ten minutes and work once.
import crypto from "node:crypto";
import path from "node:path";
import type { Prices } from "../core/index.ts";
import { DATA, getConfig, readJson, saveConfig, writeJson } from "./store.ts";
import type { ProviderConfig } from "./store.ts";
import type { IntegrationInfo } from "./integrations.ts";

export const OPENROUTER_ID = "openrouter";
/** Where OpenRouter's API is. Tests point it at a stand-in. */
export const openrouterApi = () => (process.env.TALQAVA_OPENROUTER_API || "https://openrouter.ai/api/v1").replace(/\/+$/, "");
const authPage = () => process.env.TALQAVA_OPENROUTER_AUTH || "https://openrouter.ai/auth";

/** Sent with every request so OpenRouter can show which app the usage came from. */
export const ATTRIBUTION = { "HTTP-Referer": "https://talqava.com", "X-OpenRouter-Title": "Talqava", "X-Title": "Talqava" };

/** One model on OpenRouter that can use tools (agents need tools to work). */
export interface OpenRouterModel {
  id: string;
  name: string;
  /** Dollars per million tokens. */
  prices: Prices;
  contextTokens: number;
  free: boolean;
}

// ---------- the list of models ----------
const catalogFile = () => path.join(DATA, "openrouter-models.json");
interface Catalog {
  fetchedAt: string;
  models: OpenRouterModel[];
}
const DAY = 24 * 3600 * 1000;

/** Prices on OpenRouter are dollars per token, as text; the app keeps dollars per million tokens. */
const perMillion = (value: unknown) => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 1_000_000 * 1e6) / 1e6 : null;
};

export function toCatalog(data: unknown): OpenRouterModel[] {
  const rows = (data as { data?: unknown[] })?.data ?? [];
  const models: OpenRouterModel[] = [];
  for (const row of rows as Record<string, any>[]) {
    if (typeof row?.id !== "string") continue;
    // ":batch" versions answer hours later in bulk, which does not suit an agent at work.
    if (row.id.endsWith(":batch")) continue;
    // Agents work through tools, so a model that cannot call them is left out.
    if (Array.isArray(row.supported_parameters) && !row.supported_parameters.includes("tools")) continue;
    const input = perMillion(row.pricing?.prompt);
    const output = perMillion(row.pricing?.completion);
    // "-1" marks a router whose price depends on the model it picks: its cost is not known in advance.
    if (input === null || output === null) continue;
    const cacheRead = perMillion(row.pricing?.input_cache_read);
    const cacheWrite = perMillion(row.pricing?.input_cache_write);
    models.push({
      id: row.id,
      name: typeof row.name === "string" ? row.name : row.id,
      prices: { input, output, ...(cacheRead !== null && cacheRead > 0 ? { cacheRead } : {}), ...(cacheWrite !== null && cacheWrite > 0 ? { cacheWrite } : {}) },
      contextTokens: Number(row.context_length ?? row.top_provider?.context_length) || 32_000,
      free: input === 0 && output === 0,
    });
  }
  return models.sort((a, b) => a.name.localeCompare(b.name));
}

/** The models, from the copy kept on this computer (refreshed once a day) or from OpenRouter. */
export async function openrouterModels(refresh = false): Promise<OpenRouterModel[]> {
  const kept = readJson<Catalog | null>(catalogFile(), null);
  // Batch-only versions are dropped here too, in case the kept list is from before they were left out.
  if (kept) kept.models = kept.models.filter((m) => !m.id.endsWith(":batch"));
  if (kept && !refresh && Date.now() - new Date(kept.fetchedAt).getTime() < DAY) return kept.models;
  try {
    const r = await fetch(`${openrouterApi()}/models?supported_parameters=tools`, { headers: ATTRIBUTION, signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new Error(`OpenRouter answered ${r.status}.`);
    const models = toCatalog(await r.json());
    if (models.length) writeJson(catalogFile(), { fetchedAt: new Date().toISOString(), models } satisfies Catalog);
    return models.length ? models : (kept?.models ?? []);
  } catch (err) {
    if (kept) return kept.models;
    throw new Error(`OpenRouter's list of models could not be loaded: ${(err as Error).message}`);
  }
}

/** What is known about one model without asking OpenRouter: its prices and size, from the kept list. */
export function openrouterModelInfo(id: string): OpenRouterModel | undefined {
  return readJson<Catalog | null>(catalogFile(), null)?.models.find((m) => m.id === id);
}

// ---------- signing in through openrouter.ai ----------
const pending = new Map<string, { verifier: string; callback: string; at: number }>();
const base64url = (buffer: Buffer) => buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/**
 * Starts a sign-in. `appAddress` is where this app is open (e.g. http://localhost:8788);
 * OpenRouter sends the person back there once they have approved.
 */
export function startOpenRouterSignIn(appAddress: string): { url: string } {
  const app = new URL(appAddress);
  // OpenRouter accepts a callback to localhost on any port. 127.0.0.1 is the same computer under another name.
  if (app.hostname === "127.0.0.1" || app.hostname === "[::1]") app.hostname = "localhost";
  const verifier = base64url(crypto.randomBytes(48));
  const state = base64url(crypto.randomBytes(24));
  const callback = `${app.origin}/api/integrations/openrouter/callback`;
  for (const [key, value] of pending) if (Date.now() - value.at > 10 * 60_000) pending.delete(key);
  pending.set(state, { verifier, callback, at: Date.now() });
  const url = new URL(authPage());
  url.searchParams.set("callback_url", callback);
  url.searchParams.set("code_challenge", base64url(crypto.createHash("sha256").update(verifier).digest()));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("key_label", "Talqava");
  return { url: url.href };
}

/** Finishes a sign-in: trades the one-time code for a key and saves it. */
export async function finishOpenRouterSignIn(code: unknown, state: unknown): Promise<void> {
  const started = typeof state === "string" ? pending.get(state) : undefined;
  if (!started || Date.now() - started.at > 10 * 60_000) throw new Error("This sign-in has expired or was already used. Go back to Talqava and press Connect OpenRouter again.");
  pending.delete(state as string);
  if (typeof code !== "string" || !code) throw new Error("OpenRouter did not send a code back. The sign-in may have been cancelled.");
  const r = await fetch(`${openrouterApi()}/auth/keys`, {
    method: "POST",
    headers: { "content-type": "application/json", ...ATTRIBUTION },
    body: JSON.stringify({ code, code_verifier: started.verifier, code_challenge_method: "S256" }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) throw new Error(r.status === 403 ? "OpenRouter refused the sign-in code (it may have expired). Press Connect OpenRouter again." : `OpenRouter answered ${r.status} when finishing the sign-in.`);
  const { key } = (await r.json()) as { key?: string };
  if (!key) throw new Error("OpenRouter did not send a key back.");
  saveKey(key);
  await openrouterModels(true).catch(() => []);
}

/** For people who already have a key from openrouter.ai/keys: checks it works, then saves it. */
export async function saveOpenRouterKey(key: unknown): Promise<void> {
  const value = String(key ?? "").trim();
  if (!/^sk-or-[\w-]{10,}$/.test(value)) throw new Error("An OpenRouter key starts with sk-or-. Copy it from openrouter.ai/keys.");
  const r = await fetch(`${openrouterApi()}/key`, { headers: { authorization: `Bearer ${value}`, ...ATTRIBUTION }, signal: AbortSignal.timeout(15_000) }).catch(() => null);
  if (r && (r.status === 401 || r.status === 403)) throw new Error("OpenRouter did not accept that key. Check it at openrouter.ai/keys.");
  saveKey(value);
  await openrouterModels(true).catch(() => []);
}

function saveKey(key: string) {
  const cfg = getConfig();
  const existing = cfg.providers.find((p) => p.id === OPENROUTER_ID);
  const provider: ProviderConfig = { ...existing, id: OPENROUTER_ID, kind: "openai", name: "OpenRouter", baseUrl: openrouterApi(), apiKey: key };
  saveConfig({ providers: [...cfg.providers.filter((p) => p.id !== OPENROUTER_ID), provider] });
}

const keyOf = () => getConfig().providers.find((p) => p.id === OPENROUTER_ID)?.apiKey ?? "";

/** The account behind the key: what it has spent and any limit on it, when OpenRouter says. */
async function account(): Promise<{ label?: string; usage?: number; limit?: number | null; remaining?: number | null; freeTier?: boolean; keyWorks: boolean } | null> {
  const key = keyOf();
  if (!key) return null;
  try {
    const r = await fetch(`${openrouterApi()}/key`, { headers: { authorization: `Bearer ${key}`, ...ATTRIBUTION }, signal: AbortSignal.timeout(8000) });
    if (r.status === 401 || r.status === 403) return { keyWorks: false };
    if (!r.ok) return { keyWorks: true };
    const data = ((await r.json()) as { data?: Record<string, any> }).data ?? {};
    return {
      keyWorks: true,
      label: typeof data.label === "string" ? data.label : undefined,
      usage: typeof data.usage === "number" ? data.usage : undefined,
      limit: typeof data.limit === "number" ? data.limit : null,
      remaining: typeof data.limit_remaining === "number" ? data.limit_remaining : null,
      freeTier: typeof data.is_free_tier === "boolean" ? data.is_free_tier : undefined,
    };
  } catch {
    return { keyWorks: true };
  }
}

/** Good starting choices, by what they are for. Only those OpenRouter lists are shown. */
const SUGGESTED: [string, string][] = [
  ["anthropic/claude-opus-5.5", "Claude's strongest model, for managers and complex work"],
  ["anthropic/claude-sonnet-5.5", "Claude, strong and about half the price of Opus"],
  ["anthropic/claude-haiku-5.5", "Claude's fastest and cheapest, for routine work"],
  ["openai/gpt-5.6-sol", "OpenAI, priced like Claude Sonnet"],
  ["openai/gpt-5.6-luna", "OpenAI, low cost"],
  ["google/gemini-4-carbon", "Google, priced like Claude Sonnet"],
  ["deepseek/deepseek-v4-pro", "DeepSeek, low cost"],
  ["qwen/qwen3-coder", "Qwen, low cost, made for code"],
  ["meta-llama/llama-4-maverick", "Meta's open model, low cost"],
];

/** Where the integration stands. The list of integrations skips asking OpenRouter about the account, to stay quick. */
export async function openrouterIntegration({ withAccount = true } = {}) {
  const cfg = getConfig();
  const connected = Boolean(keyOf());
  const [models, who] = await Promise.all([connected ? openrouterModels().catch(() => [] as OpenRouterModel[]) : Promise.resolve([] as OpenRouterModel[]), withAccount ? account() : Promise.resolve(null)]);
  const ids = new Set(models.map((m) => m.id));
  const using = cfg.model.startsWith(`${OPENROUTER_ID}/`) ? cfg.model.slice(OPENROUTER_ID.length + 1) : null;
  const info: IntegrationInfo = {
    id: OPENROUTER_ID,
    name: "OpenRouter",
    category: "AI models",
    summary: "One account for hundreds of AI models from many companies, such as Claude, GPT, Gemini, Llama and DeepSeek, paid for from one balance. Choose a model for your whole team or for one agent, and see what each costs before you choose.",
    state: !connected ? "needs-setup" : who && !who.keyWorks ? "needs-setup" : "connected",
    status: !connected ? "Connect your OpenRouter account" : who && !who.keyWorks ? "The saved key no longer works: connect again" : using ? `Your team uses ${models.find((m) => m.id === using)?.name ?? using}` : `${models.length} models ready to choose`,
  };
  return {
    ...info,
    connected,
    account: who,
    using,
    models,
    suggested: SUGGESTED.filter(([id]) => ids.has(id)).map(([id, why]) => ({ id, why })),
    fetchedAt: readJson<Catalog | null>(catalogFile(), null)?.fetchedAt ?? null,
  };
}

/** Uses an OpenRouter model as the main model, for every agent that has not been given one of its own. */
export async function useOpenRouterModel(model: unknown): Promise<{ model: string }> {
  if (!keyOf()) throw new Error("Connect OpenRouter first.");
  const id = String(model ?? "").trim();
  if (!/^[\w.:@/+-]{1,120}$/.test(id)) throw new Error("Choose a model from the list.");
  const models = await openrouterModels().catch(() => []);
  if (models.length && !models.some((m) => m.id === id)) throw new Error(`OpenRouter does not list ${id} as a model that can use tools.`);
  saveConfig({ model: `${OPENROUTER_ID}/${id}` });
  return { model: `${OPENROUTER_ID}/${id}` };
}

/** Disconnects OpenRouter. If the team was using one of its models, it goes back to Claude. */
export function removeOpenRouter(): { model: string } {
  const cfg = getConfig();
  const model = cfg.model.startsWith(`${OPENROUTER_ID}/`) ? "anthropic/claude-opus-5-5" : cfg.model;
  saveConfig({ model, providers: cfg.providers.filter((p) => p.id !== OPENROUTER_ID) });
  return { model };
}

// Everything the agent remembers lives in plain JSON files under data/.
import "./env.js";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DATA = path.resolve(process.env.AGENT_DATA_DIR || path.join(ROOT, "data"));
export const WORKSPACE = path.resolve(process.env.AGENT_WORKSPACE || path.join(DATA, "workspace"));
const CONV_DIR = path.join(DATA, "conversations");

export const MODELS = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5 (recommended)" },
  { id: "claude-fable-5-2", label: "Claude Fable 5.2 (most capable, costs more)" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5 (faster, cheaper)" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5 (fastest, cheapest)" },
];
export const EFFORTS = ["low", "medium", "high", "xhigh"];
export const MEMORY_LIMIT = 8000; // characters across all memory entries

export function initStore() {
  for (const dir of [DATA, WORKSPACE, CONV_DIR]) fs.mkdirSync(dir, { recursive: true });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return fallback;
    throw new Error(`Could not read ${file}: ${err.message}`);
  }
}

function writeJson(file, value, mode = 0o600) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode });
  fs.renameSync(tmp, file);
}

export const newId = () => crypto.randomBytes(8).toString("hex");

// ---------- settings ----------
const CONFIG_FILE = () => path.join(DATA, "config.json");
const DEFAULTS = {
  agentName: "Agent",
  model: "claude-opus-5-5",
  effort: "high",
  approvalMode: "ask", // "ask": confirm risky actions. "auto": run everything.
  apiKey: "",
  mcpServers: [], // [{ name, url, token }]
  secrets: {}, // { NAME: { value, host } }
  sessionSecret: "",
};

export function getConfig() {
  const cfg = { ...DEFAULTS, ...readJson(CONFIG_FILE(), {}) };
  if (!cfg.sessionSecret) {
    cfg.sessionSecret = crypto.randomBytes(32).toString("hex");
    writeJson(CONFIG_FILE(), cfg);
  }
  return cfg;
}

export function saveConfig(patch) {
  const cfg = { ...getConfig(), ...patch };
  writeJson(CONFIG_FILE(), cfg);
  return cfg;
}

export const apiKey = (cfg = getConfig()) => cfg.apiKey || process.env.ANTHROPIC_API_KEY || "";

// What the browser is allowed to see: never the key, secret values or tokens.
export function publicConfig() {
  const cfg = getConfig();
  return {
    agentName: cfg.agentName,
    model: cfg.model,
    effort: cfg.effort,
    approvalMode: cfg.approvalMode,
    hasApiKey: Boolean(apiKey(cfg)),
    apiKeyFromEnv: !cfg.apiKey && Boolean(process.env.ANTHROPIC_API_KEY),
    mcpServers: cfg.mcpServers.map((s) => ({ name: s.name, url: s.url, hasToken: Boolean(s.token) })),
    secrets: Object.entries(cfg.secrets).map(([name, s]) => ({ name, host: s.host })),
    models: MODELS,
    efforts: EFFORTS,
    workspace: WORKSPACE,
  };
}

// ---------- conversations ----------
const convFile = (id) => {
  if (!/^[a-f0-9]{16}$/.test(id)) throw new Error("Bad conversation id");
  return path.join(CONV_DIR, `${id}.json`);
};

export function createConversation(extra = {}) {
  const now = new Date().toISOString();
  const conv = {
    id: newId(),
    title: "New chat",
    createdAt: now,
    updatedAt: now,
    source: "chat",
    messages: [],
    allowed: [], // tools the user chose "always allow" for in this chat
    usage: { input: 0, output: 0 },
    ...extra,
  };
  saveConversation(conv);
  return conv;
}

export const getConversation = (id) => readJson(convFile(id), null);

export function saveConversation(conv) {
  conv.updatedAt = new Date().toISOString();
  writeJson(convFile(conv.id), conv);
}

export function deleteConversation(id) {
  fs.rmSync(convFile(id), { force: true });
}

export function listConversations() {
  return fs
    .readdirSync(CONV_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => readJson(path.join(CONV_DIR, f), null))
    .filter(Boolean)
    .map(({ id, title, createdAt, updatedAt, source }) => ({ id, title, createdAt, updatedAt, source }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

// Plain text of a message, for search and titles.
export function messageText(message) {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

export function searchConversations(query, limit = 8) {
  const needle = query.toLowerCase();
  const hits = [];
  for (const meta of listConversations()) {
    const conv = getConversation(meta.id);
    for (const message of conv.messages) {
      const text = messageText(message);
      const at = text.toLowerCase().indexOf(needle);
      if (at === -1) continue;
      hits.push({
        conversation: conv.title,
        date: conv.updatedAt.slice(0, 10),
        role: message.role,
        excerpt: text.slice(Math.max(0, at - 200), at + 400),
      });
      if (hits.length >= limit) return hits;
    }
  }
  return hits;
}

// ---------- memory ----------
const MEMORY_FILE = () => path.join(DATA, "memory.json");
export const listMemory = () => readJson(MEMORY_FILE(), []);
const memorySize = (entries) => entries.reduce((n, e) => n + e.text.length, 0);

export function addMemory(text) {
  const entries = listMemory();
  text = String(text).trim();
  if (!text) throw new Error("Nothing to remember.");
  if (memorySize(entries) + text.length > MEMORY_LIMIT) {
    throw new Error(
      `Memory is full (${MEMORY_LIMIT} characters). Remove or merge older entries first, then try again.`,
    );
  }
  const entry = { id: newId(), text, createdAt: new Date().toISOString() };
  writeJson(MEMORY_FILE(), [...entries, entry]);
  return entry;
}

export function removeMemory(id) {
  const entries = listMemory();
  const rest = entries.filter((e) => e.id !== id);
  if (rest.length === entries.length) throw new Error(`No memory entry with id ${id}.`);
  writeJson(MEMORY_FILE(), rest);
}

// ---------- skills (procedures the agent wrote down for itself) ----------
const SKILLS_FILE = () => path.join(DATA, "skills.json");
export const listSkills = () => readJson(SKILLS_FILE(), []);

export function saveSkill({ name, description, content }) {
  name = String(name).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (!name) throw new Error("A skill needs a name.");
  const skill = { name, description: String(description).trim(), content: String(content), updatedAt: new Date().toISOString() };
  writeJson(SKILLS_FILE(), [...listSkills().filter((s) => s.name !== name), skill]);
  return skill;
}

export function removeSkill(name) {
  writeJson(SKILLS_FILE(), listSkills().filter((s) => s.name !== name));
}

// ---------- scheduled jobs ----------
const JOBS_FILE = () => path.join(DATA, "jobs.json");
export const listJobs = () => readJson(JOBS_FILE(), []);
export const saveJobs = (jobs) => writeJson(JOBS_FILE(), jobs);

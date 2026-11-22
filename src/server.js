// Web server: serves the chat page and the small JSON API behind it.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  ROOT,
  DATA,
  WORKSPACE,
  MODELS,
  EFFORTS,
  initStore,
  getConfig,
  saveConfig,
  publicConfig,
  createConversation,
  getConversation,
  deleteConversation,
  listConversations,
  listMemory,
  addMemory,
  removeMemory,
  listSkills,
  removeSkill,
  listJobs,
} from "./store.js";
import { startRun, runJob, stopRun, subscribe, liveState, isRunning, awaitingApproval, resolveApproval } from "./agent.js";
import { createJob, updateJob, deleteJob, startScheduler } from "./scheduler.js";

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 8787);
const PASSWORD = process.env.DESKHAND_PASSWORD || "";
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const PUBLIC = path.join(ROOT, "public");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------- sign-in ----------
const sha = (text) => crypto.createHash("sha256").update(text).digest();
const sessionToken = () => crypto.createHmac("sha256", getConfig().sessionSecret).update(`session:${PASSWORD}`).digest("hex");

function signedIn(req) {
  if (!PASSWORD) return true;
  const cookie = /(?:^|;\s*)deskhand_session=([a-f0-9]+)/.exec(req.headers.cookie || "");
  return Boolean(cookie) && crypto.timingSafeEqual(sha(cookie[1]), sha(sessionToken()));
}

// Without a password the page only answers to this machine's own address, and
// only to requests that come from the page itself. This stops other websites
// open in the same browser from reaching the agent.
function checkOrigin(req) {
  const host = (req.headers.host || "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  if (!PASSWORD && !LOCAL_HOSTS.has(host)) throw new HttpError(403, "Open this page as http://localhost.");
  const origin = req.headers.origin;
  if (origin && new URL(origin).host !== req.headers.host) throw new HttpError(403, "Cross-site request refused.");
}

// ---------- helpers ----------
function send(res, status, body, headers = {}) {
  const json = typeof body !== "string" && !Buffer.isBuffer(body);
  res.writeHead(status, {
    "content-type": json ? "application/json; charset=utf-8" : "text/plain; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  res.end(json ? JSON.stringify(body) : body);
}

async function readBody(req) {
  if (!/^application\/json/.test(req.headers["content-type"] || "")) throw new HttpError(415, "Send JSON.");
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 2_000_000) throw new HttpError(413, "Too large.");
  }
  try {
    return JSON.parse(raw || "{}");
  } catch {
    throw new HttpError(400, "Invalid JSON.");
  }
}

function serveStatic(res, urlPath) {
  const file = path.join(PUBLIC, urlPath === "/" ? "index.html" : urlPath);
  if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw new HttpError(404, "Not found.");
  }
  send(res, 200, fs.readFileSync(file), {
    "content-type": TYPES[path.extname(file)] || "application/octet-stream",
    "content-security-policy": "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
  });
}

function conversationOr404(id) {
  const conv = /^[a-f0-9]{16}$/.test(id) ? getConversation(id) : null;
  if (!conv) throw new HttpError(404, "Conversation not found.");
  return conv;
}

function updateSettings(body) {
  const cfg = getConfig();
  const patch = {};
  if (typeof body.agentName === "string" && body.agentName.trim()) patch.agentName = body.agentName.trim().slice(0, 40);
  if (MODELS.some((m) => m.id === body.model)) patch.model = body.model;
  if (EFFORTS.includes(body.effort)) patch.effort = body.effort;
  if (["ask", "auto"].includes(body.approvalMode)) patch.approvalMode = body.approvalMode;
  if (typeof body.apiKey === "string") patch.apiKey = body.apiKey.trim();

  if (body.secret) {
    const { name, value, host, remove } = body.secret;
    if (!/^[A-Za-z0-9_]{1,40}$/.test(name || "")) throw new HttpError(400, "Secret names use letters, digits and underscores.");
    const secrets = { ...cfg.secrets };
    if (remove) delete secrets[name];
    else {
      if (!value || !/^[a-z0-9.-]+$/i.test(host || "")) throw new HttpError(400, "A secret needs a value and the host it may be sent to, e.g. api.example.com.");
      secrets[name] = { value: String(value), host: host.toLowerCase() };
    }
    patch.secrets = secrets;
  }

  if (body.mcpServer) {
    const { name, url, token, remove } = body.mcpServer;
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(name || "")) throw new HttpError(400, "Connector names use letters, digits, dashes and underscores.");
    const servers = cfg.mcpServers.filter((s) => s.name !== name);
    if (!remove) {
      if (!/^https:\/\//.test(url || "")) throw new HttpError(400, "A connector needs an https:// address.");
      servers.push({ name, url, token: token ? String(token) : "" });
    }
    patch.mcpServers = servers;
  }
  saveConfig(patch);
  return publicConfig();
}

// ---------- routes ----------
async function api(req, res, url) {
  const parts = url.pathname.split("/").filter(Boolean).slice(1); // after "api"
  const route = `${req.method} ${parts[0] || ""}`;
  const body = ["POST", "PUT", "PATCH"].includes(req.method) ? await readBody(req) : {};

  if (route === "POST login") {
    const ok = PASSWORD && crypto.timingSafeEqual(sha(String(body.password || "")), sha(PASSWORD));
    if (!ok) {
      await new Promise((r) => setTimeout(r, 1000)); // slows password guessing
      throw new HttpError(401, "Wrong password.");
    }
    const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
    return send(res, 200, { ok: true }, { "set-cookie": `deskhand_session=${sessionToken()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${secure}` });
  }
  if (!signedIn(req)) throw new HttpError(401, "Sign in first.");

  if (route === "GET state") return send(res, 200, publicConfig());
  if (route === "PUT settings") return send(res, 200, updateSettings(body));

  if (parts[0] === "conversations") {
    const [, id, action, actionId] = parts;
    if (!id) {
      if (req.method === "GET") {
        return send(res, 200, listConversations().map((c) => ({ ...c, running: isRunning(c.id), needsApproval: awaitingApproval(c.id) })));
      }
      if (req.method === "POST") return send(res, 200, createConversation());
    }
    const conv = conversationOr404(id);
    if (!action && req.method === "GET") return send(res, 200, { ...conv, live: liveState(id) });
    if (!action && req.method === "DELETE") {
      stopRun(id);
      deleteConversation(id);
      return send(res, 200, { ok: true });
    }
    if (action === "messages" && req.method === "POST") {
      const text = String(body.text || "").trim();
      if (!text) throw new HttpError(400, "Type a message first.");
      if (isRunning(id)) throw new HttpError(409, "The agent is still working. Stop it first.");
      startRun(id, text);
      return send(res, 200, { ok: true });
    }
    if (action === "stop" && req.method === "POST") {
      stopRun(id);
      return send(res, 200, { ok: true });
    }
    if (action === "approvals" && req.method === "POST") {
      if (!["allow", "always", "deny"].includes(body.decision)) throw new HttpError(400, "Bad decision.");
      if (!resolveApproval(id, actionId, body.decision)) throw new HttpError(404, "That request is no longer waiting.");
      return send(res, 200, { ok: true });
    }
    if (action === "events" && req.method === "GET") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
      const write = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
      // The snapshot and the subscription happen in the same tick, so nothing is missed between them.
      write({ type: "sync", conversation: conv, live: liveState(id) });
      const unsubscribe = subscribe(id, write);
      const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
      req.on("close", () => {
        clearInterval(ping);
        unsubscribe();
      });
      return;
    }
  }

  // Mistakes in what was typed (a bad schedule, a full memory) come back as plain messages.
  const attempt = (fn) => {
    try {
      return fn() ?? { ok: true };
    } catch (err) {
      throw err instanceof HttpError ? err : new HttpError(400, err.message);
    }
  };

  if (route === "GET memory") return send(res, 200, listMemory());
  if (route === "POST memory") return send(res, 200, attempt(() => addMemory(body.text)));
  if (route === "DELETE memory") return send(res, 200, attempt(() => removeMemory(parts[1])));

  if (route === "GET skills") return send(res, 200, listSkills());
  if (route === "DELETE skills") return send(res, 200, attempt(() => removeSkill(decodeURIComponent(parts[1]))));

  if (route === "GET jobs") return send(res, 200, listJobs());
  if (route === "POST jobs" && !parts[1]) return send(res, 200, attempt(() => createJob(body)));
  if (route === "POST jobs" && parts[2] === "run") {
    const job = listJobs().find((j) => j.id === parts[1]);
    if (!job) throw new HttpError(404, "Job not found.");
    const { conversation } = runJob(job);
    updateJob(job.id, { lastRunAt: new Date().toISOString(), lastConversationId: conversation.id });
    return send(res, 200, { conversationId: conversation.id });
  }
  if (route === "PATCH jobs") return send(res, 200, attempt(() => updateJob(parts[1], { enabled: Boolean(body.enabled) })));
  if (route === "DELETE jobs") return send(res, 200, attempt(() => deleteJob(parts[1])));

  throw new HttpError(404, "Not found.");
}

async function handle(req, res) {
  try {
    checkOrigin(req);
    const url = new URL(req.url, "http://local");
    if (url.pathname.startsWith("/api/")) return await api(req, res, url);
    if (req.method !== "GET") throw new HttpError(405, "Method not allowed.");
    return serveStatic(res, url.pathname);
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error(err);
    if (!res.headersSent) send(res, status, { error: status === 500 ? "Something went wrong on the server." : err.message });
    else res.end();
  }
}

export function start() {
  if (!LOCAL_HOSTS.has(HOST) && !PASSWORD) {
    console.error(
      `Refusing to start: HOST is ${HOST}, which other machines can reach, but DESKHAND_PASSWORD is not set.\n` +
        "This agent can run commands, so it must not be open to a network without a password. Set DESKHAND_PASSWORD in .env.",
    );
    process.exit(1);
  }
  initStore();
  getConfig();
  const server = http.createServer(handle);
  server.listen(PORT, HOST, () => {
    console.log(`Deskhand is running at http://${LOCAL_HOSTS.has(HOST) ? "localhost" : HOST}:${PORT}`);
    console.log(`Data: ${DATA}\nWorkspace: ${WORKSPACE}`);
  });
  startScheduler((job) => {
    const { conversation } = runJob(job);
    updateJob(job.id, { lastConversationId: conversation.id });
  });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.join(ROOT, "src", "server.js")) start();

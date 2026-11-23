// The Talqava Agents window. No framework: small helpers that build DOM nodes.
// Layout: a top bar (repository, command box, spending, settings) over a body
// that each view fills: home base, a quest, a bot, chats, and the other pages.
import { renderMarkdown } from "/markdown.js";

const app = document.getElementById("app");
const state = {
  config: null,
  convs: [],
  quests: [],
  crew: null,
  view: "chat", // chat is the main screen; bots ("home") are an add-on
  convId: null,
  botId: null,
  quest: null,
  running: false,
  source: null,
  selectedBot: null,
  project: "",
  spaces: [],
  space: "", // the space chats are shown and started in; "" is General
};
const ui = {}; // live nodes of the open view

try {
  state.project = localStorage.getItem("talqava.project") || "";
  state.selectedBot = localStorage.getItem("talqava.bot");
  state.space = localStorage.getItem("talqava.space") || "";
} catch {}
const remember = (key, value) => {
  try {
    localStorage.setItem(key, value ?? "");
  } catch {}
};

// ---------- helpers ----------
function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") node.className = value;
    else if (key === "style") node.setAttribute("style", value);
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (value === true) node.setAttribute(key, "");
    else if (value !== false && value != null) node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child != null && child !== false) node.append(child);
  }
  return node;
}

async function api(method, path, body) {
  if (method !== "GET" && method !== "DELETE") body ??= {}; // the server only accepts JSON writes
  const res = await fetch(`/api/${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== "login") {
    showLogin();
    throw new Error("Sign in first.");
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

/** Replaces a node's children; lists are flattened and empty values skipped. */
function fill(node, ...children) {
  node.replaceChildren(...children.flat(Infinity).filter((child) => child != null && child !== false));
  return node;
}

// Runs an action and shows any failure next to where it happened.
async function attempt(fn, where) {
  try {
    return await fn();
  } catch (err) {
    const box = h("div", { class: "banner error" }, err.message);
    (where || ui.log || ui.body || app).append(box);
    setTimeout(() => box.remove(), 8000);
  }
}

const when = (iso) => (iso ? new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "never");
const shortWhen = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : d.toLocaleDateString([], { month: "short", day: "numeric" });
};
const money = (n) => `$${n < 0.1 && n > 0 ? n.toFixed(3) : n.toFixed(2)}`;
const basename = (p) => String(p).split(/[\\/]/).filter(Boolean).pop() || p;

// ---------- sign-in ----------
function showLogin() {
  state.source?.close();
  const password = h("input", { type: "password", placeholder: "Password", autocomplete: "current-password" });
  const form = h(
    "form",
    {
      class: "login",
      onsubmit: async (e) => {
        e.preventDefault();
        await attempt(async () => {
          await api("POST", "login", { password: password.value });
          boot();
        }, form);
      },
    },
    h("div", { class: "brand" }, "Talqava Agents"),
    password,
    h("button", { class: "primary" }, "Sign in"),
  );
  fill(app, form);
  password.focus();
}

// ---------- start-up and refreshing ----------
// A Claude model with no key cannot run; a local model needs none.
const needsKey = (c) => c.model.startsWith("anthropic/") && !c.hasApiKey;

async function boot() {
  try {
    state.config = await api("GET", "state");
  } catch {
    return;
  }
  document.title = "Talqava Agents";
  if (!state.config.projects.includes(state.project)) state.project = "";
  if (needsKey(state.config)) state.view = "settings";
  await Promise.all([loadCrew(), loadQuests(), refreshList(), loadTemplates(), loadSpaces(), loadOrgs()]);
  render();
  clearInterval(boot.timer);
  // One heartbeat keeps every part of the window current.
  boot.timer = setInterval(tick, 2000);
}

async function loadCrew() {
  try {
    state.crew = await api("GET", `crew${state.project ? `?project=${encodeURIComponent(state.project)}` : ""}`);
  } catch {
    state.crew ??= { bots: [], problems: [], branch: null };
  }
  if (!state.crew.bots.some((b) => b.id === state.selectedBot)) state.selectedBot = state.crew.bots[0]?.id ?? null;
}

/** Spaces keep one client's or project's memory and chats apart; "" is General. */
async function loadSpaces() {
  try {
    state.spaces = await api("GET", "spaces");
  } catch {}
  if (!state.spaces.some((s) => s.id === state.space)) state.space = "";
}
const spaceName = (id) => state.spaces.find((s) => s.id === id)?.name || "General";
function setSpace(id) {
  state.space = id || "";
  remember("talqava.space", state.space);
}

/** Organizations: the bots in roles, with titles, departments and managers. */
async function loadOrgs() {
  try {
    state.orgs = await api("GET", "orgs");
  } catch {
    state.orgs ??= { active: "", orgs: [] };
  }
}
const activeOrg = () => state.orgs?.orgs.find((o) => o.id === state.orgs.active) ?? state.orgs?.orgs[0] ?? { id: "", name: "", mission: "", members: [] };
const roleOf = (botId) => activeOrg().members.find((m) => m.bot === botId);

async function loadTemplates() {
  try {
    state.templates = await api("GET", "quest-templates");
  } catch {
    state.templates = [];
  }
}

async function loadQuests() {
  try {
    state.quests = await api("GET", "quests");
  } catch {}
}

async function refreshList() {
  try {
    state.convs = await api("GET", "conversations");
  } catch {}
}

let ticks = 0;
async function tick() {
  if (document.hidden) return;
  ticks++;
  const before = questSignature();
  await loadQuests();
  if (ticks % 3 === 0) await refreshList();
  renderSpent();
  syncInboxCount();
  if (questSignature() !== before) {
    if (state.view === "home") renderHome();
    if (state.view === "quest") refreshQuest();
    if (state.view === "inbox") renderInbox();
  }
  if (state.view === "chat" && ticks % 3 === 0) renderChatList();
}

const questSignature = () =>
  JSON.stringify(state.quests.map((q) => [q.id, q.status, q.steps, q.outcome, q.approvals.length, q.activity?.output?.length ?? 0, q.checking, q.check?.at, q.template?.tries]));

/** Kept for the pages that call it after saving settings. */
function renderSide() {
  renderTop();
}

// ---------- the window frame ----------
// One layout for every page: a navigation rail on the left, and beside it a
// top bar (search and page tools) over the page itself.
function render() {
  ui.rail = h("nav", { class: "rail", "aria-label": "Main" });
  ui.top = h("header", { class: "top" });
  ui.body = h("div", { class: "body" });
  fill(app, ui.rail, h("div", { class: "main" }, ui.top, ui.body));
  renderTop();
  renderBody();
}

// Line icons for the rail, drawn on a 20 px grid.
const ICONS = {
  chat: "M4 5.5A2.5 2.5 0 0 1 6.5 3h7A2.5 2.5 0 0 1 16 5.5v5a2.5 2.5 0 0 1-2.5 2.5H9l-3.5 3v-3A2.5 2.5 0 0 1 4 10.5z",
  inbox: "M3.5 11.5l2-7h9l2 7M3.5 11.5v3a1.5 1.5 0 0 0 1.5 1.5h10a1.5 1.5 0 0 0 1.5-1.5v-3M3.5 11.5h4l1 2h3l1-2h4",
  team: "M10 3.5v3M10 6.5H5v3M10 6.5h5v3M3 9.5h4v3H3zM13 9.5h4v3h-4zM8 13.5h4v3H8zM10 6.5v7",
  home: "M5 7.5h10a1.5 1.5 0 0 1 1.5 1.5v5a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 14V9A1.5 1.5 0 0 1 5 7.5zM10 7.5V4.5M7.5 11.5v.01M12.5 11.5v.01",
  market: "M4 8l1-4h10l1 4M4 8v7.5h12V8M4 8h12M8 15.5v-4h4v4",
  memory: "M6 3.5h8A1.5 1.5 0 0 1 15.5 5v11.5L10 13.5l-5.5 3V5A1.5 1.5 0 0 1 6 3.5z",
  skills: "M4.5 5h11M4.5 10h11M4.5 15h7",
  jobs: "M10 5.5V10l3 2M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0z",
  settings: "M4 6h7M15 6h1M4 14h1M9 14h7M13 4v4M7 12v4",
};
const icon = (name) => {
  const node = h("span", { class: "ico", "aria-hidden": "true" });
  node.innerHTML = `<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="${ICONS[name]}"/></svg>`;
  return node;
};

function renderRail() {
  if (!ui.rail) return;
  const v = state.view;
  const item = (view, label, on, title) => h("button", { class: `railitem ${on ? "on" : ""}`, onclick: () => go(view), title: title || label, "aria-current": on ? "page" : null }, icon(view), h("span", { class: "grow" }, label));
  const inbox = item("inbox", "Inbox", v === "inbox", "What needs you, what is being worked on, and what got done");
  ui.inboxCount = h("span", { class: "count", hidden: true });
  inbox.append(ui.inboxCount);
  fill(
    ui.rail,
    h("button", { class: "plain brand", onclick: () => go("chat"), title: "Chat", "aria-label": "Talqava Agents, chat" }, "TALQAVA", h("span", { class: "cursor", "aria-hidden": "true" })),
    h("div", { class: "railgroup" }, item("chat", "Chat", v === "chat"), inbox),
    h("div", { class: "raillabel" }, "Team"),
    h("div", { class: "railgroup" }, item("team", "Organization", v === "team", "The org chart, departments and budgets"), item("home", "Bots at work", ["home", "quest", "bot"].includes(v), "Send bots on jobs and follow their work"), item("market", "Marketplace", v === "market" || v === "marketbot", "Free ready-made bots and teams")),
    h("div", { class: "raillabel" }, "Knowledge"),
    h("div", { class: "railgroup" }, item("memory", "Memory", v === "memory"), item("skills", "Skills", v === "skills"), item("jobs", "Schedules", v === "jobs")),
    h("div", { class: "railgroup railend" }, item("settings", "Settings", v === "settings")),
  );
  syncInboxCount();
}

function go(view, id = null) {
  state.view = view;
  state.convId = view === "chat" || view === "quest" ? id : null;
  state.botId = view === "bot" ? id : null;
  state.marketId = view === "marketbot" ? id : null;
  closePalette();
  renderTop();
  renderBody();
}

// The repository picker and quest spending only matter on the bot pages.
const onBotPages = () => ["home", "quest", "bot", "team"].includes(state.view);

function renderBody() {
  state.source?.close();
  state.source = null;
  ui.log = null;
  ui.body.className = "body";
  const views = { home: homeView, quest: questView, bot: botView, chat: chatView, memory: memoryView, skills: skillsView, jobs: jobsView, settings: settingsView, market: marketView, marketbot: marketBotView, inbox: inboxView, team: teamView };
  (views[state.view] || homeView)();
}

function renderTop() {
  if (!ui.top) return;
  const c = state.config;
  const repo = h(
    "select",
    {
      "aria-label": "Repository",
      onchange: async (e) => {
        state.project = e.target.value;
        remember("talqava.project", state.project);
        await loadCrew();
        renderTop();
        if (state.view === "home") renderHome();
      },
    },
    h("option", { value: "" }, "no repository"),
    c.projects.map((p) => h("option", { value: p, selected: p === state.project }, basename(p))),
  );
  ui.spent = h("div", { class: "spent" });
  const bots = ["home", "quest"].includes(state.view); // the repository and quest spending belong to the bots' work pages
  renderRail();
  fill(ui.top,
    ...[
      bots
        ? h(
            "div",
            { class: "repo", title: state.project || "Quests work in the workspace folder. Add repositories under Settings." },
            h("span", { class: "repolabel" }, "Repository"),
            repo,
            state.project && state.crew?.branch ? [h("span", { class: "on" }, "on"), state.crew.branch] : null,
          )
        : null,
      paletteBox(),
      bots ? ui.spent : null,
    ].filter(Boolean),
  );
  renderSpent();
}

function renderSpent() {
  syncInboxCount();
  if (!ui.spent) return;
  const today = new Date().toDateString();
  const spent = state.quests.filter((q) => new Date(q.createdAt).toDateString() === today).reduce((sum, q) => sum + (q.cost || 0), 0);
  fill(ui.spent, "Spent today on bots", h("b", {}, money(spent)));
}

// ---------- the command box ----------
const COMMANDS = [
  ["New chat", () => go("chat")],
  ["Inbox", () => go("inbox")],
  ["Bots", () => go("home")],
  ["Organization", () => go("team")],
  ["Marketplace", () => go("market")],
  ["Hatch a bot", () => go("bot", "new")],
  ["Memory", () => go("memory")],
  ["Skills", () => go("skills")],
  ["Schedules", () => go("jobs")],
  ["Settings", () => go("settings")],
];

function paletteBox() {
  ui.palette = h("input", { type: "text", placeholder: paletteHint(), "aria-label": "Ask something, send a bot, or run a command", autocomplete: "off" });
  ui.paletteList = null;
  ui.paletteAt = 0;
  const box = h("div", { class: "palette" }, ui.palette, h("span", { class: "keys" }, navigator.platform.includes("Mac") ? "⌘K" : "Ctrl K"));
  ui.palette.addEventListener("input", () => openPalette(box));
  ui.palette.addEventListener("focus", () => openPalette(box));
  ui.palette.addEventListener("blur", () => setTimeout(closePalette, 150));
  ui.palette.addEventListener("keydown", (e) => {
    const items = paletteItems();
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      ui.paletteAt = (ui.paletteAt + (e.key === "ArrowDown" ? 1 : -1) + items.length) % Math.max(items.length, 1);
      openPalette(box);
    } else if (e.key === "Enter") {
      e.preventDefault();
      items[ui.paletteAt]?.run();
    } else if (e.key === "Escape") {
      ui.palette.blur();
    }
  });
  return box;
}

function paletteHint() {
  const bot = state.crew?.bots.find((b) => b.id === state.selectedBot);
  if (state.view === "home" && bot) return `Send ${bot.name} on a quest, or type @name, or a command`;
  return "Ask in a new chat, @bot to send a bot, or a command";
}

function paletteItems() {
  const text = ui.palette?.value.trim() ?? "";
  const bots = state.crew?.bots ?? [];
  const items = [];
  const mention = /^@([\w-]+)\s*(.*)$/s.exec(text);
  // Plain text starts a chat; bots are sent only from the bots page or with @name.
  const botFirst = state.view === "home";
  if (text && !mention) items.push({ label: "Ask in a new chat", what: text, run: () => startChatWith(text) });
  const target = mention ? bots.find((b) => b.id === mention[1].toLowerCase() || b.name.toLowerCase().startsWith(mention[1].toLowerCase())) : botFirst ? bots.find((b) => b.id === state.selectedBot) : null;
  const task = mention ? mention[2].trim() : text;
  if (task && target) items[botFirst && !mention ? "unshift" : "push"]({ label: `Send ${target.name} on a quest`, what: task, bot: target, run: () => sendQuest(target, task) });
  if (task && !mention && botFirst) {
    for (const bot of bots.filter((b) => b !== target).slice(0, 5)) items.push({ label: `Send ${bot.name} instead`, what: bot.type, bot, run: () => sendQuest(bot, task) });
  }
  const needle = text.toLowerCase();
  const commands = [
    ...COMMANDS,
    ...(state.templates ?? []).map((t) => [`Core quest: ${t.name}`, () => (go("home"), openCoreQuest(t.id))]),
    ...bots.map((b) => [`Edit ${b.name}`, () => go("bot", b.id)]),
  ];
  for (const [label, run] of commands) if (!needle || label.toLowerCase().includes(needle)) items.push({ label, what: "", run });
  return items.slice(0, 12);
}

function openPalette(box) {
  const items = paletteItems();
  ui.paletteAt = Math.min(ui.paletteAt, Math.max(items.length - 1, 0));
  ui.paletteList?.remove();
  if (!items.length) return;
  ui.paletteList = h(
    "ul",
    { role: "listbox" },
    items.map((item, i) =>
      h(
        "li",
        { class: i === ui.paletteAt ? "on" : "", role: "option", onmousedown: (e) => (e.preventDefault(), item.run()) },
        item.bot ? keycap(item.bot.character, 22, "", item.bot.type) : null,
        h("span", {}, item.label),
        item.what ? h("span", { class: "what" }, item.what) : null,
      ),
    ),
  );
  box.append(ui.paletteList);
}

function closePalette() {
  ui.paletteList?.remove();
  ui.paletteList = null;
  ui.paletteAt = 0;
}

/** Opens a new chat and sends the text as its first message. */
function startChatWith(text) {
  ui.palette.value = "";
  ui.palette.blur();
  go("chat");
  ui.input.value = text;
  submit();
}

async function sendQuest(bot, text) {
  await attempt(async () => {
    const quest = await api("POST", "quests", { bot: bot.id, text, project: state.project || undefined });
    ui.palette.value = "";
    ui.palette.blur();
    await loadQuests();
    go("quest", quest.id);
  });
}

document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    ui.palette?.focus();
  }
});

// ---------- conversation rendering ----------
function nearBottom() {
  return ui.scroll.scrollHeight - ui.scroll.scrollTop - ui.scroll.clientHeight < 120;
}

function onEvent(event) {
  const stick = nearBottom();
  switch (event.type) {
    case "sync":
      renderConversation(event.conversation, event.live);
      break;
    case "user":
      addUser(event.text);
      ui.title.textContent = event.title;
      break;
    case "delta":
      streamDelta(event);
      break;
    case "reset":
      clearStream();
      break;
    case "assistant":
      clearStream();
      addAssistant(event.content);
      break;
    case "tool_result":
      fillResult(event.result);
      break;
    case "approval":
      addApproval(event.approval);
      break;
    case "approval_done":
      document.getElementById(`approval-${event.id}`)?.remove();
      break;
    case "status":
      setRunning(event.running);
      if (event.usage) showUsage(event.usage);
      if (!event.running) clearStream();
      refreshList();
      break;
    case "resumed":
    case "notice":
      ui.log.append(h("div", { class: "banner" }, event.text));
      break;
    case "error":
      ui.log.append(h("div", { class: "banner error" }, event.text));
      break;
  }
  if (stick || event.type === "sync" || event.type === "user") ui.scroll.scrollTop = ui.scroll.scrollHeight;
}

function renderConversation(conv, live) {
  fill(ui.log, );
  ui.cards.clear();
  ui.stream = null;
  ui.working = null;
  ui.title.textContent = conv.title;
  showUsage(conv.usage);
  for (const message of conv.messages) {
    if (message.role === "assistant") addAssistant(message.content);
    else if (typeof message.content === "string") addUser(message.content);
    else for (const block of message.content) if (block.type === "tool_result") fillResult(block);
  }
  // A new chat with one bot starts by saying who it is and where it sits.
  const withBot = state.view === "chat" ? chatBotOf(conv.id) : undefined;
  if (withBot && !conv.messages.length) {
    const role = roleOf(withBot.id);
    const reports = activeOrg().members.filter((m) => m.manager === withBot.id).map((m) => (state.crew?.bots ?? []).find((b) => b.id === m.bot)?.name).filter(Boolean);
    ui.log.append(
      h(
        "div",
        { class: "empty", style: botStyle(withBot) },
        keycap(withBot.character, 88, "", withBot.type),
        h("h2", {}, `You're chatting with ${withBot.name}.`),
        h("p", {}, `${role ? `${role.title}, ${role.department}. ` : ""}${withBot.instructions.split(/(?<=[.!?])\s/)[0]}`),
        reports.length ? h("p", { class: "note" }, `${withBot.name} leads ${reports.join(", ")} and can hand them tasks. Their reports come back into this chat.`) : null,
      ),
    );
  }
  setRunning(live.running);
  for (const delta of live.partial) streamDelta(delta);
  for (const approval of live.approvals) addApproval(approval);
}

function showUsage(usage) {
  const total = (usage?.input || 0) + (usage?.output || 0);
  const cost = usage?.cost ? ` · about $${usage.cost < 0.1 ? usage.cost.toFixed(3) : usage.cost.toFixed(2)}` : "";
  ui.meta.textContent = total ? `${total.toLocaleString()} tokens${cost}` : "";
}

function setRunning(running) {
  state.running = running;
  ui.send.textContent = running ? "Stop" : "Send";
  ui.send.classList.toggle("primary", !running);
  ui.working?.remove();
  ui.working = running ? h("div", { class: "working" }, h("span", { class: "dot" }), "Working…") : null;
  if (ui.working) ui.log.append(ui.working);
}

// New content goes above the "Working…" line so that line stays last.
function add(node) {
  if (ui.working?.isConnected) ui.working.before(node);
  else ui.log.append(node);
  return node;
}

/** How a report from a hand-off begins (REPORT_MARK in src/local/quests.ts). */
const REPORT_MARK = "[Report from ";

function addUser(text) {
  if (!text.startsWith(REPORT_MARK)) return add(h("div", { class: "msg user" }, text));
  // Reports that came back from bots a task was handed to: shown as theirs, not as something the person typed.
  const body = text.replace(/\n\n\[[^\]]*\]\s*$/, "");
  for (const part of body.split(/\n\n(?=\[Report from )/)) {
    const head = /^\[Report from ([^·\]]+) · ([\s\S]*?) · ([^·\]]*)\]\n?/.exec(part);
    const who = head?.[1].trim() ?? "A bot";
    const bot = (state.crew?.bots ?? []).find((b) => b.name === who);
    add(
      h(
        "div",
        { class: "report", style: bot ? botStyle(bot) : "" },
        h("div", { class: "rhead" }, bot ? keycap(bot.character, 28, "", bot.type) : null, h("b", {}, `${who} reported back`), h("span", { class: "mono small muted" }, head ? `${head[2].trim().slice(0, 70)} · ${head[3].trim()}` : "")),
        h("div", { class: "md" }, renderMarkdown(head ? part.slice(head[0].length) : part)),
      ),
    );
  }
}

function summarize(name, input = {}) {
  if (name === "bash") return input.command || "restart";
  if (name === "str_replace_based_edit_tool") return `${input.command || ""} ${input.path || ""}`;
  if (name === "http_request") return `${input.method || ""} ${input.url || ""}`;
  if (name === "web_search") return input.query || "";
  if (name === "web_fetch") return input.url || "";
  if (name === "memory") return input.text || `${input.action || ""} ${input.id || ""}`;
  if (name === "skill" || name === "schedule") return `${input.action || ""} ${input.name || ""}`;
  if (name === "conversation_search") return input.query || "";
  if (name === "assign_task") return `to ${input.to || "a bot"}: ${input.task || ""}`;
  if (name === "browser") return `${input.action || ""} ${input.url || input.target || ""}`;
  const text = JSON.stringify(input);
  return text === "{}" ? "" : text;
}

const NAMES = { bash: "Shell", str_replace_based_edit_tool: "Files", web_search: "Web search", web_fetch: "Read page", http_request: "API call", memory: "Memory", skill: "Skill", schedule: "Schedule", browser: "Browser", conversation_search: "Search chats", code_execution: "Code", assign_task: "Handed off" };

function toolCard(id, name, input, done) {
  const stateEl = h("span", { class: `state ${done ? "ok" : ""}` }, done ? "done" : "running…");
  const body = h("div", { class: "body" }, h("div", { class: "label" }, "Input"), h("pre", {}, typeof input === "string" ? input : JSON.stringify(input, null, 2)));
  const card = h("details", { class: "tool" }, h("summary", {}, h("span", { class: "name" }, NAMES[name] || name), h("span", { class: "what" }, summarize(name, input)), stateEl), body);
  ui.cards.set(id, { card, body, stateEl });
  return card;
}

/**
 * What the agent saved to memory, shown in the conversation as it happens,
 * with Edit and Undo, so nothing is remembered behind the person's back.
 */
function memoryNote(id, input = {}) {
  if (!["add", "update", "remove"].includes(input.action)) return toolCard(id, "memory", input, false);
  const label = h("span", { class: "mlabel" }, { add: "Remembering…", update: "Updating memory…", remove: "Forgetting…" }[input.action]);
  const text = h("span", { class: "mtext" }, input.text || "");
  const actions = h("span", { class: "mactions" });
  const node = h("div", { class: "memnote" }, h("span", { class: "mmark", "aria-hidden": "true" }, "◆"), h("div", { class: "grow" }, label, text), actions);
  const edit = (entryId) => {
    const box = h("textarea", { rows: 2 }, text.textContent);
    const done = () => (box.replaceWith(text), fill(actions, buttons(entryId)));
    box.value = text.textContent;
    text.replaceWith(box);
    box.focus();
    fill(
      actions,
      h("button", {
        class: "plain",
        onclick: () =>
          attempt(async () => {
            const saved = await api("PATCH", `memory/${entryId}`, { text: box.value });
            text.textContent = saved.text;
            label.textContent = "Memory edited";
            done();
          }, node),
      }, "Save"),
      h("button", { class: "plain", onclick: done }, "Cancel"),
    );
  };
  const buttons = (entryId) => [
    h("button", { class: "plain", onclick: () => edit(entryId) }, "Edit"),
    h("button", {
      class: "plain",
      title: "Remove this from memory",
      onclick: () =>
        attempt(async () => {
          await api("DELETE", `memory/${entryId}`);
          label.textContent = "Removed from memory";
          node.classList.add("gone");
          fill(actions);
        }, node),
    }, "Undo"),
  ];
  ui.cards.set(id, {
    onResult(block) {
      const out = resultText(block.content);
      if (block.is_error) {
        label.textContent = "Could not save to memory";
        node.classList.add("gone");
        node.append(h("div", { class: "note small" }, out));
        return;
      }
      const saved = /\(id ([a-z0-9]+)\) in (.+)\.$/.exec(out);
      if (input.action === "remove") label.textContent = "Removed from memory";
      else label.textContent = `${input.action === "add" ? "Remembered" : "Memory updated"}${saved ? ` · ${saved[2]}` : ""}`;
      if (saved && input.action !== "remove") fill(actions, buttons(saved[1]));
    },
  });
  return node;
}

function resultText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content ? JSON.stringify(content, null, 2) : "";
  return content
    .map((part) => {
      if (part.type === "text") return part.text;
      if (part.type === "image") return "[image]";
      if (part.type === "web_search_result") return `${part.title}\n${part.url}`;
      return "";
    })
    .filter(Boolean)
    .join("\n\n");
}

function fillResult(block) {
  const entry = ui.cards.get(block.tool_use_id);
  if (!entry) return;
  if (entry.onResult) return entry.onResult(block);
  const failed = block.is_error || /error$/.test(block.content?.type || "");
  entry.stateEl.textContent = failed ? "failed" : "done";
  entry.stateEl.className = `state ${failed ? "bad" : "ok"}`;
  const text = resultText(block.content);
  if (text) entry.body.append(h("div", { class: "label" }, "Result"), h("pre", {}, text));
}

function addAssistant(content) {
  const box = h("div", { class: "msg" });
  for (const block of content) {
    if (block.type === "text" && block.text.trim()) {
      box.append(h("div", { class: "md" }, renderMarkdown(block.text)));
    } else if (block.type === "thinking" && block.thinking?.trim()) {
      box.append(h("details", { class: "think" }, h("summary", {}, "Thinking"), h("div", { class: "body" }, block.thinking)));
    } else if (block.type === "tool_use" && block.name === "memory") {
      box.append(memoryNote(block.id, block.input));
    } else if (block.type === "tool_use" || block.type === "mcp_tool_use") {
      box.append(toolCard(block.id, block.name, block.input, false));
    } else if (block.type === "server_tool_use") {
      box.append(toolCard(block.id, block.name, block.input, true));
    } else if (/_tool_result$/.test(block.type) && block.tool_use_id) {
      fillResult(block);
    }
  }
  if (box.childNodes.length) add(box);
}

function streamDelta(delta) {
  if (!ui.stream) {
    ui.stream = { box: h("div", { class: "msg" }), text: "", thinking: "", md: null, think: null, tool: null };
    add(ui.stream.box);
  }
  const s = ui.stream;
  if (delta.kind === "thinking") {
    s.thinking += delta.text;
    if (!s.think) s.box.prepend((s.think = h("div", { class: "note" })));
    s.think.textContent = `Thinking: ${s.thinking.slice(-300)}`;
  } else if (delta.kind === "text") {
    s.text += delta.text;
    if (!s.md) s.box.append((s.md = h("div", { class: "md" })));
    if (!s.queued) {
      s.queued = true;
      requestAnimationFrame(() => {
        s.queued = false;
        fill(s.md, renderMarkdown(s.text));
      });
    }
  } else if (delta.kind === "tool") {
    s.box.append(h("div", { class: "note" }, `Preparing: ${NAMES[delta.text] || delta.text}…`));
  }
}

function clearStream() {
  ui.stream?.box.remove();
  ui.stream = null;
}

function addApproval(approval) {
  if (document.getElementById(`approval-${approval.id}`)) return;
  const decide = (decision) => attempt(() => api("POST", `conversations/${state.convId}/approvals/${approval.id}`, { decision }));
  const detail = approval.name === "bash" ? approval.input.command : JSON.stringify(approval.input, null, 2);
  add(
    h(
      "div",
      { class: "approval", id: `approval-${approval.id}` },
      h("strong", {}, `${speaker()} wants to use: ${NAMES[approval.name] || approval.name}`),
      approval.reason ? h("div", { class: "note" }, approval.reason) : null,
      h("pre", {}, detail),
      h(
        "div",
        { class: "row" },
        h("button", { class: "primary", onclick: () => decide("allow") }, "Allow once"),
        approval.reason ? null : h("button", { onclick: () => decide("always") }, `Always allow ${NAMES[approval.name] || approval.name} in this chat`),
        h("button", { class: "danger", onclick: () => decide("deny") }, "Don't allow"),
      ),
    ),
  );
}

// ---------- characters ----------
// Each agent is a keycap drawn in one white line. The legend printed on it is
// its job; the texture on its base tells it from the others. Status is carried
// by motion and a glyph, never by colour. Follows the Mono design boards.
const LEGENDS = { scout: "?", scribe: "Aa", maker: "</>", keeper: "zz", counter: "#", spark: "!" };
const TEXTURES = { dots: "Dots", lines: "Ruled lines", hatch: "Diagonal hatch", solid: "Solid", grid: "Grid", zigzag: "Zigzag", plain: "Plain" };
const TYPE_TEXTURES = { scout: "dots", scribe: "lines", maker: "hatch", keeper: "solid", counter: "grid", spark: "zigzag" };
const WHITE = "#f2f2f2";
const BLACK = "#0a0a0a";
// Neon colours: each bot glows in one, and the app has an accent of its own.
// The names match COLORS in src/core/crew.ts.
const NEON = {
  green: ["Green", "#00d26a"],
  cyan: ["Cyan", "#2ef2ff"],
  magenta: ["Magenta", "#ff3df5"],
  lime: ["Lime", "#b4ff39"],
  amber: ["Amber", "#ffb020"],
  violet: ["Violet", "#a78bff"],
  pink: ["Pink", "#ff4f9a"],
  yellow: ["Yellow", "#f5ff3b"],
  mint: ["Mint", "#3dffc0"],
};
const TYPE_COLORS = { scout: "cyan", scribe: "violet", maker: "lime", keeper: "mint", counter: "yellow", spark: "magenta" };
const colorName = (character, type) => (NEON[character?.color] ? character.color : TYPE_COLORS[type] || "cyan");
const colorOf = (character, type) => NEON[colorName(character, type)][1];
/** Inline style that hands a bot's colour to its row or card (used as var(--bot) in style.css). */
const botStyle = (bot) => `--bot: ${colorOf(bot?.character, bot?.type)}`;

// The app's own accent, a per-viewer choice kept in this browser.
// Dark neon green unless the person picks another.
const DEFAULT_ACCENT = "green";
let accent = DEFAULT_ACCENT;
try {
  accent = NEON[localStorage.getItem("talqava.accent")] ? localStorage.getItem("talqava.accent") : DEFAULT_ACCENT;
} catch {}
function applyAccent(name) {
  accent = NEON[name] ? name : DEFAULT_ACCENT;
  document.documentElement.style.setProperty("--accent", NEON[accent][1]);
  remember("talqava.accent", accent);
}
applyAccent(accent);

/** A row of neon swatches; `onpick` gets the colour's name. */
function swatches(current, onpick, label) {
  return h(
    "div",
    { class: "swatches", role: "group", "aria-label": label },
    Object.entries(NEON).map(([name, [title, hex]]) =>
      h("button", {
        type: "button",
        class: `swatch ${name === current ? "on" : ""}`,
        style: `--swatch: ${hex}`,
        title,
        "aria-label": title,
        "aria-pressed": String(name === current),
        onclick: () => onpick(name),
      }),
    ),
  );
}
const escapeXml = (text) => String(text).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
const legendOf = (character, type) => [...String(character?.legend || LEGENDS[type] || "?")].slice(0, 3).join("");
const textureOf = (character, type) => (TEXTURES[character?.texture] ? character.texture : TYPE_TEXTURES[type] || "plain");
let patternIds = 0;

/** A neon-on-black texture as an SVG pattern, or null for solid and plain. */
function texturePattern(kind, id, ink = WHITE) {
  const body = {
    dots: `<circle cx="1.5" cy="1.5" r="0.75" fill="${ink}"/>`,
    lines: `<path d="M0 1.5h3" stroke="${ink}" stroke-width="0.7"/>`,
    hatch: `<path d="M-0.5 3.5l4-4M-0.5 0.5l1-1M2.5 3.5l1-1" stroke="${ink}" stroke-width="0.6"/>`,
    grid: `<path d="M0 0.3h3M0.3 0v3" stroke="${ink}" stroke-width="0.55"/>`,
    zigzag: `<path d="M0 2.2l0.75-1.4 0.75 1.4 0.75-1.4 0.75 1.4" fill="none" stroke="${ink}" stroke-width="0.6"/>`,
  }[kind];
  return body ? `<pattern id="${id}" width="3" height="3" patternUnits="userSpaceOnUse">${body}</pattern>` : null;
}

/** The eyes of a bot at rest. Each kind is drawn its own way, and blinks or looks about (see style.css). */
function restingEyes(kind, ink) {
  const stroke = `fill="${BLACK}" stroke="${ink}" stroke-width="1.1"`;
  if (kind === "wide") return [19, 29].map((x) => `<g class="k-eye"><circle cx="${x}" cy="24.3" r="2.6" ${stroke}/><circle class="k-pupil" cx="${x}" cy="24.3" r="1.05" fill="${ink}"/></g>`).join("");
  if (kind === "sleepy") return `<path class="k-eye" d="M16.8 24.2q2.2 2 4.4 0M26.8 24.2q2.2 2 4.4 0" fill="none" stroke="${ink}" stroke-width="1.4" stroke-linecap="round"/>`;
  if (kind === "visor") return `<rect x="15.2" y="21.6" width="17.6" height="5.6" rx="2.8" ${stroke}/><g class="k-scanner"><circle cx="20.4" cy="24.4" r="1.05" fill="${ink}"/><circle cx="27.6" cy="24.4" r="1.05" fill="${ink}"/></g>`;
  if (kind === "specs")
    return (
      `<path d="M21.7 24.3h4.6" stroke="${ink}" stroke-width="1"/>` +
      [19, 29].map((x) => `<circle cx="${x}" cy="24.3" r="2.7" ${stroke}/><circle class="k-eye" cx="${x}" cy="24.3" r="0.95" fill="${ink}"/>`).join("")
    );
  return `<circle class="k-eye" cx="19" cy="24.5" r="1.7" fill="${ink}"/><circle class="k-eye" cx="29" cy="24.5" r="1.7" fill="${ink}"/>`;
}

/** The face, set by the mood. At rest, the bot's own kind of eyes show. */
function keyFace(mood, ink = WHITE, eyes = "dots") {
  const line = (d, w = 1.3) => `<path d="${d}" fill="none" stroke="${ink}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`;
  if (mood === "working") return line("M16.8 24.5h4.4M26.8 24.5h4.4", 1.5) + line("M22 29.6h4", 1.2);
  if (mood === "waiting") return `<circle cx="19" cy="24.5" r="2.3" fill="${ink}"/><circle cx="29" cy="24.5" r="2.3" fill="${ink}"/><circle cx="24" cy="30.2" r="1.3" fill="${ink}"/>`;
  if (mood === "done") return line("M16.8 25.2q2.2-2.6 4.4 0M26.8 25.2q2.2-2.6 4.4 0", 1.4) + line("M21 28.8q3 3.4 6 0");
  if (mood === "stuck") return line("M17.4 23l3.2 3.2M20.6 23l-3.2 3.2M27.4 23l3.2 3.2M30.6 23l-3.2 3.2") + line("M21 30.4l1.5-1 1.5 1 1.5-1 1.5 1", 1.1);
  if (mood === "asleep") return line("M17 24.8h4M27 24.8h4") + line("M22.6 29.8h2.8", 1.1);
  return restingEyes(eyes, ink) + line("M21.8 29.6q2.2 2.2 4.4 0", 1.15);
}

// What makes each bot look like itself. The names match SHAPES, EYES and TOPS in src/core/crew.ts.
const SHAPES = { key: "Key", round: "Round", tall: "Tall", wide: "Wide", soft: "Soft" };
const EYES = { dots: "Dots", wide: "Wide", sleepy: "Sleepy", visor: "Visor", specs: "Specs" };
const TOPS = { none: "Nothing", antenna: "Antenna", ears: "Ears", horns: "Horns", tuft: "Tuft", halo: "Halo" };
// Corner radii of the base and the cap, and how the body is stretched.
const SHAPE_FORM = { key: [8, 6, 1, 1], round: [15, 12.5, 1, 1], tall: [8, 6, 0.84, 1.08], wide: [9, 7, 1.1, 0.88], soft: [12, 9.5, 1, 0.95] };
const looksOf = (character) => ({ shape: SHAPE_FORM[character?.shape] ? character.shape : "key", eyes: EYES[character?.eyes] ? character.eyes : "dots", top: TOPS[character?.top] ? character.top : "none" });

/** What a bot wears on top, drawn from the top edge of its body. */
function topFeature(kind, ink, topY, left, right) {
  const p = (d, extra = "") => `<path d="${d}" fill="none" stroke="${ink}" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" ${extra}/>`;
  const y = topY.toFixed(1);
  if (kind === "antenna") return `<g class="k-antenna">${p(`M24 ${y}v-4.4`)}<circle cx="24" cy="${(topY - 5.6).toFixed(1)}" r="1.55" fill="${ink}"/></g>`;
  if (kind === "ears") return `<path class="k-ear" d="M${(left + 3.5).toFixed(1)} ${(topY + 1).toFixed(1)}l1.6-5 4.2 3.2z" fill="${BLACK}" stroke="${ink}" stroke-width="1.2" stroke-linejoin="round"/><path class="k-ear k-ear-r" d="M${(right - 3.5).toFixed(1)} ${(topY + 1).toFixed(1)}l-1.6-5-4.2 3.2z" fill="${BLACK}" stroke="${ink}" stroke-width="1.2" stroke-linejoin="round"/>`;
  if (kind === "horns") return p(`M${(left + 6).toFixed(1)} ${y}q-3-2-1.6-5.4`) + p(`M${(right - 6).toFixed(1)} ${y}q3-2 1.6-5.4`);
  if (kind === "tuft") return `<g class="k-tuft">${p(`M24 ${y}v-4M21.2 ${y}l-1.8-3.2M26.8 ${y}l1.8-3.2`)}</g>`;
  if (kind === "halo") return `<ellipse class="k-halo" cx="24" cy="${(topY - 3.6).toFixed(1)}" rx="7.5" ry="2" fill="none" stroke="${ink}" stroke-width="1.2"/>`;
  return "";
}

/**
 * An agent, drawn as a keycap character. Each has its own body shape, eyes and
 * top feature, in its own colour. Moods: "" (at rest), working, waiting, done,
 * stuck, asleep; each moves in its own way (see style.css). Below 24 px only
 * the body and a bigger legend are drawn.
 */
function keycap(character, size = 40, mood = "", type = "") {
  const legend = legendOf(character, type);
  const text = escapeXml(legend);
  const texture = textureOf(character, type);
  const ink = colorOf(character, type);
  const looks = looksOf(character);
  const [rx, irx, sx, sy] = SHAPE_FORM[looks.shape];
  const id = `tx${++patternIds}`;
  const pattern = texturePattern(texture, id, ink);
  const baseFill = texture === "solid" ? ink : pattern ? `url(#${id})` : BLACK;
  let svg;
  if (size < 24) {
    const n = [...legend].length;
    const fs = n === 1 ? 14 : n === 2 ? 10.5 : 8;
    const w = 21 * Math.min(sx, 1.04);
    const hgt = 20.5 * Math.min(sy, 1.04);
    const x = 12 - w / 2;
    const y = 22.5 - hgt;
    svg =
      `<svg aria-hidden="true" width="${size}" height="${size}" viewBox="0 0 24 24"><defs>${pattern ?? ""}</defs>` +
      `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${hgt.toFixed(1)}" rx="${(rx * 0.56).toFixed(1)}" fill="${baseFill}" stroke="${ink}" stroke-width="1"/>` +
      `<rect x="${(x + 1.7).toFixed(1)}" y="${(y + 0.4).toFixed(1)}" width="${(w - 3.4).toFixed(1)}" height="${(hgt - 4.9).toFixed(1)}" rx="${(irx * 0.56).toFixed(1)}" fill="${BLACK}" stroke="${ink}" stroke-width="1"/>` +
      `<text x="12" y="${(y + (hgt - 4.9) / 2 + fs * 0.36 + 0.4).toFixed(1)}" text-anchor="middle" font-family="ui-monospace, Menlo, Consolas, monospace" font-size="${fs}" font-weight="700" fill="${ink}">${text}</text></svg>`;
  } else {
    const big = size >= 64;
    const legendText = big
      ? `<text x="12" y="18.4" font-family="ui-monospace, Menlo, Consolas, monospace" font-size="7.2" font-weight="700" fill="${ink}">${text}</text>`
      : `<text x="11" y="19.4" font-family="ui-monospace, Menlo, Consolas, monospace" font-size="9.6" font-weight="800" fill="${ink}">${text}</text>`;
    const cursorX = (big ? 12 : 11) + (big ? 4.4 : 5.8) * [...legend].length + 0.6;
    const cursor = mood === "working" ? `<rect class="k-blink" x="${cursorX.toFixed(1)}" y="${big ? 12.4 : 12}" width="${big ? 3.2 : 3.6}" height="${big ? 6.4 : 8}" fill="${ink}"/>` : "";
    const extras =
      (mood === "waiting" ? `<rect class="k-march" x="2.5" y="5.5" width="43" height="38" rx="10.5" fill="none" stroke="${ink}" stroke-width="1.1" stroke-dasharray="3 3"/>` : "") +
      (mood === "done" ? `<circle cx="42" cy="8" r="5.2" fill="${ink}"/><path class="k-tick" d="M39.6 8.2l1.7 1.7 3.2-3.4" fill="none" stroke="${BLACK}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="8" stroke-dashoffset="8"/>` : "") +
      (mood === "asleep" ? `<text class="k-z" x="39" y="9" font-family="ui-monospace, monospace" font-size="7" fill="#b8b8b8">z</text>` : "");
    // The body is stretched from the middle of its bottom edge, so it always stands on its legs.
    const topY = 41 - 33 * sy;
    const stretch = sx === 1 && sy === 1 ? "" : ` transform="translate(24 41) scale(${sx} ${sy}) translate(-24 -41)"`;
    svg =
      `<svg aria-hidden="true" width="${size}" height="${size}" viewBox="0 0 48 48"><defs>${pattern ?? ""}</defs>` +
      `<path class="k-legs" d="M${(24 - 6.5 * sx).toFixed(1)} 41v5M${(24 + 6.5 * sx).toFixed(1)} 41v5" stroke="${ink}" stroke-width="1.6" stroke-linecap="round"/>` +
      `<g class="cap">${topFeature(looks.top, ink, topY, 24 - 19 * sx, 24 + 19 * sx)}<g${stretch}><rect x="5" y="8" width="38" height="33" rx="${rx}" fill="${baseFill}" stroke="${ink}" stroke-width="1.2"/>` +
      `<rect x="8.5" y="8.5" width="31" height="26" rx="${irx}" fill="${BLACK}" stroke="${ink}" stroke-width="1.2"/>` +
      `${legendText}${cursor}${keyFace(mood, ink, looks.eyes)}</g></g>${extras}</svg>`;
  }
  // Each bot starts its movement at a different moment and rests in its own way, so a row of them does not move in step.
  const delay = -((patternIds * 0.83) % 5).toFixed(2);
  const way = ([...legend].reduce((n, ch) => n + ch.codePointAt(0), 0) + looks.shape.length + looks.top.length) % 3;
  const node = h("span", { class: `keychar ${mood ? `k-${mood}` : `k-idle k-rest-${way}`}`, style: `--bot: ${ink}; --k-delay: ${delay}s` });
  node.innerHTML = svg;
  return node;
}

const isLive = (q) => q.status === "running" || q.status === "waiting";
// "done" (the tick) only for a result that passed its check.
const mood = (q) =>
  q?.status === "waiting" ? "waiting" : q?.status === "running" || q?.checking ? "working" : q?.status === "failed" || (q?.check && !q.check.passed) ? "stuck" : q?.check?.passed ? "done" : "";

/** How a quest stands: a glyph and a word or two, and whether it needs attention. */
function standing(q) {
  if (q.status === "waiting") return ["◌ Waiting on you", "loud"];
  if (q.status === "running") return q.template?.tries ? [`● Fixing · try ${q.template.tries} of ${q.template.maxTries}`, "loud"] : ["● Working", "loud"];
  if (q.checking) return ["◌ Checking the result", "loud"];
  if (q.check && !q.check.passed && q.status === "done") return ["✕ Check failed", "loud"];
  if (q.branch && !q.outcome && q.changedFiles === 0 && q.status === "done") return ["✓ Done · no changes", ""];
  if (q.branch && !q.outcome && q.status !== "failed") return [q.check?.passed ? "✓ Checked · ready for review" : "→ Ready for review", "loud"];
  if (q.outcome === "accepted") return ["✓ Changes kept", ""];
  if (q.outcome === "undone") return ["↶ Undone", ""];
  if (q.resumedAt && q.status === "done") return ["↺ Done after restart", ""];
  if (q.check?.passed && q.status === "done") return ["✓ Checked", ""];
  return { done: ["✓ Done", ""], stopped: ["■ Stopped", ""], budget: ["■ Hit its budget", ""], failed: ["✕ Failed", "loud"] }[q.status] || [q.status, ""];
}

function modelChip(info) {
  if (!info?.kind) return h("span", { class: "chip bad", title: info?.label || "" }, "No model");
  if (info.kind === "anthropic") return h("span", { class: "chip", title: info.label }, "Claude · key");
  return h("span", { class: "chip", title: info.label }, info.free ? "Local" : "Your key");
}

const POWER_NAMES = {
  web: "Web search and read pages",
  memory: "Memory",
  skills: "Skills",
  search: "Search past chats",
  files: "Files",
  shell: "Shell commands",
  api: "API calls with stored keys",
  schedule: "Schedules",
  browser: "Browser",
  connectors: "Connectors",
};

// ---------- home base ----------
function homeView() {
  ui.body.className = "body three";
  ui.crewCol = h("aside", { class: "side", "aria-label": "Crew" });
  ui.board = h("main", { class: "center" });
  ui.logCol = h("aside", { class: "logcol", "aria-label": "Quest log" });
  fill(ui.body, ui.crewCol, ui.board, ui.logCol);
  renderHome();
}

function renderHome() {
  if (state.view !== "home" || !ui.board) return;
  renderCrewColumn();
  renderBoard();
  renderLog();
}

/** Bots by team group, groups in name order. */
function byGroup(bots) {
  const groups = new Map();
  for (const bot of bots) groups.set(bot.group || "Other", [...(groups.get(bot.group || "Other") ?? []), bot]);
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
}

function renderCrewColumn() {
  const bots = state.crew?.bots ?? [];
  const live = new Map(state.quests.filter(isLive).map((q) => [q.bot.id, q]));
  const fromRepo = bots.some((b) => b.source === "project");
  const member = (bot) => {
    const q = live.get(bot.id);
    const status = q ? (q.status === "waiting" ? "◌ waiting on you" : `● step ${q.steps || 1}`) : bot.month?.state === "stopped" ? "■ at its monthly budget" : "idle";
    return h(
      "button",
      {
        class: `member ${bot.id === state.selectedBot ? "on" : ""}`,
        style: botStyle(bot),
        title: bot.instructions,
        onclick: () => {
          state.selectedBot = bot.id;
          remember("talqava.bot", bot.id);
          if (ui.palette) ui.palette.placeholder = paletteHint();
          if (q) go("quest", q.id);
          else renderCrewColumn();
        },
        ondblclick: () => go("bot", bot.id),
      },
      keycap(bot.character, 36, mood(q), bot.type),
      h("span", { class: "who" }, h("b", {}, bot.name), h("span", { class: "type" }, roleOf(bot.id)?.title ?? cap(bot.type)), h("span", { class: `status ${q?.status === "waiting" ? "wait" : ""}` }, status)),
      // The model is only worth a mention here when the bot has none it can use.
      bot.modelInfo?.kind ? null : modelChip(bot.modelInfo),
      h("span", { class: "plain edit", role: "button", onclick: (e) => (e.stopPropagation(), go("bot", bot.id)) }, "Edit"),
    );
  };
  fill(ui.crewCol, 
    h("div", { class: "side-head" }, h("h2", { class: "label" }, `Crew · ${bots.length}`), h("button", { class: "plain small", onclick: () => go("team"), title: "The org chart, departments and budgets" }, "Organization →")),
    fromRepo ? h("div", { class: "note small", style: "padding: 0 8px" }, ".crew/ in this repo") : null,
    ...byGroup(bots).flatMap(([group, members]) => [h("div", { class: "grouplabel" }, group), ...members.map(member)]),
    state.crew?.problems?.length ? h("div", { class: "banner error small" }, state.crew.problems.map((p) => h("div", {}, p.problem))) : null,
    h("button", { class: "hatch", onclick: () => go("market") }, "+ Add from the marketplace"),
    h("button", { class: "hatch", onclick: () => go("bot", "new") }, "+ Hatch a bot"),
    navFooter(),
  );
}

const cap = (text) => String(text).charAt(0).toUpperCase() + String(text).slice(1);

/** Pages are reached from the rail on the left, so the side columns carry no links of their own. */
function navFooter() {
  return null;
}

function renderBoard() {
  const active = state.quests.filter(isLive);
  const working = active.filter((q) => q.status === "running").length;
  const waiting = active.length - working;
  const summary = active.length ? [working && `${working} working`, waiting && `${waiting} waiting on you`, "every step saved"].filter(Boolean).join(" · ") : "";
  const selected = state.crew?.bots.find((b) => b.id === state.selectedBot);
  fill(ui.board, 
    h("div", { class: "board-head" }, h("h1", {}, "On the job"), h("span", { class: "note" }, summary)),
    active.length
      ? h("div", { class: "cards" }, ...active.map(questCard))
      : h(
          "div",
          { class: "empty-board" },
          selected ? keycap(selected.character, 72, "", selected.type) : null,
          h("h2", {}, "Nobody is on a quest"),
          h("p", {}, selected ? `Type a quest in the box at the top and ${selected.name} will go. Start it with @name to send someone else.` : "Type a quest in the box at the top."),
          h("button", { class: "primary", onclick: () => ui.palette?.focus() }, selected ? `Send ${selected.name} on a quest` : "Send a quest"),
        ),
    coreQuests(),
  );
}

/** The ready-made quests, each with the bot that goes and how its result is checked. */
function coreQuests() {
  const templates = state.templates ?? [];
  if (!templates.length) return null;
  const bots = state.crew?.bots ?? [];
  const checkWords = (c) =>
    [c.command && "runs the tests", c.changed && c.changed !== "any" && `${c.changed} changes`, c.covers && "covers everything", c.links && `${c.links}+ sources`].filter(Boolean).join(" · ");
  return h(
    "section",
    { class: "core" },
    h("div", { class: "board-head small-head" }, h("h2", {}, "Core quests"), h("span", { class: "note" }, "Ready-made, and checked before they count as done")),
    h(
      "div",
      { class: "core-grid" },
      templates.map((t) => {
        const bot = bots.find((b) => b.id === t.bot);
        return h(
          "button",
          { class: `core-card ${state.coreOpen === t.id ? "on" : ""}`, onclick: () => openCoreQuest(state.coreOpen === t.id ? null : t.id) },
          h("span", { class: "row" }, bot ? keycap(bot.character, 28, "", bot.type) : null, h("b", {}, t.name)),
          h("span", { class: "note small" }, t.summary),
          h("span", { class: "mono small muted" }, `${bot ? bot.name.toLowerCase() : t.bot} · check: ${checkWords(t.check) || "your review"}`),
        );
      }),
    ),
    state.coreOpen ? coreForm(templates.find((t) => t.id === state.coreOpen)) : null,
  );
}

function openCoreQuest(id) {
  state.coreOpen = id;
  renderHome();
  setTimeout(() => ui.board?.querySelector(".core-form input, .core-form button.primary")?.focus(), 0);
}

function coreForm(t) {
  if (!t) return null;
  const fields = t.inputs.map((input) => [input, h("input", { id: `core-${input.id}`, placeholder: input.placeholder || "", value: input.default || "" })]);
  const where =
    t.repository === "none"
      ? "Works without a repository."
      : state.project
        ? `On ${basename(state.project)}, in its own branch and copy.`
        : t.repository === "required"
          ? "Needs a repository: choose one in the box at the top left first."
          : "No repository chosen: give the GitHub repository below.";
  const start = h("button", { class: "primary" }, "Start");
  start.addEventListener("click", () =>
    attempt(async () => {
      start.disabled = true;
      start.textContent = "Gathering…";
      try {
        const inputs = Object.fromEntries(fields.map(([input, el]) => [input.id, el.value]));
        const quest = await api("POST", "quests", { template: t.id, inputs, project: state.project || undefined });
        state.coreOpen = null;
        await loadQuests();
        go("quest", quest.id);
      } finally {
        start.disabled = false;
        start.textContent = "Start";
      }
    }, ui.board),
  );
  return h(
    "div",
    { class: "card core-form" },
    h("b", {}, t.name),
    h("p", { class: "note" }, where),
    fields.map(([input, el]) => h("label", { class: "field", for: `core-${input.id}` }, `${input.label}${input.required ? "" : " (optional)"}`, el)),
    h("div", { class: "row" }, start, h("button", { onclick: () => openCoreQuest(null) }, "Cancel")),
  );
}

function questCard(q) {
  const decide = (approval, decision) => (e) => {
    e.stopPropagation();
    attempt(async () => {
      await api("POST", `conversations/${q.id}/approvals/${approval.id}`, { decision });
      await loadQuests();
      renderHome();
    }, ui.board);
  };
  const approval = q.approvals[0];
  const doing = q.activity ? `${NAMES[q.activity.name] || q.activity.name}: ${summarize(q.activity.name, q.activity.input)}` : "Thinking";
  const showOutput = q.activity && q.status === "running" && (q.activity.name === "bash" ? `$ ${q.activity.input?.command ?? ""}\n${q.activity.output}` : q.activity.output);
  return h(
    "article",
    { class: `qcard ${q.status}`, style: botStyle(q.bot), onclick: () => go("quest", q.id), tabindex: "0", onkeydown: (e) => e.key === "Enter" && go("quest", q.id) },
    q.status === "running" ? h("div", { class: "scanline", "aria-hidden": "true" }, h("span")) : null,
    h("div", { class: "head" }, h("b", {}, q.title), keycap(q.bot.character, 28, mood(q), q.bot.type)),
    approval
      ? h("div", { class: "now wait" }, `◌ ${q.bot.name.toLowerCase()} wants to use ${NAMES[approval.name] || approval.name}`)
      : h("div", { class: "now" }, `● ${q.bot.name.toLowerCase()} · step ${q.steps || 1}${q.budget?.steps ? ` of up to ${q.budget.steps}` : ""} · ${doing}`),
    approval ? h("pre", {}, approval.name === "bash" ? approval.input.command : JSON.stringify(approval.input, null, 2)) : showOutput ? h("pre", {}, showOutput.trim()) : null,
    approval?.reason || (q.readOutside && q.status === "running")
      ? h("div", { class: "caution" }, `Read outside content, so any change ${q.bot.name} wants to make now needs your approval.`)
      : null,
    approval
      ? h(
          "div",
          { class: "row" },
          h("button", { class: "primary", onclick: decide(approval, "allow") }, "Allow once"),
          approval.reason ? null : h("button", { onclick: decide(approval, "always") }, `Always for ${q.bot.name}`),
          h("button", { class: "danger", onclick: decide(approval, "deny") }, "Deny"),
        )
      : null,
    h(
      "div",
      { class: "foot" },
      q.branch ? h("span", { class: "mono" }, q.branch) : null,
      h("span", {}, q.model?.kind === "anthropic" ? "Claude" : q.model?.free ? "Local model · free" : q.model?.label || ""),
      q.cost >= 0.001 || q.budget?.spend ? h("span", {}, `${money(q.cost || 0)}${q.budget?.spend ? ` of ${money(q.budget.spend)}` : ""}`) : null,
    ),
  );
}

function renderLog() {
  const done = state.quests.filter((q) => !isLive(q));
  fill(ui.logCol, 
    h("h2", { class: "label" }, "Quest log"),
    done.length
      ? done.slice(0, 40).map((q) => {
          const [label, tone] = standing(q);
          const detail = q.status === "failed" && q.note ? q.note : q.resumedAt ? "picked up after a restart" : q.branch ? q.branch : "";
          return h(
            "button",
            { class: "logitem", style: botStyle(q.bot), onclick: () => go("quest", q.id) },
            h("div", { class: "head" }, h("b", {}, q.title), h("span", { class: `pill ${tone}` }, label)),
            h("div", { class: "meta" }, [q.bot.name, shortWhen(q.updatedAt), detail].filter(Boolean).join(" · ")),
          );
        })
      : h("p", { class: "note" }, "Finished quests appear here, with what became of them."),
  );
}

// ---------- the inbox ----------
// One place for what needs the person, what is being worked on and what got
// done, across chats and bots.
const RECENT = 3 * 24 * 3600 * 1000;
function inboxItems() {
  const quests = state.quests ?? [];
  const needs = [];
  for (const q of quests) {
    const recent = Date.now() - new Date(q.updatedAt).getTime() < RECENT;
    if (q.approvals?.length) needs.push({ kind: "approval", q, approval: q.approvals[0] });
    else if (q.branch && !q.outcome && !isLive(q) && q.status !== "failed" && q.changedFiles !== 0) needs.push({ kind: "review", q });
    else if (q.check && !q.check.passed && q.status === "done" && recent) needs.push({ kind: "check", q });
    else if (q.status === "failed" && recent) needs.push({ kind: "failed", q });
    else if (q.status === "budget" && recent) needs.push({ kind: "budget", q });
  }
  for (const c of state.convs ?? []) if (c.needsApproval) needs.push({ kind: "chat", c });
  for (const bot of state.crew?.bots ?? []) if (bot.month?.state === "stopped") needs.push({ kind: "monthly", bot });
  if (state.crew?.budgets?.total.state === "stopped") needs.push({ kind: "total" });
  const working = [...quests.filter((q) => isLive(q) && !q.approvals?.length).map((q) => ({ q })), ...(state.convs ?? []).filter((c) => c.running && !c.needsApproval).map((c) => ({ c }))];
  const today = new Date().toDateString();
  const done = quests.filter((q) => !isLive(q) && new Date(q.updatedAt).toDateString() === today && !needs.some((n) => n.q === q));
  return { needs, working, done };
}

function syncInboxCount() {
  if (!ui.inboxCount) return;
  const n = inboxItems().needs.length;
  ui.inboxCount.hidden = !n;
  ui.inboxCount.textContent = String(n);
}

function inboxView() {
  ui.body.className = "body";
  ui.log = null;
  ui.inbox = h("div", { class: "inbox" });
  fill(ui.body, h("main", { class: "center" }, ui.inbox));
  renderInbox();
  loadCrew().then(() => state.view === "inbox" && renderInbox());
}

function renderInbox() {
  if (state.view !== "inbox" || !ui.inbox) return;
  const { needs, working, done } = inboxItems();
  const act = (fn) => attempt(async () => (await fn(), await Promise.all([loadQuests(), refreshList(), loadCrew()]), renderInbox(), syncInboxCount()), ui.inbox);
  const row = (bot, title, sub, extra, buttons, tone = "") =>
    h("div", { class: `irow ${tone}`, style: bot ? botStyle(bot) : "" }, bot ? keycap(bot.character, 40, "", bot.type) : h("span", { class: "ichat", "aria-hidden": "true" }, "…"), h("div", { class: "grow" }, h("b", {}, title), h("div", { class: "note small" }, sub), extra), h("div", { class: "row" }, buttons));
  const need = (n) => {
    const { q } = n;
    if (n.kind === "approval") {
      const a = n.approval;
      const decide = (decision) => act(() => api("POST", `conversations/${q.id}/approvals/${a.id}`, { decision }));
      return row(q.bot, `${q.bot.name} wants to use ${NAMES[a.name] || a.name}`, `${q.title} · step ${q.steps || 1}`, h("pre", {}, a.name === "bash" ? a.input.command : JSON.stringify(a.input, null, 2)), [
        h("button", { class: "primary", onclick: () => decide("allow") }, "Allow once"),
        h("button", { class: "danger", onclick: () => decide("deny") }, "Don't allow"),
        h("button", { class: "plain", onclick: () => go("quest", q.id) }, "Open"),
      ]);
    }
    if (n.kind === "review") return row(q.bot, `${q.title} is ready for your review`, `${q.bot.name}${q.check?.passed ? " · passed its check" : ""} · ${q.changedFiles ?? "some"} file${q.changedFiles === 1 ? "" : "s"} changed on ${q.branch}`, null, [h("button", { class: "primary", onclick: () => go("quest", q.id) }, "Review")]);
    if (n.kind === "check") return row(q.bot, `${q.title} did not pass its check`, `${q.bot.name} · ${shortWhen(q.updatedAt)}`, null, [h("button", { onclick: () => go("quest", q.id) }, "Open")]);
    if (n.kind === "failed") return row(q.bot, `${q.title} failed`, `${q.bot.name} · ${q.note || shortWhen(q.updatedAt)}`, null, [h("button", { onclick: () => go("quest", q.id) }, "Open")]);
    if (n.kind === "budget") return row(q.bot, `${q.title} stopped at its budget`, `${q.bot.name} · say “continue” in the quest to keep going`, null, [h("button", { onclick: () => go("quest", q.id) }, "Open")]);
    if (n.kind === "chat") return row(null, "A chat is waiting for your approval", n.c.title, null, [h("button", { class: "primary", onclick: () => go("chat", n.c.id) }, "Open chat")]);
    if (n.kind === "monthly") return row(n.bot, `${n.bot.name} has reached its monthly budget`, `${money(n.bot.month.spent)} of ${money(n.bot.month.limit)} · it starts no new work until you raise it`, null, [h("button", { class: "primary", onclick: () => go("bot", n.bot.id) }, "Raise budget")]);
    return row(null, "Your bots have reached the monthly budget for all bots", "No bot starts new work until you raise it or the month turns.", null, [h("button", { class: "primary", onclick: () => go("team") }, "Change budget")]);
  };
  const live = working.filter((w) => w.q).length;
  fill(
    ui.inbox,
    h(
      "div",
      { class: "row" },
      h("div", { class: "grow" }, h("h1", {}, "Inbox"), h("p", { class: "lead" }, "What needs you, what is being worked on, and what got done today, across chats and bots.")),
      live ? h("button", { class: "danger", onclick: () => confirm(`Stop the ${live} bot${live === 1 ? "" : "s"} working now? Their work so far is kept, and you can say “continue” later.`) && act(() => Promise.all(working.filter((w) => w.q).map((w) => api("POST", `quests/${w.q.id}/stop`)))) }, "Stop all bots") : null,
    ),
    h("section", {}, h("h2", { class: `label ${needs.length ? "loud" : ""}` }, `◌ Needs you · ${needs.length}`), needs.length ? needs.map(need) : h("p", { class: "note" }, "Nothing needs you right now.")),
    h(
      "section",
      {},
      h("h2", { class: "label" }, `● Working now · ${working.length}`),
      working.length
        ? working.map((w) =>
            w.q
              ? row(w.q.bot, `${w.q.bot.name} · ${w.q.title}`, `step ${w.q.steps || 1}${w.q.activity ? ` · ${NAMES[w.q.activity.name] || w.q.activity.name}` : ""}${w.q.cost >= 0.001 ? ` · ${money(w.q.cost)} so far` : ""}`, null, [h("button", { onclick: () => go("quest", w.q.id) }, "Open"), h("button", { class: "plain", onclick: () => act(() => api("POST", `quests/${w.q.id}/stop`)) }, "Stop")])
              : row(null, w.c.title, "A chat is being answered", null, [h("button", { onclick: () => go("chat", w.c.id) }, "Open chat")]),
          )
        : h("p", { class: "note" }, "Nothing is running."),
    ),
    h(
      "section",
      {},
      h("h2", { class: "label" }, `✓ Done today · ${done.length}`),
      done.length
        ? done.map((q) => h("button", { class: "idone", onclick: () => go("quest", q.id) }, h("span", { class: "grow" }, q.title), h("span", { class: "mono small muted" }, `${q.bot.name} · ${shortWhen(q.updatedAt)} · ${standing(q)[0]}${q.cost >= 0.001 ? ` · ${money(q.cost)}` : ""}`)))
        : h("p", { class: "note" }, "Finished work from today appears here."),
    ),
  );
}

// ---------- the organization ----------
// The bots in roles: an org chart with the person at the top, departments, and
// what each bot may spend this month. Work follows the chart: a bot with
// reports hands tasks to them and gets their reports back.
async function teamView() {
  ui.body.className = "body";
  ui.log = null;
  const col = h("div", { class: "team" });
  fill(ui.body, h("main", { class: "center" }, col));
  await Promise.all([loadCrew(), loadOrgs()]);
  if (state.view !== "team") return;
  const again = () => teamView();
  const org = activeOrg();
  const bots = state.crew?.bots ?? [];
  const byId = new Map(bots.map((b) => [b.id, b]));
  const members = org.members.filter((m) => byId.has(m.bot));
  const outside = bots.filter((b) => !members.some((m) => m.bot === b.id));
  const budgets = state.crew?.budgets;
  const live = new Map(state.quests.filter(isLive).map((q) => [q.bot.id, q]));
  const total = budgets?.total ?? { spent: 0, limit: null, state: "ok" };
  const needs = inboxItems().needs.length;
  const save = (fn) => attempt(async () => (await fn(), await loadOrgs(), again()), col);
  const bar = (line, color) => {
    if (line?.limit == null) return null;
    const pct = line.limit > 0 ? Math.min(100, Math.round((line.spent / line.limit) * 100)) : 100;
    return h("div", { class: `track ${line.state}`, role: "img", "aria-label": `${pct} percent of the budget used` }, h("span", { style: `width: ${pct}%; background: ${line.state === "stopped" ? "var(--text)" : line.state === "warned" ? "#ffb020" : color || "var(--accent)"}` }));
  };
  const statusOf = (bot) => {
    const q = live.get(bot.id);
    return q ? (q.status === "waiting" ? ["◌ needs you", true] : ["● working", true]) : bot.month?.state === "stopped" ? ["■ at budget", true] : ["idle", false];
  };

  // ----- which organization -----
  const newName = h("input", { placeholder: "Name, e.g. your company", maxlength: 50, "aria-label": "Name of the new organization" });
  const newMission = h("input", { placeholder: "What it is for, in a sentence (optional)", maxlength: 300, "aria-label": "Mission" });
  const newForm = h("form", { class: "card orgform", hidden: true, onsubmit: (e) => (e.preventDefault(), save(() => api("POST", "orgs", { name: newName.value, mission: newMission.value }))) }, h("b", {}, "New organization"), h("p", { class: "note small" }, "It starts empty. Add bots to it from below or from the marketplace; a bot can be in more than one organization."), newName, newMission, h("div", { class: "row" }, h("button", { class: "primary" }, "Create organization"), h("button", { type: "button", onclick: () => (newForm.hidden = true) }, "Cancel")));
  const rename = h("input", { value: org.name, maxlength: 50, "aria-label": "Organization name" });
  const mission = h("input", { value: org.mission, maxlength: 300, placeholder: "What the organization is for, in a sentence. Every bot is told it.", "aria-label": "Mission" });
  const editForm = h(
    "form",
    { class: "card orgform", hidden: true, onsubmit: (e) => (e.preventDefault(), save(() => api("PATCH", `orgs/${org.id}`, { name: rename.value, mission: mission.value }))) },
    h("b", {}, "Name and mission"),
    rename,
    mission,
    h(
      "div",
      { class: "row" },
      h("button", { class: "primary" }, "Save"),
      h("button", { type: "button", onclick: () => (editForm.hidden = true) }, "Cancel"),
      state.orgs.orgs.length > 1 ? h("button", { type: "button", class: "plain danger", onclick: () => confirm(`Delete the organization “${org.name}”? Its chart is deleted. The bots themselves are kept.`) && save(() => api("DELETE", `orgs/${org.id}`)) }, "Delete organization") : null,
    ),
  );
  const pick = h("select", { "aria-label": "Organization", class: "orgpick" }, state.orgs.orgs.map((o) => h("option", { value: o.id, selected: o.id === org.id }, o.name)));
  pick.addEventListener("change", () => save(() => api("PATCH", `orgs/${pick.value}`, { active: true })));

  // ----- one member, on the chart or in a department -----
  const pickMember = (id) => ((ui.orgSel = ui.orgSel === id ? null : id), again());
  const node = (m) => {
    const bot = byId.get(m.bot);
    const [status, loud] = statusOf(bot);
    const reports = members.filter((x) => x.manager === m.bot).length;
    return h(
      "button",
      { class: `onode ${ui.orgSel === m.bot ? "on" : ""} ${bot.month?.state === "stopped" ? "stopped" : ""}`, style: botStyle(bot), onclick: () => pickMember(m.bot), title: `${bot.name}: ${m.title}` },
      keycap(bot.character, 44, mood(live.get(bot.id)), bot.type),
      h("b", {}, bot.name),
      m.title.toLowerCase() === bot.name.toLowerCase() ? null : h("span", { class: "otitle" }, m.title),
      h("span", { class: `mono small ${loud ? "" : "muted"}` }, reports ? `${status} · leads ${reports}` : status),
    );
  };
  const branch = (managerId) => {
    const kids = members.filter((m) => m.manager === managerId).sort((a, b) => a.department.localeCompare(b.department) || a.title.localeCompare(b.title));
    return kids.length ? h("ul", {}, kids.map((m) => h("li", {}, node(m), branch(m.bot)))) : null;
  };

  // ----- the selected member's role -----
  const detail = () => {
    const m = members.find((x) => x.bot === ui.orgSel);
    if (!m) return null;
    const bot = byId.get(m.bot);
    const title = h("input", { value: m.title, maxlength: 50 });
    const dept = h("input", { value: m.department, maxlength: 30, list: "org-depts" });
    // Nobody below this bot can become its manager.
    const below = new Set([m.bot]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const x of members) if (x.manager && below.has(x.manager) && !below.has(x.bot)) (below.add(x.bot), (grew = true));
    }
    const boss = h("select", {}, h("option", { value: "", selected: !m.manager }, "You"), members.filter((x) => !below.has(x.bot)).map((x) => h("option", { value: x.bot, selected: x.bot === m.manager }, `${byId.get(x.bot).name} · ${x.title}`)));
    const reports = members.filter((x) => x.manager === m.bot);
    const month = bot.month ?? { spent: 0, limit: null, state: "ok" };
    return h(
      "section",
      { class: "card memberbox", style: botStyle(bot) },
      h("div", { class: "row" }, keycap(bot.character, 64, mood(live.get(bot.id)), bot.type), h("div", { class: "grow" }, h("h2", {}, bot.name), h("div", { class: "note" }, bot.instructions.split(/(?<=[.!?])\s/)[0])), h("button", { class: "plain", onclick: () => pickMember(m.bot), "aria-label": "Close" }, "✕")),
      h(
        "form",
        { class: "rolegrid", onsubmit: (e) => (e.preventDefault(), save(() => api("PUT", `orgs/${org.id}/members`, { bot: m.bot, title: title.value, department: dept.value, manager: boss.value || null }))) },
        h("label", { class: "field" }, "Title", title),
        h("label", { class: "field" }, "Department", dept),
        h("label", { class: "field" }, "Reports to", boss),
        h("button", { class: "primary" }, "Save role"),
      ),
      h("p", { class: "note small" }, reports.length ? `${bot.name} can hand tasks to ${reports.map((r) => byId.get(r.bot).name).join(", ")}, and gets their reports back.` : `Nobody reports to ${bot.name}, so it does its work itself. Give it reports by setting another bot's “Reports to”.`),
      month.limit != null || month.spent >= 0.001 ? h("div", { class: "mono small muted" }, month.limit != null ? `${money(month.spent)} of ${money(month.limit)} this month` : `${money(month.spent)} this month · no limit`) : null,
      bar(month, colorOf(bot.character, bot.type)),
      h(
        "div",
        { class: "row" },
        h("button", { class: "primary", onclick: () => chatWith(bot, col) }, `Chat with ${bot.name}`),
        h("button", { onclick: () => ((state.selectedBot = bot.id), remember("talqava.bot", bot.id), go("home")) }, "Send on a quest"),
        h("button", { onclick: () => go("bot", bot.id) }, month.state === "stopped" ? "Raise budget" : "Edit bot"),
        h("button", { class: "plain danger", onclick: () => confirm(`Take ${bot.name} off the chart of ${org.name}? Its reports move up to its manager. The bot itself is kept.`) && ((ui.orgSel = null), save(() => api("DELETE", `orgs/${org.id}/members/${m.bot}`))) }, "Remove from organization"),
      ),
    );
  };

  const limit = h("input", { type: "number", min: 0, step: 1, value: total.limit ?? "", placeholder: "No limit", "aria-label": "Monthly budget for all bots, in dollars" });
  const stat = (label, value, loud) => h("div", { class: "stat" }, h("span", { class: "label" }, label), h("b", { class: loud ? "loud" : "" }, value));
  const chartView = (ui.orgView ?? "chart") === "chart";
  const depts = [...new Set(members.map((m) => m.department))].sort();
  col.append(
    ...[
      h(
        "div",
        { class: "row" },
        h("div", { class: "grow" }, h("div", { class: "row" }, h("h1", {}, org.name || "Organization"), state.orgs.orgs.length > 1 ? pick : null), h("p", { class: "lead" }, org.mission || "Your bots in roles. Work follows the chart: a bot with reports hands tasks down and brings the results back up.")),
        h("button", { onclick: () => ((editForm.hidden = !editForm.hidden), (newForm.hidden = true)) }, "Name and mission"),
        h("button", { onclick: () => ((newForm.hidden = !newForm.hidden), (editForm.hidden = true), newName.focus()) }, "＋ New organization"),
        h("button", { class: "primary", onclick: () => go("market") }, "＋ Add bots or a team"),
      ),
      editForm,
      newForm,
      h("section", { class: "stats" }, stat("Members", String(members.length)), stat("Departments", String(depts.length)), stat("Working now", String(members.filter((m) => live.has(m.bot)).length)), stat("Need you", String(needs), needs > 0), stat("Spent this month", total.limit != null ? `${money(total.spent)} of ${money(total.limit)}` : money(total.spent))),
      h(
        "div",
        { class: "row" },
        h("div", { class: "tabs flat", role: "tablist" }, h("button", { role: "tab", class: chartView ? "on" : "", onclick: () => ((ui.orgView = "chart"), again()) }, "Org chart"), h("button", { role: "tab", class: chartView ? "" : "on", onclick: () => ((ui.orgView = "depts"), again()) }, "Departments")),
        h("span", { class: "note grow" }, "Click a bot to set its title, department and who it reports to, or to chat with it."),
      ),
      members.length
        ? chartView
          ? h("div", { class: "chartwrap" }, h("div", { class: "tree" }, h("ul", {}, h("li", {}, h("div", { class: "onode you" }, h("span", { class: "youmark", "aria-hidden": "true" }, "You"), h("b", {}, "You"), h("span", { class: "otitle" }, "Owner")), branch(null)))))
          : h(
              "section",
              { class: "depts" },
              depts.map((d) => {
                const list = members.filter((m) => m.department === d).sort((a, b) => Number(Boolean(a.manager && members.find((x) => x.bot === a.manager)?.department === d)) - Number(Boolean(b.manager && members.find((x) => x.bot === b.manager)?.department === d)));
                return h("div", { class: "dept" }, h("div", { class: "row" }, h("h2", { class: "grow" }, d), h("span", { class: "mono small muted" }, `${list.length} bot${list.length === 1 ? "" : "s"}`)), h("div", { class: "deptnodes" }, list.map(node)));
              }),
            )
        : h("div", { class: "card" }, h("b", {}, `${org.name} has no bots yet.`), h("p", { class: "note" }, "Add a ready-made team from the marketplace, or add your existing bots below.")),
      detail(),
      h("datalist", { id: "org-depts" }, depts.map((d) => h("option", { value: d }))),
      outside.length
        ? h(
            "section",
            { class: "card" },
            h("h2", { class: "label" }, `Not in ${org.name} · ${outside.length}`),
            h("div", { class: "outside" }, outside.map((bot) => h("div", { class: "outbot", style: botStyle(bot) }, keycap(bot.character, 28, "", bot.type), h("span", { class: "grow" }, bot.name), h("button", { onclick: () => ((ui.orgSel = bot.id), save(() => api("PUT", `orgs/${org.id}/members`, { bot: bot.id }))) }, "Add")))),
          )
        : null,
      h(
        "section",
        { class: `card allbudget ${total.state}` },
        h("div", { class: "row" }, h("h2", { class: "label grow" }, `Budget for all bots · resets ${budgets?.resets ?? ""}`), total.state === "stopped" ? h("span", { class: "pill loud" }, "■ Stopped: no bot starts new work") : total.state === "warned" ? h("span", { class: "pill loud" }, "Past 80%") : null),
        bar(total),
        h("form", { class: "row", onsubmit: (e) => (e.preventDefault(), attempt(async () => ((state.config = await api("PUT", "settings", { monthlyBudget: limit.value === "" ? null : Number(limit.value) })), again()), col)) }, h("span", { class: "note" }, "Per month ($)"), limit, h("button", {}, "Save")),
        h("p", { class: "note small" }, "Bots are warned at 80% and start no new work at 100%, until you raise the budget or the month turns. Each bot can have its own monthly budget too. Spend is estimated from list prices."),
      ),
    ].filter(Boolean),
  );
}

// ---------- the marketplace ----------
// Free, ready-made bots, each built for one job. A bot's instructions are shown
// in full before it is added; adding saves a copy as the person's own bot.
async function loadMarket() {
  const market = await api("GET", "marketplace");
  state.market = market.bots;
  return market;
}

async function addFromMarket(bot, where) {
  await attempt(async () => {
    await api("POST", `marketplace/${bot.id}/add`);
    await Promise.all([loadMarket(), loadCrew(), loadOrgs()]);
    state.selectedBot = bot.id;
    remember("talqava.bot", bot.id);
    renderBody();
  }, where);
}

/** What a bot may use, and the risky things it cannot, in plain words. */
function powerWords(bot) {
  const can = bot.powers.map((p) => POWER_NAMES[p] || p);
  const risky = { web: "The web", files: "Your files", shell: "Shell commands", api: "API calls", browser: "A browser", schedule: "Schedules" };
  const cannot = Object.entries(risky).filter(([p]) => !bot.powers.includes(p)).map(([, label]) => label);
  return { can, cannot };
}

function marketCard(bot) {
  const add = bot.added
    ? h("button", { class: "madd", onclick: (e) => (e.stopPropagation(), go("bot", bot.id)) }, "Edit")
    : h("button", { class: "madd primary", onclick: (e) => (e.stopPropagation(), addFromMarket(bot, ui.body)) }, "Add");
  return h(
    "article",
    { class: "mcard", style: botStyle(bot), tabindex: "0", onclick: () => go("marketbot", bot.id), onkeydown: (e) => e.key === "Enter" && e.target === e.currentTarget && go("marketbot", bot.id) },
    h("div", { class: "mhead" }, keycap(bot.character, 40, "", bot.type), h("div", {}, h("b", {}, bot.name), h("div", { class: "by" }, bot.listing.title.toLowerCase() === bot.name.toLowerCase() ? `by ${bot.listing.by}` : `${bot.listing.title} · by ${bot.listing.by}`))),
    h("p", { class: "mdesc" }, bot.listing.summary),
    h("div", { class: "mfoot" }, h("span", { class: "mono small muted" }, bot.added ? "✓ On your team" : `Free · ${bot.approvals === "ask" ? "asks before changes" : "runs everything"}`), add),
  );
}

async function marketView() {
  ui.body.className = "body";
  ui.log = null;
  const col = h("div", { class: "market" });
  fill(ui.body, h("main", { class: "center" }, col));
  const market = await attempt(loadMarket, col);
  if (!market || state.view !== "market") return;
  const bots = market.bots;
  const categories = [...new Set(bots.map((b) => b.listing.category))].sort();
  const search = h("input", { type: "search", placeholder: "Search by bot name or what you need done", "aria-label": "Search bots", value: ui.marketSearch || "" });
  const pills = h("div", { class: "pills", role: "group", "aria-label": "Categories" });
  const results = h("div", { class: "msections" });
  const draw = () => {
    const cat = ui.marketCat || "";
    const needle = search.value.trim().toLowerCase();
    fill(
      pills,
      [["", "All"], ...categories.map((c) => [c, c]), ["+mine", "On my team"]].map(([id, label]) =>
        h("button", { class: `mpill ${cat === id ? "on" : ""}`, "aria-pressed": String(cat === id), onclick: () => ((ui.marketCat = id), draw()) }, label),
      ),
    );
    const match = (b) =>
      (!needle || `${b.name} ${b.listing.summary} ${b.listing.category} ${b.listing.will.join(" ")}`.toLowerCase().includes(needle)) &&
      (!cat || (cat === "+mine" ? b.added : b.listing.category === cat));
    const shown = bots.filter(match);
    const section = (title, list) => (list.length ? h("section", {}, h("h2", {}, title), h("div", { class: "mgrid" }, list.map(marketCard))) : null);
    const featured = !cat && !needle ? bots.filter((b) => b.listing.featured) : [];
    const byBot = new Map(bots.map((b) => [b.id, b]));
    const teams = (market.teams ?? []).filter((t) => (!cat || t.department === cat) && (!needle || `${t.name} ${t.summary}`.toLowerCase().includes(needle)) && cat !== "+mine");
    const teamCard = (t) => {
      const list = t.bots.map((id) => byBot.get(id)).filter(Boolean);
      const have = list.filter((b) => b.added).length;
      const add = h("button", { class: have === list.length ? "madd" : "madd primary", disabled: have === list.length }, have === list.length ? "✓ On your chart" : have ? `Add the other ${list.length - have}` : `Add all ${list.length}`);
      add.addEventListener("click", () =>
        attempt(async () => {
          add.disabled = true;
          await api("POST", `marketplace/teams/${t.id}/add`);
          await Promise.all([loadCrew(), loadOrgs()]);
          go("team");
        }, ui.body),
      );
      return h(
        "article",
        { class: "mcard tcard" },
        h("div", { class: "mhead" }, h("div", {}, h("b", {}, t.name), h("div", { class: "by" }, `${list.length} bots · lead: ${list[0]?.listing.title ?? ""}`))),
        h("div", { class: "tbots" }, list.map((b) => h("button", { class: "plain", title: `${b.name}: ${b.listing.title}`, "aria-label": b.name, style: botStyle(b), onclick: () => go("marketbot", b.id) }, keycap(b.character, 36, "", b.type)))),
        h("p", { class: "mdesc" }, t.summary),
        h("div", { class: "mfoot" }, h("span", { class: "mono small muted" }, "Free · added with their reporting lines"), add),
      );
    };
    fill(
      results,
      featured.length
        ? h(
            "section",
            {},
            h("h2", {}, "Featured"),
            h(
              "div",
              { class: "mfeatured" },
              featured.map((b) =>
                h("button", { class: "mfeat", style: botStyle(b), onclick: () => go("marketbot", b.id) }, keycap(b.character, 64, "", b.type), h("b", {}, b.name), h("span", { class: "by" }, `by ${b.listing.by}`)),
              ),
            ),
          )
        : null,
      teams.length ? h("section", {}, h("h2", {}, "Teams"), h("p", { class: "note", style: "margin: -6px 0 12px" }, "A lead and the bots that report to it, added to your organization together."), h("div", { class: "mgrid wide" }, teams.map(teamCard))) : null,
      cat || needle ? section(cat === "+mine" ? "On my team" : cat || "Results", shown) : categories.map((c) => section(c, shown.filter((b) => b.listing.category === c))),
      shown.length ? null : h("p", { class: "note" }, cat === "+mine" ? "You have not added a marketplace bot yet." : "No bot matches that. Try other words, or hatch your own bot from the Bots page."),
    );
  };
  search.addEventListener("input", () => ((ui.marketSearch = search.value), draw()));
  col.append(
    h("h1", {}, "Marketplace"),
    h("p", { class: "lead" }, "Free bots, each built for one job. Read exactly what a bot is told to do before you add it to your team."),
    pills,
    search,
    ...(market.problems?.length ? [h("div", { class: "banner error small" }, market.problems.map((p) => h("div", {}, p)))] : []),
    results,
  );
  draw();
}

async function marketBotView() {
  ui.body.className = "body";
  ui.log = null;
  const col = h("div", { class: "market" });
  fill(ui.body, h("main", { class: "center" }, col));
  const id = state.marketId;
  const market = await attempt(loadMarket, col);
  if (!market || state.view !== "marketbot" || state.marketId !== id) return;
  const bot = market.bots.find((b) => b.id === id);
  if (!bot) return go("market");
  const { can, cannot } = powerWords(bot);
  const budget = [bot.budget?.steps && `${bot.budget.steps} steps`, bot.budget?.spend != null && money(bot.budget.spend)].filter(Boolean).join(" or ");
  const copy = h("button", {}, "Copy");
  copy.addEventListener("click", () =>
    attempt(async () => {
      await navigator.clipboard.writeText(bot.instructions);
      copy.textContent = "Copied";
      setTimeout(() => (copy.textContent = "Copy"), 2000);
    }, col),
  );
  const fact = (label, value) => h("div", { class: "fact" }, h("b", {}, label), h("span", {}, value));
  const list = (title, items, cls) => (items.length ? h("div", { class: `willbox ${cls}` }, h("div", { class: "label" }, title), h("ul", {}, items.map((item) => h("li", {}, item)))) : null);
  col.append(
    h("button", { class: "plain back", onclick: () => go("market") }, "← Back to marketplace"),
    h(
      "section",
      { class: "mtop", style: botStyle(bot) },
      h(
        "div",
        { class: "grow" },
        keycap(bot.character, 88, "", bot.type),
        h("h1", {}, bot.name),
        h("div", { class: "by" }, `${bot.listing.title} · ${bot.listing.category} · by ${bot.listing.by}${bot.listing.reportsTo && market.bots.find((b) => b.id === bot.listing.reportsTo) ? ` · reports to the ${market.bots.find((b) => b.id === bot.listing.reportsTo).listing.title}` : ""}`),
        h("p", { class: "lead" }, bot.listing.summary),
        h(
          "div",
          { class: "row" },
          bot.added
            ? [h("span", { class: "mpill on" }, "✓ On your team"), h("button", { class: "primary", onclick: () => chatWith(bot, col) }, `Chat with ${bot.name}`), h("button", { onclick: () => go("bot", bot.id) }, "Edit your copy"), h("button", { onclick: () => ((state.selectedBot = bot.id), remember("talqava.bot", bot.id), go("home")) }, `Send ${bot.name} on a quest`)]
            : h("button", { class: "primary big", onclick: () => addFromMarket(bot, col) }, "Add to my team · Free"),
        ),
      ),
      h(
        "aside",
        { class: "facts", "aria-label": "At a glance" },
        fact("Price", "Free"),
        fact("Can use", can.join(", ") || "Nothing but the conversation"),
        fact("Cannot use", cannot.join(", ") || "—"),
        fact("Asks first", bot.approvals === "ask" ? "Before any change, command or API write" : "No: runs everything"),
        fact("Model", bot.model || "Your default model"),
        fact("Limit per job", budget || "Your default limits"),
      ),
    ),
    h(
      "section",
      { class: "minstr" },
      h("div", { class: "row" }, h("h2", { class: "grow" }, "Instructions"), h("span", { class: "mono small muted" }, "shown in full · nothing hidden"), copy),
      h("div", { class: "instructions" }, bot.instructions.split(/\n+/).filter((para) => para.trim()).map((para) => h("p", {}, para.trim()))),
      h("div", { class: "willrow" }, list("✓ Will do", bot.listing.will, "will"), list("✕ Will not do", bot.listing.wont, "wont")),
      h("p", { class: "note" }, bot.added ? "This bot is on your team. Your copy is yours to edit, and it never changes unless you change it." : "After you add a bot, these instructions are yours to edit. Your copy never changes unless you change it."),
    ),
  );
}

// ---------- one quest ----------
function questView() {
  ui.body.className = "body questview";
  ui.qhead = h("div", { class: "subhead" });
  ui.qsteps = h("aside", { class: "side" });
  ui.qcenter = h("main", { class: "center flush" });
  ui.qright = h("aside", { class: "logcol" });
  fill(ui.body, ui.qhead, h("div", { class: "questcols" }, ui.qsteps, ui.qcenter, ui.qright));

  ui.tab = null;
  ui.tabs = h("div", { class: "tabs", role: "tablist" });
  ui.changesPanel = h("div", { class: "tabpanel pad", hidden: true });
  ui.convoPanel = h("div", { class: "tabpanel" }, conversationPane());
  fill(ui.qcenter, ui.tabs, ui.changesPanel, ui.convoPanel);
  ui.title = h("span");
  ui.meta = h("span", { class: "meta" });
  ui.changesFor = null;
  setRunning(false);
  connect(state.convId);
  refreshQuest(true);
}

async function refreshQuest(first = false) {
  const id = state.convId;
  let q;
  try {
    q = await api("GET", `quests/${id}`);
  } catch {
    go("home");
    return;
  }
  if (state.view !== "quest" || state.convId !== id) return;
  const changed = !state.quest || state.quest.id !== q.id || state.quest.status !== q.status || state.quest.outcome !== q.outcome;
  state.quest = q;
  const [label, tone] = standing(q);
  const where = q.branch ? ["on branch ", h("code", {}, q.branch), " · your own branch is untouched"] : q.project ? [`in ${basename(q.project)}`] : ["in the workspace folder"];
  fill(ui.qhead, 
    h("button", { onclick: () => go("home") }, "Back to bots"),
    keycap(q.bot.character, 40, mood(q), q.bot.type),
    h(
      "div",
      { class: "titles" },
      h("h1", {}, q.title),
      h("div", { class: "sub" }, `${q.bot.name}${roleOf(q.bot.id) ? `, ${roleOf(q.bot.id).title}` : ` the ${cap(q.bot.type)}`} · `, ...where, q.parent ? [" · assigned by ", h("button", { class: "plain link", onclick: () => go(q.parent.isQuest ? "quest" : "chat", q.parent.id) }, q.parent.by)] : null),
    ),
    ui.meta,
    h("span", { class: `pill solid ${tone}` }, label),
    h(
      "button",
      {
        class: "plain danger",
        title: "Delete this quest",
        onclick: () =>
          confirm(q.branch && !q.outcome ? "Delete this quest and undo its changes?" : "Delete this quest from the log?") &&
          attempt(async () => {
            await api("DELETE", `quests/${q.id}`);
            await loadQuests();
            go("home");
          }),
      },
      "Delete",
    ),
  );
  renderQuestRight(q);
  renderTabs(q, first || changed);
  const conversation = await api("GET", `conversations/${id}`).catch(() => null);
  if (conversation && state.convId === id) renderSteps(q, conversation);
}

function renderTabs(q, pickDefault) {
  // A finished code quest opens on its changes, and stays there after they are kept or undone.
  const reviewable = q.branch && !isLive(q);
  const tabs = [...(q.branch ? [["changes", "Changes"]] : []), ["conversation", "Conversation"]];
  if (pickDefault || !tabs.some(([key]) => key === ui.tab)) ui.tab = reviewable ? "changes" : "conversation";
  const show = (key, focus = false) => {
    ui.tab = key;
    ui.changesPanel.hidden = key !== "changes";
    ui.convoPanel.hidden = key !== "conversation";
    for (const b of ui.tabs.children) b.classList.toggle("on", b.dataset.key === key);
    if (key === "changes") renderChanges(q);
    if (key === "conversation" && focus) ui.input?.focus();
  };
  fill(ui.tabs, ...tabs.map(([key, label]) => h("button", { role: "tab", "data-key": key, onclick: () => show(key, true) }, label)));
  show(ui.tab);
}

async function renderChanges(q) {
  const panel = ui.changesPanel;
  const stamp = `${q.id}:${q.status}:${q.outcome}`;
  if (ui.changesFor === stamp) return;
  ui.changesFor = stamp;
  if (q.outcome === "accepted") {
    fill(panel, h("div", { class: "decide" }, h("b", {}, "Changes kept."), h("p", { class: "note" }, `They are one commit on ${q.branch}. To bring them into your branch, run: git merge ${q.branch}`)));
    return;
  }
  if (q.outcome) {
    fill(panel, h("div", { class: "decide" }, h("b", {}, q.outcome === "undone" ? "Quest undone." : "The quest changed nothing."), h("p", { class: "note" }, "Its branch and working copy were removed.")));
    return;
  }
  if (isLive(q)) {
    fill(panel, h("p", { class: "note" }, "You can review the changes when the quest stops. Its work so far is in the Conversation tab."));
    return;
  }
  const changes = await attempt(() => api("GET", `quests/${q.id}/changes`), panel);
  if (!changes || state.quest?.id !== q.id) return;
  const files = splitDiff(changes.diff);
  const tab = ui.tabs.querySelector('[data-key="changes"]');
  if (tab) tab.textContent = `Changes · ${changes.files.length} file${changes.files.length === 1 ? "" : "s"}`;
  fill(panel, 
    ...(changes.files.length
      ? changes.files.map((f) => {
          const body = files.get(f.path) ?? [];
          const isNew = body.some((line) => line.startsWith("new file"));
          return h(
            "section",
            { class: "filediff" },
            h("div", { class: "fhead" }, h("span", { class: "grow" }, f.path), isNew ? h("span", { class: "muted" }, "new file") : null, h("span", { class: "plus" }, `+${f.added}`), h("span", { class: "minus" }, `−${f.removed}`)),
            h(
              "pre",
              {},
              body
                .filter((line) => !/^(diff --git|index |new file|deleted file|--- |\+\+\+ )/.test(line))
                .map((line) => h("span", { class: line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : line.startsWith("@@") ? "hunk" : "" }, line || " ")),
            ),
          );
        })
      : [h("p", { class: "note" }, "The quest changed no files.")]),
    changes.truncated ? h("p", { class: "note" }, "Some of the changes are too long to show here.") : null,
    h(
      "div",
      { class: "decide" },
      h("div", {}, h("b", {}, changes.files.length ? "Ready for your review. " : "Nothing to keep. "), h("span", { class: "muted" }, "Keeping makes one commit on the quest's branch; your current branch stays as it is.")),
      h(
        "div",
        { class: "row" },
        changes.files.length ? h("button", { class: "primary", onclick: () => attempt(async () => (await api("POST", `quests/${q.id}/accept`), afterDecision()), panel) }, "Keep the changes") : null,
        changes.files.length ? h("button", { onclick: () => (renderTabs(q, false), ui.tabs.querySelector('[data-key="conversation"]').click(), (ui.input.placeholder = `Tell ${q.bot.name} what to change…`)) }, "Ask for changes") : null,
        h(
          "button",
          { class: "danger", onclick: () => confirm("Throw away everything this quest changed?") && attempt(async () => (await api("POST", `quests/${q.id}/undo`), afterDecision()), panel) },
          changes.files.length ? "Undo whole quest" : "Close the branch",
        ),
      ),
    ),
  );
}

async function afterDecision() {
  ui.changesFor = null;
  await loadQuests();
  await refreshQuest(true);
}

/** The diff of each file, keyed by its path. */
function splitDiff(diff) {
  const files = new Map();
  let current = null;
  for (const line of diff.split("\n")) {
    const head = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (head) files.set(head[2], (current = []));
    if (current) current.push(line);
  }
  return files;
}

function renderSteps(q, conversation) {
  const results = new Map();
  for (const m of conversation.messages) {
    if (m.role === "user" && Array.isArray(m.content)) for (const b of m.content) if (b.type === "tool_result") results.set(b.tool_use_id, b);
  }
  const steps = [];
  for (const m of conversation.messages) {
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b.type !== "tool_use" && b.type !== "server_tool_use") continue;
      const result = results.get(b.id);
      const mark = b.type === "server_tool_use" ? "ok" : result ? (result.is_error ? "bad" : "ok") : q.status === "waiting" ? "wait" : isLive(q) ? "now" : "bad";
      steps.push([mark, NAMES[b.name] || b.name, summarize(b.name, b.input)]);
    }
  }
  const mark = (kind) => h("span", { class: `mark ${kind === "ok" ? "" : kind}` }, kind === "ok" ? "✓" : kind === "bad" ? "✗" : "");
  const end = q.status === "waiting" ? ["wait", "Waiting for your approval"] : isLive(q) ? ["now", "Working"] : q.branch && !q.outcome ? ["wait", "Waiting for your review"] : null;
  const powers = q.bot.powers ?? [];
  const missing = ["web", "files", "shell", "api"].filter((p) => !powers.includes(p));
  fill(ui.qsteps, 
    h("h2", { class: "label" }, "Steps"),
    h(
      "ul",
      { class: "steps" },
      steps.length ? steps.map(([kind, name, what]) => h("li", {}, mark(kind), h("span", {}, `${name} `, what ? h("code", {}, what.length > 60 ? `${what.slice(0, 60)}…` : what) : null))) : h("li", { class: "muted" }, "No tools used yet."),
      end ? h("li", {}, mark(end[0]), h("span", {}, end[1])) : null,
    ),
    h("h2", { class: "label" }, "Safety"),
    h(
      "p",
      { class: "note" },
      q.branch
        ? `Works on its own branch and copy of ${basename(q.project)}, started from your last commit. Undo removes every trace.`
        : "Works in the workspace folder. Shell commands and file changes ask first unless the bot runs everything.",
    ),
    h("p", { class: "note" }, `Powers: ${powers.map((p) => (POWER_NAMES[p] || p).toLowerCase()).join(", ") || "none"}.${missing.length ? ` No ${missing.map((p) => ({ web: "web", files: "files", shell: "shell", api: "API calls" })[p]).join(", no ")}.` : ""}`),
    q.readOutside ? h("p", { class: "note" }, "It has read outside content, so every change asks first.") : null,
    q.resumedAt ? h("p", { class: "note" }, `Picked up again after the app restarted, ${when(q.resumedAt)}.`) : null,
  );
}

/** The step budget as a row of ticks, one per step (grouped when there are many). */
function stepTicks(used, total) {
  if (!total) return null;
  const per = Math.ceil(total / 60);
  const count = Math.ceil(total / per);
  const filled = Math.min(count, Math.ceil(used / per));
  return h("div", { class: "ticks", role: "img", "aria-label": `${used} of ${total} steps used` }, Array.from({ length: count }, (_, i) => h("span", { class: i < filled ? "on" : "" })));
}

/** The quest's check: each item passed or failed, with what was found. */
function checkBlock(q) {
  if (!q.template) return null;
  const handOver =
    q.check && !q.check.passed && !q.checking && !isLive(q) && !q.outcome && q.model?.kind !== "anthropic"
      ? h(
          "button",
          { class: "primary", onclick: () => attempt(async () => (await api("POST", `quests/${q.id}/escalate`, {}), await loadQuests(), refreshQuest(true)), ui.qright) },
          "Hand to Claude",
        )
      : null;
  return h(
    "section",
    { class: "panel-block" },
    h("h2", { class: "label" }, "Check"),
    q.checking
      ? h("p", { class: "mono small" }, "◌ checking the result…")
      : q.check
        ? h(
            "ul",
            { class: "checks-list" },
            q.check.items.map((item) => h("li", {}, h("span", { class: "mark" }, item.passed ? "✓" : "✕"), h("span", {}, item.label, item.detail && !item.passed ? h("pre", {}, item.detail) : null))),
          )
        : h("p", { class: "note" }, isLive(q) ? "Runs when the bot says it is done. A failed check goes back to the bot to fix." : "Not checked."),
    q.template.tries ? h("p", { class: "note" }, `Sent back to fix ${q.template.tries} time${q.template.tries === 1 ? "" : "s"} (up to ${q.template.maxTries}).`) : null,
    q.handedTo ? h("p", { class: "note" }, `Handed to ${q.handedTo}.`) : null,
    handOver ? [h("p", { class: "note" }, "The check still fails. A stronger model can pick up where this one stopped."), handOver] : null,
  );
}

function renderQuestRight(q) {
  const spend = q.budget?.spend;
  const share = spend ? Math.min(1, (q.cost || 0) / spend) : q.budget?.steps ? Math.min(1, q.steps / q.budget.steps) : 0;
  const bot = state.crew?.bots.find((b) => b.id === q.bot.id);
  fill(ui.qright,
    checkBlock(q),
    h(
      "section",
      { class: "panel-block" },
      h("h2", { class: "label" }, "Budget"),
      stepTicks(q.steps, q.budget?.steps),
      h("div", { class: "mono small" }, `${money(q.cost || 0)}${spend ? ` of ${money(spend)}` : ""} · ${q.steps} of ${q.budget?.steps ?? "?"} steps`),
      h("p", { class: "note" }, `${q.bot.name} stops and asks when either runs out.`),
    ),
    h(
      "section",
      { class: "panel-block" },
      h("h2", { class: "label" }, "Model"),
      h("div", {}, q.model?.label || "Default model"),
      h("p", { class: "note" }, q.model?.kind === "anthropic" ? "Claude, on your key." : q.model?.free ? "Free, on this computer." : q.model?.kind ? "On your key with this provider." : ""),
    ),
    h(
      "section",
      { class: "panel-block" },
      h("h2", { class: "label" }, q.bot.name),
      h("div", { class: "mono small muted" }, `${q.bot.type} · [${legendOf(q.bot.character, q.bot.type)}] · ${(TEXTURES[textureOf(q.bot.character, q.bot.type)] || "").toLowerCase()} base`),
      h("p", { class: "note" }, q.bot.source === "project" ? "From the repository's .crew/ folder." : q.bot.source === "personal" ? "Your own bot." : "A starter bot."),
      bot ? h("button", { onclick: () => go("bot", bot.id) }, `Edit ${q.bot.name}`) : null,
    ),
  );
}

// ---------- a bot ----------
function botView() {
  ui.body.className = "body questview";
  const isNew = state.botId === "new";
  const existing = state.crew?.bots.find((b) => b.id === state.botId);
  if (!isNew && !existing) return go("home");
  const draft = structuredClone(
    existing ?? {
      id: "",
      name: "",
      type: "scout",
      character: { legend: "?", texture: "dots", color: "cyan" },
      instructions: "",
      model: undefined,
      powers: ["web", "memory"],
      approvals: "ask",
      budget: { steps: state.config.budget.steps, spend: state.config.budget.spend },
      source: "personal",
    },
  );
  const fileNote =
    isNew || existing.source === "personal"
      ? `${state.config.dataDir}/crew/${isNew ? "<name>" : existing.id}.yaml`
      : `Saving makes your own copy in ${state.config.dataDir}/crew/${existing.id}.yaml; the ${existing.source === "project" ? "repository's" : "starter"} file stays as it is.`;
  const save = h("button", { class: "primary" }, "Save");
  const head = h(
    "div",
    { class: "subhead" },
    h("button", { onclick: () => go("home") }, "Back to bots"),
    h("div", { class: "titles" }, h("h1", {}, isNew ? "Hatch a bot" : `Edit ${existing.name}`), h("div", { class: "sub mono" }, fileNote)),
    !isNew && existing.source === "personal"
      ? h(
          "button",
          {
            class: "plain danger",
            onclick: () =>
              confirm(`Remove your ${existing.name}? A starter bot of the same name comes back.`) &&
              attempt(async () => {
                await api("DELETE", `crew/${existing.id}`);
                await loadCrew();
                go("home");
              }, head),
          },
          "Remove my version",
        )
      : null,
    save,
  );

  // ----- portrait -----
  const portrait = h("aside", { class: "portrait" });
  draft.character.legend = legendOf(draft.character, draft.type);
  const legendInput = h("input", {
    id: "legend",
    value: draft.character.legend,
    maxlength: 6,
    autocomplete: "off",
    style: "text-align: center; font-family: var(--mono); font-size: 18px; max-width: 120px",
    oninput: (e) => {
      const chars = [...e.target.value.replace(/\s/g, "")].slice(0, 3).join("");
      if (chars) {
        draft.character.legend = chars;
        portrait.querySelector(".keychar")?.replaceWith(keycap(draft.character, 150, "", draft.type));
      }
    },
  });
  const drawPortrait = () => {
    draft.character.texture = textureOf(draft.character, draft.type);
    draft.character.color = colorName(draft.character, draft.type);
    fill(portrait,
      keycap(draft.character, 150, "", draft.type),
      h("h2", {}, draft.name || "New bot"),
      h("div", { class: "type" }, cap(draft.type || "bot")),
      h("p", { class: "label", style: "margin-top: 22px" }, `Glow · ${NEON[draft.character.color][0]}`),
      swatches(draft.character.color, (name) => ((draft.character.color = name), drawPortrait()), "Glow colour"),
      ...[
        ["shape", "Body", SHAPES],
        ["eyes", "Eyes", EYES],
        ["top", "On top", TOPS],
      ].flatMap(([key, label, options]) => [
        h("p", { class: "label", style: "margin-top: 14px" }, `${label} · ${options[looksOf(draft.character)[key]]}`),
        h(
          "div",
          { class: "lookrow", role: "group", "aria-label": label },
          Object.entries(options).map(([value, name]) =>
            h(
              "button",
              { class: `look ${looksOf(draft.character)[key] === value ? "on" : ""}`, title: name, "aria-label": name, "aria-pressed": String(looksOf(draft.character)[key] === value), onclick: () => ((draft.character[key] = value), drawPortrait()) },
              keycap({ ...draft.character, [key]: value }, 30, "", draft.type),
            ),
          ),
        ),
      ]),
      h("label", { class: "label", for: "legend", style: "display: block; margin-top: 22px" }, "Key legend"),
      legendInput,
      h("p", { class: "note small" }, "One to three characters printed on the key, such as ? or </>."),
      h("p", { class: "label", style: "margin-top: 16px" }, "Texture on its base"),
      h(
        "div",
        { class: "textures" },
        Object.entries(TEXTURES).map(([key, name]) =>
          h(
            "button",
            {
              class: `texture ${key === draft.character.texture ? "on" : ""}`,
              "aria-pressed": String(key === draft.character.texture),
              title: name,
              onclick: () => ((draft.character.texture = key), drawPortrait()),
            },
            keycap({ legend: draft.character.legend, texture: key, color: draft.character.color }, 30, "", draft.type),
            h("span", {}, name),
          ),
        ),
      ),
    );
  };
  drawPortrait();

  // ----- job -----
  const name = h("input", { value: draft.name, placeholder: "e.g. Pip", maxlength: 40, oninput: (e) => ((draft.name = e.target.value), drawPortrait()) });
  const types = ["scout", "scribe", "maker", "keeper", "counter", "spark"];
  const TYPE_WORDS = { scout: "finds things out", scribe: "writes", maker: "builds code", keeper: "remembers and checks", counter: "works with numbers", spark: "comes up with ideas" };
  const type = h(
    "select",
    {
      onchange: (e) => {
        if (draft.character.legend === LEGENDS[draft.type]) draft.character.legend = LEGENDS[e.target.value] ?? draft.character.legend;
        if (draft.character.texture === TYPE_TEXTURES[draft.type]) draft.character.texture = TYPE_TEXTURES[e.target.value] ?? draft.character.texture;
        if (draft.character.color === TYPE_COLORS[draft.type]) draft.character.color = TYPE_COLORS[e.target.value] ?? draft.character.color;
        draft.type = e.target.value;
        legendInput.value = draft.character.legend;
        drawPortrait();
      },
    },
    [...new Set([...types, draft.type])].map((t) => h("option", { value: t, selected: t === draft.type }, `${cap(t)}${TYPE_WORDS[t] ? ` · ${TYPE_WORDS[t]}` : ""}`)),
  );
  const instructions = h("textarea", { rows: 7, placeholder: "What this bot does and how. Plain sentences work best." }, draft.instructions);

  // ----- model -----
  const providers = state.config.providers;
  const current = draft.model;
  const useDefault = h("input", { type: "radio", name: "model", checked: !current });
  const useOwn = h("input", { type: "radio", name: "model", checked: Boolean(current) });
  const slash = current ? current.indexOf("/") : -1;
  const provider = h(
    "select",
    { onfocus: () => (useOwn.checked = true) },
    providers.map((p) => h("option", { value: p.id, selected: current ? current.slice(0, slash) === p.id : p.id !== "anthropic" }, p.name)),
  );
  const modelName = h("input", { value: current ? current.slice(slash + 1) : "", list: "bot-models", placeholder: "Model name, e.g. qwen3:8b or claude-sonnet-5-5", onfocus: () => (useOwn.checked = true) });
  const botModels = h("datalist", { id: "bot-models" });
  const listModels = () => api("GET", `providers/${encodeURIComponent(provider.value)}/models`).then((r) => fill(botModels, r.models.map((m) => h("option", { value: m })))).catch(() => {});
  provider.addEventListener("change", listModels);
  listModels();
  const checks = h("div");
  const showCheck = () => {
    const ref = useOwn.checked ? `${provider.value}/${modelName.value.trim()}` : state.config.model;
    const result = state.config.modelChecks?.[ref];
    fill(checks, 
      result
        ? h(
            "div",
            { class: "checks" },
            h("b", {}, "Model check"),
            [
              [result.instructions, "Follows instructions"],
              [result.tools, "Uses tools"],
              [result.multiStep, "Chains several steps"],
            ].map(([ok, label]) => h("div", {}, h("span", { class: ok ? "yes" : "no" }, ok ? "✓ " : "! "), label)),
            h("div", { class: "muted" }, result.recommended.includes(cap(draft.type)) ? `Good enough for a ${cap(draft.type)}.` : `Not recommended for a ${cap(draft.type)}. Good for: ${result.recommended.join(", ")}.`),
          )
        : h("p", { class: "note" }, "This model has not been checked yet. Check it under Settings."),
    );
  };
  for (const el of [provider, modelName, useDefault, useOwn]) el.addEventListener("change", showCheck);
  showCheck();

  // ----- powers -----
  const powerBoxes = Object.keys(POWER_NAMES).map((p) => [p, h("input", { type: "checkbox", checked: draft.powers.includes(p) })]);

  // ----- limits -----
  const approvals = h(
    "select",
    {},
    h("option", { value: "ask", selected: draft.approvals !== "auto" }, "Ask before any change (default)"),
    h("option", { value: "auto", selected: draft.approvals === "auto" }, "Run everything without asking"),
  );
  const spend = h("input", { type: "number", min: 0, max: 100, step: 0.05, value: draft.budget?.spend ?? "" });
  const steps = h("input", { type: "number", min: 1, max: 500, step: 1, value: draft.budget?.steps ?? "" });

  const group = h("input", { value: draft.group || "", placeholder: "e.g. Research", maxlength: 30, list: "team-groups", autocomplete: "off" });
  const groupList = h("datalist", { id: "team-groups" }, [...new Set((state.crew?.bots ?? []).map((b) => b.group))].map((g) => h("option", { value: g })));
  const monthly = h("input", { type: "number", min: 0, max: 10000, step: 0.5, value: draft.monthly ?? "", placeholder: "No limit" });
  save.addEventListener("click", () =>
    attempt(async () => {
      const body = {
        group: group.value.trim(),
        ...(monthly.value !== "" ? { monthly: Number(monthly.value) } : {}),
        name: name.value.trim(),
        type: type.value,
        character: draft.character,
        instructions: instructions.value.trim(),
        model: useOwn.checked && modelName.value.trim() ? `${provider.value}/${modelName.value.trim()}` : "default",
        powers: powerBoxes.filter(([, box]) => box.checked).map(([p]) => p),
        approvals: approvals.value,
        budget: { ...(steps.value ? { steps: Number(steps.value) } : {}), ...(spend.value !== "" ? { spend: Number(spend.value) } : {}) },
      };
      const saved = await api("PUT", `crew/${isNew ? "new" : existing.id}`, body);
      await loadCrew();
      state.selectedBot = saved.id;
      remember("talqava.bot", saved.id);
      go("home");
    }, head),
  );

  fill(ui.body, 
    head,
    h(
      "div",
      { class: "editor" },
      portrait,
      h(
        "div",
        { class: "editcards" },
        h("section", { class: "card" }, h("h3", {}, "Job"), h("label", { class: "field" }, "Name", name), h("label", { class: "field" }, "Type", type), h("label", { class: "field" }, "Instructions", instructions)),
        h(
          "section",
          { class: "card" },
          h("h3", {}, "Model"),
          h("label", { class: "choice" }, useDefault, h("span", {}, h("b", {}, "Default model"), h("div", { class: "note" }, `The one chosen in Settings: ${state.config.model}`))),
          h("label", { class: "choice" }, useOwn, h("span", { class: "grow" }, h("b", {}, "A model of its own"), h("div", { class: "form" }, provider, modelName, botModels))),
          checks,
        ),
        h(
          "section",
          { class: "card" },
          h("h3", {}, "Powers"),
          powerBoxes.map(([p, box]) => h("label", { class: "power" }, box, POWER_NAMES[p])),
          h("p", { class: "note" }, "A bot only gets the tools its powers grant. Changes ask first by default, and always after reading the web."),
        ),
        h(
          "section",
          { class: "card" },
          h("h3", {}, "Limits"),
          h("label", { class: "field" }, "Approvals", approvals),
          h("div", { class: "row" }, h("label", { class: "field grow" }, "Budget per quest ($)", spend), h("label", { class: "field grow" }, "Steps per quest", steps)),
          h("div", { class: "row" }, h("label", { class: "field grow" }, "Budget per month ($)", monthly), h("label", { class: "field grow" }, "Team group", group, groupList)),
          h("p", { class: "note small" }, existing?.month ? `Spent this month: ${money(existing.month.spent)}. At its monthly budget a bot starts no new work until you raise it or the month turns.` : "At its monthly budget a bot starts no new work until you raise it or the month turns."),
        ),
      ),
    ),
  );
  if (isNew) name.focus();
}

// ---------- chats ----------
function conversationPane() {
  ui.log = h("div", { class: "col" });
  ui.scroll = h("div", { class: "scroll" }, ui.log);
  ui.input = h("textarea", { rows: 1, placeholder: `Message ${speaker()}…` });
  ui.send = h("button", { class: "primary" }, "Send");
  ui.cards = new Map();
  ui.stream = null;
  ui.working = null;
  ui.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit();
    }
  });
  ui.input.addEventListener("input", () => {
    ui.input.style.height = "auto";
    ui.input.style.height = `${Math.min(ui.input.scrollHeight, 240)}px`;
  });
  ui.send.addEventListener("click", () => (state.running ? attempt(() => api("POST", `conversations/${state.convId}/stop`)) : submit()));
  state.running = false;
  return h("div", { class: "convo" }, ui.scroll, h("div", { class: "compose" }, h("div", { class: "col" }, ui.input, ui.send)));
}

function chatView() {
  ui.body.className = "body two";
  ui.chatSide = h("aside", { class: "side" });
  const withBot = chatBotOf();
  ui.title = h("h1", {}, "New chat");
  ui.meta = h("span", { class: "meta" });
  ui.remove = h("button", { class: "plain danger", title: "Delete this chat", onclick: deleteChat, hidden: !state.convId }, "Delete");
  // An open chat shows the space it belongs to, wherever it was opened from.
  const open = state.convs.find((c) => c.id === state.convId);
  if (open && (open.space || "") !== state.space) setSpace(open.space);
  ui.move = moveChatPicker();
  ui.pin = h("button", { class: "plain", hidden: true, onclick: () => pinChat({ id: state.convId }, !state.convs.find((c) => c.id === state.convId)?.pinned) }, "Pin");
  syncPin();
  const pane = conversationPane();
  fill(ui.body, ui.chatSide, h("main", { class: "center flush" }, h("div", { class: "chathead", style: withBot ? botStyle(withBot) : "" }, withBot ? keycap(withBot.character, 28, "", withBot.type) : null, ui.title, withBot ? h("span", { class: "mono small muted", title: "This chat is with one bot, in its role. It uses that bot's instructions, powers, model and limits." }, roleOf(withBot.id)?.title ?? cap(withBot.type)) : null, ui.meta, ui.move, withBot ? null : modelPicker(), ui.pin, ui.remove), pane));
  renderChatList();
  setRunning(false);
  if (state.convId) connect(state.convId);
  else {
    const ideas = ["Summarize the news on a topic I care about", "Help me write an email", "Explain something step by step", "Find and compare options for me"];
    ui.log.append(
      h(
        "div",
        { class: "empty" },
        h("h2", {}, `Hello. I'm ${state.config.agentName}.`),
        h("p", {}, "Ask me anything. I can search the web, work with files and remember what matters to you. Pick any AI model at the top right."),
        state.space
          ? h("p", { class: "note" }, `This chat is in ${spaceName(state.space)}. I use ${spaceName(state.space)}'s memory along with your general memory, and what I learn here stays in ${spaceName(state.space)}.`)
          : null,
        h(
          "div",
          { class: "ideas" },
          ideas.map((idea) => h("button", { onclick: () => ((ui.input.value = `${idea}: `), ui.input.focus()) }, idea)),
        ),
        h("p", { class: "note small" }, "Want a task done in the background? ", h("button", { class: "plain link", onclick: () => go("home") }, "Send a bot"), " instead."),
      ),
    );
  }
  ui.input.focus();
}

/**
 * Choose the AI model right where you chat. Lists Claude's models and every
 * model the other providers (Ollama, LM Studio and so on) say they have.
 */
function modelPicker() {
  const c = state.config;
  const pick = h("select", { class: "modelpick", "aria-label": "AI model", title: "The AI model that answers" });
  const label = (ref) => {
    const slash = ref.indexOf("/");
    const provider = c.providers.find((p) => p.id === ref.slice(0, slash));
    const name = ref.slice(slash + 1);
    if (provider?.kind === "anthropic") return `Claude · ${c.models.find((m) => m.id === name)?.label || name}`;
    return `${provider?.name || ref.slice(0, slash)} · ${name}`;
  };
  const show = (refs) => {
    const all = [...new Set([c.model, ...refs])];
    fill(
      pick,
      all.map((ref) => h("option", { value: ref, selected: ref === c.model }, label(ref))),
      h("option", { value: "" }, "Add or set up models…"),
    );
  };
  show([]);
  Promise.all(
    c.providers.map(async (p) => {
      if (p.kind === "anthropic") return c.hasApiKey ? c.models.map((m) => `${p.id}/${m.id}`) : [];
      const listed = await api("GET", `providers/${encodeURIComponent(p.id)}/models`).catch(() => ({ models: [] }));
      return listed.models.map((m) => `${p.id}/${m}`);
    }),
  ).then((lists) => pick.isConnected && show(lists.flat()));
  pick.addEventListener("change", () => {
    if (!pick.value) return go("settings");
    attempt(async () => {
      state.config = await api("PUT", "settings", { model: pick.value });
    });
  });
  return pick;
}

/** Moves the open chat to another space. Hidden until the chat exists. */
function moveChatPicker() {
  const pick = h(
    "select",
    { class: "modelpick", "aria-label": "Project of this chat", title: "The project this chat belongs to. Choose another to move it.", hidden: !state.convId || !state.spaces.length },
    h("option", { value: "", selected: !state.space }, "In General"),
    state.spaces.map((sp) => h("option", { value: sp.id, selected: sp.id === state.space }, `In ${sp.name}`)),
  );
  pick.addEventListener("change", () =>
    attempt(async () => {
      await api("PATCH", `conversations/${state.convId}`, { space: pick.value || null });
      setSpace(pick.value);
      await refreshList();
      renderChatList();
    }),
  );
  return pick;
}

/** The project picker at the top of the chat list, with a button to add one. Chats and memory are shown per project. */
function spacePicker() {
  if (ui.addingSpace) {
    const name = h("input", { placeholder: "Name, e.g. a client or a piece of work", maxlength: 40, "aria-label": "Name of the new project" });
    const cancel = () => ((ui.addingSpace = false), renderChatList(true));
    const form = h(
      "form",
      {
        class: "spaceform",
        onsubmit: (e) => {
          e.preventDefault();
          attempt(async () => {
            const made = await api("POST", "spaces", { name: name.value });
            ui.addingSpace = false;
            await loadSpaces();
            setSpace(made.id);
            go("chat");
          }, form);
        },
      },
      h("span", { class: "sidelabel" }, "New project"),
      name,
      h("p", { class: "note small" }, "A project keeps its own chats and memory, apart from the rest."),
      h("div", { class: "row" }, h("button", { class: "primary" }, "Create project"), h("button", { type: "button", onclick: cancel }, "Cancel")),
    );
    setTimeout(() => name.focus(), 0);
    return form;
  }
  const pick = h(
    "select",
    { "aria-label": "Project", title: "A project keeps its own chats and memory, apart from the rest." },
    h("option", { value: "", selected: !state.space }, "General"),
    state.spaces.map((sp) => h("option", { value: sp.id, selected: sp.id === state.space }, sp.name)),
    state.spaces.length ? h("option", { value: "+manage" }, "Manage projects…") : null,
  );
  pick.addEventListener("change", () => {
    if (pick.value === "+manage") return go("memory");
    setSpace(pick.value);
    go("chat");
  });
  return h(
    "div",
    { class: "projects" },
    h("label", { class: "sidelabel" }, "Project", pick),
    h("button", { class: "newproject", onclick: () => ((ui.addingSpace = true), renderChatList(true)) }, "＋ New project"),
  );
}

/** Pins or unpins a chat. Pinned chats stay at the top of their project's list. */
async function pinChat(c, pinned) {
  await attempt(async () => {
    await api("PATCH", `conversations/${c.id}`, { pinned });
    await refreshList();
    renderChatList(true);
    if (c.id === state.convId) syncPin();
  }, ui.chatSide);
}

/** Deletes a chat from the list, whichever chat is open. */
async function deleteChatFromList(c) {
  if (!confirm(`Delete the chat “${c.title}”? This cannot be undone.`)) return;
  await attempt(async () => {
    await api("DELETE", `conversations/${c.id}`);
    await refreshList();
    if (c.id === state.convId) go("chat");
    else renderChatList(true);
  }, ui.chatSide);
}

/** The pin button in the open chat's header says what a click will do. */
function syncPin() {
  if (!ui.pin) return;
  const open = state.convs.find((c) => c.id === state.convId);
  ui.pin.hidden = !state.convId;
  ui.pin.textContent = open?.pinned ? "Unpin" : "Pin";
  ui.pin.title = open?.pinned ? "Stop keeping this chat at the top of the list" : "Keep this chat at the top of the list";
}

function renderChatList(force = false) {
  if (!ui.chatSide || state.view !== "chat") return;
  if (!force && ui.chatSide.contains(document.activeElement) && document.activeElement.matches("input, select")) return; // not while the person is choosing or typing
  const here = state.convs.filter((c) => (c.space || "") === state.space);
  const row = (c) =>
    h(
      "div",
      { class: `chatrow ${c.id === state.convId ? "on" : ""} ${c.pinned ? "pinned" : ""}` },
      h(
        "button",
        { class: `navlink ${c.id === state.convId ? "on" : ""}`, title: c.title, onclick: () => go("chat", c.id) },
        c.pinned ? h("span", { class: "pinmark", "aria-hidden": "true" }, "★") : null,
        chatBotOf(c.id) ? keycap(chatBotOf(c.id).character, 18, "", chatBotOf(c.id).type) : null,
        h("span", { class: "title" }, c.title),
        c.needsApproval ? h("i", { class: "dot wait", title: "Waiting for your approval" }) : c.running ? h("i", { class: "dot", title: "Working" }) : null,
      ),
      h(
        "span",
        { class: "chatactions" },
        h("button", { class: "plain", title: c.pinned ? "Unpin" : "Pin to the top", "aria-label": `${c.pinned ? "Unpin" : "Pin"} ${c.title}`, onclick: () => pinChat(c, !c.pinned) }, c.pinned ? "★" : "☆"),
        h("button", { class: "plain", title: "Delete chat", "aria-label": `Delete ${c.title}`, onclick: () => deleteChatFromList(c) }, "✕"),
      ),
    );
  const pinned = here.filter((c) => c.pinned);
  const rest = here.filter((c) => !c.pinned);
  fill(ui.chatSide, 
    spacePicker(),
    h("button", { class: "primary", onclick: () => go("chat") }, "New chat"),
    h(
      "div",
      { class: "chatlist" },
      pinned.length ? [h("div", { class: "listlabel" }, "Pinned"), ...pinned.map(row), rest.length ? h("div", { class: "listlabel" }, "Chats") : null] : null,
      rest.map(row),
      here.length ? null : h("p", { class: "note small", style: "padding: 0 8px" }, state.space ? `No chats in ${spaceName(state.space)} yet.` : "No chats yet."),
    ),
    navFooter("chat"),
  );
}

async function submit() {
  const text = ui.input.value.trim();
  if (!text || state.running) return;
  await attempt(async () => {
    if (!state.convId) {
      const conv = await api("POST", "conversations", state.space ? { space: state.space } : {});
      state.convId = conv.id;
      if (ui.remove) ui.remove.hidden = false;
      if (ui.move) ui.move.hidden = !state.spaces.length;
      fill(ui.log, );
      connect(conv.id);
      await new Promise((resolve) => state.source.addEventListener("open", resolve, { once: true }));
    }
    await api("POST", `conversations/${state.convId}/messages`, { text });
    ui.input.value = "";
    ui.input.style.height = "auto";
    refreshList().then(() => (renderChatList(), syncPin()));
  });
}

async function deleteChat() {
  if (!confirm("Delete this chat? This cannot be undone.")) return;
  await attempt(async () => {
    await api("DELETE", `conversations/${state.convId}`);
    await refreshList();
    go("chat");
  });
}

function connect(id) {
  state.source?.close();
  state.source = new EventSource(`/api/conversations/${id}/events`);
  state.source.onmessage = (e) => {
    if (state.convId === id && ui.log) onEvent(JSON.parse(e.data));
  };
}

/** Who is talking in the open conversation: the quest's bot, or the agent. */
/** The bot a chat is with, when it is a chat with one bot in its role. */
const chatBotOf = (id = state.convId) => {
  const botId = state.convs.find((c) => c.id === id)?.bot;
  return botId ? (state.crew?.bots ?? []).find((b) => b.id === botId) : undefined;
};
const speaker = () => (state.view === "quest" ? (state.quests.find((q) => q.id === state.convId)?.bot.name ?? "the bot") : (chatBotOf()?.name ?? state.config.agentName));

/** Opens a chat with one bot, in its role. */
async function chatWith(bot, where) {
  await attempt(async () => {
    const conv = await api("POST", "conversations", { bot: bot.id, ...(state.space ? { space: state.space } : {}) });
    await refreshList();
    go("chat", conv.id);
  }, where);
}

// ---------- pages ----------
function page(title, intro, ...children) {
  ui.body.className = "body two";
  ui.log = null;
  const col = h("div", { class: "col page" }, h("h1", {}, title), h("p", { class: "lead" }, intro), ...children);
  ui.body.className = "body";
  fill(ui.body, h("main", { class: "center" }, col));
  return col;
}

// ---------- memory ----------
/** Everything remembered, one space at a time: add, edit, move and forget entries, and manage the spaces. */
async function memoryView() {
  if (ui.memSpace === undefined || !["", ...state.spaces.map((s) => s.id)].includes(ui.memSpace)) ui.memSpace = state.space;
  const at = ui.memSpace;
  const name = spaceName(at);
  const again = () => memoryView();
  const col = page(
    "Memory",
    `What ${state.config.agentName} remembers between chats. It adds to this on its own, and tells you in the chat when it does. General memory goes into every chat; a project's memory goes only into that project's chats.`,
  );
  const entries = await attempt(() => api("GET", "memory"), col);
  if (!entries || state.view !== "memory") return;
  const count = (id) => entries.filter((m) => (m.space || "") === id).length;

  // ----- which space -----
  const newName = h("input", { placeholder: "Name, e.g. a client or a piece of work", maxlength: 40, "aria-label": "Name of the new project" });
  const newForm = h(
    "form",
    {
      class: "row spaceadd",
      hidden: true,
      onsubmit: (e) => {
        e.preventDefault();
        attempt(async () => {
          const made = await api("POST", "spaces", { name: newName.value });
          await loadSpaces();
          ui.memSpace = made.id;
          again();
        }, col);
      },
    },
    newName,
    h("button", { class: "primary" }, "Add project"),
  );
  col.append(
    h(
      "div",
      { class: "spacetabs", role: "tablist", "aria-label": "Projects" },
      [{ id: "", name: "General" }, ...state.spaces].map((sp) =>
        h("button", { role: "tab", class: sp.id === at ? "on" : "", "aria-selected": String(sp.id === at), onclick: () => ((ui.memSpace = sp.id), again()) }, sp.name, h("span", { class: "count" }, String(count(sp.id)))),
      ),
      h("button", { class: "plain", onclick: () => ((newForm.hidden = !newForm.hidden), newName.focus()) }, "＋ New project"),
    ),
    newForm,
  );
  if (at) {
    const rename = h("input", { value: name, maxlength: 40, "aria-label": "Project name" });
    const renameForm = h(
      "form",
      {
        class: "row spaceadd",
        hidden: true,
        onsubmit: (e) => {
          e.preventDefault();
          attempt(async () => {
            await api("PATCH", `spaces/${at}`, { name: rename.value });
            await loadSpaces();
            again();
          }, col);
        },
      },
      rename,
      h("button", { class: "primary" }, "Save name"),
    );
    col.append(
      h(
        "div",
        { class: "row" },
        h("span", { class: "note grow" }, `Used only in chats in ${name}, together with General memory.`),
        h("button", { class: "plain", onclick: () => ((renameForm.hidden = !renameForm.hidden), rename.focus()) }, "Rename"),
        h(
          "button",
          {
            class: "plain danger",
            onclick: () =>
              confirm(`Delete the project “${name}”? Its ${count(at)} ${count(at) === 1 ? "memory is" : "memories are"} deleted for good, and its chats move to General.`) &&
              attempt(async () => {
                await api("DELETE", `spaces/${at}`);
                await Promise.all([loadSpaces(), refreshList()]);
                ui.memSpace = "";
                again();
              }, col),
          },
          "Delete project",
        ),
      ),
      renameForm,
    );
  } else {
    col.append(h("p", { class: "note" }, state.spaces.length ? "Carried into every chat, in every project." : "Carried into every chat. Add a project to keep one client's or piece of work's memory and chats apart."));
  }

  // ----- add -----
  const input = h("textarea", { rows: 2, placeholder: at ? `Something to remember about ${name}` : "Something to remember, e.g. “I write mystery novels under a pen name.”" });
  col.append(
    h(
      "form",
      {
        class: "form",
        onsubmit: (e) => {
          e.preventDefault();
          attempt(async () => {
            await api("POST", "memory", { text: input.value, space: at || undefined });
            again();
          }, col);
        },
      },
      input,
      h("div", {}, h("button", { class: "primary" }, at ? `Remember this in ${name}` : "Remember this")),
    ),
  );

  // ----- the entries -----
  const mine = entries.filter((m) => (m.space || "") === at).reverse(); // newest first
  const list = h("div");
  const filter = h("input", { type: "search", placeholder: `Find in ${name}'s memory`, "aria-label": "Find in memory", hidden: mine.length < 8 });
  const draw = () => {
    const needle = filter.value.trim().toLowerCase();
    const shown = needle ? mine.filter((m) => m.text.toLowerCase().includes(needle)) : mine;
    fill(list, shown.length ? shown.map(card) : h("p", { class: "note" }, mine.length ? "Nothing matches." : at ? `Nothing remembered in ${name} yet.` : "Nothing remembered yet."));
  };
  const card = (m) => {
    const text = h("div", { class: "grow" }, h("div", { class: "mtext" }, m.text), h("div", { class: "note" }, m.updatedAt ? `${when(m.createdAt)} · edited ${when(m.updatedAt)}` : when(m.createdAt)));
    const move = h(
      "select",
      { class: "modelpick", "aria-label": "Move to another project", title: "Move to another project", hidden: !state.spaces.length },
      h("option", { value: at, selected: true }, "Move to…"),
      [{ id: "", name: "General" }, ...state.spaces].filter((sp) => sp.id !== at).map((sp) => h("option", { value: sp.id }, sp.name)),
    );
    move.addEventListener("change", () => attempt(async () => (await api("PATCH", `memory/${m.id}`, { space: move.value || null }), again()), col));
    const row = h(
      "div",
      { class: "row" },
      text,
      h("button", { class: "plain", onclick: () => edit() }, "Edit"),
      move,
      h("button", { class: "plain danger", onclick: () => attempt(async () => (await api("DELETE", `memory/${m.id}`), again()), col) }, "Forget"),
    );
    const node = h("div", { class: "card" }, row);
    const edit = () => {
      const box = h("textarea", { rows: 3 });
      box.value = m.text;
      fill(
        node,
        h(
          "form",
          { class: "form", onsubmit: (e) => (e.preventDefault(), attempt(async () => (await api("PATCH", `memory/${m.id}`, { text: box.value }), again()), col)) },
          box,
          h("div", { class: "row" }, h("button", { class: "primary" }, "Save"), h("button", { type: "button", onclick: () => fill(node, row) }, "Cancel")),
        ),
      );
      box.focus();
    };
    return node;
  };
  filter.addEventListener("input", draw);
  col.append(filter, list);
  draw();
}

// ---------- skills ----------
async function skillsView() {
  const col = page("Skills", `Procedures ${state.config.agentName} has written down for itself after working out how to do something, so it can repeat it.`);
  const skills = await attempt(() => api("GET", "skills"), col);
  if (!skills) return;
  if (!skills.length) col.append(h("p", { class: "note" }, "No skills yet. Ask the agent to “save that as a skill” after a task you'll want again."));
  for (const s of skills) {
    col.append(
      h(
        "details",
        { class: "tool" },
        h("summary", {}, h("span", { class: "name" }, s.name), h("span", { class: "what" }, s.description)),
        h(
          "div",
          { class: "body" },
          h("pre", {}, s.content),
          h("button", { class: "danger", onclick: () => confirm(`Delete the skill “${s.name}”?`) && attempt(async () => (await api("DELETE", `skills/${encodeURIComponent(s.name)}`), skillsView()), col) }, "Delete"),
        ),
      ),
    );
  }
}

// ---------- schedules ----------
async function jobsView() {
  const name = h("input", { placeholder: "Morning news digest" });
  const schedule = h("input", { placeholder: "0 8 * * *" });
  const prompt = h("textarea", { rows: 3, placeholder: "What should the agent do each time?" });
  const list = h("div");
  const col = page(
    "Schedules",
    `Jobs ${state.config.agentName} runs on its own. Each run appears as a new chat. You can also just ask in a chat: “every weekday at 8am, …”.`,
    list,
    h("h3", {}, "New scheduled job"),
    h(
      "form",
      {
        class: "form",
        onsubmit: async (e) => {
          e.preventDefault();
          await attempt(async () => {
            await api("POST", "jobs", { name: name.value, schedule: schedule.value, prompt: prompt.value });
            jobsView();
          }, col);
        },
      },
      h("label", {}, "Name", name),
      h("label", {}, "When: “every 30m”, “every 1d”, “at 2026-12-01T09:00”, or a cron line (“0 8 * * *” is 8:00 every day)", schedule),
      h("label", {}, "Instructions", prompt),
      h("div", {}, h("button", { class: "primary" }, "Add job")),
    ),
  );
  const jobs = await attempt(() => api("GET", "jobs"), col);
  if (!jobs) return;
  if (!jobs.length) list.append(h("p", { class: "note" }, "No scheduled jobs yet."));
  for (const j of jobs) {
    const act = (fn) => attempt(async () => (await fn(), jobsView()), col);
    list.append(
      h(
        "div",
        { class: "card" },
        h(
          "div",
          { class: "row" },
          h("div", { class: "grow" }, h("strong", {}, j.name), h("div", { class: "note" }, `${j.schedule} · ${j.enabled ? `next ${when(j.nextRunAt)}` : "paused"} · last ${when(j.lastRunAt)}`), h("div", {}, j.prompt)),
          h(
            "div",
            { class: "row" },
            j.lastConversationId ? h("button", { onclick: () => go("chat", j.lastConversationId) }, "Last run") : null,
            h("button", { onclick: () => attempt(async () => go("chat", (await api("POST", `jobs/${j.id}/run`, {})).conversationId), col) }, "Run now"),
            h("button", { onclick: () => act(() => api("PATCH", `jobs/${j.id}`, { enabled: !j.enabled })) }, j.enabled ? "Pause" : "Resume"),
            h("button", { class: "danger", onclick: () => confirm(`Delete “${j.name}”?`) && act(() => api("DELETE", `jobs/${j.id}`)) }, "Delete"),
          ),
        ),
      ),
    );
  }
}

// ---------- settings ----------
function settingsView() {
  const c = state.config;
  const col = page("Settings", `Files the agent works on live in ${c.workspace}`);
  const save = (patch) =>
    attempt(async () => {
      state.config = await api("PUT", "settings", patch);
      document.title = state.config.agentName;
      renderSide();
      settingsView();
    }, col);
  const select = (options, value) => h("select", {}, options.map(([id, label]) => h("option", { value: id, selected: id === value }, label)));

  if (needsKey(c)) {
    col.append(
      h("div", { class: "banner" }, "To get started, paste an Anthropic API key below (console.anthropic.com → API keys), or choose a free local model under Agent."),
    );
  }

  const key = h("input", { type: "password", placeholder: c.hasApiKey ? (c.apiKeyFromEnv ? "Set in the .env file" : "Saved. Paste a new key to replace it.") : "sk-ant-…", autocomplete: "off" });
  col.append(
    h("h3", {}, "Anthropic API key"),
    h("form", { class: "form", onsubmit: (e) => (e.preventDefault(), key.value.trim() && save({ apiKey: key.value })) }, key, h("div", {}, h("button", { class: "primary" }, "Save key"))),
  );

  // The accent is a per-person choice, kept in this browser, so it changes at once without saving.
  const accentLabel = h("span", {}, NEON[accent][0]);
  const accentRow = h("div");
  const drawAccent = () => fill(accentRow, swatches(accent, (name) => (applyAccent(name), (accentLabel.textContent = NEON[name][0]), drawAccent()), "Accent colour"));
  drawAccent();
  col.append(
    h("h3", {}, "Look"),
    h("p", { class: "note" }, "Accent colour: ", accentLabel, ". Used for buttons, highlights and the cursor. Each bot glows in its own colour, which you can change when you edit the bot."),
    accentRow,
  );

  const name = h("input", { value: c.agentName });
  const slash = c.model.indexOf("/");
  const provider = select(c.providers.map((p) => [p.id, p.name]), c.model.slice(0, slash));
  const modelName = h("input", { value: c.model.slice(slash + 1), placeholder: "Model name, e.g. llama3.1 or claude-opus-5-5", autocomplete: "off" });
  const claudeModels = h("datalist", { id: "claude-models" }, c.models.map((m) => h("option", { value: m.id }, m.label)));
  // Claude's names are suggested only when Anthropic is the provider.
  const providerModels = h("datalist", { id: "provider-models" });
  const modelNote = h("p", { class: "note small" });
  // Suggest the models the chosen provider actually has.
  const syncList = async () => {
    modelName.setAttribute("list", "provider-models");
    const listed = await api("GET", `providers/${encodeURIComponent(provider.value)}/models`).catch(() => ({ models: [] }));
    fill(providerModels, listed.models.map((m) => h("option", { value: m })));
    modelNote.textContent = listed.note || (listed.models.length ? `${listed.models.length} model${listed.models.length === 1 ? "" : "s"} available. Start typing to choose.` : "");
  };
  provider.addEventListener("change", syncList);
  syncList();
  const ref = () => `${provider.value}/${modelName.value.trim()}`;
  const effort = select(c.efforts.map((e) => [e, e]), c.effort);
  const mode = select(
    [
      ["ask", "Ask me before commands, file changes and API writes"],
      ["auto", "Run everything without asking"],
    ],
    c.approvalMode,
  );
  const steps = h("input", { type: "number", min: 1, max: 500, step: 1, value: c.budget?.steps ?? 40 });
  const spend = h("input", { type: "number", min: 0, max: 100, step: 0.01, value: c.budget?.spend ?? "", placeholder: "No limit" });

  const checkBox = h("div", {});
  const showCheck = (result) => {
    if (!result) return fill(checkBox, h("p", { class: "note" }, "Not checked yet. The check takes under a minute and costs a few cents at most on a paid model."));
    const mark = (ok, label) => h("span", { class: ok ? "state ok" : "state bad" }, `${ok ? "✓" : "✗"} ${label}  `);
    fill(checkBox, 
      h(
        "div",
        { class: "card" },
        h("div", {}, h("strong", {}, result.label), h("span", { class: "note" }, ` · checked ${when(result.checkedAt)}`)),
        h("div", {}, mark(result.instructions, "follows instructions"), mark(result.tools, "uses tools"), mark(result.multiStep, "chains steps")),
        h("div", { class: "note" }, `Good for: ${result.recommended.join(", ")}`),
        result.notes.map((note) => h("div", { class: "note" }, note)),
      ),
    );
  };
  showCheck(c.modelChecks?.[c.model]);
  const checkButton = h("button", { type: "button" }, "Check this model");
  checkButton.addEventListener("click", () =>
    attempt(async () => {
      checkButton.disabled = true;
      checkButton.textContent = "Checking…";
      try {
        showCheck(await api("POST", "model-check", { model: ref() }));
        state.config = await api("GET", "state");
      } finally {
        checkButton.disabled = false;
        checkButton.textContent = "Check this model";
      }
    }, col),
  );

  col.append(
    h("h3", {}, "Agent"),
    h(
      "form",
      {
        class: "form",
        onsubmit: (e) => (
          e.preventDefault(),
          save({ agentName: name.value, model: ref(), effort: effort.value, approvalMode: mode.value, budget: { steps: Number(steps.value), spend: spend.value === "" ? null : Number(spend.value) } })
        ),
      },
      h("label", {}, "Name", name),
      h("label", {}, "Model comes from", provider),
      h("label", {}, "Model", modelName, claudeModels, providerModels),
      modelNote,
      h("p", { class: "note" }, "For a free local model, start a local model runner (Ollama, LM Studio, llama.cpp and others) and type the name of a model you have downloaded. Web search and connectors are Claude-only for now; other models read pages with the built-in page reader."),
      h("div", { class: "row" }, checkButton),
      checkBox,
      h("label", {}, "Effort, for Claude (higher thinks longer and costs more)", effort),
      h("label", {}, "Approvals", mode),
      h("p", { class: "note" }, "With “ask”, a scheduled job that needs approval waits until you open its chat and answer. “Run everything” is only sensible when the agent runs in Docker or on a machine with nothing you'd mind losing."),
      h("label", {}, "Budget per run: steps (model calls)", steps),
      h("label", {}, "Budget per run: estimated spend in US dollars", spend),
      h("p", { class: "note" }, "A run stops before going over either limit, and you can say “continue”. Spend is estimated from list prices; your provider's bill is the real figure."),
      h("div", {}, h("button", { class: "primary" }, "Save")),
    ),
  );

  const pId = h("input", { placeholder: "Short id, e.g. lmstudio" });
  const pName = h("input", { placeholder: "Name, e.g. LM Studio" });
  const pUrl = h("input", { placeholder: "Address ending in /v1, e.g. http://localhost:1234/v1" });
  const pKey = h("input", { type: "password", placeholder: "API key (blank for local runners)", autocomplete: "off" });
  const pIn = h("input", { type: "number", min: 0, step: 0.01, placeholder: "$ per million input tokens (0 if free)" });
  const pOut = h("input", { type: "number", min: 0, step: 0.01, placeholder: "$ per million output tokens (0 if free)" });
  const pContext = h("input", { type: "number", min: 2000, step: 1000, placeholder: "Context size in tokens (default 32000)" });
  const others = c.providers.filter((p) => p.kind !== "anthropic");
  col.append(
    h("h3", {}, "Model providers"),
    h("p", { class: "note" }, "Anything that offers the common chat completions format: local runners, or hosted services with your own key. Prices are optional; without them only the step budget applies."),
    ...others.map((p) =>
      h(
        "div",
        { class: "card" },
        h(
          "div",
          { class: "row" },
          h("div", { class: "grow" }, h("strong", {}, p.name), ` (${p.id}) ${p.baseUrl}`, h("div", { class: "note" }, `${p.hasKey ? "Key saved" : "No key"} · ${p.prices ? `$${p.prices.input} in / $${p.prices.output} out per million tokens` : "prices unknown"} · context ${(p.contextTokens ?? 32000).toLocaleString()} tokens`)),
          h("button", { class: "plain danger", onclick: () => save({ provider: { id: p.id, remove: true } }) }, "Remove"),
        ),
      ),
    ),
    h(
      "form",
      { class: "form", onsubmit: (e) => (e.preventDefault(), save({ provider: { id: pId.value.trim(), name: pName.value.trim(), baseUrl: pUrl.value.trim(), apiKey: pKey.value, prices: { input: pIn.value, output: pOut.value }, contextTokens: pContext.value } })) },
      pId,
      pName,
      pUrl,
      pKey,
      h("div", { class: "row" }, pIn, pOut),
      pContext,
      h("p", { class: "note small" }, "Set the context size to what the model really holds. Long quests are shortened to fit it, so a small local model keeps the task in view instead of losing track."),
      h("div", {}, h("button", {}, "Add provider")),
    ),
  );

  const sName = h("input", { placeholder: "NAME, e.g. WEATHER_KEY" });
  const sValue = h("input", { type: "password", placeholder: "The key or token", autocomplete: "off" });
  const sHost = h("input", { placeholder: "Host it may be sent to, e.g. api.example.com" });
  col.append(
    h("h3", {}, "API keys for other services"),
    h("p", { class: "note" }, "The agent uses these by name in API calls and never sees the values. Each key is only ever sent to its own host."),
    ...c.secrets.map((s) => h("div", { class: "card" }, h("div", { class: "row" }, h("div", { class: "grow" }, h("strong", {}, s.name), ` → ${s.host}`), h("button", { class: "plain danger", onclick: () => save({ secret: { name: s.name, remove: true } }) }, "Remove")))),
    h("form", { class: "form", onsubmit: (e) => (e.preventDefault(), save({ secret: { name: sName.value.trim(), value: sValue.value, host: sHost.value.trim() } })) }, sName, sValue, sHost, h("div", {}, h("button", {}, "Add key"))),
  );

  const repoPath = h("input", { placeholder: "Folder of a git repository, e.g. /home/you/code/my-app" });
  col.append(
    h("h3", {}, "Repositories"),
    h("p", { class: "note" }, "Bots can work on these. A quest that changes code gets its own branch and working copy, so your files and branches are untouched until you keep its changes. Bots in a repository's .crew/ folder join the crew when it is chosen."),
    ...c.projects.map((p) => h("div", { class: "card" }, h("div", { class: "row" }, h("div", { class: "grow" }, h("code", {}, p)), h("button", { class: "plain danger", onclick: () => save({ project: { path: p, remove: true } }) }, "Remove")))),
    h("form", { class: "form", onsubmit: (e) => (e.preventDefault(), save({ project: { path: repoPath.value.trim() } })) }, repoPath, h("div", {}, h("button", {}, "Add repository"))),
  );

  const mName = h("input", { placeholder: "Name, e.g. notion" });
  const mUrl = h("input", { placeholder: "https://… (the connector's MCP address)" });
  const mToken = h("input", { type: "password", placeholder: "Access token (if it needs one)", autocomplete: "off" });
  const mCommand = h("input", { placeholder: "Or a program to run, e.g. npx -y @some/mcp-server", class: "mono" });
  col.append(
    h("h3", {}, "Connectors (MCP servers)"),
    h("p", { class: "note" }, "Connectors give agents ready-made tools for other services. The app connects to them from this computer, so they work with every model. A connector can be on the web, or a program this computer runs. Their tools ask before changing anything unless the connector marks them read-only, and agents give them only to bots with the connectors power."),
    ...c.mcpServers.map((s) =>
      h(
        "div",
        { class: "card" },
        h("div", { class: "row" }, h("div", { class: "grow" }, h("strong", {}, s.name), " ", h("code", {}, s.command || s.url)), h("button", { class: "plain danger", onclick: () => save({ mcpServer: { name: s.name, remove: true } }) }, "Remove")),
      ),
    ),
    h(
      "form",
      { class: "form", onsubmit: (e) => (e.preventDefault(), save({ mcpServer: { name: mName.value.trim(), url: mUrl.value.trim(), token: mToken.value, command: mCommand.value.trim() } })) },
      mName,
      mUrl,
      mToken,
      mCommand,
      h("div", {}, h("button", {}, "Add connector")),
    ),
  );
}

boot();

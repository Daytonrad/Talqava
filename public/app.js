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
  // Children may be nested lists of any depth (a list inside a conditional inside a list).
  for (const child of children.flat(Infinity)) {
    if (child != null && child !== false) node.append(child);
  }
  return node;
}


// ---------- the Talqava logo ----------
// The mark: a white bar (the layer Talqava adds on top) over a green cursor (work under way), on a black tile.
// The wordmark: TALQAVA drawn as strokes as thick as the bar. Both follow the brand guide; colours are fixed.
const LOGO_WORD = "M0 4H40M20 0V56M58 56V16A12 12 0 0 1 70 4H78A12 12 0 0 1 90 16V56M58 32H90M112 0V52H148M178 4H186A12 12 0 0 1 198 16V40A12 12 0 0 1 186 52H178A12 12 0 0 1 166 40V16A12 12 0 0 1 178 4ZM188 42L202 56M220 56V16A12 12 0 0 1 232 4H240A12 12 0 0 1 252 16V56M220 32H252M274 0V28L290 48L306 28V0M328 56V16A12 12 0 0 1 340 4H348A12 12 0 0 1 360 16V56M328 32H360";
function brandLogo({ mark = 26, word = 12, cursor = true } = {}) {
  const node = h("span", { class: "logo", "aria-hidden": "true" });
  node.innerHTML =
    `<svg class="logo-mark" viewBox="0 0 64 64" width="${mark}" height="${mark}"><rect width="64" height="64" rx="16" fill="#0A0A0A"/><rect x="0.5" y="0.5" width="63" height="63" rx="15.5" fill="none" stroke="#2A2A2A"/><rect x="14" y="16" width="36" height="8" fill="#F2F2F2"/><rect x="27" y="28" width="10" height="20" fill="#00D26A"/></svg>` +
    (word ? `<svg class="logo-word" viewBox="0 0 364 56" width="${(word * 364) / 56}" height="${word}"><path d="${LOGO_WORD}" fill="none" stroke="currentColor" stroke-width="8" stroke-linejoin="miter" stroke-miterlimit="2"/></svg>` : "");
  if (word && cursor) node.append(h("span", { class: "cursor" }));
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
    h("div", { class: "brand", role: "img", "aria-label": "Talqava Agents" }, brandLogo({ mark: 48, word: 18 })),
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
  integrations: "M7.5 3.5v4M12.5 3.5v4M5.5 7.5h9v2.5a4.5 4.5 0 0 1-9 0zM10 14.5v2.5",
  library: "M3.5 6A1.5 1.5 0 0 1 5 4.5h3l1.5 2H15A1.5 1.5 0 0 1 16.5 8v6A1.5 1.5 0 0 1 15 15.5H5A1.5 1.5 0 0 1 3.5 14zM7 10.5h6M7 12.8h4",
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
    h("button", { class: "plain brand", onclick: () => go("chat"), title: "Chat", "aria-label": "Talqava Agents, chat" }, brandLogo()),
    h("div", { class: "railgroup" }, item("chat", "Chat", v === "chat"), inbox),
    h("div", { class: "raillabel" }, "Team"),
    h("div", { class: "railgroup" }, item("team", "Organization", v === "team", "The org chart, departments and budgets"), item("home", "Work in progress", ["home", "quest", "bot"].includes(v), "Assign tasks to agents and follow their work"), item("market", "Marketplace", v === "market" || v === "marketbot", "Ready-made agents and teams for every department")),
    h("div", { class: "raillabel" }, "Knowledge"),
    h("div", { class: "railgroup" }, item("library", "Library", v === "library", "Documents you share with your agents"), item("memory", "Memory", v === "memory"), item("skills", "Skills", v === "skills"), item("jobs", "Schedules", v === "jobs")),
    h("div", { class: "raillabel" }, "Connect"),
    h("div", { class: "railgroup" }, item("integrations", "Integrations", v === "integrations", "Connect the tools your business already uses, starting with Git")),
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
  const views = { home: homeView, quest: questView, bot: botView, chat: chatView, memory: memoryView, skills: skillsView, jobs: jobsView, settings: settingsView, market: marketView, marketbot: marketBotView, inbox: inboxView, team: teamView, integrations: integrationsView, library: libraryView };
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
            { class: "repo", title: state.project || "Tasks work in the workspace folder. Connect repositories under Integrations → Git." },
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
  fill(ui.spent, "Spent today on agents", h("b", {}, money(spent)));
}

// ---------- the command box ----------
const COMMANDS = [
  ["New chat", () => go("chat")],
  ["Inbox", () => go("inbox")],
  ["Bots", () => go("home")],
  ["Organization", () => go("team")],
  ["Marketplace", () => go("market")],
  ["Create an agent", () => go("bot", "new")],
  ["Memory", () => go("memory")],
  ["Skills", () => go("skills")],
  ["Schedules", () => go("jobs")],
  ["Settings", () => go("settings")],
];

function paletteBox() {
  ui.palette = h("input", { type: "text", placeholder: paletteHint(), "aria-label": "Ask something, assign an agent, or run a command", autocomplete: "off" });
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
  if (state.view === "home" && bot) return `Assign a task to ${bot.name}, or type @name, or a command`;
  return "Ask in a new chat, type @name to assign an agent, or run a command";
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
  if (task && target) items[botFirst && !mention ? "unshift" : "push"]({ label: `Assign to ${target.name}`, what: task, bot: target, run: () => sendQuest(target, task) });
  if (task && !mention && botFirst) {
    for (const bot of bots.filter((b) => b !== target).slice(0, 5)) items.push({ label: `Assign to ${bot.name} instead`, what: roleLine(bot, roleOf(bot.id)?.title), bot, run: () => sendQuest(bot, task) });
  }
  const needle = text.toLowerCase();
  const commands = [
    ...COMMANDS,
    ...(state.templates ?? []).map((t) => [`Standard task: ${t.name}`, () => (go("home"), openCoreQuest(t.id))]),
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

/**
 * Starts a task, first checking (for free, on this computer) that it has what it needs. When something is
 * missing, says what and how to fix it, instead of letting agents spend money finding out.
 * Resolves to the new task, or null when it was not started.
 */
async function startTask(payload) {
  const reply = await api("POST", "quests", payload);
  if (!reply.needs) return reply;
  const choice = await needsDialog(reply.needs, reply.repositories ?? []);
  if (!choice) return null;
  if (choice.project) return startTask({ ...payload, project: choice.project });
  if (choice.anyway) return startTask({ ...payload, anyway: true });
  return null;
}

function needsDialog(needs, repositories) {
  return new Promise((resolve) => {
    const dialog = h("dialog", { class: "needs" });
    const done = (value) => (dialog.close(), dialog.remove(), resolve(value));
    const goFix = (need) => {
      done(null);
      if (need.fix === "integrations-git") return ((ui.integration = "git"), go("integrations"));
      if (need.fix === "integrations-openrouter") return ((ui.integration = "openrouter"), go("integrations"));
      go("settings");
    };
    const canSkip = needs.every((n) => n.canSkip);
    fill(
      dialog,
      h("div", { class: "label" }, "Before this task starts"),
      h("h2", {}, needs.length === 1 ? needs[0].title : "A few things are missing"),
      h("p", { class: "note" }, "Nothing has been spent. Agents have not started, so this costs nothing."),
      needs.map((n) =>
        h(
          "div",
          { class: "needrow" },
          needs.length > 1 ? h("b", {}, n.title) : null,
          h("p", {}, n.detail),
          n.fix === "choose-repository"
            ? h("div", { class: "row wrap" }, repositories.map((p) => h("button", { class: "primary", onclick: () => done({ project: p }) }, basename(p))))
            : h("div", { class: "row" }, h("button", { class: "primary", onclick: () => goFix(n) }, n.fix === "integrations-git" ? "Connect a repository" : n.fix === "integrations-openrouter" ? "Connect OpenRouter" : "Open Settings")),
        ),
      ),
      h("div", { class: "row end" }, h("button", { class: "plain", onclick: () => done(null) }, "Cancel"), canSkip ? h("button", { onclick: () => done({ anyway: true }) }, "Start anyway") : null),
    );
    dialog.addEventListener("cancel", (e) => (e.preventDefault(), done(null)));
    document.body.append(dialog);
    dialog.showModal();
  });
}

async function sendQuest(bot, text) {
  await attempt(async () => {
    const quest = await startTask({ bot: bot.id, text, project: state.project || undefined });
    if (!quest) return;
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
    const who = head?.[1].trim() ?? "An agent";
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
  if (name === "assign_task") return `to ${input.to || "an agent"}: ${input.task || ""}`;
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
/** How an agent's name and role read in two lines: the name, then its title, or its department when the name is the title. */
const roleLine = (bot, title) => {
  const t = title || bot?.title || "";
  return t && t.toLowerCase() !== String(bot?.name ?? "").toLowerCase() ? t : bot?.group || t;
};

// Each agent is a character: a keycap with its initials printed on it, its own
// body shape, eyes and something on top, in its own colour. It moves a little
// at rest, and its face and motion show what it is doing.
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
  ui.crewCol = h("aside", { class: "side", "aria-label": "Agents" });
  ui.board = h("main", { class: "center" });
  ui.logCol = h("aside", { class: "logcol", "aria-label": "Completed work" });
  fill(ui.body, ui.crewCol, ui.board, ui.logCol);
  renderHome();
}

function renderHome() {
  if (state.view !== "home" || !ui.board) return;
  renderCrewColumn();
  renderBoard();
  renderLog();
}

/** The agents the work page is about: the members of the organization that is selected, or everyone when it has none. */
function orgBots() {
  const bots = state.crew?.bots ?? [];
  const members = new Set(activeOrg().members.map((m) => m.bot));
  const mine = bots.filter((b) => members.has(b.id));
  return mine.length ? mine : bots;
}

/** Bots by department in the selected organization, departments in name order. */
function byDepartment(bots) {
  const groups = new Map();
  for (const bot of bots) groups.set(departmentOf(bot.id), [...(groups.get(departmentOf(bot.id)) ?? []), bot]);
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
}

/** Bots by team group, groups in name order. */
function byGroup(bots) {
  const groups = new Map();
  for (const bot of bots) groups.set(bot.group || "Other", [...(groups.get(bot.group || "Other") ?? []), bot]);
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
}

function renderCrewColumn() {
  const all = state.crew?.bots ?? [];
  const bots = orgBots();
  const org = activeOrg();
  const orgs = state.orgs?.orgs ?? [];
  const orgPick = h("select", { class: "orgpick", "aria-label": "Organization", onchange: (e) => attempt(async () => (await api("PATCH", `orgs/${e.target.value}`, { active: true }), await loadOrgs(), (state.selectedBot = null), renderHome())) }, orgs.map((o) => h("option", { value: o.id, selected: o.id === org.id }, o.name)));
  const live = new Map(state.quests.filter(isLive).map((q) => [q.bot.id, q]));
  const fromRepo = bots.some((b) => b.source === "project");
  const member = (bot) => {
    const q = live.get(bot.id);
    const status = q ? (q.status === "waiting" ? "◌ Waiting on you" : `● Working · step ${q.steps || 1}`) : bot.month?.state === "stopped" ? "■ At its monthly budget" : "Available";
    return h(
      "button",
      {
        class: `member ${bot.id === state.selectedBot ? "on" : ""}`,
        style: botStyle(bot),
        title: bot.instructions,
        onclick: () => {
          state.selectedBot = bot.id;
          state.selectedTeam = null;
          remember("talqava.bot", bot.id);
          if (ui.palette) ui.palette.placeholder = paletteHint();
          if (q) go("quest", q.id);
          else renderHome();
        },
        ondblclick: () => go("bot", bot.id),
      },
      keycap(bot.character, 36, mood(q), bot.type),
      h("span", { class: "who" }, h("b", {}, bot.name), ((t) => (t && t.toLowerCase() !== bot.name.toLowerCase() ? h("span", { class: "type" }, t) : null))(roleOf(bot.id)?.title ?? bot.title), h("span", { class: `status ${q?.status === "waiting" ? "wait" : ""}` }, ((n) => (n && !q ? `${status} · ${n} done this week` : status))(state.quests.filter((x) => x.bot.id === bot.id && !isLive(x) && within(x.updatedAt, WEEK)).length))),
      // The model is only worth a mention here when the bot has none it can use.
      bot.modelInfo?.kind ? null : modelChip(bot.modelInfo),
      h("span", { class: "plain edit", role: "button", onclick: (e) => (e.stopPropagation(), go("bot", bot.id)) }, "Edit"),
    );
  };
  fill(ui.crewCol, 
    orgs.length > 1 ? h("label", { class: "sidelabel" }, "Organization", orgPick) : null,
    h("div", { class: "side-head" }, h("h2", { class: "label" }, `${orgs.length > 1 ? "" : `${org.name || "Organization"} · `}${bots.length} agent${bots.length === 1 ? "" : "s"} · ${new Set(bots.map((b) => departmentOf(b.id))).size} department${new Set(bots.map((b) => departmentOf(b.id))).size === 1 ? "" : "s"}`), h("button", { class: "plain small", onclick: () => go("team"), title: "The org chart, departments and budgets" }, "Chart →")),
    fromRepo ? h("div", { class: "note small", style: "padding: 0 8px" }, ".crew/ in this repo") : null,
    ...byDepartment(bots).flatMap(([group, members]) => [h("div", { class: "grouplabel" }, `${group} · ${members.length}`), ...members.map(member)]),
    all.length > bots.length ? h("p", { class: "note small", style: "padding: 6px 8px 0" }, `${all.length - bots.length} more agent${all.length - bots.length === 1 ? " is" : "s are"} on your team but not in this organization. `, h("button", { class: "plain link", onclick: () => go("team") }, "Add them on the chart")) : null,
    state.crew?.problems?.length ? h("div", { class: "banner error small" }, state.crew.problems.map((p) => h("div", {}, p.problem))) : null,
    h("button", { class: "hatch", onclick: () => go("market") }, "+ Add from the marketplace"),
    h("button", { class: "hatch", onclick: () => go("bot", "new") }, "+ Create an agent"),
    navFooter(),
  );
}

const cap = (text) => String(text).charAt(0).toUpperCase() + String(text).slice(1);

/** Pages are reached from the rail on the left, so the side columns carry no links of their own. */
function navFooter() {
  return null;
}

// Tasks worth suggesting to each department, so the box is never a blank page.
const TASK_IDEAS = {
  Sales: ["Research 10 prospects that fit our ideal customer, and say why each fits", "Draft a follow-up for a prospect who has gone quiet", "Prepare me for a sales call: what to ask and the likely objections"],
  Marketing: ["Write this month's customer newsletter from my notes", "Draft three social posts announcing our latest news", "Rewrite our homepage introduction so it is clearer"],
  Finance: ["Summarise income and costs from the file I share, against last month", "List overdue invoices and draft a reminder for each", "Build a 13-week cash forecast from my figures"],
  Operations: ["Write down how we do a recurring job as a step-by-step checklist", "Give me a weekly report of what is overdue and who it is waiting on", "Compare three suppliers on price, terms and delivery"],
  Research: ["Compare our top three competitors on price and features, with sources", "Find out what rules apply to our business in our area", "What do customers say they dislike about products like ours?"],
  "Customer Support": ["Draft replies to the customer questions I paste", "Group this week's complaints by cause and suggest fixes", "Write an onboarding plan for a new customer"],
  People: ["Write a job description and interview scorecard for a role", "Draft an onboarding checklist for a new hire", "Screen the applications I share against the scorecard"],
  Legal: ["Summarise this contract: who must do what, by when, and the risks", "List our contracts and when each renews", "Check this plan against our own policies"],
  Leadership: ["Turn this goal into a plan across departments, with owners and dates", "Report where each department stands against its targets", "List the decisions that are waiting on me"],
  Product: ["Write the problem, the evidence and success measure for an idea", "Turn this request into acceptance criteria", "Rank these ideas and say what each displaces"],
  Engineering: ["Fix a bug I describe and run the tests", "Add tests for a file", "Review this change against the plan"],
  Communications: ["Draft an announcement from my notes", "Edit this draft and keep my voice", "Turn these points into an email I can send"],
};
const WEEK = 7 * 24 * 3600 * 1000;
const within = (iso, ms) => Date.now() - new Date(iso).getTime() < ms;
const departmentOf = (botId) => roleOf(botId)?.department ?? state.crew?.bots.find((b) => b.id === botId)?.group ?? "Other";
/** How long ago something started, in a word or two. */
const elapsed = (iso) => {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  return mins < 1 ? "just now" : mins < 60 ? `${mins} min` : mins < 1440 ? `${Math.round(mins / 60)} h` : `${Math.round(mins / 1440)} d`;
};

/**
 * The work page: assign work, see what needs the person, follow what is under
 * way down the chain of hand-offs, and read how each department is doing.
 * Ordered by what the person should do next, not by what the software has.
 */
function renderBoard() {
  const quests = state.quests ?? [];
  const bots = orgBots();
  const active = quests.filter(isLive);
  const selectedAgent = bots.find((b) => b.id === state.selectedBot) ?? bots[0];
  const { needs } = inboxItems();
  const week = quests.filter((q) => !isLive(q) && within(q.updatedAt, WEEK));
  const succeeded = week.filter((q) => q.status === "done" && !(q.check && !q.check.passed));
  const weekAll = quests.filter((q) => within(q.updatedAt, WEEK));
  const spent = weekAll.reduce((n, q) => n + (q.cost || 0), 0);
  const stat = (label, value, note, loud) => h("div", { class: "stat" }, h("span", { class: "label" }, label), h("b", { class: loud ? "loud" : "" }, value), note ? h("span", { class: "statnote" }, note) : null);

  // ----- assign a task: to a whole team (through its manager, who splits it up) or to one agent -----
  const orgMembers = activeOrg().members.filter((m) => bots.some((b) => b.id === m.bot));
  const underOf = (id) => {
    const all = new Set([id]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const m of orgMembers) if (m.manager && all.has(m.manager) && !all.has(m.bot)) (all.add(m.bot), (grew = true));
    }
    return all.size - 1;
  };
  const teams = orgMembers
    .filter((m) => orgMembers.some((x) => x.manager === m.bot))
    .map((m) => ({ lead: m.bot, name: m.department && m.department !== "Leadership" ? `${m.department} team` : `Everyone under the ${bots.find((b) => b.id === m.bot)?.name}`, size: underOf(m.bot) + 1 }))
    .sort((a, b) => b.size - a.size);
  const team = teams.find((t) => t.lead === state.selectedTeam) ?? null;
  const selected = team ? bots.find((b) => b.id === team.lead) : selectedAgent;
  const who = h(
    "select",
    {
      "aria-label": "Assign to",
      onchange: (e) => {
        const value = e.target.value;
        if (value.startsWith("team:")) state.selectedTeam = value.slice(5);
        else (state.selectedTeam = null), (state.selectedBot = value), remember("talqava.bot", value);
        state.draftTask = what.value;
        renderHome();
      },
    },
    teams.length ? h("optgroup", { label: "Teams" }, teams.map((t) => h("option", { value: `team:${t.lead}`, selected: t.lead === team?.lead }, `${t.name} · ${t.size} agents`))) : null,
    byDepartment(bots).map(([group, members]) => h("optgroup", { label: `${group} · one agent` }, members.map((b) => h("option", { value: b.id, selected: !team && b.id === selected?.id }, b.name)))),
  );
  const what = h("textarea", { rows: 2, placeholder: team ? `What should the ${team.name} do? Say what a good result looks like.` : selected ? `What should the ${selected.name} do? Say what a good result looks like.` : "What needs doing?", "aria-label": "The task" }, state.draftTask ?? "");
  what.addEventListener("input", () => (state.draftTask = what.value));
  const assign = h("button", { class: "primary" }, team ? "Assign to the team" : "Assign task");
  // The repository the task is about, where any are connected. With one connected and none chosen, the task gets that one.
  const repos = state.config?.projects ?? [];
  const repoPick = repos.length
    ? h("label", { class: "repoline" }, "Repository", h("select", { "aria-label": "Repository for this task", onchange: (e) => ((state.project = e.target.value), remember("talqava.project", state.project), loadCrew().then(() => (renderTop(), renderHome()))) }, repos.length > 1 || state.project ? h("option", { value: "", selected: !state.project }, repos.length === 1 ? "None" : "None chosen") : null, repos.map((p) => h("option", { value: p, selected: p === state.project || (repos.length === 1 && !state.project) }, basename(p)))))
    : null;
  const send = () =>
    Promise.resolve(attempt(async () => {
      const text = what.value.trim();
      if (!selected || text.length < 3) return what.focus();
      assign.disabled = true;
      // A team's task goes to its manager, with the instruction to share it out and bring back one result.
      const forTeam = team ? `${text}\n\n[This task is for your whole team (the ${team.name}), not for you alone. Split it into parts and hand each part to the right member of your team with assign_task. When their reports come back, check them, put them together, and give one combined result. Do only the parts that nobody on your team can do.]` : text;
      const started = await startTask({ bot: selected.id, text: forTeam, title: team ? `${team.name}: ${text}` : undefined, project: state.project || undefined });
      if (!started) return;
      state.draftTask = "";
      await loadQuests();
      renderHome();
    }, ui.board)).finally(() => (assign.disabled = false));
  assign.addEventListener("click", send);
  what.addEventListener("keydown", (e) => (e.metaKey || e.ctrlKey) && e.key === "Enter" && send());
  const ideas = selected ? (TASK_IDEAS[departmentOf(selected.id)] ?? TASK_IDEAS[selected.group] ?? []) : [];
  const leads = selected && activeOrg().members.some((m) => m.manager === selected.id);
  const composer = h(
    "section",
    { class: "card assignbox", style: selected ? botStyle(selected) : "" },
    h("div", { class: "assignrow" }, selected ? keycap(selected.character, 40, "", selected.type) : null, h("div", { class: "grow" }, h("div", { class: "row" }, h("span", { class: "label", style: "margin: 0" }, "Assign a task to"), who, team ? h("span", { class: "note small" }, `A whole team: the ${selected.name} shares the work out across ${team.size - 1} agent${team.size === 2 ? "" : "s"} and brings back one result`) : selected ? h("span", { class: "note small" }, `One agent · ${departmentOf(selected.id)}${leads ? " · can hand parts to its team" : ""}`) : null), what)),
    repoPick ? h("div", { class: "assignmeta" }, repoPick, h("span", { class: "note small" }, repos.length === 1 && !state.project ? "Your connected repository is used automatically." : state.project ? "Agents that change files work in their own copy; you review before anything is kept." : "Choose one if the task is about your code.")) : null,
    h("div", { class: "assignfoot" }, h("div", { class: "ideachips" }, ideas.map((idea) => h("button", { type: "button", class: "ideachip", title: "Use this as a starting point", onclick: () => ((what.value = idea), (state.draftTask = idea), what.focus()) }, idea))), assign),
  );

  // ----- what is under way, as chains of hand-offs -----
  const childrenOf = (id) => active.filter((q) => q.parent?.id === id);
  const roots = active.filter((q) => !q.parent || !active.some((p) => p.id === q.parent.id));
  const flow = (q, depth = 0) => {
    const approval = q.approvals?.[0];
    const pct = q.budget?.steps ? Math.min(100, Math.round(((q.steps || 0) / q.budget.steps) * 100)) : null;
    const doing = approval ? `Wants to use ${NAMES[approval.name] || approval.name}` : q.checking ? "Checking the result" : q.activity ? `${NAMES[q.activity.name] || q.activity.name}: ${summarize(q.activity.name, q.activity.input)}` : "Thinking";
    const kindWord = q.kind === "question" ? "Question" : q.kind === "decision" ? "Decision" : /^Request: /.test(q.title) ? "Request" : null;
    return [
      h(
        "button",
        { class: `flowrow ${approval ? "wait" : ""}`, style: `${botStyle(q.bot)}; --depth: ${depth}`, onclick: () => go("quest", q.id) },
        depth ? h("span", { class: "flowelbow", "aria-hidden": "true" }) : null,
        keycap(q.bot.character, 30, mood(q), q.bot.type),
        h("span", { class: "flowmain" }, h("b", {}, kindWord ? h("span", { class: "chip" }, kindWord) : null, q.title.replace(/^(Question|Request|Decision needed): /, "")), h("span", { class: "flowsub" }, `${q.bot.name} · ${departmentOf(q.bot.id)}${q.parent ? ` · from ${q.parent.by}` : ""} · ${doing}`), q.said ? h("span", { class: "flowsaid" }, q.said.replace(/\s+/g, " ").slice(0, 200)) : null),
        h("span", { class: "flowmeta" }, pct != null ? h("span", { class: "track", title: `Step ${q.steps || 0} of up to ${q.budget.steps}` }, h("span", { style: `width: ${pct}%; background: var(--bot)` })) : null, h("span", { title: q.chain && q.chain.tasks > 1 ? `This task alone: ${money(q.cost || 0)}. With the ${q.chain.tasks - 1} it handed on: ${money(q.chain.cost)}, of a shared budget of ${money(q.chain.budget)}.` : "" }, q.chain && q.chain.tasks > 1 ? `${elapsed(q.createdAt)} · ${money(q.chain.cost)} with ${q.chain.tasks - 1} handed on` : `${elapsed(q.createdAt)} · ${money(q.cost || 0)}`)),
      ),
      ...childrenOf(q.id).flatMap((c) => flow(c, depth + 1)),
    ];
  };

  // ----- how each department is doing this week -----
  const depts = new Map();
  const row = (name) => depts.get(name) ?? depts.set(name, { name, agents: 0, active: 0, waiting: 0, done: 0, failed: 0, spent: 0 }).get(name);
  for (const b of bots) row(departmentOf(b.id)).agents++;
  for (const q of active) (q.approvals?.length ? row(departmentOf(q.bot.id)).waiting++ : row(departmentOf(q.bot.id)).active++);
  for (const q of week) (succeeded.includes(q) ? row(departmentOf(q.bot.id)).done++ : row(departmentOf(q.bot.id)).failed++);
  for (const q of weekAll) row(departmentOf(q.bot.id)).spent += q.cost || 0;
  const rows = [...depts.values()].sort((a, b) => b.active + b.waiting + b.done + b.failed - (a.active + a.waiting + a.done + a.failed) || a.name.localeCompare(b.name));
  const busiest = Math.max(1, ...rows.map((r) => r.active + r.waiting + r.done + r.failed));
  const idle = rows.filter((r) => r.active + r.waiting + r.done + r.failed === 0).map((r) => r.name);
  const stuck = rows.filter((r) => r.waiting > 0 && r.waiting >= r.active).map((r) => r.name);
  const insight = !weekAll.length
    ? "No work yet this week. Assign a first task above: pick an agent and use one of the suggestions."
    : [stuck.length ? `${stuck.join(", ")} ${stuck.length === 1 ? "is" : "are"} waiting on you more than working: clear the approvals to unblock ${stuck.length === 1 ? "it" : "them"}.` : "", idle.length && idle.length < rows.length ? `No work this week in ${idle.slice(0, 4).join(", ")}${idle.length > 4 ? ` and ${idle.length - 4} more` : ""}.` : "", week.length - succeeded.length ? `${week.length - succeeded.length} task${week.length - succeeded.length === 1 ? "" : "s"} did not finish cleanly: open ${week.length - succeeded.length === 1 ? "it" : "them"} under Completed work.` : ""].filter(Boolean).join(" ") || "Work is flowing: nothing is blocked on you.";

  fill(ui.board, 
    h("div", { class: "board-head" }, h("div", {}, h("h1", {}, "Work in progress"), h("p", { class: "lead" }, "Assign work, clear what is waiting on you, and see how each department is doing."))),
    composer,
    h(
      "section",
      { class: "stats" },
      stat("Waiting on you", String(needs.length), needs.length ? "Approvals, reviews and failures" : "Nothing blocked", needs.length > 0),
      stat("In progress", String(active.length), active.length ? `${new Set(active.map((q) => q.bot.id)).size} agent${new Set(active.map((q) => q.bot.id)).size === 1 ? "" : "s"} working` : "No tasks under way"),
      stat("Finished this week", String(week.length), week.length ? `${Math.round((succeeded.length / week.length) * 100)}% finished cleanly` : "None yet"),
      stat("Spent this week", money(spent), weekAll.length ? `${money(spent / weekAll.length)} a task on average` : "Estimated from list prices"),
    ),
    needs.length
      ? h("section", { class: "worksec" }, h("div", { class: "row" }, h("h2", { class: "grow" }, "Waiting on you"), h("button", { class: "plain small", onclick: () => go("inbox") }, "Open inbox →")), h("div", { class: "cards" }, needs.filter((n) => n.kind === "approval").map((n) => questCard(n.q))), h("div", { class: "needlist" }, needs.filter((n) => n.kind !== "approval").map(needRow)))
      : null,
    h(
      "section",
      { class: "worksec" },
      h("div", { class: "row" }, h("h2", { class: "grow" }, "Under way"), active.length ? h("span", { class: "note small" }, "Indented tasks were handed on by the one above") : null),
      active.length ? h("div", { class: "flow" }, roots.flatMap((q) => flow(q))) : h("div", { class: "card quiet" }, h("b", {}, "Nothing under way."), h("span", { class: "note" }, " Assign a task above. A lead will split it across its team, and each hand-off shows here beneath it.")),
    ),
    ((results) =>
      results.length
        ? h("section", { class: "worksec" }, h("div", { class: "row" }, h("h2", { class: "grow" }, "Latest results"), h("button", { class: "plain small", onclick: () => go("inbox") }, "All updates →")), h("div", { class: "updates" }, results.map((q) => updateCard(q, { compact: true }))))
        : null)(ownTasks().filter((q) => !isLive(q)).slice(0, 3)),
    h(
      "section",
      { class: "worksec" },
      h("div", { class: "row" }, h("h2", { class: "grow" }, `Departments this week · ${activeOrg().name || "your organization"}`), h("button", { class: "plain small", onclick: () => go("team") }, "Organization →")),
      h("p", { class: "note insight" }, insight),
      h(
        "div",
        { class: "depttable", role: "table" },
        h("div", { class: "dhead", role: "row" }, ...["Department", "Agents", "Working", "Waiting on you", "Finished", "Not clean", "Spent", "Load"].map((x) => h("span", { role: "columnheader" }, x))),
        rows.map((r) =>
          h("div", { class: "drow", role: "row" }, h("b", {}, r.name), h("span", {}, String(r.agents)), h("span", {}, String(r.active)), h("span", { class: r.waiting ? "loud" : "" }, String(r.waiting)), h("span", {}, String(r.done)), h("span", { class: r.failed ? "warn" : "" }, String(r.failed)), h("span", {}, money(r.spent)), h("span", { class: "track" }, h("span", { style: `width: ${Math.round(((r.active + r.waiting + r.done + r.failed) / busiest) * 100)}%; background: var(--accent)` }))),
        ),
      ),
    ),
    coreQuests(),
  );
}

/** One thing that needs the person, other than an approval: a review, a failed check, a failure, a budget reached. */
function needRow(n) {
  if (!n.q) {
    const words = n.kind === "chat" ? [n.c.title || "A chat", "A chat is waiting for your approval", () => go("chat", n.c.id)] : n.kind === "monthly" ? [`${n.bot.name} has reached its monthly budget`, "It starts no new work until you raise it", () => go("bot", n.bot.id)] : ["The monthly budget for all agents is used up", "No agent starts new work until you raise it", () => go("team")];
    return h("button", { class: "needrow", onclick: words[2] }, h("span", { class: "flowmain" }, h("b", {}, words[0]), h("span", { class: "flowsub" }, words[1])), h("span", { class: "pill loud" }, "Open"));
  }
  const why = { review: "Changes ready for your review", check: "Finished, but its check failed", failed: n.q.note ? `Failed: ${n.q.note}` : "Failed", budget: "Stopped at its budget: say “continue” to keep going" }[n.kind] ?? "";
  return h("button", { class: "needrow", style: botStyle(n.q.bot), onclick: () => go("quest", n.q.id) }, keycap(n.q.bot.character, 30, mood(n.q), n.q.bot.type), h("span", { class: "flowmain" }, h("b", {}, n.q.title), h("span", { class: "flowsub" }, `${n.q.bot.name} · ${departmentOf(n.q.bot.id)} · ${why}`)), h("span", { class: "pill loud" }, n.kind === "review" ? "Review" : "Open"));
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
    { class: "core worksec" },
    h("div", { class: "row" }, h("h2", { class: "grow" }, "Checked task templates"), h("span", { class: "note small" }, "Ready-made tasks whose result is checked automatically before it counts as done")),
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
          h("span", { class: "mono small muted" }, `${bot ? bot.name : t.bot} · check: ${checkWords(t.check) || "your review"}`),
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
      ? h("div", { class: "now wait" }, `◌ ${q.bot.name} wants to use ${NAMES[approval.name] || approval.name}`)
      : h("div", { class: "now" }, `● ${q.bot.name} · step ${q.steps || 1}${q.budget?.steps ? ` of up to ${q.budget.steps}` : ""} · ${doing}`),
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
    h("h2", { class: "label" }, "Completed work"),
    done.length
      ? done.slice(0, 40).map((q) => {
          const [label, tone] = standing(q);
          const detail = q.status === "failed" && q.note ? q.note : q.resumedAt ? "picked up after a restart" : q.branch ? q.branch : "";
          return h(
            "button",
            { class: "logitem", style: botStyle(q.bot), onclick: () => go("quest", q.id) },
            h("div", { class: "head" }, h("b", {}, q.title), h("span", { class: `pill ${tone}` }, label)),
            h("div", { class: "meta" }, [q.bot.name, shortWhen(q.updatedAt), q.chain && q.chain.tasks > 1 ? `${money(q.chain.cost)} for ${q.chain.tasks} tasks` : q.cost >= 0.005 ? money(q.cost) : "", detail].filter(Boolean).join(" · ")),
          );
        })
      : h("p", { class: "note" }, "Finished tasks appear here, with what became of them."),
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

/** Tasks the person assigned themselves (not the parts handed on from them), newest first. */
const ownTasks = () => (state.quests ?? []).filter((q) => q.chain).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
/** When the person last looked at their updates; an update newer than this is unread. */
const seenUpdates = () => {
  try {
    return localStorage.getItem("talqava.updatesSeen") || "";
  } catch {
    return "";
  }
};
const unreadUpdates = () => ownTasks().filter((q) => !isLive(q) && String(q.updatedAt) > seenUpdates());

/** One update from the team, as a message: who, what happened, what they said, what it cost. */
function updateCard(q, { compact = false } = {}) {
  const live = isLive(q);
  const waiting = q.approvals?.length;
  const failed = q.status === "failed" || q.status === "budget" || (q.check && !q.check.passed);
  const headline = waiting ? "needs your approval" : live ? "is working on" : q.status === "failed" ? "could not finish" : q.status === "budget" ? "stopped at its budget" : q.status === "stopped" ? "was stopped on" : "finished";
  const parts = q.chain?.tasks > 1 ? `${q.chain.finished} of ${q.chain.tasks - 1} parts finished${q.chain.working ? `, ${q.chain.working} under way` : ""} (${(q.chain.who ?? []).join(", ")})` : "";
  const doing = live && !waiting ? (q.activity ? `${NAMES[q.activity.name] || q.activity.name}: ${summarize(q.activity.name, q.activity.input)}` : "Thinking") : "";
  const words = q.status === "failed" && q.note ? q.note : q.said;
  const unread = !live && String(q.updatedAt) > seenUpdates();
  return h(
    "article",
    { class: `update ${live ? "live" : ""} ${failed ? "bad" : ""} ${unread ? "unread" : ""}`, style: botStyle(q.bot), onclick: () => go("quest", q.id), tabindex: "0", onkeydown: (e) => e.key === "Enter" && go("quest", q.id) },
    keycap(q.bot.character, compact ? 30 : 40, mood(q), q.bot.type),
    h(
      "div",
      { class: "grow" },
      h("div", { class: "uhead" }, h("b", {}, `${q.bot.name} ${headline}`), h("span", { class: "utime" }, `${shortWhen(q.updatedAt)} · ${money(q.chain?.cost ?? q.cost ?? 0)}`)),
      h("div", { class: "utitle" }, q.title),
      doing ? h("div", { class: "unow" }, h("i", { class: "dot", "aria-hidden": "true" }), doing) : null,
      parts ? h("div", { class: "uparts" }, parts) : null,
      words ? h("div", { class: `uwords ${compact ? "short" : ""}` }, compact ? words.slice(0, 220) + (words.length > 220 ? "…" : "") : words) : live ? null : h("div", { class: "uwords muted" }, "It left no report."),
      h("div", { class: "ufoot" }, h("button", { class: "plain small", onclick: (e) => (e.stopPropagation(), (state.openReceipt = q.id), go("quest", q.id)) }, "See the receipt →")),
    ),
  );
}

function syncInboxCount() {
  if (!ui.inboxCount) return;
  const n = inboxItems().needs.length + unreadUpdates().length;
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
  // Updates count as read a moment after the Inbox is opened, so the ones that were new are still marked this time.
  clearTimeout(ui.seenTimer);
  ui.seenTimer = setTimeout(() => (remember("talqava.updatesSeen", new Date().toISOString()), syncInboxCount()), 4000);
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
    if (n.kind === "budget") return row(q.bot, `${q.title} stopped at its budget`, `${q.bot.name} · say “continue” in the task to keep going`, null, [h("button", { onclick: () => go("quest", q.id) }, "Open")]);
    if (n.kind === "chat") return row(null, "A chat is waiting for your approval", n.c.title, null, [h("button", { class: "primary", onclick: () => go("chat", n.c.id) }, "Open chat")]);
    if (n.kind === "monthly") return row(n.bot, `${n.bot.name} has reached its monthly budget`, `${money(n.bot.month.spent)} of ${money(n.bot.month.limit)} · it starts no new work until you raise it`, null, [h("button", { class: "primary", onclick: () => go("bot", n.bot.id) }, "Raise budget")]);
    return row(null, "Your agents have reached the monthly budget for all agents", "No agent starts new work until you raise it or the month turns.", null, [h("button", { class: "primary", onclick: () => go("team") }, "Change budget")]);
  };
  const live = working.filter((w) => w.q).length;
  fill(
    ui.inbox,
    h(
      "div",
      { class: "row" },
      h("div", { class: "grow" }, h("h1", {}, "Inbox"), h("p", { class: "lead" }, "What needs you, what is being worked on, and what got done today, across chats and agents.")),
      live ? h("button", { class: "danger", onclick: () => confirm(`Stop the ${live} bot${live === 1 ? "" : "s"} working now? Their work so far is kept, and you can say “continue” later.`) && act(() => Promise.all(working.filter((w) => w.q).map((w) => api("POST", `quests/${w.q.id}/stop`)))) }, "Stop all agents") : null,
    ),
    ((updates) =>
      h(
        "section",
        {},
        h("h2", { class: "label" }, `Updates from your team · ${updates.length}`),
        updates.length ? updates.map((q) => updateCard(q)) : h("p", { class: "note" }, "When you assign a task, each update and the final report arrive here."),
      ))(ownTasks().filter((q) => Date.now() - new Date(q.updatedAt).getTime() < 7 * 24 * 3600 * 1000).slice(0, 20)),
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
/** What a role answers for: its targets, what it decides itself, and what it must take to its lead. Nothing when its file says none. */
function governanceBox(bot) {
  const g = bot?.governance;
  if (!g || !(g.kpis?.length || g.decides?.length || g.escalates?.length)) return null;
  const col = (label, items) => (items?.length ? h("div", { class: "gcol" }, h("div", { class: "label" }, label), h("ul", {}, items.map((x) => h("li", {}, x)))) : null);
  return h("div", { class: "govern" }, col("Measured on", g.kpis), col("Decides itself", g.decides), col("Must escalate", g.escalates));
}

/**
 * A small picture of how each structure's chart is drawn: you at the top in
 * the accent colour, leads outlined, the rest filled. Solid lines are
 * reporting lines; dashed ones are a matrix's project lines or peer links.
 */
function structureDiagram(id) {
  const W = 22;
  const H = 12;
  const box = (x, y, kind = "") => `<rect class="sd-box ${kind}" x="${x - W / 2}" y="${y - H / 2}" width="${W}" height="${H}" rx="3.5"/>`;
  const line = (x1, y1, x2, y2, kind = "") => `<path class="sd-line ${kind}" d="M${x1} ${y1}L${x2} ${y2}"/>`;
  // A lead above a row of reports, joined by an elbow.
  const fan = (px, py, xs, cy) => {
    const mid = (py + cy) / 2;
    return line(px, py + H / 2, px, mid) + (xs.length > 1 ? line(Math.min(...xs), mid, Math.max(...xs), mid) : "") + xs.map((x) => line(x, mid, x, cy - H / 2)).join("");
  };
  let body = "";
  if (id === "hierarchical") {
    body = fan(120, 14, [70, 170], 46) + fan(70, 46, [44, 96], 78) + fan(170, 46, [144, 196], 78) + [44, 96, 144, 196].map((x) => line(x, 84, x, 98) + box(x, 104)).join("") + box(120, 14, "top") + box(70, 46, "lead") + box(170, 46, "lead") + [44, 96, 144, 196].map((x) => box(x, 78, "lead")).join("");
  } else if (id === "functional") {
    const heads = [50, 120, 190];
    body = fan(120, 14, heads, 46) + heads.map((x) => line(x, 52, x, 98) + box(x, 46, "lead") + box(x, 76) + box(x, 104)).join("") + box(120, 14, "top");
  } else if (id === "divisional") {
    const divs = [48, 120, 192];
    body = fan(120, 12, divs, 44) + divs.map((x) => `<rect class="sd-group" x="${x - 32}" y="30" width="64" height="84" rx="7"/>` + fan(x, 46, [x - 15, x + 15], 76) + line(x - 15, 82, x - 15, 96) + line(x + 15, 82, x + 15, 96) + box(x, 46, "lead") + box(x - 15, 76) + box(x + 15, 76) + box(x - 15, 102) + box(x + 15, 102)).join("") + box(120, 12, "top");
  } else if (id === "matrix") {
    const cols = [92, 146, 200];
    const rows = [64, 96];
    body = fan(146, 12, cols, 36) + cols.map((x) => line(x, 42, x, 96)).join("") + rows.map((y) => line(38, y, 200, y, "dash")).join("") + rows.map((y) => box(38, y, "lead")).join("") + cols.map((x) => box(x, 36, "lead") + rows.map((y) => box(x, y)).join("")).join("") + box(146, 12, "top");
  } else if (id === "team") {
    const pods = [48, 120, 192];
    body = fan(120, 12, pods, 44) + pods.map((x) => `<rect class="sd-group" x="${x - 32}" y="30" width="64" height="84" rx="32"/>` + line(x - 15, 76, x + 15, 76, "dash") + line(x - 15, 76, x, 100, "dash") + line(x + 15, 76, x, 100, "dash") + line(x, 52, x - 15, 70) + line(x, 52, x + 15, 70) + box(x, 46, "lead") + box(x - 15, 76) + box(x + 15, 76) + box(x, 100)).join("") + box(120, 12, "top");
  } else if (id === "flat") {
    const xs = [30, 66, 102, 138, 174, 210];
    body = fan(120, 30, xs, 82) + line(30, 82, 210, 82, "dash") + xs.map((x) => box(x, 82)).join("") + box(120, 30, "top");
  } else {
    body = line(120, 26, 120, 44) + line(70, 44, 170, 44) + line(70, 44, 70, 58) + line(170, 44, 170, 58) + box(120, 20, "top") + `<rect class="sd-box ghost" x="59" y="58" width="22" height="12" rx="3.5"/><rect class="sd-box ghost" x="159" y="58" width="22" height="12" rx="3.5"/><rect class="sd-box ghost" x="109" y="88" width="22" height="12" rx="3.5"/>` + line(120, 82, 120, 70, "dash") + `<path class="sd-plus" d="M120 60v8M116 64h8"/>`;
  }
  const wrap = h("div", {});
  wrap.innerHTML = `<svg viewBox="0 0 240 120" aria-hidden="true">${body}</svg>`;
  return wrap.firstChild;
}

async function teamView() {
  ui.body.className = "body";
  ui.log = null;
  const col = h("div", { class: "team" });
  fill(ui.body, h("main", { class: "center" }, col));
  await Promise.all([loadCrew(), loadOrgs()]);
  if (state.view !== "team") return;
  const again = () => teamView();
  const org = activeOrg();
  const structures = state.orgs.structures ?? [];
  const assignRules = state.orgs.assignRules ?? {};
  const requestRules = state.orgs.requestRules ?? {};
  const industries = state.orgs.industries ?? [];
  const industry = industries.find((i) => i.id === org.industry) ?? industries[0] ?? { id: "", name: "", examples: "", recommended: [], why: "", seats: {} };
  const structure = structures.find((x) => x.id === org.structure) ?? structures[0] ?? { id: "", name: "", summary: "", philosophy: "", bestFor: "", watchOut: "", shape: "" };
  const orgMemory = (ui.orgView ?? "teams") === "memory" && org.id ? await api("GET", `orgs/${org.id}/memory`).catch(() => []) : [];
  if (state.view !== "team") return;
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
    return q ? (q.status === "waiting" ? ["◌ Needs you", true] : ["● Working", true]) : bot.month?.state === "stopped" ? ["■ At budget", true] : ["Available", false];
  };

  // ----- which organization -----
  const newName = h("input", { placeholder: "Name, e.g. your company", maxlength: 50, "aria-label": "Name of the new organization" });
  const newMission = h("input", { placeholder: "What it is for, in a sentence (optional)", maxlength: 300, "aria-label": "Mission" });
  const newStructure = h("select", { "aria-label": "Structure" }, structures.map((x) => h("option", { value: x.id, selected: x.id === "functional" }, `${x.name}: ${x.summary}`)));
  const newForm = h("form", { class: "card orgform", hidden: true, onsubmit: (e) => (e.preventDefault(), save(() => api("POST", "orgs", { name: newName.value, mission: newMission.value, structure: newStructure.value }))) }, h("b", {}, "New organization"), h("p", { class: "note small" }, "It starts empty. Add agents to it from below or from the marketplace; an agent can be in more than one organization."), newName, newMission, h("label", { class: "field" }, "How it is run", newStructure), h("div", { class: "row" }, h("button", { class: "primary" }, "Create organization"), h("button", { type: "button", onclick: () => (newForm.hidden = true) }, "Cancel")));
  const rename = h("input", { value: org.name, maxlength: 50, "aria-label": "Organization name" });
  const mission = h("input", { value: org.mission, maxlength: 300, placeholder: "What the organization is for, in a sentence. Every agent is told it.", "aria-label": "Mission" });
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
      state.orgs.orgs.length > 1 ? h("button", { type: "button", class: "plain danger", onclick: () => confirm(`Delete the organization “${org.name}”? Its chart is deleted. The agents themselves are kept.`) && save(() => api("DELETE", `orgs/${org.id}`)) }, "Delete organization") : null,
    ),
  );
  const pick = h("select", { "aria-label": "Organization", class: "orgpick" }, state.orgs.orgs.map((o) => h("option", { value: o.id, selected: o.id === org.id }, o.name)));
  pick.addEventListener("change", () => save(() => api("PATCH", `orgs/${pick.value}`, { active: true })));

  // ----- how the organization is run: its structure and the philosophy behind it -----
  const ownPhilosophy = h("textarea", { rows: 4, maxlength: 1200, placeholder: "How your organization works, in your own words. For example: decisions are made by whoever is closest to the customer; anything over $500 comes to me first." }, org.philosophy ?? "");
  const ownRule = h("select", {}, Object.entries(assignRules).map(([id, words]) => h("option", { value: id, selected: id === (org.assign ?? "reports") }, words)));
  // What setting a structure up will do, said before it is done.
  const setUpWords = (x) => {
    const missing = (industry.seats?.[x.id] ?? []).filter((id) => !byId.has(id)).length;
    const layers = { hierarchical: "a general manager, then department heads, then their specialists", functional: "department heads reporting to you, with their specialists beneath them", matrix: "departments under a general manager, with a project lead on dotted lines", team: "teams that each own an outcome, a lead with its mix of specialists", flat: "one small level: a specialist from each department, all reporting to you, and no managers" }[x.id];
    const size = industry.sizes?.[x.id];
    const leaving = members.filter((m) => !(industry.seats?.[x.id] ?? []).includes(m.bot)).length;
    return `Set up ${org.name} as “${x.name}” for ${industry.name.toLowerCase()}?\n\nThe chart is redrawn as ${layers}. It will have exactly ${size?.agents ?? 0} agents in ${size?.departments ?? 0} ${x.id === "team" ? "teams" : "departments"}.${missing ? ` ${missing} ${missing === 1 ? "is" : "are"} added from the marketplace.` : ""}${leaving ? ` ${leaving} agent${leaving === 1 ? "" : "s"} now on the chart ${leaving === 1 ? "is" : "are"} not part of this set-up and leave${leaving === 1 ? "s" : ""} it; ${leaving === 1 ? "it stays" : "they stay"} on your team and can be added back.` : ""}`;
  };
  const structureCard = (x) => {
    const current = x.id === org.structure;
    return h(
      "div",
      { class: `scard ${current ? "on" : ""}` },
      h("div", { class: "sdiagram", role: "img", "aria-label": `A sample ${x.name} chart: ${x.shape}` }, structureDiagram(x.id)),
      h("div", { class: "shead" }, h("b", {}, x.name), h("span", { class: "row" }, industry.recommended?.includes(x.id) ? h("span", { class: "chip rec", title: industry.why }, industry.recommended[0] === x.id ? "Recommended" : "Also suits you") : null, current ? h("span", { class: "chip on" }, "In use") : null)),
      h("p", { class: "ssum" }, x.summary),
      ((size) => h("div", { class: "ssize" }, size?.agents ? [h("span", {}, h("b", {}, String(size.agents)), " agents"), h("span", {}, h("b", {}, String(size.departments)), x.id === "team" ? " teams" : " departments"), h("span", {}, h("b", {}, String(size.levels)), size.levels === 1 ? " level" : " levels")] : h("span", {}, "You decide who is on it")))(industry.sizes?.[x.id]),
      h("div", { class: "ssec" }, h("div", { class: "label" }, "Philosophy"), x.id === "custom" ? h("label", { class: "field" }, "Write yours. Every agent is told this.", ownPhilosophy) : h("p", {}, x.philosophy)),
      h("div", { class: "ssec" }, h("div", { class: "label" }, "Recommended for"), h("div", { class: "sbiz" }, (x.businesses ?? []).map((b) => h("span", { class: "chip" }, b))), h("p", {}, x.bestFor)),
      h("div", { class: "ssec" }, h("div", { class: "label" }, "Watch out for"), h("p", {}, x.watchOut)),
      h("div", { class: "ssec" }, h("div", { class: "label" }, "How work moves"), x.id === "custom" ? ownRule : h("p", {}, assignRules[x.assign] ?? ""), x.id === "custom" || x.assign === "anyone" ? null : h("p", { class: "gap" }, requestRules[x.request] ?? "")),
      h("div", { class: "ssec" }, h("div", { class: "label" }, "When two leads disagree"), h("p", {}, x.tieBreak)),
      h(
        "div",
        { class: "sactions" },
        x.id === "custom"
          ? h("button", { class: "primary", onclick: () => save(() => api("PATCH", `orgs/${org.id}`, { structure: "custom", philosophy: ownPhilosophy.value, assign: ownRule.value })) }, current ? "Save" : "Use my own structure")
          : [
              h("button", { class: "primary", onclick: () => confirm(setUpWords(x)) && ((ui.orgStructures = false), (ui.orgOpen = ""), (ui.orgView = "teams"), (ui.orgSel = null), save(async () => (await api("POST", `orgs/${org.id}/build`, { structure: x.id }), await loadCrew()))) }, current ? "Set up the chart this way" : "Set up this structure"),
            ],
      ),
    );
  };
  // A new organization that still has only the standard agents opens on this choice.
  ui.orgStructures ??= org.structure === "flat" && members.length > 0 && members.every((m) => byId.get(m.bot).source === "starter");
  const industryPick = h("select", { "aria-label": "Your kind of business", onchange: (e) => save(() => api("PATCH", `orgs/${org.id}`, { industry: e.target.value })) }, industries.map((i) => h("option", { value: i.id, selected: i.id === industry.id }, i.name)));
  const structurePanel = h(
    "section",
    { class: "card structures", hidden: !ui.orgStructures },
    h("div", { class: "row" }, h("h2", { class: "grow" }, "How should this organization be run?"), h("button", { class: "plain", "aria-label": "Close", onclick: () => ((ui.orgStructures = false), again()) }, "✕")),
    h("p", { class: "note" }, "Two choices. Your kind of business decides which departments and roles the chart is staffed with. The structure is the management philosophy: what every agent is told about how to work, who may hand work to whom, and who settles a disagreement. The chart stays yours to edit."),
    h("div", { class: "sbusiness" }, h("label", { class: "field" }, "1. Your kind of business", industryPick), h("div", { class: "grow" }, h("p", { class: "note" }, industry.examples), h("p", { class: "note" }, h("b", {}, "Our recommendation: "), `${(industry.recommended ?? []).map((id) => structures.find((x) => x.id === id)?.name).filter(Boolean).join(", or ")}. ${industry.why}`))),
    h("div", { class: "label", style: "margin-top: 18px" }, "2. The structure"),
    h("div", { class: "sgrid" }, [...structures].sort((a, b) => ((i) => (i < 0 ? 9 : i))((industry.recommended ?? []).indexOf(a.id)) - ((i) => (i < 0 ? 9 : i))((industry.recommended ?? []).indexOf(b.id))).map(structureCard)),
  );

  // Everything on this page is arranged by dragging. What is being dragged is one of:
  // a member already on the chart, an agent on the team that is not on it, an agent
  // or a ready-made team from the marketplace. Dropping it on an agent makes it report
  // there (a team brings its own reports along); dropping it on You makes it report to you.
  const dropOn = (managerId) => {
    const d = ui.orgDrag;
    ui.orgDrag = null;
    if (!d) return;
    if (d.kind === "member") {
      const m = members.find((x) => x.bot === d.id);
      if (!m || d.id === managerId || (m.manager ?? null) === (managerId ?? null)) return;
      return save(() => api("PUT", `orgs/${org.id}/members`, { bot: d.id, manager: managerId }));
    }
    if (d.kind === "agent") return save(() => api("PUT", `orgs/${org.id}/members`, { bot: d.id, manager: managerId }));
    if (d.kind === "market") return save(async () => (await api("POST", `marketplace/${d.id}/add`), await loadCrew(), await api("PUT", `orgs/${org.id}/members`, { bot: d.id, manager: managerId }), (state.market = null)));
    if (d.kind === "team") {
      return save(async () => {
        await api("POST", `marketplace/teams/${d.id}/add`);
        await loadCrew();
        // The team's lead takes the place it was dropped on; its own reports came with it.
        if (d.lead && d.lead !== managerId) await api("PUT", `orgs/${org.id}/members`, { bot: d.lead, manager: managerId }).catch(() => {});
        state.market = null;
      });
    }
  };
  const dropZone = (managerId) => ({
    ondragover: (e) => {
      if (!ui.orgDrag || (ui.orgDrag.kind === "member" && ui.orgDrag.id === managerId)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "move";
      e.currentTarget.classList.add("drop");
    },
    ondragleave: (e) => e.currentTarget.classList.remove("drop"),
    ondrop: (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.currentTarget.classList.remove("drop");
      dropOn(managerId);
    },
  });
  /** Makes something draggable, carrying what it is. The page shows where it may be dropped while it is in the air. */
  const draggable = (payload) => ({
    draggable: "true",
    ondragstart: (e) => {
      ui.orgDrag = payload;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", payload.id);
      e.currentTarget.classList.add("dragging");
      col.classList.add("dragging-on");
      col.classList.toggle("dragging-member", payload.kind === "member");
    },
    ondragend: (e) => {
      ui.orgDrag = null;
      e.currentTarget.classList.remove("dragging");
      col.classList.remove("dragging-on", "dragging-member");
    },
  });
  // Dropping a member here takes it off the chart.
  const removeZone = () =>
    h(
      "div",
      {
        class: "removezone",
        ondragover: (e) => {
          if (ui.orgDrag?.kind !== "member") return;
          e.preventDefault();
          e.currentTarget.classList.add("drop");
        },
        ondragleave: (e) => e.currentTarget.classList.remove("drop"),
        ondrop: (e) => {
          e.preventDefault();
          e.currentTarget.classList.remove("drop");
          const d = ui.orgDrag;
          ui.orgDrag = null;
          const m = d?.kind === "member" ? members.find((x) => x.bot === d.id) : null;
          if (m) minus(m);
        },
      },
      "− Drop here to remove from the chart",
    );

  // ----- one member, on the chart or in a department -----
  const pickMember = (id) => ((ui.orgSel = ui.orgSel === id ? null : id), (ui.orgPanel = null), again());
  const node = (m) => {
    const bot = byId.get(m.bot);
    const [status, loud] = statusOf(bot);
    const reports = members.filter((x) => x.manager === m.bot).length;
    return h(
      "button",
      {
        class: `onode ${ui.orgSel === m.bot ? "on" : ""} ${bot.month?.state === "stopped" ? "stopped" : ""}`,
        style: botStyle(bot),
        onclick: () => pickMember(m.bot),
        title: `${bot.name}: ${m.title}. Drag onto another agent to change who it reports to.`,
        ...draggable({ kind: "member", id: m.bot }),
        ...dropZone(m.bot),
      },
      keycap(bot.character, 44, mood(live.get(bot.id)), bot.type),
      h("b", {}, bot.name),
      h("span", { class: "otitle" }, m.title.toLowerCase() === bot.name.toLowerCase() ? m.department : m.title),
      h("span", { class: `mono small ${loud ? "" : "muted"}` }, reports ? `${status} · leads ${reports}` : status),
      m.also && byId.get(m.also) ? h("span", { class: "odotted", title: "Project lead (dotted line)" }, `⋯ ${byId.get(m.also).name}`) : null,
    );
  };
  // Everyone beneath a member on the chart.
  const under = (botId) => {
    const all = new Set([botId]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const x of members) if (x.manager && all.has(x.manager) && !all.has(x.bot)) (all.add(x.bot), (grew = true));
    }
    all.delete(botId);
    return all;
  };
  const openPanel = (panel) => ((ui.orgPanel = panel), (ui.orgSel = null), panel ? (ui.orgOpen = "") : null, again());
  // Minus takes an agent off the chart (asking first what to do with a lead's team); plus adds one beneath it.
  const minus = (m) => {
    const bot = byId.get(m.bot);
    if (under(m.bot).size) return openPanel({ kind: "remove", bot: m.bot });
    if (confirm(`Take the ${bot.name} off the chart of ${org.name}? It stays on your team and can be added back.`)) save(() => api("DELETE", `orgs/${org.id}/members/${m.bot}`));
  };
  const controls = (m) =>
    h(
      "span",
      { class: "nodectl" },
      h("button", { class: "ctl minus", title: `Remove the ${byId.get(m.bot).name} from the chart`, "aria-label": `Remove ${byId.get(m.bot).name}`, onclick: (e) => (e.stopPropagation(), minus(m)) }, "−"),
      h("button", { class: "ctl plus", title: `Add an agent reporting to the ${byId.get(m.bot).name}`, "aria-label": `Add an agent under ${byId.get(m.bot).name}`, onclick: (e) => (e.stopPropagation(), openPanel({ kind: "add", under: m.bot })) }, "+"),
    );
  const nodeWrap = (m) => h("div", { class: "onodewrap" }, node(m), controls(m));
  const branch = (managerId) => {
    const kids = members.filter((m) => m.manager === managerId).sort((a, b) => a.department.localeCompare(b.department) || a.title.localeCompare(b.title));
    return kids.length ? h("ul", {}, kids.map((m) => h("li", {}, nodeWrap(m), branch(m.bot)))) : null;
  };

  // ----- the panel a plus or minus opens -----
  const panel = () => {
    const p = ui.orgPanel;
    if (!p) return null;
    const close = h("button", { class: "plain", "aria-label": "Close", onclick: () => openPanel(null) }, "✕");
    if (p.kind === "orgs") {
      const all = state.orgs.orgs;
      const nameOf = (id) => structures.find((x) => x.id === id)?.name ?? "";
      return h(
        "section",
        { class: "card memberbox orgpanel" },
        h("div", { class: "row" }, h("div", { class: "grow" }, h("h2", {}, `Your organizations · ${all.length}`), h("div", { class: "note" }, "Open one to work on it, or delete one you no longer need. Deleting removes its chart and its memory; the agents themselves stay on your team, and chats and tasks are kept.")), close),
        h(
          "div",
          { class: "pickrows" },
          all.map((o) =>
            h(
              "div",
              { class: "pickrow" },
              h("span", { class: "flowmain" }, h("b", {}, o.name, o.id === org.id ? h("span", { class: "chip on", style: "margin-left: 8px" }, "Open now") : null), h("span", { class: "flowsub" }, `${o.members.length} agent${o.members.length === 1 ? "" : "s"} · ${new Set(o.members.map((m) => m.department)).size} department${new Set(o.members.map((m) => m.department)).size === 1 ? "" : "s"} · ${nameOf(o.structure)}${o.mission ? ` · ${o.mission}` : ""}`)),
              o.id === org.id ? null : h("button", { onclick: () => ((ui.orgPanel = null), (ui.orgSel = null), save(() => api("PATCH", `orgs/${o.id}`, { active: true }))) }, "Open"),
              all.length > 1
                ? h("button", { class: "danger", onclick: () => confirm(`Delete the organization “${o.name}”?\n\nIts chart (${o.members.length} agent${o.members.length === 1 ? "" : "s"}) and its memory are deleted and cannot be brought back. The agents stay on your team.`) && ((ui.orgSel = null), save(() => api("DELETE", `orgs/${o.id}`))) }, "Delete")
                : h("span", { class: "note small", title: "Create another organization first" }, "Your only organization"),
            ),
          ),
        ),
        all.length === 1 ? h("p", { class: "note small" }, "An organization can be deleted once you have more than one. To empty this one instead, use Start over.") : null,
      );
    }
    if (p.kind === "reset") {
      const size = industry.sizes?.[org.structure];
      const recipe = size?.agents ? `${size.agents} agents in ${size.departments} ${org.structure === "team" ? "teams" : "departments"}` : "";
      const done = (mode) => ((ui.orgPanel = null), (ui.orgSel = null), save(async () => (await api("POST", `orgs/${org.id}/reset`, { mode }), await loadCrew())));
      return h(
        "section",
        { class: "card memberbox orgpanel" },
        h("div", { class: "row" }, h("div", { class: "grow" }, h("h2", {}, `Start ${org.name} over?`), h("div", { class: "note" }, `The chart has ${members.length} agent${members.length === 1 ? "" : "s"} now. Starting over changes the chart only: every agent stays on your team, and your chats, tasks and memory are kept.`)), close),
        h(
          "div",
          { class: "resetchoices" },
          recipe
            ? h("div", { class: "resetchoice" }, h("b", {}, `Reset to the standard ${structure.name.toLowerCase()} chart`), h("p", { class: "note" }, `Exactly what ${structure.name.toLowerCase()} calls for in ${industry.name.toLowerCase()}: ${recipe}. Agents you added that are not part of it leave the chart, and every reporting line goes back to the standard.`), h("button", { class: "primary", onclick: () => done("recipe") }, `Reset to ${size.agents} agents`))
            : null,
          h("div", { class: "resetchoice" }, h("b", {}, "Clear the chart"), h("p", { class: "note" }, "An empty chart with nobody on it. Build it yourself by dragging in agents and teams, or choose a structure afterwards."), h("button", { class: "danger", onclick: () => done("empty") }, "Clear to 0 agents")),
        ),
        h("div", {}, h("button", { class: "plain", onclick: () => openPanel(null) }, "Cancel")),
      );
    }
    if (p.kind === "remove") {
      const m = members.find((x) => x.bot === p.bot);
      if (!m) return null;
      const bot = byId.get(m.bot);
      const below = under(m.bot);
      const boss = m.manager ? byId.get(m.manager)?.name : "you";
      return h(
        "section",
        { class: "card memberbox orgpanel", style: botStyle(bot) },
        h("div", { class: "row" }, keycap(bot.character, 40, "", bot.type), h("div", { class: "grow" }, h("h2", {}, `Remove the ${bot.name}?`), h("div", { class: "note" }, `${below.size} agent${below.size === 1 ? " is" : "s are"} beneath it on the chart. Agents taken off the chart stay on your team and can be added back.`)), close),
        h(
          "div",
          { class: "row" },
          h("button", { class: "danger", onclick: () => ((ui.orgPanel = null), save(() => api("DELETE", `orgs/${org.id}/teams/${m.bot}`))) }, `− Remove the whole team (${below.size + 1} agents)`),
          h("button", { onclick: () => ((ui.orgPanel = null), save(() => api("DELETE", `orgs/${org.id}/members/${m.bot}`))) }, `− Remove only the ${bot.name}: its reports move up to ${boss}`),
          h("button", { class: "plain", onclick: () => openPanel(null) }, "Cancel"),
        ),
      );
    }
    const lead = p.under ? byId.get(p.under) : null;
    if (p.under && !members.some((x) => x.bot === p.under)) return null;
    const find = h("input", { type: "search", placeholder: "Search by role, e.g. bookkeeper or marketing", "aria-label": "Search agents", value: ui.orgAddSearch ?? "" });
    const results = h("div", { class: "addlist" });
    const place = (botId) => save(() => api("PUT", `orgs/${org.id}/members`, { bot: botId, manager: p.under ?? null }));
    const draw = () => {
      const needle = find.value.trim().toLowerCase();
      const match = (text) => !needle || text.toLowerCase().includes(needle);
      const mine = outside.filter((b) => match(`${b.name} ${b.group} ${b.instructions}`));
      const market = (state.market ?? []).filter((b) => !b.added && !byId.has(b.id) && match(`${b.name} ${b.listing.category} ${b.listing.summary}`));
      const rowFor = (b, sub, onclick) => h("button", { class: "addrow", style: botStyle(b), onclick }, keycap(b.character, 30, "", b.type), h("span", { class: "flowmain" }, h("b", {}, b.name), h("span", { class: "flowsub" }, sub)), h("span", { class: "pill loud" }, "+ Add"));
      fill(
        results,
        mine.length ? h("div", { class: "label" }, "On your team, not on this chart") : null,
        mine.map((b) => rowFor(b, `${b.group} · ${b.instructions.split(/(?<=[.!?])\s/)[0].slice(0, 90)}`, () => place(b.id))),
        market.length ? h("div", { class: "label" }, "From the marketplace") : null,
        market.slice(0, needle ? 30 : 12).map((b) => rowFor(b, `${b.listing.category} · ${b.listing.summary.slice(0, 90)}`, () => save(async () => (await api("POST", `marketplace/${b.id}/add`), await loadCrew(), await api("PUT", `orgs/${org.id}/members`, { bot: b.id, manager: p.under ?? null }), (state.market = null))))),
        !mine.length && !market.length ? h("p", { class: "note" }, state.market ? "Nothing matches. Try other words, or create your own agent." : "Loading the marketplace…") : null,
        !needle && market.length > 12 ? h("p", { class: "note small" }, `${market.length - 12} more in the marketplace: search to find them.`) : null,
      );
    };
    find.addEventListener("input", () => ((ui.orgAddSearch = find.value), draw()));
    if (!state.market) loadMarket().then(draw).catch(() => {});
    draw();
    setTimeout(() => find.focus(), 0);
    return h(
      "section",
      { class: "card memberbox orgpanel", style: lead ? botStyle(lead) : "" },
      h("div", { class: "row" }, lead ? keycap(lead.character, 40, "", lead.type) : h("span", { class: "youmark", "aria-hidden": "true" }, "You"), h("div", { class: "grow" }, h("h2", {}, lead ? `Add an agent under the ${lead.name}` : "Add an agent reporting to you"), h("div", { class: "note" }, "Pick one. It joins the chart at this place, and you can drag it elsewhere afterwards.")), close),
      find,
      results,
      h("div", { class: "row" }, h("button", { onclick: () => go("market") }, "Add a whole team from the marketplace"), h("button", { onclick: () => go("bot", "new") }, "Create your own agent")),
    );
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
    const reports = members.filter((x) => x.manager === m.bot || x.also === m.bot);
    const showAlso = org.structure === "matrix" || org.structure === "custom" || Boolean(m.also);
    const also = h("select", {}, h("option", { value: "", selected: !m.also }, "None"), members.filter((x) => x.bot !== m.bot).map((x) => h("option", { value: x.bot, selected: x.bot === m.also }, `${byId.get(x.bot).name} · ${x.title}`)));
    const mates = m.manager ? members.filter((x) => x.manager === m.manager && x.bot !== m.bot) : [];
    const rule = org.assignRule ?? "reports";
    const handsTo = rule === "anyone" ? "any other agent" : [...reports, ...(rule === "team" ? mates : [])].map((r) => byId.get(r.bot).name).join(", ");
    const month = bot.month ?? { spent: 0, limit: null, state: "ok" };
    const boss0 = m.manager ? byId.get(m.manager) : null;
    return h(
      "section",
      { class: "card memberbox personcard", style: botStyle(bot) },
      h("div", { class: "row" }, keycap(bot.character, 56, mood(live.get(bot.id)), bot.type), h("div", { class: "grow" }, h("h2", {}, bot.name), h("div", { class: "note" }, bot.instructions.split(/(?<=[.!?])\s/)[0].replace(/^I am the organization's [^:.]*: /, "I ").replace(/^I am the organization's /, "The organization's ")), h("div", { class: "note small" }, boss0 ? `Works for the ${boss0.name}${reports.length ? ` · manages ${reports.length}` : ""}` : `Works directly for you${reports.length ? ` · manages ${reports.length}` : ""}`)), h("button", { class: "plain", onclick: () => pickMember(m.bot), "aria-label": "Close" }, "✕")),
      h(
        "div",
        { class: "row" },
        h("button", { class: "primary big", onclick: () => chatWith(bot, col) }, "Chat with it"),
        h("button", { class: "big", onclick: () => ((state.selectedBot = bot.id), remember("talqava.bot", bot.id), go("home")) }, "Give it a task"),
        h("button", { class: "plain danger", onclick: () => ((ui.orgSel = null), minus(m)) }, "Remove from my team"),
      ),
      h(
        "details",
        { class: "moreabout", open: ui.orgRoleOpen ? "" : null, ontoggle: (e) => (ui.orgRoleOpen = e.target.open) },
        h("summary", {}, h("b", {}, "Change its job, or who it works for")),
        h(
          "div",
          { class: "body" },
      h(
        "form",
        { class: "rolegrid", onsubmit: (e) => (e.preventDefault(), save(() => api("PUT", `orgs/${org.id}/members`, { bot: m.bot, title: title.value, department: dept.value, manager: boss.value || null, ...(showAlso ? { also: also.value || null } : {}) }))) },
        h("label", { class: "field" }, "Job title", title),
        h("label", { class: "field" }, "Team or department", dept),
        h("label", { class: "field" }, "Works for", boss),
        showAlso ? h("label", { class: "field", title: "A second lead, such as a project lead, who may also give this agent tasks" }, "Project lead (dotted line)", also) : null,
        h("button", { class: "primary" }, "Save"),
      ),
      h("p", { class: "note small" }, `${handsTo ? `The ${bot.name} can hand tasks to ${handsTo}, and gets their reports back.` : `Nobody takes tasks from the ${bot.name}, so it does its work itself. Drag another agent onto it to give it a report.`} It can ask any colleague a question, and shares the organization's memory.`),
      governanceBox(bot),
      month.limit != null || month.spent >= 0.001 ? h("div", { class: "mono small muted" }, month.limit != null ? `${money(month.spent)} of ${money(month.limit)} this month` : `${money(month.spent)} this month · no limit`) : null,
      bar(month, colorOf(bot.character, bot.type)),
          h("div", {}, h("button", { onclick: () => go("bot", bot.id) }, month.state === "stopped" ? "Raise its budget" : "Edit everything about this agent")),
        ),
      ),
    );
  };

  function depts_() {
    return [...new Set(members.map((m) => m.department))].sort();
  }
  const limit = h("input", { type: "number", min: 0, step: 1, value: total.limit ?? "", placeholder: "No limit", "aria-label": "Monthly budget for all agents, in dollars" });
  const stat = (label, value, loud) => h("div", { class: "stat" }, h("span", { class: "label" }, label), h("b", { class: loud ? "loud" : "" }, value));
  const view = ui.orgView ?? "teams";
  const chartView = view === "chart";
  const tab = (id, label) => h("button", { role: "tab", class: view === id ? "on" : "", "aria-selected": String(view === id), onclick: () => ((ui.orgView = id), again()) }, label);
  // A team is a lead and the agents that report to it.
  const leads = members.filter((m) => members.some((x) => x.manager === m.bot));
  // The tray: what can be dragged onto the chart. Ready-made teams, the person's agents that are not on it, and the marketplace.
  const trayFind = h("input", { type: "search", placeholder: "Find an agent or team to drag in, e.g. bookkeeper", "aria-label": "Find an agent or team", value: ui.traySearch ?? "" });
  const trayItems = h("div", { class: "trayitems" });
  const drawTray = () => {
    const needle = trayFind.value.trim().toLowerCase();
    const match = (text) => !needle || text.toLowerCase().includes(needle);
    const addNow = (payload) => ((ui.orgDrag = payload), dropOn(null));
    const chip = (bot, payload, sub) => h("div", { class: "traychip", style: botStyle(bot), role: "button", tabindex: "0", title: `Click to add it reporting to you, or drag it onto an agent or a team. ${sub}`, onclick: () => addNow(payload), ...draggable(payload) }, keycap(bot.character, 26, "", bot.type), h("span", { class: "flowmain" }, h("b", {}, bot.name), h("span", { class: "flowsub" }, sub)));
    const mine = outside.filter((b) => match(`${b.name} ${b.group}`));
    const teams = (state.marketTeams ?? []).filter((t) => match(`${t.name} ${t.summary}`));
    const market = (state.market ?? []).filter((b) => !byId.has(b.id) && match(`${b.name} ${b.listing.category} ${b.listing.summary}`));
    const marketById = new Map((state.market ?? []).map((b) => [b.id, b]));
    fill(
      trayItems,
      teams.length
        ? h(
            "div",
            { class: "traygroup" },
            h("span", { class: "label" }, "Ready-made teams"),
            h(
              "div",
              { class: "trayrow" },
              teams.map((t) => {
                const onChart = t.bots.filter((id) => members.some((m) => m.bot === id));
                const all = onChart.length === t.bots.length;
                const payload = { kind: "team", id: t.id, lead: t.bots[0] };
                return h(
                  "div",
                  { class: `traychip team ${all ? "have" : ""}`, title: `${t.summary} Drag it onto the board, or use + and −.`, ...draggable(payload) },
                  h("span", { class: "teamstack" }, t.bots.slice(0, 3).map((id) => (marketById.get(id) ? keycap(marketById.get(id).character, 22, "", marketById.get(id).type) : null))),
                  h("span", { class: "flowmain" }, h("b", {}, t.name), h("span", { class: "flowsub" }, all ? `All ${t.bots.length} on your chart` : onChart.length ? `${onChart.length} of ${t.bots.length} on your chart` : `${t.bots.length} agents · led by the ${marketById.get(t.bots[0])?.name ?? "lead"}`)),
                  all ? null : h("button", { class: "ctl plus", title: `Add the ${t.name} to your chart`, "aria-label": `Add the ${t.name}`, onclick: (e) => (e.stopPropagation(), addNow(payload)) }, "+"),
                  onChart.length
                    ? h(
                        "button",
                        {
                          class: "ctl minus",
                          title: `Take the ${t.name} off your chart`,
                          "aria-label": `Remove the ${t.name}`,
                          onclick: (e) => {
                            e.stopPropagation();
                            if (!confirm(`Take the ${t.name} off your chart?\n\n${onChart.length} agent${onChart.length === 1 ? "" : "s"} leave${onChart.length === 1 ? "s" : ""} the chart. They stay on your team and can be added back with +.`)) return;
                            // Members first, their lead last, so nobody is moved up the chart on the way out.
                            save(async () => { for (const id of [...onChart].reverse()) await api("DELETE", `orgs/${org.id}/members/${id}`); });
                          },
                        },
                        "−",
                      )
                    : null,
                );
              }),
            ),
          )
        : null,
      mine.length ? h("div", { class: "traygroup" }, h("span", { class: "label" }, "Your agents, not on this chart"), h("div", { class: "trayrow" }, mine.map((b) => chip(b, { kind: "agent", id: b.id }, b.group)))) : null,
      market.length ? h("div", { class: "traygroup" }, h("span", { class: "label" }, needle ? "From the marketplace" : "From the marketplace (search for more)"), h("div", { class: "trayrow" }, market.slice(0, needle ? 24 : 8).map((b) => chip(b, { kind: "market", id: b.id }, b.listing.category)))) : null,
      !teams.length && !mine.length && !market.length ? h("p", { class: "note" }, state.market ? "Nothing matches. Try other words." : "Loading…") : null,
    );
  };
  trayFind.addEventListener("input", () => ((ui.traySearch = trayFind.value), drawTray()));
  const tray = () => {
    if (!state.market) loadMarket().then(drawTray).catch(() => {});
    drawTray();
    return h("section", { class: "card tray" }, h("div", { class: "row" }, h("div", { class: "grow" }, h("b", {}, "Add to my team"), h("div", { class: "note small" }, "Click one to add it. Or drag it onto a team to put it there.")), trayFind), trayItems, removeZone());
  };

  // The team builder: each lead's team as a card, the agents working alone under the person, and a place to start a new team.
  const solo = members.filter((m) => !m.manager && !leads.includes(m));
  // One person on a list: a badge, a name, a line on what it does. Click to open it; drag to move it; drop on it to put someone under it.
  const blurb = (bot) => {
    // What it does, in its own words. A first sentence that only states its title ("I am a recruiter.") is skipped for the next one.
    const sentences = bot.instructions.split(/(?<=[.!?])\s+/);
    const first = /^I am (a|an|the) [^,:]{0,60}\.$/i.test(sentences[0] ?? "") && sentences[1] ? sentences[1] : (sentences[0] ?? "");
    return first.replace(/^I am the organization's [^:.]*: /, "").replace(/^./, (c) => c.toUpperCase()).slice(0, 110);
  };
  const personRow = (m, tag) => {
    const bot = byId.get(m.bot);
    const [status, loud] = statusOf(bot);
    return h(
      "div",
      { class: "onodewrap personwrap" },
      h(
        "button",
        { class: `person ${ui.orgSel === m.bot ? "on" : ""}`, style: botStyle(bot), title: "Click to chat with it or give it work. Drag to move it.", onclick: () => pickMember(m.bot), ...draggable({ kind: "member", id: m.bot }), ...dropZone(m.bot) },
        keycap(bot.character, 34, mood(live.get(bot.id)), bot.type),
        h("span", { class: "flowmain" }, h("b", {}, bot.name, tag ? h("span", { class: "chip", style: "margin-left: 8px" }, tag) : null), h("span", { class: "flowsub" }, blurb(bot))),
        loud ? h("span", { class: "pill loud" }, status.replace(/^[●◌■] /, "")) : null,
      ),
      controls(m),
    );
  };
  const teamCard = (lead) => {
    const bot = byId.get(lead.bot);
    const list = members.filter((x) => x.manager === lead.bot);
    const dotted = members.filter((x) => x.also === lead.bot);
    const parent = lead.manager ? byId.get(lead.manager) : null;
    // A team is named after what it does: its department, or the outcome it owns.
    const name = lead.department && lead.department !== "Leadership" ? lead.department : bot.name;
    return h(
      "div",
      { class: "dept teamcard", style: botStyle(bot), ...dropZone(lead.bot) },
      h("div", { class: "row" }, h("div", { class: "grow" }, h("h2", {}, name), h("div", { class: "note small" }, `${list.length + 1} agent${list.length ? "s" : ""}${parent ? ` · part of the ${parent.name}'s team` : ""}`)), h("button", { class: "ctl plus", title: "Add someone to this team", "aria-label": `Add someone to ${name}`, onclick: () => openPanel({ kind: "add", under: lead.bot }) }, "+"), h("button", { class: "ctl minus", title: "Remove this team", "aria-label": `Remove ${name}`, onclick: () => openPanel({ kind: "remove", bot: lead.bot }) }, "−")),
      h("div", { class: "people" }, personRow(lead, "Manager"), list.map((x) => personRow(x, members.some((y) => y.manager === x.bot) ? "Manages a team" : "")), dotted.map((x) => personRow(x, "Also helps here"))),
      h("div", {}, h("button", { class: "teamtask", title: "The manager shares the work out across the team and brings back one result", onclick: () => ((state.selectedTeam = lead.bot), go("home")) }, "Give this team a task")),
    );
  };
  const teamsView = () =>
    h(
      "div",
      { class: "teamboard" },
      solo.length || !leads.length
        ? h(
            "div",
            { class: "dept youlane", ...dropZone(null) },
            h("div", { class: "row" }, h("span", { class: "youmark", "aria-hidden": "true" }, "You"), h("div", { class: "grow" }, h("h2", {}, "Works directly for you"), h("div", { class: "note small" }, `${solo.length} agent${solo.length === 1 ? "" : "s"}`)), h("button", { class: "ctl plus", title: "Add someone who works directly for you", "aria-label": "Add someone who works directly for you", onclick: () => openPanel({ kind: "add", under: null }) }, "+")),
            h("div", { class: "people two" }, solo.map((x) => personRow(x, ""))),
          )
        : null,
      leads.length ? h("section", { class: "depts" }, leads.map((lead) => ((card) => (card.setAttribute("data-team", lead.bot), card))(teamCard(lead)))) : null,
    );
  const shelfOf = (e) => (e.shelf === "org" ? "Whole organization" : e.shelf === "dept" ? `${e.key} department` : `${byId.get(e.key)?.name ?? e.key}${e.kind === "log" ? " · past work" : " · notes"}`);
  const memText = h("textarea", { rows: 2, maxlength: 800, placeholder: "Something every agent should know. For example: our fiscal year starts in April; never promise delivery dates without checking with Operations." });
  const memShelf = h("select", { "aria-label": "Who should know this" }, h("option", { value: "org:" }, "Whole organization"), depts_().map((d) => h("option", { value: `dept:${d}` }, `${d} department`)));
  const memoryView = () => {
    const groups = new Map();
    for (const e of orgMemory) groups.set(shelfOf(e), [...(groups.get(shelfOf(e)) ?? []), e]);
    const order = [...groups.keys()].sort((a, b) => Number(b === "Whole organization") - Number(a === "Whole organization") || a.localeCompare(b));
    return h(
      "section",
      { class: "orgmem" },
      h("p", { class: "note" }, "What the organization remembers across every task. Each agent sees the organization's entries, its own department's, and its own notes and past work. Only what bears on the task in hand is sent to the model, so memory can grow without every task costing more. You can add, correct or remove anything here."),
      h("form", { class: "card form", onsubmit: (e) => (e.preventDefault(), save(() => api("POST", `orgs/${org.id}/memory`, { text: memText.value, shelf: memShelf.value.startsWith("dept:") ? "dept" : "org", key: memShelf.value.slice(memShelf.value.indexOf(":") + 1) }))) }, h("b", {}, "Add to memory"), memText, h("div", { class: "row" }, memShelf, h("button", { class: "primary" }, "Remember"))),
      orgMemory.length
        ? order.map((name) =>
            h(
              "div",
              { class: "memgroup" },
              h("h2", { class: "label" }, `${name} · ${groups.get(name).length}`),
              groups.get(name).slice().reverse().map((e) =>
                h("div", { class: "card memrow" }, h("div", { class: "grow mtext" }, e.text), h("span", { class: "mono small muted" }, e.kind === "log" ? "Recorded automatically" : `Saved by ${e.by}`), h("button", { class: "plain danger", "aria-label": "Remove this entry", onclick: () => save(() => api("DELETE", `orgs/${org.id}/memory/${e.id}`)) }, "Remove")),
              ),
            ),
          )
        : h("div", { class: "card" }, h("b", {}, "Nothing remembered yet."), h("p", { class: "note" }, "Agents save decisions, facts and how jobs are done as they work, and each finished task is recorded here automatically.")),
    );
  };
  const depts = depts_();
  // A wide chart opens centred on the top of the tree, not on its left edge.
  setTimeout(() => {
    const wrap = col.querySelector(".chartwrap");
    if (wrap && wrap.scrollWidth > wrap.clientWidth) wrap.scrollLeft = ui.orgScroll?.[org.id + org.structure] ?? (wrap.scrollWidth - wrap.clientWidth) / 2;
    wrap?.addEventListener("scroll", () => (ui.orgScroll = { [org.id + org.structure]: wrap.scrollLeft }), { passive: true });
  }, 0);
  // ----- the simple set-up: two plain questions, then one button -----
  const PLAIN = {
    flat: ["Small and simple", "A handful of agents who all report to you. The easiest way to start."],
    functional: ["Departments", "A head for each department with its specialists under it. You manage the heads."],
    hierarchical: ["A manager runs it for me", "A general manager looks after the department heads. You mostly deal with one agent."],
    team: ["Teams built around goals", "Small mixed teams, each owning one result, such as winning customers."],
    matrix: ["Shared specialists on projects", "Specialists belong to a department and also work for a project lead."],
    custom: ["My own way", "Start from an empty board, build it yourself and write your own rules."],
  };
  const plainName = (id) => PLAIN[id]?.[0] ?? structure.name;
  const fresh = org.structure === "flat" && members.length > 0 && members.every((m) => byId.get(m.bot).source === "starter");
  const open = ui.orgOpen ?? (fresh || !members.length ? "run" : "");
  const show = (what) => ((ui.orgOpen = open === what ? "" : what), (ui.orgPanel = null), again());
  const wizard = () => {
    const picked = ui.wizStructure ?? (fresh || !members.length ? (industry.recommended ?? []).find((id) => ["flat", "functional", "hierarchical"].includes(id)) ?? "functional" : org.structure);
    const size = industry.sizes?.[picked];
    const choice = (id) =>
      h(
        "button",
        { class: `waychoice ${picked === id ? "on" : ""}`, "aria-pressed": String(picked === id), onclick: () => ((ui.wizStructure = id), again()) },
        h("span", { class: "waydiagram", "aria-hidden": "true" }, structureDiagram(id)),
        h("span", { class: "flowmain" }, h("b", {}, PLAIN[id][0], industry.recommended?.[0] === id ? h("span", { class: "chip rec", style: "margin-left: 8px" }, "Recommended") : null), h("span", { class: "waywords" }, PLAIN[id][1]), industry.sizes?.[id]?.agents ? h("span", { class: "flowsub" }, `${industry.sizes[id].agents} agents · ${industry.sizes[id].departments} ${id === "team" ? "teams" : "departments"}`) : null),
      );
    const basic = ["flat", "functional", "hierarchical"];
    const more = ["team", "matrix", "custom"];
    const showMore = ui.wizMore || more.includes(picked);
    const go = h("button", { class: "primary big" }, picked === "custom" ? "Start with an empty board" : size?.agents ? `Set up my team · ${size.agents} agents` : "Set up my team");
    go.addEventListener("click", () => {
      const replacing = members.length && !fresh;
      if (replacing && !confirm(`Set ${org.name} up again as “${PLAIN[picked][0]}”?\n\n${picked === "custom" ? "Your board stays as it is; only the rules change." : `The board is redrawn with exactly ${size?.agents ?? "the"} agents for this choice. Agents that are not part of it leave the board; they stay available under “Add agents or a team”.`}`)) return;
      go.disabled = true;
      go.textContent = "Setting up…";
      ui.orgOpen = "";
      ui.orgView = "teams";
      ui.orgSel = null;
      save(async () => {
        if (picked === "custom") await api("PATCH", `orgs/${org.id}`, { structure: "custom" });
        else await api("POST", `orgs/${org.id}/build`, { structure: picked, industry: industry.id, exact: true });
        await loadCrew();
      });
    });
    return h(
      "section",
      { class: "card wizard" },
      h("div", { class: "row" }, h("div", { class: "grow" }, h("h2", {}, fresh || !members.length ? "Set up your team" : "Change how your team is set up"), h("p", { class: "note" }, "Answer two questions and your team of AI agents is ready. You can change anything afterwards.")), fresh || !members.length ? null : h("button", { class: "plain", "aria-label": "Close", onclick: () => show("run") }, "✕")),
      h("div", { class: "wizstep" }, h("div", { class: "wiznum" }, "1"), h("div", { class: "grow" }, h("b", {}, "What kind of business is it?"), h("div", { class: "biztiles" }, industries.map((i) => h("button", { class: `biztile ${i.id === industry.id ? "on" : ""}`, "aria-pressed": String(i.id === industry.id), title: i.examples, onclick: () => i.id !== industry.id && save(() => api("PATCH", `orgs/${org.id}`, { industry: i.id })) }, h("b", {}, i.name), h("span", {}, i.examples)))))),
      h(
        "div",
        { class: "wizstep" },
        h("div", { class: "wiznum" }, "2"),
        h("div", { class: "grow" }, h("b", {}, "How do you want to run it?"), h("div", { class: "waychoices" }, basic.map(choice), showMore ? more.map(choice) : null), h("div", { class: "row" }, showMore ? h("button", { class: "plain link", onclick: () => ((ui.orgCompare = !ui.orgCompare), again()) }, ui.orgCompare ? "Hide the full comparison" : "Compare all of them in detail") : h("button", { class: "plain link", onclick: () => ((ui.wizMore = true), again()) }, "Not sure, or want something else? Show more ways"))),
      ),
      h("div", { class: "wizgo" }, go, h("span", { class: "note" }, picked === "custom" ? "Nobody is added. Drag agents and teams onto the board yourself." : size?.agents ? `Your board will have exactly ${size.agents} agents in ${size.departments} ${picked === "team" ? "teams" : "departments"} for ${industry.name.toLowerCase()}, each already reporting to the right lead.` : "")),
      ui.orgCompare ? h("div", { class: "sgrid" }, [...structures].map(structureCard)) : null,
    );
  };

  // ----- spending rules, kept out of the way -----
  const rulesPanel = () =>
    h(
      "section",
      { class: "card rulespanel" },
      h("div", { class: "row" }, h("div", { class: "grow" }, h("h2", {}, "Spending rules"), h("p", { class: "note" }, "Agents never pay, send or sign anything themselves. These set when they must stop and ask you.")), h("button", { class: "plain", "aria-label": "Close", onclick: () => show("rules") }, "✕")),
          h("form", { class: "row spendlimit", onsubmit: (e) => (e.preventDefault(), save(() => api("PATCH", `orgs/${org.id}`, { approvalLimit: approvalInput.value === "" ? null : Number(approvalInput.value) }))) }, h("label", { class: "note", for: "approval-limit" }, "Needs your approval: any spending or commitment above ($)"), approvalInput, h("button", {}, "Save"), h("span", { class: "note small" }, org.approvalLimit ? "" : "Blank means every one needs you.")),
      h(
        "section",
        { class: `card allbudget ${total.state}` },
        h("div", { class: "row" }, h("h2", { class: "label grow" }, `Budget for all agents · resets ${budgets?.resets ?? ""}`), total.state === "stopped" ? h("span", { class: "pill loud" }, "■ Stopped: no agent starts new work") : total.state === "warned" ? h("span", { class: "pill loud" }, "Past 80%") : null),
        bar(total),
        h("form", { class: "row", onsubmit: (e) => (e.preventDefault(), attempt(async () => ((state.config = await api("PUT", "settings", { monthlyBudget: limit.value === "" ? null : Number(limit.value) })), again()), col)) }, h("span", { class: "note" }, "Per month ($)"), limit, h("button", {}, "Save")),
        h("p", { class: "note small" }, "Agents are warned at 80% and start no new work at 100%, until you raise the budget or the month turns. Each agent can have its own monthly budget too. Spend is estimated from list prices."),
      ),
    );

  const teamCount = leads.length;
  const needWord = needs ? ` · ${needs} need${needs === 1 ? "s" : ""} you` : "";
  const moreItem = (label, onclick, title) => h("button", { class: "moreitem", title: title || label, onclick }, label);
  col.append(
    ...[
      h(
        "div",
        { class: "row orghead" },
        h("div", { class: "grow" }, h("div", { class: "row" }, h("h1", {}, org.name || "Your team"), state.orgs.orgs.length > 1 ? pick : null), h("p", { class: "lead" }, members.length ? `${members.length} AI agent${members.length === 1 ? "" : "s"}${teamCount ? ` in ${teamCount} team${teamCount === 1 ? "" : "s"}` : ", all working directly for you"}${needWord}` : "Nobody on your team yet")),
        h("button", { class: "primary", onclick: () => ((ui.orgTray = !ui.orgTray), (ui.orgOpen = ""), again()) }, ui.orgTray ? "Done adding" : "＋ Add to my team"),
        h("button", { "aria-expanded": String(Boolean(ui.orgMore)), onclick: () => ((ui.orgMore = !ui.orgMore), again()) }, "More ▾"),
      ),
      ui.orgMore
        ? h(
            "div",
            { class: "moremenu" },
            moreItem("Change my set-up", () => ((ui.orgMore = false), show("run")), "Your kind of business and how the team is run"),
            moreItem("Spending limits", () => ((ui.orgMore = false), show("rules")), "When agents must ask you, and the monthly budget"),
            moreItem("What my team remembers", () => ((ui.orgMore = false), (ui.orgOpen = ""), (ui.orgView = view === "memory" ? "teams" : "memory"), again()), "Facts and decisions your agents keep"),
            moreItem("Rename", () => ((ui.orgMore = false), show("rename"))),
            moreItem("Add another organization", () => ((ui.orgMore = false), show("new"))),
            moreItem(`My organizations (${state.orgs.orgs.length})`, () => ((ui.orgMore = false), (ui.orgOpen = ""), openPanel({ kind: "orgs" })), "Open or delete an organization"),
            moreItem("Start over", () => ((ui.orgMore = false), (ui.orgOpen = ""), openPanel({ kind: "reset" })), "Reset the team to the standard set-up, or clear it"),
          )
        : null,
      open === "run" ? wizard() : null,
      open === "rules" ? rulesPanel() : null,
      open === "rename" ? ((editForm.hidden = false), editForm) : null,
      open === "new" ? ((newForm.hidden = false), newForm) : null,
      ui.orgPanel?.kind === "reset" || ui.orgPanel?.kind === "orgs" ? panel() : null,
      view === "memory"
        ? h("div", { class: "row" }, h("h2", { class: "grow", style: "margin: 0; font-size: 16px" }, "What my team remembers"), h("button", { onclick: () => ((ui.orgView = "teams"), again()) }, "← Back to my team"))
        : members.length
          ? h("div", { class: "row" }, h("span", { class: "note grow" }, "Click anyone to chat with them or give them work. Drag someone onto a team to move them."), h("div", { class: "viewswitch", role: "group", "aria-label": "View" }, h("button", { class: view === "teams" ? "on" : "", "aria-pressed": String(view === "teams"), onclick: () => ((ui.orgView = "teams"), again()) }, "List"), h("button", { class: view === "chart" ? "on" : "", "aria-pressed": String(view === "chart"), onclick: () => ((ui.orgView = "chart"), again()) }, "Chart")))
          : null,
      view === "memory" ? null : detail(),
      ui.orgTray && view !== "memory" ? tray() : null,
      view === "memory"
        ? memoryView()
        : !members.length
          ? h("div", { class: "card quiet" }, h("b", {}, "Nobody is on the board yet."), h("span", { class: "note" }, " Answer the two questions above, or press “Add agents or a team” and drag some in."))
          : view === "chart"
            ? h("div", { class: "chartwrap" }, h("div", { class: `tree ${members.length > 10 ? "dense" : ""}` }, h("ul", {}, h("li", {}, h("div", { class: "onodewrap" }, h("div", { class: "onode you", title: "Drop an agent here to have it report to you", ...dropZone(null) }, h("span", { class: "youmark", "aria-hidden": "true" }, "You"), h("b", {}, "You"), h("span", { class: "otitle" }, "Owner")), h("span", { class: "nodectl" }, h("button", { class: "ctl plus", title: "Add an agent reporting to you", "aria-label": "Add an agent reporting to you", onclick: () => openPanel({ kind: "add", under: null }) }, "+"))), branch(null)))))
            : teamsView(),
      view === "memory" || ui.orgPanel?.kind === "reset" || ui.orgPanel?.kind === "orgs" ? null : panel(),
      h("datalist", { id: "org-depts" }, depts.map((d) => h("option", { value: d }))),
    ].filter(Boolean),
  );
}

// ---------- the library ----------
// Documents the person shares with their agents. Files are dropped here (or
// into the folder itself); the app reads them into the organization's
// database, and agents search them as they work. Each document says who may use it.
const sizeWords = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);

const LIB_ICONS = {
  folder: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4.2l2 2.2h8.8A1.5 1.5 0 0 1 21 9.7v8.8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z"/></svg>',
  lock: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="5" y="10.5" width="14" height="9.5" rx="2"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/></svg>',
  ai: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 3v3M12 18v3M3 12h3M18 12h3"/><rect x="7" y="7" width="10" height="10" rx="2.5"/></svg>',
  up: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M6 11l6-6 6 6"/></svg>',
};
const libIcon = (name, cls = "") => {
  const node = h("span", { class: `libicon ${cls}`, "aria-hidden": "true" });
  node.innerHTML = LIB_ICONS[name];
  return node;
};
const libParent = (rel) => (rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "");
const libBase = (rel) => rel.slice(rel.lastIndexOf("/") + 1);
const IMAGE_TYPES = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg"]);
const VIDEO_TYPES = new Set(["mp4", "mov", "webm"]);
const AUDIO_TYPES = new Set(["mp3", "m4a", "wav", "ogg"]);
const KIND_COLORS = { pdf: "#ff6b6b", doc: "#5aa9ff", docx: "#5aa9ff", xls: "#3ddc84", xlsx: "#3ddc84", csv: "#3ddc84", ppt: "#ffb020", pptx: "#ffb020", md: "#b8b8b8", txt: "#b8b8b8" };

/** Says in a few words who may use something: every agent, some departments, or nobody (private). */
function accessLabel(item, bots) {
  const a = item.access;
  if (a.private) return "Private";
  if (a.everyone) return "All agents";
  const names = [...a.departments, ...a.agents.map((x) => bots.get(x)?.name ?? x)];
  return names.length ? (names.length > 2 ? `${names.slice(0, 2).join(", ")} +${names.length - 2}` : names.join(", ")) : "No agents";
}

/** A small modal: resolves with what the person chose, or null. */
function libDialog(title, body, buttons) {
  return new Promise((resolve) => {
    const dialog = h("dialog", { class: "needs libdialog" });
    const done = (value) => (dialog.close(), dialog.remove(), resolve(value));
    fill(dialog, h("h2", {}, title), body, h("div", { class: "row end" }, h("button", { class: "plain", onclick: () => done(null) }, "Cancel"), buttons.map(([label, value, primary]) => h("button", { class: primary ? "primary" : "", onclick: () => done(typeof value === "function" ? value() : value) }, label))));
    dialog.addEventListener("cancel", (e) => (e.preventDefault(), done(null)));
    document.body.append(dialog);
    dialog.showModal();
  });
}

/** Asks who may use one or more files or folders. Resolves with a body for the server, or null. */
async function askAccess(lib, bots, targets) {
  const first = targets[0].item;
  const current = targets.length === 1 ? (first.accessSet ? (first.access.private ? "private" : first.access.everyone ? "everyone" : "some") : "inherit") : "everyone";
  const choice = (value, title, text) => h("label", { class: `accesschoice ${value}` }, h("input", { type: "radio", name: "libaccess", value, checked: value === current }), h("span", {}, h("b", {}, title), h("span", { class: "note small" }, text)));
  const depts = lib.departments.map((d) => [d, h("input", { type: "checkbox", checked: first.access.departments.includes(d) && !first.access.private })]);
  const agents = lib.agents.filter((a) => bots.has(a)).map((a) => [a, h("input", { type: "checkbox", checked: first.access.agents.includes(a) })]);
  const pick = h("div", { class: "accessgrid" }, h("div", {}, h("div", { class: "label" }, "Departments"), depts.map(([d, box]) => h("label", { class: "power" }, box, d))), h("div", {}, h("div", { class: "label" }, "Individual agents"), h("div", { class: "agentpick" }, agents.map(([a, box]) => h("label", { class: "power" }, box, bots.get(a).name)))));
  const body = h(
    "div",
    { class: "accesschoices" },
    h("p", { class: "note" }, targets.length === 1 ? `For “${first.name}”${targets[0].kind === "folder" ? " and everything inside it, unless something inside has its own setting" : ""}.` : `For the ${targets.length} items you selected.`),
    choice("everyone", "All agents can use it", "Every agent may search and read it."),
    choice("some", "Only some departments or agents", "Choose who below."),
    pick,
    choice("private", "Private: locked from AI", "No agent ever sees it, finds it or reads it. Only you, in this app."),
    targets.some((t) => t.item.path.includes("/") || t.kind === "file") ? choice("inherit", "Same as its folder", "Follows the folder it is in.") : null,
  );
  for (const [, box] of [...depts, ...agents]) box.addEventListener("change", () => (body.querySelector('input[value="some"]').checked = true));
  return libDialog("Who can use this?", body, [["Save", () => ({ mode: body.querySelector('input[name="libaccess"]:checked')?.value ?? "everyone", departments: depts.filter(([, b]) => b.checked).map(([d]) => d), agents: agents.filter(([, b]) => b.checked).map(([a]) => a) }), true]]);
}

/** Asks which folder to move things to. Resolves with its path ("" for the top of the library), or null. */
function askFolder(lib, moving) {
  const blocked = (p) => moving.some((m) => m.kind === "folder" && (p === m.path || p.startsWith(`${m.path}/`)));
  let chosen = null;
  const list = h("div", { class: "folderpick", role: "listbox", "aria-label": "Folders" });
  const rows = [{ path: "", name: "Library (top)" }, ...lib.folders].filter((f) => !blocked(f.path));
  const draw = () =>
    fill(list, rows.map((f) => h("button", { class: `folderopt ${chosen === f.path ? "on" : ""}`, role: "option", "aria-selected": String(chosen === f.path), style: `padding-left: ${12 + (f.path ? f.path.split("/").length : 0) * 16}px`, onclick: () => ((chosen = f.path), draw()) }, libIcon("folder"), f.path ? libBase(f.path) : f.name)));
  draw();
  return libDialog(`Move ${moving.length === 1 ? `“${libBase(moving[0].path)}”` : `${moving.length} items`} to…`, list, [["Move here", () => chosen, true]]);
}

/** Reads a dropped folder (and its sub-folders) into files with their paths. */
async function droppedFiles(dataTransfer) {
  const entries = [...(dataTransfer.items ?? [])].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return [...dataTransfer.files].map((file) => ({ file, rel: file.name }));
  const out = [];
  const visit = async (entry) => {
    if (entry.isFile) return new Promise((resolve) => entry.file((file) => (out.push({ file, rel: entry.fullPath.replace(/^\//, "") }), resolve()), () => resolve()));
    const reader = entry.createReader();
    for (;;) {
      const batch = await new Promise((resolve) => reader.readEntries(resolve, () => resolve([])));
      if (!batch.length) break;
      for (const e of batch) await visit(e);
    }
  };
  for (const e of entries) await visit(e);
  return out.filter((x) => !libBase(x.rel).startsWith("."));
}

async function libraryView() {
  ui.body.className = "body";
  ui.log = null;
  const col = h("div", { class: "library files" });
  fill(ui.body, h("main", { class: "center wide" }, col));
  const again = () => libraryView();
  let lib;
  try {
    [lib] = await Promise.all([api("GET", "library"), loadCrew()]);
  } catch (err) {
    return fill(col, h("div", { class: "banner error" }, err.message));
  }
  if (state.view !== "library") return;
  const bots = new Map((state.crew?.bots ?? []).map((b) => [b.id, b]));
  const act = (fn, note) => attempt(async () => (await fn(), note && (ui.libraryNote = note), again()), col);
  ui.libPath ??= "";
  if (ui.libPath && !lib.folders.some((f) => f.path === ui.libPath)) ui.libPath = "";
  ui.libSel ??= new Set();
  const cur = ui.libPath;
  const docById = new Map(lib.documents.map((d) => [d.id, d]));
  const folderByPath = new Map(lib.folders.map((f) => [f.path, f]));
  const keyOf = (kind, p) => `${kind}:${p}`;
  const selected = () => [...ui.libSel].map((k) => ({ kind: k.slice(0, k.indexOf(":")), path: k.slice(k.indexOf(":") + 1) })).filter((t) => (t.kind === "folder" ? folderByPath.has(t.path) : lib.documents.some((d) => d.path === t.path)));
  const itemOf = (t) => (t.kind === "folder" ? folderByPath.get(t.path) : lib.documents.find((d) => d.path === t.path));

  // ----- uploading: buttons, or dropping files and folders from the computer anywhere on the list -----
  const status = h("span", { class: "note small" });
  const upload = async (list, into = cur) => {
    list = list.filter((x) => x.file.size > 0);
    if (!list.length) return;
    const failed = [];
    let n = 0;
    for (const { file, rel } of list) {
      status.textContent = `Uploading ${++n} of ${list.length}: ${rel}…`;
      const res = await fetch(`/api/library/upload?name=${encodeURIComponent(rel)}&folder=${encodeURIComponent(into)}`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: file }).catch(() => null);
      if (!res?.ok) failed.push(`${rel}: ${(await res?.json().catch(() => ({})))?.error ?? "could not be added"}`);
    }
    ui.libraryNote = failed.length ? `Not added: ${failed.join(" · ")}` : `Uploaded ${list.length} file${list.length === 1 ? "" : "s"}.`;
    again();
  };
  const filePick = h("input", { type: "file", multiple: true, hidden: true });
  filePick.addEventListener("change", () => upload([...filePick.files].map((file) => ({ file, rel: file.name }))));
  const folderPick = h("input", { type: "file", multiple: true, hidden: true, webkitdirectory: "" });
  folderPick.addEventListener("change", () => upload([...folderPick.files].map((file) => ({ file, rel: file.webkitRelativePath || file.name }))));

  // ----- moving by drag and drop: a row onto a folder, or onto a folder in the path at the top -----
  const dropTarget = (node, folderPath) => {
    node.addEventListener("dragover", (e) => {
      if (!ui.libDrag && !e.dataTransfer.types.includes("Files")) return;
      if (ui.libDrag?.some((t) => t.kind === "folder" && (folderPath === t.path || folderPath.startsWith(`${t.path}/`)))) return;
      e.preventDefault();
      e.stopPropagation();
      node.classList.add("dropover");
    });
    node.addEventListener("dragleave", () => node.classList.remove("dropover"));
    node.addEventListener("drop", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      node.classList.remove("dropover");
      if (ui.libDrag) {
        const moving = ui.libDrag;
        ui.libDrag = null;
        if (moving.every((t) => libParent(t.path) === folderPath)) return;
        ui.libSel.clear();
        return act(() => api("POST", "library/move", { items: moving, to: folderPath }), `Moved ${moving.length === 1 ? `“${libBase(moving[0].path)}”` : `${moving.length} items`} to ${folderPath ? libBase(folderPath) : "the top of the library"}.`);
      }
      upload(await droppedFiles(e.dataTransfer), folderPath);
    });
    return node;
  };
  const draggable = (node, target) => {
    node.draggable = true;
    node.addEventListener("dragstart", (e) => {
      const key = keyOf(target.kind, target.path);
      ui.libDrag = ui.libSel.has(key) ? selected() : [target];
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", target.path);
      node.classList.add("dragging");
    });
    node.addEventListener("dragend", () => ((ui.libDrag = null), node.classList.remove("dragging")));
    return node;
  };

  // ----- the actions -----
  const rename = (t) => ((ui.libRename = keyOf(t.kind, t.path)), again());
  const moveTo = async (targets) => {
    const to = await askFolder(lib, targets);
    if (to === null) return;
    ui.libSel.clear();
    act(() => api("POST", "library/move", { items: targets, to }), `Moved to ${to ? libBase(to) : "the top of the library"}.`);
  };
  const remove = (targets) => {
    const words = targets.length === 1 ? `“${libBase(targets[0].path)}”${targets[0].kind === "folder" ? " and everything in it" : ""}` : `these ${targets.length} items`;
    if (!confirm(`Delete ${words}?\n\nThey go to Deleted, where you can put them back for 30 days. Agents can no longer use them.`)) return;
    ui.libSel.clear();
    if (targets.some((t) => t.kind === "file" && docById.get(ui.libPreview)?.path === t.path)) ui.libPreview = null;
    act(() => api("POST", "library/delete", { items: targets }), `Deleted ${words}. Find it under Deleted to put it back.`);
  };
  const setAccess = async (targets) => {
    const withItems = targets.map((t) => ({ ...t, item: itemOf(t) })).filter((t) => t.item);
    const chosen = await askAccess(lib, bots, withItems);
    if (!chosen) return;
    act(async () => {
      for (const t of withItems) {
        if (t.kind === "folder") await api("PATCH", "library/folder", { path: t.path, ...chosen });
        else await api("PATCH", `library/${t.item.id}`, chosen);
      }
    }, chosen.mode === "private" ? "Locked as private: no agent can see it." : "Saved who can use it.");
  };

  // ----- the path at the top: Library › Finance › Contracts, each a place to drop things -----
  const crumbs = [["", "Library"], ...cur.split("/").filter(Boolean).map((_, i, all) => [all.slice(0, i + 1).join("/"), all[i]])];
  const breadcrumb = h(
    "nav",
    { class: "crumbs", "aria-label": "Folder path" },
    crumbs.map(([p, name], i) => [i ? h("span", { class: "sep", "aria-hidden": "true" }, "›") : null, dropTarget(h("button", { class: `crumb ${i === crumbs.length - 1 ? "here" : ""}`, onclick: () => ((ui.libPath = p), ui.libSel.clear(), (ui.libView = "files"), again()), "aria-current": i === crumbs.length - 1 ? "page" : null }, name), p)]),
  );

  // ----- what is shown: this folder, or everything that matches a search by name -----
  const find = (ui.libFind ?? "").trim().toLowerCase();
  const sortBy = ui.libSort ?? "name";
  const order = (a, b) => (sortBy === "size" ? (b.size ?? 0) - (a.size ?? 0) : sortBy === "modified" ? (b.modified ?? 0) - (a.modified ?? 0) : a.name.localeCompare(b.name, undefined, { numeric: true }));
  const folders = (find ? lib.folders.filter((f) => f.name.toLowerCase().includes(find)) : lib.folders.filter((f) => libParent(f.path) === cur)).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const files = (find ? lib.documents.filter((d) => d.name.toLowerCase().includes(find)) : lib.documents.filter((d) => libParent(d.path) === cur)).sort(order);

  const accessChip = (item, target) =>
    h(
      "button",
      { class: `accesschip ${item.access.private ? "private" : item.access.everyone ? "all" : "some"}`, title: `${item.access.private ? "Locked from AI" : "Who can use this"}${item.accessSet ? "" : item.accessFrom !== null && item.accessFrom !== undefined ? ` · follows the folder “${item.accessFrom ? libBase(item.accessFrom) : "Library"}”` : ""}. Click to change.`, onclick: (e) => (e.stopPropagation(), setAccess([target])) },
      libIcon(item.access.private ? "lock" : "ai"),
      accessLabel(item, bots),
    );
  const checkbox = (target) => {
    const key = keyOf(target.kind, target.path);
    return h("input", { type: "checkbox", class: "pick", "aria-label": `Select ${libBase(target.path)}`, checked: ui.libSel.has(key), onclick: (e) => e.stopPropagation(), onchange: (e) => (e.target.checked ? ui.libSel.add(key) : ui.libSel.delete(key), again()) });
  };
  const nameCell = (target, label, sub) => {
    if (ui.libRename === keyOf(target.kind, target.path)) {
      const input = h("input", { class: "renamebox", value: label, "aria-label": "New name" });
      const save = () => {
        ui.libRename = null;
        const name = input.value.trim();
        if (!name || name === label) return again();
        act(() => api("POST", "library/move", { items: [target], to: libParent(target.path), name }), `Renamed to “${name}”.`);
      };
      input.addEventListener("keydown", (e) => (e.key === "Enter" ? save() : e.key === "Escape" ? ((ui.libRename = null), again()) : null));
      input.addEventListener("blur", save);
      setTimeout(() => (input.focus(), input.setSelectionRange(0, label.lastIndexOf(".") > 0 && target.kind === "file" ? label.lastIndexOf(".") : label.length)), 0);
      return h("span", { class: "fname" }, input);
    }
    return h("span", { class: "fname" }, h("b", {}, label), sub ? h("span", { class: "fsub" }, sub) : null);
  };
  const menu = (target, extra = []) =>
    h(
      "span",
      { class: "rowacts" },
      [...extra, ["Rename", () => rename(target)], ["Move", () => moveTo([target])], ["Delete", () => remove([target])]].map(([label, fn]) => h("button", { class: `plain small ${label === "Delete" ? "danger" : ""}`, onclick: (e) => (e.stopPropagation(), fn()) }, label)),
    );
  const thumb = (d) => {
    if (IMAGE_TYPES.has(d.type)) return h("img", { class: "fthumb", src: `/api/library/${d.id}/raw`, alt: "", loading: "lazy" });
    return h("span", { class: "fkind", style: `--kind: ${KIND_COLORS[d.type] ?? "#8c8c8c"}` }, (d.type || "file").slice(0, 4).toUpperCase());
  };
  const folderRow = (f) => {
    const target = { kind: "folder", path: f.path };
    const row = h(
      "div",
      { class: `frow folder ${ui.libSel.has(keyOf("folder", f.path)) ? "sel" : ""}`, role: "row", tabindex: "0", onclick: () => ((ui.libPath = f.path), (ui.libFind = ""), ui.libSel.clear(), again()), onkeydown: (e) => e.key === "Enter" && e.target === row && ((ui.libPath = f.path), again()) },
      checkbox(target),
      libIcon("folder", "ficon"),
      nameCell(target, f.name, `${f.files} file${f.files === 1 ? "" : "s"}${f.folders ? `, ${f.folders} folder${f.folders === 1 ? "" : "s"}` : ""}${find && libParent(f.path) ? ` · in ${libParent(f.path)}` : ""}`),
      accessChip(f, target),
      h("span", { class: "fsize" }, "—"),
      h("span", { class: "fdate" }, ""),
      menu(target),
    );
    return dropTarget(draggable(row, target), f.path);
  };
  const fileRow = (d) => {
    const target = { kind: "file", path: d.path };
    const row = h(
      "div",
      { class: `frow ${ui.libPreview === d.id ? "open" : ""} ${ui.libSel.has(keyOf("file", d.path)) ? "sel" : ""}`, role: "row", tabindex: "0", onclick: () => ((ui.libPreview = ui.libPreview === d.id ? null : d.id), again()), onkeydown: (e) => e.key === "Enter" && e.target === row && ((ui.libPreview = d.id), again()) },
      checkbox(target),
      thumb(d),
      nameCell(target, d.name, find && libParent(d.path) ? `in ${libParent(d.path)}` : d.readable ? null : d.problem ? "Kept, found by name only" : null),
      accessChip(d, target),
      h("span", { class: "fsize" }, sizeWords(d.size)),
      h("span", { class: "fdate" }, d.modified ? shortWhen(new Date(d.modified).toISOString()) : ""),
      menu(target, [["Open", () => attempt(() => api("POST", "library/launch", { id: d.id }), col)]]),
    );
    return draggable(row, target);
  };

  // ----- the preview of one file -----
  const previewOf = (d) => {
    const raw = `/api/library/${d.id}/raw`;
    const text = h("pre", { class: "ptext" }, "Loading…");
    const viewer = IMAGE_TYPES.has(d.type)
      ? h("img", { class: "pimage", src: raw, alt: d.name })
      : VIDEO_TYPES.has(d.type)
        ? h("video", { class: "pmedia", src: raw, controls: true })
        : AUDIO_TYPES.has(d.type)
          ? h("audio", { class: "pmedia", src: raw, controls: true })
          : d.type === "pdf"
            ? h("iframe", { class: "ppdf", src: raw, title: d.name })
            : d.readable
              ? text
              : h("div", { class: "pnone" }, h("b", {}, "No preview for this kind of file."), h("span", { class: "note small" }, "Open it on this computer to see it."));
    if (d.readable && viewer === text) api("GET", `library/${d.id}/text`).then((r) => (text.textContent = r.text + (r.to < r.parts ? "\n\n…" : ""))).catch((err) => (text.textContent = err.message));
    const target = { kind: "file", path: d.path };
    const fact = (label, value) => h("div", { class: "pfact" }, h("span", {}, label), h("b", {}, value));
    return h(
      "aside",
      { class: "preview", "aria-label": `Preview of ${d.name}` },
      h("div", { class: "phead" }, h("b", { class: "grow" }, d.name), h("button", { class: "plain small", "aria-label": "Close preview", onclick: () => ((ui.libPreview = null), again()) }, "✕")),
      h("div", { class: "pview" }, viewer),
      h("div", { class: "row wrap" }, h("button", { class: "primary small", onclick: () => attempt(() => api("POST", "library/launch", { id: d.id }), col) }, "Open"), h("button", { class: "small", onclick: () => attempt(() => api("POST", "library/open", { id: d.id }), col) }, "Show in Finder"), h("a", { class: "button small", href: raw, download: d.name }, "Download")),
      h(
        "div",
        { class: "pai" },
        h("div", { class: "label" }, "AI access"),
        h(
          "div",
          { class: "segmented", role: "group", "aria-label": "Who can use this file" },
          [["everyone", "All agents"], ["some", "Some"], ["private", "Private"]].map(([mode, label]) => {
            const on = mode === (d.access.private ? "private" : d.access.everyone ? "everyone" : "some");
            return h("button", { class: on ? "on" : "", "aria-pressed": String(on), onclick: () => (mode === "some" ? setAccess([target]) : act(() => api("PATCH", `library/${d.id}`, { mode }), mode === "private" ? "Locked as private: no agent can see it." : "Every agent can use it now.")) }, mode === "private" ? [libIcon("lock"), label] : label);
          }),
        ),
        h("p", { class: "note small" }, d.access.private ? "Locked. No agent can find, list or read this file." : `${accessLabel(d, bots)} can search and read it.${d.accessSet ? "" : d.accessFrom ? ` Follows the folder “${libBase(d.accessFrom)}”.` : " Follows its folder."}`),
        d.accessSet && d.path.includes("/") ? h("button", { class: "plain small", onclick: () => act(() => api("PATCH", `library/${d.id}`, { mode: "inherit" }), "It follows its folder again.") }, "Use its folder's setting") : null,
      ),
      h("div", { class: "pfacts" }, fact("Where", d.path.includes("/") ? libParent(d.path) : "Library"), fact("Size", sizeWords(d.size)), fact("Changed", d.modified ? new Date(d.modified).toLocaleString() : "—"), fact("Read for agents", d.readable ? `${d.passages} part${d.passages === 1 ? "" : "s"}` : "Name only"), d.problem ? h("p", { class: "note small" }, d.problem) : null),
      h("div", { class: "row wrap" }, h("button", { class: "plain small", onclick: () => rename(target) }, "Rename"), h("button", { class: "plain small", onclick: () => moveTo([target]) }, "Move"), h("button", { class: "plain small danger", onclick: () => remove([target]) }, "Delete")),
    );
  };

  // ----- Deleted: put things back, or remove them for good -----
  if (ui.libView === "deleted") {
    fill(
      col,
      h("div", { class: "row" }, h("button", { class: "plain back", onclick: () => ((ui.libView = "files"), again()) }, "← Back to the library"), h("span", { class: "grow" }), lib.deleted.length ? h("button", { class: "danger", onclick: () => confirm(`Delete all ${lib.deleted.length} items for good?\n\nThis cannot be undone.`) && act(() => api("POST", "library/purge", { all: true }), "Deleted emptied.") }, "Empty Deleted") : null),
      h("div", {}, h("h1", {}, "Deleted"), h("p", { class: "lead" }, "Files and folders you deleted stay here for 30 days, then go for good. Agents cannot use anything in here.")),
      ui.libraryNote ? h("div", { class: "banner" }, ui.libraryNote) : null,
      lib.deleted.length
        ? h("div", { class: "flist" }, lib.deleted.map((t) => h("div", { class: "frow" }, h("span", {}), t.kind === "folder" ? libIcon("folder", "ficon") : h("span", { class: "fkind" }, (t.name.split(".").pop() || "file").slice(0, 4).toUpperCase()), h("span", { class: "fname" }, h("b", {}, t.name), h("span", { class: "fsub" }, `Was in ${libParent(t.from) || "Library"} · deleted ${shortWhen(t.at)}`)), h("span", {}), h("span", { class: "fsize" }, sizeWords(t.size)), h("span", {}), h("span", { class: "rowacts show" }, h("button", { class: "small", onclick: () => act(() => api("POST", "library/restore", { id: t.id }), `Put “${t.name}” back.`) }, "Restore"), h("button", { class: "plain small danger", onclick: () => confirm(`Delete “${t.name}” for good?\n\nThis cannot be undone.`) && act(() => api("POST", "library/purge", { id: t.id }), `Deleted “${t.name}” for good.`) }, "Delete forever")))))
        : h("div", { class: "card quiet" }, h("b", {}, "Nothing deleted."), h("span", { class: "note" }, " Anything you delete from the library waits here for 30 days.")),
    );
    ui.libraryNote = null;
    return;
  }

  // ----- the page -----
  const findBox = h("input", { type: "search", class: "findbox", placeholder: "Find a file or folder by name", value: ui.libFind ?? "", "aria-label": "Find by name" });
  findBox.addEventListener("input", () => {
    ui.libFind = findBox.value;
    clearTimeout(ui.libFindTimer);
    ui.libFindTimer = setTimeout(() => (again(), setTimeout(() => document.querySelector(".findbox")?.focus(), 0)), 250);
  });
  const sortPick = h("select", { "aria-label": "Sort by", onchange: (e) => ((ui.libSort = e.target.value), again()) }, [["name", "Name"], ["modified", "Last changed"], ["size", "Size"]].map(([v, t]) => h("option", { value: v, selected: v === sortBy }, `Sort: ${t}`)));
  const newFolder = () => {
    const input = h("input", { class: "renamebox", placeholder: "Folder name", "aria-label": "New folder name" });
    const save = () => {
      const name = input.value.trim();
      ui.libNewFolder = false;
      if (!name) return again();
      act(() => api("POST", "library/folders", { parent: cur, name }), `Made the folder “${name}”.`);
    };
    input.addEventListener("keydown", (e) => (e.key === "Enter" ? save() : e.key === "Escape" ? ((ui.libNewFolder = false), again()) : null));
    input.addEventListener("blur", save);
    setTimeout(() => input.focus(), 0);
    return h("div", { class: "frow folder newfolder" }, h("span", {}), libIcon("folder", "ficon"), h("span", { class: "fname" }, input), h("span", {}), h("span", {}), h("span", {}), h("span", {}));
  };
  const sel = selected();
  const here = folderByPath.get(cur);
  const allKeys = [...folders.map((f) => keyOf("folder", f.path)), ...files.map((d) => keyOf("file", d.path))];
  const allOn = allKeys.length > 0 && allKeys.every((k) => ui.libSel.has(k));
  const list = h(
    "div",
    { class: "flist", role: "table", "aria-label": "Files" },
    h("div", { class: "frow fheadrow", role: "row" }, h("input", { type: "checkbox", class: "pick", "aria-label": "Select all", checked: allOn, onchange: () => (allOn ? allKeys.forEach((k) => ui.libSel.delete(k)) : allKeys.forEach((k) => ui.libSel.add(k)), again()) }), h("span", {}), h("span", {}, "Name"), h("span", {}, "AI access"), h("span", { class: "fsize" }, "Size"), h("span", { class: "fdate" }, "Changed"), h("span", {})),
    cur && !find ? dropTarget(h("div", { class: "frow uprow", role: "row", tabindex: "0", onclick: () => ((ui.libPath = libParent(cur)), again()) }, h("span", {}), libIcon("up", "ficon"), h("span", { class: "fname" }, h("b", {}, "Up a folder")), h("span", {}), h("span", {}), h("span", {}), h("span", {})), libParent(cur)) : null,
    ui.libNewFolder ? newFolder() : null,
    folders.map(folderRow),
    files.map(fileRow),
    !folders.length && !files.length && !ui.libNewFolder ? h("div", { class: "fempty" }, h("b", {}, find ? "Nothing matches that name." : "This folder is empty."), find ? null : h("span", { class: "note" }, "Drop files or folders here from your computer, or press Upload.")) : null,
  );
  // Dropping files from the computer anywhere on the list puts them in the folder being shown.
  const listArea = dropTarget(h("div", { class: "flistwrap" }, list), cur);
  const preview = ui.libPreview && docById.get(ui.libPreview);

  // ----- trying a search, as the person or as one agent -----
  const query = h("input", { type: "search", placeholder: "Try a question, e.g. what is our refund policy?", value: ui.libraryQuery ?? "", "aria-label": "Search inside documents" });
  const as = h("select", { "aria-label": "Search as" }, h("option", { value: "" }, "As you (everything, private too)"), lib.agents.filter((a) => bots.has(a)).map((a) => h("option", { value: a, selected: a === ui.libraryAs }, `As the ${bots.get(a).name}`)));
  const results = h("div", { class: "hits" });
  const search = async () => {
    ui.libraryQuery = query.value;
    ui.libraryAs = as.value;
    if (!query.value.trim()) return fill(results);
    try {
      const { hits } = await api("POST", "library/search", { query: query.value, as: as.value });
      fill(results, hits.length ? hits.map((x) => h("div", { class: "hit" }, h("div", { class: "label" }, `${x.path} · part ${x.part}`), h("p", {}, x.text.slice(0, 420)))) : h("p", { class: "note" }, as.value ? "Nothing this agent may use matches that." : "Nothing in the library matches that."));
    } catch (err) {
      fill(results, h("div", { class: "banner error" }, err.message));
    }
  };

  fill(
    col,
    h("div", { class: "row" }, h("div", { class: "grow" }, h("h1", {}, "Library"), h("p", { class: "lead" }, `${lib.organization}'s files, kept on this computer. Organize them in folders, and choose for each file or folder whether your agents may use it or it stays private.`))),
    h(
      "div",
      { class: "ftoolbar" },
      breadcrumb,
      h("span", { class: "grow" }),
      findBox,
      sortPick,
      h("button", { onclick: () => ((ui.libNewFolder = true), again()) }, "New folder"),
      h("button", { class: "primary", onclick: () => filePick.click() }, "Upload files"),
      h("button", { onclick: () => folderPick.click(), title: "Upload a whole folder, with the folders inside it" }, "Upload a folder"),
      filePick,
      folderPick,
    ),
    h(
      "div",
      { class: "fstatus" },
      cur && here ? [h("span", { class: "note small" }, "This folder:"), accessChip(here, { kind: "folder", path: cur })] : h("span", { class: "note small" }, `${lib.stats.documents} file${lib.stats.documents === 1 ? "" : "s"}${lib.stats.private ? ` · ${lib.stats.private} private` : ""}`),
      status,
      h("span", { class: "grow" }),
      h("button", { class: "plain small", onclick: () => attempt(() => api("POST", "library/open", { path: cur }), col) }, "Show in Finder"),
      h("button", { class: "plain small", onclick: () => ((ui.libView = "deleted"), again()) }, `Deleted${lib.deleted.length ? ` · ${lib.deleted.length}` : ""}`),
    ),
    ui.libraryNote ? h("div", { class: "banner" }, ui.libraryNote) : null,
    sel.length
      ? h("div", { class: "selbar" }, h("b", {}, `${sel.length} selected`), h("button", { class: "small", onclick: () => moveTo(sel) }, "Move"), h("button", { class: "small", onclick: () => setAccess(sel) }, "AI access"), h("button", { class: "small danger", onclick: () => remove(sel) }, "Delete"), h("button", { class: "plain small", onclick: () => (ui.libSel.clear(), again()) }, "Clear"))
      : null,
    h("div", { class: `fmain ${preview ? "withpreview" : ""}` }, listArea, preview ? previewOf(preview) : null),
    h("p", { class: "note small" }, "Drag files onto a folder, or onto a folder in the path above, to move them. Drop files or folders from your computer to upload."),
    h("details", { class: "card trysearch" }, h("summary", {}, h("b", {}, "Check what your agents will find")), h("form", { class: "row", onsubmit: (e) => (e.preventDefault(), search()) }, query, as, h("button", {}, "Search")), results),
    h("p", { class: "note small" }, `Kept on this computer in ${lib.folder}. Private files are never sent to any AI model. For the rest, only the passages that match what an agent is working on are sent.`),
  );
  ui.libraryNote = null;
  if (ui.libraryQuery) search();
}

// ---------- integrations ----------
// The outside tools agents work with, filed by category. Git is the first:
// repositories agents may work on, each task in a branch and copy of its own.
const INTEGRATION_MARKS = {
  git: `<svg viewBox="0 0 48 48" width="44" height="44" aria-hidden="true"><rect x="3" y="3" width="42" height="42" rx="11" fill="var(--accent)" fill-opacity="0.11" stroke="var(--accent)" stroke-opacity="0.5" stroke-width="1.25"/><g fill="none" stroke="var(--accent)" stroke-width="2.2" stroke-linecap="round"><path d="M17 14v20M17 24c8 0 14-1 14-8"/></g><g fill="var(--bg)" stroke="var(--accent)" stroke-width="2.2"><circle cx="17" cy="14" r="3.4"/><circle cx="17" cy="34" r="3.4"/><circle cx="31" cy="15" r="3.4"/></g></svg>`,
};
INTEGRATION_MARKS.mcp = `<svg viewBox="0 0 48 48" width="44" height="44" aria-hidden="true"><rect x="3" y="3" width="42" height="42" rx="11" fill="var(--accent)" fill-opacity="0.11" stroke="var(--accent)" stroke-opacity="0.5" stroke-width="1.25"/><g fill="none" stroke="var(--accent)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 24h8M26 24h8"/><rect x="20" y="18" width="8" height="12" rx="2.5" fill="var(--bg)"/><circle cx="12" cy="24" r="3" fill="var(--bg)"/><circle cx="36" cy="24" r="3" fill="var(--bg)"/><path d="M24 12v6M24 30v6"/></g></svg>`;
INTEGRATION_MARKS.openrouter = `<svg viewBox="0 0 48 48" width="44" height="44" aria-hidden="true"><rect x="3" y="3" width="42" height="42" rx="11" fill="var(--accent)" fill-opacity="0.11" stroke="var(--accent)" stroke-opacity="0.45"/><g fill="none" stroke="var(--accent)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 24h7c3 0 4-1.5 5.5-4.5S28 14 31 14h5"/><path d="M12 24h7c3 0 4 1.5 5.5 4.5S28 34 31 34h5"/><path d="M19 24h17"/><path d="M33 11l3 3-3 3M33 21l3 3-3 3M33 31l3 3-3 3"/></g><circle cx="12" cy="24" r="2.6" fill="var(--accent)"/></svg>`;
const integrationMark = (id) => {
  const node = h("span", { class: "imark" });
  node.innerHTML = INTEGRATION_MARKS[id] ?? "";
  return node;
};
const STATE_WORDS = { connected: ["Connected", "on"], "needs-setup": ["Not set up", ""], unavailable: ["Unavailable", "bad"] };

async function integrationsView() {
  ui.body.className = "body";
  ui.log = null;
  const col = h("div", { class: "integrations" });
  fill(ui.body, h("main", { class: "center" }, col));
  const again = () => integrationsView();
  let list, git;
  try {
    [list, git] = await Promise.all([api("GET", "integrations"), ["git", "mcp", "openrouter"].includes(ui.integration) ? api("GET", `integrations/${ui.integration}`) : null]);
  } catch (err) {
    return fill(col, h("div", { class: "banner error" }, err.message));
  }
  if (state.view !== "integrations") return;
  const act = (fn) => attempt(async () => (await fn(), (state.config = await api("GET", "state")), renderTop(), again()), col);

  if (ui.integration === "git" && git) return fill(col, ...gitIntegrationPage(git, act, col, again));
  if (ui.integration === "mcp" && git) return fill(col, ...mcpIntegrationPage(git, act, col, again));
  if (ui.integration === "openrouter" && git) {
    if (ui.orWaiting && !git.connected) waitForSignIn();
    return fill(col, ...openrouterIntegrationPage(git, act, col, again));
  }

  const chosen = ui.integrationCategory ?? "All";
  const shown = list.integrations.filter((i) => chosen === "All" || i.category === chosen);
  fill(
    col,
    h("div", {}, h("h1", {}, "Integrations"), h("p", { class: "lead" }, "Connect the tools your business already uses, so your agents can work where the work is. Each integration says exactly what agents can and cannot do with it.")),
    h("div", { class: "pills", role: "group", "aria-label": "Categories" }, ["All", ...list.categories].map((c) => h("button", { class: `mpill ${c === chosen ? "on" : ""}`, "aria-pressed": String(c === chosen), onclick: () => ((ui.integrationCategory = c), again()) }, c))),
    ...list.categories
      .filter((c) => shown.some((i) => i.category === c))
      .map((c) =>
        h(
          "section",
          { class: "icat" },
          h("h2", {}, c),
          h(
            "div",
            { class: "igrid" },
            shown
              .filter((i) => i.category === c)
              .map((i) =>
                h(
                  "button",
                  { class: "icard", onclick: () => ((ui.integration = i.id), again()) },
                  h("div", { class: "ihead" }, integrationMark(i.id), h("div", { class: "grow" }, h("b", {}, i.name), h("div", { class: "by" }, i.status)), h("span", { class: `chip ${STATE_WORDS[i.state][1]}` }, STATE_WORDS[i.state][0])),
                  h("p", { class: "mdesc" }, i.summary),
                  h("span", { class: "ilink" }, i.state === "connected" ? "Manage →" : "Set up →"),
                ),
              ),
          ),
        ),
      ),
    h("p", { class: "note" }, "More integrations will be added here. Services that offer a connector (an MCP server) can already be added under ", h("button", { class: "plain link", onclick: () => go("settings") }, "Settings → Connectors"), "."),
  );
}

/** A typical task for one agent, for the "about $x a task" line: what agents read and write in one, roughly. */
const TYPICAL_TASK = { input: 40_000, output: 3_000 };
const taskCost = (p) => (p.input * TYPICAL_TASK.input + p.output * TYPICAL_TASK.output) / 1e6;
const perMillion = (n) => (n === 0 ? "free" : n < 0.1 ? `$${n.toFixed(3)}` : `$${n.toFixed(2)}`);

/** The OpenRouter integration: one account for hundreds of models, chosen from a list that shows the cost. */
function openrouterIntegrationPage(or, act, col, again) {
  const back = h("button", { class: "plain back", onclick: () => ((ui.integration = null), (ui.orWaiting = null), again()) }, "← All integrations");
  const head = h(
    "div",
    { class: "ihero" },
    integrationMark("openrouter"),
    h("div", { class: "grow" }, h("div", { class: "row" }, h("h1", {}, "OpenRouter"), h("span", { class: `chip ${STATE_WORDS[or.state][1]}` }, STATE_WORDS[or.state][0])), h("p", { class: "lead" }, or.summary)),
  );

  // ---- connecting ----
  const connect = h("button", { class: "primary big" }, ui.orWaiting ? "Open openrouter.ai again" : "Connect OpenRouter");
  connect.addEventListener("click", async () => {
    connect.disabled = true;
    try {
      const { url } = await api("POST", "integrations/openrouter/start");
      window.open(url, "_blank", "noopener");
      ui.orWaiting = Date.now();
      waitForSignIn();
      again();
    } catch (err) {
      connect.disabled = false;
      alert(err.message);
    }
  });
  const keyInput = h("input", { type: "password", placeholder: "sk-or-…", autocomplete: "off", "aria-label": "OpenRouter key" });
  const keyForm = h(
    "details",
    { class: "card onthis" },
    h("summary", {}, h("b", {}, "Already have an OpenRouter key?"), h("span", { class: "note small" }, "Paste it instead")),
    h(
      "form",
      { class: "body form", onsubmit: (e) => (e.preventDefault(), act(() => api("POST", "integrations/openrouter/key", { key: keyInput.value }))) },
      h("p", { class: "note" }, "Make one at openrouter.ai/keys, copy it, and paste it here. It is kept on this computer and only ever sent to OpenRouter."),
      keyInput,
      h("div", {}, h("button", { class: "primary" }, "Save key")),
    ),
  );

  if (!or.connected) {
    return [
      back,
      head,
      h(
        "section",
        { class: "isec" },
        h("h2", {}, "Connect in one step"),
        h(
          "div",
          { class: "card form" },
          h("div", { class: "istep num" }, h("span", { class: "istepmark", "aria-hidden": "true" }, "1"), h("div", { class: "grow" }, h("b", {}, "Press Connect OpenRouter"), h("p", { class: "note" }, "openrouter.ai opens in your web browser. Sign in, or make a free account there. You can add credit there too: you pay OpenRouter directly for what your agents use."))),
          h("div", { class: "istep num" }, h("span", { class: "istepmark", "aria-hidden": "true" }, "2"), h("div", { class: "grow" }, h("b", {}, "Press Authorize on openrouter.ai"), h("p", { class: "note" }, "That gives this app its own key. You do not copy anything. You can set a spending limit for it on that page."))),
          h("div", { class: "istep num" }, h("span", { class: "istepmark", "aria-hidden": "true" }, "3"), h("div", { class: "grow" }, h("b", {}, "Come back here"), h("p", { class: "note" }, "This page notices by itself, and you choose which model your team uses."))),
          h("div", { class: "row" }, connect, ui.orWaiting ? h("span", { class: "note" }, h("i", { class: "dot", "aria-hidden": "true" }), " Waiting for you to approve on openrouter.ai…") : null),
        ),
        keyForm,
        h("div", { class: "willgrid" },
          h("div", { class: "willbox will" }, h("div", { class: "label" }, "✓ With OpenRouter"), h("ul", {}, ...["Run your agents on models from Anthropic, OpenAI, Google, Meta, DeepSeek, Mistral, Qwen and more", "Give one agent a different model from the rest, such as a cheaper one for routine work", "See every model's price before you choose, and the real cost of each task on its receipt"].map((x) => h("li", {}, x)))),
          h("div", { class: "willbox wont" }, h("div", { class: "label" }, "✕ It never"), h("ul", {}, ...["Spends past the budgets you set in this app, or the limit you set on openrouter.ai", "Sends your key anywhere but OpenRouter", "Changes your Claude setup: Claude through your Anthropic key keeps working"].map((x) => h("li", {}, x)))),
        ),
      ),
    ];
  }

  // ---- connected: the account and choosing a model ----
  const a = or.account;
  const accountLine = !a ? "Connected." : !a.keyWorks ? "The saved key no longer works. Connect again below." : [a.usage !== undefined ? `${money(a.usage)} used so far` : null, a.limit ? `limit ${money(a.limit)}${a.remaining !== null && a.remaining !== undefined ? `, ${money(a.remaining)} left` : ""}` : "no limit set on this key", a.freeTier ? "free tier: add credit on openrouter.ai to use paid models" : null].filter(Boolean).join(" · ");
  const current = or.models.find((m) => m.id === or.using);

  ui.orSort ??= "suggested";
  const search = h("input", { type: "search", placeholder: `Search ${or.models.length} models, e.g. claude, gpt, gemini, llama, free`, "aria-label": "Search models", value: ui.orSearch ?? "" });
  const sort = h("select", { "aria-label": "Order" }, [["suggested", "Suggested first"], ["cheap", "Cheapest first"], ["name", "A to Z"], ["context", "Longest documents first"]].map(([v, t]) => h("option", { value: v, selected: v === ui.orSort }, t)));
  const rows = h("div", { class: "ormodels" });
  const suggested = new Map(or.suggested.map((s) => [s.id, s.why]));
  const row = (m) =>
    h(
      "div",
      { class: `ormodel ${m.id === or.using ? "on" : ""}` },
      h(
        "div",
        { class: "grow" },
        h("div", { class: "row tight" }, h("b", {}, m.name), m.free ? h("span", { class: "chip on" }, "Free") : null, m.id === or.using ? h("span", { class: "chip on" }, "Your team uses this") : null),
        h("div", { class: "mono small muted" }, m.id),
        suggested.has(m.id) ? h("div", { class: "note small" }, suggested.get(m.id)) : null,
      ),
      h(
        "div",
        { class: "orprice" },
        h("b", {}, m.free ? "Free" : `about ${money(taskCost(m.prices))} a task`),
        h("span", {}, m.free ? "limited daily use" : `${perMillion(m.prices.input)} in · ${perMillion(m.prices.output)} out per million tokens`),
        h("span", {}, `holds about ${Math.round((m.contextTokens * 0.75) / 1000).toLocaleString()}k words`),
      ),
      m.id === or.using ? h("button", { disabled: true }, "In use") : h("button", { onclick: () => act(() => api("POST", "integrations/openrouter/use", { model: m.id })) }, "Use for my team"),
    );
  const draw = () => {
    ui.orSearch = search.value;
    ui.orSort = sort.value;
    const words = search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    let shown = or.models.filter((m) => words.every((w) => (w === "free" ? m.free : `${m.name} ${m.id}`.toLowerCase().includes(w))));
    const by = { cheap: (x, y) => taskCost(x.prices) - taskCost(y.prices), name: (x, y) => x.name.localeCompare(y.name), context: (x, y) => y.contextTokens - x.contextTokens, suggested: (x, y) => (suggested.has(y.id) - suggested.has(x.id)) || (x.id === or.using ? -1 : y.id === or.using ? 1 : 0) || x.name.localeCompare(y.name) };
    shown = shown.sort(by[sort.value] ?? by.suggested);
    fill(rows, shown.length ? [shown.slice(0, 60).map(row), shown.length > 60 ? h("p", { class: "note small" }, `Showing 60 of ${shown.length}. Search to narrow the list.`) : null] : h("p", { class: "note" }, "No model matches that search."));
  };
  search.addEventListener("input", draw);
  sort.addEventListener("change", draw);
  draw();

  return [
    back,
    head,
    h(
      "section",
      { class: "isec" },
      h("h2", {}, "Your account"),
      h(
        "div",
        { class: "card" },
        h("div", { class: "row" }, h("div", { class: "grow" }, h("b", {}, a?.keyWorks === false ? "Not working" : "Connected"), h("div", { class: "note" }, accountLine)), h("button", { type: "button", onclick: () => window.open("https://openrouter.ai/settings/credits", "_blank", "noopener") }, "Add credit"), h("button", { type: "button", class: "plain", onclick: () => window.open("https://openrouter.ai/activity", "_blank", "noopener") }, "See activity on openrouter.ai")),
        a?.keyWorks === false ? h("div", { class: "row" }, connect) : null,
      ),
    ),
    h(
      "section",
      { class: "isec" },
      h("h2", {}, "Which model your team uses"),
      h(
        "div",
        { class: "card" },
        current
          ? h("div", {}, h("b", {}, `${current.name}`), h("p", { class: "note" }, `Every agent uses it, except agents you gave a model of their own. About ${current.free ? "nothing" : money(taskCost(current.prices))} for a typical task by one agent; the receipt of each task shows the real cost OpenRouter charged.`))
          : h("div", {}, h("b", {}, `Your team uses ${state.config?.model?.startsWith("anthropic/") ? "Claude, through your Anthropic key" : state.config?.model || "the model set under Settings"}`), h("p", { class: "note" }, "Choose a model below to run your team on OpenRouter instead. You can switch back at any time under Settings.")),
        h("p", { class: "note small" }, "To give one agent its own model, open that agent, and under Model choose OpenRouter and the model. Cheaper models suit routine work; stronger ones suit managers and complex tasks."),
      ),
      h("div", { class: "row" }, search, sort),
      rows,
      h("p", { class: "note small" }, "“About a task” is a rough guide for one agent doing one task (about 40,000 tokens read and 3,000 written). A token is about three quarters of a word. Only models that can use tools are listed, because agents work through tools."),
    ),
    h(
      "section",
      { class: "isec" },
      h(
        "div",
        { class: "card danger-zone" },
        h("div", { class: "row" }, h("div", { class: "grow" }, h("b", {}, "Remove this integration"), h("p", { class: "note" }, "Forgets the key on this computer. If your team uses an OpenRouter model, it goes back to Claude. To stop the key working everywhere, delete it at openrouter.ai/keys.")),
          h("button", { class: "danger", onclick: () => confirm("Remove OpenRouter?\n\nThe key is forgotten on this computer, and agents using an OpenRouter model go back to Claude.") && act(() => api("POST", "integrations/openrouter/remove")) }, "Remove integration"),
        ),
      ),
    ),
  ];
}

/** While the person approves on openrouter.ai, checks every few seconds whether the key has arrived. */
function waitForSignIn() {
  clearTimeout(ui.orTimer);
  const tick = async () => {
    if (!ui.orWaiting || Date.now() - ui.orWaiting > 10 * 60_000) return (ui.orWaiting = null);
    const or = await api("GET", "integrations/openrouter").catch(() => null);
    if (or?.connected) {
      ui.orWaiting = null;
      state.config = await api("GET", "state").catch(() => state.config);
      if (state.view === "integrations") integrationsView();
      return;
    }
    ui.orTimer = setTimeout(tick, 2500);
  };
  ui.orTimer = setTimeout(tick, 2500);
}

/** The MCP integration: Talqava inside Claude and other AI apps, and other services' tools for the agents. */
function mcpIntegrationPage(mcp, act, col, again) {
  const back = h("button", { class: "plain back", onclick: () => ((ui.integration = null), again()) }, "← All integrations");
  const copy = (text, btn) => navigator.clipboard?.writeText(text).then(() => ((btn.textContent = "Copied"), setTimeout(() => (btn.textContent = "Copy"), 1500))).catch(() => {});
  const copyBox = (label, text) => {
    const btn = h("button", { type: "button" }, "Copy");
    btn.addEventListener("click", () => copy(text, btn));
    return h("div", { class: "copybox" }, h("div", { class: "row" }, h("span", { class: "label grow", style: "margin: 0" }, label), btn), h("pre", {}, text));
  };
  const name = h("input", { placeholder: "A short name, e.g. notion", "aria-label": "Connector name" });
  const address = h("input", { placeholder: "Its web address, e.g. https://mcp.example.com/mcp", "aria-label": "Connector address" });
  const token = h("input", { type: "password", placeholder: "Access token (only if it needs one)", autocomplete: "off", "aria-label": "Access token" });
  return [
    back,
    h("div", { class: "ihero" }, integrationMark("mcp"), h("div", { class: "grow" }, h("div", { class: "row" }, h("h1", {}, "MCP"), h("span", { class: `chip ${STATE_WORDS[mcp.state][1]}` }, STATE_WORDS[mcp.state][0])), h("p", { class: "lead" }, mcp.summary))),
    h(
      "section",
      { class: "isec" },
      h("h2", {}, "Use your Talqava team from Claude"),
      h(
        "div",
        { class: "card form" },
        h("div", { class: "row" }, h("b", { class: "grow" }, "The Claude desktop app"), h("span", { class: `chip ${mcp.claude.added ? "on" : ""}` }, mcp.claude.added ? "Added" : mcp.claude.found ? "Not added" : "Not installed")),
        h("p", { class: "note" }, "Adds your Talqava team to Claude, so you can say things like “ask my Head of Marketing for a campaign plan” in a Claude chat. The work still happens here, and anything that changes files or sends something still waits for your approval here."),
        mcp.claude.added
          ? [h("div", { class: "istep done" }, h("span", { class: "istepmark", "aria-hidden": "true" }, "✓"), h("div", { class: "grow" }, h("b", {}, "Talqava is added to Claude"), h("p", { class: "note" }, "Quit Claude completely and open it again to see it. Keep this app open while you use it. Then try asking Claude: “What agents are on my Talqava team?”"))), h("div", { class: "row" }, h("button", { class: "plain danger", onclick: () => confirm("Take Talqava out of Claude?") && act(() => api("POST", "integrations/mcp/claude-desktop", { remove: true })) }, "Remove from Claude"))]
          : mcp.claude.found
            ? h("div", { class: "row" }, h("button", { class: "primary big", onclick: () => act(() => api("POST", "integrations/mcp/claude-desktop", {})) }, "Add Talqava to Claude"), h("span", { class: "note" }, "One click. Nothing else in Claude's settings is changed, and a copy of them is kept first."))
            : h("div", { class: "row" }, h("span", { class: "note" }, "The Claude desktop app was not found on this computer."), h("button", { type: "button", class: "plain link", onclick: () => window.open("https://claude.ai/download", "_blank", "noopener") }, "Get Claude, open it once, then come back")),
        h("div", { class: "label", style: "margin: 8px 0 0" }, "What Claude can do with your team"),
        h("ul", { class: "toollist" }, mcp.tools.map(([, words]) => h("li", {}, words))),
      ),
      h("details", { class: "card onthis" }, h("summary", {}, h("b", {}, "Other AI apps"), h("span", { class: "note small" }, "For people comfortable with settings files")), h("div", { class: "body" }, h("p", { class: "note" }, "Any app that supports MCP can use the same connection. Paste one of these where that app asks for it."), copyBox("Claude Code (run in a terminal)", mcp.claudeCode), copyBox("Any other app (settings snippet)", mcp.snippet))),
    ),
    h(
      "section",
      { class: "isec" },
      h("h2", {}, `Give your agents tools from other services${mcp.connectors.length ? ` · ${mcp.connectors.length}` : ""}`),
      h("p", { class: "note", style: "margin: 0" }, "A connector lets your agents use another service, such as your documents, calendar or CRM. Their tools ask you before changing anything, and what they return is treated as outside information."),
      mcp.connectors.map((c) => h("div", { class: "card" }, h("div", { class: "row" }, h("div", { class: "grow" }, h("b", {}, c.name), h("div", { class: "mono small muted" }, c.where)), h("button", { class: "danger", onclick: () => confirm(`Remove the ${c.name} connector? Your agents can no longer use its tools.`) && act(() => api("PUT", "settings", { mcpServer: { name: c.name, remove: true } })) }, "Remove")))),
      h("form", { class: "card form", onsubmit: (e) => (e.preventDefault(), act(() => api("PUT", "settings", { mcpServer: { name: name.value.trim(), url: address.value.trim(), token: token.value } }))) }, h("b", {}, "Add a connector"), h("p", { class: "note small" }, "The service gives you its MCP address, and a token if it needs one."), name, address, token, h("div", {}, h("button", { class: "primary" }, "Add connector"))),
      h("p", { class: "note small" }, "Connectors that run as a program on this computer are added under ", h("button", { class: "plain link", onclick: () => go("settings") }, "Settings → Connectors"), "."),
    ),
  ];
}

/** The Git integration: what it does, whether it is ready, the repositories, and GitHub. */
function gitIntegrationPage(git, act, col, again) {
  const back = h("button", { class: "plain back", onclick: () => ((ui.integration = null), again()) }, "← All integrations");
  const step = (done, title, body) => h("div", { class: `istep ${done ? "done" : ""}` }, h("span", { class: "istepmark", "aria-hidden": "true" }, done ? "✓" : ""), h("div", { class: "grow" }, h("b", {}, title), body));
  const head = h("div", { class: "ihero" }, integrationMark("git"), h("div", { class: "grow" }, h("div", { class: "row" }, h("h1", {}, "Git and GitHub"), h("span", { class: `chip ${STATE_WORDS[git.state][1]}` }, STATE_WORDS[git.state][0])), h("p", { class: "lead" }, git.summary)));
  // Looking through folders on this computer happens only when asked.
  const searchBtn = h("button", {}, ui.gitAuto?.local ? "Search this computer again" : "Search this computer for repositories");
  searchBtn.addEventListener("click", async () => {
    searchBtn.disabled = true;
    searchBtn.textContent = "Searching…";
    try {
      ui.gitAuto = await api("POST", "integrations/git/auto", { scan: true });
    } catch (err) {
      ui.gitAuto = { steps: [], local: [], error: err.message };
    }
    again();
  });
  const auto = ui.gitAuto;
  const connectLocal = (r) => act(async () => (await api("PUT", "settings", { project: { path: r.path } }), (ui.gitAuto = await api("POST", "integrations/git/auto", { scan: true }))));
  const copyBtn = (r) => {
    const btn = h("button", {}, "Copy here and connect");
    btn.addEventListener("click", () => ((btn.disabled = true), (btn.textContent = "Copying…"), act(async () => (await api("POST", "integrations/git/clone", { url: r.url }), (ui.gitAuto = await api("POST", "integrations/git/auto")))).finally(() => ((btn.disabled = false), (btn.textContent = "Copy here and connect")))));
    return btn;
  };
  // Repositories on GitHub that are not on this computer yet: tick the ones wanted, and they are copied here and connected.
  const remotePicker = (found) => {
    ui.gitPick ??= new Set();
    const filter = h("input", { type: "search", placeholder: "Filter your repositories", "aria-label": "Filter repositories", value: ui.gitPickFilter ?? "" });
    const rows = h("div", { class: "pickrows" });
    const go = h("button", { class: "primary" }, "Connect selected");
    const draw = () => {
      const needle = filter.value.trim().toLowerCase();
      const shown = found.remote.filter((r) => !needle || `${r.name} ${r.description}`.toLowerCase().includes(needle));
      for (const url of [...ui.gitPick]) if (!found.remote.some((r) => r.url === url && !r.connected)) ui.gitPick.delete(url);
      fill(
        rows,
        shown.length
          ? shown.map((r) => {
              if (r.connected) return h("div", { class: "pickrow" }, h("span", { class: "flowmain" }, h("b", {}, r.name), h("span", { class: "flowsub" }, r.description || "Already connected")), h("span", { class: "chip on" }, "Connected"));
              const box = h("input", { type: "checkbox", checked: ui.gitPick.has(r.url), "aria-label": `Select ${r.name}` });
              box.addEventListener("change", () => ((box.checked ? ui.gitPick.add(r.url) : ui.gitPick.delete(r.url)), count()));
              return h("label", { class: "pickrow pickable" }, box, h("span", { class: "flowmain" }, h("b", {}, r.name, r.private ? h("span", { class: "chip", style: "margin-left: 8px" }, "Private") : null), h("span", { class: "flowsub" }, `${r.description ? `${r.description} · ` : ""}last changed ${shortWhen(r.pushedAt)}`)));
            })
          : h("p", { class: "note" }, "No repository matches."),
      );
    };
    const count = () => ((go.textContent = ui.gitPick.size ? `Copy here and connect ${ui.gitPick.size} selected` : "Select repositories to connect"), (go.disabled = !ui.gitPick.size));
    filter.addEventListener("input", () => ((ui.gitPickFilter = filter.value), draw()));
    go.addEventListener("click", () => {
      const urls = [...ui.gitPick];
      go.disabled = true;
      act(async () => {
        for (const [i, url] of urls.entries()) {
          go.textContent = `Copying ${i + 1} of ${urls.length}…`;
          await api("POST", "integrations/git/clone", { url });
          ui.gitPick.delete(url);
        }
        if (ui.githubPick?.account) ui.githubPick.repos = (await api("POST", "integrations/git/github-repos", { account: ui.githubPick.account })).repos;
      }).finally(count);
    });
    draw();
    count();
    return [h("div", { class: "row", style: "margin-top: 6px" }, h("div", { class: "label grow", style: "margin: 0" }, `Repositories of ${found.login} · ${found.remote.length}`), filter), h("p", { class: "note small", style: "margin: 0" }, `Tick the ones you want. Each is copied into ${git.cloneFolder} and connected; nothing on GitHub changes.`), found.remote.length ? rows : h("p", { class: "note" }, "This account has no repositories that this sign-in can see."), found.remote.length ? h("div", {}, go) : null];
  };
  // What a search of this computer found, for the "On this computer" part of the page.
  const foundHere = auto?.local
    ? auto.local.length
      ? [
          h("div", { class: "row" }, h("div", { class: "label grow", style: "margin: 6px 0 0" }, `Found on this computer · ${auto.local.length}`), auto.local.length > 1 ? h("button", { class: "plain link", onclick: () => act(async () => { for (const r of auto.local) await api("PUT", "settings", { project: { path: r.path } }); ui.gitAuto = await api("POST", "integrations/git/auto", { scan: true }); }) }, "Connect all") : null),
          h("div", { class: "pickrows" }, auto.local.map((r) => h("div", { class: "pickrow" }, h("span", { class: "flowmain" }, h("b", {}, r.name), h("span", { class: "flowsub" }, r.path)), h("button", { class: "primary", onclick: () => connectLocal(r) }, "Connect")))),
        ]
      : h("p", { class: "note" }, auto.error ?? "No repositories were found in the usual folders. Connect one by its folder below.")
    : null;
  if (!git.installed) {
    return [
      back,
      head,
      h("section", { class: "card isetup" }, h("h2", {}, "One thing to install first"), h("div", { class: "istep action" }, h("span", { class: "istepmark", "aria-hidden": "true" }, "!"), h("div", { class: "grow" }, h("b", {}, "Git is not on this computer yet"), h("p", { class: "note" }, "Press Install Git. macOS opens its own installer window: click Install there and wait a few minutes, then come back and press Check again."))), h("div", { class: "row" }, h("button", { class: "primary", onclick: (e) => ((e.target.disabled = true), attempt(async () => alert((await api("POST", "integrations/git/install")).message), col)) }, "Install Git"), h("button", { onclick: again }, "Check again"))),
    ];
  }

  // ----- repositories -----
  const folder = h("input", { placeholder: "A folder on this computer, e.g. /Users/you/Projects/my-app", "aria-label": "Folder of a repository" });
  const url = h("input", { placeholder: "https://github.com/your-name/your-repository", "aria-label": "Web address of a repository" });
  const cloneBtn = h("button", { class: "primary" }, "Copy it here and connect");
  const repoCard = (r) =>
    h(
      "div",
      { class: `card irepo ${r.found ? "" : "gone"}` },
      h("div", { class: "row" }, h("div", { class: "grow" }, h("b", {}, r.name), h("div", { class: "mono small muted" }, r.path)), r.found && state.project !== r.path ? h("button", { title: "New tasks will work on this repository", onclick: () => ((state.project = r.path), remember("talqava.project", r.path), loadCrew().then(() => (renderTop(), again()))) }, "Use for new tasks") : r.found ? h("span", { class: "chip on" }, "In use for new tasks") : null, h(
        "button",
        {
          class: "danger",
          onclick: () => {
            const copy = (git.copies ?? []).includes(r.path);
            if (!confirm(`Remove ${r.name} from Talqava?\n\nAgents stop working on it. ${copy ? "This is a copy the app made; you are asked next whether to delete it too." : "The folder and everything in it stay on your computer."}`)) return;
            const deleteCopy = copy && confirm(`Also delete the copy on this computer?\n\n${r.path}\n\nOK deletes those files (the repository on GitHub is not touched). Cancel keeps them.`);
            if (state.project === r.path) (state.project = ""), remember("talqava.project", "");
            act(async () => (await api("POST", "integrations/git/disconnect", { path: r.path, deleteCopy }), ui.gitAuto ? (ui.gitAuto = await api("POST", "integrations/git/auto")) : null));
          },
        },
        "Remove",
      )),
      r.found
        ? h(
            "div",
            { class: "ifacts" },
            h("div", {}, h("span", { class: "label" }, "Your branch"), h("span", {}, r.branch)),
            h("div", {}, h("span", { class: "label" }, "Last commit"), h("span", { title: r.lastCommit ? `${r.lastCommit.author}` : "" }, r.lastCommit ? `${r.lastCommit.subject.slice(0, 70)} · ${shortWhen(r.lastCommit.when)}` : "No commits yet")),
            h("div", {}, h("span", { class: "label" }, "Your unsaved changes"), h("span", { class: r.uncommitted ? "warn" : "" }, r.uncommitted ? `${r.uncommitted} file${r.uncommitted === 1 ? "" : "s"} not committed` : "None")),
            h("div", {}, h("span", { class: "label" }, "Hosted at"), h("span", {}, r.github ? `GitHub · ${r.github}` : r.remote || "This computer only")),
            h("div", {}, h("span", { class: "label" }, "Agent work"), h("span", {}, `${r.activeTasks} task${r.activeTasks === 1 ? "" : "s"} under way · ${r.taskBranches} task branch${r.taskBranches === 1 ? "" : "es"}`)),
          )
        : h("p", { class: "note" }, "This folder is no longer a git repository, or has been moved. Disconnect it, or put it back."),
      r.found && !r.lastCommit ? h("p", { class: "note small" }, "A repository needs at least one commit before an agent can work on it.") : null,
    );

  // ----- GitHub: sign in through the web, or with a token -----
  const openWeb = (address) => window.open(address, "_blank", "noopener");
  // Loads the accounts this sign-in can see (the person's own, and their companies) and one account's repositories.
  const loadAccount = async (account) => {
    try {
      const listed = ui.githubPick?.accounts ? ui.githubPick : await api("POST", "integrations/git/github-accounts");
      const chosen = account ?? ui.githubPick?.account ?? listed.accounts[0].login;
      ui.githubPick = { login: listed.login, accounts: listed.accounts, account: chosen, repos: null, error: null };
      again();
      ui.githubPick.repos = (await api("POST", "integrations/git/github-repos", { account: chosen })).repos;
    } catch (err) {
      ui.githubPick = { ...(ui.githubPick ?? { accounts: [] }), repos: [], error: err.message };
    }
    again();
  };
  const afterGithub = async () => {
    ui.githubSignIn = null;
    ui.githubTokenFlow = false;
    ui.githubPick = null;
    state.config = await api("GET", "state");
    await loadAccount();
  };
  const startSignIn = async (btn) => {
    btn.disabled = true;
    try {
      ui.githubSignIn = await api("POST", "integrations/git/github-start");
      navigator.clipboard?.writeText(ui.githubSignIn.code).catch(() => {});
      openWeb(ui.githubSignIn.url);
      again();
    } catch (err) {
      ui.githubSignIn = { error: err.message };
      again();
    }
  };
  // While a sign-in is under way, ask GitHub every few seconds whether it has been approved.
  const waitForApproval = (status) => {
    const started = ui.githubSignIn;
    const tick = async () => {
      if (ui.githubSignIn !== started || state.view !== "integrations" || ui.integration !== "git") return;
      try {
        const r = await api("POST", "integrations/git/github-poll");
        if (r.done) return afterGithub();
        setTimeout(tick, (r.wait ?? started.interval ?? 5) * 1000);
      } catch (err) {
        ui.githubSignIn = { error: err.message };
        again();
      }
    };
    setTimeout(tick, (started.interval ?? 5) * 1000);
    status.textContent = "Waiting for you to approve on GitHub…";
  };
  const githubSection = () => {
    const signIn = ui.githubSignIn;
    const clientId = h("input", { placeholder: "Client ID, e.g. Ov23li…", value: git.github.clientId ?? "", autocomplete: "off", "aria-label": "GitHub app Client ID" });
    const oneClick = h(
      "details",
      { class: "card setup-once", open: ui.githubOnceOpen ? "" : null },
      h("summary", {}, h("b", {}, "One-click sign-in"), h("span", { class: `chip ${git.github.canSignIn ? "on" : ""}` }, git.github.canSignIn ? "Ready" : "Set up once")),
      h(
        "div",
        { class: "body" },
        h("p", { class: "note" }, "“Connect GitHub” signs people in on github.com with a short code, with no token to copy. GitHub requires an app to be registered for that, once, by whoever publishes this product. After that it works for everyone who uses it."),
        h("ol", { class: "isteps" }, h("li", {}, "On GitHub open Settings → Developer settings → OAuth Apps → New OAuth App."), h("li", {}, "Name it Talqava Agents. For both web addresses use your website (they are not used by this kind of sign-in)."), h("li", {}, "Tick “Enable Device Flow”, then Register application."), h("li", {}, "Copy the Client ID shown on the app's page and paste it here. No secret is needed.")),
        h("form", { class: "row", onsubmit: (e) => (e.preventDefault(), (ui.githubOnceOpen = true), act(() => api("POST", "integrations/git/github-client", { clientId: clientId.value }))) }, clientId, h("button", { class: "primary" }, "Save Client ID"), h("button", { type: "button", class: "plain link", onclick: () => openWeb("https://github.com/settings/applications/new") }, "Open that page on GitHub")),
      ),
    );
    if (git.github.tokenSaved) {
      const pick = ui.githubPick;
      const other = h("input", { placeholder: "Company's name on GitHub, e.g. talqava", "aria-label": "Company's name on GitHub", autocomplete: "off" });
      return h(
        "section",
        { class: "isec" },
        h("h2", {}, "GitHub"),
        h(
          "div",
          { class: "card form" },
          h("div", { class: "row" }, h("b", { class: "grow" }, pick?.login ? `Connected as ${pick.login}` : "Connected to GitHub"), h("span", { class: "chip on" }, "Connected")),
          h("p", { class: "note small" }, "The sign-in is kept on this computer, is only ever sent to GitHub, and is never shown to an agent."),
          h("div", { class: "row" }, pick ? null : h("button", { class: "primary", onclick: (e) => ((e.target.disabled = true), (e.target.textContent = "Loading your accounts…"), loadAccount()) }, "Choose repositories"), testBtn, h("button", { type: "button", class: "plain danger", onclick: () => confirm("Disconnect GitHub?\n\nRepositories already connected stay connected. Agents can no longer read issues and pull requests, and you can connect a different account afterwards.") && act(async () => (await api("PUT", "settings", { secret: { name: "GITHUB_TOKEN", remove: true } }), (ui.githubPick = null))) }, "Disconnect GitHub"), tested),
          pick
            ? [
                h("div", { class: "label", style: "margin: 8px 0 0" }, "Whose repositories?"),
                h("div", { class: "pills", role: "group", "aria-label": "Account" }, pick.accounts.map((a) => h("button", { class: `mpill ${a.login === pick.account ? "on" : ""}`, "aria-pressed": String(a.login === pick.account), title: a.description, onclick: () => a.login !== pick.account && loadAccount(a.login) }, a.kind === "personal" ? `${a.login} (you)` : a.login)), pick.account && !pick.accounts.some((a) => a.login === pick.account) ? h("button", { class: "mpill on" }, pick.account) : null),
                pick.error ? h("div", { class: "banner error" }, pick.error) : pick.repos ? remotePicker({ login: pick.account, remote: pick.repos }) : h("p", { class: "note" }, "Loading repositories…"),
                h(
                  "details",
                  { class: "notlisted", open: ui.githubNotListed ? "" : null, ontoggle: (e) => (ui.githubNotListed = e.target.open) },
                  h("summary", {}, h("b", {}, "My company is not listed")),
                  h(
                    "div",
                    { class: "body" },
                    h("p", { class: "note" }, "GitHub only shows a company (an “organization”) to an app the company has allowed. Whoever connects decides this on GitHub, and a company owner may have to approve it once."),
                    h("ol", { class: "isteps" }, h("li", {}, "If you used Connect GitHub: on github.com open Settings → Applications → Authorized OAuth Apps → Talqava Agents, and under Organization access press Grant (or Request) beside your company. ", h("button", { type: "button", class: "plain link", onclick: () => openWeb("https://github.com/settings/applications") }, "Open that page")), h("li", {}, "If you used a token and your company uses single sign-on: on the tokens page press Configure SSO beside the token and authorize it for your company. ", h("button", { type: "button", class: "plain link", onclick: () => openWeb("https://github.com/settings/tokens") }, "Open that page")), h("li", {}, "Then press Refresh here, or type the company's GitHub name below to look at it directly.")),
                    h("form", { class: "row", onsubmit: (e) => (e.preventDefault(), other.value.trim() ? loadAccount(other.value.trim().replace(/^@|^https:\/\/github\.com\//, "").replace(/\/.*$/, "")) : other.focus()) }, other, h("button", {}, "Show its repositories"), h("button", { type: "button", class: "plain link", onclick: () => ((ui.githubPick = null), loadAccount()) }, "Refresh the list of accounts")),
                  ),
                ),
              ]
            : null,
        ),
        oneClick,
      );
    }
    const connect = h("button", { class: "primary big" }, "Connect GitHub");
    connect.addEventListener("click", () => (git.github.canSignIn ? startSignIn(connect) : ((ui.githubTokenFlow = true), again())));
    const status = h("span", { class: "note" });
    if (signIn?.code) waitForApproval(status);
    return h(
      "section",
      { class: "isec" },
      h("h2", {}, "GitHub"),
      h(
        "div",
        { class: "card form" },
        h("div", { class: "row" }, h("b", { class: "grow" }, "Connect your GitHub account"), h("span", { class: "chip" }, "Not connected")),
        h("p", { class: "note" }, "Sign in on github.com in your browser, then choose which of your repositories to bring in. Your password is never typed into this app."),
        signIn?.code
          ? h(
              "div",
              { class: "signin" },
              h("div", { class: "label" }, "Type this code on GitHub"),
              h("div", { class: "signcode", "aria-live": "polite" }, signIn.code),
              h("div", { class: "row" }, h("button", { class: "primary", onclick: () => (navigator.clipboard?.writeText(signIn.code).catch(() => {}), openWeb(signIn.url)) }, "Copy the code and open GitHub"), h("button", { class: "plain", onclick: () => ((ui.githubSignIn = null), again()) }, "Cancel")),
              h("ol", { class: "isteps" }, h("li", {}, "GitHub opens in your browser. Sign in if it asks."), h("li", {}, "Paste or type the code above and press Continue."), h("li", {}, "Press Authorize. This page carries on by itself.")),
              status,
            )
          : h("div", { class: "row" }, connect, h("button", { type: "button", class: "plain link", onclick: () => openWeb("https://github.com/signup") }, "No GitHub account? Create one free, then come back and press Connect GitHub")),
        signIn?.error ? h("div", { class: "banner error" }, signIn.error) : null,
        ui.githubTokenFlow || signIn?.error
          ? h(
              "form",
              { class: "tokenflow", onsubmit: (e) => (e.preventDefault(), token.value.trim() ? act(async () => (await api("PUT", "settings", { secret: { name: "GITHUB_TOKEN", value: token.value.trim(), host: "api.github.com" } }), await afterGithub())) : token.focus()) },
              h("div", { class: "label" }, "Connect with an access token"),
              h("ol", { class: "isteps" }, h("li", {}, h("button", { type: "button", class: "plain link", onclick: () => openWeb("https://github.com/settings/tokens/new?description=Talqava%20Agents&scopes=repo,read:org,read:user") }, "Open GitHub's token page"), " in your browser. Sign in, or create a free account, if it asks."), h("li", {}, "The name and permissions are already filled in. Scroll down and press Generate token."), h("li", {}, "Copy the token GitHub shows (it starts with ghp_) and paste it here.")),
              h("div", { class: "row" }, token, h("button", { class: "primary" }, "Connect")),
            )
          : null,
      ),
      oneClick,
    );
  };

  // ----- GitHub token field and test -----
  const token = h("input", { type: "password", autocomplete: "off", placeholder: git.github.tokenSaved ? "A token is saved. Paste a new one to replace it." : "Paste a GitHub token (starts with ghp_ or github_pat_)", "aria-label": "GitHub token" });
  const tested = h("span", { class: "note small" });
  const testBtn = h("button", { type: "button", onclick: async () => {
    tested.textContent = "Checking…";
    try {
      tested.textContent = `✓ GitHub accepted it: signed in as ${(await api("POST", "integrations/git/test-github")).login}.`;
    } catch (err) {
      tested.textContent = `✕ ${err.message}`;
    }
  } }, "Test");

  const connected = git.github.tokenSaved;
  const hasRepo = git.repos.some((r) => r.found);
  return [
    back,
    head,
    h(
      "section",
      { class: "card isetup" },
      h("h2", {}, "Three steps"),
      step(connected, "1. Connect GitHub", h("p", { class: "note" }, connected ? "Done. You are signed in." : "Sign in on github.com in your browser. Start below.")),
      step(hasRepo, "2. Choose your repositories", h("p", { class: "note" }, hasRepo ? `${git.repos.filter((r) => r.found).length} connected. Add or remove any time.` : connected ? "Pick your account or your company below, and tick the ones you want." : "After you connect, you pick which ones to bring in: your own, or your company's.")),
      step(hasRepo, "3. Give an agent a task on it", h("p", { class: "note" }, "Choose the repository at the top of Work in progress and assign a task. You review every change before it is kept.")),
    ),
    githubSection(),
    h("section", { class: "isec" }, h("h2", {}, `Connected repositories${git.repos.length ? ` · ${git.repos.length}` : ""}`), git.repos.length ? git.repos.map(repoCard) : h("p", { class: "note" }, "None yet. Connect GitHub above and choose the ones you want.")),
    h(
      "details",
      { class: "card onthis", open: ui.gitLocalOpen || auto?.local ? "" : null, ontoggle: (e) => (ui.gitLocalOpen = e.target.open) },
      h("summary", {}, h("b", {}, "Already have a repository on this computer?"), h("span", { class: "note small" }, "Optional")),
      h(
        "div",
        { class: "body" },
        h("p", { class: "note" }, "If the code is already in a folder on this computer, you can connect that folder instead of copying it from GitHub. Nothing on this computer is looked at until you press Search."),
        h("div", {}, searchBtn),
        foundHere,
        h(
          "div",
          { class: "iadd" },
        h("form", { class: "card form", onsubmit: (e) => (e.preventDefault(), act(() => api("PUT", "settings", { project: { path: folder.value.trim() } }))) }, h("b", {}, "Connect a folder by its location"), h("p", { class: "note small" }, "Type where it is. Nothing is copied or moved."), folder, h("div", {}, h("button", { class: "primary" }, "Connect"))),
        h(
          "form",
          {
            class: "card form",
            onsubmit: (e) => {
              e.preventDefault();
              cloneBtn.disabled = true;
              cloneBtn.textContent = "Copying…";
              act(() => api("POST", "integrations/git/clone", { url: url.value.trim() })).finally?.(() => ((cloneBtn.disabled = false), (cloneBtn.textContent = "Copy it here and connect")));
            },
          },
          h("b", {}, "Copy one from a web address"),
          h("p", { class: "note small" }, `Paste its address from GitHub or another host. A copy is made in ${git.cloneFolder}. A private repository needs this computer to be signed in to that host already.`),
          url,
          h("div", {}, cloneBtn),
        ),
        ),
        h("p", { class: "note small" }, `Git ${git.version} is installed. ${git.identity.name ? `Changes you keep are recorded as ${git.identity.name}${git.identity.email ? ` <${git.identity.email}>` : ""}.` : "Git has no name for you yet; connecting GitHub sets it from your account."}`),
      ),
    ),
    h(
      "section",
      { class: "isec" },
      h("h2", {}, "What agents can and cannot do"),
      h(
        "div",
        { class: "willrow" },
        h("div", { class: "willbox will" }, h("div", { class: "label" }, "✓ With this integration"), h("ul", {}, ...["Work on a repository in a branch and working copy made for that one task", "Read the code and its history, and run the project's tests", "Show you every change, file by file, before anything is kept", "Read GitHub issues and pull requests when a token is saved"].map((x) => h("li", {}, x)))),
        h("div", { class: "willbox wont" }, h("div", { class: "label" }, "✕ Never"), h("ul", {}, ...["Touch your own branches or your unsaved changes", "Commit to your branch: keeping a task makes one commit on the task's own branch", "Push, merge or deploy: those stay with you", "See your GitHub token"].map((x) => h("li", {}, x)))),
      ),
      h("p", { class: "note" }, git.coders.length ? `Agents that can change files, and so get a branch of their own: ${git.coders.map((b) => b.name).join(", ")}. Others can read a repository but not change it.` : "No agent on your team can change files yet. Add one from the marketplace, such as a developer."),
      h("p", { class: "note" }, "To use it: connect a repository, choose it in the Repository box at the top of Work in progress, then assign a task. When the task stops, its page shows the changes with Keep the changes and Undo."),
    ),
    git.repos.length || git.github.tokenSaved
      ? h(
          "section",
          { class: "card removeint" },
          h("div", { class: "grow" }, h("b", {}, "Remove this integration"), h("p", { class: "note" }, `Disconnects ${git.repos.length ? `all ${git.repos.length} repositor${git.repos.length === 1 ? "y" : "ies"}` : "everything"} and forgets the GitHub sign-in. Folders on your computer and everything on GitHub are left as they are. You can set it up again at any time.`)),
          h(
            "button",
            {
              class: "danger",
              onclick: () => {
                if (!confirm(`Remove the Git integration?\n\n${git.repos.length} repositor${git.repos.length === 1 ? "y is" : "ies are"} disconnected and the GitHub sign-in is forgotten. Nothing on GitHub changes.`)) return;
                const deleteCopies = (git.copies ?? []).length > 0 && confirm(`Also delete the ${git.copies.length} cop${git.copies.length === 1 ? "y" : "ies"} this app made on this computer?\n\n${git.copies.join("\n")}\n\nOK deletes those files. Cancel keeps them. Folders you connected yourself are never deleted.`);
                state.project = "";
                remember("talqava.project", "");
                ui.gitAuto = null;
                ui.githubPick = null;
                ui.githubSignIn = null;
                act(() => api("POST", "integrations/git/remove", { deleteCopies }));
              },
            },
            "Remove integration",
          ),
        )
      : null,
  ];
}

// ---------- the marketplace ----------
// Free, ready-made bots, each built for one job. A bot's instructions are shown
// in full before it is added; adding saves a copy as the person's own bot.
async function loadMarket() {
  const market = await api("GET", "marketplace");
  state.market = market.bots;
  state.marketTeams = market.teams ?? [];
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
  const search = h("input", { type: "search", placeholder: "Search by agent name or what you need done", "aria-label": "Search agents", value: ui.marketSearch || "" });
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
        h("div", { class: "mhead" }, h("div", {}, h("b", {}, t.name), h("div", { class: "by" }, `${list.length} agents · lead: ${list[0]?.listing.title ?? ""}`))),
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
      teams.length ? h("section", {}, h("h2", {}, "Teams"), h("p", { class: "note", style: "margin: -6px 0 12px" }, "A lead and the agents that report to it, added to your organization together."), h("div", { class: "mgrid wide" }, teams.map(teamCard))) : null,
      cat || needle ? section(cat === "+mine" ? "On my team" : cat || "Results", shown) : categories.map((c) => section(c, shown.filter((b) => b.listing.category === c))),
      shown.length ? null : h("p", { class: "note" }, cat === "+mine" ? "You have not added a marketplace agent yet." : "No agent matches that. Try other words, or create your own agent from the Work in progress page."),
    );
  };
  search.addEventListener("input", () => ((ui.marketSearch = search.value), draw()));
  col.append(
    h("h1", {}, "Marketplace"),
    h("p", { class: "lead" }, "Agents for every department, each built for one role. Read exactly what an agent is instructed to do before you add it to your organization."),
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
            ? [h("span", { class: "mpill on" }, "✓ On your team"), h("button", { class: "primary", onclick: () => chatWith(bot, col) }, `Chat with ${bot.name}`), h("button", { onclick: () => go("bot", bot.id) }, "Edit your copy"), h("button", { onclick: () => ((state.selectedBot = bot.id), remember("talqava.bot", bot.id), go("home")) }, `Assign a task to the ${bot.name}`)]
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
      h("div", { class: "row" }, h("h2", { class: "grow" }, "Instructions"), h("span", { class: "mono small muted" }, "Shown in full · nothing hidden"), copy),
      h("div", { class: "instructions" }, bot.instructions.split(/\n+/).filter((para) => para.trim()).map((para) => h("p", {}, para.trim()))),
      h("div", { class: "willrow" }, list("✓ Will do", bot.listing.will, "will"), list("✕ Will not do", bot.listing.wont, "wont")),
      governanceBox(bot),
      h("p", { class: "note" }, bot.added ? "This agent is on your team. Your copy is yours to edit, and it never changes unless you change it." : "After you add an agent, these instructions are yours to edit. Your copy never changes unless you change it."),
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
  ui.receiptPanel = h("div", { class: "tabpanel pad", hidden: true });
  ui.convoPanel = h("div", { class: "tabpanel" }, conversationPane());
  fill(ui.qcenter, ui.tabs, ui.changesPanel, ui.receiptPanel, ui.convoPanel);
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
    h("button", { onclick: () => go("home") }, "Back to agents"),
    keycap(q.bot.character, 40, mood(q), q.bot.type),
    h(
      "div",
      { class: "titles" },
      h("h1", {}, q.title),
      h("div", { class: "sub" }, `${q.bot.name}${roleOf(q.bot.id) ? `, ${roleOf(q.bot.id).title}` : (q.bot.title && q.bot.title !== q.bot.name ? `, ${q.bot.title}` : "")} · `, ...where, q.parent ? [" · assigned by ", h("button", { class: "plain link", onclick: () => go(q.parent.isQuest ? "quest" : "chat", q.parent.id) }, q.parent.by)] : null),
    ),
    ui.meta,
    h("span", { class: `pill solid ${tone}` }, label),
    h(
      "button",
      {
        class: "plain danger",
        title: "Delete this task",
        onclick: () =>
          confirm(q.branch && !q.outcome ? "Delete this task and undo its changes?" : "Delete this task from the log?") &&
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
  const tabs = [...(q.branch ? [["changes", "Changes"]] : []), ["conversation", "Conversation"], ["receipt", "Receipt"]];
  // Opened from a "Receipt" button, the task starts on its receipt.
  if (state.openReceipt === q.id) ((ui.tab = "receipt"), (state.openReceipt = null), (pickDefault = false));
  if (pickDefault || !tabs.some(([key]) => key === ui.tab)) ui.tab = reviewable ? "changes" : "conversation";
  const show = (key, focus = false) => {
    ui.tab = key;
    ui.changesPanel.hidden = key !== "changes";
    ui.convoPanel.hidden = key !== "conversation";
    ui.receiptPanel.hidden = key !== "receipt";
    if (key === "receipt") renderReceipt(q);
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
    fill(panel, h("div", { class: "decide" }, h("b", {}, q.outcome === "undone" ? "Task undone." : "The task changed nothing."), h("p", { class: "note" }, "Its branch and working copy were removed.")));
    return;
  }
  if (isLive(q)) {
    fill(panel, h("p", { class: "note" }, "You can review the changes when the task stops. Its work so far is in the Conversation tab."));
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
      : [h("p", { class: "note" }, "The task changed no files.")]),
    changes.truncated ? h("p", { class: "note" }, "Some of the changes are too long to show here.") : null,
    h(
      "div",
      { class: "decide" },
      h("div", {}, h("b", {}, changes.files.length ? "Ready for your review. " : "Nothing to keep. "), h("span", { class: "muted" }, "Keeping makes one commit on the task's branch; your current branch stays as it is.")),
      h(
        "div",
        { class: "row" },
        changes.files.length ? h("button", { class: "primary", onclick: () => attempt(async () => (await api("POST", `quests/${q.id}/accept`), afterDecision()), panel) }, "Keep the changes") : null,
        changes.files.length ? h("button", { onclick: () => (renderTabs(q, false), ui.tabs.querySelector('[data-key="conversation"]').click(), (ui.input.placeholder = `Tell ${q.bot.name} what to change…`)) }, "Ask for changes") : null,
        h(
          "button",
          { class: "danger", onclick: () => confirm("Throw away everything this task changed?") && attempt(async () => (await api("POST", `quests/${q.id}/undo`), afterDecision()), panel) },
          changes.files.length ? "Undo whole task" : "Close the branch",
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
        : "Works in the workspace folder. Shell commands and file changes ask first unless the agent runs everything.",
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
      ? h("p", { class: "mono small" }, "◌ Checking the result…")
      : q.check
        ? h(
            "ul",
            { class: "checks-list" },
            q.check.items.map((item) => h("li", {}, h("span", { class: "mark" }, item.passed ? "✓" : "✕"), h("span", {}, item.label, item.detail && !item.passed ? h("pre", {}, item.detail) : null))),
          )
        : h("p", { class: "note" }, isLive(q) ? "Runs when the agent says it is done. A failed check goes back to the agent to fix." : "Not checked."),
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
      h("div", { class: "mono small muted" }, roleLine(q.bot, roleOf(q.bot.id)?.title)),
      h("p", { class: "note" }, q.bot.source === "project" ? "From the repository's .crew/ folder." : q.bot.source === "personal" ? "Your own agent." : "A standard agent."),
      bot ? h("button", { onclick: () => go("bot", bot.id) }, `Edit ${q.bot.name}`) : null,
    ),
  );
}

// ---------- the receipt: what was done, what was not, and what each agent cost ----------
const tokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
const KINDS = { task: "Your task", handoff: "Handed on", question: "Question", decision: "Decision" };
const STATUS_WORDS = { done: "Finished", failed: "Failed", budget: "Out of budget", stopped: "Stopped", running: "Working", waiting: "Waiting" };

function receiptText(r) {
  const out = [`RECEIPT: ${r.title}`, `${new Date(r.startedAt).toLocaleString()}${r.endedAt ? ` to ${new Date(r.endedAt).toLocaleString()}` : " (still under way)"}`, `Total ${money(r.total)} of a ${money(r.budget)} budget · ${r.lines.length} parts · ${r.actions} actions · ${r.failedActions} did not work`, "", "COST BY AGENT"];
  for (const a of r.byAgent) out.push(`  ${a.agent}: ${money(a.cost)} · ${a.tasks} part${a.tasks === 1 ? "" : "s"} · ${a.actions} actions · ${tokens(a.input)} read, ${tokens(a.output)} written`);
  out.push("", "NOT DONE");
  if (r.total > r.budget) out.push(`  The task cost ${money(r.total)}, over its ${money(r.budget)} budget.`);
  if (!r.notDone.length && !r.failedActions) out.push("  Nothing: every part finished.");
  for (const n of r.notDone) out.push(`  ${n.agent}: ${n.title.slice(0, 90)} - ${n.why}`);
  out.push("", "EVERY PART");
  for (const l of r.lines) {
    out.push(`  ${l.agent} · ${KINDS[l.kind] || l.kind}${l.from ? ` from ${l.from}` : ""} · ${STATUS_WORDS[l.status] || l.status} · ${money(l.cost)} · ${l.model}`, `    ${l.title.replace(/\s+/g, " ").slice(0, 160)}`);
    for (const a of l.actions) out.push(`    ${a.ok ? "done    " : "NOT DONE"} ${NAMES[a.name] || a.name}: ${String(summarize(a.name, a.input)).replace(/\s+/g, " ").slice(0, 140)}${a.error ? ` (${a.error.replace(/\s+/g, " ").slice(0, 140)})` : ""}`);
  }
  return out.join("\n");
}

async function renderReceipt(q) {
  const panel = ui.receiptPanel;
  if (!panel) return;
  let r;
  try {
    r = await api("GET", `quests/${q.id}/receipt`);
  } catch (err) {
    return fill(panel, h("p", { class: "note" }, `The receipt could not be loaded: ${err.message}`));
  }
  if (!r || state.convId !== q.id) return;
  const open = new Set([...panel.querySelectorAll("details[open]")].map((d) => d.dataset.id));
  const most = Math.max(...r.byAgent.map((a) => a.cost), 0.000001);
  // Not done: parts that did not finish, single actions that did not work, and going over the budget.
  const undone = [
    ...(r.total > r.budget ? [{ agent: "Budget", title: `The task cost ${money(r.total)}, over its ${money(r.budget)} budget.`, why: "" }] : []),
    ...r.notDone,
    ...r.lines.flatMap((l) => l.actions.filter((a) => !a.ok).map((a) => ({ agent: l.agent, title: `${NAMES[a.name] || a.name}: ${String(summarize(a.name, a.input))}`, why: a.error }))),
  ];
  const copy = h("button", { class: "small", onclick: () => navigator.clipboard?.writeText(receiptText(r)).then(() => ((copy.textContent = "Copied"), setTimeout(() => (copy.textContent = "Copy receipt"), 1500))) }, "Copy receipt");
  const save = h("button", { class: "small", onclick: () => {
    const a = h("a", { href: URL.createObjectURL(new Blob([receiptText(r)], { type: "text/plain" })), download: `receipt-${r.id}.txt` });
    a.click();
    URL.revokeObjectURL(a.href);
  } }, "Save as a file");
  fill(
    panel,
    h(
      "div",
      { class: "receipt" },
      h("div", { class: "rhead" }, h("div", { class: "grow" }, h("div", { class: "label" }, "Receipt"), h("h2", {}, r.title), h("div", { class: "note small" }, `${new Date(r.startedAt).toLocaleString()}${r.endedAt ? ` to ${new Date(r.endedAt).toLocaleTimeString()}` : " · still under way"}`)), copy, save),
      h(
        "div",
        { class: "rtotals" },
        h("div", {}, h("span", {}, "Total cost"), h("b", {}, money(r.total)), h("i", {}, `of a ${money(r.budget)} budget`)),
        h("div", {}, h("span", {}, "Parts"), h("b", {}, String(r.lines.length)), h("i", {}, `${r.lines.filter((l) => l.status === "done").length} finished`)),
        h("div", {}, h("span", {}, "Actions taken"), h("b", {}, String(r.actions)), h("i", { class: r.failedActions ? "bad" : "" }, r.failedActions ? `${r.failedActions} did not work` : "all worked")),
        h("div", {}, h("span", {}, "Reading and writing"), h("b", {}, tokens(r.input + r.output)), h("i", {}, `tokens: ${tokens(r.input)} read, ${tokens(r.output)} written`)),
      ),
      h("h3", {}, "Cost by agent"),
      h(
        "div",
        { class: "ragents" },
        r.byAgent.map((a) =>
          h(
            "div",
            { class: "ragent" },
            keycap(a.character, 26, "", a.type),
            h("div", { class: "grow" }, h("div", { class: "rname" }, h("b", {}, a.agent), h("span", {}, `${a.tasks} part${a.tasks === 1 ? "" : "s"} · ${a.actions} action${a.actions === 1 ? "" : "s"}${a.failed ? ` · ${a.failed} did not work` : ""} · ${tokens(a.input + a.output)} tokens`)), h("div", { class: "rbar" }, h("i", { style: `width:${Math.max(2, (a.cost / most) * 100)}%` }))),
            h("div", { class: "rcost" }, h("b", {}, money(a.cost)), h("span", {}, r.total ? `${Math.round((a.cost / r.total) * 100)}%` : "")),
          ),
        ),
      ),
      h("h3", {}, `What was not done · ${undone.length}`),
      undone.length
        ? h("div", { class: "rnot" }, undone.map((n) => h("div", { class: "rnotrow" }, h("b", {}, n.agent), h("span", { class: "grow" }, n.title.replace(/\s+/g, " ").slice(0, 110)), h("em", {}, n.why))))
        : h("p", { class: "note" }, "Nothing was left undone: every part finished and left a report."),
      h("h3", {}, "Every part, in order"),
      h("p", { class: "note small" }, "Open a part to see each action the agent took and whether it worked."),
      r.lines.map((l) =>
        h(
          "details",
          { class: `rline ${l.notDone ? "bad" : ""}`, "data-id": l.id, open: open.has(l.id) || undefined },
          h(
            "summary",
            {},
            keycap(l.character, 22, "", l.type),
            h("div", { class: "grow" }, h("div", { class: "rname" }, h("b", {}, l.agent), h("span", {}, `${KINDS[l.kind] || l.kind}${l.from ? ` from ${l.from}` : ""} · ${STATUS_WORDS[l.status] || l.status} · ${l.actions.length} action${l.actions.length === 1 ? "" : "s"} · ${l.model}`)), h("div", { class: "rtitle" }, l.title.replace(/\s+/g, " "))),
            h("div", { class: "rcost" }, h("b", {}, money(l.cost)), h("span", {}, `${tokens(l.input + l.output)} tokens`)),
          ),
          h(
            "div",
            { class: "rbody" },
            l.notDone ? h("div", { class: "rwhy" }, l.notDone) : null,
            l.actions.length
              ? h("ol", { class: "racts" }, l.actions.map((a) => h("li", { class: a.ok ? "" : "bad" }, h("span", { class: "rmark" }, a.ok ? "Done" : "Not done"), h("b", {}, NAMES[a.name] || a.name), h("span", { class: "grow" }, String(summarize(a.name, a.input)).replace(/\s+/g, " ").slice(0, 200)), a.error ? h("em", {}, a.error.replace(/\s+/g, " ")) : null)))
              : h("p", { class: "note small" }, "No actions: the agent only wrote its answer."),
            l.said ? h("div", { class: "rsaid" }, h("span", { class: "label" }, "Its report"), l.said) : null,
            l.id !== q.id ? h("button", { class: "plain small", onclick: () => go("quest", l.id) }, "Open this part →") : null,
          ),
        ),
      ),
      h("p", { class: "note small" }, "Costs are estimated from each model's list price, the same way as everywhere else in the app."),
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
      title: "",
      group: "",
      character: { legend: "", texture: "dots", color: "green" },
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
    h("button", { onclick: () => go("home") }, "Back to agents"),
    h("div", { class: "titles" }, h("h1", {}, isNew ? "Create an agent" : `Edit ${existing.name}`), h("div", { class: "sub mono" }, fileNote)),
    !isNew && existing.source === "personal"
      ? h(
          "button",
          {
            class: "plain danger",
            onclick: () =>
              confirm(`Remove your version of ${existing.name}? The standard agent of the same name comes back.`) &&
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
  // An agent with no initials yet gets them from its title or name as it is typed.
  const initialsOf = (text) => String(text).trim().split(/\s+/).filter((w) => /^[A-Za-z0-9]/.test(w) && !/^(of|the|and|for)$/i.test(w)).map((w) => w[0].toUpperCase()).slice(0, 3).join("");
  let ownLegend = Boolean(draft.character.legend) && !isNew;
  if (!draft.character.legend) draft.character.legend = isNew ? "?" : legendOf(draft.character, draft.type);
  const autoLegend = () => {
    if (ownLegend) return;
    const made = initialsOf(draft.title || draft.name);
    if (made) (draft.character.legend = made), (legendInput.value = made);
  };
  const legendInput = h("input", {
    id: "legend",
    value: draft.character.legend,
    maxlength: 6,
    autocomplete: "off",
    style: "text-align: center; font-weight: 600; font-size: 16px; max-width: 120px",
    oninput: (e) => {
      const chars = [...e.target.value.replace(/\s/g, "")].slice(0, 3).join("");
      if (chars) {
        ownLegend = true;
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
      h("h2", {}, draft.name || "New agent"),
      h("div", { class: "type" }, roleLine({ name: draft.name, group: draft.group }, draft.title) || "Role not set"),
      h("p", { class: "label", style: "margin-top: 22px" }, `Colour · ${NEON[draft.character.color][0]}`),
      swatches(draft.character.color, (name) => ((draft.character.color = name), drawPortrait()), "Colour"),
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
      h("label", { class: "label", for: "legend", style: "display: block; margin-top: 22px" }, "Initials"),
      legendInput,
      h("p", { class: "note small" }, "One to three characters printed on its key, such as HS for Head of Sales."),
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
  const name = h("input", { value: draft.name, placeholder: "e.g. Head of Partnerships", maxlength: 40, oninput: (e) => ((draft.name = e.target.value), autoLegend(), drawPortrait()) });
  const title = h("input", { value: draft.title && draft.title !== cap(draft.type) ? draft.title : "", placeholder: "e.g. Head of Partnerships", maxlength: 50, oninput: (e) => ((draft.title = e.target.value), autoLegend(), drawPortrait()) });
  const types = ["scout", "scribe", "maker", "keeper", "counter", "spark"];
  const TYPE_WORDS = { scout: "Research and analysis", scribe: "Writing and communications", maker: "Software engineering", keeper: "Operations and oversight", counter: "Numbers and data", spark: "Strategy and planning" };
  const type = h(
    "select",
    {
      onchange: (e) => {
        if (draft.character.texture === TYPE_TEXTURES[draft.type]) draft.character.texture = TYPE_TEXTURES[e.target.value] ?? draft.character.texture;
        if (draft.character.color === TYPE_COLORS[draft.type]) draft.character.color = TYPE_COLORS[e.target.value] ?? draft.character.color;
        draft.type = e.target.value;
        drawPortrait();
      },
    },
    [...new Set([...types, draft.type])].map((t) => h("option", { value: t, selected: t === draft.type }, TYPE_WORDS[t] ?? cap(t))),
  );
  const instructions = h("textarea", { rows: 7, placeholder: "What this role is responsible for and how it works. Plain sentences work best." }, draft.instructions);

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
            h("div", { class: "muted" }, result.recommended.includes(cap(draft.type)) ? `Suitable for ${(TYPE_WORDS[draft.type] ?? "this kind of work").toLowerCase()}.` : `Not recommended for ${(TYPE_WORDS[draft.type] ?? "this kind of work").toLowerCase()}. Suitable for: ${result.recommended.map((r) => (TYPE_WORDS[r.toLowerCase()] ?? r).toLowerCase()).join(", ")}.`),
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

  const group = h("input", { value: draft.group || "", placeholder: "e.g. Sales", maxlength: 30, list: "team-groups", autocomplete: "off", oninput: (e) => ((draft.group = e.target.value), drawPortrait()) });
  const groupList = h("datalist", { id: "team-groups" }, [...new Set((state.crew?.bots ?? []).map((b) => b.group))].map((g) => h("option", { value: g })));
  const monthly = h("input", { type: "number", min: 0, max: 10000, step: 0.5, value: draft.monthly ?? "", placeholder: "No limit" });
  save.addEventListener("click", () =>
    attempt(async () => {
      const body = {
        group: group.value.trim(),
        ...(monthly.value !== "" ? { monthly: Number(monthly.value) } : {}),
        name: name.value.trim(),
        title: title.value.trim() || name.value.trim(),
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
        h("section", { class: "card" }, h("h3", {}, "Role"), h("label", { class: "field" }, "Name", name), h("label", { class: "field" }, "Job title", title), h("label", { class: "field" }, "Department", group, groupList), h("label", { class: "field" }, "Kind of work", type), h("label", { class: "field" }, "Instructions", instructions)),
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
          h("p", { class: "note" }, "An agent only gets the tools its powers grant. Changes ask first by default, and always after reading the web."),
        ),
        h(
          "section",
          { class: "card" },
          h("h3", {}, "Limits"),
          h("label", { class: "field" }, "Approvals", approvals),
          h("div", { class: "row" }, h("label", { class: "field grow" }, "Budget per task ($)", spend), h("label", { class: "field grow" }, "Steps per task", steps)),
          h("div", { class: "row" }, h("label", { class: "field grow" }, "Budget per month ($)", monthly)),
          h("p", { class: "note small" }, existing?.month ? `Spent this month: ${money(existing.month.spent)}. At its monthly budget an agent starts no new work until you raise it or the month turns.` : "At its monthly budget an agent starts no new work until you raise it or the month turns."),
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
  fill(ui.body, ui.chatSide, h("main", { class: "center flush" }, h("div", { class: "chathead", style: withBot ? botStyle(withBot) : "" }, withBot ? keycap(withBot.character, 28, "", withBot.type) : null, ui.title, withBot ? h("span", { class: "small muted", title: "This chat is with one agent, in its role. It uses that agent's instructions, powers, model and limits." }, roleLine(withBot, roleOf(withBot.id)?.title)) : null, ui.meta, ui.move, withBot ? null : modelPicker(), ui.pin, ui.remove), pane));
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
        h("p", { class: "note small" }, "Want a task done in the background? ", h("button", { class: "plain link", onclick: () => go("home") }, "Assign an agent"), " instead."),
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
      ((tasks) =>
        tasks.length
          ? [
              h("div", { class: "listlabel" }, "Team tasks"),
              tasks.map((q) =>
                h(
                  "div",
                  { class: "chatrow" },
                  h("button", { class: "navlink", title: `${q.bot.name}: ${q.title}`, onclick: () => go("quest", q.id) }, keycap(q.bot.character, 18, "", q.bot.type), h("span", { class: "title" }, q.title), q.approvals?.length ? h("i", { class: "dot wait", title: "Waiting for your approval" }) : isLive(q) ? h("i", { class: "dot", title: "Working" }) : String(q.updatedAt) > seenUpdates() ? h("i", { class: "dot new", title: "New result" }) : null),
                ),
              ),
            ]
          : null)(ownTasks().slice(0, 8)),
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
const speaker = () => (state.view === "quest" ? (state.quests.find((q) => q.id === state.convId)?.bot.name ?? "the agent") : (chatBotOf()?.name ?? state.config.agentName));

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
    h("p", { class: "note" }, "Accent colour: ", accentLabel, ". Used for buttons and highlights. Each agent has a colour and a look of its own, which you can change when you edit the agent."),
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
  const savings = select([["off", "Off: every agent uses my model"], ["balanced", "On: match the model to the work"]], c.savings ?? "off");
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
          save({ agentName: name.value, model: ref(), effort: effort.value, savings: savings.value, approvalMode: mode.value, budget: { steps: Number(steps.value), spend: spend.value === "" ? null : Number(spend.value) } })
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
      h("label", {}, "Cost saving for your team of agents", savings),
      h("p", { class: "note small" }, "With cost saving on, and Claude Opus or Fable as your model: managers who plan and check keep your model, team members doing their own part use Claude Sonnet 5.5 (about half the price), and quick questions between agents use Claude Haiku 5.5 (about a fortieth). An agent you gave a model of its own keeps it. Off uses your model for everything."),
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
      h("p", { class: "note small" }, "Set the context size to what the model really holds. Long tasks are shortened to fit it, so a small local model keeps the task in view instead of losing track."),
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
    h("p", { class: "note" }, "Repositories and GitHub are set up under ", h("button", { class: "plain link", onclick: () => ((ui.integration = "git"), go("integrations")) }, "Integrations → Git"), ", which also shows each repository's branch and state."),
    h("p", { class: "note" }, "Agents can work on these. A task that changes code gets its own branch and working copy, so your files and branches are untouched until you keep its changes. Agents in a repository's .crew/ folder join the team when it is chosen."),
    ...c.projects.map((p) => h("div", { class: "card" }, h("div", { class: "row" }, h("div", { class: "grow" }, h("code", {}, p)), h("button", { class: "plain danger", onclick: () => save({ project: { path: p, remove: true } }) }, "Remove")))),
    h("form", { class: "form", onsubmit: (e) => (e.preventDefault(), save({ project: { path: repoPath.value.trim() } })) }, repoPath, h("div", {}, h("button", {}, "Add repository"))),
  );

  const mName = h("input", { placeholder: "Name, e.g. notion" });
  const mUrl = h("input", { placeholder: "https://… (the connector's MCP address)" });
  const mToken = h("input", { type: "password", placeholder: "Access token (if it needs one)", autocomplete: "off" });
  const mCommand = h("input", { placeholder: "Or a program to run, e.g. npx -y @some/mcp-server", class: "mono" });
  col.append(
    h("h3", {}, "Connectors (MCP servers)"),
    h("p", { class: "note" }, "Connectors give agents ready-made tools for other services. The app connects to them from this computer, so they work with every model. A connector can be on the web, or a program this computer runs. Their tools ask before changing anything unless the connector marks them read-only, and agents give them only to agents with the connectors power."),
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

// Rebuilds docs/architecture.html from docs/architecture.json:
//   node docs/build-architecture.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const data = fs.readFileSync(path.join(here, "architecture.json"), "utf8");
const embedded = JSON.stringify(JSON.parse(data)).replace(/</g, "\\u003c");

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Personal Agent: architecture</title>
<style>
:root {
  --bg: #f6f3ee; --panel: #fffdf9; --text: #24211d; --muted: #6f685e; --line: #d9d1c4;
  --core: #b4532a; --core-text: #fff; --app: #fffdf9; --data: #e6efe4; --data-line: #7fa27b;
  --ext: #e7ecf5; --ext-line: #7d93bd; --person: #f3e3c8; --person-line: #c79a4b; --code: #efe9df;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #1b1a18; --panel: #242321; --text: #ece7df; --muted: #a39b90; --line: #3a3731;
    --core: #e0825a; --core-text: #1b1a18; --app: #2b2927; --data: #24322a; --data-line: #5f8a69;
    --ext: #232b3a; --ext-line: #5f78a8; --person: #3a301d; --person-line: #a98345; --code: #2e2c29;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 1120px; margin: 0 auto; padding: 32px 16px 64px; }
h1 { font: 600 30px/1.2 Georgia, "Iowan Old Style", serif; margin: 0 0 8px; }
h2 { font: 600 20px/1.3 Georgia, serif; margin: 44px 0 6px; }
p { margin: 0 0 12px; }
.lede { font-size: 17px; max-width: 760px; }
.muted { color: var(--muted); }
.chips { display: flex; flex-wrap: wrap; gap: 8px; margin: 14px 0 0; padding: 0; list-style: none; }
.chips li { border: 1px solid var(--line); border-radius: 999px; padding: 3px 12px; font-size: 13px; background: var(--panel); }
code { background: var(--code); border-radius: 4px; padding: 1px 5px; font: 13px ui-monospace, Menlo, Consolas, monospace; overflow-wrap: anywhere; }
.diagram { overflow-x: auto; border: 1px solid var(--line); border-radius: 12px; background: var(--panel); padding: 12px; }
.diagram svg { display: block; min-width: 980px; width: 100%; height: auto; }
.node rect { stroke-width: 1.5; }
.node .label { font: 600 15px system-ui, sans-serif; fill: var(--text); }
.node .sub { font: 12px system-ui, sans-serif; fill: var(--muted); }
.node.core rect { fill: var(--core); stroke: var(--core); }
.node.core .label, .node.core .sub { fill: var(--core-text); }
.node.app rect { fill: var(--app); stroke: var(--line); }
.node.data rect { fill: var(--data); stroke: var(--data-line); }
.node.external rect { fill: var(--ext); stroke: var(--ext-line); }
.node.person rect { fill: var(--person); stroke: var(--person-line); }
.edge line { stroke: var(--muted); stroke-width: 1.5; }
.edge text { font: 11.5px system-ui, sans-serif; fill: var(--muted); paint-order: stroke; stroke: var(--panel); stroke-width: 4px; }
.arrow { fill: var(--muted); }
.legend { display: flex; flex-wrap: wrap; gap: 14px; margin: 10px 0 0; font-size: 13px; color: var(--muted); }
.legend span::before { content: ""; display: inline-block; width: 12px; height: 12px; border-radius: 3px; margin-right: 6px; vertical-align: -1px; border: 1.5px solid var(--sw-line); background: var(--sw); }
.grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px; }
.card h3 { font: 600 15px/1.3 system-ui, sans-serif; margin: 0 0 2px; }
.card .meta { font-size: 12.5px; color: var(--muted); margin-bottom: 8px; }
.card p { margin: 0 0 8px; font-size: 14px; }
.steps { list-style: none; padding: 0; margin: 0; display: grid; gap: 8px; }
.steps li { display: grid; grid-template-columns: 34px 1fr; gap: 12px; background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 12px 14px; }
.steps .n { width: 30px; height: 30px; border-radius: 50%; background: var(--core); color: var(--core-text); display: grid; place-items: center; font-weight: 700; }
.steps b { display: block; }
.table { overflow-x: auto; border: 1px solid var(--line); border-radius: 12px; background: var(--panel); }
table { border-collapse: collapse; width: 100%; font-size: 14px; }
th, td { text-align: left; padding: 9px 14px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); font-weight: 600; }
tr:last-child td { border-bottom: 0; }
td:first-child { white-space: nowrap; }
footer { margin-top: 44px; color: var(--muted); font-size: 13px; }
</style>
</head>
<body>
<main id="root"></main>
<script type="application/json" id="data">${embedded}</script>
<script>
const d = JSON.parse(document.getElementById("data").textContent);
const root = document.getElementById("root");
const NS = "http://www.w3.org/2000/svg";

function h(tag, attrs, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, v);
  node.append(...kids.flat().filter((k) => k != null));
  return node;
}
function s(tag, attrs, text) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, v);
  if (text != null) node.textContent = text;
  return node;
}
const section = (title, intro, ...kids) => [h("h2", {}, title), ...(intro ? [h("p", { class: "muted" }, intro)] : []), ...kids];
function table(heads, rows) {
  return h("div", { class: "table" }, h("table", {},
    h("thead", {}, h("tr", {}, heads.map((t) => h("th", {}, t)))),
    h("tbody", {}, rows.map((cells) => h("tr", {}, cells.map((c) => h("td", {}, c)))))));
}
const code = (t) => h("code", {}, t);

// ----- the diagram -----
function diagram() {
  const W = 190, H = 62, PX = 310, PY = 140, M = 12;
  const cols = Math.max(...d.diagram.nodes.map((n) => n.col)) + 1;
  const rows = Math.max(...d.diagram.nodes.map((n) => n.row)) + 1;
  const svg = s("svg", { viewBox: "0 0 " + ((cols - 1) * PX + W + M * 2) + " " + ((rows - 1) * PY + H + M * 2), role: "img", "aria-label": "How the parts of the agent connect" });
  const defs = s("defs");
  const marker = s("marker", { id: "arrow", viewBox: "0 0 10 10", refX: "9", refY: "5", markerWidth: "7", markerHeight: "7", orient: "auto-start-reverse" });
  marker.append(s("path", { d: "M0 0 L10 5 L0 10 z", class: "arrow" }));
  defs.append(marker);
  svg.append(defs);
  const at = Object.fromEntries(d.diagram.nodes.map((n) => [n.id, { x: M + n.col * PX, y: M + n.row * PY, ...n }]));

  for (const e of d.diagram.edges) {
    const a = at[e.from], b = at[e.to];
    let x1, y1, x2, y2, lx, ly, anchor = "middle";
    if (a.row === b.row) {
      x1 = a.x + W; x2 = b.x; y1 = y2 = a.y + H / 2; lx = (x1 + x2) / 2; ly = y1 - 7;
    } else if (a.col === b.col) {
      x1 = x2 = a.x + W / 2; y1 = a.y + H; y2 = b.y; lx = x1 + 8; ly = (y1 + y2) / 2 + 4; anchor = "start";
    } else {
      // Diagonal: leave from the corner nearest the target.
      const up = b.row < a.row, right = b.col > a.col;
      x1 = right ? a.x + W - 30 : a.x + 30; y1 = up ? a.y : a.y + H;
      x2 = right ? b.x + 30 : b.x + W - 30; y2 = up ? b.y + H : b.y;
      lx = (x1 + x2) / 2; ly = (y1 + y2) / 2 + 4;
    }
    const g = s("g", { class: "edge" });
    g.append(s("line", { x1, y1, x2, y2, "marker-end": "url(#arrow)" }), s("text", { x: lx, y: ly, "text-anchor": anchor }, e.label));
    svg.append(g);
  }
  for (const n of Object.values(at)) {
    const g = s("g", { class: "node " + n.kind });
    g.append(s("rect", { x: n.x, y: n.y, width: W, height: H, rx: 10 }),
      s("text", { class: "label", x: n.x + W / 2, y: n.y + 26, "text-anchor": "middle" }, n.label),
      s("text", { class: "sub", x: n.x + W / 2, y: n.y + 45, "text-anchor": "middle" }, n.sub));
    svg.append(g);
  }
  const legend = [["Core loop", "--core", "--core"], ["Part of the app", "--app", "--line"], ["On your machine", "--data", "--data-line"], ["Outside services", "--ext", "--ext-line"]];
  return [h("div", { class: "diagram" }, svg), h("div", { class: "legend" }, legend.map(([t, bg, ln]) => h("span", { style: "--sw: var(" + bg + "); --sw-line: var(" + ln + ")" }, t)))];
}

root.append(
  h("h1", {}, d.name + ": how it is built"),
  h("p", { class: "lede" }, d.summary),
  h("ul", { class: "chips" }, [d.runtime.requires, d.runtime.language, "One dependency: " + d.runtime.dependencies[0], "Default model: " + d.model.default, d.tests.count + " automated tests"].map((t) => h("li", {}, t))),

  ...section("The map", "Arrows show who calls whom. The blue boxes are outside services; everything else is one program on your machine."),
  ...diagram(),

  ...section("What happens when you send a message"),
  h("ol", { class: "steps" }, d.flow.map((f) => h("li", {}, h("span", { class: "n" }, String(f.step)), h("div", {}, h("b", {}, f.where), f.what)))),

  ...section("The parts", "Each file, what it is responsible for, and what it relies on."),
  h("div", { class: "grid" }, d.components.map((c) => h("div", { class: "card" },
    h("h3", {}, c.role), h("div", { class: "meta" }, code(c.file), " · " + c.lines + " lines"),
    h("p", {}, c.does),
    c.uses.length ? h("p", { class: "muted" }, "Uses: ", c.uses.flatMap((u, i) => [i ? ", " : "", code(u)])) : null))),

  ...section("The agent's tools", "What Claude can do, where each tool runs, and when it waits for your approval."),
  table(["Tool", "Runs on", "Asks first", "What it does"], d.tools.map((t) => [h("span", {}, h("b", {}, t.label), h("br"), code(t.name)), t.runsOn, t.approval, t.does])),

  ...section("What is stored, and where", "Plain JSON files. Back up the data folder and you have backed up the agent."),
  table(["Path", "Holds"], d.data.map((x) => [code(x.path), x.holds])),

  ...section("Safeguards"),
  h("div", { class: "grid" }, d.safeguards.map((g) => h("div", { class: "card" }, h("h3", {}, g.name), h("p", {}, g.what)))),

  ...section("How the page talks to the server", "Live event types on the stream: " + d.events.join(", ") + "."),
  table(["Method", "Path", "What it does"], d.api.map((a) => [a.method, code(a.path), a.does])),

  ...section("Where it runs"),
  table(["Mode", "How", "Notes"], d.deployment.map((m) => [h("b", {}, m.mode), m.how, m.notes])),

  ...section("Model"),
  h("p", {}, "Default ", code(d.model.default), ". Selectable in Settings: ", d.model.choices.flatMap((m, i) => [i ? ", " : "", code(m)]), "."),
  h("ul", { class: "chips" }, d.model.features.map((f) => h("li", {}, f))),

  h("footer", {}, "Version " + d.version + ". This page is generated from architecture.json by docs/build-architecture.mjs."),
);
</script>
</body>
</html>
`;
fs.writeFileSync(path.join(here, "architecture.html"), html);
console.log("Wrote docs/architecture.html");

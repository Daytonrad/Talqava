#!/usr/bin/env node
// Removes files that dependencies bring along but Talqava neither needs nor may ship under its open-source policy
// (legal/OPEN_SOURCE_POLICY.md). Runs after every install (npm's postinstall), so the app, the installer, Docker and
// the Mac app all leave them out. Each entry says why, and was checked to be unused by what Talqava does.
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const REMOVE = [
  {
    // The Liberation fonts (version 1, Red Hat) are under GPL v2 with a font exception, which the policy avoids. The
    // PDF reader uses them only to draw pages; Talqava reads text from PDFs, which works without them (tested).
    dir: "node_modules/pdfjs-dist/standard_fonts",
    match: /^(LiberationSans-.*\.ttf|LICENSE_LIBERATION)$/,
  },
];

let removed = 0;
for (const { dir, match } of REMOVE) {
  const at = path.join(ROOT, dir);
  if (!fs.existsSync(at)) continue;
  for (const name of fs.readdirSync(at)) if (match.test(name)) fs.rmSync(path.join(at, name)), removed++;
}
if (removed) console.log(`Talqava: left out ${removed} file${removed === 1 ? "" : "s"} its open-source policy does not ship (see scripts/prune-shipped.mjs).`);

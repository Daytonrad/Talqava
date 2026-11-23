// Copies the app (code, web pages, starter bots and quests) into build/server
// and installs only what it needs to run, ready to go inside the Mac app.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const out = path.join(here, "build", "server");

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
for (const item of ["src", "public", "crew", "quests", "package.json", "package-lock.json", "LICENSE"]) {
  fs.cpSync(path.join(root, item), path.join(out, item), { recursive: true });
}
execFileSync("npm", ["ci", "--omit=dev", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: out, stdio: "inherit" });
console.log(`Server ready in ${out}`);

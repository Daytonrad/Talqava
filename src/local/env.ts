// Loads settings from .env before anything else reads them.
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

try {
  process.loadEnvFile(path.join(ROOT, ".env"));
} catch {}

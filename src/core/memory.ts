// Which memories go into a conversation. General memories go everywhere; a
// space's memories go only into that space's conversations. When there is more
// than fits comfortably in the prompt, the entries that bear on what is being
// talked about are shown and the rest stay one search away.
import { rank } from "./rank.ts";
import type { MemoryEntry } from "./types.ts";

/** How much memory is put in the prompt, in characters. More than this is picked by relevance. */
export const MEMORY_PROMPT_BUDGET = 6000;
/** The longest a single entry may be. Memory holds facts, not documents. */
export const MEMORY_ENTRY_LIMIT = 1500;

/** The entries a conversation in this space may see: General's and its own. */
export function visibleMemory(entries: MemoryEntry[], space?: string): MemoryEntry[] {
  return entries.filter((e) => !e.space || e.space === space);
}

/**
 * Picks what to show. Everything, if it fits. Otherwise the entries that match
 * `about` best (the latest message and the chat's title), then the newest,
 * until the budget is used. `hidden` counts what was left out.
 */
export function selectMemory(entries: MemoryEntry[], space: string | undefined, about: string, budget = MEMORY_PROMPT_BUDGET): { shown: MemoryEntry[]; hidden: number } {
  const visible = visibleMemory(entries, space);
  const size = (list: MemoryEntry[]) => list.reduce((n, e) => n + e.text.length + 20, 0);
  if (size(visible) <= budget) return { shown: visible, hidden: 0 };
  const relevant = rank(about, visible, (e) => e.text).map((r) => r.item);
  const newest = [...visible].reverse();
  const picked = new Set<MemoryEntry>();
  let used = 0;
  const take = (entry: MemoryEntry, limit: number) => {
    if (picked.has(entry) || used + entry.text.length + 20 > limit) return;
    picked.add(entry);
    used += entry.text.length + 20;
  };
  // Most of the room goes to what is relevant; the newest entries fill the rest.
  for (const entry of relevant) take(entry, budget * 0.7);
  for (const entry of newest) take(entry, budget);
  for (const entry of relevant) take(entry, budget);
  return { shown: visible.filter((e) => picked.has(e)), hidden: visible.length - picked.size };
}

// Ranked text search, used for memory and past conversations. It matches on
// words rather than an exact phrase: the words may come in any order, in other
// forms ("charging" finds "charge", "prices" finds "price"), and rarer words
// count for more. No model or network is needed, so it works with every setup.

const STOP = new Set(
  "a an and are as at be but by did do does for from had has have he her his how i if in into is it its me my of on or our she so than that the their them then there these they this to was we were what when where which who why will with would you your about".split(
    " ",
  ),
);

/** A word reduced to a rough stem, so different forms of it match. */
export function stem(word: string): string {
  let w = word;
  if (w.length > 4 && w.endsWith("ies")) w = `${w.slice(0, -3)}y`;
  else if (w.length > 4 && w.endsWith("sses")) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us")) w = w.slice(0, -1);
  for (const suffix of ["ingly", "edly", "ing", "ed", "ly"]) {
    if (w.length - suffix.length >= 3 && w.endsWith(suffix)) {
      w = w.slice(0, -suffix.length);
      // "planned" → "plan", "running" → "run"
      if (w.length > 3 && w.at(-1) === w.at(-2) && !"lsz".includes(w.at(-1)!)) w = w.slice(0, -1);
      break;
    }
  }
  if (w.length > 4 && w.endsWith("e")) w = w.slice(0, -1);
  return w;
}

/** The searchable words of a text: lowercased, stemmed, without filler words. */
export function terms(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => !STOP.has(w)).map(stem);
}

export interface Ranked<T> {
  item: T;
  score: number;
}

/**
 * Orders items by how well their text matches the query (BM25). Items that
 * share no word with the query are left out.
 */
export function rank<T>(query: string, items: T[], textOf: (item: T) => string): Ranked<T>[] {
  const wanted = [...new Set(terms(query))];
  if (!wanted.length || !items.length) return [];
  const docs = items.map((item) => {
    const counts = new Map<string, number>();
    const words = terms(textOf(item));
    for (const w of words) counts.set(w, (counts.get(w) ?? 0) + 1);
    return { item, counts, length: words.length };
  });
  const average = docs.reduce((n, d) => n + d.length, 0) / docs.length || 1;
  const k = 1.4;
  const b = 0.75;
  const out: Ranked<T>[] = [];
  const idf = new Map(
    wanted.map((w) => {
      const having = docs.filter((d) => d.counts.has(w)).length;
      return [w, Math.log(1 + (docs.length - having + 0.5) / (having + 0.5))];
    }),
  );
  for (const doc of docs) {
    let score = 0;
    let matched = 0;
    for (const w of wanted) {
      const f = doc.counts.get(w);
      if (!f) continue;
      matched++;
      score += idf.get(w)! * ((f * (k + 1)) / (f + k * (1 - b + (b * doc.length) / average)));
    }
    // Matching more of the query's words matters more than repeating one of them.
    if (matched) out.push({ item: doc.item, score: score * (0.5 + matched / wanted.length) });
  }
  return out.sort((x, y) => y.score - x.score);
}

/** A passage of the text around the first word that matches the query. */
export function excerpt(text: string, query: string, before = 200, after = 400): string {
  const wanted = new Set(terms(query));
  let at = 0;
  for (const match of text.toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)) {
    if (wanted.has(stem(match[0]))) {
      at = match.index;
      break;
    }
  }
  const start = Math.max(0, at - before);
  return `${start > 0 ? "…" : ""}${text.slice(start, at + after)}${at + after < text.length ? "…" : ""}`;
}

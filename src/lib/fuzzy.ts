/**
 * Subsequence fuzzy matching for the command palette. Higher is better; null
 * means the query is not a subsequence of the text at all.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const t = text.toLowerCase();
  if (t === q) return 1000;
  let score = 0;
  let ti = 0;
  let prevMatch = -2;
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi];
    const at = t.indexOf(ch, ti);
    if (at === -1) return null;
    score += 10;
    if (at === prevMatch + 1) score += 8; // consecutive
    if (at === 0) score += 12; // prefix
    else if (/[\s_./-]/.test(t[at - 1])) score += 6; // word start
    else if (t[at - 1] === t[at - 1].toLowerCase() && text[at] !== text[at].toLowerCase()) score += 4; // camelCase hump
    prevMatch = at;
    ti = at + 1;
  }
  // shorter texts and earlier matches rank higher
  score -= Math.min(20, Math.floor((t.length - q.length) / 4));
  if (t.startsWith(q)) score += 20;
  return score;
}

export function fuzzyFilter<T>(items: T[], query: string, getText: (item: T) => string | string[]): T[] {
  const q = query.trim();
  if (!q) return items;
  const scored: { item: T; score: number; index: number }[] = [];
  items.forEach((item, index) => {
    const texts = getText(item);
    const list = Array.isArray(texts) ? texts : [texts];
    let best: number | null = null;
    for (const [i, text] of list.entries()) {
      const s = fuzzyScore(q, text);
      if (s === null) continue;
      const adjusted = i === 0 ? s : s - 15; // secondary texts (column names) count a little less
      if (best === null || adjusted > best) best = adjusted;
    }
    if (best !== null) scored.push({ item, score: best, index });
  });
  return scored.sort((a, b) => b.score - a.score || a.index - b.index).map((x) => x.item);
}

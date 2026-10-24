import type { CatalogEntry } from '../../../../contracts/src/tables.ts';

/**
 * The command head of a line: the longest catalog entry whose words equal the line's leading words word by word
 * (exact match, no folding of case or spacing — the owner's rule of 10-24: only the catalog's real syntax counts).
 * Null when no entry heads it — the commands check refutes such a line on its own.
 */
export function commandHeadOf(line: string, catalogEntries: CatalogEntry[]): string | null {
  const words = line.split(' ').filter((word) => word !== '');
  if (words.length === 0) return null;
  let best: { head: string; length: number } | null = null;
  for (const entry of catalogEntries) {
    const entryWords = entry.words;
    if (entryWords.length === 0 || entryWords.length > words.length) continue;
    if (!entryWords.every((word, i) => word === words[i])) continue;
    if (best === null || entryWords.length > best.length) best = { head: entryWords.join(' '), length: entryWords.length };
  }
  return best?.head ?? null;
}

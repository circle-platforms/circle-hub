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

/** CommandIdentity path of the longest catalog head: the tree reference path, or `/commands/` plus the head words. */
export function commandPathOf(line: string, catalog: ReadonlyArray<{ words?: unknown; reference?: unknown }>): string | null {
  const words = line.split(' ').filter(word => word !== '');
  if (words.length === 0) return null;
  let best: { path: string; length: number } | null = null;
  for (const entry of catalog) {
    if (!Array.isArray(entry.words) || entry.words.length === 0 || entry.words.length > words.length) continue;
    if (!entry.words.every((word, index) => typeof word === 'string' && word === words[index])) continue;
    const reference = typeof entry.reference === 'string' ? entry.reference : '';
    const rooted = reference.startsWith('tree:') && /^[0-9a-f]{64}\//.test(reference.slice(5));
    const path = rooted ? reference.slice(69).split('@')[0] : '/commands/' + entry.words.join('/');
    if (!path.startsWith('/') || path.length > 512) continue;
    if (best === null || entry.words.length > best.length) best = { path, length: entry.words.length };
  }
  return best?.path ?? null;
}

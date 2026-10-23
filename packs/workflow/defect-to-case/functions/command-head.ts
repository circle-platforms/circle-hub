import type { CatalogEntry } from '../../../../contracts/src/tables.ts';
import { normalizeCommand, normalizeText } from './compact-index.ts';

/**
 * The command head of a line: the longest catalog entry whose words head the line's words (NFKC, case-insensitive,
 * whitespace collapsed). Null when no entry heads it — the commands check refutes such a line on its own.
 */
export function commandHeadOf(line: string, catalogEntries: CatalogEntry[]): string | null {
  const words = normalizeCommand(line).split(' ').filter(Boolean);
  if (words.length === 0) return null;
  let best: { head: string; length: number } | null = null;
  for (const entry of catalogEntries) {
    const entryWords = (entry.words ?? []).map((word) => normalizeText(word));
    if (entryWords.length === 0 || entryWords.length > words.length) continue;
    if (!entryWords.every((word, i) => word === words[i])) continue;
    if (best === null || entryWords.length > best.length) best = { head: normalizeCommand(entry.words.join(' ')), length: entryWords.length };
  }
  return best?.head ?? null;
}

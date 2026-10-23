// Version lines of the product's documents (product knowledge): the manual folders rel_apv_<line> and rel_nsae_<line> of the
// manual store, and spec, product and qa documents by the version tokens in their names or titles (APV 10.6.4, NSAE10.6.4,
// V10.6.4, 10_6_4). APV and NSAE are one product: an NSAE-named document belongs to the same line as the APV-named one.
// Lines compare as naming.ts lineKey does (10.7 and 10.7.0 are one line). The manual store's own read finds a line's folder
// by the numbers it ends in; these functions are the product's mapping for the later capabilities (case location, the
// knowledge of specs per version).
import { familyOf, lineKey } from './naming.ts';
import type { Family } from './types.ts';
import { guarded, isRecord } from './util.ts';

const FOLDER = /^rel_(apv|nsae)_([0-9]{1,3}(?:_[0-9]{1,3}){1,3})$/i;
/** A version token: an optional product name, an optional v/V, two or three numbers of at most two digits, not part of a longer number. */
const TOKEN = /(?<![0-9A-Za-z._])(?:(APV|NSAE)[\s_-]*)?[vV]?([0-9]{1,2}(?:[._][0-9]{1,2}){1,2})(?![0-9]|[._][0-9])/g;
const MAX_TEXT = 4096;

/** The line of a manual folder (rel_apv_10_6_4 and rel_nsae_10_6_4 are 10.6.4); null for any other name. */
export function folderLine(name: string): string | null {
  const match = typeof name === 'string' ? FOLDER.exec(name.trim()) : null;
  return match === null ? null : lineKey(match[2].replaceAll('_', '.'));
}

/** The manual folder names of a line under both names, APV first (10.7 gives rel_apv_10_7 and rel_apv_10_7_0, and the NSAE ones). */
export function folderNames(line: string): string[] {
  const key = lineKey(line);
  if (!/^[0-9]{1,3}(?:\.[0-9]{1,3}){1,3}$/.test(key)) return [];
  const spellings = key.split('.').length === 2 ? [key, `${key}.0`] : [key];
  return ['apv', 'nsae'].flatMap((family) => spellings.map((s) => `rel_${family}_${s.replaceAll('.', '_')}`));
}

export type DocumentLine = { line: string; family: Family | null; token: string };

/** The version lines a document name or title names, in order, once each; the family is the product name written with it. */
export function documentLines(text: string): DocumentLine[] {
  if (typeof text !== 'string') return [];
  const out: DocumentLine[] = [];
  const seen = new Set<string>();
  for (const match of text.slice(0, MAX_TEXT).normalize('NFKC').matchAll(TOKEN)) {
    const line = lineKey(match[2].replaceAll('_', '.'));
    if (seen.has(line)) continue;
    seen.add(line);
    out.push({ line, family: match[1] === undefined ? null : (familyOf(match[1]) as Family), token: match[0].trim() });
  }
  return out;
}

/** Pack function entry: `{ folder?, text? }` -> the folder's line and the lines the text names. */
export default function documents(input: unknown): { folder: string | null; lines: DocumentLine[]; warnings: string[] } {
  return guarded(
    () => {
      const record = isRecord(input) ? input : {};
      return { folder: typeof record.folder === 'string' ? folderLine(record.folder) : null, lines: typeof record.text === 'string' ? documentLines(record.text) : [], warnings: [] as string[] };
    },
    (warning) => ({ folder: null, lines: [], warnings: [warning] }),
  );
}

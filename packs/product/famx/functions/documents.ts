// Version lines of the product's documents (product knowledge): the manual folders rel_famx_<line> and rel_famy_<line> of the
// manual store, and spec, product and qa documents by the version tokens in their names or titles (FAMX 10.6.4, FAMY10.6.4,
// V10.6.4, 10_6_4). FAMX and FAMY are one product: an FAMY-named document belongs to the same line as the FAMX-named one.
// Lines compare as naming.ts lineKey does (10.7 and 10.7.0 are one line). The manual store's own read finds a line's folder
// by the numbers it ends in; these functions are the product's mapping for the later capabilities (case location, the
// knowledge of specs per version).
import { familyOf, lineKey } from './naming.ts';
import type { Family } from './types.ts';
import { guarded, isRecord } from './util.ts';

const FOLDER = /^rel_(famx|famy)_([0-9]{1,3}(?:_[0-9]{1,3}){1,3})$/i;
/** A version token: an optional product name, an optional v/V, two or three numbers of at most two digits, not part of a longer number. */
const TOKEN = /^(?:(FAMX|FAMY)[ _-])?[vV]?([0-9]{1,3}(?:[._][0-9]{1,3}){1,3})$/g;
const MAX_TEXT = 4096;

/** The line of a manual folder (rel_famx_10_6_4 and rel_famy_10_6_4 are 10.6.4); null for any other name. */
export function folderLine(name: string): string | null {
  const match = typeof name === 'string' ? FOLDER.exec(name.trim()) : null;
  return match === null ? null : lineKey(match[2].replaceAll('_', '.'));
}

/** The manual folder names of a line under both names, FAMX first (10.7 gives rel_famx_10_7 and rel_famx_10_7_0, and the FAMY ones). */
export function folderNames(line: string): string[] {
  const key = lineKey(line);
  if (!/^[0-9]{1,3}(?:\.[0-9]{1,3}){1,3}$/.test(key)) return [];
  const spellings = key.split('.').length === 2 ? [key, `${key}.0`] : [key];
  return ['famx', 'famy'].flatMap((family) => spellings.map((s) => `rel_${family}_${s.replaceAll('.', '_')}`));
}

export type DocumentLine = { line: string; family: Family | null; token: string };

/**
 * famx-documents@1 (declared for the owner's R6 rule, 2026-10-24): a version association comes from a document's own
 * name, never from prose. The declared name form is the file's base name without a `@<revision>` suffix and without a
 * text extension the store serves (`md`, `markdown`, `txt`, `adoc` — the formats this pack reads), and that whole
 * remainder must be the version form: an optional product name, a separator, an optional `v`, and two to four dotted
 * numbers. A title, a chapter path or any other text is not scanned.
 */
export function documentNameOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const at = base.lastIndexOf('@');
  const named = at > 0 ? base.slice(0, at) : base;
  return named.replace(/\.(?:md|markdown|txt|adoc)$/i, '');
}

/** The version lines a document name names, in order, once each; the family is the product name written with it. */
export function documentLines(text: string): DocumentLine[] {
  if (typeof text !== 'string') return [];
  const out: DocumentLine[] = [];
  const seen = new Set<string>();
  for (const match of text.slice(0, MAX_TEXT).matchAll(TOKEN)) {
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

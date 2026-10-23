// An engine cursor is only a candidate. Every emitted text@1 range is read back from supplied original lines.
// A candidate is decided in two passes: first the exact spellings (the source line as written, or that line with the
// structural marker of the context taken off), and only when nothing matches exactly, a folded comparison of the words
// (text.ts plainText: tags, character references, inline marks and the engine's typographic replacements folded away,
// the source line's attribute references expanded by the engine itself). The fold locates a line; it never becomes a
// citation or a statement. Among several candidates that all hold this exact text, the one at the engine's own cursor is
// the block's line; a citation is emitted only when one candidate is left, and it is the source line re-read verbatim.
import { sourceLines } from './input.ts';
import { plainConverted, plainText } from './text.ts';
import type { AdocInput, MappedLine, VerifiedRange } from './types.ts';

/** The contexts whose text the engine hands over converted (tags and character references); every other context keeps the
 * source spelling, so a `<name>` an author wrote stays text and is not folded away as a tag. */
const CONVERTED: ReadonlySet<string> = new Set(['list_item', 'table_cell', 'section', 'floating_title']);

export interface VerifyContext {
  /** The lines of every original file, when the caller already read them (text@1's own decoding). */
  originals?: Map<string, string[]>;
  /** The engine's attribute substitution, applied to a candidate source line before the folded comparison. */
  expand?: (text: string) => string;
}

const IDENTITY = (text: string): string => text;

export function ranges(rows: MappedLine[], input: AdocInput, originals?: Map<string, string[]>): VerifiedRange[] {
  const out: VerifiedRange[] = [];
  for (const row of rows) {
    const last = out.at(-1);
    if (last && last.file === row.file && last.to + 1 === row.line) {
      last.to = row.line; last.verbatim += '\n' + row.text;
    } else out.push({ file: row.file, from: row.line, to: row.line, selector: '', reference: '', verbatim: row.text });
  }
  for (const range of out) {
    range.selector = `l/${range.from === range.to ? range.from : `${range.from}-${range.to}`}`;
    const original = (originals?.get(range.file) ?? sourceLines(range.file, input.files[range.file].text).map((row) => row.text)).slice(range.from - 1, range.to);
    if (original.length !== range.to - range.from + 1 || original.join('\n') !== range.verbatim) return [];
    range.reference = `src:${input.files[range.file].sha256}/text@1/${range.selector}`;
  }
  return out;
}

const HEADING = /^={1,6}\s+/;
const ADMONITION = /^[A-Z][A-Z_0-9]*:\s+/;
const INLINE_CONDITION = /^\s*(?:ifdef|ifndef)::([^\[]*)\[(.*)\]\s*$/;
const DESCRIBED = /^(.+?)\s*(?::{2,4}|;;)\s*(.*)$/;
const BULLET = /^\s*(?:\*+|-|\+|\.+|[0-9]+[.)]|[a-z][.)])\s+/i;
const CELL = /(?<!\\)\|/;

/**
 * The spellings of one source line that can carry the text of a block of this context: the line itself and the line
 * with its structural markers taken off, one at a time (heading equals signs, list bullet, description-list separator,
 * admonition label, table cell separators, the wrapper of a single-line conditional branch — a bullet may carry such a
 * branch, so the markers are stripped in any order). Nothing is added that the line does not say.
 */
function variantsOf(kind: string, line: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue = [line];
  while (queue.length > 0) {
    const base = (queue.shift() as string).trim();
    if (base === '' || seen.has(base)) continue;
    seen.add(base);
    out.push(base);
    const inline = INLINE_CONDITION.exec(base);
    if (inline !== null) queue.push(inline[2] as string);
    if (kind === 'section' || kind === 'floating_title') queue.push(base.replace(HEADING, ''));
    if (kind === 'admonition') queue.push(base.replace(ADMONITION, ''));
    if (kind === 'list_item') {
      const item = base.replace(BULLET, '');
      queue.push(item);
      const described = DESCRIBED.exec(item);
      if (described !== null) queue.push(described[1] as string, described[2] as string);
    }
    if (kind === 'table_cell') for (const cell of base.split(CELL)) queue.push(cell.replace(/\\\|/g, '|'));
  }
  return out;
}

/** Whether one source line carries the block's text: exactly as written, or (folded) in the words both sides agree on. */
function lineMatches(kind: string, expected: string, source: string, expand: (text: string) => string, folded: boolean): boolean {
  if (!folded) {
    if (kind === 'section' || kind === 'floating_title') return HEADING.test(source) && source.replace(HEADING, '') === expected;
    if (kind === 'table_cell') return source.split(CELL).some((cell) => cell.trim() === expected);
    if (kind === 'list_item') return source.replace(/^\s*(?:\*+|[-.]|[0-9]+[.)]) +/, '') === expected;
    return source === expected;
  }
  const want = (CONVERTED.has(kind) ? plainConverted : plainText)(expected);
  if (want === '') return false;
  return variantsOf(kind, source).some((variant) => plainText(expand(variant)) === want);
}

export function verifyOrigin(
  raw: string,
  kind: string,
  reported: number | undefined,
  mapped: MappedLine[],
  visible: Set<number>,
  input: AdocInput,
  context: VerifyContext = {},
): { origins: VerifiedRange[]; flat: number | null; reason: string; chosenAmong: number } {
  if (raw === '' || !Number.isInteger(reported) || reported! < 1) return { origins: [], flat: null, reason: '引擎没有可逐字回核的内容或行号', chosenAmong: 0 };
  const expected = raw.split('\n');
  const { originals, expand = IDENTITY } = context;
  const candidatesAt = (folded: boolean): Array<{ rows: MappedLine[]; flat: number }> => {
    const found: Array<{ rows: MappedLine[]; flat: number }> = [];
    // Fixed, narrow recovery for the observed delimiter/conditional cursor offsets. No whole-document fuzzy search.
    for (let at = Math.max(0, reported! - 3); at <= Math.min(mapped.length - 1, reported! + 1); at++) {
      if (!visible.has(at)) continue;
      const rows: MappedLine[] = [];
      let cursor = at;
      for (const line of expected) {
        while (cursor < mapped.length && !visible.has(cursor)) cursor++;
        if (cursor >= mapped.length) break;
        const actual = mapped[cursor];
        if (!lineMatches(kind, line, actual.text, expand, folded)) break;
        rows.push(actual); cursor++;
      }
      if (rows.length === expected.length) found.push({ rows, flat: at + 1 });
    }
    return found;
  };
  let candidates = candidatesAt(false);
  let folded = false;
  if (candidates.length === 0) {
    candidates = candidatesAt(true);
    folded = true;
  }
  // The same text on several lines near the cursor (a repeated sentence, a repeated table cell): every candidate holds
  // this exact text, so the engine's own cursor decides which line the block came from, and the choice is disclosed in
  // the report. Nothing is forced onto a line that does not hold the text.
  const among = candidates.length;
  if (among > 1) {
    const atCursor = candidates.filter((candidate) => candidate.flat === reported);
    if (atCursor.length === 1) candidates = atCursor;
  }
  if (candidates.length !== 1) {
    return {
      origins: [],
      flat: null,
      chosenAmong: 0,
      reason: candidates.length > 0
        ? `候选行不唯一（${candidates.length} 行都有这段文字，引擎报告的第 ${reported} 行不在其中或不止一行相符），不能把相同文字硬归到某一行`
        : folded
          ? 'sourcemap 邻近行里没有原文与本块的文字相符（已按结构标记、属性展开、行内标记与宏、字符引用和排版替换归一后再找）'
          : 'sourcemap 附近没有逐字相符的原文',
    };
  }
  const chosen = candidates[0];
  const origins = ranges(chosen.rows, input, originals);
  return { origins, flat: origins.length ? chosen.flat : null, reason: origins.length ? '' : '候选映射与重新读取的原件行不符', chosenAmong: origins.length > 0 ? among : 0 };
}

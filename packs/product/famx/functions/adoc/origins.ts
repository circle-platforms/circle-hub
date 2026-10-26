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
/** The narrow marker rule the exact pass has always used; the folded pass uses BULLET and the other variants. */
const EXACT_BULLET = /^\s*(?:\*+|[-.]|[0-9]+[.)]) +/;
const CELL = /(?<!\\)\|/;
/** A single-line comment (`// …`), which the reader drops; a `////` block-comment delimiter is not one. */
const COMMENT_LINE = /^\s*\/\/(?!\/)/;

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
    if (kind === 'list_item') return source.replace(EXACT_BULLET, '') === expected;
    if (kind === 'admonition') return source.replace(ADMONITION, '') === expected;
    return source === expected;
  }
  const want = (CONVERTED.has(kind) ? plainConverted : plainText)(expected);
  if (want === '') return false;
  // The engine's attribute substitution is asked only of a line that carries a reference: expanding every candidate line
  // of every block costs more than the rest of the expansion together on a table-dense book.
  return variantsOf(kind, source).some((variant) => plainText(variant) === want || (variant.includes('{') && plainText(expand(variant)) === want));
}

/**
 * A line the engine's reader consumes without producing a block of its own, so a cursor may sit past it: a conditional
 * control, a block delimiter, a block attribute or title line, a heading, an attribute entry, an include line — and a
 * line a condition removed, which is not visible at all. A blank line is NOT one of them: it ends a paragraph, so a
 * cursor never sits past one, and a candidate on the other side of a blank line is another block's line.
 */
const SKIPPABLE: ReadonlyArray<RegExp> = [
  /^\s*(?:ifdef|ifndef|ifeval|endif)::/,
  /^\s*(?:\|={2,}|-{2,}|={2,}|_{2,}|\.{2,}|\+{2,}|\*{2,}|"{2,})\s*$/,
  /^\s*\[[^\]]*\]\s*$/,
  /^\s*\.[^\s.]/,
  /^\s*={1,6}\s+\S/,
  /^\s*:[^\s:][^:]*!?:/,
  /^\s*include::\S+\[.*\]\s*$/,
];

/** A line no block's text stands on: one a condition removed, one the reader consumes without producing a block, or a
 * blank one. The engine's cursor may sit on such a line and still belong to a block whose text starts elsewhere (a
 * listing's delimiter, the `endif` after a removed branch); it may not sit on another block's own text. */
function noTextLine(index: number, mapped: MappedLine[], visible: Set<number>): boolean {
  if (!visible.has(index)) return true;
  const line = mapped[index];
  // A cursor past the last mapped line reaches nothing: the line is unknown, so it is not one of these.
  if (line === undefined) return false;
  return line.text.trim() === '' || SKIPPABLE.some((pattern) => pattern.test(line.text));
}

/**
 * Whether the engine's cursor can belong to a block whose text starts at `at`. Two things must hold: the cursor's own
 * line is one no block's text stands on, and every line between the cursor and the candidate is one the reader consumes
 * without producing a block. Together they keep a neighbouring line that happens to hold the same words — the item
 * before a checkbox item, a paragraph above an admonition — from being cited for a block the engine put elsewhere: the
 * text being equal does not show which line the block came from.
 */
function reachableFrom(cursor: number, at: number, mapped: MappedLine[], visible: Set<number>): boolean {
  if (cursor === at) return true;
  if (!noTextLine(cursor, mapped, visible)) return false;
  for (let index = Math.min(cursor, at) + 1; index < Math.max(cursor, at); index++) {
    if (!visible.has(index)) continue;
    const line = mapped[index];
    if (line === undefined) return false;
    if (!SKIPPABLE.some((pattern) => pattern.test(line.text))) return false;
  }
  return true;
}

/** The visible lines a candidate may start on: the cursor's own line, three visible lines before it and two after. The
 * window is counted in visible lines, so a block whose cursor sits on the `endif` of a removed branch still reaches the
 * line it was read from. */
function windowStarts(cursor: number, mapped: MappedLine[], visible: Set<number>): number[] {
  const out: number[] = [];
  let seen = 0;
  for (let at = cursor; at >= 0 && seen < 4; at--) {
    if (!visible.has(at)) continue;
    out.push(at);
    seen++;
  }
  seen = 0;
  for (let at = cursor + 1; at < mapped.length && seen < 2; at++) {
    if (!visible.has(at)) continue;
    out.push(at);
    seen++;
  }
  return out;
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
  const cursor = reported! - 1;
  const starts = windowStarts(cursor, mapped, visible);
  const collectAt = (folded: boolean): Array<{ rows: MappedLine[]; flat: number }> => {
    const found: Array<{ rows: MappedLine[]; flat: number }> = [];
    for (const at of starts) {
      const rows: MappedLine[] = [];
      let walked = at;
      for (const line of expected) {
        while (walked < mapped.length && !visible.has(walked)) walked++;
        // A single-line comment is not content: the reader drops it, so a block's lines can sit on either side of one and
        // the block cites two ranges. A `////` block comment is not stepped over line by line, and a line that IS the
        // expected text — a comment line inside a verbatim listing — is never skipped.
        while (
          walked < mapped.length &&
          COMMENT_LINE.test(mapped[walked]!.text) &&
          !lineMatches(kind, line, mapped[walked]!.text, expand, folded)
        ) {
          walked++;
          while (walked < mapped.length && !visible.has(walked)) walked++;
        }
        if (walked >= mapped.length) break;
        const actual = mapped[walked];
        if (!lineMatches(kind, line, actual.text, expand, folded)) break;
        rows.push(actual); walked++;
      }
      if (rows.length === expected.length) found.push({ rows, flat: at + 1 });
    }
    return found;
  };
  // The exact pass decides on its own only when it found the engine's cursor's own line: that line holds this block's
  // text as written where the engine said the block is, and nothing stronger exists. Every other case collects both
  // passes before deciding, because a neighbouring line that literally holds the engine's words (an admonition label, an
  // expanded attribute, a marker) is an exact match for the wrong line, and had the exact pass alone decided, the folded
  // pass that finds the block's own line would never have run.
  const byFlat = new Map<number, { rows: MappedLine[]; flat: number }>();
  const exact = collectAt(false);
  for (const candidate of exact) byFlat.set(candidate.flat, candidate);
  const foldedOnly = exact.some((candidate) => candidate.flat === reported) ? [] : collectAt(true).filter((candidate) => !byFlat.has(candidate.flat));
  for (const candidate of foldedOnly) byFlat.set(candidate.flat, candidate);
  const matched = [...byFlat.values()].sort((a, b) => a.flat - b.flat);
  const admissible = matched.filter((candidate) => reachableFrom(cursor, candidate.flat - 1, mapped, visible));
  if (admissible.length === 0) {
    return {
      origins: [],
      flat: null,
      chosenAmong: 0,
      reason: matched.length > 0
        ? `有 ${matched.length} 行与这段文字相符，但都与引擎报告的第 ${reported} 行隔着正文行，不能确定是哪一行`
        : foldedOnly.length > 0 || byFlat.size > 0
          ? 'sourcemap 邻近行里没有原文与本块的文字相符'
          : 'sourcemap 邻近行里没有原文与本块的文字相符（已按结构标记、属性展开、行内标记与宏、字符引用和排版替换归一后再找）',
    };
  }
  // The same text on several admissible lines: the engine's own cursor decides. How many lines hold the text is
  // disclosed either way, so a reader sees that the words were not unique in the neighbourhood.
  const among = admissible.length;
  const matchedCount = byFlat.size;
  const chosen = among > 1 ? admissible.filter((candidate) => candidate.flat === reported!) : admissible;
  if (chosen.length !== 1) {
    return {
      origins: [],
      flat: null,
      chosenAmong: 0,
      reason: `候选行不唯一（${among} 行都有这段文字，引擎报告的第 ${reported} 行不在其中），不能把相同文字硬归到某一行`,
    };
  }
  const one = chosen[0]!;
  const origins = ranges(one.rows, input, originals);
  return { origins, flat: origins.length ? one.flat : null, reason: origins.length ? '' : '候选映射与重新读取的原件行不符', chosenAmong: origins.length > 0 ? matchedCount : 0 };
}

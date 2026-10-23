// The adoc-to-K1 mapping (task kb-adoc item 4): the expanded model becomes the markdown@1 shape — sections from the
// `=` levels of the source (a `[discrete]` heading is a block, not a section; `=======` lines are reported upstream
// and stay ordinary blocks), blocks with kind/section/text/path, and every block cites the text@1 line selector of
// its verified original range. K1's placement code (produceManualEntries) applies to the result unchanged.
//
// Nothing is placed that cannot be cited. A block whose text step one could not verify against a source line stays out
// of the model and is reported with its kind, file, line, reason and next action, because K1 counts a block without a
// selector as malformed and skips it: the content would disappear from the knowledge with only a count left behind.
// A block's citation is kept as the chapter file's digest and the plain text@1 line selector (Citation); the selector
// field K1 copies into its fragments is a key of this model, which entries.ts turns into the fragment the Hub verifies.
import type { Block, Composition, ExpandedModel, Section, VerifiedRange } from './types.ts';
import type { MarkdownBlock, MarkdownSection } from '../../../../../hub/refs/api.ts';
import { decodeReferences, inlineMarkdown, plainConverted, plainText, squeeze, stripMarks } from './text.ts';
import { selectorText, utf8Offsets } from '../util.ts';
import { parseAnchor } from '../manual.ts';

/**
 * One fragment of one chapter file: the file's digest and the text@1 line selector of the verified range, kept apart.
 * The Hub's FragmentRef holds them in separate fields (`source` and `selector`), and only that shape verifies.
 */
export interface Citation {
  file: string;
  sha256: string;
  /** text@1 selector of the verified range: `l/<n>` or `l/<a>-<b>`. */
  selector: string;
}

/**
 * The citation one fragment of the mapped model stands for: a block's own citation, the citation of one row of a table
 * block (K1 gives a row as a byte range inside the block's text), or a section's heading line. Null when the mapped
 * model has no citation for it, which the producer refuses instead of inventing a reference.
 */
export function citationFor(model: AdocModel, selector: string, range?: [number, number]): Citation | null {
  const key = CITE_KEY.exec(selector);
  if (key !== null) {
    const block = model.blocks[Number(key[1])];
    if (block === undefined) return null;
    if (range === undefined) return block.cite;
    const row = (block.rowCites ?? []).find((one) => one.range[0] === range[0] && one.range[1] === range[1]);
    return row === undefined ? null : row.cite;
  }
  if (selector.startsWith('h/')) {
    for (const section of model.sections) if (section.selector === selector) return section.cite;
  }
  return null;
}

/** One row of a mapped table: the byte range K1 computes inside the block's text, and the row's own citation. */
export interface RowCite {
  range: [number, number];
  cite: Citation;
}

/**
 * A block of the mapped model. K1 copies `selector` verbatim into the fragments of the entries it makes, and it never
 * reads a block selector, so the mapped model puts a citation key there (`cite/<index of the block>`) and keeps the real
 * text@1 selector and the file digest in `cite`; `entries.ts` turns the two into a FragmentRef the Hub verifies. A key
 * that never reaches that rewrite is not a reference either: verifyFragment refuses it, so nothing cites a chapter file
 * by accident.
 */
export interface AdocBlock extends MarkdownBlock {
  cite: Citation;
  rowCites?: RowCite[];
}

/** A section of the mapped model: `cite` is the heading's own verified source line, null when it has none. */
export interface AdocSection extends MarkdownSection {
  cite: Citation | null;
}

export interface AdocModel {
  charset: string;
  lines: number;
  sections: AdocSection[];
  blocks: AdocBlock[];
  nulRemoved: number;
}

/** The citation key K1 carries through to a fragment's `selector`, and its two directions. */
export const citeKey = (index: number): string => `cite/${index}`;
const CITE_KEY = /^cite\/([0-9]+)$/;

export const K1_KINDS: Readonly<Record<string, string>> = {
  paragraph: 'paragraph',
  section: 'heading',
  listing: 'code_block',
  literal: 'code_block',
  example: 'example_block',
  table: 'table',
  open: 'open_block',
  quote: 'quote_block',
  sidebar: 'sidebar',
  pass: 'pass_block',
  stem: 'stem_block',
  image: 'image',
  admonition: 'admonition',
  floating_title: 'discrete_heading',
  list_item: 'list_item',
};

const kindOf = (block: Block): string => K1_KINDS[block.kind] ?? block.kind;

/** The longest selector the Hub's reference grammar takes (`MAX_SELECTOR_LENGTH` in hub/refs/reference.ts; the pack
 * re-implements the reference codecs, because pack code may not import the Hub at run time). */
const MAX_SELECTOR_LENGTH = 4096;
const ENDS_IN_ORDINAL = /\[[0-9]+\]$/;

/**
 * The segment of one heading, spelled as markdown@1 spells it: `[k]` (from 1) is appended when the key repeats among its
 * siblings, when the key itself ends in `[digits]`, or when it is empty (`segmentFor` in hub/refs/parsers/markdown.ts).
 */
function segmentFor(key: string, ordinal: number): string {
  return ordinal > 1 || key === '' || ENDS_IN_ORDINAL.test(key) ? `${key}[${ordinal}]` : key;
}

/**
 * The kind K1 reads this block as. An example is reference only and takes no part in judgment (task item 6), so its own
 * content is never a paragraph — the one kind K1 reads anchors from — and never a table, which K1 would split into row
 * signatures; a listing inside an example stays code, which K1 never anchors either.
 */
function mappedKind(block: Block): string {
  const kind = kindOf(block);
  return block.example && kind !== 'code_block' ? 'example_block' : kind;
}

/** A group token of a signature line: `<name>`, `[weight]`, `{add|del}`. */
const GROUP = /^([<[{])[\s\S]*[>\]}]$/;
/** A word of a command head, spelled as K1's anchor grammar reads it. */
const WORD = /^[A-Za-z0-9?][A-Za-z0-9_.?:/+-]{0,63}$/;

/** Whether every group of a line is closed: `<name`, `name>` and `[a<b]` are no signature. */
function groupsBalanced(text: string): boolean {
  let depth = 0;
  for (const ch of text) {
    if (ch === '<' || ch === '[' || ch === '{') depth++;
    else if (ch === '>' || ch === ']' || ch === '}') depth--;
    if (depth < 0) return false;
  }
  return depth === 0;
}

/**
 * The spelling K1's anchor grammar reads for a signature line whose parts the source does not mark (a whole-line
 * monospace paragraph, a line of a signature block): the words before the first parameter group are the command head and
 * every group after it is a parameter. An alternative group (`{add|del}`) and an optional group that words follow
 * (`[no] demo pool add`) stay in the head, because K1 reads them as alternatives of the command itself, not as a
 * parameter. Null when the line has no head word, a head token is no command word, a group is not closed, or K1 would
 * not read the result as an anchor: such a line is not a signature and is reported instead of being emitted with marks
 * this mapping invented.
 */
/** One signature line read: the spelling K1 reads, or why the line is no signature. */
export type SignatureLine = { spelling: string; problem: null } | { spelling: null; problem: string };

export function readSignatureLine(plain: string): SignatureLine {
  const text = squeeze(plain);
  if (text === '' || /[\r\n]/.test(text)) return { spelling: null, problem: '这一行没有文字' };
  if (!groupsBalanced(text)) return { spelling: null, problem: '这一行的尖括号、方括号或花括号不配对' };
  const tokens = text.split(' ');
  const head: string[] = [];
  const params: string[] = [];
  for (let at = 0; at < tokens.length; at++) {
    const token = tokens[at] as string;
    if (GROUP.test(token) === false) {
      (params.length > 0 ? params : head).push(token);
      continue;
    }
    const followedByWord = tokens.slice(at + 1).some((later) => GROUP.test(later) === false);
    if (params.length === 0 && (token.includes('|') || (token.startsWith('[') && followedByWord))) head.push(token);
    else params.push(token);
  }
  if (head.length === 0) return { spelling: null, problem: '第一个参数组之前没有命令词' };
  if (head.some((token) => GROUP.test(token) === false && WORD.test(token) === false)) {
    return { spelling: null, problem: '命令词位置上有不是命令词的文字（例如中文说明或标点）' };
  }
  const spelling = `**${head.join(' ')}**${params.length > 0 ? ` *${params.join(' ')}*` : ''}`;
  return parseAnchor(spelling, null) === null ? { spelling: null, problem: '这一行按 K1 的锚点语法读不成命令签名' } : { spelling, problem: null };
}

export function signatureSpelling(plain: string): string | null {
  return readSignatureLine(plain).spelling;
}

/** One citation per source line of a block, from the block's own verified ranges; null when they do not line up. */
function lineCitations(block: Block, digestOf: (file: string) => string, count: number): Citation[] | null {
  const out: Citation[] = [];
  for (const origin of block.origins) {
    const lines = origin.verbatim.split('\n').length;
    for (let at = 0; at < lines; at++) out.push({ file: origin.file, sha256: digestOf(origin.file), selector: `l/${origin.from + at}` });
  }
  return out.length === count ? out : null;
}

/** A paragraph that is one monospace line: the engine's single code span, or the source's own `+…+` spelling of it. */
function monospaceLine(block: Block): string | null {
  const span = /^<code>([\s\S]*)<\/code>$/.exec(block.converted.trim());
  if (span !== null) return inlineMarkdown(span[1] as string);
  const marked = /^\+([\s\S]*)\+$/.exec(squeeze(block.expanded));
  return marked === null ? null : marked[1] as string;
}

/** One cell's text in the mapped table: the engine's own inline output in K1's spelling, kept on one row line. */
function cellText(cell: { raw: string }): string {
  return inlineMarkdown(cell.raw).replaceAll('|', '\\|').replaceAll('\n', ' ');
}

/** One row line of the mapped table text, in the `|`-pipe spelling K1's manual producer splits. */
function rowOf(cells: readonly string[]): string {
  return `| ${cells.join(' | ')} |`;
}

/**
 * The citation that covers a set of verified ranges: they must be of one file and leave no line between them, so the
 * cited range is exactly the lines that were read back. Null when there is nothing verified, or a gap.
 */
function mergedCitation(origins: readonly VerifiedRange[], digestOf: (file: string) => string): Citation | null {
  if (origins.length === 0) return null;
  const file = origins[0]!.file;
  if (origins.some((origin) => origin.file !== file)) return null;
  const sorted = [...origins].sort((a, b) => a.from - b.from);
  let next = sorted[0]!.from;
  for (const origin of sorted) {
    if (origin.from > next) return null;
    next = Math.max(next, origin.to + 1);
  }
  const from = sorted[0]!.from;
  const to = next - 1;
  return { file, sha256: digestOf(file), selector: from === to ? `l/${from}` : `l/${from}-${to}` };
}

/** The distinct verified ranges of one engine row's cells. */
function cellOrigins(row: ReadonlyArray<{ origins: VerifiedRange[] }>): VerifiedRange[] {
  const parts: VerifiedRange[] = [];
  for (const cell of row) {
    const origin = cell.origins[0];
    if (origin !== undefined && !parts.some((part) => part.file === origin.file && part.from === origin.from && part.to === origin.to)) parts.push(origin);
  }
  return parts;
}

/** One table of the mapped model: its text, the citation of every line K1 can cite, and what the engine's own row
 * model would not let stand (a row with no verified cell, a row whose cell count differs from the header's). */
interface Table {
  text: string;
  rowCites: RowCite[];
  dropped: number[];
  cite: Citation | null;
  misaligned: Array<{ row: number; cells: number; header: number }>;
}

/**
 * The mapped text of a table and the citation of every line K1 can cite: the engine's own rows, one line each, in the
 * order head, body and foot give them, with the head row as K1's header and the delimiter row K1's pipe-table reader
 * needs under it. Nothing is regrouped by line number, so a row the engine reads as one row stays one row, a cell that
 * spans source lines stays on its own row line, and a table the engine reads without a head row gets an empty header
 * line instead of a body row promoted into one. The delimiter and an empty header are produced lines and cite no row of
 * the source: the delimiter cites nothing, the empty header the table's own range. The byte ranges are computed exactly
 * as K1 computes them over this text, so the range in a fragment K1 makes finds the row it names.
 */
function tableOf(block: Block, digestOf: (file: string) => string): Table {
  const none: Table = { text: '', rowCites: [], dropped: [], cite: null, misaligned: [] };
  if (block.rows === undefined) return { ...none, text: block.expanded, cite: mergedCitation(block.origins, digestOf) };
  const verified: VerifiedRange[] = [];
  const rows = [...block.rows.head, ...block.rows.body, ...block.rows.foot].map((row, index) => {
    const origins = cellOrigins(row);
    for (const origin of origins) if (!verified.includes(origin)) verified.push(origin);
    return { index, cells: row.map(cellText), cite: mergedCitation(origins, digestOf) };
  });
  const cite = mergedCitation(verified, digestOf);
  const dropped = rows.filter((row) => row.cite === null).map((row) => row.index);
  const header = block.rows.head.length > 0 ? rows[0]! : null;
  const cited = header !== null && header.cite !== null;
  const body = (header === null ? rows : rows.slice(1)).filter((row) => row.cite !== null);
  if (!cited && body.length === 0) return { ...none, dropped };
  const cells = cited ? header!.cells.length : body[0]!.cells.length;
  const headerLine = cited ? rowOf(header!.cells) : rowOf(Array.from({ length: cells }, () => ''));
  const headerCite = cited ? header!.cite : cite;
  if (headerCite === null) return { ...none, dropped };
  const lines = [headerLine, rowOf(Array.from({ length: cells }, () => '---')), ...body.map((row) => rowOf(row.cells))];
  const cites: Array<Citation | null> = [headerCite, null, ...body.map((row) => row.cite)];
  const text = lines.join('\n');
  // The byte ranges of the lines of this text, as K1's lineRanges computes them: [start of the line, offset of its
  // line break or of the end of the text].
  const offsets = utf8Offsets(text);
  const rowCites: RowCite[] = [];
  let start = 0;
  let line = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || text.charCodeAt(i) === 0x0a) {
      const one = cites[line];
      if (one !== null && one !== undefined) rowCites.push({ range: [offsets[start], offsets[i]], cite: one });
      start = i + 1;
      line++;
    }
  }
  // A table the engine reads with rows of unequal cell count is mapped as the engine reports it and reported: the row
  // structure is the engine's, never a repair of the source. A row that carries no citation is reported too, so the
  // shape the engine gave is disclosed even when part of it stays out of the mapped text.
  const misaligned: Array<{ row: number; cells: number; header: number }> = [];
  const reference = cited ? header : body[0]!;
  for (const row of rows) if (row !== reference && row.cells.length !== cells) misaligned.push({ row: row.index, cells: row.cells.length, header: cells });
  return { text, rowCites, dropped, cite, misaligned };
}

/**
 * The text this block carries into the mapped model; '' for a container whose children carry its content. A statement
 * carries what the source says under this family's attribute set (K02 R[4] lets it differ from the source line, and the
 * fragment stays on the verified range): the engine substitutes nothing inside a listing or literal block, so those stay
 * verbatim, while every other block gives the attribute-expanded text in the reader's inline spelling.
 */
function textOf(block: Block): string {
  // A list item's own text is already the engine's converted text; a listing or literal block is verbatim (the engine
  // substitutes nothing inside it), so it stays as written; every other block gives the engine's inline output of its
  // own source line, or the attribute-expanded source text where the engine keeps no conversion.
  if (block.kind === 'list_item') return inlineMarkdown(block.raw).trim();
  if (block.kind === 'listing' || block.kind === 'literal') return block.raw;
  if (block.kind === 'paragraph') {
    // A whole-line monospace paragraph is a signature line the author marked as such (task item 6): the engine's code
    // span, or the source's `+…+` spelling, which the engine renders as plain text. A line that reads as no signature
    // stays the code span it is.
    const monospace = monospaceLine(block);
    if (monospace !== null) {
      const signature = signatureSpelling(monospace);
      if (signature !== null) return signature;
    }
  }
  return inlineMarkdown(block.converted !== '' ? block.converted : block.expanded);
}

/**
 * A description-list entry: the term item and the value item of one source line, used only when the two items really
 * are that line (their words and the line's words agree), so `name:: 成员名称` becomes one statement instead of a
 * statement "name" and a statement "成员名称" that both cite the same line.
 */
function describedEntry(term: Block, value: Block | undefined): { text: string; origin: VerifiedRange } | null {
  if (value === undefined || value.kind !== 'list_item' || value.listAt !== term.listAt) return null;
  const origin = term.origins.length === 1 ? term.origins[0]! : null;
  const other = value.origins.length === 1 ? value.origins[0]! : null;
  if (origin === null || other === null || origin.file !== other.file || origin.from !== other.from || origin.to !== other.to) return null;
  if (plainText(origin.verbatim) !== plainConverted(`${term.raw}:: ${value.raw}`)) return null;
  return { text: `${inlineMarkdown(term.raw)}:: ${inlineMarkdown(value.raw)}`, origin };
}

export interface Uncited {
  kind: string;
  file: string | null;
  line: number | null;
  reason: string;
  next_action: string;
}

/** What one mapping of the expanded model gives: the K1 model, the report lines of the production, and the blocks that
 * could not be cited and therefore are not in the model (never a block without a citation: K1 counts one as malformed
 * and skips it, so the content would vanish with only a count left behind). */
/** A line the author declared a signature that reads as none: kept as ordinary text, reported, never given marks. */
export interface UnparsedSignature {
  file: string | null;
  line: number | null;
  text: string;
  reason: string;
  next_action: string;
}

export interface Mapped {
  model: AdocModel;
  warnings: string[];
  uncited: Uncited[];
  unparsed: UnparsedSignature[];
}

/**
 * One K1 model of the expanded adoc. `manualName` names the manual of every fragment reference (the K1 producer
 * composes `/manual/<name>/<章节路径>` from it); the composition ties the model to its inputs.
 */
export function toK1Model(model: ExpandedModel, composition: Composition, manualName: string): Mapped {
  const sections: AdocSection[] = [{ level: 0, title: '', key: '', ordinal: 1, parent: null, children: [], blocks: [], line: 0, end: 0, selector: null, attributes: null, cite: null }];
  const blocks: AdocBlock[] = [];
  // A section is keyed by the node the engine gave for it (the index of its own block), never by its title text: two
  // sections with the same title are two sections, and `IPv4/IPv6` is not the parent of `IPv4` and `IPv6`.
  const headings = new Map<number, Block>();
  model.blocks.forEach((block, at) => {
    if (block.kind === 'section') headings.set(at, block);
  });
  const digestOf = (file: string): string => composition.files.find((one) => one.file === file)?.sha256 ?? '';
  const citationOf = (origin: VerifiedRange): Citation => ({ file: origin.file, sha256: digestOf(origin.file), selector: origin.selector });
  const byNode = new Map<number, number>();
  // The encoded and the decoded heading path of every section, built once from the parent's, and the sibling keys that
  // decide an ordinal — the three markdown@1 keeps for the same rule.
  const encodedPaths: Array<string | null> = [''];
  const decodedPaths: Array<string[] | null> = [[]];
  const childKeys: Array<Map<string, number>> = [new Map()];
  const unverifiedHeadings: string[] = [];
  const sectionOf = (path: Block['path']): number => {
    if (path.length === 0) return 0;
    const last = path[path.length - 1] as Section;
    const known = byNode.get(last.at);
    if (known !== undefined) return known;
    const parent = sectionOf(path.slice(0, -1));
    const block = headings.get(last.at) ?? null;
    // The segment comes from the heading's own source line — the author's words, with the attribute references of this
    // family expanded and the inline marks off — never from the engine's converted title, which carries tags and
    // character references into the path. A title with no marks can also never be read as a signature (task item 6).
    const fromSource = block !== null && block.heading !== null;
    const title = squeeze(stripMarks(decodeReferences(fromSource ? (block as Block).heading as string : inlineMarkdown(last.title))));
    if (!fromSource) {
      unverifiedHeadings.push(`${block === null ? `章节「${title}」` : `${placeOf(model, block)} 的标题「${title}」`}回核不到源行，段用引擎标题的纯文本形式`);
    }
    const key = title;
    const siblings = childKeys[parent] as Map<string, number>;
    const ordinal = (siblings.get(key) ?? 0) + 1;
    siblings.set(key, ordinal);
    const segment = segmentFor(key, ordinal);
    const encodedSegment = selectorText([segment]);
    const above = encodedPaths[parent] as string | null;
    const length = above === null || encodedSegment === null ? Number.POSITIVE_INFINITY : 2 + (above === '' ? 0 : above.length + 1) + encodedSegment.length;
    const encoded = above === null || encodedSegment === null || length > MAX_SELECTOR_LENGTH ? null : above === '' ? encodedSegment : `${above}/${encodedSegment}`;
    const at = sections.length;
    const origin = block?.origins[0] ?? null;
    encodedPaths.push(encoded);
    decodedPaths.push(encoded === null ? null : [...(decodedPaths[parent] as string[]), segment]);
    childKeys.push(new Map());
    sections.push({
      level: path.length,
      title,
      key,
      ordinal,
      parent,
      children: [],
      blocks: [],
      line: 0,
      end: 0,
      selector: encoded === null ? null : `h/${encoded}`,
      attributes: null,
      cite: origin === null ? null : citationOf(origin),
    });
    (sections[parent] as AdocSection).children.push(at);
    byNode.set(last.at, at);
    return at;
  };
  /** The decoded heading path of a section: what a block's `path` carries, spelled as its `h/` selector is. */
  const pathOf = (section: number): string[] | null => decodedPaths[section] ?? null;
  /** One mapped block: the citation key K1 carries into its fragments, and the citation the key stands for. */
  const emit = (block: Block, kind: string, text: string, cite: Citation, rowCites?: RowCite[]): void => {
    const section = sectionOf(block.path);
    const index = sections[section]!.blocks.length;
    const [from, to] = linesOf(cite.selector);
    sections[section]!.blocks.push(blocks.length);
    blocks.push({
      kind,
      section,
      index,
      line: from - 1,
      lines: to - from + 1,
      text,
      selector: citeKey(blocks.length),
      path: pathOf(section),
      cite,
      ...(rowCites === undefined ? {} : { rowCites }),
    });
  };
  const uncited: Uncited[] = [];
  const unparsed: UnparsedSignature[] = [];
  const misaligned: string[] = [];
  for (let at = 0; at < model.blocks.length; at++) {
    const block = model.blocks[at]!;
    if (block.kind === 'section') continue;
    if (block.kind === 'listing' && block.role === 'signature' && !block.example) {
      // The explicit signature structure: every line is read on its own, by the explicit rule, and cited on its own
      // source line. A blank line carries nothing. A line the rule does not read stays the ordinary text it is and is
      // reported with its file, line and reason: no line is emitted with bold marks this mapping invented.
      const lines = block.raw.split('\n');
      const cites = lineCitations(block, digestOf, lines.length);
      if (cites === null) {
        uncited.push(uncitedOf(model, block, block.origins.length === 0 ? '' : 'signature 块的行与已核对的原文行对不上，不能逐行发引用'));
        continue;
      }
      const expanded = block.expanded.split('\n');
      for (let index = 0; index < lines.length; index++) {
        const source = expanded[index] ?? (lines[index] as string);
        if (squeeze(source) === '') continue;
        const read = readSignatureLine(stripMarks(source));
        const cite = cites[index] as Citation;
        if (read.spelling !== null) {
          emit(block, 'paragraph', read.spelling, cite);
          continue;
        }
        const [line] = linesOf(cite.selector);
        unparsed.push({
          file: cite.file,
          line,
          text: source,
          reason: read.problem,
          next_action: '签名行应写成命令词后跟参数组（<必选>、[可选] 或 {a|b}）；核对这一行的括号与命令词，修好源后按同一修订号重跑',
        });
        emit(block, 'paragraph', source, cite);
      }
      continue;
    }
    const table = block.rows === undefined ? null : tableOf(block, digestOf);
    const text = table === null ? textOf(block) : table.text;
    // A container with no text of its own (a list, an example, an open or sidebar block) is not mapped: the engine gives
    // a block for each of its children, and each of those carries and cites its own text.
    if (text === '' && table === null) continue;
    if (block.kind === 'list_item' && block.listAt !== null && model.blocks[block.listAt]?.kind === 'dlist') {
      const entry = describedEntry(block, model.blocks[at + 1]);
      if (entry !== null) {
        emit(block, mappedKind(block), entry.text, citationOf(entry.origin));
        at++;
        continue;
      }
    }
    const cite = table === null ? (block.origins.length > 0 ? citationOf(block.origins[0]!) : null) : table.cite;
    if (cite === null) {
      uncited.push(uncitedOf(model, block, table === null ? '' : '表格的单元格都回核不到原文行'));
      continue;
    }
    for (const row of table?.dropped ?? []) {
      uncited.push(uncitedOf(model, block, `表格的第 ${row + 1} 行（按引擎的行模型数）没有已核对的单元格，这一行没有进映射，也没有借用别的行的来源行`));
    }
    for (const row of table?.misaligned ?? []) {
      misaligned.push(`${placeOf(model, block)} 的表格第 ${row.row + 1} 行（按引擎的行模型数）有 ${row.cells} 格，表头有 ${row.header} 格`);
    }
    emit(block, mappedKind(block), text, cite, table === null ? undefined : table.rowCites);
  }
  const warnings: string[] = [];
  if (misaligned.length > 0) {
    warnings.push(
      `有 ${misaligned.length} 个表格行的格数与表头不一致，按引擎给出的行原样映射，没有重组也没有补格：${misaligned.slice(0, 5).join('；')}${misaligned.length > 5 ? ' 等' : ''}。` +
        '下一步：核对这些表格的列定义和竖线（行末多一个竖线会让引擎多读一格），修好源后按同一修订号重跑。',
    );
  }
  if (unverifiedHeadings.length > 0) {
    warnings.push(
      `有 ${unverifiedHeadings.length} 个章节标题回核不到源行：${unverifiedHeadings.slice(0, 5).join('；')}${unverifiedHeadings.length > 5 ? ' 等' : ''}。` +
        '下一步：核对这些标题行（定位器已在邻近行做过归一比较），修好源或定位器后按同一修订号重跑。',
    );
  }
  if (unparsed.length > 0) {
    const shown = unparsed.slice(0, 5).map((one) => `${one.file ?? '展开文本'}${one.line === null ? '' : `:${one.line}`}`).join('、');
    warnings.push(
      `有 ${unparsed.length} 行声明为签名的文字读不成命令签名，按原文当作普通文字挂在所在章节，没有补加粗记号：${shown}${unparsed.length > 5 ? ' 等' : ''}。` +
        `原因是 ${[...new Set(unparsed.map((one) => one.reason))].join('；')}。${unparsed[0]!.next_action}。`,
    );
  }
  if (uncited.length > 0) {
    const shown = uncited.slice(0, 5).map((one) => `${one.kind} ${one.file ?? '展开文本'}${one.line === null ? '' : `:${one.line}`}`).join('、');
    warnings.push(
      `有 ${uncited.length} 个块或表格行回核不到原文行，没有交给落点代码（不给它们发引用，也不让它们被当成“格式不对”悄悄丢掉）：${shown}${uncited.length > 5 ? ' 等' : ''}。` +
        '下一步：按这些文件和行号核对源行，修好源或定位器后按同一修订号重跑；在那之前这些文字没有进知识。',
    );
  }
  void manualName;
  return { model: { charset: 'utf-8', lines: model.line_map.length, sections, blocks, nulRemoved: 0 }, warnings, uncited, unparsed };
}

/** The first and last line of a text@1 line selector. */
function linesOf(selector: string): [number, number] {
  const body = selector.replace(/^l\//, '');
  const dash = body.indexOf('-');
  const from = Number(dash < 0 ? body : body.slice(0, dash));
  const to = Number(dash < 0 ? body : body.slice(dash + 1));
  return [Number.isFinite(from) ? from : 1, Number.isFinite(to) ? to : from];
}

/** Where the engine put a block: the file and line of its own report, or the line of the expanded text. */
function placeOf(model: ExpandedModel, block: Block): string {
  const line = block.reportedLine;
  if (line === null) return '行号不明的块';
  const file = line >= 1 && line <= model.line_map.length ? model.line_map[line - 1]!.file : null;
  return file === null ? `展开文本第 ${line} 行` : `${file}:${line}`;
}

/** A block or row the mapping does not place: what the engine reported for it, where, and why no citation exists. */
function uncitedOf(model: ExpandedModel, block: Block, reason: string): Uncited {
  const line = block.reportedLine;
  const file = line !== null && line >= 1 && line <= model.line_map.length ? model.line_map[line - 1]!.file : null;
  return {
    kind: block.kind,
    file,
    line,
    reason: reason === '' ? (block.unverifiedReason === '' ? '没有已核对的原文行' : block.unverifiedReason) : reason,
    next_action: '按文件和行号核对源行（定位器已在 sourcemap 邻近行做过逐字比较，含结构标记、属性展开、行内标记、字符引用和排版替换的归一）；修好源或定位器后按同一修订号重跑',
  };
}

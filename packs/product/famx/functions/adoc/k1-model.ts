import {signatureOf} from './structure.ts';
import type {InlineNode} from './inline.ts';
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
import { decodeReferences, dropPairedMarks, inlineMarkdown, plainConverted, plainText, squeeze } from './text.ts';
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

/** Whether a fragment of the mapped model cites example content (a block that is an example or sits inside one). */
export function citesExample(model: AdocModel, selector: string): boolean {
  const key = CITE_KEY.exec(selector);
  return key !== null && model.blocks[Number(key[1])]?.example === true;
}

/** One row of a mapped table: the byte range K1 computes inside the block's text, and the row's own citation. */
export interface RowCite {
  authored?:boolean;
  inline?:InlineNode[];
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
  inline?:InlineNode[];
  structuralSignature?:ReturnType<typeof signatureOf>;
  sourceGroup?:number;
  paragraphCites?:Citation[];
  rowCites?: RowCite[];
  /** True for example content: reference only, so the producer marks the entries it warrants (task item 6). */
  example: boolean;
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

/**
 * The kind of one part of a paragraph that was split by its source ranges. K1 places it like any other text block (at its
 * section node, or under the command before it, with the prose literals read from it) and reads no anchor from it, because
 * an anchor is a block the author wrote as a standalone signature line — a source boundary (an include, a conditional, a
 * comment line) is not a semantic one.
 */
const PARAGRAPH_PART = 'paragraph_part';

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

/** Whether every group of a line is closed: `<name`, `name>` and `[a<b]` are no signature. */
function groupsBalanced(text: string): boolean {
  const stack:string[]=[];
  const pairs:Record<string,string>={'<':'>','[':']','{':'}'};
  for(const ch of text){if(Object.hasOwn(pairs,ch))stack.push(pairs[ch]);else if(ch==='>'||ch===']'||ch==='}'){if(stack.pop()!==ch)return false;}}
  return stack.length===0;
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

// Compatibility formatter only; adoc production never calls this helper to admit a definition.
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
  // This maps declared signature syntax only; word appearance does not establish command identity.
  // The manual producer subsequently verifies every head and parameter position against its locked tree.
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

/** One cell's text in the mapped table: the engine's own inline output in K1's spelling, kept on one row line. */
function cellText(cell: { raw: string }): string {
  return inlineMarkdown(cell.raw).replaceAll('|', '\\|').replaceAll('\n', ' ');
}

/** One row line of the mapped table text, in the `|`-pipe spelling K1's manual producer splits. */
function rowOf(cells: readonly string[]): string {
  return `| ${cells.join(' | ')} |`;
}

/**
 * The citation that covers a set of verified ranges: they must be of one file, and every line between them must be one
 * `bridge` accepts (a line that re-reads as blank), so the cited range holds the verified lines and nothing that says
 * something else. Null when there is nothing verified, or a line between that cannot be bridged.
 */
function mergedCitation(origins: readonly VerifiedRange[], digestOf: (file: string) => string, bridge?: (file: string, line: number) => boolean): Citation | null {
  if (origins.length === 0) return null;
  const file = origins[0]!.file;
  if (origins.some((origin) => origin.file !== file)) return null;
  const sorted = [...origins].sort((a, b) => a.from - b.from);
  let next = sorted[0]!.from;
  for (const origin of sorted) {
    if (origin.from > next) {
      if (bridge === undefined) return null;
      for (let line = next; line < origin.from; line++) if (!bridge(file, line)) return null;
    }
    next = Math.max(next, origin.to + 1);
  }
  const from = sorted[0]!.from;
  const to = next - 1;
  return { file, sha256: digestOf(file), selector: from === to ? `l/${from}` : `l/${from}-${to}` };
}

/** A cell that holds words and cites no line: the row's text carries them, so the row cannot cite only its other cells. */
const missingCell = (row: ReadonlyArray<{ raw: string; origins: VerifiedRange[] }>): boolean =>
  row.some((cell) => cell.raw.trim() !== '' && cell.origins.length === 0);

/** Why one engine row cites nothing. */
function rowReason(row: ReadonlyArray<{ raw: string; origins: VerifiedRange[] }>): string {
  if (cellOrigins(row).length === 0) return '没有已核对的单元格';
  if (missingCell(row)) return '有单元格回核不到原文行，不能只按另一部分单元格给整行发引用';
  return '自己的单元格之间隔着不是空行的行，给不出这一行的来源范围';
}

/** Where the engine put a line of the expanded text: the chapter file and that file's own line number. */
function placeOfLine(model: ExpandedModel, expandedLine: number | null): { file: string | null; line: number | null; place: string } {
  if (expandedLine === null || expandedLine < 1 || expandedLine > model.line_map.length) return { file: null, line: null, place: '行号不明' };
  const row = model.line_map[expandedLine - 1]!;
  return { file: row.file, line: row.line, place: `${row.file}:${row.line}` };
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
  dropped: Array<{ index: number; reason: string; line: number | null }>;
  cite: Citation | null;
  /** Why the table as a whole cites nothing, when it does not; '' when it cites. */
  reason: string;
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
function tableOf(block: Block, digestOf: (file: string) => string, blank: (file: string, line: number) => boolean): Table {
  const none = (reason: string): Table => ({ text: '', rowCites: [], dropped: [], cite: null, reason, misaligned: [] });
  if (block.rows === undefined) return { ...none(''), text: block.expanded, cite: mergedCitation(block.origins, digestOf, blank) };
  const verified: VerifiedRange[] = [];
  const engineRows = [...block.rows.head, ...block.rows.body, ...block.rows.foot];
  const rows = engineRows.map((row, index) => {
    const origins = cellOrigins(row);
    for (const origin of origins) if (!verified.includes(origin)) verified.push(origin);
    // A row whose text holds a cell that cites no line is not cited at all: its own cells' lines do not contain that
    // cell's words, so citing them would cite a line that does not hold what the entry says.
    // The line the report names: the cell that cites nothing when there is one, else the row's first cell.
    const offending = row.find((cell) => cell.raw.trim() !== '' && cell.origins.length === 0) ?? row.find((cell) => cell.reportedLine !== null);
    return { index, inline:row.flatMap(cell=>cell.inline??[]),cells: row.map(cellText), cite: missingCell(row) ? null : mergedCitation(origins, digestOf, blank), firstLine: offending?.reportedLine ?? null };
  });
  const dropped = rows.filter((row) => row.cite === null).map((row) => ({ index: row.index, reason: rowReason(engineRows[row.index]!), line: row.firstLine }));
  const header = block.rows.head.length > 0 ? rows[0]! : null;
  const cited = header !== null && header.cite !== null;
  const body = (header === null ? rows : rows.slice(1)).filter((row) => row.cite !== null);
  // The table stands on its cited rows, not on one gap-free range over all of them: a blank line between two rows (or
  // between two cells of a row written one cell per line) costs nothing. Only when no row is cited at all is the table
  // itself uncited, and the reason says which of the two it is.
  const merged = mergedCitation(verified, digestOf, blank);
  const first = cited ? header! : body[0] ?? null;
  const cite = merged ?? first?.cite ?? null;
  if (!cited && body.length === 0) {
    return { ...none(verified.length === 0 ? '表格的单元格都回核不到原文行' : '表格有已核对的单元格，但没有一行能给出自己的来源范围'), dropped };
  }
  const cells = cited ? header!.cells.length : body[0]!.cells.length;
  const headerLine = cited ? rowOf(header!.cells) : rowOf(Array.from({ length: cells }, () => ''));
  const headerCite = cited ? header!.cite : cite;
  if (headerCite === null) return { ...none('表格给不出表头行的来源范围'), dropped };
  const lines = [headerLine, rowOf(Array.from({ length: cells }, () => '---')), ...body.map((row) => rowOf(row.cells))];
  const cites: Array<Citation | null> = [headerCite, null, ...body.map((row) => row.cite)];
  const inlineRows=[cited?header!.inline:[],[],...body.map(row=>row.inline)];
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
      if (one !== null && one !== undefined) rowCites.push({ range: [offsets[start], offsets[i]], cite: one,inline:inlineRows[line],authored:line!==0||cited });
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
  return { text, rowCites, dropped, cite, reason: '', misaligned };
}

/**
 * The parts of one block whose verified ranges are not contiguous (a conditional inside it, an include boundary, a line
 * the reader dropped): one part per range, with its own lines and its own citation, so no fragment cites a range that
 * holds only part of what the statement says. The text's lines map one to one onto the ranges' lines; null when they do
 * not, and the block is then reported instead of being cited on its first range alone.
 */
function splitByOrigins(block: Block, text: string, digestOf: (file: string) => string): Array<{ text: string; cite: Citation }> | null {
  const lines = text.split('\n');
  const counts = block.origins.map((origin) => origin.to - origin.from + 1);
  if (counts.reduce((sum, count) => sum + count, 0) !== lines.length) return null;
  const out: Array<{ text: string; cite: Citation }> = [];
  let at = 0;
  block.origins.forEach((origin, index) => {
    const size = counts[index] as number;
    const part = lines.slice(at, at + size).join('\n');
    at += size;
    // A part that holds no words (a range of blank lines) makes no entry of its own.
    if (squeeze(part) === '') return;
    out.push({ text: part, cite: { file: origin.file, sha256: digestOf(origin.file), selector: origin.selector } });
  });
  return out;
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
  /** The chapter file, and that file's own line number — what a reader opens. */
  file: string | null;
  line: number | null;
  /** The same block's line in the expanded text (the engine's own number), kept apart for the line map and step one's report. */
  expanded_line: number | null;
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
  const sourceGroups=new Map(model.blocks.map((block,index)=>[block,index]));
  const emitted=new Set<Block>();
  // A section is keyed by the node the engine gave for it (the index of its own block), never by its title text: two
  // sections with the same title are two sections, and `IPv4/IPv6` is not the parent of `IPv4` and `IPv6`.
  const headings = new Map<number, Block>();
  model.blocks.forEach((block, at) => {
    if (block.kind === 'section') headings.set(at, block);
  });
  const digestOf = (file: string): string => composition.files.find((one) => one.file === file)?.sha256 ?? '';
  // Whether an original line re-reads as blank, from the expanded text and its line map. Built on first use: only a table
  // whose verified cells are separated by other lines needs it, and a range is bridged only over lines that hold
  // nothing, so the cited range never swallows a line that says something the entry does not.
  let originalLines: Map<string, string> | null = null;
  const blankLine = (file: string, line: number): boolean => {
    if (originalLines === null) {
      originalLines = new Map();
      const lines = model.expanded_text.split('\n');
      model.line_map.forEach((row, index) => originalLines?.set(`${row.file}\u0000${row.line}`, lines[index] ?? ''));
    }
    const text = originalLines.get(`${file}\u0000${line}`);
    return text !== undefined && text.trim() === '';
  };
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
    // family expanded — never from the engine's converted title, which carries tags and character references into the
    // path. Only the paired marks at token edges go, so `health_check`, `C++` and `步骤 #1` keep every character they were
    // written with; a title whose marks are gone can also never be read as a signature (task item 6).
    const fromSource = block !== null && block.heading !== null;
    const title = squeeze(dropPairedMarks(decodeReferences(fromSource ? (block as Block).heading as string : inlineMarkdown(last.title))));
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
    const first=!emitted.has(block);emitted.add(block);
    blocks.push({
      kind,sourceGroup:sourceGroups.get(block),
      inline:first?block.inline:[],structuralSignature:!first||block.example?null:signatureOf(block),
      ...(first&&block.origins.length>1?{paragraphCites:block.origins.map(citationOf)}:{}),
      section,
      index,
      line: from - 1,
      lines: to - from + 1,
      text,
      selector: citeKey(blocks.length),
      path: pathOf(section),
      cite,
      example: block.example,
      ...(rowCites === undefined ? {} : { rowCites }),
    });
  };
  // Every section of the expanded model exists before any block is placed, in document order, so an empty section or one
  // whose content is all uncited still takes its ordinal among its siblings (markdown@1 numbers every heading, empty or
  // not) and a later sibling never inherits an earlier sibling's path. The document title (level 0) is not a chapter: the
  // manual's name comes from the producer, and the engine puts the `==` sections beside it, not under it.
  for (const block of model.blocks) if (block.kind === 'section' && block.level >= 1) sectionOf(block.path);
  const uncited: Uncited[] = [];
  const unparsed: UnparsedSignature[] = [];
  const misaligned: string[] = [];
  for (let at = 0; at < model.blocks.length; at++) {
    const block = model.blocks[at]!;
    if (block.kind === 'section') continue;
    if (block.kind === 'listing' && block.role === 'signature' && !block.example) {
      // A listing is verbatim source, even with a legacy signature role. Only engine paragraph/inline
      // structure admits definitions. Preserve each source line and citation without synthesizing marks.
      const lines=block.raw.split('\n'),cites=lineCitations(block,digestOf,lines.length);
      if(cites===null){uncited.push(uncitedOf(model,block,block.unverifiedReason||'listing 的原文行与引用数量不一致'));continue;}
      for(let index=0;index<lines.length;index++)if(lines[index]!=='')emit(block,'code_block',lines[index]!,cites[index]!);
      continue;
    }
    const table = block.rows === undefined ? null : tableOf(block, digestOf, blankLine);
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
    if (table === null && block.origins.length > 1) {
      // The block's verified lines are not one range: each range becomes its own mapped block, cited on its own lines.
      const parts = splitByOrigins(block, text, digestOf);
      if (parts === null) {
        uncited.push(uncitedOf(model, block, '这个块已核对的原文行不连续，而它的文字与这些行对不上，不能分成各自引用的部分'));
        continue;
      }
      // A part is not a block the author wrote: the whole block was one paragraph, and one paragraph whose text spans
      // lines is no anchor of K1's (its grammar is single-line), so a part must not become a signature the source does
      // not have. K1 reads an anchor only from a `paragraph`, which is why the parts of one say they are parts.
      const kind = mappedKind(block) === 'paragraph' ? PARAGRAPH_PART : mappedKind(block);
      for (const part of parts) emit(block, kind, part.text, part.cite);
      continue;
    }
    const cite = table === null ? (block.origins.length > 0 ? citationOf(block.origins[0]!) : null) : table.cite;
    if (cite === null) {
      uncited.push(uncitedOf(model, block, table === null ? '' : table.reason));
      continue;
    }
    for (const row of table?.dropped ?? []) {
      const place = placeOfLine(model, row.line);
      uncited.push(uncitedOf(model, block, `表格的第 ${row.index + 1} 行（按引擎的行模型数，${place.place}）${row.reason}，这一行没有进映射，也没有借用别的行的来源行`));
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
    const shown = uncited.slice(0, 5).map((one) => `${one.kind} ${one.file ?? '展开文本'}${one.line === null ? `第 ${one.expanded_line} 行` : `:${one.line}`}`).join('、');
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

/** Where the engine put a block: its chapter file and that file's own line, or the expanded line when the file is unknown. */
function placeOf(model: ExpandedModel, block: Block): string {
  return placeOfLine(model, block.reportedLine).place;
}

/**
 * A block or row the mapping does not place: what the engine reported for it, where, and why no citation exists. The place
 * is the chapter file and that file's own line — the engine reports a line of the expanded text, which in an included
 * chapter is not a line of any file a reader can open; the expanded line is kept beside it.
 */
function uncitedOf(model: ExpandedModel, block: Block, reason: string): Uncited {
  const place = placeOfLine(model, block.reportedLine);
  return {
    kind: block.kind,
    file: place.file,
    line: place.line,
    expanded_line: block.reportedLine,
    reason: reason === '' ? (block.unverifiedReason === '' ? '没有已核对的原文行' : block.unverifiedReason) : reason,
    next_action: '按文件和行号核对源行（定位器已在 sourcemap 邻近行做过逐字比较，含结构标记、属性展开、行内标记与宏、字符引用和排版替换的归一）；修好源或定位器后按同一修订号重跑',
  };
}

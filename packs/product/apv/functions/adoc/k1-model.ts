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
import type { Block, Composition, ExpandedModel, VerifiedRange } from './types.ts';
import type { MarkdownBlock, MarkdownSection } from '../../../../../hub/refs/api.ts';
import { inlineMarkdown, plainText } from './text.ts';

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

/**
 * K1's signature grammar: bold head then italic params. asciidoctor collapses `**head** *\<param\>*` into one
 * strong run (`<strong>head &lt;param&gt;</strong>`, the angle marks escaped as `\<`), and keeps two strong runs
 * as `**head** **\<param\>**`. Both become `**head** *\<param\>*`, the one spelling parseAnchor accepts.
 */
function signatureShape(text: string): string {
  const decoded = text.replace(/&lt;/gu, '<').replace(/&gt;/gu, '>').replace(/&amp;/gu, '&');
  let out = decoded.replace(/\*\*([^*]+)\*\*\s+\*\*(\\?[<[][\s\S]*?[>\]])\*\*/gu, '**$1** *$2*');
  out = out.replace(/\*\*([^*]+) (\\?[<[][\s\S]*?[>\]])\*\*/gu, '**$1** *$2*');
  return out;
}

/** The first verified origin among a table's cells (the block's own is often lost). */
function tableOrigin(block: Block): VerifiedRange | null {
  if (block.rows === undefined) return null;
  for (const row of [...block.rows.head, ...block.rows.body, ...block.rows.foot]) {
    for (const cell of row) if (cell.origins.length > 0) return cell.origins[0]!;
  }
  return null;
}

function rowOf(cells: Array<{ text: string; line: number | null }>): string {
  return `| ${cells.map((cell) => cell.text).join(' | ')} |`;
}

function tableText(block: Block): string {
  if (block.rows === undefined) return block.expanded;
  const raw = [...block.rows.head, ...block.rows.body, ...block.rows.foot];
  const cells: Array<{ text: string; line: number | null }> = [];
  for (const row of raw) {
    for (const cell of row) {
      if (cell.raw === '' && cell.origins.length === 0) continue;
      cells.push({ text: signatureShape(inlineMarkdown(cell.raw)).replaceAll('|', '\\|'), line: cell.origins[0]?.from ?? null });
    }
  }
  // The engine's row model loses the row structure of a multi-cell line (it emits one row per cell). Rows are
  // rebuilt from the verified line numbers: a verified line opens a row holding the lineless cells collected since
  // the previous verified line (a cell whose origin the inline rewrite lost rides with the next verified line)
  // followed by its own cell — so `**cmd** *\<p\>* | 说明` of source line 7 is one row: [cmd, 说明].
  const rows: Array<Array<{ text: string; line: number | null }>> = [];
  let pending: Array<{ text: string; line: number | null }> = [];
  for (const cell of cells) {
    if (cell.line === null) {
      pending.push(cell);
      continue;
    }
    const last = rows.at(-1);
    if (last !== undefined && last.every((c) => c.line === null || c.line === cell.line)) {
      last.push(...pending, cell);
    } else {
      rows.push([...pending, cell]);
    }
    pending = [];
  }
  if (pending.length > 0) rows.push(pending);
  // K1's pipe-table reader needs a delimiter row under the header; an adoc table has none, so one is synthesized
  // from the header's cell count (a produced line, never a source line: the fragment ranges cite source rows only).
  const headerCells = rows[0]?.length ?? 2;
  const delimiter = `| ${Array.from({ length: headerCells }, () => '---').join(' | ')} |`;
  return [rows.length > 0 ? rowOf(rows[0]!) : '', delimiter, ...rows.slice(1).map(rowOf)].join('\n');
}

/** The text this block carries into the mapped model; '' for a container whose children carry its content. */
function textOf(block: Block): string {
  if (block.rows !== undefined) return tableText(block);
  // A list item's own text is the engine's converted text: the reader's spelling (markdown-shaped inline marks), not
  // the engine's tags. A listing stays verbatim (the engine substitutes nothing inside it).
  if (block.kind === 'list_item') return inlineMarkdown(block.raw).trim();
  return block.raw;
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
  if (plainText(origin.verbatim) !== plainText(`${term.raw}:: ${value.raw}`)) return null;
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
export interface Mapped {
  model: AdocModel;
  warnings: string[];
  uncited: Uncited[];
}

/**
 * One K1 model of the expanded adoc. `manualName` names the manual of every fragment reference (the K1 producer
 * composes `/manual/<name>/<章节路径>` from it); the composition ties the model to its inputs.
 */
export function toK1Model(model: ExpandedModel, composition: Composition, manualName: string): Mapped {
  const sections: AdocSection[] = [{ level: 0, title: '', key: '', ordinal: 0, parent: null, children: [], blocks: [], line: 0, end: 0, selector: null, attributes: null, cite: null }];
  const byPath = new Map<string, number>([['', 0]]);
  const blocks: AdocBlock[] = [];
  let ordinal = 0;
  const keyOf = (path: Block['path']): string => path.map((s) => s.title).join('/');
  const sectionOf = (path: Block['path']): number => {
    const key = keyOf(path);
    const known = byPath.get(key);
    if (known !== undefined) return known;
    const parent = path.length <= 1 ? 0 : sectionOf(path.slice(0, -1));
    ordinal += 1;
    const at = sections.length;
    const title = path[path.length - 1]!.title;
    sections.push({ level: path.length, title, key: title, ordinal, parent, children: [], blocks: [], line: 0, end: 0, selector: `h/${key}`, attributes: null, cite: null });
    sections[parent]!.children.push(at);
    byPath.set(key, at);
    return at;
  };
  const citationOf = (origin: VerifiedRange): Citation => ({
    file: origin.file,
    sha256: composition.files.find((file) => file.file === origin.file)?.sha256 ?? '',
    selector: origin.selector,
  });
  /** One mapped block: the citation key K1 carries into its fragments, and the citation the key stands for. */
  const emit = (block: Block, kind: string, text: string, origin: VerifiedRange): void => {
    const section = sectionOf(block.path);
    const index = sections[section]!.blocks.length;
    sections[section]!.blocks.push(blocks.length);
    blocks.push({
      kind,
      section,
      index,
      line: origin.from - 1,
      lines: origin.to - origin.from + 1,
      text,
      selector: citeKey(blocks.length),
      path: block.path.map((s) => s.title),
      cite: citationOf(origin),
    });
  };
  const uncited: Uncited[] = [];
  for (let at = 0; at < model.blocks.length; at++) {
    const block = model.blocks[at]!;
    if (block.kind === 'section') continue;
    if (block.kind === 'listing' && block.role === 'signature') {
      // The explicit signature structure: each line becomes one paragraph anchor (a bare line gains the bold marks
      // the role declares; a marked line stays as written), citing the line's own verified origin.
      const origin = block.origins[0] ?? null;
      if (origin === null) {
        uncited.push(uncitedOf(model, block));
        continue;
      }
      for (const line of block.raw.split('\n')) {
        const marked = /^\*\*/.test(line) ? line : `**${line}**`;
        const lineOrigin = block.origins.find((one) => one.verbatim.split('\n').includes(line)) ?? origin;
        emit(block, 'paragraph', marked, lineOrigin);
      }
      continue;
    }
    const text = textOf(block);
    // A container with no text of its own (a list, an example, an open or sidebar block, a table's own node) is not
    // mapped: the engine gives a block for each of its children, and each of those carries and cites its own text.
    if (text === '' && block.rows === undefined) continue;
    if (block.kind === 'list_item' && block.listAt !== null && model.blocks[block.listAt]?.kind === 'dlist') {
      const entry = describedEntry(block, model.blocks[at + 1]);
      if (entry !== null) {
        emit(block, kindOf(block), entry.text, entry.origin);
        at++;
        continue;
      }
    }
    const origin = block.origins[0] ?? (block.rows !== undefined ? tableOrigin(block) : null);
    if (origin === null) {
      uncited.push(uncitedOf(model, block));
      continue;
    }
    emit(block, kindOf(block), text, origin);
  }
  const warnings: string[] = [];
  if (uncited.length > 0) {
    const shown = uncited.slice(0, 5).map((one) => `${one.kind} ${one.file ?? '展开文本'}${one.line === null ? '' : `:${one.line}`}`).join('、');
    warnings.push(
      `有 ${uncited.length} 个块回核不到原文行，没有交给落点代码（不给它们发引用，也不让它们被当成“格式不对”悄悄丢掉）：${shown}${uncited.length > 5 ? ' 等' : ''}。` +
        '下一步：按这些文件和行号核对源行，修好源或定位器后按同一修订号重跑；在那之前这些块的文字没有进知识。',
    );
  }
  void manualName;
  return { model: { charset: 'utf-8', lines: model.line_map.length, sections, blocks, nulRemoved: 0 }, warnings, uncited };
}

/** A block the mapping does not place: what the engine reported for it, where, and why no citation exists. */
function uncitedOf(model: ExpandedModel, block: Block): Uncited {
  const line = block.reportedLine;
  const file = line !== null && line >= 1 && line <= model.line_map.length ? model.line_map[line - 1]!.file : null;
  return {
    kind: block.kind,
    file,
    line,
    reason: block.unverifiedReason === '' ? '没有已核对的原文行' : block.unverifiedReason,
    next_action: '按文件和行号核对源行（定位器已在 sourcemap 邻近行做过逐字比较，含结构标记、属性展开、行内标记、字符引用和排版替换的归一）；修好源或定位器后按同一修订号重跑',
  };
}

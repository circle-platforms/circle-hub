// The adoc-to-K1 mapping (task kb-adoc item 4): the expanded model becomes the markdown@1 shape — sections from the
// `=` levels of the source (a `[discrete]` heading is a block, not a section; `=======` lines are reported upstream
// and stay ordinary blocks), blocks with kind/section/text/path, and every block cites the text@1 line selector of
// its verified original range. K1's placement code (produceManualEntries) applies to the result unchanged.
//
// Nothing is placed that cannot be cited: a block whose text step one could not verify against a source line fails the
// whole group with a typed reason instead of being handed to K1 without a selector, because K1 counts such a block as
// malformed and skips it — the content would disappear from the knowledge with only a count left behind.
import type { Block, Composition, ExpandedModel, VerifiedRange } from './types.ts';
import type { MarkdownBlock, MarkdownModel, MarkdownSection } from '../../../../../hub/refs/api.ts';
import { inlineMarkdown, plainText } from './text.ts';

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
 * could not be cited and therefore are not in the model (never a block without a selector: K1 counts one as malformed
 * and skips it, so the content would vanish with only a count left behind). */
export interface Mapped {
  model: MarkdownModel;
  warnings: string[];
  uncited: Uncited[];
}

/**
 * One K1 model of the expanded adoc. `manualName` names the manual of every fragment reference (the K1 producer
 * composes `/manual/<name>/<章节路径>` from it); the composition ties the model to its inputs.
 */
export function toK1Model(model: ExpandedModel, composition: Composition, manualName: string): Mapped {  const sections: MarkdownSection[] = [{ level: 0, title: '', key: '', ordinal: 0, parent: null, children: [], blocks: [], line: 0, end: 0, selector: null, attributes: null }];
  const byPath = new Map<string, number>([['', 0]]);
  const blocks: MarkdownBlock[] = [];
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
    sections.push({ level: path.length, title, key: title, ordinal, parent, children: [], blocks: [], line: 0, end: 0, selector: `h/${key}`, attributes: null });
    sections[parent]!.children.push(at);
    byPath.set(key, at);
    return at;
  };
  const cite = (origin: VerifiedRange): string => `src:${composition.files.find((f) => f.file === origin.file)?.sha256 ?? ''}/text@1/${origin.selector}`;
  const emit = (block: Block, text: string, origin: VerifiedRange | null): void => {
    const section = sectionOf(block.path);
    const index = sections[section]!.blocks.length;
    sections[section]!.blocks.push(blocks.length);
    // Paragraphs cite their RAW source text (the verbatim line step one checked), not the engine's inline output — the
    // raw is what was verified against the source, and K1's anchor grammar reads it directly.
    blocks.push({
      kind: kindOf(block),
      section,
      index,
      line: (origin?.from ?? 1) - 1,
      lines: origin === null ? 1 : origin.to - origin.from + 1,
      text,
      selector: origin === null ? null : cite(origin),
      path: block.path.map((s) => s.title),
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
        const section = sectionOf(block.path);
        const index = sections[section]!.blocks.length;
        sections[section]!.blocks.push(blocks.length);
        blocks.push({ kind: 'paragraph', section, index, line: (lineOrigin.from ?? 1) - 1, lines: 1, text: marked, selector: cite(lineOrigin), path: block.path.map((s) => s.title) });
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
        emit(block, entry.text, entry.origin);
        at++;
        continue;
      }
    }
    const origin = block.origins[0] ?? (block.rows !== undefined ? tableOrigin(block) : null);
    if (origin === null) {
      uncited.push(uncitedOf(model, block));
      continue;
    }
    emit(block, text, origin);
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

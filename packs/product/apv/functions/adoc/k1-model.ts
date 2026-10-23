// The adoc-to-K1 mapping (task kb-adoc item 4): the expanded model becomes the markdown@1 shape — sections from the
// `=` levels of the source (a `[discrete]` heading is a block, not a section; `=======` lines are reported upstream
// and stay ordinary blocks), blocks with kind/section/text/path, and every block cites the text@1 line selector of
// its verified original range. K1's placement code (produceManualEntries) applies to the result unchanged.
import type { Block, Composition } from './types.ts';
import type { MarkdownBlock, MarkdownModel, MarkdownSection } from '../../../../../hub/refs/api.ts';

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
};

const kindOf = (block: Block): string => K1_KINDS[block.kind] ?? block.kind;

/** The inline form K1 reads: asciidoctor's HTML-ish inline output becomes markdown-shaped bold/mono spans. */
function inlineOf(text: string): string {
  return text
    .replace(/<strong>([\s\S]*?)<\/strong>/gu, '**$1**')
    .replace(/<code>([\s\S]*?)<\/code>/gu, '`$1`')
    .replace(/<em>([\s\S]*?)<\/em>/gu, '*$1*')
    .replace(/&amp;/gu, '&')
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"');
}

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

/** One table row rebuilt from its cells: the adoc `|`-pipe shape K1's manual producer splits. Cells of one row are
 * the cells between two verified line numbers (the engine flattens a multi-cell row into single-cell rows; the
 * signature cell of a row may lose its own origin when its inline spans rewrite the raw text, so it joins the row
 * the next verified line has not yet closed). */
/** The first verified origin among a table's cells (the block's own is often lost). */
function tableOrigin(block: Block): { file: string; from: number; to: number; selector: string; reference: string; verbatim: string } | null {
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
      cells.push({ text: signatureShape(inlineOf(cell.expanded)).replaceAll('|', '\\|'), line: cell.origins[0]?.from ?? null });
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

/**
 * One K1 model of the expanded adoc. `manualName` names the manual of every fragment reference (the K1 producer
 * composes `/manual/<name>/<章节路径>` from it); the composition ties the model to its inputs.
 */
export function toK1Model(model: { blocks: Block[] }, composition: Composition, manualName: string): MarkdownModel {
  const sections: MarkdownSection[] = [{ level: 0, title: '', key: '', ordinal: 0, parent: null, children: [], blocks: [], line: 0, end: 0, selector: null, attributes: null }];
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
  for (const block of model.blocks) {
    if (block.kind === 'section') continue;
    const section = sectionOf(block.path);
    // A table's own origin is often lost (the engine rewrites its raw text): its selector cites the first verified
    // line among its cells, so the K1 producer always has a citable fragment for the block.
    if (block.kind === 'listing' && block.role === 'signature') {
      // The explicit signature structure: each line becomes one paragraph anchor (a bare line gains the bold marks
      // the role declares; a marked line stays as written), citing the line's own verified origin.
      for (const line of block.raw.split('\n')) {
        const marked = /^\*\*/.test(line) ? line : `**${line}**`;
        const lineOrigin = block.origins.find((origin) => origin.verbatim.split('\n').includes(line)) ?? block.origins[0] ?? null;
        const at = sections[section]!.blocks.length;
        sections[section]!.blocks.push(blocks.length);
        blocks.push({ kind: 'paragraph', section, index: at, line: (lineOrigin?.from ?? 1) - 1, lines: 1, text: marked, selector: lineOrigin === null ? null : `src:${composition.files.find((f) => f.file === lineOrigin.file)?.sha256 ?? ''}/text@1/${lineOrigin.selector}`, path: block.path.map((s) => s.title) });
      }
      continue;
    }
    const origin = block.origins[0] ?? (block.kind === 'table' ? tableOrigin(block) : null);
    const index = sections[section]!.blocks.length;
    sections[section]!.blocks.push(blocks.length);
    // Paragraphs cite their RAW source text (the verbatim markdown-shaped line: `**cmd** *\<param\>*`), not the
    // engine's collapsed inline HTML — the raw is what step one verified against the source, and K1's anchor
    // grammar reads it directly. A role=signature listing becomes a signature block; an example block keeps its
    // listing shape (K1 records its lines as code literals, never anchors).
    const text = block.kind === 'table' ? tableText(block) : block.raw;
    blocks.push({
      kind: kindOf(block),
      section,
      index,
      line: (origin?.from ?? 1) - 1,
      lines: origin === null ? 1 : origin.to - origin.from + 1,
      text,
      selector: origin === null ? null : `src:${composition.files.find((f) => f.file === origin.file)?.sha256 ?? ''}/text@1/${origin.selector}`,
      path: block.path.map((s) => s.title),
    });
  }
  void manualName;
  return { charset: 'utf-8', lines: 0, sections, blocks, nulRemoved: 0 };
}

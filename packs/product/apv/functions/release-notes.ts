// Producer of release note entries from a converted release note (markdown@1 model): the title and the opening blocks
// give product, version, build and release date; the sections 已修复问题 (fixed) and 遗留问题 (known) hold module
// subheadings and items (list items, table rows, paragraphs) that cite bug ids. Every item is a defect entry (K02 R[3]);
// `data.status` says fixed or known. Entries are not placed in the tree by code (path null): the module is their literal
// hint for the typed-judgment model; the build is their applicability.
import type { Family, FragmentRef, MarkdownModel, ProducedEntry, ReleaseResult } from './types.ts';
import { idsFromTitle } from './ids.ts';
import { familyOf } from './naming.ts';
import { asString, decodeEntities, guarded, internalError, isRecord, pad2, squeeze, stripNul, utf8Offsets, validDate } from './util.ts';

const PARSER = 'markdown@1';
// Tested before FIX: a negated "fixed" (未修复问题, Unfixed Issues) names known issues, never fixes.
const KNOWN = /(?:未|尚未|没有|未能)(?:修复|解决)|遗留问题|已知问题|\b(?:not\s+fixed|unfixed|unresolved)\b|\bknown\s+(?:issues|problems)\b|\bopen\s+issues\b|\boutstanding\s+issues\b/i;
const FIX = /已修复(?:的)?问题|修复(?:的)?问题|问题修复|已解决(?:的)?问题|\bfixed\s+(?:issues|bugs|problems)\b|\bbug\s*fixes\b|\bresolved\s+issues\b/i;
const NUMBERING = /^\s*(?:[0-9]+(?:\.[0-9]+)*[.．、)）]?|[一二三四五六七八九十]+[、.．]|[(（][0-9一二三四五六七八九十]+[)）])\s*/;
const BUILD = /(?:[A-Za-z][A-Za-z0-9]{0,31}[-_])?(?:Rel|Beta)[_.](?:APV|NSAE)[A-Za-z0-9_.-]*/i;
const PRODUCT = /(?<![A-Za-z])(APV|NSAE)(?![A-Za-z])/i;
const VERSION_LABEL = /(?:版本号?|version)\s*[:：|]?\s*v?([0-9]{1,2}(?:\.[0-9]{1,3}){1,5})(?![0-9.])/i;
const VERSION = /(?<![0-9.])v?([0-9]{1,2}(?:\.[0-9]{1,3}){1,5})(?![0-9.])/i;
const DATE_LABEL = /(?:发布日期|发布时间|release\s*date|日期)\s*[:：|]?\s*([0-9]{4}\s*[-/.年]\s*[0-9]{1,2}\s*[-/.月]\s*[0-9]{1,2}\s*日?)/i;
const DATE = /(?<![0-9])([0-9]{4}\s*[-/.年]\s*[0-9]{1,2}\s*[-/.月]\s*[0-9]{1,2}\s*日?)(?![0-9])/;
const ID_HEADER = /bug|缺陷|问题单|问题编号|^id$|^编号$/i;
const MODULE_HEADER = /模块|module|组件|component/i;
const SEQUENCE_HEADER = /^(?:序号|no\.?|#)$/i;
const MAX_HTML_TABLE = 1_000_000;

type Section = { level: number; title: string; parent: number | null; line: number };
type Block = { kind: string; section: number; text: string; selector: string; line: number };
type Item = { text: string; start: number; end: number; bugId?: string; module?: string };

function isoDate(text: string): string | null {
  const match = /^([0-9]{4})\s*[-/.年]\s*([0-9]{1,2})\s*[-/.月]\s*([0-9]{1,2})/.exec(text);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return validDate(year, month, day) ? `${year}-${pad2(month)}-${pad2(day)}` : null;
}

function cleanTitle(title: string): string {
  return squeeze(title.replace(NUMBERING, '').replace(/\*\*|__/g, ''));
}

/** Cells of a pipe-table row; null when the line is not a row. */
function pipeCells(line: string): string[] | null {
  const text = line.trim();
  if (!text.includes('|')) return null;
  const cells: string[] = [];
  let current = '';
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\' && text[i + 1] === '|') {
      current += '|';
      i++;
    } else if (text[i] === '|') {
      cells.push(current);
      current = '';
    } else current += text[i];
  }
  cells.push(current);
  if (text.startsWith('|')) cells.shift();
  if (text.endsWith('|') && !text.endsWith('\\|')) cells.pop();
  return cells.map((cell) => squeeze(cell));
}

const DELIMITER = /^\s*\|?\s*:?-{1,}:?\s*(?:\|\s*:?-{1,}:?\s*)*\|?\s*$/;
const BORDER = /^\s*\+(?:[-=:]+\+)+\s*$/;

type Row = { cells: string[]; start: number; end: number; header: boolean };

/** Rows of a markdown table block (pipe or grid), with UTF-16 offsets in the block text. */
function tableRows(text: string): Row[] {
  const lines: Array<{ text: string; start: number; end: number }> = [];
  let at = 0;
  for (const line of text.split('\n')) {
    lines.push({ text: line, start: at, end: at + line.length });
    at += line.length + 1;
  }
  if (lines.some((line) => BORDER.test(line.text))) {
    // Grid table: rows between border lines, cells split at '|' (column positions are display widths, so CJK text shifts them);
    // the lines of one row are joined cell by cell, each cell once (a row of many lines stays linear); a border of '='
    // ends the header.
    const rows: Row[] = [];
    let group: typeof lines = [];
    const flush = (header: boolean): void => {
      if (group.length === 0) return;
      const parts: string[][] = [];
      for (const line of group) (pipeCells(line.text) ?? []).forEach((cell, k) => (parts[k] ??= []).push(cell));
      const cells = Array.from({ length: parts.length }, (_, k) => squeeze((parts[k] ?? []).join(' ')));
      rows.push({ cells, start: group[0].start, end: group[group.length - 1].end, header });
      group = [];
    };
    for (const line of lines) {
      if (BORDER.test(line.text)) flush(line.text.includes('='));
      else if (line.text.trim().startsWith('|')) group.push(line);
    }
    flush(false);
    return rows;
  }
  const rows: Row[] = [];
  lines.forEach((line, index) => {
    if (DELIMITER.test(line.text)) {
      if (index === 1 && rows.length === 1) rows[0].header = true;
      return;
    }
    const cells = pipeCells(line.text);
    if (cells !== null) rows.push({ cells, start: line.start, end: line.end, header: false });
  });
  return rows;
}

/**
 * Spans of `<name ...>...</name>` inside lower[from, to), in order, with offsets into the whole text. Found with indexOf
 * on the slice only, so a row costs its own length (linear, no backtracking).
 */
function elementSpans(lower: string, name: string, from: number, to: number): Array<{ start: number; inner: number; close: number; end: number }> {
  const part = lower.slice(from, to);
  const spans: Array<{ start: number; inner: number; close: number; end: number }> = [];
  let at = 0;
  while (at < part.length) {
    const start = part.indexOf(`<${name}`, at);
    if (start < 0) break;
    if (!/[\s>/]/.test(part[start + name.length + 1] ?? '')) {
      at = start + 1;
      continue;
    }
    const inner = part.indexOf('>', start);
    const close = inner < 0 ? -1 : part.indexOf(`</${name}`, inner);
    if (inner < 0 || close < 0) break;
    const end = part.indexOf('>', close);
    spans.push({ start: from + start, inner: from + inner + 1, close: from + close, end: from + (end < 0 ? part.length : end + 1) });
    at = end < 0 ? part.length : end + 1;
  }
  return spans;
}

/** ASCII letters lower-cased, nothing else: the offsets stay those of the text (toLowerCase turns İ into two code units). */
function asciiLower(text: string): string {
  return text.replace(/[A-Z]+/g, (run) => run.toLowerCase());
}

/** Rows of an HTML table block: cells with tags stripped and entities decoded; th-only rows are headers. */
function htmlRows(text: string): Row[] {
  if (text.length > MAX_HTML_TABLE || !/<table\b/i.test(text)) return [];
  const lower = asciiLower(text);
  const rows: Row[] = [];
  for (const row of elementSpans(lower, 'tr', 0, text.length)) {
    const cells: Array<{ start: number; text: string; header: boolean }> = [];
    for (const name of ['td', 'th']) {
      for (const cell of elementSpans(lower, name, row.inner, row.close)) {
        // A tag never holds '<': each match attempt stops at the next '<', so a run of stray '<' stays linear.
        cells.push({ start: cell.start, text: squeeze(decodeEntities(text.slice(cell.inner, cell.close).replace(/<[^<>]*>/g, ' '))), header: name === 'th' });
      }
    }
    cells.sort((a, b) => a.start - b.start);
    if (cells.length > 0) rows.push({ cells: cells.map((cell) => cell.text), start: row.start, end: row.end, header: cells.every((cell) => cell.header) });
  }
  return rows;
}

/** Items of a table: one per data row; the id, module and text columns are found from the header. */
function tableItems(rows: Row[]): Item[] {
  const header = rows.find((row) => row.header) ?? null;
  const names = header?.cells ?? [];
  const idColumn = names.findIndex((name) => ID_HEADER.test(name));
  const moduleColumn = names.findIndex((name) => MODULE_HEADER.test(name));
  const skip = new Set(names.map((name, k) => (SEQUENCE_HEADER.test(name) ? k : -1)).filter((k) => k >= 0));
  const items: Item[] = [];
  for (const row of rows) {
    if (row.header) continue;
    const textCells = row.cells.filter((_, k) => k !== idColumn && k !== moduleColumn && !skip.has(k) && row.cells[k] !== '');
    let bugId: string | undefined;
    if (idColumn >= 0) bugId = /[0-9]{2,9}/.exec(row.cells[idColumn] ?? '')?.[0];
    else if (header === null && /^[0-9]{3,9}$/.test(row.cells[0] ?? '')) {
      bugId = row.cells[0];
      textCells.shift();
    }
    const text = squeeze(textCells.join(' '));
    if (text === '' && bugId === undefined) continue;
    const item: Item = { text, start: row.start, end: row.end };
    if (bugId !== undefined) item.bugId = bugId;
    if (moduleColumn >= 0 && (row.cells[moduleColumn] ?? '') !== '') item.module = row.cells[moduleColumn];
    items.push(item);
  }
  return items;
}

const MARKER = /^(\s*)(?:[-+*]|[0-9]{1,9}[.)])(?:\s+|$)/;

/** Items of a list block: a marker line starts an item, deeper or unmarked lines continue it. */
function listItems(text: string): Item[] {
  const items: Item[] = [];
  let at = 0;
  let base = -1;
  for (const line of text.split('\n')) {
    const marker = MARKER.exec(line);
    const indent = marker ? marker[1].length : -1;
    if (marker && (base < 0 || indent <= base + 1)) {
      if (base < 0) base = indent;
      items.push({ text: line.slice(marker[0].length), start: at, end: at + line.length });
    } else if (items.length > 0 && line.trim() !== '') {
      const item = items[items.length - 1];
      item.text += ` ${line.trim().replace(MARKER, '')}`;
      item.end = at + line.length;
    }
    at += line.length + 1;
  }
  for (const item of items) item.text = squeeze(item.text);
  return items.filter((item) => item.text !== '');
}

function itemsOf(block: Block, warnings: { skipped: number }): Item[] {
  if (block.kind === 'list') return listItems(block.text);
  if (block.kind === 'table') return tableItems(tableRows(block.text));
  if (block.kind === 'html_block') {
    const rows = htmlRows(block.text);
    if (rows.length > 0) return tableItems(rows);
  }
  if (block.kind === 'paragraph') {
    const text = squeeze(block.text);
    return text === '' ? [] : [{ text, start: 0, end: block.text.length }];
  }
  warnings.skipped++;
  return [];
}

function bugIdOf(text: string): string | undefined {
  const ids = idsFromTitle(text);
  return ids.bugs[0] ?? ids.unclassified[0];
}

export function produceReleaseEntries(model: MarkdownModel): ReleaseResult {
  const warnings: string[] = [];
  const out: ReleaseResult = { product: null, version: null, build: null, released: null, entries: [], warnings };
  try {
    if (!isRecord(model) || !Array.isArray(model.sections) || !Array.isArray(model.blocks)) {
      warnings.push('输入不是 markdown@1 模型（缺 sections 或 blocks）');
      return out;
    }
    const sections: Section[] = (model.sections as unknown[]).map((value) =>
      isRecord(value)
        ? {
            level: Number.isInteger(value.level) ? (value.level as number) : 0,
            title: stripNul(asString(value.title) ?? ''),
            parent: Number.isInteger(value.parent) ? (value.parent as number) : null,
            line: Number.isInteger(value.line) ? (value.line as number) : 0,
          }
        : { level: 0, title: '', parent: null, line: 0 },
    );
    const blocks: Block[] = [];
    let invalid = 0;
    for (const value of model.blocks as unknown[]) {
      if (isRecord(value) && typeof value.kind === 'string' && Number.isInteger(value.section) && typeof value.text === 'string' && typeof value.selector === 'string') {
        blocks.push({ kind: value.kind, section: value.section as number, text: value.text, selector: value.selector, line: Number.isInteger(value.line) ? (value.line as number) : 0 });
      } else invalid++;
    }
    if (invalid > 0) warnings.push(`有 ${invalid} 个块格式不对，已跳过`);

    // The issue section above a section (fixed or known), and the module heading (its child on the way down).
    type Status = 'fixed' | 'known';
    const kindOf = new Map<number, { status: Status; module: string | null; at: number }>();
    const resolve = (index: number): { status: Status; module: string | null; at: number } | null => {
      const chain: number[] = [];
      const visited = new Set<number>();
      for (let at: number | null = index; at !== null && at > 0 && at < sections.length && !visited.has(at); at = sections[at].parent) {
        visited.add(at);
        chain.push(at);
      }
      for (let k = chain.length - 1; k >= 0; k--) {
        const title = sections[chain[k]].title;
        const status: Status | null = KNOWN.test(title) ? 'known' : FIX.test(title) ? 'fixed' : null;
        if (status !== null) return { status, module: k > 0 ? cleanTitle(sections[chain[k - 1]].title) || null : null, at: chain[k] };
      }
      return null;
    };
    for (const block of blocks) if (!kindOf.has(block.section)) kindOf.set(block.section, resolve(block.section) ?? { status: 'fixed', module: null, at: -1 });

    // Header: the first heading and the blocks before the first fix or known-issue section.
    const firstHeading = sections.findIndex((section, index) => index > 0 && section.level >= 1);
    const title = firstHeading > 0 ? cleanTitle(sections[firstHeading].title) : '';
    const header: string[] = [];
    for (const block of blocks) {
      const found = kindOf.get(block.section);
      if (found !== undefined && found.at >= 0) break;
      if (header.length < 50) header.push(block.text);
    }
    const headerText = header.join('\n');
    const productMatch = PRODUCT.exec(title) ?? PRODUCT.exec(headerText);
    out.product = productMatch ? (familyOf(productMatch[1]) as Family) : null;
    const buildMatch = BUILD.exec(title) ?? BUILD.exec(headerText);
    out.build = buildMatch ? buildMatch[0].replace(/[._-]+$/, '') : null;
    out.version = (VERSION_LABEL.exec(headerText) ?? VERSION.exec(title) ?? VERSION_LABEL.exec(title))?.[1] ?? null;
    const dateText = (DATE_LABEL.exec(headerText) ?? DATE_LABEL.exec(title) ?? DATE.exec(title) ?? DATE.exec(headerText))?.[1] ?? null;
    out.released = dateText === null ? null : isoDate(dateText);
    if (dateText !== null && out.released === null) warnings.push(`发布日期 ${dateText} 不是有效日期`);
    if (out.product === null) warnings.push('标题和开头没有写产品名（APV 或 NSAE）');
    if (out.build === null) warnings.push('标题和开头没有写构建名');
    if (out.released === null && dateText === null) warnings.push('标题和开头没有写发布日期');

    const counters = { skipped: 0 };
    let sectionsFound = 0;
    const seenSections = new Set<number>();
    for (const block of blocks) {
      const found = kindOf.get(block.section);
      if (found === undefined || found.at < 0) continue;
      if (!seenSections.has(found.at)) {
        seenSections.add(found.at);
        sectionsFound++;
      }
      let offsets: Uint32Array | null = null;
      for (const item of itemsOf(block, counters)) {
        const text = squeeze(stripNul(item.text));
        const module = item.module ?? found.module;
        const bugId = item.bugId ?? bugIdOf(text);
        const fragment: FragmentRef = { parser: PARSER, selector: block.selector };
        if (item.start > 0 || item.end < block.text.length) {
          offsets ??= utf8Offsets(block.text);
          fragment.range = [offsets[item.start], offsets[item.end]];
        }
        const data: { [key: string]: unknown } = { status: found.status, module, text, build: out.build };
        if (bugId !== undefined) data.bugId = bugId;
        out.entries.push({
          kind: 'defect',
          path: null,
          statement: module === null ? text : `${module}：${text}`,
          data,
          fragments: [fragment],
          applicability: out.build === null ? null : { builds: [out.build] },
        } satisfies ProducedEntry);
      }
    }
    if (sectionsFound === 0) warnings.push('没有找到“已修复问题”或“遗留问题”章节');
    if (counters.skipped > 0) warnings.push(`问题章节里有 ${counters.skipped} 个块不是列表、表格或段落，已跳过`);
    return out;
  } catch (error) {
    warnings.push(internalError(error));
    return out;
  }
}

/** Pack function entry: the markdown@1 model, or `{ model }`. */
export default function releaseNotes(input: unknown): ReleaseResult {
  return guarded(
    () => {
      if (isRecord(input) && isRecord(input.model) && !Array.isArray(input.blocks)) return produceReleaseEntries(input.model as unknown as MarkdownModel);
      return produceReleaseEntries(input as MarkdownModel);
    },
    (warning) => ({ product: null, version: null, build: null, released: null, entries: [], warnings: [warning] }),
  );
}

// Producer of release note entries from a converted release note (markdown@1 model): the title and the opening blocks
// give product, version, build and release date. A defect entry exists only where a section or block declares
// `status` as exactly `fixed` or `known` (closed values already stored on `data.status`; not a vocabulary axis).
// Heading words are not a status. A child heading under that section is the module. Table columns are the integer
// indexes declared on the block (`bug`, `module`, `text`, `sequence`); header words do not choose a column, and a
// headerless first cell is not a bug id. A declared bug cell is an id only when the whole cell is the 2–9 digit token
// from ids.ts (`normalizeId`). List and paragraph text still passes through `idsFromTitle` for a bug marker.
// Every item under a declared status is a defect entry (K02 R[3]). `data.bug` is the id when one was read (an index
// key; not `bugId`). Entries are not placed in the tree by code (path null): the module is their literal hint for the
// typed-judgment model; the build is their applicability.
import type { Family, FragmentRef, MarkdownModel, ProducedEntry, ReleaseResult } from './types.ts';
import { idsFromTitle, normalizeId } from './ids.ts';
import { familyOf } from './naming.ts';
import { asString, decodeEntities, guarded, internalError, isRecord, pad2, squeeze, stripNul, utf8Offsets, validDate } from './util.ts';

const PARSER = 'markdown@1';
const STATUS_MISSING = '缺的事实：发布页没有声明 status（只能是 fixed 或 known）。下一步：发布页作者在重新生产前，在章节或块上写入 status。';
const NUMBERING = /^\s*(?:[0-9]+(?:\.[0-9]+)*[.．、)）]?|[一二三四五六七八九十]+[、.．]|[(（][0-9一二三四五六七八九十]+[)）])\s*/;
const BUILD = /(?:[A-Za-z][A-Za-z0-9]{0,31}[-_])?(?:Rel|Beta)[_.](?:APV|NSAE)[A-Za-z0-9_.-]*/i;
const PRODUCT = /(?<![A-Za-z])(APV|NSAE)(?![A-Za-z])/i;
const VERSION_LABEL = /(?:版本号?|version)\s*[:：|]?\s*v?([0-9]{1,2}(?:\.[0-9]{1,3}){1,5})(?![0-9.])/i;
const VERSION = /(?<![0-9.])v?([0-9]{1,2}(?:\.[0-9]{1,3}){1,5})(?![0-9.])/i;
const DATE_LABEL = /(?:发布日期|发布时间|release\s*date|日期)\s*[:：|]?\s*([0-9]{4}\s*[-/.年]\s*[0-9]{1,2}\s*[-/.月]\s*[0-9]{1,2}\s*日?)/i;
const DATE = /(?<![0-9])([0-9]{4}\s*[-/.年]\s*[0-9]{1,2}\s*[-/.月]\s*[0-9]{1,2}\s*日?)(?![0-9])/;
const MAX_HTML_TABLE = 1_000_000;

type Status = 'fixed' | 'known';
type ColumnMap = { bug?: number; module?: number; text?: number; sequence?: number };
type Section = { level: number; title: string; parent: number | null; line: number; status: Status | null };
type Block = { kind: string; section: number; text: string; selector: string; line: number; status: Status | null; columns: ColumnMap | null };
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

function declaredStatus(value: unknown): Status | null {
  return value === 'fixed' || value === 'known' ? value : null;
}

/** Integer indexes under the exact keys `bug`, `module`, `text` and `sequence`. Any other key is ignored. */
function declaredColumns(value: unknown): ColumnMap | null {
  if (!isRecord(value)) return null;
  const out: ColumnMap = {};
  for (const key of ['bug', 'module', 'text', 'sequence'] as const) {
    const index = value[key];
    if (typeof index === 'number' && Number.isInteger(index) && index >= 0 && index < 64) out[key] = index;
  }
  return out.bug === undefined && out.module === undefined && out.text === undefined && out.sequence === undefined ? null : out;
}

/**
 * A declared bug cell is an id only when the whole cell is the digit token ids.ts accepts for a bug (2–9 digits,
 * `normalizeId`). Digits inside a longer cell are not an id.
 */
function bugCell(cell: string | undefined): string | undefined {
  if (cell === undefined || !/^[0-9]{2,9}$/.test(cell)) return undefined;
  return normalizeId(cell) ?? undefined;
}

/** Items of a table: one per data row. Columns come only from the declared index map. */
function tableItems(rows: Row[], columns: ColumnMap | null): Item[] {
  const items: Item[] = [];
  for (const row of rows) {
    if (row.header) continue;
    if (columns === null) {
      const text = squeeze(row.cells.filter((cell) => cell !== '').join(' '));
      if (text === '') continue;
      items.push({ text, start: row.start, end: row.end });
      continue;
    }
    const bugId = columns.bug === undefined ? undefined : bugCell(row.cells[columns.bug]);
    const moduleCell = columns.module === undefined ? undefined : (row.cells[columns.module] ?? '');
    const skip = new Set<number>();
    if (columns.bug !== undefined) skip.add(columns.bug);
    if (columns.module !== undefined) skip.add(columns.module);
    if (columns.sequence !== undefined) skip.add(columns.sequence);
    const text = columns.text !== undefined
      ? squeeze(row.cells[columns.text] ?? '')
      : squeeze(row.cells.filter((cell, k) => !skip.has(k) && cell !== '').join(' '));
    if (text === '' && bugId === undefined) continue;
    const item: Item = { text, start: row.start, end: row.end };
    if (bugId !== undefined) item.bugId = bugId;
    if (moduleCell !== undefined && moduleCell !== '') item.module = moduleCell;
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
  if (block.kind === 'table') return tableItems(tableRows(block.text), block.columns);
  if (block.kind === 'html_block') {
    const rows = htmlRows(block.text);
    if (rows.length > 0) return tableItems(rows, block.columns);
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
            status: declaredStatus(value.status),
          }
        : { level: 0, title: '', parent: null, line: 0, status: null },
    );
    const blocks: Block[] = [];
    let invalid = 0;
    for (const value of model.blocks as unknown[]) {
      if (isRecord(value) && typeof value.kind === 'string' && Number.isInteger(value.section) && typeof value.text === 'string' && typeof value.selector === 'string') {
        blocks.push({
          kind: value.kind,
          section: value.section as number,
          text: value.text,
          selector: value.selector,
          line: Number.isInteger(value.line) ? (value.line as number) : 0,
          status: declaredStatus(value.status),
          columns: declaredColumns(value.columns),
        });
      } else invalid++;
    }
    if (invalid > 0) warnings.push(`有 ${invalid} 个块格式不对，已跳过`);

    // The nearest declared status above a section, and the module heading (its child on the way down).
    const kindOf = new Map<number, { status: Status; module: string | null; at: number } | null>();
    const resolve = (index: number): { status: Status; module: string | null; at: number } | null => {
      const chain: number[] = [];
      const visited = new Set<number>();
      for (let at: number | null = index; at !== null && at > 0 && at < sections.length && !visited.has(at); at = sections[at].parent) {
        visited.add(at);
        chain.push(at);
      }
      const statusAt = chain.findIndex((at) => sections[at].status !== null);
      if (statusAt < 0) return null;
      const status = sections[chain[statusAt]].status;
      if (status === null) return null;
      const module = statusAt > 0 ? cleanTitle(sections[chain[statusAt - 1]].title) || null : null;
      return { status, module, at: chain[statusAt] };
    };
    for (const block of blocks) if (!kindOf.has(block.section)) kindOf.set(block.section, resolve(block.section));

    // Header: the first heading and the blocks before the first section or block that declares a status.
    const firstHeading = sections.findIndex((section, index) => index > 0 && section.level >= 1);
    const title = firstHeading > 0 ? cleanTitle(sections[firstHeading].title) : '';
    const header: string[] = [];
    for (const block of blocks) {
      const found = kindOf.get(block.section);
      if ((found !== undefined && found !== null) || block.status !== null) break;
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
      const found = kindOf.get(block.section) ?? null;
      const status = block.status ?? (found === null ? null : found.status);
      if (status === null) continue;
      const at = found === null ? block.section : found.at;
      if (!seenSections.has(at)) {
        seenSections.add(at);
        sectionsFound++;
      }
      let offsets: Uint32Array | null = null;
      for (const item of itemsOf(block, counters)) {
        const text = squeeze(stripNul(item.text));
        const module = item.module ?? (found === null ? null : found.module);
        const bugId = item.bugId ?? bugIdOf(text);
        const fragment: FragmentRef = { parser: PARSER, selector: block.selector };
        if (item.start > 0 || item.end < block.text.length) {
          offsets ??= utf8Offsets(block.text);
          fragment.range = [offsets[item.start], offsets[item.end]];
        }
        const data: { [key: string]: unknown } = { status, module, text, build: out.build };
        if (bugId !== undefined) data.bug = bugId;
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
    if (sectionsFound === 0) warnings.push(STATUS_MISSING);
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

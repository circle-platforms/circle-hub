// The runner's own workbook template, carried by the run's profile. A case workbook is this file with rows filled in, as the
// reference compiler does: its notes, object and method lists, drop-downs, column widths and defined names stay the template's.
// Filling edits the worksheet text and keeps every other member's bytes, so the Hub recomputes the same workbook. Node
// built-ins only; the template itself is data, so this pack names no product.
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import FORMAT from './format.json' with { type: 'json' };
const isRecord = (value: unknown): value is { [key: string]: unknown } => typeof value === 'object' && value !== null && !Array.isArray(value);
import { zipStore } from './zip-store.ts';

export interface TemplateDoc { sha256: string; xlsx_base64: string }
export interface TemplateBook { sheet: string; header: string[]; identity_marker: string; range_name: string; template?: TemplateDoc }
export interface WorkbookTemplate {
  members: ReadonlyArray<{ name: string; bytes: Buffer }>;
  relationships: ReadonlyArray<{ source: string; id: string; type: string; target: string }>;
  /** The worksheet text, the row of the nine-column header and the last row the template formats. */
  sheet: string; headerRow: number; lastRow: number;
  /** A1, B1 and C1 as the template holds them: marker, runtime schema and the contract identity it was made for. */
  identity: [string, string, string];
}
export class TemplateError extends Error { constructor(message: string) { super(message); this.name = 'TemplateError'; } }
const refuse = (message: string): never => { throw new TemplateError(message); };

function zipMembers(bytes: Buffer): Array<{ name: string; bytes: Buffer }> {
  let end = bytes.length - 22; while (end >= 0 && bytes.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) refuse('运行器模板不是 ZIP 文件');
  const count = bytes.readUInt16LE(end + 10); let at = bytes.readUInt32LE(end + 16);
  const out: Array<{ name: string; bytes: Buffer }> = [];
  for (let i = 0; i < count; i++) {
    if (bytes.readUInt32LE(at) !== 0x02014b50) refuse('运行器模板的 ZIP 目录不完整');
    const method = bytes.readUInt16LE(at + 10), packed = bytes.readUInt32LE(at + 20), size = bytes.readUInt32LE(at + 24);
    const nameLength = bytes.readUInt16LE(at + 28), extra = bytes.readUInt16LE(at + 30), comment = bytes.readUInt16LE(at + 32), offset = bytes.readUInt32LE(at + 42);
    const name = bytes.toString('utf8', at + 46, at + 46 + nameLength);
    const start = offset + 30 + bytes.readUInt16LE(offset + 26) + bytes.readUInt16LE(offset + 28);
    if (size > FORMAT.max_workbook_bytes) refuse('运行器模板的成员超出本包字节上限');
    const body = bytes.subarray(start, start + packed);
    const content = method === 0 ? Buffer.from(body) : method === 8 ? inflateRawSync(body, { maxOutputLength: FORMAT.max_workbook_bytes }) : refuse('运行器模板用了不支持的 ZIP 压缩方法');
    if (content.length !== size) refuse('运行器模板的成员长度不符');
    out.push({ name, bytes: content }); at += 46 + nameLength + extra + comment;
  }
  return out;
}
const decoded = (text: string) => text.replace(/&#(\d+);|&#x([0-9a-fA-F]+);|&(amp|lt|gt|quot|apos);/g, (_, decimal, hex, name) => decimal ? String.fromCodePoint(Number(decimal)) : hex ? String.fromCodePoint(parseInt(hex, 16)) : ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[name]);
/** The texts of one row's inline cells, by column letter. */
function rowTexts(sheet: string, number: number): Map<string, string> {
  const start = sheet.indexOf(`<row r="${number}"`); if (start < 0) refuse(`运行器模板没有第 ${number} 行`);
  const row = sheet.slice(start, sheet.indexOf('</row>', start)); const out = new Map<string, string>();
  for (const match of row.matchAll(/<c r="([A-Z]+)\d+"[^>]*>(?:<is><t[^>]*>([\s\S]*?)<\/t><\/is>)?/g)) out.set(match[1], decoded(match[2] ?? ''));
  return out;
}
const cache = new Map<string, WorkbookTemplate>();
/** The profile's template, checked against its digest and the book it must serve. */
export function readTemplate(book: TemplateBook): WorkbookTemplate {
  const doc = book.template;
  if (!isRecord(doc) || typeof doc.sha256 !== 'string' || typeof doc.xlsx_base64 !== 'string') return refuse('运行配置没有运行器模板；管理员把模板写进 runtime-profile 的 workbook.template 后重开运行');
  const key = JSON.stringify([doc.sha256, book.sheet, book.header, book.identity_marker, book.range_name]);
  const known = cache.get(key); if (known) return known;
  const bytes = Buffer.from(doc.xlsx_base64, 'base64');
  if (createHash('sha256').update(bytes).digest('hex') !== doc.sha256) refuse('运行器模板的字节与配置写的摘要不符');
  const members = zipMembers(bytes), text = (name: string) => (members.find((member) => member.name === name) ?? refuse(`运行器模板缺 ${name}`)).bytes.toString('utf8');
  const workbook = text('xl/workbook.xml'), sheet = text(FORMAT.worksheet_part);
  const open = `<definedName name="${book.range_name}">`, from = workbook.indexOf(open); if (from < 0) refuse(`运行器模板没有定义名 ${book.range_name}`);
  const range = /^'?(.+?)'?!\$A\$(\d+):\$I\$(\d+)$/.exec(decoded(workbook.slice(from + open.length, workbook.indexOf('</definedName>', from))));
  if (!range || range[1] !== book.sheet || range[2] !== range[3]) return refuse(`运行器模板的 ${book.range_name} 没有指向表 ${book.sheet} 的一行九列表头`);
  const headerRow = Number(range[2]), header = rowTexts(sheet, headerRow);
  if (book.header.some((value, column) => header.get(String.fromCharCode(65 + column)) !== value)) refuse('运行器模板的表头和配置不一致');
  const first = rowTexts(sheet, 1), identity: [string, string, string] = [first.get('A') ?? '', first.get('B') ?? '', first.get('C') ?? ''];
  if (identity[0] !== book.identity_marker) refuse('运行器模板第一行没有身份标记');
  const lastRow = Number(/^<row r="(\d+)"/.exec(sheet.slice(sheet.lastIndexOf('<row r="')))?.[1] ?? 0);
  const relations = (name: string, source: string) => [...text(name).matchAll(/<Relationship\b([^>]*?)\/?>/g)].map((match) => { const attribute = (key: string) => new RegExp(`\\b${key}="([^"]*)"`).exec(match[1])?.[1] ?? ''; return { source, id: attribute('Id'), type: attribute('Type'), target: attribute('Target') }; });
  const read = { members, relationships: [...relations('_rels/.rels', ''), ...relations('xl/_rels/workbook.xml.rels', 'xl/workbook.xml')], sheet, headerRow, lastRow, identity };
  cache.set(key, read); return read;
}
export type CellText = (text: string, at: string) => string;
const CELL = /<c r="([A-I])(\d+)"((?: s="\d+")?)[^>]*?(?:\/>|><\/c>)/g;
function filledRow(row: string, values: ReadonlyArray<string | number>, text: CellText): string {
  const placed = new Set<string>();
  const out = row.replace(CELL, (cell, column: string, number: string, style: string) => {
    placed.add(column); const value = values[column.charCodeAt(0) - 65];
    if (value === undefined || value === '') return cell;
    return typeof value === 'number' ? `<c r="${column}${number}"${style} t="n"><v>${value}</v></c>` : `<c r="${column}${number}"${style} t="inlineStr"><is><t xml:space="preserve">${text(value, `/${column}${number}`)}</t></is></c>`;
  });
  for (const [column, value] of values.entries()) if (value !== '' && !placed.has(String.fromCharCode(65 + column))) refuse(`运行器模板的数据行缺 ${String.fromCharCode(65 + column)} 列单元格`);
  return out;
}
/** The workbook: `identity` adds cells to the first row by column letter, `rows` fill the rows below the header in order. */
export function fillTemplate(template: WorkbookTemplate, identity: Record<string, string>, rows: ReadonlyArray<ReadonlyArray<string | number>>, text: CellText): Uint8Array {
  if (template.headerRow + rows.length > template.lastRow) refuse(`工作簿 ${rows.length} 行超出运行器模板的 ${template.lastRow} 行；把脑图拆成几份分别编译`);
  let sheet = template.sheet;
  const firstEnd = sheet.indexOf('</row>', sheet.indexOf('<row r="1"'));
  sheet = sheet.slice(0, firstEnd) + Object.entries(identity).map(([column, value]) => `<c r="${column}1" t="inlineStr"><is><t xml:space="preserve">${text(value, `/${column}1`)}</t></is></c>`).join('') + sheet.slice(firstEnd);
  const start = sheet.indexOf(`<row r="${template.headerRow + 1}"`); if (start < 0) refuse('运行器模板表头下面没有数据行');
  let at = start, body = '';
  for (const [k, values] of rows.entries()) {
    if (!sheet.startsWith(`<row r="${template.headerRow + 1 + k}"`, at)) refuse(`运行器模板的第 ${template.headerRow + 1 + k} 行不连续`);
    const close = sheet.indexOf('</row>', at) + '</row>'.length, row = sheet.slice(at, close);
    body += values.length ? filledRow(row, values, text) : row; at = close;
  }
  const worksheet = Buffer.from(sheet.slice(0, start) + body + sheet.slice(at), 'utf8');
  return zipStore(template.members.map((member) => member.name === FORMAT.worksheet_part ? { name: member.name, bytes: worksheet } : member));
}

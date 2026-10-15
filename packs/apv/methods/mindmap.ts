import ExcelJS from 'exceljs';
import {boundedUnzip} from '../../../packages/knowledge/src/zip.ts';
import { zipSync } from 'fflate';
import { ApiError, MAX_SOURCE_BYTES,canonicalHash, sha256, type UnmappedElement } from '../../../packages/contracts/src/index.ts';
import {MINDMAP_CONTRACT_VERSION,MINDMAP_MAPPING_VERSION,MINDMAP_WORKBOOK_CREATOR} from '../contracts.ts';
import { verifyMindmapWorkbook } from './mindmap-verify.ts';

export interface Topic { title: string; note?: string; children: Topic[] }
export interface ParsedMindmap { ir: Topic; format: string; unmapped: UnmappedElement[]; irSha256: string }
export const CASE_COLUMNS = ['编号','一级模块','二级模块','用例标题','备注','层级深度','路径'];

function invalid(message: string): never { throw new ApiError('INVALID_MINDMAP', message); }
function object(value: unknown, path: string): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`Expected an object at ${path}`);
  return value as Record<string, any>;
}
function text(value: unknown, path: string, title = false): string {
  if (typeof value !== 'string') invalid(`Expected text at ${path}`);
  const normalized = title ? value.trim().replace(/[\r\n]+/g, ' ') : value;
  if ((title && !normalized) || normalized.length > 32_767 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(normalized)) invalid(`Invalid spreadsheet text at ${path}`);
  return normalized;
}
export function parseMindmap(source: Uint8Array, fileName: string): ParsedMindmap {
  if (source.byteLength > MAX_SOURCE_BYTES) invalid('Source exceeds the upload limit');
  let bytes = source; let zipped = false; const unmapped: UnmappedElement[] = [];
  const zipMagic = source[0] === 0x50 && source[1] === 0x4b;
  if (zipMagic) {
    zipped=true;
    try{
      const archive=boundedUnzip(source,{maxBytes:64*1024*1024,maxEntries:2048});
      for(const name of Object.keys(archive))if(!['content.json','metadata.json','manifest.json','Thumbnails/thumbnail.png'].includes(name)&&!name.endsWith('/'))unmapped.push({path:'zip:'+name,reason:'Archive attachment or extension is not mapped to V1 cells'});
      if(!archive['content.json'])throw new ApiError('UNSUPPORTED_MINDMAP','XMind 2020+ requires exactly one root content.json; content.xml is unsupported');
      bytes = archive['content.json'];
      if (bytes.byteLength > MAX_SOURCE_BYTES) invalid('Expanded content exceeds the limit');
    } catch (error) { if (error instanceof ApiError) throw error; invalid('Cannot parse the XMind zip archive'); }
  } else if (fileName.toLowerCase().endsWith('.xmind')) {
    throw new ApiError('UNSUPPORTED_MINDMAP', 'A .xmind input must be a zip containing content.json');
  }
  let input: unknown;
  try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '')); }
  catch { invalid('Source is not valid UTF-8 JSON'); }
  const extras = (record: Record<string, unknown>, allowed: string[], path: string) => {
    for (const key of Object.keys(record)) if (!allowed.includes(key)) unmapped.push({ path: `${path}.${key}`, reason: 'Element is outside the frozen structural mapping' });
  };
  let count = 0;
  const limits = (depth: number) => { count++; if (depth > 128 || count > 50_000) invalid('Mindmap exceeds depth or node limits'); };
  const tree = (value: unknown, path: string, depth: number): Topic => {
    limits(depth); const node = object(value, path); extras(node, ['title','note','children'], path);
    if (node.children !== undefined && !Array.isArray(node.children)) invalid(`Expected children array at ${path}`);
    return { title: text(node.title, `${path}.title`, true), ...(node.note === undefined ? {} : { note: text(node.note, `${path}.note`) }),
      children: (node.children ?? []).map((child: unknown, index: number) => tree(child, `${path}.children[${index}]`, depth + 1)) };
  };
  const xmind = (value: unknown, path: string, depth: number): Topic => {
    limits(depth); const node = object(value, path); extras(node, ['id','class','title','notes','children'], path);
    let note: string | undefined;
    if (node.notes !== undefined) {
      const notes = object(node.notes, `${path}.notes`); extras(notes, ['plain'], `${path}.notes`);
      if (notes.plain !== undefined) { const plain = object(notes.plain, `${path}.notes.plain`); extras(plain, ['content'], `${path}.notes.plain`); note = text(plain.content, `${path}.notes.plain.content`); }
    }
    let children: unknown[] = [];
    if (node.children !== undefined) {
      const group = object(node.children, `${path}.children`); extras(group, ['attached'], `${path}.children`);
      if (group.attached !== undefined && !Array.isArray(group.attached)) invalid(`Expected children.attached array at ${path}`);
      children = group.attached ?? [];
    }
    return { title: text(node.title, `${path}.title`, true), ...(note === undefined ? {} : { note }),
      children: children.map((child, index) => xmind(child, `${path}.children.attached[${index}]`, depth + 1)) };
  };
  let ir: Topic; let format: string;
  if (Array.isArray(input)) {
    if (!input.length) invalid('XMind contains no sheets');
    const sheet = object(input[0], '$[0]'); extras(sheet, ['id','class','title','rootTopic'], '$[0]');
    ir = xmind(sheet.rootTopic, '$[0].rootTopic', 0);
    for (let index = 1; index < input.length; index++) unmapped.push({ path: `$[${index}]`, reason: 'Additional XMind sheet is outside V1; only the first sheet is compiled' });
    format = zipped ? 'XMind 2020+ zip / content.json' : 'XMind content.json';
  } else {
    if (zipped) invalid('XMind content.json must be an array of sheets');
    const envelope = object(input, '$');
    if ('root' in envelope) { extras(envelope, ['root','formatNote','sampleId','type'], '$'); ir = tree(envelope.root, '$.root', 0); }
    else ir = tree(envelope, '$', 0);
    format = '主题树 JSON';
  }
  if (JSON.stringify(unmapped).length > 32_767) invalid('Unmapped element report exceeds a V1 explanation cell');
  return { ir, format, unmapped, irSha256: canonicalHash(ir) };
}

export async function compileMindmap(source: Uint8Array, fileName: string): Promise<{
  workbook: Buffer; parsed: ParsedMindmap; status: 'succeeded' | 'partial'; unmapped: UnmappedElement[];
  verification: { reader: string; rowCount: number; sourceSha256: string; irSha256: string; artifactSha256: string };
}> {
  const parsed = parseMindmap(source, fileName);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = MINDMAP_WORKBOOK_CREATOR;
  workbook.created = new Date('2000-01-01T00:00:00Z'); workbook.modified = workbook.created;
  const cases = workbook.addWorksheet('用例清单', { views: [{ state: 'frozen', ySplit: 1 }] });
  const widths = [14,24,24,38,54,12,80];
  cases.columns = CASE_COLUMNS.map((header, index) => ({ header, key: header, width: widths[index] }));
  let sequence = 0;
  const visit = (node: Topic, path: string[], depth: number): void => {
    if (depth >= 2) {
      sequence++; const pathValue = text(path.join('/'), 'computed path');
      const row = cases.addRow([`TC-${String(sequence).padStart(3,'0')}`, path[0], path[1] ?? '', node.title,
        node.note ?? '', depth, pathValue]);
      row.height = Math.min(120, Math.max(28, 16 * Math.ceil(Math.max((node.note?.length ?? 0) / 48, path.join('/').length / 72))));
    }
    for (const child of node.children) visit(child, [...path, child.title], depth + 1);
  };
  visit(parsed.ir, [], 0);
  cases.autoFilter = { from: 'A1', to: `G${Math.max(1, sequence + 1)}` };
  cases.getColumn(6).numFmt = '0';
  const info = workbook.addWorksheet('说明'); info.columns = [{ header: '项', width: 28 }, { header: '值', width: 110 }];
  const status = parsed.unmapped.length ? 'partial' : 'succeeded';
  for (const entry of [
    ['源文件 SHA-256', sha256(source)], ['输入格式', parsed.format], ['契约版本', MINDMAP_CONTRACT_VERSION],
    ['映射规则版本', MINDMAP_MAPPING_VERSION], ['源文件标题', parsed.ir.title], ['IR SHA-256', parsed.irSha256],
    ['产物状态', status], ['未映射清单', JSON.stringify(parsed.unmapped)],
  ]) info.addRow(entry);
  for (const sheet of [cases, info]) {
    sheet.eachRow(row => { row.eachCell(cell => { cell.font = { name: 'Microsoft YaHei', size: 11 }; cell.alignment = { vertical: 'top', wrapText: true }; }); });
    sheet.getRow(1).height = 26;
    sheet.getRow(1).eachCell(cell => { cell.font = { name: 'Microsoft YaHei', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF24445C' } }; });
  }
  info.getRow(9).height = Math.min(240, Math.max(32, Math.ceil(JSON.stringify(parsed.unmapped).length / 100) * 16));
  // Freeze ZIP timestamps too, so retries across wall-clock seconds preserve the exact artifact SHA.
  const output = Buffer.from(zipSync(boundedUnzip(Buffer.from(await workbook.xlsx.writeBuffer())),
    { level: 6, mtime: new Date('2000-01-01T00:00:00Z') }));
  const verification = await verifyMindmapWorkbook(output, parsed, sha256(source));
  return { workbook: output, parsed, status, unmapped: parsed.unmapped, verification };
}

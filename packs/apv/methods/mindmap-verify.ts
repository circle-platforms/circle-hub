import readWorkbook from 'read-excel-file/node';
import { unzipSync, strFromU8 } from 'fflate';
import { ApiError, sha256 } from '../../../packages/contracts/src/index.ts';
import {MINDMAP_CONTRACT_VERSION,MINDMAP_MAPPING_VERSION} from '../contracts.ts';
import type { ParsedMindmap, Topic } from './mindmap.ts';

// This reader does not use ExcelJS, the writer's row list, or its worksheet models.
export async function verifyMindmapWorkbook(bytes: Buffer, source: ParsedMindmap, sourceSha256: string): Promise<{
  reader: string; rowCount: number; sourceSha256: string; irSha256: string; artifactSha256: string;
}> {
  const fail = (message: string): never => { throw new ApiError('ARTIFACT_VERIFICATION_FAILED', message); };
  let expandedSize = 0; const names = new Set<string>(); let archive: Record<string, Uint8Array>;
  try {
    archive = unzipSync(bytes,{ filter:entry => {
      expandedSize += entry.originalSize;
      if (expandedSize > 64*1024*1024 || names.size > 512 || names.has(entry.name) || entry.name.split('/').includes('..')) fail('Unsafe or oversized workbook archive');
      names.add(entry.name); return true;
    } });
  } catch (error) { if (error instanceof ApiError) throw error; fail('Workbook is not a valid OOXML zip'); }
  if (!archive!['[Content_Types].xml'] || !archive!['xl/workbook.xml']) fail('Workbook OOXML parts are missing');
  if (Object.keys(archive!).some(name => /vbaProject|macrosheets|externalLinks/i.test(name)) || /macroEnabled|vbaProject/i.test(strFromU8(archive!['[Content_Types].xml']))) fail('V1 workbooks cannot contain macros or external workbook links');
  for (const [name,part] of Object.entries(archive!)) {
    if (/^xl\/worksheets\/.*\.xml$/.test(name) && /<(?:[\w-]+:)?f(?:\s|>)/.test(strFromU8(part))) fail('V1 cells must be literal values, not formulas');
    if (name.endsWith('.rels') && /TargetMode=["']External["']/.test(strFromU8(part))) fail('V1 workbook cannot contain active external targets');
  }
  const sheets = await readWorkbook(bytes, { trim: false });
  if (sheets.length !== 2 || sheets[0].sheet !== '用例清单' || sheets[1].sheet !== '说明') fail('Workbook sheet names or order differ from V1');
  const columns = ['编号','一级模块','二级模块','用例标题','备注','层级深度','路径'];
  if (JSON.stringify(sheets[0].data[0]) !== JSON.stringify(columns)) fail('Workbook columns differ from V1');
  let position = 1;
  const inspect = (node: Topic, ancestors: string[]): void => {
    const depth = ancestors.length;
    if (depth >= 2) {
      const expected = [`TC-${String(position).padStart(3,'0')}`, ancestors[0], ancestors[1] ?? '', node.title, node.note ?? '', depth, ancestors.join('/')];
      const actual = sheets[0].data[position];
      if (!actual || actual.length !== 7 || typeof actual[5] !== 'number' || !Number.isInteger(actual[5])) fail(`Row ${position + 1} has invalid depth or width`);
      for (let column = 0; column < 7; column++) {
        const value = actual[column] ?? '';
        if (value !== expected[column] || (column !== 5 && typeof value !== 'string')) fail(`Cell ${position + 1}:${column + 1} differs from the IR`);
      }
      position++;
    }
    node.children.forEach(child => inspect(child, ancestors.concat(child.title)));
  };
  inspect(source.ir, []);
  if (sheets[0].data.length !== position) fail('Workbook includes missing or extra case rows');
  if (JSON.stringify(sheets[1].data[0]) !== '["项","值"]') fail('Explanation header differs from V1');
  const values = new Map<string, string>();
  for (const row of sheets[1].data.slice(1)) {
    if (row.length !== 2 || typeof row[0] !== 'string' || typeof row[1] !== 'string' || values.has(row[0])) fail('Explanation has invalid or duplicate entries');
    values.set(row[0] as string, row[1] as string);
  }
  for (const [key, expected] of [
    ['源文件 SHA-256', sourceSha256], ['输入格式', source.format], ['契约版本', MINDMAP_CONTRACT_VERSION],
    ['映射规则版本', MINDMAP_MAPPING_VERSION], ['源文件标题', source.ir.title], ['IR SHA-256', source.irSha256],
    ['产物状态', source.unmapped.length ? 'partial' : 'succeeded'], ['未映射清单', JSON.stringify(source.unmapped)],
  ]) if (values.get(key) !== expected) fail(`Explanation value differs: ${key}`);
  return { reader: 'read-excel-file/9.3.12', rowCount: position - 1, sourceSha256, irSha256: source.irSha256, artifactSha256: sha256(bytes) };
}

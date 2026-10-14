import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { zipSync, unzipSync, strToU8 } from 'fflate';
import readWorkbook from 'read-excel-file/node';
import { compileMindmap, parseMindmap } from '../../packs/apv/methods/mindmap.ts';
import { verifyMindmapWorkbook } from '../../packs/apv/methods/mindmap-verify.ts';
import { sha256 } from '../../packages/contracts/src/index.ts';

const samples = new URL('../../references/platform/snapshot/samples/v05/', import.meta.url);
const headers = ['编号', '一级模块', '二级模块', '用例标题', '备注', '层级深度', '路径'];
test('frozen V05 inputs compile to all eight independently frozen rows and provenance cells', async () => {
  const expected = JSON.parse(await readFile(new URL('smp-v05-02.json', samples), 'utf8'));
  for (const name of ['smp-v05-01-content.json', 'smp-v05-01-topic-tree.json']) {
    const bytes = await readFile(new URL(name, samples));
    const result = await compileMindmap(bytes, name);
    assert.equal(result.status, 'succeeded'); assert.equal(result.unmapped.length, 0);
    const sheets = await readWorkbook(result.workbook, { trim: false });
    assert.deepEqual(sheets.map(sheet => sheet.sheet), ['用例清单', '说明']);
    assert.deepEqual(sheets[0].data[0], headers);
    assert.deepEqual(sheets[0].data.slice(1).map(row => row.map(value => value ?? '')),
      expected.expectedRows.map((row: Record<string, unknown>) => headers.map(header => row[header])));
    const explanation = new Map(sheets[1].data.slice(1).map(row => [row[0], row[1]]));
    assert.equal(explanation.get('源文件 SHA-256'), sha256(bytes));
    assert.equal(explanation.get('契约版本'), 'Excel 输出契约 V1');
    assert.equal(explanation.get('映射规则版本'), '1.0.0');
    assert.equal(typeof sheets[0].data[1][5], 'number');
    const check = await verifyMindmapWorkbook(result.workbook, parseMindmap(bytes, name), sha256(bytes));
    assert.equal(check.rowCount, 8);
  }
});

test('synthetic XMind zip, title normalization, literal formulas and unknown elements', async () => {
  const content = [{ id: 'sheet-synthetic', rootTopic: { title: ' 根标题 ', children: { attached: [{ title: ' 功能\n模块 ',
    children: { attached: [{ title: '=literal test', notes: { plain: { content: '注释\n第二行' } },
      href: 'https://synthetic.invalid', unknownExtension: { format: 'future' } }] } }] } } }];
  const bytes = Buffer.from(zipSync({ 'content.json': strToU8(JSON.stringify(content)),
    'metadata.json': strToU8(JSON.stringify({ creator: 'circle-hub synthetic' })) }));
  const result = await compileMindmap(bytes, 'synthetic.xmind');
  assert.equal(result.status, 'partial');
  assert.ok(result.unmapped.some(entry => entry.path.endsWith('href')));
  assert.ok(result.unmapped.some(entry => entry.path.endsWith('unknownExtension')));
  const sheets = await readWorkbook(result.workbook, { trim: false });
  assert.deepEqual(sheets[0].data[1], ['TC-001', '功能 模块', '=literal test', '=literal test', '注释\n第二行', 2, '功能 模块/=literal test']);
  const explanation = new Map(sheets[1].data.slice(1).map(row => [row[0], row[1]]));
  assert.match(String(explanation.get('未映射清单')), /unknownExtension/);
});

test('invalid structures produce no workbook and multiple sheets are explicitly partial', async () => {
  for (const input of ['not json', JSON.stringify({ title: '  ', children: [] }),
    JSON.stringify({ title: 'root', children: [{ title: 'module', children: [{ title: 'test', note: 5 }] }] })]) {
    await assert.rejects(compileMindmap(Buffer.from(input), 'invalid.json'), (error: any) => error.code === 'INVALID_MINDMAP');
  }
  const zip = Buffer.from(zipSync({ 'content.xml': strToU8('<old-xmind/>') }));
  await assert.rejects(compileMindmap(zip, 'old.xmind'), (error: any) => error.code === 'UNSUPPORTED_MINDMAP');
  const multi = [{ rootTopic: { title: 'one', children: { attached: [] } } }, { rootTopic: { title: 'two' } }];
  const partial = await compileMindmap(Buffer.from(JSON.stringify(multi)), 'content.json');
  assert.equal(partial.status, 'partial'); assert.ok(partial.unmapped.some(entry => entry.path === '$[1]'));
});

test('independent reader rejects a wrong workbook while identical inputs have stable cells', async () => {
  const a = Buffer.from(JSON.stringify({ title: 'root', children: [{ title: 'module', children: [{ title: 'A' }] }] }));
  const b = Buffer.from(JSON.stringify({ title: 'root', children: [{ title: 'module', children: [{ title: 'B' }] }] }));
  const first = await compileMindmap(a, 'a.json'); await delay(2100); const second = await compileMindmap(a, 'a.json');
  assert.equal(sha256(first.workbook), sha256(second.workbook));
  const wrong = await compileMindmap(b, 'b.json');
  await assert.rejects(verifyMindmapWorkbook(wrong.workbook, parseMindmap(a, 'a.json'), sha256(a)));
  const macro = unzipSync(first.workbook); macro['xl/vbaProject.bin'] = strToU8('synthetic macro marker');
  await assert.rejects(verifyMindmapWorkbook(Buffer.from(zipSync(macro)),parseMindmap(a,'a.json'),sha256(a)),
    (error: any) => error.code === 'ARTIFACT_VERIFICATION_FAILED');
  const formula = unzipSync(first.workbook);
  formula['xl/worksheets/sheet1.xml'] = strToU8(new TextDecoder().decode(formula['xl/worksheets/sheet1.xml'])
    .replace(/<c r="D2"[\s\S]*?<\/c>/,'<c r="D2" t="str"><f>HYPERLINK("https://synthetic.invalid")</f><v>A</v></c>'));
  await assert.rejects(verifyMindmapWorkbook(Buffer.from(zipSync(formula)),parseMindmap(a,'a.json'),sha256(a)),
    (error: any) => error.code === 'ARTIFACT_VERIFICATION_FAILED');
});

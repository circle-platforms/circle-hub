import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { autoCases } from './auto-cases.ts';
function mindmap(count: number) { return { root: { data: { id: 'synthetic-root', text: '合成用例' }, children: [...Array.from({ length: count }, (_, i) => ({ data: { id: `synthetic-${i}`, text: `合成用例 ${i}`, priority: 2, auto: 'YES', autoid: `synthetic-auto-${i}` } })), ...['yes', '', undefined].map((auto, i) => ({ data: { id: `excluded-${i}`, text: '不入选', priority: 2, auto, autoid: `excluded-${i}` } }))] } }; }
test('auto selection requires exact YES and preserves authored document order', () => {
  assert.deepEqual(autoCases(Buffer.from(JSON.stringify(mindmap(5)))), Array.from({ length: 5 }, (_, i) => `synthetic-auto-${i}`));
});
for (const count of [4, 6]) test(`auto selection refuses ${count} cases with actionable actual count`, () => {
  assert.throws(() => autoCases(Buffer.from(JSON.stringify(mindmap(count)))), new RegExp(`找到 ${count} 个`));
});
test('auto selection refuses duplicate missing and imprecise ids and respects plan case rule', () => {
  const raw = mindmap(5); raw.root.children[1]!.data.autoid = raw.root.children[0]!.data.autoid;
  assert.throws(() => autoCases(Buffer.from(JSON.stringify(raw))));
  raw.root.children[1]!.data.autoid = ''; assert.throws(() => autoCases(Buffer.from(JSON.stringify(raw))));
  Object.assign(raw.root.children[1]!.data, { autoid: Number.MAX_SAFE_INTEGER + 1 }); assert.throws(() => autoCases(Buffer.from(JSON.stringify(raw))));
  assert.throws(() => autoCases(Buffer.from(JSON.stringify(mindmap(5))), 'tagged'), /找到 0 个/);
});

test('selection rejects imprecision anywhere and selected ids duplicated by excluded cases', () => {
  const imprecise = mindmap(5); Object.assign(imprecise.root.children[5].data, { autoid: Number.MAX_SAFE_INTEGER + 1 });
  assert.throws(() => autoCases(Buffer.from(JSON.stringify(imprecise))), /文档.*精度.*文本/);
  const duplicate = mindmap(5); duplicate.root.children[5].data.autoid = duplicate.root.children[0].data.autoid;
  assert.throws(() => autoCases(Buffer.from(JSON.stringify(duplicate))), /重复.*case_rule/);
});
test('the optional deployment profile applies the exact plan autoid pattern', () => {
  const bytes = Buffer.from(JSON.stringify(mindmap(5)));
  const profile = { schema: 'runtime-profile@1', workbook: { autoid_pattern: '^synthetic-auto-[0-9]+$' } };
  assert.equal(autoCases(bytes, 'marked', profile).length, 5);
  for (const pattern of ['^[0-9]{18}$', '[', 'unanchored']) assert.throws(() => autoCases(bytes, 'marked', { ...profile, workbook: { autoid_pattern: pattern } }), /autoid_pattern.*--profile/);
});

test('explicit autoids selects exactly those five YES cases in document order', () => {
  const bytes = Buffer.from(JSON.stringify(mindmap(8)));
  const ids = ['synthetic-auto-6', 'synthetic-auto-1', 'synthetic-auto-3', 'synthetic-auto-0', 'synthetic-auto-4'];
  assert.deepEqual(autoCases(bytes, 'marked', undefined, ids), ['synthetic-auto-0', 'synthetic-auto-1', 'synthetic-auto-3', 'synthetic-auto-4', 'synthetic-auto-6']);
  assert.throws(() => autoCases(bytes, 'marked', undefined, ids.slice(0, 4)), /显式列出 4 个/);
  assert.throws(() => autoCases(bytes, 'marked', undefined, [...ids, 'synthetic-auto-2']), /显式列出 6 个/);
  assert.throws(() => autoCases(bytes, 'marked', undefined, ['synthetic-auto-0', 'synthetic-auto-0', 'synthetic-auto-1', 'synthetic-auto-2', 'synthetic-auto-3']), /重复/);
  assert.throws(() => autoCases(bytes, 'marked', undefined, ['synthetic-auto-0', 'synthetic-auto-1', 'synthetic-auto-2', 'synthetic-auto-3', 'excluded-0']), /不在 auto 正好为 YES/);
  assert.throws(() => autoCases(bytes, 'marked', undefined, ['synthetic-auto-0', 'synthetic-auto-1', 'synthetic-auto-2', 'synthetic-auto-3', ' synthetic-auto-4']), /不精确相等/);
});

test('the case CLI records an explicit selection and still refuses an agile response envelope', () => {
  const guide = readFileSync(new URL('./README.md', import.meta.url), 'utf8');
  assert.match(guide, /content 制品/);
  assert.match(guide, /不要喂 original/);
  assert.match(guide, /circle-hub resource read <资源> mindmap <文档键>/);
  assert.match(guide, /circle-hub original export <产物 content 那一行的摘要> --out <仓库外文件>/);
  const envelope = { code: 0, msg: 'synthetic-ok', data: JSON.stringify(mindmap(5)) };
  assert.throws(() => autoCases(Buffer.from(JSON.stringify(envelope))), /原始应答信封.*content 制品.*original export/);
  const dir = mkdtempSync(join(tmpdir(), 'auto-cases-explicit-'));
  try {
    const map = mindmap(8);
    const source = join(dir, 'map.json');
    writeFileSync(source, JSON.stringify(map));
    const ids = ['synthetic-auto-6', 'synthetic-auto-1', 'synthetic-auto-3', 'synthetic-auto-0', 'synthetic-auto-4'];
    const child = spawnSync(process.execPath, ['scripts/real/convert/auto-cases.ts', source, '--out', join(dir, 'out'), '--autoids', ids.join(',')], { encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    const saved = JSON.parse(readFileSync(join(dir, 'out/auto-cases.json'), 'utf8'));
    assert.deepEqual(saved.autoids, ['synthetic-auto-0', 'synthetic-auto-1', 'synthetic-auto-3', 'synthetic-auto-4', 'synthetic-auto-6']);
    assert.equal(saved.selection_source, '选择来源：集成者显式列出');
    assert.ok(!child.stdout.includes('synthetic-auto-0'));
    const plain = spawnSync(process.execPath, ['scripts/real/convert/auto-cases.ts', source, '--out', join(dir, 'plain')], { encoding: 'utf8' });
    assert.equal(plain.status, 1);
    assert.match(plain.stderr, /找到 8 个/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('selection normalizes the two documented local original forms without changing case order', () => {
  const raw = mindmap(5); const expected = autoCases(Buffer.from(JSON.stringify(raw)));
  for (const value of ['\uffff\uffff' + JSON.stringify(raw), JSON.stringify([raw]), '\uffff\uffff' + JSON.stringify([raw.root])]) assert.deepEqual(autoCases(Buffer.from(value)), expected);
  assert.throws(() => autoCases(Buffer.from(JSON.stringify([raw, raw]))), /normalize-mindmap\.ts.*重跑/);
});

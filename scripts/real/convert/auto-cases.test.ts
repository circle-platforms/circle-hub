import { test } from 'node:test';
import assert from 'node:assert/strict';
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

test('selection normalizes the two documented local original forms without changing case order', () => {
  const raw = mindmap(5); const expected = autoCases(Buffer.from(JSON.stringify(raw)));
  for (const value of ['\uffff\uffff' + JSON.stringify(raw), JSON.stringify([raw]), '\uffff\uffff' + JSON.stringify([raw.root])]) assert.deepEqual(autoCases(Buffer.from(value)), expected);
  assert.throws(() => autoCases(Buffer.from(JSON.stringify([raw, raw]))), /normalize-mindmap\.ts.*重跑/);
});

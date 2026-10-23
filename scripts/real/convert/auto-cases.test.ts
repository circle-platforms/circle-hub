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

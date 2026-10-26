import assert from 'node:assert/strict';
import { test } from 'node:test';
import TABLE from '../tables/template-v3.json' with { type: 'json' };
import { categoryFacts, readTemplate } from './template.ts';
import { casesOf } from './cases.ts';
import { warningSink } from './common.ts';
function cases(category_ids?: unknown, title = '没有审计日志测试 audit') {
  return casesOf('d', [{ data: { id: 'r', text: '审计日志' }, children: [1] }, { data: { id: 'c', text: title, priority: 2, resource: ['Functional'], ...(category_ids === undefined ? {} : { category_ids }) }, children: [2] }, { data: { id: 'e', text: '合成结果' }, children: [] }], warningSink());
}
const template = () => { const t = readTemplate(TABLE); assert.ok(typeof t !== 'string'); return t; };
test('audit words and legacy test-type tags supply no category evidence', () => {
  assert.deepEqual(categoryFacts(template(), cases()).filter(c => c.present), []);
});
test('exact authored category ids work without matching words and are deduplicated', () => {
  const facts = categoryFacts(template(), cases(['audit_log', 'functional', 'audit_log'], '合成事项'));
  assert.deepEqual(facts.filter(c => c.present).map(c => [c.id, c.count]), [['functional', 1], ['audit_log', 1]]);
});
test('noncanonical or malformed author declarations are structural errors', () => {
  for (const invalid of [['Audit_log'], [' audit_log'], ['audit_log '], ['审计日志'], ['unknown'], [], 'audit_log', [null]]) {
    assert.throws(() => categoryFacts(template(), cases(invalid)), /category_ids/);
  }
});
test('category rows contain descriptive metadata only and policy retains all required ids', () => {
  for (const row of TABLE.categories) assert.deepEqual(Object.keys(row).sort(), ['description', 'group', 'id', 'label']);
  assert.equal(template().categories.length, 24);
  assert.ok(template().categories.every(c => c.required));
});

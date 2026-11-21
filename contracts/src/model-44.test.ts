import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const model = JSON.parse(readFileSync(new URL('../model.json', import.meta.url), 'utf8'));
const element = (id: string) => model.elements.find((e: { id: string }) => e.id === id)!;

test('K02 leaves conditions out of an entry that has none to say, and keeps disclosing a partly declared one', () => {
  assert.ok(model.version >= 44);
  const k02 = element('K02');
  const field = k02.fields.find((f: string) => f.startsWith('适用条件（'));
  assert.ok(field.includes('没有一个字段带这些信息的条目不存也不显示适用条件和逐字段状态'));
  assert.ok(k02.rules[2].includes('不存不显示适用条件，缺适用条件同样不是无条件适用'));
  assert.ok(k02.rules[2].includes('其余字段按 declaration_status.undeclared 披露'));
  assert.ok(k02.changes44.some((text: string) => text.includes('决定 159')));
});

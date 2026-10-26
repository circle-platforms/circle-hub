import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { projectDefects } from './projection.ts';
import { checkQuoteSources } from './checks.ts';
import { quoteSubject } from './subjects.ts';
const digest = 'b'.repeat(64);
const input = { context: { line: '10.7' }, inputs: [{ slot: 'defects', external: 'plm:bug:910001', sha256: digest, model: { id: '910001', title: '合成缺陷', fix_field: 'repair_notes', fields: { repair_notes: '合成修复说明' } } }] };
test('without a manual the run discloses the missing fact and only the configured fix source is allowed', () => {
  const result = projectDefects(input); assert.ok(!('error' in result), JSON.stringify(result));
  assert.equal((result.items[0].fields.allowed_quote_sources as { manual: unknown }).manual, null);
  assert.match(result.warnings[0].message, /10\.7.*manual:cli:10\.7/); assert.match(result.warnings[0].message, /repair_notes/); assert.match(result.warnings[0].message, /重开/);
  const subject = (reference: string) => quoteSubject({ item: { id: '910001', fields: result.items[0].fields }, slots: { cases: [{ data: { expected: [{ text: '合成', quote: { text: '合成', reference } }] } }] } });
  assert.equal(checkQuoteSources({ subject: subject(`src:${digest}/json@1/p/fields/repair_notes`) })[0].verdict, 'support');
  assert.equal(checkQuoteSources({ subject: subject(`src:${'c'.repeat(64)}/markdown@1/b/0`) })[0].verdict, 'refute');
});

for (const line of ['10.7', null]) test(`manual refusal gives a usable optional binding action for line ${line}`, () => {
  const external = 'manual:cli:10.8';
  const result = projectDefects({ ...input, context: { line }, inputs: [...input.inputs, { slot: 'manual', external, sha256: 'c'.repeat(64), model: {} }] });
  assert.ok('error' in result); assert.equal(result.error.code, 'defect-to-case.manual_mismatch');
  assert.match(result.error.message, /^输入槽 manual：/);
  if (line) {
    assert.ok(result.error.message.includes(external)); assert.ok(result.error.message.includes(line));
    assert.match(result.error.fix ?? '', /不绑定 manual/); assert.match(result.error.fix ?? '', /修复说明字段/);
  } else {
    assert.match(result.error.message, /没有版本线/); assert.match(result.error.fix ?? '', /不绑定 manual/);
    assert.ok(!result.error.fix?.includes('manual:cli:'));
  }
});
test('multiple manuals are disclosed as multiple bindings and offer leaving the optional slot unbound', () => {
  const manuals = ['manual:cli:10.7', 'manual:cli:10.8'].map(external => ({ slot: 'manual', external, sha256: 'c'.repeat(64), model: {} }));
  const result = projectDefects({ ...input, inputs: [...input.inputs, ...manuals] });
  assert.ok('error' in result); assert.match(result.error.message, /2.*手册/); assert.match(result.error.fix ?? '', /不绑定 manual/);
});

test('manual refusal documents the missing cross-slot error path contract', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(readme, /PackError\.path/);
  assert.ok(readme.includes('/inputs/<declared slot>'));
  assert.ok(readme.includes('/inputs/manual'));
});

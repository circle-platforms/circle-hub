import assert from 'node:assert/strict';
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

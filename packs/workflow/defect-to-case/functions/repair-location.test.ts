import assert from 'node:assert/strict';
import { test } from 'node:test';
import { quoteSubject } from './subjects.ts';
import { checkGroundedReading, checkQuoteSources } from './checks.ts';
const allowed = { defect: 'b'.repeat(64), fix_field: 'repair/notes', manual: null };
test('source violations name the original case/expected indexes and the concrete allowed selector', () => {
  const subject = quoteSubject({ item: { id: 'synthetic', fields: { allowed_quote_sources: allowed } }, slots: { cases: [{ data: { expected: [{ text: 'Missing quote' }] } }, { data: { expected: [{ text: 'Missing quote' }, { text: '合成', quote: { reference: `src:${'c'.repeat(64)}/json@1/p/fields/other`, text: '合成' } }] } }] } });
  const out = checkQuoteSources({ subject });
  assert.match(out[0].statement, /第 2 个起草用例第 2 个期望结果/);
  assert.ok(out[0].statement.includes(`src:${allowed.defect}/json@1/p/fields/repair%2Fnotes`));
});
test('verbatim violations use a submission-relative slots/data pointer the engine can preserve', () => {
  const out = checkGroundedReading({ subject: { item: 'synthetic', slots: { cases: [{ data: { expected: [{ text: '改写', quote: { reference: `src:${allowed.defect}/json@1/p/fields/fix`, text: '原文' } }] } }] } } });
  assert.equal(out[0].pointer, '/slots/cases/0/data/expected/0/text');
});

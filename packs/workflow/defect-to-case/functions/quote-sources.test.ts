import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectDefects } from './projection.ts';
import { quoteSubject } from './subjects.ts';
import { checkQuoteSources } from './checks.ts';
import type { BoundInput } from '../../../../contracts/src/pack.ts';

const defect = 'b'.repeat(64), manual = 'c'.repeat(64);
const context = { product: 'synthetic', line: '10.7', names: [], build: 'Synthetic_10_7', root: 'a'.repeat(64), parameters: {}, groups: [] };
const bound = (slot: string, external: string, sha256: string, model: unknown): BoundInput => ({ slot, external, sha256, model, media_type: 'application/json', parser: 'json@1', meta: null });
const bug = { id: '910001', title: '合成缺陷', fix_field: 'repair_notes', fields: { repair_notes: '合成修复说明', steps: '合成步骤' }, html_fields: ['repair_notes', 'steps'] };
const manualInput = bound('manual', 'manual:cli:10.7', manual, '合成手册');
function projected(model: Record<string, unknown> = bug, extra: BoundInput[] = [manualInput]) {
  return projectDefects({ inputs: [bound('defects', 'plm:bug:910001', defect, model), ...extra], context });
}
function subject(reference: string) {
  const out = projected(); assert.ok(!('error' in out));
  return quoteSubject({ item: { id: '910001', fields: out.items[0].fields }, context, slots: { cases: [{ data: { expected: [{ text: '合成', quote: { reference, text: '合成' } }] } }] } });
}

test('projection freezes configured field and both original digests, and fails closed without the setting', () => {
  const result = projected(); assert.ok(!('error' in result));
  assert.deepEqual(result.items[0].fields.allowed_quote_sources, { defect, fix_field: 'repair_notes', fix_notes: null, manual });
  for (const fix_field of [undefined, null, '', 2]) {
    const out = projected({ ...bug, fix_field }); assert.ok('error' in out);
    assert.match(out.error.message + out.error.fix, /settings\.bug_fix_field/);
  }
});
test('a supplied manual must be unique and on the selected version line', () => {
  for (const inputs of [[manualInput, manualInput], [{ ...manualInput, external: 'manual:cli:10.8' }]]) {
    const out = projected(bug, inputs); assert.ok('error' in out); assert.match(out.error.fix, /manual/);
  }
});
test('only the configured field of this defect or the bound manual may supply quotations', () => {
  for (const reference of [`src:${defect}/json@1/p/fields/repair_notes`, `src:${defect}/json@1/p/fields/repair_notes:0-6`, `src:${manual}/markdown@1/s/synthetic`, `src:${manual}`]) {
    assert.equal(checkQuoteSources({ subject: subject(reference) })[0].verdict, 'support', reference);
  }
  for (const reference of [`src:${defect}/json@1/p/fields/steps`, `src:${defect}/json@1/p/title`, `src:${defect}`, `src:${defect}/json@1/p/fields/repair_notes/other`, `src:${'d'.repeat(64)}/json@1/p/fields/repair_notes`, `tree:${context.root}/manual`, `rec:${defect}#/fields/repair_notes`]) {
    const out = checkQuoteSources({ subject: subject(reference) });
    assert.equal(out[0].verdict, 'refute', reference); assert.equal(out[0].tier, 'blocking');
    assert.equal(out[0].code, 'defect-to-case.quote_source_forbidden'); assert.match(out[0].statement, /修正/);
  }
});
test('a non-empty fix_notes comment is quotable when the configured field is absent', () => {
  const model = { id: '910001', title: '合成缺陷', fix_field: null, fix_notes: [{ action: 'assigned', date: '2026-04-02', actor: 'synthetic-dev', comment: '合成分配说明', index: 1 }, { action: 'resolved', comment: '', index: 3 }], fields: {} };
  const out = projected(model); assert.ok(!('error' in out));
  assert.deepEqual(out.items[0].fields.allowed_quote_sources, { defect, fix_field: null, fix_notes: [0], manual });
  const input = { item: { id: '910001', fields: out.items[0].fields }, slots: { cases: [{ data: { expected: [{ text: '合成', quote: { reference: `src:${defect}/json@1/p/fix_notes/0/comment`, text: '合成' } }] } }] } };
  assert.equal(checkQuoteSources({ subject: quoteSubject(input) })[0].verdict, 'support');
  const other = { item: { id: '910001', fields: out.items[0].fields }, slots: { cases: [{ data: { expected: [{ text: '合成', quote: { reference: `src:${defect}/json@1/p/fix_notes/1/comment`, text: '合成' } }] } }] } };
  assert.equal(checkQuoteSources({ subject: quoteSubject(other) })[0].verdict, 'refute');
  const neither = projected({ id: '910001', title: '合成缺陷', fields: { fix: '不能兜底' } });
  assert.ok('error' in neither); assert.match(neither.error.fix, /settings\.bug_fix_actions/);
});
test('field names with escaped path characters are matched as one exact selector segment', () => {
  const out = projected({ ...bug, fix_field: 'repair/notes', fields: { 'repair/notes': '合成修复说明' } }); assert.ok(!('error' in out));
  const input = { item: { id: '910001', fields: out.items[0].fields }, slots: { cases: [{ data: { expected: [{ text: '合成', quote: { reference: `src:${defect}/json@1/p/fields/repair%2Fnotes`, text: '合成' } }] } }] } };
  assert.equal(checkQuoteSources({ subject: quoteSubject(input) })[0].verdict, 'support');
});

// Decision 159 (K02 F[6], R[2], model 44): an entry with no declared, judged or conflicting condition carries no
// applicability. The empty marker a producer writes is not stored, and a read says nothing of such an entry's conditions.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { entryContentOf, entryDigest } from './digest.ts';
import { applicabilityFields, withoutEmptyApplicability } from './applicability-fields.ts';

const marker = (declared: string[], conflicted: string[] = []) => ({ schema: 'applicability-state@1', grammar: 'synthetic@1', declaration_status: declared.length ? 'declared' : 'undeclared', judgment_status: 'unjudged', declared_fields: declared, conflicted_fields: conflicted, criteria_digest: 'c'.repeat(64) });

test('a marker that declares nothing is dropped when the entry is produced; the rest of the data stays', () => {
  const content = entryContentOf({ kind: 'behaviour', statement: '合成说明', data: { section: ['甲'], applicability_state: marker([]) }, applicability: null });
  assert.deepEqual(content.data, { section: ['甲'] });
  assert.equal(entryDigest(content), entryDigest(entryContentOf({ kind: 'behaviour', statement: '合成说明', data: { section: ['甲'] }, applicability: null })), 'the same entry as one produced without a marker');
});

test('a marker with a declared or conflicting field, or an entry with a value, keeps its marker', () => {
  const declared = { section: ['甲'], applicability_state: marker(['models']) };
  assert.deepEqual(entryContentOf({ kind: 'behaviour', statement: 'x', data: declared, applicability: { models: ['M1'] } }).data, declared);
  const conflicted = { applicability_state: marker([], ['platforms']) };
  assert.deepEqual(entryContentOf({ kind: 'behaviour', statement: 'x', data: conflicted, applicability: null }).data, conflicted);
  const valued = { applicability_state: marker([]) };
  assert.deepEqual(entryContentOf({ kind: 'behaviour', statement: 'x', data: valued, applicability: { models: ['M1'] } }).data, valued);
});

test('an entry without a marker and without a value reads as declaring nothing, with no missing source to report', () => {
  const fields = applicabilityFields({ section: ['甲'] }, null);
  for (const state of Object.values(fields)) {
    assert.equal(state.declaration_status, 'undeclared');
    assert.equal(state.missing, undefined);
  }
});

test('only an entry with something to say keeps its applicability, fields and admission context', () => {
  const context = { composition: 'a'.repeat(64), criteria_digest: 'b'.repeat(64) };
  const empty = { entry: 'e'.repeat(64), statement: 's', applicability_fields: applicabilityFields({}, null), applicability_context: context };
  assert.deepEqual(withoutEmptyApplicability(empty), { entry: 'e'.repeat(64), statement: 's' });
  const judged = applicabilityFields({}, null);
  judged.models.judgment_status = 'judged';
  judged.models.judgments = ['d'.repeat(64)];
  assert.ok(withoutEmptyApplicability({ ...empty, applicability_fields: judged }).applicability_fields, 'a judged field is kept');
  const declared = applicabilityFields({ applicability_state: marker(['models']) }, { models: ['M1'] });
  assert.ok(withoutEmptyApplicability({ ...empty, applicability: '型号 M1', applicability_fields: declared }).applicability_context, 'a declared field is kept');
  const unread = applicabilityFields({}, null);
  unread.platforms.missing = '本节点回注尚未完全核读';
  assert.ok(withoutEmptyApplicability({ ...empty, applicability_fields: unread }).applicability_fields, 'judgments not yet read are said');
});

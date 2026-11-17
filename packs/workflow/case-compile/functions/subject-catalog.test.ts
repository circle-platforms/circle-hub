import assert from 'node:assert/strict';
import { test } from 'node:test';
import { opened, sealed } from './text.ts';
import { planSubject, workbookSubject } from './subject.ts';

// The rule of hub/runs/engine/evaluate.ts: every reference-like string in a subject is read, against one budget per submission.
const references = (value: unknown, out = new Set<string>()): Set<string> => {
  if (typeof value === 'string') { if (value.length <= 8192 && /^(?:src|tree|entry|rec):/.test(value)) out.add(value); }
  else if (Array.isArray(value)) for (const item of value) references(item, out);
  else if (typeof value === 'object' && value !== null) for (const item of Object.values(value)) references(item, out);
  return out;
};
const root = 'a'.repeat(64);
const entries = Array.from({ length: 300 }, (_, i) => ({ words: ['demo', `w${i}`], reference: `tree:${root}/commands/demo/w${i}`, signatures: [{ params: [], reference: `tree:${root}/commands/demo/w${i}/s` }] }));
const input = { item: { id: 'one', fields: {} }, slots: {}, catalog: entries, catalog_complete: true, context: { root, groups: [{ kind: 'case-compile', plan_set: [{ item: 'one', plan: {}, command_catalog: { root, complete: true, entries } }] }] } };

test('catalog entries in a subject are not reference-like strings, however many there are', () => {
  assert.equal(references({ entries }).size, 600);
  assert.equal(references(planSubject(input)).size, 0);
  assert.equal(references(workbookSubject(input)).size, 0);
});

test('a sealed catalog opens to exactly what went in, and an unsealed value stays as it is', () => {
  const catalog = { root, complete: true, entries };
  assert.deepEqual(opened(sealed(catalog)), catalog);
  assert.deepEqual(opened(planSubject(input).command_catalog), catalog);
  assert.deepEqual(opened(catalog), catalog);
  assert.equal(opened(undefined), undefined);
  assert.equal(sealed(null), null);
  assert.deepEqual(opened((workbookSubject(input) as { plan_set: unknown }).plan_set), input.context.groups[0].plan_set);
});

test('a record that merely has a text field is not taken for a sealed value', () => {
  const value = { sealed: '{}', other: 1 };
  assert.deepEqual(opened(value), value);
});

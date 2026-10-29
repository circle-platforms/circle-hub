import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boundView, caseEntry, indexViewOf } from '../../traceability/functions/test-support.ts';
import project from './project.ts';
import check from './check.ts';

function run(view: Record<string, unknown>) {
  return project({ inputs: [boundView('stories', { stories: [{ id: '33001', status: 'synthetic' }], unread: [] }, 'plm:stories:33001'), boundView('cases', view)] }) as any;
}

test('a truncated view without complete key-space evidence cannot prove an absent story', () => {
  const view = indexViewOf('case', 'stories', [], { truncated: true });
  const result = run(view);
  assert.equal(result.error?.code, 'story-traceability.invalid_input');
  assert.match(result.error.message, /缺少|不完整/);
  assert.match(result.error.fix, /重新|补/);
});

test('a legacy untruncated view without a key-space fact cannot prove an absent story', () => {
  const view = indexViewOf('case', 'stories', []);
  const result = run(view);
  assert.equal(result.error?.code, 'story-traceability.invalid_input');
  assert.match(result.error.message, /缺少|不完整/);
  assert.match(result.error.fix, /重新|补/);
});

test('a per-key cut plus an unresolved feeding gap cannot prove absence', () => {
  const view = indexViewOf('case', 'stories', [caseEntry({ defects: [], stories: ['99'], case: 'synthetic' })], { truncated: true });
  Object.assign(view, { cut_keys: ['99'], key_space_complete: false });
  const result = run(view);
  assert.equal(result.error?.code, 'story-traceability.invalid_input');
});

test('known links remain observable as a lower bound when the key space is incomplete', () => {
  const view = indexViewOf('case', 'stories', [caseEntry({ defects: [], stories: ['33001'], case: 'synthetic' })], { truncated: true });
  Object.assign(view, { key_space_complete: false });
  const result = run(view);
  assert.ok(!result.error);
  assert.equal(result.items[0].fields.case_count_lower_bound, true);
  const outcomes = check({ subject: { items: result.items, context: { groups: result.groups } } }) as any[];
  assert.ok(outcomes.some(outcome => outcome.verdict === 'support' && outcome.statement.includes('至少')));
});

test('a completeness claim cannot override a narrowed or incomplete source scope', () => {
  const narrowed = indexViewOf('case', 'stories', []);
  Object.assign(narrowed, { only: ['33001'], key_space_complete: true });
  assert.equal(run(narrowed).error?.code, 'story-traceability.invalid_input');
  const incompleteScope = indexViewOf('case', 'stories', []);
  Object.assign(incompleteScope, { scope: { complete: false } });
  assert.equal(run(incompleteScope).error?.code, 'story-traceability.invalid_input');
});

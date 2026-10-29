import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boundView, caseEntry, indexViewOf } from '../../traceability/functions/test-support.ts';
import project from './project.ts';
import check from './check.ts';

function exampleView() {
  return indexViewOf('case', 'stories', [
    caseEntry({ defects: [], stories: ['21'], case: 'synthetic-a' }),
    caseEntry({ defects: [], stories: ['99'], case: 'synthetic-b' }),
  ]);
}
function run(options: { count?: unknown; notes?: string[]; metadata?: boolean; truncated?: boolean; view?: ReturnType<typeof exampleView> } = {}) {
  const view = structuredClone(options.view ?? exampleView());
  Object.assign(view, { key_space_complete: true, cut_keys: ['99'], truncated: options.truncated ?? true, notes: options.notes ?? [] });
  const cases = boundView('cases', view);
  if (options.metadata !== false) cases.meta = { index_excluded_entries: options.count ?? 0, index_view_sha256: cases.sha256 };
  return project({ inputs: [boundView('stories', { stories: [{ id: '21', status: 'synthetic' }], unread: [] }, 'plm:stories:21'), cases] }) as any;
}

test('free-text notes cannot change coverage when the structural omission count is zero', () => {
  const view = exampleView();
  const plain = run({ view, count: 0, notes: [] });
  const changed = run({ view, count: 0, notes: ['1 个条目的文字有凭据扫描命中，没有放进这个视图'] });
  assert.equal(plain.items[0].fields.case_count_lower_bound, false);
  assert.equal(changed.items[0].fields.case_count_lower_bound, false);
});

test('a structural omission count limits coverage even without a descriptive note', () => {
  const result = run({ count: 1, notes: [] });
  assert.equal(result.items[0].fields.case_count_lower_bound, true);
  assert.equal(result.items[0].fields.coverage_complete, false);
});

test('a truncated legacy view with no omission fact does not claim an exact count', () => {
  const result = run({ metadata: false });
  assert.equal(result.items[0].fields.case_count_lower_bound, true);
  assert.equal(result.items[0].fields.coverage_complete, false);
  const [outcome] = check({ subject: { items: result.items, context: { groups: result.groups } } }) as any[];
  assert.ok(outcome.data.gaps.length > 0);
  assert.ok(outcome.data.next_actions.length > 0);
  assert.ok(outcome.statement.includes('下一步'));
});

test('malformed omission metadata is a structural refusal', () => {
  const result = run({ count: -1 });
  assert.equal(result.error?.code, 'story-traceability.invalid_input');
});

test('metadata for a different view cannot establish an exact count', () => {
  const view = indexViewOf('case', 'stories', [caseEntry({ defects: [], stories: ['21'], case: 'synthetic-a' })]);
  Object.assign(view, { key_space_complete: true, cut_keys: ['99'], truncated: true });
  const cases = boundView('cases', view);
  cases.meta = { index_excluded_entries: 0, index_view_sha256: 'f'.repeat(64) };
  const result = project({ inputs: [boundView('stories', { stories: [{ id: '21' }], unread: [] }, 'plm:stories:21'), cases] }) as any;
  assert.equal(result.items[0].fields.case_count_lower_bound, true);
});

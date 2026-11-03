// Narrowed completeness (1.0.16): a case index narrowed by only= proves absence for the ids it requested when the Hub marks
// it only_complete, never for an id it did not request, and never when the flag is false, missing or contradicted.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boundView, caseEntry, indexViewOf } from '../../traceability/functions/test-support.ts';
import project from './project.ts';
import check from './check.ts';

function run(view: Record<string, unknown>, ids: string[]) {
  return project({ inputs: [boundView('stories', { stories: ids.map(id => ({ id, status: 'synthetic' })), unread: [] }, `plm:stories:${ids.join('+')}`), boundView('cases', view)] }) as any;
}
function narrowed(only: string[], entries = [caseEntry({ defects: [], stories: ['0021'], case: 'synthetic' })], flag: unknown = true) {
  const view = indexViewOf('case', 'stories', entries, { truncated: false });
  Object.assign(view, { only, only_complete: flag, key_space_complete: false });
  return view;
}

test('a complete narrowed view proves absence for its requested ids and keeps the normalized hit', () => {
  const result = run(narrowed(['21', '33001']), ['21', '33001']);
  assert.equal(result.error, undefined, result.error?.message);
  const byId = Object.fromEntries(result.items.map((item: any) => [item.fields.id, item.fields]));
  assert.equal(byId['21'].indexed_match_count, 1);
  assert.equal(byId['21'].coverage_complete, true);
  assert.equal(byId['33001'].indexed_match_count, 0);
  assert.equal(byId['33001'].coverage_complete, true);
  assert.equal(result.groups[0].view.only_complete, true);
  const outcomes = check({ subject: { items: result.items, context: { groups: result.groups } } }) as any[];
  assert.ok(outcomes.every(outcome => outcome.verdict === 'support'), JSON.stringify(outcomes.map(o => o.statement)));
  assert.ok(outcomes.every(outcome => outcome.data.coverage.only_complete === true));
});

test('an id the narrowed view did not request stays undetermined', () => {
  const result = run(narrowed(['21']), ['21', '44']);
  assert.equal(result.error?.code, 'story-traceability.invalid_input');
  assert.match(result.error.message, /缺少需求 44/);
  assert.match(result.error.fix, /only=<这些编号>/);
});

test('a narrowed view without a true only_complete proves no absence', () => {
  for (const flag of [false, undefined]) {
    const view = narrowed(['33001'], [], flag);
    if (flag === undefined) delete view.only_complete;
    const result = run(view, ['33001']);
    assert.equal(result.error?.code, 'story-traceability.invalid_input', String(flag));
  }
});

test('an only_complete claim that contradicts the view is refused', () => {
  const withoutOnly = indexViewOf('case', 'stories', []);
  Object.assign(withoutOnly, { only_complete: true });
  assert.match(run(withoutOnly, ['33001']).error?.message ?? '', /only_complete|所列取值完整/);
  const skipped = narrowed(['33001'], []);
  Object.assign(skipped, { skipped: 1 });
  assert.equal(run(skipped, ['33001']).error?.code, 'story-traceability.invalid_input');
  const incompleteScope = narrowed(['33001'], []);
  Object.assign(incompleteScope, { scope: { complete: false } });
  assert.equal(run(incompleteScope, ['33001']).error?.code, 'story-traceability.invalid_input');
  const notBoolean = narrowed(['33001'], [], 'yes');
  assert.match(run(notBoolean, ['33001']).error?.message ?? '', /only_complete 不是布尔值/);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCompactIndex } from './compact-index.ts';
import { checkDuplicate } from './checks.ts';
import { SYNTHETIC_CATALOG, SYNTHETIC_INDEX_VIEW, makeGoodDraft } from '../testing/fixtures.ts';
function compare(indexed: string, draftTitle: string) {
  const view = structuredClone(SYNTHETIC_INDEX_VIEW); Object.values(view.entries)[0].data.title = indexed;
  const compact = buildCompactIndex(view);
  const draft = makeGoodDraft(); draft.title = draftTitle; draft.steps = [{ command: 'show health detail' }];
  return { compact, outcomes: checkDuplicate({ subject: { item: 'synthetic-defect', drafts: [draft], indexed_cases: compact }, catalog: SYNTHETIC_CATALOG }) };
}
test('equal long titles compare in full and an eighty-unit prefix does not become a duplicate', () => {
  const title = '合成标题'.repeat(23);
  assert.equal(compare(title, title).outcomes[0].verdict, 'refute');
  assert.equal(compare(title, title.slice(0, 80)).outcomes[0].verdict, 'support');
});
test('a display cut across a surrogate pair cannot corrupt the comparison key or display text', () => {
  const title = 'a'.repeat(79) + '😀' + 'Full tail';
  const result = compare(title, title);
  assert.equal(result.outcomes[0].verdict, 'refute');
  const held = Object.values(result.compact.by_commands)[0][0];
  assert.equal(held.title.isWellFormed(), true);
});

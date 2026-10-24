import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCompactIndex } from './compact-index.ts';
import { checkDuplicate } from './checks.ts';
import { SYNTHETIC_CATALOG, SYNTHETIC_INDEX_VIEW, makeDuplicateDraft } from '../testing/fixtures.ts';
const displayTitle = (raw: string): string => {
  // The same display rule the compact index applies to a case's title (compact-index.ts cuts at 80 units).
  const cut = raw.slice(0, 80);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
};
function compare(indexed: string, draftTitle: string) {
  const view = structuredClone(SYNTHETIC_INDEX_VIEW); Object.values(view.entries)[0].data.title = indexed;
  const compact = buildCompactIndex(view);
  const draft = makeDuplicateDraft(); draft.title = draftTitle; 
  return { compact, outcomes: checkDuplicate({ subject: { item: 'synthetic-defect', drafts: [draft], indexed_cases: compact }, catalog: SYNTHETIC_CATALOG }), held: displayTitle(indexed) };
}
test('titles of any length or spelling are display only for the same structure', () => {
  const title = '合成标题'.repeat(23);
  const shown = displayTitle(title);
  assert.equal(compare(title, shown).outcomes[0].verdict, 'refute');
  assert.equal(compare(title, shown.slice(0, 40)).outcomes[0].verdict, 'refute');
  // No folding: a case-insensitive or spacing-variant spelling of the same title is not a duplicate (10-24 rule).
  assert.equal(compare('Show Health', 'show health').outcomes[0].verdict, 'refute');
  assert.equal(compare('Show  Health', 'Show Health').outcomes[0].verdict, 'refute');
});
test('the held title stays well-formed display text', () => {
  const title = 'a'.repeat(79) + '😀' + 'Full tail';
  const result = compare(title, displayTitle(title));
  assert.equal(result.outcomes[0].verdict, 'refute');
  const held = Object.values(result.compact.by_commands)[0][0];
  assert.equal(held.title.isWellFormed(), true);
});

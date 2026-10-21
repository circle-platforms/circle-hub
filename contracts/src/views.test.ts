import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ImpactView, ViewEntry } from './views.ts';
import { schemas } from './views.ts';

const H1 = 'a'.repeat(64);
const H2 = 'b'.repeat(64);
const H3 = 'c'.repeat(64);
const ROOT_A = '1'.repeat(64);
const ROOT_B = '2'.repeat(64);

const entry = (digest: string, kind: string, statement: string) => ({
  entry: digest,
  kind,
  statement,
  data: {},
  reference: `tree:${ROOT_B}/commands/show@${digest}`,
});

const view = {
  schema: 'impact-view@1',
  product: 'widget',
  from: { build: 'Rel_W_1_0_1', root: ROOT_A },
  to: { build: 'Rel_W_1_0_2', root: ROOT_B },
  changed_kinds: ['definition', 'behaviour'],
  attached_kinds: ['case'],
  changes: [{ path: '/commands/show', change: 'modified', before: [H1], after: [H2] }],
  placements: [{ path: '/commands/show', from: [H3], to: [H3] }],
  entries: { [H2]: entry(H2, 'definition', 'show x'), [H3]: entry(H3, 'case', 'a case') },
  totals: { changed_paths: 1, attached_from: 1, attached_to: 1 },
  truncated: false,
  notes: [],
};

test('an impact view parses and a wrong one is refused', () => {
  assert.ok(ImpactView.safeParse(view).success);
  assert.ok(!ImpactView.safeParse({ ...view, schema: 'impact-view@2' }).success, 'the schema is pinned');
  assert.ok(!ImpactView.safeParse({ ...view, changes: [{ path: '/commands/show', change: 'renamed', before: [], after: [] }] }).success, 'change kinds come from the axis');
  assert.ok(!ImpactView.safeParse({ ...view, changed_kinds: [] }).success, 'at least one changed kind');
  assert.ok(!ImpactView.safeParse({ ...view, changed_kinds: ['command'] }).success, 'entry kinds come from the axis');
  assert.ok(!ImpactView.safeParse({ ...view, entries: { nothex: entry(H2, 'definition', 'x') } }).success, 'entries are keyed by digest');
  assert.ok(!ImpactView.safeParse({ ...view, extra: 1 }).success, 'unknown keys are refused');
});

test('a view entry carries a tree reference, never a source reference', () => {
  assert.ok(ViewEntry.safeParse(entry(H2, 'case', 's')).success);
  assert.ok(!ViewEntry.safeParse({ ...entry(H2, 'case', 's'), reference: `src:${H2}` }).success);
});

test('the view is registered for the generated schemas', () => {
  assert.deepEqual(Object.keys(schemas), ['impact-view@1']);
});

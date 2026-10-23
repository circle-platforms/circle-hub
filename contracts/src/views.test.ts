import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FacetView, ImpactView, IndexView, ViewEntry, schemas } from './views.ts';

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
  skipped: { from: 0, to: 0 },
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
  assert.ok(!ImpactView.safeParse({ ...view, skipped: { from: -1, to: 0 } }).success, 'a skipped count is not negative');
  assert.ok(!ImpactView.safeParse({ ...view, skipped: undefined }).success, 'the skipped counts are always stated');
});

test('a view entry carries a tree reference, never a source reference', () => {
  assert.ok(ViewEntry.safeParse(entry(H2, 'case', 's')).success);
  assert.ok(!ViewEntry.safeParse({ ...entry(H2, 'case', 's'), reference: `src:${H2}` }).success);
});

test('the view is registered for the generated schemas', () => {
  assert.deepEqual(Object.keys(schemas), ['links-view@1', 'impact-view@1', 'facet-view@1', 'index-view@1']);
});

test('a facet view counts entries by the values of data fields', () => {
  const facet = {
    schema: 'facet-view@1',
    product: 'widget',
    build: { build: 'Rel_W_1_0_2', root: ROOT_B },
    kind: 'case',
    by: ['line', 'has_expected'],
    rows: [
      { values: { line: '1.0', has_expected: true }, count: 12 },
      { values: { line: '1.0', has_expected: false }, count: 2 },
      { values: { line: null, has_expected: true }, count: 1 },
    ],
    total: 15,
    totals: {empty:{line:1,has_expected:0}},
    truncated: false,
    skipped: 0,
    notes: [],
  };
  assert.ok(FacetView.safeParse(facet).success);
  assert.ok(!FacetView.safeParse({...facet,totals:undefined}).success, 'empty counts are always present');
  for (const empty of [{line:1},{line:1,has_expected:-1},{line:16,has_expected:0},{line:1,has_expected:0,extra:0}]) {
    assert.ok(!FacetView.safeParse({...facet,totals:{empty}}).success);
  }
  assert.ok(!FacetView.safeParse({ ...facet, by: [] }).success, 'at least one field');
  assert.ok(!FacetView.safeParse({ ...facet, by: ['Line'] }).success, 'a field name is lower case');
  assert.ok(!FacetView.safeParse({ ...facet, rows: [{ values: { line: { nested: 1 } }, count: 1 }] }).success, 'values are scalars');
  assert.ok(!FacetView.safeParse({ ...facet, rows: [{ values: {}, count: 0 }] }).success, 'a row counts at least one entry');
});

test('an index view maps a data value to the entries that carry it', () => {
  const index = {
    schema: 'index-view@1',
    product: 'widget',
    build: { build: 'Rel_W_1_0_2', root: ROOT_B },
    kind: 'case',
    key: 'defects',
    keys: { '61061': [H3] },
    entries: { [H3]: entry(H3, 'case', 'a case') },
    total_keys: 1,
    total_entries: 1,
    truncated: false,
    skipped: 0,
    notes: [],
  };
  assert.ok(IndexView.safeParse(index).success);
  assert.ok(IndexView.safeParse({ ...index, only: ['61061'], cut_keys: [] }).success);
  assert.ok(IndexView.safeParse({ ...index, cut_keys: ['61061'] }).success);
  assert.ok(!IndexView.safeParse({ ...index, only: [61061] }).success);
  assert.ok(!IndexView.safeParse({ ...index, cut_keys: [61061] }).success);
  assert.ok(!IndexView.safeParse({ ...index, keys: { '61061': ['nothex'] } }).success, 'entries are named by digest');
  assert.ok(!IndexView.safeParse({ ...index, key: 'Defects' }).success);
});

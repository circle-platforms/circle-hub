// Reading a bound input as the facet view the board needs (facet-view@1, kind case, the five by fields; the caller may add
// priority). The model is authoritative. A view that is not this one, or is malformed, is a refusal the caller can fix.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BY, boundView, facetRow, facetViewOf } from './test-support.ts';
import { readFacetView } from './views.ts';

const base = () => facetViewOf([facetRow({ line: '10.6.1', module: 'SSL', has_expected: true, vague_expected: false, negative: false }, 10)]);

describe('readFacetView', () => {
  it('reads a well-formed view: rows, total, skipped, source reference', () => {
    const bound = boundView('facets', { ...base(), skipped: 2, notes: ['有来源没读'] });
    const read = readFacetView(bound, 'facets');
    assert.ok(read.ok);
    // 现行必填是 line、module、has_expected、negative、test_type_status；默认视图仍可带 vague_expected，只是不再当判断。
    assert.deepEqual(read.view.by, BY);
    assert.equal(read.view.rows.length, 1);
    assert.deepEqual([read.view.total, read.view.skipped, read.view.truncated], [10, 2, false]);
    assert.deepEqual(read.view.notes, ['有来源没读']);
    assert.equal(read.view.source, `src:${bound.sha256}`);
  });

  it('accepts a view whose by also carries priority (the caller may add it)', () => {
    const by = ['line', 'module', 'priority', 'has_expected', 'negative', 'test_type_status'];
    const view = facetViewOf([facetRow({ line: '10.6.1', module: 'SSL', priority: 'P1', has_expected: true, vague_expected: false, negative: false }, 4)], { by });
    const read = readFacetView(boundView('facets', view), 'facets');
    assert.ok(read.ok);
    assert.deepEqual(read.view.by, by);
  });

  it('refuses a view of another schema or kind, or one missing a needed by field', () => {
    const wrong: Array<Record<string, unknown>> = [
      { ...base(), schema: 'index-view@1' },
      { ...base(), kind: 'defect' },
      { ...base(), by: ['line', 'module', 'has_expected', 'negative'] },
      { ...base(), by: ['line', 'line', 'module', 'has_expected', 'vague_expected', 'negative'] },
    ];
    for (const view of wrong) {
      const read = readFacetView(boundView('facets', view), 'facets');
      assert.ok(!read.ok);
      if (!read.ok) assert.equal(read.code, 'wrong_view');
    }
  });

  it('refuses a malformed view: a row without a positive integer count, a non-scalar value, a bad total', () => {
    const wrong: Array<Record<string, unknown>> = [
      { ...base(), rows: [{ values: { line: '10.6.1' }, count: 0 }] },
      { ...base(), rows: [{ values: { line: '10.6.1' }, count: 1.5 }] },
      { ...base(), rows: [{ values: { line: ['10.6.1'] }, count: 2 }] },
      { ...base(), total: -1 },
      { ...base(), build: { build: 'B', root: 'not-a-digest' } },
    ];
    for (const view of wrong) {
      const read = readFacetView(boundView('facets', view), 'facets');
      assert.ok(!read.ok);
      if (!read.ok) assert.equal(read.code, 'wrong_view');
    }
  });
});

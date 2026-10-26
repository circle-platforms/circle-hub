// The board grouping and metrics: one group per (line, module) of the facet view (module null is the group 'unplaced'),
// rows that split a group by the other fields summed. Missing is has_expected false. Vague is not read from the facet
// flag vague_expected: that flag is not an expectation judgment, so the vague ratio stays 0/0 until judgments are
// applied. Negative counts only when test_type_status is declared and negative is boolean; otherwise the row is
// type_unclassified and stays out of the negative denominator. Ratios are exact fractions {num, den}, rounded only for
// display. Then an independent computation on a random corpus of 100,000 synthetic cases.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { displayOf, groupBoard, percentOf } from './board.ts';
import { boundView, facetRow, facetViewOf, randomOf, reversed, rowsOfCorpus, type CorpusCase } from './test-support.ts';
import { readFacetView } from './views.ts';

const viewOf = (rows: Parameters<typeof facetViewOf>[0], overrides?: Parameters<typeof facetViewOf>[1]) => {
  const read = readFacetView(boundView('facets', facetViewOf(rows, overrides)), 'facets');
  assert.ok(read.ok);
  return read.view;
};

describe('groupBoard', () => {
  it('counts one group per (line, module), with the exact definitions of missing, vague and negative', () => {
    const view = viewOf([
      facetRow({ line: '10.6.1', module: 'SSL', has_expected: true, vague_expected: false, negative: false }, 8),
      facetRow({ line: '10.6.1', module: 'SSL', has_expected: false, vague_expected: false, negative: false }, 2),
      facetRow({ line: '10.6.1', module: 'SSL', has_expected: true, vague_expected: true, negative: false }, 1),
      facetRow({ line: '10.6.1', module: 'SSL', has_expected: true, vague_expected: false, negative: true }, 1),
      // A case can be negative AND missing: it counts in both.
      facetRow({ line: '10.6.1', module: 'SSL', has_expected: false, vague_expected: false, negative: true }, 1),
      facetRow({ line: '10.6.1', module: 'HA', has_expected: true, vague_expected: false, negative: true }, 4),
    ]);
    const groups = groupBoard(view);
    assert.equal(groups.length, 2);
    const ssl = groups.find((g) => g.id === '10.6.1/SSL')!;
    // 含糊期望不从 vague_expected 累加；这 13 条都是已声明的布尔负向，所以负向分母等于用例数。
    assert.deepEqual(ssl.counts, { cases: 13, missing: 3, vague: 0, negative: 2, negative_denominator: 13, type_unclassified: 0 });
    assert.deepEqual(ssl.ratios, { missing: { num: 3, den: 13 }, vague: { num: 0, den: 0 }, negative: { num: 2, den: 13 } });
    assert.deepEqual(ssl.line, '10.6.1');
    assert.deepEqual(ssl.module, 'SSL');
    const ha = groups.find((g) => g.id === '10.6.1/HA')!;
    assert.deepEqual(ha.counts, { cases: 4, missing: 0, vague: 0, negative: 4, negative_denominator: 4, type_unclassified: 0 });
  });

  it('a null module is the group unplaced, and a null line groups under unplaced too', () => {
    const view = viewOf([
      facetRow({ line: '10.6.1', module: null, has_expected: true, vague_expected: false, negative: false }, 5),
      facetRow({ line: null, module: 'SSL', has_expected: false, vague_expected: false, negative: false }, 3),
    ]);
    const groups = groupBoard(view);
    assert.deepEqual(
      groups.map((g) => [g.id, g.counts.cases]),
      [
        ['10.6.1/unplaced', 5],
        ['unplaced/SSL', 3],
      ],
    );
  });

  it('sums rows that split a group by the other fields, and ignores extra by fields such as priority', () => {
    const withPriority = viewOf(
      [
        facetRow({ line: '10.6.1', module: 'SSL', priority: 'P1', has_expected: false, vague_expected: false, negative: false }, 2),
        facetRow({ line: '10.6.1', module: 'SSL', priority: 'P2', has_expected: false, vague_expected: false, negative: false }, 3),
        facetRow({ line: '10.6.1', module: 'SSL', priority: 'P1', has_expected: true, vague_expected: true, negative: true }, 1),
      ],
      // by 最多 6 个，且必须含 test_type_status。vague_expected 已不是必填字段，让位给 priority。
      { by: ['line', 'module', 'priority', 'has_expected', 'negative', 'test_type_status'] },
    );
    const [group] = groupBoard(withPriority);
    assert.equal(group.id, '10.6.1/SSL');
    assert.deepEqual(group.counts, { cases: 6, missing: 5, vague: 0, negative: 1, negative_denominator: 6, type_unclassified: 0 });
  });

  it('a field that is neither true nor false counts toward cases but neither missing, vague nor negative', () => {
    // 未声明必须配 negative null。字符串 'yes' 与声明状态不一致，视图会拒，不能拿来当未分类。
    const view = viewOf([facetRow({ line: '10.6.1', module: 'SSL', has_expected: null, vague_expected: false, negative: null }, 4)]);
    const [group] = groupBoard(view);
    assert.deepEqual(group.counts, { cases: 4, missing: 0, vague: 0, negative: 0, negative_denominator: 0, type_unclassified: 4 });
  });

  it('rounds only for display: the fractions stay exact, the display numbers four decimals, the percents one', () => {
    assert.equal(displayOf(1, 3), 0.3333);
    assert.equal(displayOf(2, 3), 0.6667);
    assert.equal(displayOf(0, 7), 0);
    assert.equal(displayOf(5, 5), 1);
    assert.equal(percentOf(1, 3), '33.3%');
    assert.equal(percentOf(1, 20), '5.0%');
    assert.equal(percentOf(0, 50), '0.0%');
    assert.equal(percentOf(3, 3), '100.0%');
    const [group] = groupBoard(viewOf([facetRow({ line: '10.6.1', module: 'SSL', has_expected: false, vague_expected: false, negative: false }, 1)]));
    assert.deepEqual([group.display.missing, group.ratios.missing], [1, { num: 1, den: 1 }]);
  });

  it('does not depend on the order of the rows or the member order', () => {
    const rows = [
      facetRow({ line: '10.6.1', module: 'SSL', has_expected: true, vague_expected: false, negative: false }, 8),
      facetRow({ line: '10.6.1', module: 'SSL', has_expected: false, vague_expected: false, negative: true }, 2),
      facetRow({ line: null, module: null, has_expected: true, vague_expected: true, negative: false }, 1),
      facetRow({ line: '10.6.0', module: 'HA', has_expected: true, vague_expected: false, negative: false }, 3),
    ];
    const one = groupBoard(viewOf(rows));
    const two = groupBoard(viewOf(reversed(rows) as typeof rows));
    assert.deepEqual(two, one);
  });

  it('equals an independent plain-loop computation on a random corpus of 100,000 synthetic cases', () => {
    const random = randomOf(20261022);
    const lines = ['10.6.1', '10.6.0', '10.7.1', null, '10.8.6', '10.7.0'];
    const modules = ['SSL', 'HA', 'SLB', 'WebUI', '系统', '网络', '认证', null, '日志', '升级', '授权', '审计'];
    const corpus: CorpusCase[] = [];
    for (let i = 0; i < 100000; i++) {
      corpus.push({
        line: lines[Math.floor(random() * lines.length)],
        module: modules[Math.floor(random() * modules.length)],
        has_expected: random() < 0.9,
        vague_expected: random() < 0.08,
        negative: random() < 0.05,
      });
    }
    // The view the reader would answer (its grouping by the five fields), then the pack's groups.
    const view = viewOf(rowsOfCorpus(corpus));
    assert.equal(view.total, 100000);
    const groups = groupBoard(view);
    // The independent computation: plain loops over the corpus, grouped by (line, module).
    const expected = new Map<string, { cases: number; missing: number; vague: number; negative: number; negative_denominator: number; type_unclassified: number }>();
    for (const entry of corpus) {
      const key = `${entry.line ?? 'unplaced'}/${entry.module ?? 'unplaced'}`;
      const held = expected.get(key) ?? { cases: 0, missing: 0, vague: 0, negative: 0, negative_denominator: 0, type_unclassified: 0 };
      held.cases++;
      if (entry.has_expected === false) held.missing++;
      // 独立对照与看板同一条规则：vague_expected 不计入含糊数。
      if (typeof entry.negative === 'boolean') {
        held.negative_denominator++;
        if (entry.negative === true) held.negative++;
      } else held.type_unclassified++;
      expected.set(key, held);
    }
    assert.equal(groups.length, expected.size);
    for (const group of groups) {
      const want = expected.get(group.id);
      assert.ok(want !== undefined, group.id);
      assert.deepEqual(group.counts, want, group.id);
      assert.deepEqual(group.ratios.missing, { num: want.missing, den: want.cases }, group.id);
      expected.delete(group.id);
    }
    assert.equal(expected.size, 0);
    // Groups are sorted by id in code-unit order.
    const ids = groups.map((g) => g.id);
    assert.deepEqual([...ids].sort(), ids);
  });
});

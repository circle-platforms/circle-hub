import { labelOf } from './generated/vocabulary.ts';
// The totals check: run-level facts over the whole view (cases, missing, vague, negative) and the caveat that the board
// describes the indexed cases, not the whole suite. A view that declares itself complete but whose rows cannot hold its
// stated total contradicts itself: the totals are refuted (advisory) instead of stated.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { projectItems } from './project.ts';
import { buildSubject } from './subject.ts';
import { totalsOutcome } from './totals.ts';
import { placementFor, boundView, facetRow, facetViewOf } from './test-support.ts';

const CONTEXT = { product: 'famx', names: ['FAMX', 'FAMY'], line: null, build: null, root: null, parameters: {}, groups: [] };

function subjectOf(rows: Parameters<typeof facetViewOf>[0], options: { overrides?: Parameters<typeof facetViewOf>[1] } = {}) {
  const projected = projectItems({ inputs: [boundView('facets', facetViewOf(rows, options.overrides)), placementFor(facetViewOf(rows, options.overrides))], parameters: {}, context: CONTEXT });
  assert.ok(!('error' in projected));
  const items = projected.items.map((it) => ({ id: it.id, label: it.label, location: `src:${it.location.source}/json@1/${it.location.selector}`, fields: it.fields }));
  return { subject: buildSubject({ applies: 'run', items, context: { ...CONTEXT, groups: projected.groups ?? [] } }), projected };
}

describe('totalsOutcome', () => {
  it('totals the whole view and says what the board cannot see', () => {
    const { subject, projected } = subjectOf([
      facetRow({ line: '10.6.1', module: 'SSL', has_expected: false, vague_expected: false, negative: true }, 2),
      facetRow({ line: '10.6.1', module: 'SSL', has_expected: true, vague_expected: true, negative: false }, 1),
      facetRow({ line: '10.6.1', module: 'HA', has_expected: true, vague_expected: false, negative: false }, 17),
    ]);
    const outcome = totalsOutcome(subject);
    assert.equal(outcome.verdict, 'support');
    assert.equal(outcome.tier, 'advisory');
    assert.equal(outcome.item, undefined);
    const data = outcome.data as { cases: number; missing: number; vague: number; negative: number; ratios: { missing: { num: number; den: number } }; view: { total: number; skipped: number; truncated: boolean } };
    // 那 1 条 vague_expected 不是期望质量判断，含糊数是 0。
    assert.deepEqual([data.cases, data.missing, data.vague, data.negative], [20, 2, 0, 2]);
    assert.deepEqual(data.ratios.missing, { num: 2, den: 20 });
    assert.match(outcome.statement, /合计：用例 20 个/);
    assert.match(outcome.statement, /无期望结果 2 个（10\.0%）/);
    assert.ok(outcome.statement.includes(labelOf('knowledge_count', 'commandless_cases')));
    assert.match(outcome.statement, /计入合计/);
    assert.match(outcome.statement, /不是整套测试/);
    const groups = projected.groups as Array<{ view: { source: string }; placement: { source: string } }>;
    assert.deepEqual(outcome.grounds, [groups[0].view.source, groups[0].placement.source]);
  });

  it('names the listed sources that were not read', () => {
    const { subject } = subjectOf([facetRow({ line: '10.6.1', module: 'SSL', has_expected: true, vague_expected: false, negative: false }, 3)], { overrides: { skipped: 5 } });
    const outcome = totalsOutcome(subject);
    assert.match(outcome.statement, /5 份列出的来源没有读取/);
    assert.equal(outcome.verdict, 'support');
  });

  it('refutes the totals when the rows of an untruncated view cannot hold its stated total', () => {
    const { subject } = subjectOf([facetRow({ line: '10.6.1', module: 'SSL', has_expected: true, vague_expected: false, negative: false }, 3)], { overrides: { total: 100 } });
    const outcome = totalsOutcome(subject);
    assert.deepEqual([outcome.verdict, outcome.code, outcome.tier], ['refute', 'quality-board.total_undercount', 'advisory']);
    assert.match(outcome.statement, /未截断/);
  });

  it('refutes the totals when the rows of an untruncated view hold more than its stated total (a list-valued field counted cases twice)', () => {
    const { subject } = subjectOf(
      [facetRow({ line: '10.6.1', module: 'SSL', has_expected: true, vague_expected: false, negative: false }, 3)],
      { overrides: { total: 2 } },
    );
    const outcome = totalsOutcome(subject);
    assert.deepEqual([outcome.verdict, outcome.code], ['refute', 'quality-board.multi_valued']);
  });

  it('a truncated view is not a mismatch: the totals cover the listed part and say so', () => {
    const { subject } = subjectOf([facetRow({ line: '10.6.1', module: 'SSL', has_expected: true, vague_expected: false, negative: false }, 3)], { overrides: { total: 100, truncated: true } });
    const outcome = totalsOutcome(subject);
    assert.equal(outcome.verdict, 'support');
    assert.match(outcome.statement, /截断/);
  });

  it('an empty subject is an unknown, not a silent pass', () => {
    const outcome = totalsOutcome(buildSubject({ applies: 'run', items: [], context: CONTEXT }));
    assert.deepEqual([outcome.verdict, outcome.reason], ['unknown', 'check_error']);
  });
});

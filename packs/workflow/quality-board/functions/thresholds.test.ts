// The thresholds check: advisory violations when a group's missing or vague share exceeds its maximum or the negative share
// falls below its minimum; equal to the threshold is not a violation; never a blocking violation (management signals, not
// defects). The board check itself: always support with the metrics as claim data, unless the frozen counts contradict the
// definitions (counts_inconsistent).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { boardOutcomes } from './board.ts';
import { projectItems } from './project.ts';
import { buildSubject } from './subject.ts';
import { readThresholds, thresholdOutcomes } from './thresholds.ts';
import { placementFor, boundView, facetRow, facetViewOf } from './test-support.ts';
import type { BoardSubject, CheckOutcome } from './types.ts';

const CONTEXT = { product: 'famx', names: ['FAMX', 'FAMY'], line: null, build: null, root: null, parameters: {}, groups: [] };

/** Projects a hand-built facet view and builds the checks' subject, as a run does. */
function subjectOf(rows: Parameters<typeof facetViewOf>[0], options: { parameters?: Record<string, unknown>; overrides?: Parameters<typeof facetViewOf>[1]; edit?: (fields: Record<string, unknown>) => void } = {}): BoardSubject {
  const parameters = options.parameters ?? {};
  const projected = projectItems({ inputs: [boundView('facets', facetViewOf(rows, options.overrides)), placementFor(facetViewOf(rows, options.overrides))], parameters, context: { ...CONTEXT, parameters } });
  assert.ok(!('error' in projected), 'projected');
  const items = projected.items.map((it) => {
    const fields = it.fields as Record<string, unknown>;
    options.edit?.(fields);
    return { id: it.id, label: it.label, location: `src:${it.location.source}/json@1/${it.location.selector}`, fields };
  });
  return buildSubject({ applies: 'run', items, context: { ...CONTEXT, parameters, groups: projected.groups ?? [] } });
}

const byId = (outcomes: CheckOutcome[], id: string): CheckOutcome[] => outcomes.filter((o) => o.item === id);

/** 含糊阈值的分母是已受理期望质量判断，不是分面 vague_expected。比较测试在投影后写入这个分母，否则零分母会把比较短路成 unknown。 */
function judged(fields: Record<string, unknown>, vague = 0): void {
  const counts = fields.counts as { cases: number; vague: number };
  const ratios = fields.ratios as { vague: { num: number; den: number } };
  counts.vague = vague;
  ratios.vague = { num: vague, den: counts.cases };
  fields.quality = { judged: counts.cases, unjudged: 0, conflicted: 0, sources: [] };
}

describe('boardOutcomes', () => {
  it('always supports with the metrics as claim data (advisory)', () => {
    const subject = subjectOf([
      facetRow({ line: '10.6.1', module: 'SSL', has_expected: true, vague_expected: false, negative: false }, 23),
      facetRow({ line: '10.6.1', module: 'SSL', has_expected: false, vague_expected: false, negative: true }, 2),
    ]);
    const outcomes = boardOutcomes(subject);
    assert.equal(outcomes.length, 1);
    const [outcome] = outcomes;
    assert.deepEqual([outcome.verdict, outcome.tier, outcome.item, outcome.pointer], ['support', 'advisory', '10.6.1/SSL', '/items/0/fields']);
    // 没有期望质量判断时，含糊数保持 0，并写明未判断和有效声明分母。
    assert.equal(outcome.statement, '用例 25 个；无期望结果 2 个（8.0%）；含糊期望 0 个（未判断，已判断 0 个）；未判断 25 个；负面用例 2 个（8.0%；有效声明分母 25；类型未声明 0）');
    const data = outcome.data as { counts: { cases: number; missing: number }; ratios: { missing: { num: number; den: number } }; display: { missing: number } };
    assert.deepEqual(data.counts, { cases: 25, missing: 2, vague: 0, negative: 2, negative_denominator: 25, type_unclassified: 0 });
    assert.deepEqual(data.ratios.missing, { num: 2, den: 25 });
    assert.equal(data.display.missing, 0.08);
    assert.deepEqual(outcome.grounds, [subject.items[0].location]);
  });

  it('refutes (advisory) when the frozen counts contradict the definitions — more missing than cases', () => {
    const outcomes = boardOutcomes(
      subjectOf([facetRow({ line: '10.6.1', module: 'SSL', has_expected: false, vague_expected: false, negative: false }, 3)], {
        edit: (fields) => {
          (fields.counts as { missing: number }).missing = 5;
        },
      }),
    );
    const [outcome] = outcomes;
    assert.deepEqual([outcome.verdict, outcome.code, outcome.tier], ['refute', 'quality-board.counts_inconsistent', 'advisory']);
    assert.match(outcome.statement, /不自洽/);
  });

  it('an item with malformed fields is unknown (check error), never silently passed', () => {
    const outcomes = boardOutcomes(
      subjectOf([facetRow({ line: '10.6.1', module: 'SSL', has_expected: true, vague_expected: false, negative: false }, 1)], {
        edit: (fields) => {
          fields.counts = 'nope';
        },
      }),
    );
    assert.deepEqual([outcomes[0].verdict, outcomes[0].reason], ['unknown', 'check_error']);
  });

  it('an empty subject gives one unknown outcome instead of a silent pass', () => {
    const outcomes = boardOutcomes(buildSubject({ applies: 'run', items: [], context: CONTEXT }));
    assert.equal(outcomes.length, 1);
    assert.deepEqual([outcomes[0].verdict, outcomes[0].reason], ['unknown', 'check_error']);
  });
});

describe('thresholdOutcomes', () => {
  it('a group within the thresholds is support, at advisory tier', () => {
    // 20 cases: 1 missing (5.0%), 1 vague (5.0%), 1 negative (5.0%) — exactly at both maxima, above the minimum.
    const subject = subjectOf([
      facetRow({ line: '10.6.1', module: 'SSL', has_expected: false, vague_expected: false, negative: false }, 1),
      facetRow({ line: '10.6.1', module: 'SSL', has_expected: true, vague_expected: true, negative: false }, 1),
      facetRow({ line: '10.6.1', module: 'SSL', has_expected: true, vague_expected: false, negative: true }, 1),
      facetRow({ line: '10.6.1', module: 'SSL', has_expected: true, vague_expected: false, negative: false }, 17),
    ], { edit: (fields) => judged(fields, 1) });
    const outcomes = thresholdOutcomes(subject);
    assert.deepEqual(
      outcomes.map((o) => [o.verdict, o.tier]),
      [['support', 'advisory']],
    );
    assert.match(outcomes[0].statement, /阈值内/);
  });

  it('equal to the threshold is not a violation; one case more is', () => {
    // 20 cases, 1 missing = 5.0% = the default maximum: no violation.
    const at = thresholdOutcomes(subjectOf([facetRow({ line: '10.6.1', module: 'SSL', has_expected: false, vague_expected: false, negative: true }, 1), facetRow({ line: '10.6.1', module: 'SSL', has_expected: true, vague_expected: false, negative: false }, 19)], { edit: (fields) => judged(fields) }));
    assert.deepEqual(
      at.map((o) => o.verdict),
      ['support'],
    );
    // 25 cases, 2 missing = 8.0% > 5.0%: a missing_expected violation.
    const over = thresholdOutcomes(subjectOf([facetRow({ line: '10.6.1', module: 'SSL', has_expected: false, vague_expected: false, negative: true }, 2), facetRow({ line: '10.6.1', module: 'SSL', has_expected: true, vague_expected: false, negative: false }, 23)], { edit: (fields) => judged(fields) }));
    assert.deepEqual(
      over.map((o) => [o.verdict, o.code ?? null]),
      [['refute', 'quality-board.missing_expected']],
    );
    assert.match(over[0].statement, /8\.0%/);
    assert.match(over[0].statement, /5\.0%/);
    const data = over[0].data as { metric: string; ratio: { num: number; den: number }; threshold: number };
    assert.deepEqual([data.metric, data.ratio, data.threshold], ['missing', { num: 2, den: 25 }, 0.05]);
  });

  it('the negative share below its minimum is a violation; exactly at it is not', () => {
    // 50 cases, 1 negative = 2.0% = the default minimum: no violation.
    const at = thresholdOutcomes(subjectOf([facetRow({ line: '10.6.1', module: 'HA', has_expected: true, vague_expected: false, negative: true }, 1), facetRow({ line: '10.6.1', module: 'HA', has_expected: true, vague_expected: false, negative: false }, 49)], { edit: (fields) => judged(fields) }));
    assert.deepEqual(
      at.map((o) => o.verdict),
      ['support'],
    );
    // 50 cases, none negative = 0.0% < 2.0%.
    const under = thresholdOutcomes(subjectOf([facetRow({ line: '10.6.1', module: 'HA', has_expected: true, vague_expected: false, negative: false }, 50)], { edit: (fields) => judged(fields) }));
    assert.deepEqual(
      under.map((o) => [o.verdict, o.code ?? null]),
      [['refute', 'quality-board.negative_share']],
    );
    assert.match(under[0].statement, /低于下限/);
  });

  it('one group may violate several thresholds: one refute per violation', () => {
    // 10 cases: 4 missing (40%), 3 vague (30%), 0 negative (0%).
    const subject = subjectOf([
      facetRow({ line: '10.6.1', module: 'WebUI', has_expected: false, vague_expected: false, negative: false }, 4),
      facetRow({ line: '10.6.1', module: 'WebUI', has_expected: true, vague_expected: true, negative: false }, 3),
      facetRow({ line: '10.6.1', module: 'WebUI', has_expected: true, vague_expected: false, negative: false }, 3),
    ], { edit: (fields) => judged(fields, 3) });
    const outcomes = thresholdOutcomes(subject);
    assert.deepEqual(
      outcomes.map((o) => o.code),
      ['quality-board.missing_expected', 'quality-board.vague_expected', 'quality-board.negative_share'],
    );
    assert.ok(outcomes.every((o) => o.tier === 'advisory' && o.item === '10.6.1/WebUI'));
  });

  it('the parameters move the thresholds', () => {
    const rows = [facetRow({ line: '10.6.1', module: 'SSL', has_expected: false, vague_expected: false, negative: false }, 1), facetRow({ line: '10.6.1', module: 'SSL', has_expected: true, vague_expected: false, negative: true }, 19)];
    const loose = thresholdOutcomes(subjectOf(rows, { parameters: { max_missing_ratio: 0.1, min_negative_ratio: 0.01 }, edit: (fields) => judged(fields) }));
    assert.deepEqual(
      loose.map((o) => o.verdict),
      ['support'],
    );
    const strict = thresholdOutcomes(subjectOf(rows, { parameters: { max_missing_ratio: 0.04 }, edit: (fields) => judged(fields) }));
    assert.deepEqual(
      strict.map((o) => o.code ?? null),
      ['quality-board.missing_expected'],
    );
  });

  it('reads the defaults when no parameter is given', () => {
    assert.deepEqual(readThresholds({}), { thresholds: { max_missing_ratio: 0.05, max_vague_ratio: 0.05, min_negative_ratio: 0.02 }, ignored: [] });
    assert.deepEqual(readThresholds({ max_missing_ratio: 2 }).ignored, ['max_missing_ratio']);
    assert.deepEqual(readThresholds({ min_negative_ratio: -0.1 }).ignored, ['min_negative_ratio']);
  });
});

// Edge cases of the quality board written after a mutation check: missing plus vague beyond the case count is
// a counts_inconsistent refutation, and an untruncated view whose rows hold fewer cases than its stated total
// is refuted even when the gap is small.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { boardOutcomes } from './board.ts';
import { projectItems } from './project.ts';
import { buildSubject } from './subject.ts';
import { totalsOutcome } from './totals.ts';
import { placementFor, boundView, facetRow, facetViewOf } from './test-support.ts';

const CONTEXT = { product: 'famx', names: ['FAMX', 'FAMY'], line: null, build: null, root: null, parameters: {}, groups: [] };

function subjectOf(rows: Parameters<typeof facetViewOf>[0], options: { overrides?: Parameters<typeof facetViewOf>[1]; edit?: (fields: Record<string, unknown>) => void } = {}) {
  const projected = projectItems({ inputs: [boundView('facets', facetViewOf(rows, options.overrides)), placementFor(facetViewOf(rows, options.overrides))], parameters: {}, context: CONTEXT });
  assert.ok(!('error' in projected), 'projected');
  const items = projected.items.map((it) => {
    const fields = it.fields as Record<string, unknown>;
    options.edit?.(fields);
    return { id: it.id, label: it.label, location: `src:${it.location.source}/json@1/${it.location.selector}`, fields };
  });
  return buildSubject({ applies: 'run', items, context: { ...CONTEXT, groups: projected.groups ?? [] } });
}

describe('quality-board edge cases', () => {
  it('refutes (advisory) when missing plus vague exceeds the case count, each within it', () => {
    const subject = subjectOf([facetRow({ line: '10.6.1', module: 'SSL', has_expected: true, vague_expected: false, negative: false }, 10)], {
      edit: (fields) => {
        const counts = fields.counts as { cases: number; missing: number; vague: number };
        counts.missing = 6;
        counts.vague = 5;
      },
    });
    const [outcome] = boardOutcomes(subject);
    assert.deepEqual([outcome.verdict, outcome.code, outcome.tier], ['refute', 'quality-board.counts_inconsistent', 'advisory']);
    assert.match(outcome.statement, /加起来（11）多于用例总数（10）/);
  });

  it('refutes an untruncated view whose rows hold even one case fewer than its stated total', () => {
    const subject = subjectOf(
      [facetRow({ line: '10.6.1', module: 'SSL', has_expected: true, vague_expected: false, negative: false }, 9)],
      { overrides: { total: 10 } },
    );
    const outcome = totalsOutcome(subject);
    assert.deepEqual([outcome.verdict, outcome.code], ['refute', 'quality-board.total_undercount']);
    assert.match(outcome.statement, /（9）少于视图声明的用例总数（10）/);
  });
});

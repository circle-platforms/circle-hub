// Every entry point runs unchanged in the Hub sandbox (hub/rules): only modules inside the pack are loaded at run time, the
// type imports are erased, and the output equals the direct call. All three checks also run through runCheck, as a run calls
// them.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { callPackFunction, osIsolationAvailable, runCheck } from '../../../../hub/rules/api.ts';
import board from './board.ts';
import project from './project.ts';
import subject from './subject.ts';
import thresholds from './thresholds.ts';
import totals from './totals.ts';
import { placementFor, boundView, facetRow, facetViewOf } from './test-support.ts';
import type { ProjectedItem } from './types.ts';

const packDir = fileURLToPath(new URL('../', import.meta.url));
const available = await osIsolationAvailable();

const CONTEXT = { product: 'famx', names: ['FAMX', 'FAMY'], line: null, build: null, root: null, parameters: {}, groups: [] };
const view = facetViewOf([
  facetRow({ line: '10.6.1', module: 'SSL', has_expected: false, vague_expected: false, negative: false }, 1),
  facetRow({ line: '10.6.1', module: 'SSL', has_expected: true, vague_expected: false, negative: true }, 19),
  facetRow({ line: '10.6.1', module: null, has_expected: true, vague_expected: true, negative: false }, 2),
]);
const projection = { inputs: [boundView('facets', view), placementFor(view)], parameters: {}, context: CONTEXT };
const projected = project(projection) as { items: ProjectedItem[]; groups: Record<string, unknown>[] };
const runSubject = {
  applies: 'run',
  items: projected.items.map((it) => ({ id: it.id, label: it.label, location: `src:${(it.location as { source: string }).source}/json@1/${(it.location as { selector: string }).selector}`, fields: it.fields })),
  context: { ...CONTEXT, groups: projected.groups },
};
const built = subject(runSubject);

const entries: Array<{ module: string; input: unknown; direct: (input: unknown) => unknown }> = [
  { module: 'functions/project.ts', input: projection, direct: project },
  { module: 'functions/subject.ts', input: runSubject, direct: subject },
  { module: 'functions/board.ts', input: { check: 'board', table: null, subject: built, context: { pack: 'quality-board' }, sources: {} }, direct: board },
  { module: 'functions/thresholds.ts', input: { check: 'thresholds', table: null, subject: built, context: { pack: 'quality-board' }, sources: {} }, direct: thresholds },
  { module: 'functions/totals.ts', input: { check: 'totals', table: null, subject: built, context: { pack: 'quality-board' }, sources: {} }, direct: totals },
];

describe('pack functions in the Hub sandbox', { skip: available ? false : 'no OS network isolation on this machine (sandbox-exec)' }, () => {
  for (const entry of entries) {
    it(`${entry.module} gives the same result as the direct call`, async () => {
      const result = await callPackFunction({ packDir, module: entry.module }, entry.input, { timeoutMs: 20_000 });
      assert.equal(result.osIsolation, true);
      assert.deepEqual(result.output, JSON.parse(JSON.stringify(entry.direct(entry.input))));
    });
  }

  it('runs the declared checks through runCheck, with the tier and outcomes a run gets', async () => {
    const context = { run: 'run_0000000000000000000000000a', requirement: 'board', pack: 'quality-board' };
    const boardOutcomes = await runCheck({ id: 'board', function: { module: 'functions/board.ts' }, tier: 'advisory' }, { subject: built, context, packDir, sourceTexts: {} });
    assert.deepEqual(boardOutcomes, board({ subject: built }));
    assert.deepEqual(
      boardOutcomes.map((o) => [o.item, o.verdict]),
      [
        ['10.6.1/SSL', 'support'],
        ['10.6.1/unplaced', 'support'],
      ],
    );
    const thresholdOutcomes = await runCheck({ id: 'thresholds', function: { module: 'functions/thresholds.ts' }, tier: 'advisory' }, { subject: built, context: { ...context, requirement: 'thresholds' }, packDir, sourceTexts: {} });
    assert.deepEqual(thresholdOutcomes, thresholds({ subject: built }));
    assert.deepEqual(
      thresholdOutcomes.map((o) => [o.item, o.verdict, o.code ?? null]),
      [
        // 没有期望质量判断时含糊阈值是 unknown，不再把 vague_expected 当成越界。未归位 0/2 仍低于负向下限。
        ['10.6.1/SSL', 'unknown', null],
        ['10.6.1/unplaced', 'unknown', null],
        ['10.6.1/unplaced', 'refute', 'quality-board.negative_share'],
      ],
    );
    const totalOutcomes = await runCheck({ id: 'totals', function: { module: 'functions/totals.ts' }, tier: 'advisory' }, { subject: built, context: { ...context, requirement: 'totals' }, packDir, sourceTexts: {} });
    assert.deepEqual(totalOutcomes, totals({ subject: built }));
    assert.deepEqual(
      totalOutcomes.map((o) => [o.verdict, o.item ?? null]),
      [['support', null]],
    );
  });
});

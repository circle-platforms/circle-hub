// A production run end to end: the published quality-board pack, the real run engine, and a hand-built facet view served by
// a fake knowledge reader. start_run computes and stores the validation result with no submission; every group's metrics
// come back as fact claims, the threshold violations as advisory refutations, and the totals as a cross-item claim.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { StartRunOutput, SubmitResultOutput } from '../../../contracts/src/tools.ts';
import { ValidationResult, partitionCountsOf, type ItemResult } from '../../../contracts/src/validation.ts';
import { osIsolationAvailable } from '../../../hub/rules/api.ts';
import { startPostgres, type TemporaryPostgres } from '../../../hub/testing/postgres.ts';
import { facetRow, facetViewOf } from './functions/test-support.ts';
import { BUILD, ROOT, call, openHub, type Hub } from './test-hub.ts';

const skip = (await osIsolationAvailable()) ? false : 'no OS network isolation on this machine (sandbox-exec)';
let postgres: TemporaryPostgres;
let hub: Hub;

const FACETS_ID = `knowledge:facets:apv:${BUILD.name}?kind=case&by=line,module,has_expected,vague_expected,negative`;

// The view: SSL within the thresholds (20 cases: 1 missing, 1 vague, 1 negative — exactly at both maxima, not violations),
// WebUI outside them (10 cases: 4 missing, 3 vague, 0 negative), and a group without a module.
const ROWS = [
  facetRow({ line: '10.6.1', module: 'SSL', has_expected: false, vague_expected: false, negative: false }, 1),
  facetRow({ line: '10.6.1', module: 'SSL', has_expected: true, vague_expected: true, negative: false }, 1),
  facetRow({ line: '10.6.1', module: 'SSL', has_expected: true, vague_expected: false, negative: true }, 1),
  facetRow({ line: '10.6.1', module: 'SSL', has_expected: true, vague_expected: false, negative: false }, 17),
  facetRow({ line: '10.6.1', module: 'WebUI', has_expected: false, vague_expected: false, negative: false }, 4),
  facetRow({ line: '10.6.1', module: 'WebUI', has_expected: true, vague_expected: true, negative: false }, 3),
  facetRow({ line: '10.6.1', module: 'WebUI', has_expected: true, vague_expected: false, negative: false }, 3),
  facetRow({ line: '10.6.1', module: null, has_expected: true, vague_expected: false, negative: true }, 2),
];

const located = (result: ValidationResult, id: string): ItemResult => {
  for (const items of Object.values(result.partitions)) {
    const item = (items as ItemResult[]).find((i) => i.item === id);
    if (item) return item;
  }
  throw new Error(`item ${id} is in no partition`);
};

before(async () => {
  postgres = await startPostgres();
  if (skip) return;
  hub = await openHub(postgres);
  hub.views.put(FACETS_ID, facetViewOf(ROWS));
});
after(async () => {
  await hub?.close();
  await postgres?.stop();
});

describe('a production run of quality-board', { skip }, () => {
  it('computes and stores the board at start_run: metrics as fact claims, threshold violations advisory, never blocking', async () => {
    const detail = await hub.service.startRunDetailed(hub.alice, { pack: 'quality-board', inputs: { facets: { external: FACETS_ID } } }, call());
    assert.equal(detail.answer.call_result, 'ok', JSON.stringify(detail.answer.errors));
    assert.ok(StartRunOutput.safeParse({ ...detail.answer, trace: '4bf92f3577b34da6a3ce929d0e0e4736' }).success);
    const run = detail.answer.run!;
    // The pack binds no product line: the view's external id names the product and the build, and no build is locked.
    assert.deepEqual([run.product, run.version, run.build, run.root], [undefined, undefined, undefined, undefined]);
    assert.deepEqual(
      run.requirements.map((r) => [r.key, r.accepted_producer]),
      [
        ['board', 'fact'],
        ['thresholds', 'fact'],
        ['totals', 'fact'],
      ],
    );
    assert.deepEqual(
      run.sources.map((s) => [s.slot, s.role, s.external]),
      [['facets', 'subject', `${FACETS_ID}@${ROOT}`]],
    );
    assert.deepEqual(
      run.items.map((i) => [i.id, i.summary]),
      [
        ['10.6.1/SSL', '用例 20 个；无期望结果 1 个（5.0%）；含糊期望 1 个（5.0%）；负面用例 1 个（5.0%）'],
        ['10.6.1/WebUI', '用例 10 个；无期望结果 4 个（40.0%）；含糊期望 3 个（30.0%）；负面用例 0 个（0.0%）'],
        ['10.6.1/unplaced', '用例 2 个；无期望结果 0 个（0.0%）；含糊期望 0 个（0.0%）；负面用例 2 个（100.0%）'],
      ],
    );

    const production = detail.production!;
    const result = production.result;
    assert.ok(ValidationResult.safeParse(result).success);
    assert.deepEqual([result.acceptance, result.errors], ['accepted', []]);
    // Advisory violations never reject: every group is delivered.
    assert.deepEqual(production.counts, { delivered: 3, rejected: 0, quarantined: 0, incomplete: 0, unknown: 0 });
    assert.deepEqual(production.counts, partitionCountsOf(result.partitions));

    // The answers, written down before the run.
    const ssl = located(result, '10.6.1/SSL');
    assert.deepEqual(
      ssl.requirements.map((r) => [r.requirement, r.status]),
      [
        ['board', 'satisfied'],
        ['thresholds', 'satisfied'],
      ],
    );
    const board = ssl.requirements[0];
    assert.deepEqual(board.layers, [{ layer: 'static', terminal: 'pass' }]);
    const metrics = board.claims[0].statement.data as { counts: { cases: number; missing: number; vague: number; negative: number }; ratios: { missing: { num: number; den: number } }; display: { missing: number; negative: number } };
    assert.deepEqual(metrics.counts, { cases: 20, missing: 1, vague: 1, negative: 1 });
    assert.deepEqual(metrics.ratios.missing, { num: 1, den: 20 });
    assert.deepEqual([metrics.display.missing, metrics.display.negative], [0.05, 0.05]);
    assert.equal(board.claims[0].statement.verdict, 'support');
    assert.deepEqual(board.claims[0].warrant, { producer: 'function', id: 'quality-board.board@1.0.2', independence: 'judge_not_author' });
    assert.deepEqual(ssl.requirements[1].claims.map((c) => c.statement.verdict), ['support']);

    const webui = located(result, '10.6.1/WebUI');
    assert.deepEqual(webui.requirements.map((r) => [r.requirement, r.status]), [
      ['board', 'satisfied'],
      ['thresholds', 'unsatisfied'],
    ]);
    // One static layer per requirement; the first violation leads. All three refutations are claims of the requirement.
    assert.deepEqual(webui.requirements[1].layers, [{ layer: 'static', terminal: 'violation', code: 'quality-board.missing_expected', tier: 'advisory', attribution: 'author_input' }]);
    assert.deepEqual(
      webui.requirements[1].claims.map((c) => c.statement.code),
      ['quality-board.missing_expected', 'quality-board.vague_expected', 'quality-board.negative_share'],
    );

    // The totals are a cross-item fact claim and say what the board cannot see.
    const totals = result.cross_item.find((c) => c.requirement === 'totals');
    assert.ok(totals, 'the totals claim');
    assert.equal(totals.statement.verdict, 'support');
    assert.equal(totals.qualifier.nature, 'fact');
    const data = totals.statement.data as { cases: number; missing: number; vague: number; negative: number; view: { total: number; listed_rows: number } };
    assert.deepEqual([data.cases, data.missing, data.vague, data.negative], [32, 5, 4, 3]);
    assert.deepEqual([data.view.total, data.view.listed_rows], [32, 8]);
    assert.match(totals.statement.text, /合计：用例 32 个/);
    assert.match(totals.statement.text, /不是整套测试/);
    assert.match(totals.statement.text, /没有解析出命令的用例是未归位条目，也计入合计/);

    // The result is the run's latest and readable by reference.
    const view = (await hub.service.getRun(hub.alice, run.run))!;
    assert.deepEqual(view.latest, { record: production.record, result });
  });

  it('moves the thresholds with the parameters', async () => {
    const detail = await hub.service.startRunDetailed(hub.alice, { pack: 'quality-board', inputs: { facets: { external: FACETS_ID } }, parameters: { max_missing_ratio: 0.5, max_vague_ratio: 0.5, min_negative_ratio: 0 } }, call());
    assert.equal(detail.answer.call_result, 'ok', JSON.stringify(detail.answer.errors));
    const result = detail.production!.result;
    const webui = located(result, '10.6.1/WebUI');
    assert.deepEqual(
      webui.requirements[1].claims.map((c) => c.statement.verdict),
      ['support'],
    );
    assert.deepEqual(detail.production!.counts, { delivered: 3, rejected: 0, quarantined: 0, incomplete: 0, unknown: 0 });
  });

  it('keeps the pack from users it is not assigned to, and takes model commentary only as judgments', async () => {
    const refused = await hub.service.startRun(hub.bob, { pack: 'quality-board', inputs: { facets: { external: FACETS_ID } } }, call());
    assert.deepEqual(
      refused.errors.map((e) => e.code),
      ['SOURCE_UNAVAILABLE'],
    );
    const detail = await hub.service.startRunDetailed(hub.alice, { pack: 'quality-board', inputs: { facets: { external: FACETS_ID } } }, call());
    const run = detail.answer.run!;
    const answer = await hub.service.submitResult(hub.alice, { run: run.run, model: 'scripted-model@test', items: [], cross_item: [{ nature: 'judgment', statement: '看板与预期一致', grounds: [run.items[0].location] }] }, call());
    assert.ok(SubmitResultOutput.safeParse({ ...answer, trace: '4bf92f3577b34da6a3ce929d0e0e4736' }).success);
    assert.equal(answer.acceptance, 'accepted', JSON.stringify(answer.errors));
    const comment = answer.result!.cross_item.find((c) => c.warrant.producer === 'model')!;
    assert.deepEqual([comment.qualifier.nature, comment.statement.text], ['judgment', '看板与预期一致']);
    assert.deepEqual(answer.counts, detail.production!.counts);
  });
});

import { labelOf } from './functions/generated/vocabulary.ts';
// A production run end to end: the published quality-board pack, the real run engine, and a hand-built facet view served by
// a fake knowledge reader. start_run computes and stores the validation result with no submission; every group's metrics
// come back as fact claims, the threshold violations as advisory refutations, and the totals as a cross-item claim.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { StartRunOutput, SubmitResultOutput } from '../../../contracts/src/tools.ts';
import { ValidationResult, partitionCountsOf, type ItemResult } from '../../../contracts/src/validation.ts';
import { osIsolationAvailable } from '../../../hub/rules/api.ts';
import { startPostgres, type TemporaryPostgres } from '../../../hub/testing/postgres.ts';
import { facetRow, facetViewOf, placementFor } from './functions/test-support.ts';
import { BUILD, ROOT, call, openHub, type Hub } from './test-hub.ts';

const skip = (await osIsolationAvailable()) ? false : 'no OS network isolation on this machine (sandbox-exec)';
let postgres: TemporaryPostgres;
let hub: Hub;

const PLACEMENT_ID = `knowledge:facets:famx:${BUILD.name}?kind=case&by=commands`;
const TAGS_ID = `knowledge:facets:famx:${BUILD.name}?kind=case&by=line,module,tags,resource_empty,tag_valid`;
const FACETS_BY = ['line', 'module', 'has_expected', 'negative', 'test_type_status'];
const FACETS_ID = `knowledge:facets:famx:${BUILD.name}?kind=case&by=${FACETS_BY.join(',')}`;
const TAGS_BY = ['line', 'module', 'tags', 'resource_empty', 'tag_valid'];

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
  hub.views.put(FACETS_ID, facetViewOf(ROWS, { by: FACETS_BY }));
  hub.views.put(PLACEMENT_ID, placementFor(facetViewOf(ROWS), 2).model as Record<string, unknown>);
});
after(async () => {
  await hub?.close();
  await postgres?.stop();
});

describe('a production run of quality-board', { skip }, () => {
  it('computes and stores the board at start_run: metrics as fact claims, threshold violations advisory, never blocking', async () => {
    const detail = await hub.service.startRunDetailed(hub.alice, { pack: 'quality-board', inputs: { facets: { external: FACETS_ID }, placement: { external: PLACEMENT_ID } } }, call());
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
      [['facets', 'subject', `${FACETS_ID}@${ROOT}`], ['placement', 'hint', `${PLACEMENT_ID}@${ROOT}`]],
    );
    assert.deepEqual(
      run.items.map((i) => [i.id, i.summary]),
      [
        ['10.6.1/SSL', '用例 20 个；无期望结果 1 个（5.0%）；含糊期望 0 个（未判断，已判断 0 个）；未判断 20 个；负面用例 1 个（5.0%；有效声明分母 20；类型未声明 0）'],
        ['10.6.1/WebUI', '用例 10 个；无期望结果 4 个（40.0%）；含糊期望 0 个（未判断，已判断 0 个）；未判断 10 个；负面用例 0 个（0.0%；有效声明分母 10；类型未声明 0）'],
        ['10.6.1/unplaced', '用例 2 个；无期望结果 0 个（0.0%）；含糊期望 0 个（未判断，已判断 0 个）；未判断 2 个；负面用例 2 个（100.0%；有效声明分母 2；类型未声明 0）'],
      ],
    );

    const production = detail.production!;
    const result = production.result;
    assert.ok(ValidationResult.safeParse(result).success);
    assert.equal(result.acceptance, 'accepted');
    // 三条阈值都缺已受理期望判断，运行记下 missing_input。请求号和期限每次不同，只核对条目和要求。
    assert.deepEqual(result.errors.map((error) => [error.code, error.requirement, error.item]), [
      ['missing_input', 'thresholds', '10.6.1/SSL'],
      ['missing_input', 'thresholds', '10.6.1/WebUI'],
      ['missing_input', 'thresholds', '10.6.1/unplaced'],
    ]);
    // 开跑时请求还没落成未完成，两条未知里有一条仍待补。
    assert.deepEqual(production.counts, { delivered: 3, rejected: 0, quarantined: 0, incomplete: 0, unknown: 2, pending_unknown: 1 });
    assert.deepEqual(production.counts, partitionCountsOf(result.partitions));

    // The answers, written down before the run.
    const ssl = located(result, '10.6.1/SSL');
    assert.deepEqual(
      ssl.requirements.map((r) => [r.requirement, r.status]),
      [
        ['board', 'satisfied'],
        ['thresholds', 'pending'],
      ],
    );
    const board = ssl.requirements[0];
    assert.deepEqual(board.layers, [{ layer: 'static', terminal: 'pass' }]);
    const metrics = board.claims[0].statement.data as { counts: { cases: number; missing: number; vague: number; negative: number }; ratios: { missing: { num: number; den: number } }; display: { missing: number; negative: number } };
    assert.deepEqual(metrics.counts, { cases: 20, missing: 1, vague: 0, negative: 1, negative_denominator: 20, type_unclassified: 0 });
    assert.deepEqual(metrics.ratios.missing, { num: 1, den: 20 });
    assert.deepEqual([metrics.display.missing, metrics.display.negative], [0.05, 0.05]);
    assert.equal(board.claims[0].statement.verdict, 'support');
    assert.deepEqual(board.claims[0].warrant, { producer: 'function', id: 'quality-board.board@2.0.12', independence: 'judge_not_author' });
    // 没有绑定评审时含糊分母是 0，阈值检查是 unknown，不是支持。
    assert.deepEqual(ssl.requirements[1].claims.map((c) => c.statement.verdict), ['unknown']);

    const webui = located(result, '10.6.1/WebUI');
    assert.deepEqual(webui.requirements.map((r) => [r.requirement, r.status]), [
      ['board', 'satisfied'],
      ['thresholds', 'unsatisfied'],
    ]);
    // One static layer per requirement; the first violation leads. All three refutations are claims of the requirement.
    const webuiLayer = webui.requirements[1].layers[0];
    assert.equal(webuiLayer.terminal, 'violation');
    assert.equal(webuiLayer.code, 'quality-board.missing_expected');
    assert.equal(webuiLayer.tier, 'advisory');
    assert.equal(webuiLayer.attribution, 'producer_error');
    assert.equal(webuiLayer.gaps?.[0]?.reason, 'missing_input');
    assert.equal(webuiLayer.gaps?.[0]?.exit?.action, 'request');
    assert.deepEqual(
      webui.requirements[1].claims.map((c) => c.statement.code),
      // vague_expected 不再产生含糊越界。0/10 仍低于负向下限。unknown 主张没有 code。
      [undefined, 'quality-board.missing_expected', 'quality-board.negative_share'],
    );

    // The totals are a cross-item fact claim and say what the board cannot see.
    const totals = result.cross_item.find((c) => c.requirement === 'totals');
    assert.ok(totals, 'the totals claim');
    assert.equal(totals.statement.verdict, 'support');
    assert.equal(totals.qualifier.nature, 'fact');
    const data = totals.statement.data as { cases: number; missing: number; vague: number; negative: number; view: { total: number; listed_rows: number } };
    assert.deepEqual([data.cases, data.missing, data.vague, data.negative], [32, 5, 0, 3]);
    assert.deepEqual([data.view.total, data.view.listed_rows], [32, 8]);
    assert.match(totals.statement.text, /合计：用例 32 个/);
    assert.match(totals.statement.text, /不是整套测试/);
    assert.ok(totals.statement.text.includes(labelOf('knowledge_count', 'commandless_cases')));

    // The result is the run's latest and readable by reference.
    const view = (await hub.service.getRun(hub.alice, run.run))!;
    assert.deepEqual(view.latest, { record: production.record, result });
  });

  it('reads the optional tag view and required placement through the production engine', async () => {
    // 覆盖只认闭集精确原文。Functional / function / Stress 不再折成类型。
    hub.views.put(TAGS_ID, facetViewOf([
      facetRow({ line: '10.6.1', module: 'SSL', tags: 'functional' }, 10),
      facetRow({ line: '10.6.1', module: 'SSL', tags: null }, 10),
      facetRow({ line: '10.6.1', module: 'WebUI', tags: null }, 10),
      facetRow({ line: '10.6.1', module: null, tags: 'stress' }, 2),
    ], { by: TAGS_BY, total: 32 }));
    const detail = await hub.service.startRunDetailed(hub.alice, { pack: 'quality-board', inputs: { facets: [{ external: FACETS_ID }, { external: TAGS_ID }], placement: { external: PLACEMENT_ID } } }, call());
    assert.equal(detail.answer.call_result, 'ok', JSON.stringify(detail.answer.errors));
    const result = detail.production!.result;
    const ssl = located(result, '10.6.1/SSL');
    const data = ssl.requirements.find((r) => r.requirement === 'board')!.claims[0].statement.data as { counts: { cases: number }; coverage: { present: string[]; missing: string[]; untagged: number } };
    assert.equal(data.counts.cases, 20);
    assert.deepEqual(data.coverage.present, ['功能测试']);
    assert.equal(data.coverage.untagged, 10);
    assert.equal(data.coverage.missing.length, 5);
    assert.ok(result.cross_item.find((c) => c.requirement === 'totals')!.statement.text.includes(labelOf('knowledge_count', 'commandless_cases') + ' 2 个'));
    assert.ok(hub.views.reads.some((id) => id.startsWith(TAGS_ID)));
  });

  it('moves the thresholds with the parameters', async () => {
    const detail = await hub.service.startRunDetailed(hub.alice, { pack: 'quality-board', inputs: { facets: { external: FACETS_ID }, placement: { external: PLACEMENT_ID } }, parameters: { max_missing_ratio: 0.5, max_vague_ratio: 0.5, min_negative_ratio: 0 } }, call());
    assert.equal(detail.answer.call_result, 'ok', JSON.stringify(detail.answer.errors));
    const result = detail.production!.result;
    const webui = located(result, '10.6.1/WebUI');
    assert.deepEqual(
      webui.requirements[1].claims.map((c) => c.statement.verdict),
      ['unknown'],
    );
    // 参数放宽也不制造已判断分母，阈值主张仍是 unknown。
    assert.deepEqual(detail.production!.counts, { delivered: 3, rejected: 0, quarantined: 0, incomplete: 0, unknown: 3 });
  });

  it('keeps the pack from users it is not assigned to, and takes model commentary only as judgments', async () => {
    const refused = await hub.service.startRun(hub.bob, { pack: 'quality-board', inputs: { facets: { external: FACETS_ID }, placement: { external: PLACEMENT_ID } } }, call());
    assert.deepEqual(
      refused.errors.map((e) => e.code),
      ['SOURCE_UNAVAILABLE'],
    );
    const detail = await hub.service.startRunDetailed(hub.alice, { pack: 'quality-board', inputs: { facets: { external: FACETS_ID }, placement: { external: PLACEMENT_ID } } }, call());
    const run = detail.answer.run!;
    const answer = await hub.service.submitResult(hub.alice, { run: run.run, model: 'scripted-model@test', items: [], cross_item: [{ nature: 'judgment', statement: '看板与预期一致', grounds: [run.items[0].location] }] }, call());
    assert.ok(SubmitResultOutput.safeParse({ ...answer, trace: '4bf92f3577b34da6a3ce929d0e0e4736' }).success);
    assert.equal(answer.acceptance, 'accepted', JSON.stringify(answer.errors));
    const comment = answer.result!.cross_item.find((c) => c.warrant.producer === 'model')!;
    assert.deepEqual([comment.qualifier.nature, comment.statement.text], ['judgment', '看板与预期一致']);
    // 提交后三条阈值的具名请求已经开出，条目从待补未知改记为未完成。
    assert.deepEqual(detail.production!.counts, { delivered: 3, rejected: 0, quarantined: 0, incomplete: 0, unknown: 2, pending_unknown: 1 });
    assert.deepEqual(answer.counts, { delivered: 0, rejected: 0, quarantined: 0, incomplete: 3, unknown: 0 });
  });
});

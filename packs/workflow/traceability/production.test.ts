// A production run end to end: the published traceability pack, the real run engine, and hand-built index views served by a
// fake knowledge reader. start_run computes and stores the validation result with no submission; each per-defect answer,
// written down here first, comes back as the data of a fact claim, and the run-level counts as a cross-item claim.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { StartRunOutput, SubmitResultOutput } from '../../../contracts/src/tools.ts';
import { LayerResult, ValidationResult, partitionCountsOf, type ItemResult } from '../../../contracts/src/validation.ts';
import { osIsolationAvailable } from '../../../hub/rules/api.ts';
import { startPostgres, type TemporaryPostgres } from '../../../hub/testing/postgres.ts';
import { caseEntry, defectEntry, indexViewOf } from './functions/test-support.ts';
import type { MatrixRow } from './functions/types.ts';
import { BUILD, ROOT, call, openHub, type Hub } from './test-hub.ts';

const skip = (await osIsolationAvailable()) ? false : 'no OS network isolation on this machine (sandbox-exec)';
let postgres: TemporaryPostgres;
let hub: Hub;

function terminalFields(layers: LayerResult[]): Omit<LayerResult, 'missing' | 'exit' | 'gaps'>[] {
  return layers.map(layer => {
    LayerResult.parse(layer);
    if (layer.reason !== undefined) {
      assert.ok(layer.missing);
      assert.equal(layer.exit?.action, 'request');
      assert.equal(layer.exit?.request_kind, 'clarification');
      assert.deepEqual(layer.exit?.audience, { user: hub.alice.id });
    }
    const { missing, exit, gaps, ...fields } = layer;
    return fields;
  });
}


const DEFECTS_ID = `knowledge:index:famx:${BUILD.name}?kind=defect&key=bug`;
const CASES_ID = `knowledge:index:famx:${BUILD.name}?kind=case&key=defects&fields=document,node,title`;

// The corpus: a traced fixed defect, a traced known one, an untraced one, and one in a status conflict.
const DEFECTS = [
  defectEntry({ bug: '71001', statement: '告警阈值修改后不生效' }),
  defectEntry({ bug: '71002', status: 'known', statement: '会话保持在切换后失效' }),
  defectEntry({ bug: '71003', statement: '日志里少了告警一行' }),
  defectEntry({ bug: '71004', status: 'fixed', statement: '证书链校验绕过' }),
  defectEntry({ bug: '71004', status: 'known', statement: '证书链校验绕过（遗留）' }),
];
const CASES = [
  caseEntry({ defects: ['71001'], case: 'C-102', title: '阈值超出范围报错' }),
  caseEntry({ defects: ['71001'], case: 'C-101', title: '修改告警阈值后查询生效' }),
  caseEntry({ defects: ['71002'], case: 'C-103', title: '主备切换后会话保持' }),
  caseEntry({ defects: ['71004'], case: 'C-104', title: '不完整证书链被拒绝' }),
];

const located = (result: ValidationResult, id: string): { partition: string; item: ItemResult } => {
  for (const [partition, items] of Object.entries(result.partitions)) {
    const matches=(items as ItemResult[]).filter(i=>i.item===id || i.item==='plm:'+id || i.item==='bugzilla:'+id);
    assert.ok(matches.length<=1,'number-only lookup cannot choose a cross-system collision');
    const item=matches[0];
    if (item) return { partition, item };
  }
  throw new Error(`item ${id} is in no partition`);
};

before(async () => {
  postgres = await startPostgres();
  if (skip) return;
  hub = await openHub(postgres);
  hub.views.put(DEFECTS_ID, indexViewOf('defect', 'bug', DEFECTS));
  hub.views.put(`${DEFECTS_ID}&fields=bug`, indexViewOf('defect', 'bug', DEFECTS));
  // The cases view is served slim, as the reader answers the pack's fields=document,node,title request.
  hub.views.put(CASES_ID, indexViewOf('case', 'defects', CASES, {}, ['document', 'node', 'title']));
});
after(async () => {
  await hub?.close();
  await postgres?.stop();
});

describe('a production run of traceability', { skip }, () => {
  it('computes and stores the matrix at start_run: every answer a fact claim or an unknown, never a failure for absence', async () => {
    const detail = await hub.service.startRunDetailed(hub.alice, { pack: 'traceability', inputs: { defects: { external: DEFECTS_ID }, cases: { external: CASES_ID } } }, call());
    assert.equal(detail.answer.call_result, 'ok', JSON.stringify(detail.answer.errors));
    assert.ok(StartRunOutput.safeParse({ ...detail.answer, trace: '4bf92f3577b34da6a3ce929d0e0e4736' }).success);
    const run = detail.answer.run!;
    // The pack binds no product line: the views' external ids name the product and the build, and no build is locked.
    assert.deepEqual([run.product, run.version, run.build, run.root], [undefined, undefined, undefined, undefined]);
    assert.deepEqual(
      run.requirements.map((r) => [r.key, r.accepted_producer]),
      [
        ['traced', 'fact'],
        ['counts', 'fact'],
      ],
    );
    // The defects view is the judged source, the cases view the expectation read against it.
    assert.deepEqual(
      run.sources.map((s) => [s.slot, s.role]),
      [
        ['defects', 'subject'],
        ['cases', 'expected'],
      ],
    );
    assert.deepEqual(
      run.sources.map((s) => s.external),
      [`${DEFECTS_ID}@${ROOT}`, `${CASES_ID}&only=71001,71002,71003,71004@${ROOT}`],
    );
    assert.deepEqual(
      run.items.map((i) => [i.id, i.summary]),
      [
        ['71001', '已修复；2 个用例'],
        ['71002', '已知；1 个用例'],
        ['71003', '已修复；无已索引用例（未知）'],
        ['71004', '状态矛盾（已修复、已知）；1 个用例'],
      ],
    );
    assert.match(run.items[0].location, /^src:[0-9a-f]{64}\/json@1\/p\/entries\/[0-9a-f]{64}$/);

    const production = detail.production!;
    assert.ok(production);
    const result = production.result;
    assert.ok(ValidationResult.safeParse(result).success);
    assert.equal(result.acceptance,'accepted');assert.equal(result.errors.length,1);
    assert.ok(result.errors.every(error=>error.code==='missing_input'&&error.item==='71003'&&error.requirement==='traced'&&error.path!==undefined&&error.rounds_left===0&&error.fix?.includes('请求 rec:')));
    assert.deepEqual(production.counts, { delivered: 4, rejected: 0, quarantined: 0, incomplete: 0, unknown: 1 });
    assert.deepEqual(production.counts, partitionCountsOf(result.partitions));

    // The answers, written down before the run: layers, status and the claim data of every defect.
    const EXPECTED: Record<string, { layers: unknown[]; status: string; verdict: string; cases: string[] }> = {
      '71001': { layers: [{ layer: 'static', terminal: 'pass' }], status: 'satisfied', verdict: 'support', cases: ['C-101', 'C-102'] },
      '71002': { layers: [{ layer: 'static', terminal: 'pass' }], status: 'satisfied', verdict: 'support', cases: ['C-103'] },
      '71003': { layers: [{ layer: 'static', terminal: 'unchecked', reason: 'missing_input', attribution: 'data_gap' }], status: 'pending', verdict: 'unknown', cases: [] },
      '71004': {
        layers: [{ layer: 'static', terminal: 'violation', code: 'traceability.status_conflict', tier: 'advisory', attribution: 'author_input' }],
        status: 'unsatisfied',
        verdict: 'refute',
        cases: ['C-104'],
      },
    };
    for (const [id, expected] of Object.entries(EXPECTED)) {
      const { partition, item } = located(result, id);
      assert.equal(partition, 'delivered', id);
      assert.deepEqual(item.requirements.map((r) => r.requirement), ['traced'], id);
      const [requirement] = item.requirements;
      assert.deepEqual(terminalFields(requirement.layers), expected.layers, id);
      assert.equal(requirement.status, expected.status, id);
      assert.equal(requirement.claims.length, 1, id);
      const [claim] = requirement.claims;
      assert.equal(claim.statement.verdict, expected.verdict, id);
      assert.deepEqual(claim.warrant, { producer: 'function', id: 'traceability.traced@1.0.11', independence: 'judge_not_author' }, id);
      assert.equal(claim.qualifier.nature, expected.verdict === 'unknown' ? 'unknown' : 'fact', id);
      const data = claim.statement.data as unknown as MatrixRow & { case_count: number; status: string | null };
      assert.deepEqual(
        data.cases.map((c) => c.case),
        expected.cases,
        id,
      );
      assert.equal(data.case_count, expected.cases.length, id);
      assert.equal(data.bug, id, id);
      assert.equal(claim.pointer, `/items/${run.items.findIndex((i) => i.id === id)}/fields`, id);
      // Grounds are the tree references of the defect entries and of the case entries (in the sorted case order).
      const defectRefs = DEFECTS.filter((d) => d.data.bug === id).map((d) => d.reference).sort();
      const caseRefs = expected.cases.map((caseId) => CASES.find((c) => c.data.node === caseId)!.reference);
      assert.deepEqual(claim.grounds, [...defectRefs, ...caseRefs], id);
    }

    // The run-level counts are a cross-item fact claim.
    const counts = result.cross_item.find((c) => c.requirement === 'counts');
    assert.ok(counts, 'the counts claim');
    assert.equal(counts.statement.verdict, 'support');
    assert.equal(counts.qualifier.nature, 'fact');
    const data = counts.statement.data as { defects: number; traced: number; untraced: number; conflicts: number; build: string };
    assert.deepEqual([data.defects, data.traced, data.untraced, data.conflicts, data.build], [4, 3, 1, 1, BUILD.name]);
    assert.match(counts.statement.text, /缺陷 4 个：已追溯 3 个，未追溯 1 个/);
    assert.deepEqual(counts.grounds.length, 2);

    // The result is the run's latest and readable by reference.
    const view = (await hub.service.getRun(hub.alice, run.run))!;
    assert.deepEqual(view.latest, { record: production.record, result });
  });

  it('selects the defect entries by the statuses parameter', async () => {
    const detail = await hub.service.startRunDetailed(hub.alice, { pack: 'traceability', inputs: { defects: { external: DEFECTS_ID }, cases: { external: CASES_ID } }, parameters: { statuses: ['known'] } }, call());
    assert.equal(detail.answer.call_result, 'ok', JSON.stringify(detail.answer.errors));
    const run = detail.answer.run!;
    assert.deepEqual(
      run.items.map((i) => [i.id, i.summary]),
      [
        ['71002', '已知；1 个用例'],
        ['71004', '已知；1 个用例'],
      ],
    );
    const result = detail.production!.result;
    const conflict = located(result, '71004').item.requirements[0];
    // With the fixed entry filtered out, 71004 is a plain known defect: no conflict.
    assert.deepEqual(conflict.layers, [{ layer: 'static', terminal: 'pass' }]);
    const counts = result.cross_item.find((c) => c.requirement === 'counts')!;
    const data = counts.statement.data as { defects: number; traced: number; untraced: number; conflicts: number };
    assert.deepEqual([data.defects, data.traced, data.untraced, data.conflicts], [2, 2, 0, 0]);
    assert.deepEqual(detail.production!.counts, { delivered: 2, rejected: 0, quarantined: 0, incomplete: 0, unknown: 0 });
  });

  it('keeps the pack from users it is not assigned to, and takes model commentary only as judgments', async () => {
    const refused = await hub.service.startRun(hub.bob, { pack: 'traceability', inputs: { defects: { external: DEFECTS_ID }, cases: { external: CASES_ID } } }, call());
    assert.deepEqual(
      refused.errors.map((e) => e.code),
      ['SOURCE_UNAVAILABLE'],
    );
    const detail = await hub.service.startRunDetailed(hub.alice, { pack: 'traceability', inputs: { defects: { external: DEFECTS_ID }, cases: { external: CASES_ID } } }, call());
    const run = detail.answer.run!;
    const answer = await hub.service.submitResult(hub.alice, { run: run.run, model: 'scripted-model@test', items: [], cross_item: [{ nature: 'judgment', statement: '矩阵与预期一致', grounds: [run.items[0].location] }] }, call());
    assert.ok(SubmitResultOutput.safeParse({ ...answer, trace: '4bf92f3577b34da6a3ce929d0e0e4736' }).success);
    assert.equal(answer.acceptance, 'accepted', JSON.stringify(answer.errors));
    const comment = answer.result!.cross_item.find((c) => c.warrant.producer === 'model')!;
    assert.deepEqual([comment.qualifier.nature, comment.statement.text], ['judgment', '矩阵与预期一致']);
    assert.deepEqual(answer.counts, detail.production!.counts);
  });

  it('binds plm:bugs expected sources and reads defect statuses into checks: closed counts correct', async () => {
    const DEFECTS_WITH_PLM = `knowledge:index:famx:${BUILD.name}?kind=defect&key=bug&variant=plm-bind`;
    const defects = [
      defectEntry({ bug: '81001', statement: '81001已修复', system: 'plm' }),
      defectEntry({ bug: '81002', statement: '81002已知', system: 'plm' }),
    ];
    const cases = [caseEntry({ defects: ['81001'], case: 'C-8101', title: '81001的用例' })];
    hub.views.put(DEFECTS_WITH_PLM, indexViewOf('defect', 'bug', defects));
    hub.views.put(CASES_ID, indexViewOf('case', 'defects', cases, {}, ['document', 'node', 'title']));
    hub.views.put('plm:bugs:81001+81002', {
      bugs: [
        { id: '81001', status: 'closed' },
        { id: '81002', status: 'active' },
      ],
      unread: [],
    });

    const detail = await hub.service.startRunDetailed(hub.alice, { pack: 'traceability', inputs: { defects: { external: DEFECTS_WITH_PLM }, cases: { external: CASES_ID } } }, call());
    assert.equal(detail.answer.call_result, 'ok', JSON.stringify(detail.answer.errors));
    const result = detail.production!.result;

    const c81001 = located(result, '81001').item.requirements[0].claims[0];
    const data1 = c81001.statement.data as Record<string, unknown>;
    assert.equal(data1.closed, true);
    assert.equal(data1.defect_system_status, 'closed');
    assert.equal(data1.defect_system_unknown_reason, null);

    const c81002 = located(result, '81002').item.requirements[0].claims[0];
    const data2 = c81002.statement.data as Record<string, unknown>;
    assert.equal(data2.closed, false);
    assert.equal(data2.defect_system_status, 'active');
    assert.equal(data2.defect_system_unknown_reason, null);

    const counts = result.cross_item.find((c) => c.requirement === 'counts')!;
    const countData = counts.statement.data as Record<string, unknown>;
    assert.equal(countData.closed_defects, 1);
    assert.equal(countData.closed_traced, 1);
    assert.equal(countData.closed_untraced, 0);
    assert.equal(countData.status_unknown, 0);
  });

  it('marks defect system unknown with reason source unavailable when PLM source cannot be read', async () => {
    const DEFECTS_UNREAD = `knowledge:index:famx:${BUILD.name}?kind=defect&key=bug&variant=plm-unread`;
    const defects = [
      defectEntry({ bug: '82001', statement: '82001未读', system: 'plm' }),
    ];
    hub.views.put(DEFECTS_UNREAD, indexViewOf('defect', 'bug', defects));
    // plm:bugs:82001 is NOT put into hub.views -> read fails/unavailable

    const detail = await hub.service.startRunDetailed(hub.alice, { pack: 'traceability', inputs: { defects: { external: DEFECTS_UNREAD }, cases: { external: CASES_ID } } }, call());
    assert.equal(detail.answer.call_result, 'ok', JSON.stringify(detail.answer.errors));
    const result = detail.production!.result;

    const c82001 = located(result, '82001').item.requirements[0].claims[0];
    const data = c82001.statement.data as Record<string, unknown>;
    assert.equal(data.defect_system_status, null);
    assert.equal(data.defect_system_unknown_reason, '缺陷系统没有读到（来源不可用）');
    assert.equal(data.closed, false);

    const counts = result.cross_item.find((c) => c.requirement === 'counts')!;
    const countData = counts.statement.data as Record<string, unknown>;
    assert.equal(countData.closed_defects, 0);
    assert.equal(countData.status_unknown, 1);
  });

  it('reports oversized PLM source in unread_sources and marks status unknown', async () => {
    const DEFECTS_OVERSIZED = `knowledge:index:famx:${BUILD.name}?kind=defect&key=bug&variant=plm-oversized`;
    const defects = [
      defectEntry({ bug: '83001', statement: '83001超大', system: 'plm' }),
    ];
    hub.views.put(DEFECTS_OVERSIZED, indexViewOf('defect', 'bug', defects));
    const hugePayload = {
      bugs: [{ id: '83001', status: 'closed' }],
      unread: [],
      padding: 'x'.repeat(1024 * 1024 + 100),
    };
    hub.views.put('plm:bugs:83001', hugePayload);

    const detail = await hub.service.startRunDetailed(hub.alice, { pack: 'traceability', inputs: { defects: { external: DEFECTS_OVERSIZED }, cases: { external: CASES_ID } } }, call());
    assert.equal(detail.answer.call_result, 'ok', JSON.stringify(detail.answer.errors));
    const result = detail.production!.result;

    const c83001 = located(result, '83001').item.requirements[0].claims[0];
    const data = c83001.statement.data as Record<string, unknown>;
    assert.equal(data.defect_system_status, null);
    assert.equal(data.defect_system_unknown_reason, '缺陷系统没有读到（来源不可用）');
    assert.equal(data.closed, false);

    const counts = result.cross_item.find((c) => c.requirement === 'counts')!;
    const countData = counts.statement.data as Record<string, unknown>;
    assert.equal(countData.closed_defects, 0);
    assert.equal(countData.status_unknown, 1);
  });

  it('filters bound sources by types so oversized cases view is not read and unreturned bug reports ID not returned', async () => {
    const DEFECTS_WITH_OMISSION = `knowledge:index:famx:${BUILD.name}?kind=defect&key=bug&variant=plm-omission`;
    const defects = [
      defectEntry({ bug: '84001', statement: '84001在PLM', system: 'plm' }),
      defectEntry({ bug: '84002', statement: '84002未返回', system: 'plm' }),
    ];
    hub.views.put(DEFECTS_WITH_OMISSION, indexViewOf('defect', 'bug', defects));
    // Cases view is huge (over 1 MiB limit)
    const HUGE_CASES_ID = `knowledge:index:famx:${BUILD.name}?kind=case&key=defects&variant=huge-cases`;
    const hugeCases = [caseEntry({ defects: ['84001'], case: 'C-8401', title: '84001用例' })];
    const hugeCasesObj = indexViewOf('case', 'defects', hugeCases, {}, ['document', 'node', 'title']);
    const firstCase=Object.values(hugeCasesObj.entries as Record<string,{data:Record<string,unknown>}>)[0];
    firstCase.data.title=String(firstCase.data.title)+'y'.repeat(1024 * 1024 + 100);
    hub.views.put(HUGE_CASES_ID, hugeCasesObj);

    hub.views.put('plm:bugs:84001+84002', {
      bugs: [{ id: '84001', status: 'closed' }],
      unread: [], // 84002 is not in bugs and not in unread
    });

    const detail = await hub.service.startRunDetailed(hub.alice, { pack: 'traceability', inputs: { defects: { external: DEFECTS_WITH_OMISSION }, cases: { external: HUGE_CASES_ID } } }, call());
    assert.equal(detail.answer.call_result, 'ok', JSON.stringify(detail.answer.errors));
    const result = detail.production!.result;

    // 84001 has status closed
    const c84001 = located(result, '84001').item.requirements[0].claims[0];
    const data1 = c84001.statement.data as Record<string, unknown>;
    assert.equal(data1.closed, true);
    assert.equal(data1.defect_system_status, 'closed');

    // 84002 must be "缺陷系统没有返回这个编号", NOT "来源不可用" (because huge cases view was not read!)
    const c84002 = located(result, '84002').item.requirements[0].claims[0];
    const data2 = c84002.statement.data as Record<string, unknown>;
    assert.equal(data2.defect_system_status, null);
    assert.equal(data2.defect_system_unknown_reason, '缺陷系统没有返回这个编号');
    assert.equal(data2.closed, false);
  });
});

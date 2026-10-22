// A production run end to end: the published traceability pack, the real run engine, and hand-built index views served by a
// fake knowledge reader. start_run computes and stores the validation result with no submission; each per-defect answer,
// written down here first, comes back as the data of a fact claim, and the run-level counts as a cross-item claim.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { StartRunOutput, SubmitResultOutput } from '../../../contracts/src/tools.ts';
import { ValidationResult, partitionCountsOf, type ItemResult } from '../../../contracts/src/validation.ts';
import { osIsolationAvailable } from '../../../hub/rules/api.ts';
import { startPostgres, type TemporaryPostgres } from '../../../hub/testing/postgres.ts';
import { caseEntry, defectEntry, indexViewOf } from './functions/test-support.ts';
import type { MatrixRow } from './functions/types.ts';
import { BUILD, ROOT, call, openHub, type Hub } from './test-hub.ts';

const skip = (await osIsolationAvailable()) ? false : 'no OS network isolation on this machine (sandbox-exec)';
let postgres: TemporaryPostgres;
let hub: Hub;

const DEFECTS_ID = `knowledge:index:apv:${BUILD.name}?kind=defect&key=bug`;
const CASES_ID = `knowledge:index:apv:${BUILD.name}?kind=case&key=defects&fields=document,node,title`;

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
    const item = (items as ItemResult[]).find((i) => i.item === id);
    if (item) return { partition, item };
  }
  throw new Error(`item ${id} is in no partition`);
};

before(async () => {
  postgres = await startPostgres();
  if (skip) return;
  hub = await openHub(postgres);
  hub.views.put(DEFECTS_ID, indexViewOf('defect', 'bug', DEFECTS));
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
      [`${DEFECTS_ID}@${ROOT}`, `${CASES_ID}@${ROOT}`],
    );
    assert.deepEqual(
      run.items.map((i) => [i.id, i.summary]),
      [
        ['71001', '已修复；2 个用例'],
        ['71002', '已知（未修复）；1 个用例'],
        ['71003', '已修复；无已索引用例（未知）'],
        ['71004', '状态矛盾（已修复、已知）；1 个用例'],
      ],
    );
    assert.match(run.items[0].location, /^src:[0-9a-f]{64}\/json@1\/p\/entries\/[0-9a-f]{64}$/);

    const production = detail.production!;
    assert.ok(production);
    const result = production.result;
    assert.ok(ValidationResult.safeParse(result).success);
    assert.deepEqual([result.acceptance, result.errors], ['accepted', []]);
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
      assert.deepEqual(requirement.layers, expected.layers, id);
      assert.equal(requirement.status, expected.status, id);
      assert.equal(requirement.claims.length, 1, id);
      const [claim] = requirement.claims;
      assert.equal(claim.statement.verdict, expected.verdict, id);
      assert.deepEqual(claim.warrant, { producer: 'function', id: 'traceability.traced@1.0.2', independence: 'judge_not_author' }, id);
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
        ['71002', '已知（未修复）；1 个用例'],
        ['71004', '已知（未修复）；1 个用例'],
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
});

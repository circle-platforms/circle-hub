// A production run end to end: the published case-location pack, the real run engine, invented agile mind maps read as
// external objects with their tree facts, and PLM stories and bugs bound as expected sources. start_run computes and stores
// the validation result with no submission; each answer, written down here first, comes back as the data of a fact claim.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { StartRunOutput, SubmitResultOutput } from '../../../contracts/src/tools.ts';
import { ValidationResult, partitionCountsOf, type ItemResult } from '../../../contracts/src/validation.ts';
import { createPacksPort, createWorkflowStore } from '../../../hub/runs/api.ts';
import { osIsolationAvailable } from '../../../hub/rules/api.ts';
import { startPostgres, type TemporaryPostgres } from '../../../hub/testing/postgres.ts';
import { mindMapJson, smallMap } from './functions/test-support.ts';
import type { LocateAnswer } from './functions/types.ts';
import { BUILD, ROOT, call, openHub, publishProduct, type Hub } from './test-hub.ts';

const skip = (await osIsolationAvailable()) ? false : 'no OS network isolation on this machine (sandbox-exec)';
let postgres: TemporaryPostgres;
let hub: Hub;

const P0 = '030：APV/NSAE测试项目';
const DOCUMENTS: Record<string, { title: string; root: string; ancestors: string[] }> = {
  '24001': { title: '需求20931 证书链校验', root: 'NSAE', ancestors: [P0, '060：10.6.1', '004：10.6.1-R2-2026/7', 'SSL'] },
  '24002': { title: 'bug to case 90220 告警', root: 'APV', ancestors: ['通用用例', '基础功能'] },
  '24003': { title: 'NSAE 10.6.2.31 升级兼容', root: 'NSAE', ancestors: [P0, '专项'] },
  '24004': { title: 'Bug 61001 会话保持', root: '合成平台', ancestors: [P0, '060：10.6.1', '004：10.6.1-R2-2026/7', 'SLB'] },
};
const external = (id: string) => ({ external: `agile:mindmap:${id}` });
const ALL = { documents: Object.keys(DOCUMENTS).map(external) };

/** The answers, written from the owner's scheme before the run. */
const EXPECTED: Record<string, { verdict: string; product: [string | null, string | null]; version: string | null; source: string; confidence: string; line: string | null; train: string | null; module: string | null; build_names: string[]; requirements: string[]; defects: string[]; unclassified: string[] }> = {
  '24001': { verdict: 'support', product: ['apv', 'NSAE'], version: '10.6.1', source: 'folders', confidence: 'high', line: '10.6.1', train: '10.6.1-R2-2026/7', module: 'SSL', build_names: [], requirements: ['20931'], defects: [], unclassified: [] },
  '24002': { verdict: 'unknown', product: ['apv', 'APV'], version: null, source: 'none', confidence: 'none', line: null, train: null, module: null, build_names: [], requirements: [], defects: [], unclassified: ['90220'] },
  '24003': { verdict: 'unknown', product: ['apv', 'NSAE'], version: '10.6.2.31', source: 'title', confidence: 'low', line: null, train: null, module: null, build_names: [], requirements: [], defects: [], unclassified: [] },
  '24004': { verdict: 'unknown', product: [null, '合成平台'], version: '10.6.1', source: 'folders', confidence: 'high', line: '10.6.1', train: '10.6.1-R2-2026/7', module: 'SLB', build_names: [], requirements: [], defects: ['61001'], unclassified: [] },
};

/** The build candidates requirement: no check is installed (the check would need the line's builds), so it is unchecked. */
const NO_CANDIDATES = [{ layer: 'static', terminal: 'unchecked', reason: 'no_check', attribution: 'unattributed' }];

before(async () => {
  postgres = await startPostgres();
  if (skip) return;
  hub = await openHub(postgres);
  for (const [id, d] of Object.entries(DOCUMENTS)) {
    hub.external.put(`agile:mindmap:${id}`, { bytes: new TextEncoder().encode(mindMapJson(id, smallMap(id, d.title))), mediaType: 'application/json', meta: { title: d.title, root: d.root, ancestors: d.ancestors } });
  }
  hub.external.put('agile:mindmap:24005', {
    bytes: new TextEncoder().encode(mindMapJson('24005', smallMap('24005', '31006-SSL证书链'))),
    mediaType: 'application/json',
    meta: { title: '31006-SSL证书链', root: 'NSAE', ancestors: [P0, '060：10.6.1', '004：10.6.1-R2-2026/7', 'SSL'] },
  });
  hub.external.put('plm:story:20931', { bytes: new TextEncoder().encode('# 需求 20931 证书链校验\n\n设备校验服务器证书链，链不完整时拒绝连接。\n'), mediaType: 'text/markdown', meta: { title: '需求 20931 证书链校验' } });
  hub.external.put('plm:story:31006', { bytes: new TextEncoder().encode('# 需求 31006 证书链\n\n证书链的长度上限可配置。\n'), mediaType: 'text/markdown', meta: { title: '需求 31006 证书链' } });
  hub.external.put('plm:bug:90220', { bytes: new TextEncoder().encode('缺陷 90220：告警阈值修改后不生效。影响版本 10.6.1。\n'), mediaType: 'text/plain', meta: { title: '缺陷 90220' } });
  hub.external.put('plm:bug:61001', { bytes: new TextEncoder().encode('缺陷 61001：会话保持在切换后失效。\n'), mediaType: 'text/plain' });
});
after(async () => {
  await hub?.close();
  await postgres?.stop();
});

const located = (result: ValidationResult, id: string): { partition: string; item: ItemResult } => {
  for (const [partition, items] of Object.entries(result.partitions)) {
    const item = (items as ItemResult[]).find((i) => i.item === id);
    if (item) return { partition, item };
  }
  throw new Error(`item ${id} is in no partition`);
};
const answerOf = (result: ValidationResult, id: string): LocateAnswer => located(result, id).item.requirements[0].claims[0].statement.data as unknown as LocateAnswer;

describe('a production run of case-location', { skip }, () => {
  it('computes and stores the location of every document at start_run, each answer a fact claim or an unknown', async () => {
    const detail = await hub.service.startRunDetailed(hub.alice, { pack: 'case-location', product: 'NSAE', inputs: ALL }, call());
    assert.equal(detail.answer.call_result, 'ok', JSON.stringify(detail.answer.errors));
    assert.ok(StartRunOutput.safeParse({ ...detail.answer, trace: '4bf92f3577b34da6a3ce929d0e0e4736' }).success);
    const run = detail.answer.run!;
    // The run is bound to the line named by either of its names; the locked build is the knowledge root, not the located version.
    assert.deepEqual([run.product, run.version, run.build, run.root], ['apv', BUILD.line, BUILD.name, ROOT]);
    assert.equal(run.slots, undefined);
    assert.deepEqual(
      run.requirements.map((r) => [r.key, r.accepted_producer]),
      [
        ['location', 'fact'],
        ['build_candidates', 'fact'],
      ],
    );
    assert.deepEqual(
      run.items.map((i) => [i.id, i.label]),
      Object.entries(DOCUMENTS).map(([id, d]) => [id, d.title]),
    );
    assert.equal(run.items[0].summary, '产品线 apv（NSAE）；版本 10.6.1（目录，置信度高）；发布火车 10.6.1-R2-2026/7；模块 SSL；需求 20931');
    assert.match(run.items[1].summary!, /^不确定（没有版本层）：产品线 apv（APV）；版本未知/);
    // The PLM records a word names in a title are bound as expected sources; the unmarked 90220 is read neither as a story
    // nor as a bug, so no false evidence gap and no unrelated record.
    assert.deepEqual(
      run.sources.filter((s) => s.role === 'expected').map((s) => s.external),
      ['plm:story:20931@1', 'plm:bug:61001@1'],
    );
    assert.deepEqual(
      run.sources.filter((s) => s.role === 'subject').map((s) => s.external),
      ['agile:mindmap:24001@1', 'agile:mindmap:24002@1', 'agile:mindmap:24003@1', 'agile:mindmap:24004@1'],
    );
    assert.ok(!hub.external.reads.some((id) => id.endsWith(':90220')), hub.external.reads.join(', '));
    assert.deepEqual(detail.unavailable, []);

    const production = detail.production!;
    assert.ok(production);
    const result = production.result;
    assert.ok(ValidationResult.safeParse(result).success);
    assert.deepEqual([result.acceptance, result.errors, result.cross_item], ['accepted', [], []]);
    // Every item has its build candidates unchecked, so every item counts as unknown.
    assert.deepEqual(production.counts, { delivered: 4, rejected: 0, quarantined: 0, incomplete: 0, unknown: 4 });
    assert.deepEqual(production.counts, partitionCountsOf(result.partitions));
    for (const [k, [id, expected]] of Object.entries(EXPECTED).entries()) {
      const { partition, item } = located(result, id);
      assert.equal(partition, 'delivered', id);
      assert.deepEqual(
        item.requirements.map((r) => r.requirement),
        ['location', 'build_candidates'],
      );
      const [requirement, candidates] = item.requirements;
      assert.deepEqual([candidates.layers, candidates.status, candidates.claims], [NO_CANDIDATES, 'pending', []], id);
      assert.equal(requirement.claims.length, 1, id);
      const [claim] = requirement.claims;
      const answer = claim.statement.data as unknown as LocateAnswer;
      assert.deepEqual(
        {
          verdict: claim.statement.verdict,
          product: [answer.product_line, answer.product_name],
          version: answer.version,
          source: answer.version_source,
          confidence: answer.confidence,
          line: answer.line,
          train: answer.train,
          module: answer.module,
          build_names: answer.build_names,
          requirements: answer.requirements,
          defects: answer.defects,
          unclassified: answer.unclassified,
        },
        expected,
        id,
      );
      assert.equal(answer.case_id, id);
      assert.equal(answer.source, `agile:mindmap:${id}@1`);
      assert.deepEqual(answer.ancestor_path, [DOCUMENTS[id].root, ...DOCUMENTS[id].ancestors]);
      assert.deepEqual(claim.warrant, { producer: 'function', id: 'case-location.locate@1.0.0', independence: 'judge_not_author' });
      assert.deepEqual(claim.grounds, [run.items.find((i) => i.id === id)!.location]);
      // The folders are not in the cited node: the claim points at the item's fields, as the run record holds them.
      assert.equal(claim.pointer, `/items/${k}/fields`);
      assert.deepEqual(run.items[k].fields.ancestors, DOCUMENTS[id].ancestors);
      assert.match(claim.statement.text, /目录是敏捷平台读取时列出的，取自系统包的元数据，没有引用片段/);
      if (expected.verdict === 'support') {
        assert.deepEqual([claim.qualifier.nature, claim.qualifier.basis_rank, requirement.status], ['fact', 'rule_over_observation', 'satisfied']);
        assert.deepEqual(requirement.layers, [{ layer: 'static', terminal: 'pass' }]);
      } else {
        assert.deepEqual([claim.qualifier.nature, claim.statement.reason, requirement.status], ['unknown', 'missing_input', 'pending']);
        assert.deepEqual(requirement.layers, [{ layer: 'static', terminal: 'unchecked', reason: 'missing_input', attribution: 'data_gap' }]);
      }
    }
    // The result is the run's latest and readable by reference.
    const view = (await hub.service.getRun(hub.alice, run.run))!;
    assert.deepEqual(view.latest, { record: production.record, result });
  });

  it('refutes a declaration that contradicts the tree and fills only what the tree does not give', async () => {
    const detail = await hub.service.startRunDetailed(hub.alice, { pack: 'case-location', product: 'APV', inputs: ALL, parameters: { line: '10.5.3' } }, call());
    assert.equal(detail.answer.call_result, 'ok', JSON.stringify(detail.answer.errors));
    const result = detail.production!.result;
    const conflict = located(result, '24001').item.requirements[0];
    assert.deepEqual(conflict.layers, [{ layer: 'static', terminal: 'violation', code: 'case-location.declaration_conflict', tier: 'advisory', attribution: 'author_input' }]);
    assert.deepEqual([conflict.status, conflict.unsatisfied_reason], ['unsatisfied', 'outcome_mismatch']);
    assert.deepEqual((conflict.claims[0].statement.data as unknown as LocateAnswer).conflicts, [{ field: 'line', declared: '10.5.3', tree: '10.6.1' }]);
    const filled = located(result, '24002').item.requirements[0];
    const answer = filled.claims[0].statement.data as unknown as LocateAnswer;
    assert.deepEqual([answer.version, answer.version_source, answer.confidence, answer.declared], ['10.5.3', 'parameter', 'low', ['line', 'version']]);
    assert.equal(filled.layers[0].terminal, 'unchecked');
    // The document under another root has no product line, but its folders give 10.6.1: the declaration contradicts that too.
    assert.equal(located(result, '24004').item.requirements[0].layers[0].terminal, 'violation');
    assert.equal(located(result, '24003').item.requirements[0].layers[0].terminal, 'unchecked');
    assert.deepEqual(detail.production!.counts, { delivered: 4, rejected: 0, quarantined: 0, incomplete: 0, unknown: 4 });
  });

  it('binds the product line the pack declares when the run names none', async () => {
    const detail = await hub.service.startRunDetailed(hub.alice, { pack: 'case-location', inputs: { documents: [external('24001')] } }, call());
    assert.equal(detail.answer.call_result, 'ok', JSON.stringify(detail.answer.errors));
    const run = detail.answer.run!;
    assert.deepEqual([run.product, run.root], ['apv', ROOT]);
    const item = located(detail.production!.result, '24001').item.requirements[0];
    const answer = item.claims[0].statement.data as unknown as LocateAnswer;
    assert.deepEqual([answer.product_line, answer.product_name, answer.version, item.claims[0].statement.verdict], ['apv', 'NSAE', '10.6.1', 'support']);
  });

  it('binds the kind the declared id ranges give and reports it apart from the tree facts', async () => {
    const parameters = { id_ranges: { story: { min: 10000, max: 49999 }, bug: { min: 50000 } } };
    const detail = await hub.service.startRunDetailed(hub.alice, { pack: 'case-location', inputs: { documents: [external('24005'), external('24002')] }, parameters }, call());
    assert.equal(detail.answer.call_result, 'ok', JSON.stringify(detail.answer.errors));
    const run = detail.answer.run!;
    assert.deepEqual(
      run.sources.filter((s) => s.role === 'expected').map((s) => s.external),
      ['plm:story:31006@1', 'plm:bug:90220@1'],
    );
    const result = detail.production!.result;
    const ranged = answerOf(result, '24005');
    assert.deepEqual([ranged.unclassified, ranged.ranged, ranged.declared], [['31006'], { requirements: ['31006'], defects: [] }, []]);
    const claim = located(result, '24005').item.requirements[0].claims[0];
    assert.deepEqual([claim.statement.verdict, claim.qualifier.nature], ['support', 'fact']);
    assert.match(claim.statement.text, /未分类编号 31006（声明的范围：需求）/);
    assert.deepEqual(answerOf(result, '24002').ranged, { requirements: [], defects: ['90220'] });
  });

  it('locates every case of a document with granularity case', async () => {
    const detail = await hub.service.startRunDetailed(hub.alice, { pack: 'case-location', product: 'NSAE', inputs: { documents: [external('24001')] }, parameters: { granularity: 'case' } }, call());
    assert.equal(detail.answer.call_result, 'ok', JSON.stringify(detail.answer.errors));
    const run = detail.answer.run!;
    assert.deepEqual(
      run.items.map((i) => [i.id, i.label]),
      [
        ['24001:24001n2', '设置参数后查看结果'],
        ['24001:24001n4', '参数超出范围时报错'],
      ],
    );
    const answer = answerOf(detail.production!.result, '24001:24001n2');
    assert.deepEqual([answer.version, answer.module, answer.ancestor_path.slice(-2)], ['10.6.1', 'SSL', ['需求20931 证书链校验', '基本功能']]);
    assert.deepEqual(detail.production!.counts, { delivered: 2, rejected: 0, quarantined: 0, incomplete: 0, unknown: 2 });
  });

  it('keeps the pack from users it is not assigned to, and takes model commentary only as judgments', async () => {
    const refused = await hub.service.startRun(hub.bob, { pack: 'case-location', inputs: ALL }, call());
    assert.deepEqual(
      refused.errors.map((e) => e.code),
      ['SOURCE_UNAVAILABLE'],
    );
    const detail = await hub.service.startRunDetailed(hub.alice, { pack: 'case-location', product: 'NSAE', inputs: { documents: [external('24001')] } }, call());
    const run = detail.answer.run!;
    const answer = await hub.service.submitResult(hub.alice, { run: run.run, model: 'scripted-model@test', items: [], cross_item: [{ nature: 'judgment', statement: '定位与目录一致', grounds: [run.items[0].location] }] }, call());
    assert.ok(SubmitResultOutput.safeParse({ ...answer, trace: '4bf92f3577b34da6a3ce929d0e0e4736' }).success);
    assert.equal(answer.acceptance, 'accepted', JSON.stringify(answer.errors));
    const comment = answer.result!.cross_item.find((c) => c.warrant.producer === 'model')!;
    assert.deepEqual([comment.qualifier.nature, comment.statement.text], ['judgment', '定位与目录一致']);
    assert.deepEqual(answer.counts, detail.production!.counts);
  });

  it('binds only its own line when another product line is active: no other names, no other knowledge, no other runs', async () => {
    await publishProduct(hub, { id: 'acme', title: '合成的另一条产品线', names: ['Acme', 'Widget'] });
    const [summary] = (await createWorkflowStore(hub.registry).summaries(hub.alice)).filter((s) => s.id === 'case-location');
    assert.deepEqual(summary.products, ['APV', 'NSAE']);
    assert.deepEqual([...(await createPacksPort(hub.registry).readableProducts(hub.alice))], ['apv']);
    const other = await hub.service.startRun(hub.alice, { pack: 'case-location', product: 'Acme', inputs: { documents: [external('24001')] } }, call());
    assert.deepEqual(
      other.errors.map((e) => [e.code, e.path]),
      [['REFERENCE_UNRESOLVED', '/product']],
    );
    // Without a product the run still binds the pack's own line.
    const own = await hub.service.startRun(hub.alice, { pack: 'case-location', inputs: { documents: [external('24001')] } }, call());
    assert.equal(own.run?.product, 'apv');
  });
});

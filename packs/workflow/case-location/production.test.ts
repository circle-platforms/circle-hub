// A production run end to end: the published case-location pack, the real run engine, invented agile mind maps read as
// external objects with their tree facts, and PLM stories and bugs bound as expected sources. start_run computes and stores
// the validation result with no submission; each answer, written down here first, comes back as the data of a fact claim.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { IDENTITY } from './pack-files.ts';
import { StartRunOutput, SubmitResultOutput } from '../../../contracts/src/tools.ts';
import { LayerResult, ValidationResult, partitionCountsOf, type ItemResult } from '../../../contracts/src/validation.ts';
import { createPacksPort, createWorkflowStore } from '../../../hub/runs/api.ts';
import { osIsolationAvailable } from '../../../hub/rules/api.ts';
import { startPostgres, type TemporaryPostgres } from '../../../hub/testing/postgres.ts';
import { mindMapJson, smallMap } from './functions/test-support.ts';
import type { LocateAnswer } from './functions/types.ts';
import { BUILD, ROOT, call, openHub, publishProduct, type Hub } from './test-hub.ts';

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


const P0 = '030：FAMX/FAMY测试项目';
const DOCUMENTS: Record<string, { title: string; root: string; ancestors: string[] }> = {
  '24001': { title: 'story:20931', root: 'FAMY', ancestors: [P0, '060：10.6.1', '004：10.6.1-R2-2026/7', 'SSL'] },
  '24002': { title: 'bug:90220', root: 'FAMX', ancestors: ['通用用例', '基础功能'] },
  '24003': { title: 'FAMY 10.6.2.31 升级兼容', root: 'FAMY', ancestors: [P0, '专项'] },
  '24004': { title: 'bug:61001', root: '合成平台', ancestors: [P0, '060：10.6.1', '004：10.6.1-R2-2026/7', 'SLB'] },
};
const external = (id: string) => ({ external: `agile:mindmap:${id}` });
const ALL = { documents: Object.keys(DOCUMENTS).map(external) };

/** The answers, written from the owner's scheme before the run. */
const EXPECTED: Record<string, { verdict: string; product: [string | null, string | null]; version: string | null; source: string; confidence: string; line: string | null; train: string | null; module: string | null; build_names: string[]; requirements: string[]; defects: string[]; unclassified: string[] }> = {
  '24001': { verdict: 'support', product: ['famx', 'FAMY'], version: '10.6.1', source: 'folders', confidence: 'high', line: '10.6.1', train: '10.6.1-R2-2026/7', module: 'SSL', build_names: [], requirements: ['20931'], defects: [], unclassified: [] },
  '24002': { verdict: 'unknown', product: ['famx', 'FAMX'], version: null, source: 'none', confidence: 'none', line: null, train: null, module: null, build_names: [], requirements: [], defects: ['90220'], unclassified: [] },
  '24003': { verdict: 'unknown', product: ['famx', 'FAMY'], version: null, source: 'none', confidence: 'none', line: null, train: null, module: null, build_names: [], requirements: [], defects: [], unclassified: [] },
  '24004': { verdict: 'unknown', product: [null, '合成平台'], version: '10.6.1', source: 'folders', confidence: 'high', line: '10.6.1', train: '10.6.1-R2-2026/7', module: 'SLB', build_names: [], requirements: [], defects: ['61001'], unclassified: [] },
};

/** The candidates of line 10.6.1 as the check lists them (released first by date descending, then unreleased by name). */
const CANDIDATES_10_6_1 = [
  { name: 'Rel_FAMX_10_6_1_63', family: 'FAMX', base: 'Rel_FAMX_10_6_1_63', alias: false, platform: null, built_at: '2026-09-25T00:00:00.000Z', released: false },
  { name: 'Rel_FAMX_10_6_1_60', family: 'FAMX', base: 'Rel_FAMX_10_6_1_60', alias: false, platform: null, built_at: '2026-09-18T00:00:00.000Z', released: true },
  { name: 'Rel_FAMX_10_6_1_57', family: 'FAMX', base: 'Rel_FAMX_10_6_1_57', alias: false, platform: null, built_at: '2026-09-01T00:00:00.000Z', released: true },
  { name: 'Rel_FAMY_10_6_1_57', family: 'FAMY', base: 'Rel_FAMX_10_6_1_57', alias: true, platform: null, built_at: '2026-09-01T00:00:00.000Z', released: true },
  { name: 'Rel_FAMY_10_6_1_11', family: 'FAMY', base: 'Rel_FAMY_10_6_1_11', alias: false, platform: null, built_at: '2026-08-01T00:00:00.000Z', released: true },
];
/** The build_candidates outcome per document of the main run: a located line gives its candidates, none is an unknown. */
const CANDIDATES: Record<string, { status: string; verdict: string; line: string | null }> = {
  '24001': { status: 'satisfied', verdict: 'support', line: '10.6.1' },
  '24002': { status: 'pending', verdict: 'unknown', line: null },
  '24003': { status: 'pending', verdict: 'unknown', line: null },
  '24004': { status: 'satisfied', verdict: 'support', line: '10.6.1' },
};

before(async () => {
  postgres = await startPostgres();
  if (skip) return;
  hub = await openHub(postgres);
  for (const [id, d] of Object.entries(DOCUMENTS)) {
    hub.external.put(`agile:mindmap:${id}`, { bytes: new TextEncoder().encode(mindMapJson(id, smallMap(id, d.title))), mediaType: 'application/json', meta: { title: d.title, root: d.root, ancestors: d.ancestors } });
  }
  hub.external.put('agile:mindmap:24005', {
    bytes: new TextEncoder().encode(mindMapJson('24005', smallMap('24005', '33001'))),
    mediaType: 'application/json',
    meta: { title: '33001', root: 'FAMY', ancestors: [P0, '060：10.6.1', '004：10.6.1-R2-2026/7', 'SSL'] },
  });
  hub.external.put('agile:mindmap:24006', {
    bytes: new TextEncoder().encode(mindMapJson('24006', smallMap('24006', 'Rel_FAMX_10_7_4_101 会话保持'))),
    mediaType: 'application/json',
    meta: { title: 'Rel_FAMX_10_7_4_101 会话保持', root: 'FAMY', ancestors: [P0, '060：10.6.1', '004：10.6.1-R2-2026/7', 'SLB'] },
  });
  hub.external.put('plm:story:20931', { bytes: new TextEncoder().encode('# 需求 20931 证书链校验\n\n设备校验服务器证书链，链不完整时拒绝连接。\n'), mediaType: 'text/markdown', meta: { title: '需求 20931 证书链校验' } });
  hub.external.put('plm:story:33001', { bytes: new TextEncoder().encode('# 需求 33001 证书链\n\n证书链的长度上限可配置。\n'), mediaType: 'text/markdown', meta: { title: '需求 33001 证书链' } });
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
    const detail = await hub.service.startRunDetailed(hub.alice, { pack: 'case-location', product: 'FAMY', inputs: ALL }, call());
    assert.equal(detail.answer.call_result, 'ok', JSON.stringify(detail.answer.errors));
    assert.ok(StartRunOutput.safeParse({ ...detail.answer, trace: '4bf92f3577b34da6a3ce929d0e0e4736' }).success);
    const run = detail.answer.run!;
    // The run is bound to the line named by either of its names; the locked build is the knowledge root, not the located version.
    assert.deepEqual([run.product, run.version, run.build, run.root], ['famx', BUILD.line, BUILD.name, ROOT]);
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
    assert.equal(run.items[0].summary, '产品线 famx（FAMY）；版本 10.6.1（目录，置信度高）；发布火车 10.6.1-R2-2026/7；模块 SSL；需求 20931');
    assert.match(run.items[1].summary!, /^不确定（没有版本层，发布火车层未知，模块层未知）：产品线 famx（FAMX）；版本未知/);
    // famx-id-fields@1: a whole declared field binds its expected source; a marker word in prose binds nothing.
    assert.deepEqual(
      run.sources.filter((s) => s.role === 'expected').map((s) => s.external),
      ['plm:story:20931@1', 'plm:bug:90220@1', 'plm:bug:61001@1'],
    );
    assert.deepEqual(
      run.sources.filter((s) => s.role === 'subject').map((s) => s.external),
      ['agile:mindmap:24001@1', 'agile:mindmap:24002@1', 'agile:mindmap:24003@1', 'agile:mindmap:24004@1'],
    );
    assert.equal(hub.external.reads.filter(id => id.endsWith(':90220')).length, 1);
    assert.deepEqual(detail.unavailable, []);

    const production = detail.production!;
    assert.ok(production);
    const result = production.result;
    assert.ok(ValidationResult.safeParse(result).success);
    assert.equal(result.acceptance,'accepted');assert.deepEqual(result.cross_item,[]);
    assert.ok(result.errors.length>0,'missing location facts are visible in the accepted receipt');
    assert.ok(result.errors.every(error=>error.code==='missing_input'&&error.item!==undefined&&error.requirement!==undefined&&error.rounds_left===0&&error.path!==undefined&&error.fix?.includes('请求 rec:')));
    // 24002 and 24003 are unknown on both requirements (no version line), 24004 on location (a root of no product line).
    assert.deepEqual(production.counts, { delivered: 4, rejected: 0, quarantined: 0, incomplete: 0, unknown: 3 });
    assert.deepEqual(production.counts, partitionCountsOf(result.partitions));
    for (const [k, [id, expected]] of Object.entries(EXPECTED).entries()) {
      const { partition, item } = located(result, id);
      assert.equal(partition, 'delivered', id);
      assert.deepEqual(
        item.requirements.map((r) => r.requirement),
        ['location', 'build_candidates'],
      );
      const [requirement, candidates] = item.requirements;
      const expectedCandidates = CANDIDATES[id];
      assert.equal(candidates.status, expectedCandidates.status, id);
      assert.equal(candidates.claims.length, 1, id);
      const candidatesClaim = candidates.claims[0];
      assert.equal(candidatesClaim.statement.verdict, expectedCandidates.verdict, id);
      assert.deepEqual(candidatesClaim.warrant, { producer: 'function', id: `case-location.candidates@${IDENTITY.version}`, independence: 'judge_not_author' }, id);
      const candidatesData = candidatesClaim.statement.data as { kind: string; line: string | null; candidates: unknown[] };
      assert.equal(candidatesData.kind, 'candidates', id);
      assert.equal(candidatesData.line, expectedCandidates.line, id);
      if (expectedCandidates.verdict === 'support') {
        assert.deepEqual(candidates.layers, [{ layer: 'static', terminal: 'pass' }], id);
        assert.deepEqual(candidatesData.candidates, CANDIDATES_10_6_1, id);
        assert.match(candidatesClaim.statement.text, /版本线 10\.6\.1 的构建候选 5 个，其中别名 1 个（别名基于它所基于的构建），按制作时间从新到旧/, id);
      } else {
        assert.deepEqual(terminalFields(candidates.layers), [{ layer: 'static', terminal: 'unchecked', reason: 'missing_input', attribution: 'data_gap' }], id);
        assert.match(candidatesClaim.statement.text, /版本线/, id);
        assert.deepEqual(candidatesData.candidates, [], id);
      }
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
      assert.deepEqual(claim.warrant, { producer: 'function', id: `case-location.locate@${IDENTITY.version}`, independence: 'judge_not_author' });
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
        assert.deepEqual(terminalFields(requirement.layers), [{ layer: 'static', terminal: 'unchecked', reason: 'missing_input', attribution: 'data_gap' }]);
      }
    }
    // The result is the run's latest and readable by reference.
    const view = (await hub.service.getRun(hub.alice, run.run))!;
    assert.deepEqual(view.latest, { record: production.record, result });
  });

  it('refutes a declaration that contradicts the tree and fills only what the tree does not give', async () => {
    const detail = await hub.service.startRunDetailed(hub.alice, { pack: 'case-location', product: 'FAMX', inputs: ALL, parameters: { line: '10.7.3' } }, call());
    assert.equal(detail.answer.call_result, 'ok', JSON.stringify(detail.answer.errors));
    const result = detail.production!.result;
    const conflict = located(result, '24001').item.requirements[0];
    assert.deepEqual(conflict.layers, [{ layer: 'static', terminal: 'violation', code: 'case-location.declaration_conflict', tier: 'advisory', attribution: 'author_input' }]);
    assert.deepEqual([conflict.status, conflict.unsatisfied_reason], ['unsatisfied', 'outcome_mismatch']);
    assert.deepEqual((conflict.claims[0].statement.data as unknown as LocateAnswer).conflicts, [{ field: 'line', declared: '10.7.3', tree: '10.6.1' }]);
    const filled = located(result, '24002').item.requirements[0];
    const answer = filled.claims[0].statement.data as unknown as LocateAnswer;
    assert.deepEqual([answer.version, answer.version_source, answer.confidence, answer.declared], ['10.7.3', 'parameter', 'low', ['line', 'version']]);
    assert.equal(filled.layers[0].terminal, 'unchecked');
    // The document under another root has no product line, but its folders give 10.6.1: the declaration contradicts that too.
    assert.equal(located(result, '24004').item.requirements[0].layers[0].terminal, 'violation');
    assert.equal(located(result, '24003').item.requirements[0].layers[0].terminal, 'unchecked');
    assert.deepEqual(detail.production!.counts, { delivered: 4, rejected: 0, quarantined: 0, incomplete: 0, unknown: 2 });
  });

  it('binds the product line the pack declares when the run names none', async () => {
    const detail = await hub.service.startRunDetailed(hub.alice, { pack: 'case-location', inputs: { documents: [external('24001')] } }, call());
    assert.equal(detail.answer.call_result, 'ok', JSON.stringify(detail.answer.errors));
    const run = detail.answer.run!;
    assert.deepEqual([run.product, run.root], ['famx', ROOT]);
    const item = located(detail.production!.result, '24001').item.requirements[0];
    const answer = item.claims[0].statement.data as unknown as LocateAnswer;
    assert.deepEqual([answer.product_line, answer.product_name, answer.version, item.claims[0].statement.verdict], ['famx', 'FAMY', '10.6.1', 'support']);
  });

  it('binds the kind the declared id ranges give and reports it apart from the tree facts', async () => {
    const parameters = { id_ranges: { story: { min: 10000, max: 49999 }, bug: { min: 50000 } } };
    const detail = await hub.service.startRunDetailed(hub.alice, { pack: 'case-location', inputs: { documents: [external('24005'), external('24002')] }, parameters }, call());
    assert.equal(detail.answer.call_result, 'ok', JSON.stringify(detail.answer.errors));
    const run = detail.answer.run!;
    assert.deepEqual(
      run.sources.filter((s) => s.role === 'expected').map((s) => s.external),
      ['plm:story:33001@1', 'plm:bug:90220@1'],
    );
    const result = detail.production!.result;
    const ranged = answerOf(result, '24005');
    assert.deepEqual([ranged.unclassified, ranged.ranged, ranged.declared], [['33001'], { requirements: ['33001'], defects: [] }, []]);
    const claim = located(result, '24005').item.requirements[0].claims[0];
    assert.deepEqual([claim.statement.verdict, claim.qualifier.nature], ['support', 'fact']);
    assert.match(claim.statement.text, /未分类编号 33001（声明的范围：需求）/);
    assert.deepEqual(answerOf(result, '24002').ranged, { requirements: [], defects: [] });
  });

  it('locates every case of a document with granularity case', async () => {
    const detail = await hub.service.startRunDetailed(hub.alice, { pack: 'case-location', product: 'FAMY', inputs: { documents: [external('24001')] }, parameters: { granularity: 'case' } }, call());
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
    assert.deepEqual([answer.version, answer.module, answer.ancestor_path.slice(-2)], ['10.6.1', 'SSL', ['story:20931', '基本功能']]);
    assert.deepEqual(detail.production!.counts, { delivered: 2, rejected: 0, quarantined: 0, incomplete: 0, unknown: 0 });
  });

  it('a written build name of another line is an advisory violation naming that line, beside the candidates of the located one', async () => {
    const detail = await hub.service.startRunDetailed(hub.alice, { pack: 'case-location', product: 'FAMY', inputs: { documents: [external('24006')] } }, call());
    assert.equal(detail.answer.call_result, 'ok', JSON.stringify(detail.answer.errors));
    const result = detail.production!.result;
    const item = located(result, '24006').item;
    const candidates = item.requirements.find((r) => r.requirement === 'build_candidates')!;
    // The candidates of the located line, then the cross-check of the written name: one support and one violation.
    assert.deepEqual(
      candidates.claims.map((c) => [c.statement.verdict, c.statement.code ?? null]),
      [
        ['support', null],
        ['refute', 'case-location.build_other_line'],
      ],
    );
    const data = candidates.claims[1].statement.data as { kind: string; name: string; line: string };
    assert.deepEqual([data.kind, data.name, data.line], ['written_build', 'Rel_FAMX_10_7_4_101', '10.7.4']);
    assert.match(candidates.claims[1].statement.text, /属于版本线 10\.7\.4/);
    // The violation is advisory: the item is delivered, and the build_candidates requirement is unsatisfied.
    assert.deepEqual(candidates.layers, [{ layer: 'static', terminal: 'violation', code: 'case-location.build_other_line', tier: 'advisory', attribution: 'author_input' }]);
    assert.equal(candidates.status, 'unsatisfied');
    assert.deepEqual(detail.production!.counts, { delivered: 1, rejected: 0, quarantined: 0, incomplete: 0, unknown: 0 });
  });

  it('keeps the pack from users it is not assigned to, and takes model commentary only as judgments', async () => {
    const refused = await hub.service.startRun(hub.bob, { pack: 'case-location', inputs: ALL }, call());
    assert.deepEqual(
      refused.errors.map((e) => e.code),
      ['SOURCE_UNAVAILABLE'],
    );
    const detail = await hub.service.startRunDetailed(hub.alice, { pack: 'case-location', product: 'FAMY', inputs: { documents: [external('24001')] } }, call());
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
    assert.deepEqual(summary.products, ['FAMX', 'FAMY']);
    assert.deepEqual([...(await createPacksPort(hub.registry).readableProducts(hub.alice))], ['famx']);
    const other = await hub.service.startRun(hub.alice, { pack: 'case-location', product: 'Acme', inputs: { documents: [external('24001')] } }, call());
    assert.deepEqual(
      other.errors.map((e) => [e.code, e.path]),
      [['REFERENCE_UNRESOLVED', '/product']],
    );
    // Without a product the run still binds the pack's own line.
    const own = await hub.service.startRun(hub.alice, { pack: 'case-location', inputs: { documents: [external('24001')] } }, call());
    assert.equal(own.run?.product, 'famx');
  });
});

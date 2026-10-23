// A production run of case-compile end to end: the staged pack and the real run engine, a fake external serving the
// synthetic case document and the two named documents, and the command catalog of the locked build. The model's good
// submission is accepted with every check passing and the two markers on every conclusion; a forbidden (object,
// method) pair and a hand-edited plan are refuted with their codes.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { StartRunOutput, SubmitResultOutput } from '../../../contracts/src/tools.ts';
import { ValidationResult } from '../../../contracts/src/validation.ts';
import { osIsolationAvailable } from '../../../hub/rules/api.ts';
import { createDefaultRegistry, parserKey, recognize } from '../../../hub/refs/api.ts';
import { startPostgres, type TemporaryPostgres } from '../../../hub/testing/postgres.ts';
import { CONTRACT_DOC, MANIFEST_DOC } from './functions/test-support.ts';
import { call, openHub, sha, type Hub } from './testing/hub.ts';

const skip = (await osIsolationAvailable()) ? false : 'no OS network isolation on this machine (sandbox-exec)';
let postgres: TemporaryPostgres;
let hub: Hub;

/** The raw KityMinder export of the synthetic reviewed document (two cases with one step and one expected leaf each). */
const MINDMAP_JSON = JSON.stringify({
  root: {
    data: { id: 'doc-1', text: '文档 doc-1' },
    children: [
      {
        data: { id: 'g-1', text: '功能', priority: 1 },
        children: [
          {
            data: { id: 'c-1', text: '健康检查间隔配置测试', priority: 2, resource: ['功能'] },
            children: [{ data: { id: 'c-1-s1', text: '配置健康检查间隔 widget health interval 60' }, children: [{ data: { id: 'c-1-e1', text: '健康检查间隔设置成功' }, children: [] }] }],
          },
          {
            data: { id: 'c-2', text: '会话保持基本功能测试', priority: 2 },
            children: [{ data: { id: 'c-2-s1', text: '开启会话保持 widget session persistence cookie' }, children: [{ data: { id: 'c-2-e1', text: '会话保持生效' }, children: [] }] }],
          },
        ],
      },
    ],
  },
  template: 'default',
  theme: 'fresh-blue',
  version: '1.4.43',
});

const DOC_SHA = sha(MINDMAP_JSON);

/** The fragment reference of a case leaf (its expected result) inside the bound mind map, for the quotes. */
function leafReference(text: string): string {
  const parsed = recognize(createDefaultRegistry(), new TextEncoder().encode(MINDMAP_JSON), 'application/json');
  assert.ok(parsed !== null && parserKey(parsed.parser) === 'kityminder@1');
  const model = parsed.document.model as { nodes: Array<{ text: string; selector: string }> };
  const node = model.nodes.find((candidate) => candidate.text === text);
  assert.ok(node, `leaf ${text} not in the parsed model`);
  return `src:${DOC_SHA}/kityminder@1/${node.selector}`;
}

interface PlanData {
  bucket: string;
  blocks: string[];
  steps: Array<{ object: string; method: string; params: Record<string, unknown> }>;
  expects: Array<{ text: string; quote: { reference: string; text: string } }>;
}

function planOf(steps: PlanData['steps'], expects: PlanData['expects']): PlanData {
  return { bucket: 'bed-a', blocks: ['setup'], steps, expects };
}

function submission(run: string, plans: Map<string, PlanData>) {
  return {
    run,
    model: 'synthetic-model',
    items: [...plans.entries()].map(([item, data]) => ({
      item,
      handling: 'handled' as const,
      slots: {
        plan: [
          {
            text: `${item} 的执行计划（${data.steps.length} 步，${data.expects.length} 个期望结果）`,
            quotes: data.expects.map((expect) => expect.quote),
            data,
          },
        ],
      },
    })),
  };
}

const start = () => ({
  pack: 'case-compile',
  product: 'apv',
  build: 'Rel_APV_10_6_1_57',
  inputs: {
    subject: { external: 'agile:mindmap:doc-1' },
    contract: { external: 'doc:doc:compile-contract' },
    inventory: { external: 'doc:doc:bed-topology' },
  },
});

before(async () => {
  postgres = await startPostgres();
  if (skip) return;
  hub = await openHub(postgres);
  hub.external.put('agile:mindmap:doc-1', { bytes: new TextEncoder().encode(MINDMAP_JSON), mediaType: 'application/json' });
  hub.external.put('doc:doc:compile-contract', { bytes: new TextEncoder().encode(JSON.stringify(CONTRACT_DOC)), mediaType: 'application/json' });
  hub.external.put('doc:doc:bed-topology', { bytes: new TextEncoder().encode(JSON.stringify(MANIFEST_DOC)), mediaType: 'application/json' });
});
after(async () => {
  await hub?.close();
  await postgres?.stop();
});

function goodPlans(): Map<string, PlanData> {
  const plans = new Map<string, PlanData>();
  plans.set('doc-1:c-1', planOf([
    { object: 'dut', method: 'listen', params: { address: '192.0.2.10', port: 8080 } },
    { object: 'dut', method: 'cli', params: { line: 'widget health interval 60' } },
    { object: 'client', method: 'request', params: { target: '192.0.2.90', count: 3 } },
    { object: 'server', method: 'respond', params: { backend: '192.0.2.90', status: 200 } },
  ], [{ text: '健康检查间隔设置成功', quote: { reference: leafReference('健康检查间隔设置成功'), text: '健康检查间隔设置成功' } }]));
  plans.set('doc-1:c-2', planOf([
    { object: 'dut', method: 'cli', params: { line: 'widget session persistence cookie' } },
  ], [{ text: '会话保持生效', quote: { reference: leafReference('会话保持生效'), text: '会话保持生效' } }]));
  return plans;
}

describe('a production run of case-compile', { skip }, () => {
  it('starts with one item per case and accepts the good submission, every conclusion marked', async () => {
    const detail = await hub.service.startRunDetailed(hub.alice, start(), call());
    assert.equal(detail.answer.call_result, 'ok', JSON.stringify(detail.answer.errors));
    assert.ok(StartRunOutput.safeParse({ ...detail.answer, trace: '4bf92f3577b34da6a3ce929d0e0e4736' }).success);
    const run = detail.answer.run!;
    assert.deepEqual(
      run.items.map((item: { id: string }) => item.id),
      ['doc-1:c-1', 'doc-1:c-2'],
    );
    assert.deepEqual(
      run.requirements.map((r: { key: string; accepted_producer: string }) => [r.key, r.accepted_producer]),
      [
        ['plan', 'judgment'],
        ['contract_methods', 'fact'],
        ['bed_addresses', 'fact'],
        ['commands_known', 'fact'],
        ['expected_grounded', 'fact'],
        ['plan_deterministic', 'fact'],
      ],
    );

    const answer = await hub.service.submitResult(hub.alice, submission(run.run, goodPlans()), call());
    assert.ok(SubmitResultOutput.safeParse({ ...answer, trace: '4bf92f3577b34da6a3ce929d0e0e4736' }).success, JSON.stringify(answer));
    assert.equal(answer.call_result, 'ok', JSON.stringify(answer.errors));
    const result = ValidationResult.parse(answer.result);
    assert.deepEqual([result.acceptance, result.errors], ['accepted', []]);
    const stored = (await hub.service.getRun(hub.alice, run.run))!;
    const claims = [...Object.values(result.partitions).flatMap((items) => items.flatMap((item) => item.requirements.flatMap((requirement) => requirement.claims)))];
    // 包函数的结论每条都带两句标记；catalog@1 和 quote@1 解释器的结论是核心生成的，带不了包的文字（见 README 决定 4）。
    const packClaims = claims.filter((claim) => claim.qualifier.nature === 'fact' && typeof claim.warrant.id === 'string' && claim.warrant.id.startsWith('case-compile.'));
    assert.ok(packClaims.length > 0);
    for (const claim of packClaims) {
      assert.equal(claim.statement.verdict, 'support', claim.statement.text);
      assert.match(claim.statement.text, /按合成合约核对/, claim.statement.text);
      assert.match(claim.statement.text, /不证明在真实设备上跑得通/, claim.statement.text);
    }
    const interpreterClaims = claims.filter((claim) => claim.qualifier.nature === 'fact' && (claim.warrant.id === 'catalog@1' || claim.warrant.id === 'quote@1'));
    assert.ok(interpreterClaims.length > 0, '解释器结论在（命令目录和逐字引文）');
    for (const claim of interpreterClaims) assert.equal(claim.statement.verdict, 'support', claim.statement.text);
    // 解释器的 pointer 照实钉住（README「Pointers」一节按此写）：catalog@1 是 /phrases/<k>，quote@1 是 /quotes/<k>/text。
    for (const claim of interpreterClaims.filter((claim) => claim.warrant.id === 'catalog@1')) assert.equal(claim.pointer, '/phrases/0');
    for (const claim of interpreterClaims.filter((claim) => claim.warrant.id === 'quote@1')) assert.equal(claim.pointer, '/quotes/0/text');
    assert.ok(
      claims.some((claim) => claim.qualifier.nature === 'judgment'),
      'plan 要求是模型自己的判断（执行计划），五个事实要求项逐项核对它',
    );
    const deterministic = packClaims.find((claim) => claim.statement.text.includes('确定性生成并回读一致'));
    assert.ok(deterministic, '确定性结论在');
    const produced = deterministic.statement.data as { plan: string; sha256: string };
    assert.equal(produced.sha256, createHash('sha256').update(produced.plan, 'utf8').digest('hex'), 'data 里的 sha256 就是计划文本的摘要');
    assert.ok(deterministic.statement.text.includes(`sha256 ${produced.sha256}`), '结论文字写出 sha256');
    const plan = JSON.parse(produced.plan) as { schema: string; case: string; steps: unknown[] };
    assert.equal(plan.schema, 'exec-plan@1');
    assert.equal(plan.case, 'doc-1:c-1');
    assert.equal(plan.steps.length, 4);
    assert.equal(stored.latest?.result.acceptance, 'accepted');
  });

  it('refutes a forbidden (object, method) pair; the plan is still generated from the rest of the slots', async () => {
    const detail = await hub.service.startRunDetailed(hub.alice, start(), call());
    assert.equal(detail.answer.call_result, 'ok', JSON.stringify(detail.answer.errors));
    const run = detail.answer.run!;
    const plans = goodPlans();
    const bad = plans.get('doc-1:c-1')!;
    bad.steps = [{ object: 'dut', method: 'reboot', params: {} }, ...bad.steps.slice(1)];
    const answer = await hub.service.submitResult(hub.alice, submission(run.run, plans), call());
    assert.equal(answer.call_result, 'ok', JSON.stringify(answer.errors));
    const result = ValidationResult.parse(answer.result);
    const claims = [...Object.values(result.partitions).flatMap((items) => items.flatMap((item) => item.requirements.flatMap((requirement) => requirement.claims)))];
    const forbidden = claims.find((claim) => claim.statement.verdict === 'refute' && claim.statement.text.includes('禁用的组合'));
    assert.ok(forbidden, JSON.stringify(claims.map((claim) => claim.statement.text)));
    assert.match(forbidden.statement.text, /按合成合约核对/);
    assert.match(forbidden.statement.text, /不证明在真实设备上跑得通/);
    assert.equal(forbidden.qualifier.nature, 'fact');
    assert.equal(forbidden.pointer, '/data/steps/0', '包函数的驳回带 /data/ 形状的 pointer');
    assert.equal(result.acceptance, 'accepted', '校验照常完成并存下；不满足写在要求项状态上');
    const requirementOf = (key: string) => {
      for (const items of Object.values(result.partitions)) {
        for (const item of items) {
          if (item.item !== 'doc-1:c-1') continue;
          const requirement = item.requirements.find((candidate: { requirement: string }) => candidate.requirement === key);
          if (requirement !== undefined) return requirement as { status: string; unsatisfied_reason?: string };
        }
      }
      throw new Error(`requirement ${key} not found`);
    };
    assert.deepEqual([requirementOf('contract_methods').status, requirementOf('contract_methods').unsatisfied_reason], ['unsatisfied', 'outcome_mismatch']);
    assert.equal(requirementOf('plan_deterministic').status, 'satisfied', '其余槽位照学生成执行计划并回读一致');
  });

  it('refuses the run to a user the pack is not assigned to', async () => {
    const detail = await hub.service.startRunDetailed(hub.bob, start(), call());
    assert.equal(detail.answer.call_result, 'error');
    assert.deepEqual(detail.answer.errors.map((e: { code: string }) => e.code), ['SOURCE_UNAVAILABLE']);
  });
});

// The remaining checks: command lines for the catalog (the contract's command parameters), an explicit source on
// every expected result, and determinism — the same slots generate byte-identical plan text twice, and a submitted
// plan that differs from what the slots generate is refuted.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkDeterministic, checkExpectedSources } from './checks.ts';
import { canonicalJson, generatePlan, generatePlanJson, readSlots } from './plan.ts';
import { commandSubject, quoteSubject } from './subject.ts';
import { contractOf, goodData, QUOTE, subjectOf } from './test-support.ts';

const MARK = '（按合成合约核对；不证明在真实设备上跑得通）';

describe('命令行和引文的主体', () => {
  it('commandSubject 收集合约标记为命令行的参数值', () => {
    const subject = commandSubject({ slots: { plan: [{ data: goodData() }] }, item: 'doc-1:c-1', context: { groups: [group()] } }) as { phrases: string[] };
    assert.deepEqual(subject.phrases, ['widget health interval 60']);
  });

  it('quoteSubject 收集每个期望结果的引文', () => {
    const subject = quoteSubject({ slots: { plan: [{ data: goodData() }] }, item: 'doc-1:c-1', context: { groups: [group()] } }) as { quotes: Array<{ reference: string; text: string }> };
    assert.deepEqual(subject.quotes, [QUOTE]);
  });
});

function group(): Record<string, unknown> {
  return {
    kind: 'case-compile',
    contract: {
      schema: 'compile-contract@1',
      synthetic: true,
      objects: [{ name: 'dut', methods: [{ name: 'cli', params: [{ name: 'line', type: 'string', command: true }] }] }],
      forbidden: [],
    },
    manifest: { schema: 'test-bed-manifest@1', beds: [{ name: 'bed-a', devices: [], services: [], reserved: [] }] },
    leases: { now: '2026-10-23T02:00:00.000Z', entries: [] },
  };
}

describe('期望结果的来源', () => {
  it('正例：每个期望结果都带逐字来源', () => {
    const [outcome] = checkExpectedSources(subjectOf(goodData()));
    assert.equal(outcome.verdict, 'support');
    assert.match(outcome.statement, /1 个期望结果都带有逐字来源/);
    assert.ok(outcome.statement.endsWith(MARK));
  });

  it('反例：期望结果没有来源', () => {
    const data = goodData();
    data.expects = [
      { text: '健康检查间隔设置成功', quote: QUOTE },
      { text: '会话保持生效', quote: { reference: '', text: '' } },
    ];
    data.plan_json = '';
    const [outcome] = checkExpectedSources(subjectOf(data));
    assert.deepEqual([outcome.verdict, outcome.code], ['refute', 'case-compile.expect_without_source']);
    assert.match(outcome.statement, /第 2 个期望结果「会话保持生效」没有逐字来源/);
    assert.ok(outcome.statement.endsWith(MARK));
  });

  it('反例：一个期望结果都没有', () => {
    const data = goodData();
    data.expects = [];
    data.plan_json = '';
    const [outcome] = checkExpectedSources(subjectOf(data));
    assert.deepEqual([outcome.verdict, outcome.code], ['refute', 'case-compile.expect_without_source']);
  });
});

describe('确定性', () => {
  it('同一份槽位两次生成的执行计划逐字节相同', () => {
    const contract = contractOf();
    const data = goodData(contract);
    const read = readSlots(data);
    assert.equal(read.ok, true);
    if (!read.ok) return;
    const first = generatePlanJson('doc-1:c-1', read.slots, contract);
    const second = generatePlanJson('doc-1:c-1', read.slots, contract);
    assert.ok(first !== null && first === second, '两次生成必须逐字节相同');
    const plan = generatePlan('doc-1:c-1', read.slots, contract);
    assert.equal(canonicalJson(plan), first);
    assert.match(first, /"schema":"exec-plan@1"/);
    assert.ok(first.indexOf('"params":{"address":"192.0.2.10","port":8080}') > 0, '参数按合约声明的顺序');
    assert.ok(first.indexOf('"params":{"backend":"192.0.2.90","status":200}') > 0);
    assert.ok(first.indexOf('"count":3') > 0);
    assert.equal(data.plan_json, first, '夹具的 plan_json 就是生成器出的文本');
  });

  it('缺省参数由生成器按合约填上：模型不写，生成结果里有', () => {
    const contract = contractOf();
    const data = goodData(contract);
    const request = data.steps.find((step) => step.method === 'request')!;
    delete request.params.count;
    const read = readSlots(data);
    assert.equal(read.ok, true);
    if (!read.ok) return;
    const json = generatePlanJson('doc-1:c-1', read.slots, contract) as string;
    assert.ok(json.indexOf('"count":"1"') > 0, '缺省值按文档的字符串形式填上');
  });

  it('提交的 plan_json 与槽位生成的一致：支持', () => {
    const [outcome] = checkDeterministic(subjectOf(goodData()));
    assert.equal(outcome.verdict, 'support');
    assert.match(outcome.statement, /确定性重读一致/);
    assert.ok(outcome.statement.endsWith(MARK));
  });

  it('提交的 plan_json 被手写改动：不通过，并给出生成的规范文本', () => {
    const data = goodData();
    data.plan_json = data.plan_json.replace('"port":8080', '"port":8081');
    const [outcome] = checkDeterministic(subjectOf(data));
    assert.deepEqual([outcome.verdict, outcome.code], ['refute', 'case-compile.plan_mismatch']);
    assert.ok(outcome.statement.endsWith(MARK));
    const generated = (outcome.data as { generated: string }).generated;
    assert.ok(generated.indexOf('"port":8080') > 0, '数据里带生成的规范文本，供对照');
  });

  it('键序不同但内容相同的 plan_json 也是不一致（规范形式是唯一的）', () => {
    const data = goodData();
    const plan = JSON.parse(data.plan_json) as Record<string, unknown>;
    const reordered = JSON.stringify({ steps: plan.steps, schema: plan.schema, expects: plan.expects, case: plan.case, blocks: plan.blocks, bed: plan.bed });
    data.plan_json = reordered;
    const [outcome] = checkDeterministic(subjectOf(data));
    assert.deepEqual([outcome.verdict, outcome.code], ['refute', 'case-compile.plan_mismatch']);
  });
});

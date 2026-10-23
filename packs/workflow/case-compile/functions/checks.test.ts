// The remaining checks: command lines for the catalog (the contract's command parameters), an explicit source on
// every expected result, and determinism — the same slots generate byte-identical plan text twice, and a submitted
// plan that differs from what the slots generate is refuted.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkDeterministic, checkExpectedSources } from './checks.ts';
import { canonicalJson, diffPlan, generatePlan, generatePlanJson, parsePlan, readSlots, sha256Hex } from './plan.ts';
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
  it('正例：每个期望结果都带逐字来源，且文字出自引文', () => {
    const [outcome] = checkExpectedSources(subjectOf(goodData()));
    assert.equal(outcome.verdict, 'support');
    assert.match(outcome.statement, /1 个期望结果都带有逐字来源且文字出自引文/);
    assert.ok(outcome.statement.endsWith(MARK));
  });

  it('正例：期望文字比引文短时算片段；空白折叠后相同也算', () => {
    const data = goodData();
    data.expects = [
      { text: '设置成功', quote: { reference: QUOTE.reference, text: '健康检查间隔设置成功' } },
      { text: '健康检查间隔 设置成功', quote: { reference: QUOTE.reference, text: '健康检查间隔\n设置成功' } },
    ];
    const [outcome] = checkExpectedSources(subjectOf(data));
    assert.equal(outcome.verdict, 'support', outcome.statement);
  });

  it('反例：期望文字不是它的引文的片段（引文是真的，文字是模型写的）', () => {
    const data = goodData();
    data.expects = [{ text: '健康检查立即生效', quote: QUOTE }];
    const [outcome] = checkExpectedSources(subjectOf(data));
    assert.deepEqual([outcome.verdict, outcome.code], ['refute', 'case-compile.expect_not_in_quote']);
    assert.match(outcome.statement, /第 1 个期望结果「健康检查立即生效」不是它的引文/);
    assert.equal(outcome.pointer, '/data/expects/0');
    assert.ok(outcome.statement.endsWith(MARK));
  });

  it('反例：期望结果没有来源', () => {
    const data = goodData();
    data.expects = [
      { text: '健康检查间隔设置成功', quote: QUOTE },
      { text: '会话保持生效', quote: { reference: '', text: '' } },
    ];
    const [outcome] = checkExpectedSources(subjectOf(data));
    assert.deepEqual([outcome.verdict, outcome.code], ['refute', 'case-compile.expect_without_source']);
    assert.match(outcome.statement, /第 2 个期望结果「会话保持生效」没有逐字来源/);
    assert.equal(outcome.pointer, '/data/expects/1');
    assert.ok(outcome.statement.endsWith(MARK));
  });

  it('反例：一个期望结果都没有', () => {
    const data = goodData();
    data.expects = [];
    const [outcome] = checkExpectedSources(subjectOf(data));
    assert.deepEqual([outcome.verdict, outcome.code], ['refute', 'case-compile.expect_without_source']);
    assert.equal(outcome.pointer, '/data/expects');
  });
});

describe('确定性', () => {
  it('同一份槽位两次生成的执行计划逐字节相同', () => {
    const contract = contractOf();
    const data = goodData();
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
  });

  it('缺省参数由生成器按合约填上：模型不写，生成结果里有', () => {
    const contract = contractOf();
    const data = goodData();
    const request = data.steps.find((step) => step.method === 'request')!;
    delete request.params.count;
    const read = readSlots(data);
    assert.equal(read.ok, true);
    if (!read.ok) return;
    const json = generatePlanJson('doc-1:c-1', read.slots, contract) as string;
    assert.ok(json.indexOf('"count":"1"') > 0, '缺省值按文档的字符串形式填上');
  });

  it('另一个读取器把生成的文本解析回来，和槽位逐项一致', () => {
    const contract = contractOf();
    const data = goodData();
    const read = readSlots(data);
    assert.equal(read.ok, true);
    if (!read.ok) return;
    const text = generatePlanJson('doc-1:c-1', read.slots, contract) as string;
    const reread = parsePlan(text);
    assert.ok(reread !== null, '生成的文本必须能被回读器解析');
    assert.deepEqual(diffPlan(read.slots, reread, contract), []);
    assert.equal(parsePlan('{"schema":"exec-plan@1","case":"x"}'), null, '缺字段的不是 exec-plan@1');
    assert.equal(parsePlan('不是 JSON'), null);
  });

  it('回读不一致能被逐项比对指出来（台架、步骤、参数、期望来源）', () => {
    const contract = contractOf();
    const data = goodData();
    const read = readSlots(data);
    assert.equal(read.ok, true);
    if (!read.ok) return;
    const text = generatePlanJson('doc-1:c-1', read.slots, contract) as string;
    const reread = parsePlan(text)!;
    const drifted = { ...reread, bed: 'bed-b', steps: reread.steps.map((step, i) => (i === 1 ? { ...step, params: { line: 'widget health interval 90' } } : step)) };
    const diffs = diffPlan(read.slots, drifted, contract);
    assert.ok(diffs.some((diff) => diff.includes('bed-b')), JSON.stringify(diffs));
    assert.ok(diffs.some((diff) => diff.includes('第 2 步的参数')), JSON.stringify(diffs));
  });

  it('支持：由槽位生成并回读一致，结论写出 sha256，data 里带计划文本和摘要', () => {
    const contract = contractOf();
    const data = goodData();
    const read = readSlots(data);
    assert.equal(read.ok, true);
    if (!read.ok) return;
    const generated = generatePlanJson('doc-1:c-1', read.slots, contract) as string;
    const digest = sha256Hex(generated);
    const [outcome] = checkDeterministic(subjectOf(data));
    assert.equal(outcome.verdict, 'support');
    assert.ok(outcome.statement.includes(`sha256 ${digest}`), outcome.statement);
    assert.ok(outcome.statement.endsWith(MARK));
    assert.deepEqual(outcome.data, { plan: generated, sha256: digest });
  });

  it('生成不出来或回读不一致记未知，原因是出件失败，不写成模型的错', () => {
    const data = goodData();
    data.steps = [{ object: 'dut', method: 'reset', params: {} }];
    const [outcome] = checkDeterministic(subjectOf(data));
    assert.deepEqual([outcome.verdict, outcome.reason], ['unknown', 'output_failed']);
    assert.ok(!('code' in outcome) || outcome.code === undefined, '出件失败不是模型的违规');
    assert.equal(outcome.pointer, '/data');
    assert.match(outcome.statement, /出件失败/);
    assert.ok(outcome.statement.endsWith(MARK));
  });

  it('槽位里写了 plan_json 是不通过：执行计划由 Hub 生成，模型只填槽', () => {
    const data = { ...goodData(), plan_json: '{"schema":"exec-plan@1"}' };
    const [outcome] = checkDeterministic(subjectOf(data));
    assert.deepEqual([outcome.verdict, outcome.code], ['refute', 'case-compile.plan_in_slots']);
    assert.equal(outcome.pointer, '/data/plan_json');
    assert.ok(outcome.statement.endsWith(MARK));
  });
});

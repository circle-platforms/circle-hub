// The compile contract: parsing positives and negatives, and the contract_shape check — a method not in the contract,
// a forbidden pair, a wrong parameter count, a wrong parameter type or range. Every conclusion carries the markers.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkContractShape } from './checks.ts';
import { isForbidden, lookupMethod, parseContract } from './contract.ts';
import { CONTRACT_DOC, contractOf, goodData, subjectOf } from './test-support.ts';

const MARK = '（按合成合约核对；不证明在真实设备上跑得通）';

describe('编译合约的解析', () => {
  it('合成合约解析通过：对象、方法、参数、禁用组合', () => {
    const contract = contractOf();
    assert.equal(contract.synthetic, true);
    assert.equal(contract.objects.length, 3);
    assert.equal(lookupMethod(contract, 'dut', 'cli')?.params[0].command, true);
    assert.equal(isForbidden(contract, 'dut', 'reboot'), true);
    assert.equal(isForbidden(contract, 'dut', 'save'), false);
  });

  it('合约问题的正反例：schema 不对、对象名重复、参数类型未知、enum 没有取值、address 角色未知', () => {
    const read = parseContract({
      schema: 'something-else',
      objects: [
        { name: 'dut', methods: [{ name: 'a', params: [{ name: 'x', type: 'wat' }] }] },
        { name: 'dut', methods: [] },
        { name: 'srv', methods: [{ name: 'b', params: [{ name: 'e', type: 'enum' }, { name: 'v', type: 'ipv4', address: 'sideways' }] }] },
      ],
      forbidden: [{ object: 'dut' }],
    });
    assert.equal(read.ok, false);
    if (read.ok) return;
    const text = read.problems.map((p) => `${p.pointer} ${p.message}`).join('\n');
    assert.match(text, /schema 不是 compile-contract@1/);
    assert.match(text, /对象 dut 重复/);
    assert.match(text, /类型 wat 不在/);
    assert.match(text, /enum 却没有 values/);
    assert.match(text, /address 角色 sideways 不在/);
    assert.match(text, /禁用组合不是 \{object, method\}/);
  });
});

describe('contract_shape 检查', () => {
  it('正例：全部步骤符合合约，结论是支持并带标记', () => {
    const [outcome] = checkContractShape(subjectOf(goodData()));
    assert.equal(outcome.verdict, 'support');
    assert.match(outcome.statement, /4 步调用符合合约/);
    assert.ok(outcome.statement.endsWith(MARK), outcome.statement);
  });

  it('反例：方法不在合约里', () => {
    const data = goodData();
    data.steps = [{ object: 'dut', method: 'reset', params: {} }, ...data.steps.slice(1)];
    const [outcome] = checkContractShape(subjectOf(data));
    assert.deepEqual([outcome.verdict, outcome.code], ['refute', 'case-compile.method_unknown']);
    assert.match(outcome.statement, /reset.*不在合约里/);
    assert.equal(outcome.pointer, '/data/steps/0');
    assert.ok(outcome.statement.endsWith(MARK));
  });

  it('反例：禁用的（对象，方法）组合', () => {
    const data = goodData();
    data.steps = [{ object: 'dut', method: 'reboot', params: {} }, ...data.steps.slice(1)];
    const [outcome] = checkContractShape(subjectOf(data));
    assert.deepEqual([outcome.verdict, outcome.code], ['refute', 'case-compile.method_forbidden']);
    assert.match(outcome.statement, /禁用的组合/);
  });

  it('反例：参数个数不对（缺必填、写未声明）', () => {
    const data = goodData();
    data.steps = [
      { object: 'dut', method: 'listen', params: { address: '192.0.2.10' } },
      { object: 'client', method: 'request', params: { target: '192.0.2.90', count: 3, retries: 2 } },
    ];
    const outcomes = checkContractShape(subjectOf(data));
    const codes = outcomes.map((o) => o.code).sort();
    assert.deepEqual(codes, ['case-compile.param_arity', 'case-compile.param_arity']);
    assert.match(outcomes.map((o) => o.statement).join('\n'), /缺必填参数 port/);
    assert.match(outcomes.map((o) => o.statement).join('\n'), /没有声明的参数 retries/);
  });

  it('反例：参数类型不对', () => {
    const data = goodData();
    data.steps = [{ object: 'server', method: 'respond', params: { backend: '192.0.2.90', status: 'ok' } }];
    const [outcome] = checkContractShape(subjectOf(data));
    assert.deepEqual([outcome.verdict, outcome.code], ['refute', 'case-compile.param_type']);
    assert.match(outcome.statement, /status 应为整数/);
  });

  it('反例：参数取值越界', () => {
    const data = goodData();
    data.steps = [{ object: 'client', method: 'request', params: { target: '192.0.2.90', count: 5000 } }];
    const [outcome] = checkContractShape(subjectOf(data));
    assert.deepEqual([outcome.verdict, outcome.code], ['refute', 'case-compile.param_range']);
    assert.match(outcome.statement, /不大于 1000/);
  });

  it('反例：槽位形状和未知块', () => {
    const [shape] = checkContractShape(subjectOf({ bucket: 'bed-a', blocks: 'many', steps: [], expects: [] }));
    assert.equal(shape.code, 'case-compile.slots_invalid');
    const [block] = checkContractShape(subjectOf({ bucket: 'bed-a', blocks: ['setup', 'warmup'], steps: [{ object: 'dut', method: 'save', params: {} }], expects: [] }));
    assert.equal(block.code, 'case-compile.block_unknown');
  });

  it('合约不是合成的时，结论只带“不证明在真实设备上跑得通”', () => {
    const doc = { ...(CONTRACT_DOC as Record<string, unknown>), synthetic: false };
    const contract = contractOf(doc);
    const [outcome] = checkContractShape(subjectOf(goodData(), { contractDoc: doc }));
    assert.equal(outcome.verdict, 'support');
    assert.ok(outcome.statement.endsWith('（不证明在真实设备上跑得通）'), outcome.statement);
    assert.ok(!outcome.statement.includes('按合成合约核对'));
  });
});

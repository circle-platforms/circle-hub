import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fidelityBrief } from './fidelity.ts';
import { estimateTokens } from './generated/skills/plumb/plumb-client/index.ts';
import {
  FIDELITY_MAX_EST_TOKENS,
  formatBlockForFidelity,
  partitionFidelityBlocks,
  renderFidelityStepState,
} from './fidelity-render.ts';

const RECORD = {
  schema: 'recompose-record@1',
  contract: { intent: { text: '验证接口地址与对端互通配置' } },
  atoms: [
    { id: '1', kind: 'action', text: '进入接口 eth0 视图' },
    { id: '2', kind: 'action', text: '配置接口地址 192.0.2.30/24 并启用' },
    { id: '3', kind: 'action', text: '查看接口状态并确认可达' },
    { id: 'e1', kind: 'expectation', text: '接口 eth0 显示 192.0.2.30 UP' },
  ],
  ledgers: { original: [], adapted: [], rebindings: [] },
};

test('partitionFidelityBlocks preserves all preconditions and cleanup while hiding worker prose', () => {
  const plan = {
    bucket: 'bed-1',
    blocks: [],
    steps: [
      {
        object: 'dut0',
        method: 'cmd_config',
        args: ['widget peer 192.0.2.2'],
        keywords: {},
        description: '内部描述不得泄露给模型',
        precondition_source: { reference: 'knowledge:manual#widget-peer', text: 'Configure peer IP before enabling sync' },
      },
      {
        object: 'dut0',
        method: 'cmd_config',
        args: ['interface eth0', 'ip address 192.0.2.30/24', 'no shutdown'],
        keywords: {},
        description: '作者步骤描述',
        author_step_refs: ['1', '2'],
      },
      {
        object: 'dut0',
        method: 'cmd_show',
        args: ['show interface eth0'],
        keywords: {},
        author_step_refs: ['3'],
      },
      {
        object: 'dut0',
        method: 'cmd_config',
        args: ['no widget peer 192.0.2.2'],
        keywords: {},
        cleanup: true,
        precondition_source: { reference: 'knowledge:manual#widget-peer', text: 'Remove peer IP during cleanup' },
      },
    ],
    expects: [{ text: '192.0.2.30', quote: { reference: 'r', text: '192.0.2.30' }, after: 3 }],
    replacements: [],
  };
  const brief = fidelityBrief('doc:1', RECORD, plan)!;
  const part = partitionFidelityBlocks(brief);
  assert.equal(part.negativeCase, null);
  assert.equal(part.exemptedIndices.size,0);
  assert.deepEqual(part.candidateBlocks.map((b) => b.index), [1,2,3,4]);

  const rendered = renderFidelityStepState(brief, 1, part);
  assert.equal(rendered.overBudget, false);
  assert.ok(!rendered.state.includes('内部描述不得泄露给模型'));
  assert.ok(!rendered.state.includes('作者步骤描述'));
  assert.match(rendered.state, /\[当前作者步骤 2\]/);
  assert.match(rendered.state, /\[候选命令块\]/);
  assert.match(rendered.state, /block\[2\]/);
});

test('negative missing-precondition cases NEVER fold away preconditions or cleanup steps', () => {
  const negRecord = {
    schema: 'recompose-record@1',
    contract: { intent: { text: '验证前置未配置对端地址时下发配置报错' } },
    atoms: [
      { id: '1', kind: 'action', text: '在未配置 peer 前置的情况下执行 widget commit' },
      { id: 'e1', kind: 'expectation', text: 'peer is not configured' },
    ],
    ledgers: { original: [], adapted: [], rebindings: [] },
  };
  const negPlan = {
    bucket: 'bed-1',
    blocks: [],
    steps: [
      {
        object: 'dut0',
        method: 'cmd_config',
        args: ['widget peer 192.0.2.2'],
        keywords: {},
        precondition_source: { reference: 'knowledge:manual#widget-peer', text: 'Configure peer' },
      },
      {
        object: 'dut0',
        method: 'cmd_config',
        args: ['widget commit'],
        keywords: {},
      },
    ],
    expects: [{ text: 'peer is not configured', quote: { reference: 'r', text: 'peer is not configured' }, after: 2 }],
    replacements: [],
  };
  const brief = fidelityBrief('doc:neg', negRecord, negPlan)!;
  const part = partitionFidelityBlocks(brief);
  assert.equal(part.exemptedIndices.size, 0);
  assert.deepEqual(part.candidateBlocks.map((b) => b.index), [1, 2]);
});

test('renderFidelityStepState truncates oldest prior steps first, never slices mid-block, and flags overBudget > 2400', () => {
  const manyAtoms = [];
  for (let i = 1; i <= 35; i += 1) {
    manyAtoms.push({ id: String(i), kind: 'action', text: `第 ${i} 步配置策略规则并检查参数 ${'alpha '.repeat(55)}` });
  }
  const bigBrief = fidelityBrief('doc:big', {
    schema: 'recompose-record@1',
    contract: { intent: { text: '长流程用例意图' } },
    atoms: manyAtoms,
    ledgers: { original: [], adapted: [], rebindings: [] },
  }, {
    bucket: 'bed-1',
    blocks: [],
    steps: [{ object: 'dut1', method: 'cmd_show', args: ['show running-config'], keywords: {} }],
    expects: [],
    replacements: [],
  })!;

  const part = partitionFidelityBlocks(bigBrief);
  const res = renderFidelityStepState(bigBrief, 34, part);
  assert.equal(res.truncated, true);
  assert.equal(res.overBudget, false);
  assert.ok(res.estTokensAfter <= FIDELITY_MAX_EST_TOKENS);
  assert.match(res.state, /\[候选命令块\]\nblock\[1\]/);

  const hugeBrief = fidelityBrief('doc:huge', {
    schema: 'recompose-record@1',
    contract: { intent: { text: '短意图' } },
    atoms: [{ id: '1', kind: 'action', text: '执行超长命令' }],
    ledgers: { original: [], adapted: [], rebindings: [] },
  }, {
    bucket: 'bed-1',
    blocks: [],
    steps: [{ object: 'dut1', method: 'cmd_config', args: ['cmd ' + 'longtoken '.repeat(900)], keywords: {} }],
    expects: [],
    replacements: [],
  })!;
  const hugePart = partitionFidelityBlocks(hugeBrief);
  const hugeRes = renderFidelityStepState(hugeBrief, 0, hugePart);
  assert.equal(hugeRes.overBudget, true);
  assert.ok(hugeRes.estTokensAfter > FIDELITY_MAX_EST_TOKENS);
  assert.ok(hugeRes.state.includes(formatBlockForFidelity(hugeBrief.blocks[0]!)));
  assert.ok(estimateTokens(hugeRes.state) > FIDELITY_MAX_EST_TOKENS);
});

test('Plumb receives all exemption evidence and the authoritative rule without folding claims',()=>{
 const brief=fidelityBrief('doc:synthetic', {...RECORD,sources:{states:[{atom:'1',state:'missing_prerequisite',prerequisites:['manual-only-antecedent'],reason:'registered proof'}]}},{bucket:'bed-1',blocks:[],steps:[{object:'dut0',method:'cmd_config',args:['prepare'],keywords:{},precondition_source:{reference:'knowledge:manual',text:'exact manual antecedent'}}],expects:[],replacements:[]})!;
 const part=partitionFidelityBlocks(brief),rendered=renderFidelityStepState(brief,0,part);
 assert.deepEqual(part.candidateBlocks,brief.blocks);assert.match(rendered.state,/manual-only-antecedent/);assert.match(rendered.state,/exact manual antecedent/);assert.ok(rendered.state.includes(brief.rules[2]));
 assert.doesNotMatch(rendered.state,/已核验豁免说明/);
});

const LONG_NAME = ['a'.repeat(63), 'b'.repeat(63), 'c'.repeat(63), 'd'.repeat(61)].join('.');
const LONG_RECORD = {
  schema: 'recompose-record@1',
  contract: { intent: { text: '验证超长域名在服务上可配置并可解析' } },
  atoms: [
    { id: '1', kind: 'action', text: '配置超长域名' },
    { id: '2', kind: 'action', text: '启用签名功能' },
    { id: '3', kind: 'action', text: '客户端带验证查询' },
    { id: 'e1', kind: 'expectation', text: '查询返回签名' },
  ],
  ledgers: { original: [], adapted: [], rebindings: [] },
  sources: { states: [{ atom: '2', state: 'missing_prerequisite', prerequisites: ['feature on（手册原话：该功能默认是禁用的）', 'demo signer on 启用签名功能', 'demo host name 配置域名并绑定可解析记录'], reason: '功能默认禁用，签名功能须单独开启；被测域名须先配置为可解析的域名' }] },
};
function repeatedNameBrief(count: number, literalEvery = 3) {
  const steps = Array.from({ length: count }, (_, i) => ({
    object: 'dut1',
    method: 'cmd_config',
    args: [i % literalEvery === 0 ? `demo host name "${LONG_NAME}" 60` : `demo feature ${i} on`],
    keywords: {},
    author_step_refs: [String((i % 3) + 1)],
  }));
  return fidelityBrief('doc:long-name', LONG_RECORD, { bucket: 'bed-1', blocks: [], steps, expects: [], replacements: [] })!;
}
function withLiteralsRestored(state: string, literal: string): string {
  return state.replace(/\n\n\[长字面量对照\][^\n]*\n[^\n]*\n[^\n]*(?=\n\n\[候选命令块\])/u, '').replaceAll('«L1»', literal);
}

test('a repeated long literal is written once in a table and named in the blocks, and the state then fits', () => {
  const brief = repeatedNameBrief(48);
  const part = partitionFidelityBlocks(brief);
  const plain = renderFidelityStepState(brief, 2, part, 1_000_000);
  assert.equal(plain.overBudget, false);
  assert.ok(plain.estTokensAfter > FIDELITY_MAX_EST_TOKENS, 'the plain state is over the limit');

  const res = renderFidelityStepState(brief, 2, part);
  assert.equal(res.overBudget, false);
  assert.ok(res.estTokensAfter <= FIDELITY_MAX_EST_TOKENS);
  assert.equal(res.estTokensPlain, renderFidelityStepState(brief, 2, part, 0).estTokensPlain, 'the plain figure does not depend on the rescue');
  assert.ok(res.estTokensPlain > FIDELITY_MAX_EST_TOKENS);
  assert.equal(res.substitutions.length, 1);
  const [sub] = res.substitutions;
  assert.deepEqual({ name: sub!.name, length: sub!.length, labels: sub!.labels, occurrences: sub!.occurrences }, { name: '«L1»', length: 253, labels: [63, 63, 63, 61], occurrences: 16 });
  assert.match(sub!.sha256_12, /^[0-9a-f]{12}$/u);
  assert.equal(res.state.split(LONG_NAME).length - 1, 1, 'the literal stays in the state exactly once');
  assert.equal(res.state.split('«L1»').length - 1, 16 + 1, 'sixteen names in the blocks and one in the table');
  assert.match(res.state, /\[长字面量对照\]\n[^\n]+\n«L1» = a{63}\.b{63}\.c{63}\.d{61}（共 253 个字符；各段 63、63、63、61）\n\n\[候选命令块\]/u);
  assert.equal(withLiteralsRestored(res.state, LONG_NAME), plain.state, 'nothing but the long literal was rewritten');
  assert.deepEqual(renderFidelityStepState(brief, 2, part), res, 'the same input gives the same state');
});

test('a state that fits is left byte for byte as it was, repeated literal or not', () => {
  const brief = repeatedNameBrief(30);
  const part = partitionFidelityBlocks(brief);
  const res = renderFidelityStepState(brief, 2, part);
  assert.equal(res.overBudget, false);
  assert.ok(res.estTokensAfter <= FIDELITY_MAX_EST_TOKENS);
  assert.deepEqual(res.substitutions, []);
  assert.equal(res.estTokensPlain, res.estTokensAfter);
  assert.equal(res.state.split(LONG_NAME).length - 1, 10);
  assert.ok(!res.state.includes('[长字面量对照]'));
});

test('a state the long literal does not explain stays over budget and says where its tokens go', () => {
  const steps = Array.from({ length: 90 }, (_, i) => ({
    object: 'dut1',
    method: 'cmd_config',
    args: [i % 30 === 0 ? `demo host name "${LONG_NAME}" 60` : `demo feature ${i} on with option ${i * 7} and profile ${i * 13}`],
    keywords: {},
    author_step_refs: [String((i % 3) + 1)],
  }));
  const brief = fidelityBrief('doc:many-blocks', LONG_RECORD, { bucket: 'bed-1', blocks: [], steps, expects: [], replacements: [] })!;
  const res = renderFidelityStepState(brief, 2, partitionFidelityBlocks(brief));
  assert.equal(res.overBudget, true);
  assert.ok(res.estTokensPlain > FIDELITY_MAX_EST_TOKENS);
  assert.equal(res.estTokensAfter, res.estTokensPlain, 'what is reported is the plain figure');
  assert.ok(res.reducedEstTokens !== null && res.reducedEstTokens > FIDELITY_MAX_EST_TOKENS && res.reducedEstTokens < res.estTokensPlain, `reduced to ${res.reducedEstTokens}`);
  assert.deepEqual(res.substitutions, []);
  assert.ok(res.parts !== null && res.parts.commandBlocks > res.parts.exemptions && res.parts.exemptions > 0 && res.parts.currentStep > 0);
  assert.ok(!res.state.includes('[长字面量对照]'), 'a state that is refused is not rewritten');
});

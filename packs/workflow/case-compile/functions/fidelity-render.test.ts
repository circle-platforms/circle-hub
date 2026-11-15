import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fidelityBrief } from './fidelity.ts';
import { estimateTokens } from './generated/skills/plumb/plumb-client/index.ts';
import {
  FIDELITY_MAX_EST_TOKENS,
  formatBlockForFidelity,
  isNegativeMissingPreconditionCase,
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

test('partitionFidelityBlocks folds exempted precondition_source + paired cleanup:true while hiding worker prose', () => {
  const plan = {
    bucket: 'bed-1',
    blocks: [],
    steps: [
      {
        object: 'apv0',
        method: 'cmd_config',
        args: ['synconfig peer 192.0.2.2'],
        keywords: {},
        description: '内部描述不得泄露给模型',
        precondition_source: { reference: 'knowledge:manual#synconfig', text: 'Configure peer IP before enabling sync' },
      },
      {
        object: 'apv0',
        method: 'cmd_config',
        args: ['interface eth0', 'ip address 192.0.2.30/24', 'no shutdown'],
        keywords: {},
        description: '作者步骤描述',
        author_step_refs: ['1', '2'],
      },
      {
        object: 'apv0',
        method: 'cmd_show',
        args: ['show interface eth0'],
        keywords: {},
        author_step_refs: ['3'],
      },
      {
        object: 'apv0',
        method: 'cmd_config',
        args: ['no synconfig peer 192.0.2.2'],
        keywords: {},
        cleanup: true,
        precondition_source: { reference: 'knowledge:manual#synconfig', text: 'Remove peer IP during cleanup' },
      },
    ],
    expects: [{ text: '192.0.2.30', quote: { reference: 'r', text: '192.0.2.30' }, after: 3 }],
    replacements: [],
  };
  const brief = fidelityBrief('doc:1', RECORD, plan)!;
  const part = partitionFidelityBlocks(brief);
  assert.equal(part.negativeCase, false);
  assert.deepEqual([...part.exemptedIndices].sort((a, b) => a - b), [1, 4]);
  assert.deepEqual(part.candidateBlocks.map((b) => b.index), [2, 3]);

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
      { id: '1', kind: 'action', text: '在未配置 peer 前置的情况下执行 synconfig commit' },
      { id: 'e1', kind: 'expectation', text: 'peer is not configured' },
    ],
    ledgers: { original: [], adapted: [], rebindings: [] },
  };
  const negPlan = {
    bucket: 'bed-1',
    blocks: [],
    steps: [
      {
        object: 'apv0',
        method: 'cmd_config',
        args: ['synconfig peer 192.0.2.2'],
        keywords: {},
        precondition_source: { reference: 'knowledge:manual#synconfig', text: 'Configure peer' },
      },
      {
        object: 'apv0',
        method: 'cmd_config',
        args: ['synconfig commit'],
        keywords: {},
      },
    ],
    expects: [{ text: 'peer is not configured', quote: { reference: 'r', text: 'peer is not configured' }, after: 2 }],
    replacements: [],
  };
  const brief = fidelityBrief('doc:neg', negRecord, negPlan)!;
  assert.equal(isNegativeMissingPreconditionCase(brief), true);
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

  // Oversized single command block triggers overBudget rather than cutting mid-block.
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

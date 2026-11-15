// Unit tests for coarse command recall (<=40), tournament chunking, node builder, and @1800 state truncation.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BriefKnowledge, BriefNode } from './authoring-brief.ts';
import {
  buildCommandIndex,
  buildPlumbNode,
  CMD_RECALL_LIMIT,
  formatChoiceCandidates,
  lookupCommandDefinition,
  NONE_CANDIDATE,
  normalizeMatchedCandidate,
  partitionChoiceChunks,
  recallCommandCandidates,
  truncateCmdVerifyState,
} from './cmd-recall.ts';

function makeSyntheticKnowledge(count = 55): BriefKnowledge {
  const root = 'a'.repeat(64);
  const nodes = new Map<string, BriefNode>();
  nodes.set('/commands', {
    path: '/commands',
    children: [
      { name: 'ip', path: '/commands/ip' },
      { name: 'no', path: '/commands/no' },
      { name: 'show', path: '/commands/show' },
    ],
    entries: [],
  });
  nodes.set('/commands/ip', {
    path: '/commands/ip',
    children: [{ name: 'address', path: '/commands/ip/address' }],
    entries: [],
  });
  nodes.set('/commands/ip/address', {
    path: '/commands/ip/address',
    children: [],
    entries: [{
      kind: 'definition',
      statement: 'ip address <ip:ipv4> <mask:ipv4>\n  配置接口 IPv4 主地址与子网掩码',
      reference: `tree:${root}/commands/ip/address@1`,
    }],
  });
  nodes.set('/commands/no/ip/address', {
    path: '/commands/no/ip/address',
    children: [],
    entries: [{
      kind: 'definition',
      statement: 'no ip address\n  删除或取消接口 IPv4 地址配置',
      reference: `tree:${root}/commands/no/ip/address@2`,
    }],
  });
  nodes.set('/commands/show/ip/interface', {
    path: '/commands/show/ip/interface',
    children: [],
    entries: [{
      kind: 'definition',
      statement: 'show ip interface [<ifname:string>]\n  查看接口 IP 状态与地址信息',
      reference: `tree:${root}/commands/show/ip/interface@3`,
    }],
  });
  for (let i = 0; i < count; i += 1) {
    const p = `/commands/widget/cmd-${String(i).padStart(2, '0')}`;
    nodes.set(p, {
      path: p,
      children: [],
      entries: [{
        kind: 'definition',
        statement: `widget cmd-${String(i).padStart(2, '0')} <val:int>\n  合成组件命令 ${i}`,
        reference: `tree:${root}${p}@${10 + i}`,
      }],
    });
  }
  const parameters = new Map([
    ['ip address', [{ name: 'ip', statement: '接口 IPv4 地址，禁止使用保留广播地址', reference: `tree:${root}/manual/p@1` }]],
  ]);
  return { root, nodes, lines: new Map(), parameters };
}

test('buildCommandIndex and recallCommandCandidates cap results at 40 and rank Chinese/CLI intent accurately', () => {
  const knowledge = makeSyntheticKnowledge(55);
  const index = buildCommandIndex(knowledge);
  assert.equal(index.docs.length, 58);

  const recalled = recallCommandCandidates(index, '配置接口 ip address 组件 widget');
  assert.ok(recalled.length <= CMD_RECALL_LIMIT);
  assert.ok(recalled.length >= 2);
  assert.equal(recalled[0]!.candidate.command, 'ip address');
  assert.ok(recalled[0]!.candidate.definition.includes('参数说明: ip:'));

  const deleteRecall = recallCommandCandidates(index, '删除 接口 ip');
  assert.equal(deleteRecall[0]!.candidate.command, 'no ip address');

  const showRecall = recallCommandCandidates(index, '查看 接口 状态');
  assert.equal(showRecall[0]!.candidate.command, 'show ip interface');
});

test('partitionChoiceChunks and formatChoiceCandidates keep every Plumb chunk <=25 including NONE', () => {
  const knowledge = makeSyntheticKnowledge(40);
  const index = buildCommandIndex(knowledge);
  const recalled = recallCommandCandidates(index, 'widget', { limit: 40 }).map((r) => r.candidate);
  assert.equal(recalled.length, 40);

  const chunks = partitionChoiceChunks(recalled);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0]!.length, 24);
  assert.equal(chunks[1]!.length, 16);

  for (const chunk of chunks) {
    const formatted = formatChoiceCandidates(chunk);
    assert.ok(formatted.length >= 2 && formatted.length <= 25);
    assert.deepEqual(formatted.at(-1), NONE_CANDIDATE);
  }
});

test('normalizeMatchedCandidate resolves exact, syntax-suffixed, quoted, and NONE choices', () => {
  const index = buildCommandIndex(makeSyntheticKnowledge(5));
  const cands = index.docs.map((d) => d.candidate);

  assert.equal(normalizeMatchedCandidate('都不是', cands).noneSelected, true);
  assert.equal(normalizeMatchedCandidate('`ip address`', cands).matched?.command, 'ip address');
  assert.equal(normalizeMatchedCandidate('ip address <ip:ipv4> <mask:ipv4>', cands).matched?.command, 'ip address');
  assert.equal(normalizeMatchedCandidate('unknown command', cands).matched, null);
});

test('buildPlumbNode and lookupCommandDefinition populate non-empty node and locked syntax definition', () => {
  const knowledge = makeSyntheticKnowledge(3);
  const item = {
    id: 'doc:1',
    fields: {
      title: '接口配置测试',
      path: ['网络配置', '接口模块', '接口配置测试'],
      steps: [{ text: '为 eth0 配置地址 192.0.2.10/24' }],
    },
  };
  const node = buildPlumbNode(item, '为 eth0 配置地址 192.0.2.10/24', 'firewall');
  assert.equal(node.line, 'firewall');
  assert.equal(node.module, '接口模块');
  assert.deepEqual(node.path, ['网络配置', '接口模块', '接口配置测试']);
  assert.equal(node.title, '为 eth0 配置地址 192.0.2.10/24');

  const fallbackNode = buildPlumbNode({}, '');
  assert.ok(typeof fallbackNode.line === 'string' && fallbackNode.line.length > 0);

  const lookup = lookupCommandDefinition(knowledge, 'ip address 192.0.2.10/24');
  assert.equal(lookup.path, '/commands/ip/address');
  assert.equal(lookup.command, 'ip address');
  assert.ok(lookup.definition.includes('ip address <ip:ipv4>'));
});

test('truncateCmdVerifyState drops oldest executed steps without cutting current step under @1800 budget', () => {
  const longExecuted = Array.from({ length: 30 }, (_, i) => `step-${i}: ${'cmd arg '.repeat(25)}`);
  const current = '[当前步骤]\n步骤意图: 验证接口主地址\n待核验命令: ip address 192.0.2.10/24';
  const rendered = truncateCmdVerifyState({
    caseTitle: '接口地址验证',
    executedSteps: longExecuted,
    currentStepSection: current,
    overheadText: 'ip address 192.0.2.10/24',
  });
  assert.equal(rendered.truncated, true);
  assert.equal(rendered.overBudget, false);
  assert.ok(rendered.estTokensAfter <= 1800);
  assert.ok(rendered.state.includes(current));
  assert.ok(rendered.state.includes('已省略'));
  assert.ok(!rendered.state.includes('step-0:'));

  const huge = truncateCmdVerifyState({
    executedSteps: [],
    currentStepSection: `[当前步骤]\n${'超长中文命令说明'.repeat(1200)}`,
  });
  assert.equal(huge.overBudget, true);
});

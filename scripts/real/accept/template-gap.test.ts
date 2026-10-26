// Synthetic tool logs only; no client, Hub, connector or product code runs here.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import scenario, { type GapGold } from './template-gap.ts';

function categoryCheck(summary: string) {
  return scenario({ document: 'synthetic-document', cases: 2 }).check([
    { index: 1, tools: [], toolResults: [{ id: 'synthetic-result', text: `运行 run_synthetic\n用例 2 个；${summary}`, isError: false }] },
  ]).find(check => check.name === '给出缺的类别，不是只给一个数')!;
}

for (const summary of [
  '缺 18 个模板类别：合成类别',
  '缺 18 个模板类别（只列编号）：synthetic-category',
  '缺 2 个模板类别（合成说明）：类别甲、类别乙',
]) test(`accepts category summary ${summary}`, () => {
  assert.equal(categoryCheck(summary).ok, true);
});

for (const summary of [
  '缺 18 个模板类别',
  '缺 18 个模板类别(只列编号)：synthetic-category',
  '缺 18 个模板类别（只列编号：synthetic-category',
  '缺 18 个模板类别（说明）（另一说明）：synthetic-category',
  '缺 18 个模板类别（外层（内层））：synthetic-category',
  '缺 18 个模板类别（跨行\n说明）：synthetic-category',
  '缺 十八 个模板类别：synthetic-category',
  '缺 18 个模板类别（说明）:synthetic-category',
]) test(`rejects malformed category summary ${JSON.stringify(summary)}`, () => {
  assert.equal(categoryCheck(summary).ok, false);
});

const gold = { document: 'synthetic-document', cases: 2 };
const firstTurn = { index: 0, system: null, messages: [], tools: [], toolResults: [] };
const index = { external: 'knowledge:index:synthetic:Synthetic_build?kind=case&key=document&only=synthetic-document&fields=document,node,commands,title,path_labels' };

for (const flags of [{ build: 'Synthetic_build' }, { build: 'Synthetic_build', case_index: true }, { build: 'Synthetic_build', case_index: false }]) {
  test(`binds the exact document index ${JSON.stringify(flags)}`, async () => {
    assert.deepEqual(await scenario({ ...gold, product: 'synthetic', ...flags }).respond(firstTurn), [{
      tool: 'hub_start_run', input: { pack: 'template-gap', product: 'synthetic', build: 'Synthetic_build', inputs: {
        documents: { external: 'agile:mindmap:synthetic-document' }, case_index: index,
      } },
    }]);
  });
}

test('keeps document-only gold compatible without binding an index', async () => {
  for (const flags of [{}, { case_index: false }]) assert.deepEqual(await scenario({ ...gold, ...flags }).respond(firstTurn), [{
    tool: 'hub_start_run', input: { pack: 'template-gap', inputs: { documents: { external: 'agile:mindmap:synthetic-document' } } },
  }]);
});

for (const [flags, missing] of [
  [{ case_index: true }, 'product、build'],
  [{ product: 'synthetic', case_index: true }, 'build'],
  [{ build: 'Synthetic_build' }, 'product'],
  [{ product: ' ', build: 'Synthetic_build' }, 'product'],
  [{ product: 'synthetic', build: '', case_index: true }, 'build'],
] as const) test(`refuses an index request missing ${missing}: ${JSON.stringify(flags)}`, () => {
  assert.throws(() => scenario({ ...gold, ...flags }), error => error instanceof Error && error.message.includes(missing) && error.message.includes('补齐') && error.message.includes('重跑'));
});

test('index-backed gold requires a definite command coverage summary', () => {
  const configured: GapGold = { ...gold, product: 'synthetic', build: 'Synthetic_build' };
  for (const [summary, expected] of [
    ['按命令：2 个命令，1 个缺类别', true],
    ['按命令：0 个命令，0 个缺类别；用例未解析出命令', true],
    ['按命令：未计算，缺 case_index', false],
    ['按命令：已读 2 个命令，1 个潜在缺口待补证', false],
    ['', false],
  ] as const) {
    const checks = scenario(configured).check([{ index: 1, tools: [], toolResults: [{ id: 'synthetic-result', text: `运行 run_synthetic\n用例 2 个；缺 18 个模板类别：synthetic-category；${summary}`, isError: false }] }]);
    assert.equal(checks.find(check => check.name === '按命令覆盖已计算')?.ok, expected, summary);
  }
});

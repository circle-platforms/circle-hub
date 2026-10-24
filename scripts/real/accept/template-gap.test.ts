// Synthetic tool logs only; no client, Hub, connector or product code runs here.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import scenario from './template-gap.ts';

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

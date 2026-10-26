import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseLog, resultTexts } from './lib/accept.ts';
import caseLocation from './accept/case-location.ts';
import templateGap from './accept/template-gap.ts';

const log = [
  { index: 0, tools: [{ name: 'hub_start_run' }], toolResults: [] },
  { index: 1, tools: [{ name: 'hub_start_run' }], toolResults: [{ id: 't1', text: '运行 run_x：任务包 case-location@1.0.0\n- location 用例定位：满足 1\n产品线 famx（FAMY）；版本 10.6.1（目录，置信度高）；发布火车 10.6.1-R1', isError: false }] },
]
  .map((row) => JSON.stringify(row))
  .join('\n');

test('the model log is read as turns and the tool results as the client forwarded them', () => {
  const turns = parseLog(`${log}\n`);
  assert.deepEqual(turns.map((t) => t.index), [0, 1]);
  assert.equal(resultTexts(turns).length, 1);
  assert.deepEqual(turns[0].tools, ['hub_start_run']);
});

test('the case-location scenario starts the run in the first turn and checks the answer against the gold', () => {
  const s = caseLocation({ document: '90001', product: 'FAMX', line: '10.6.1', train: '10.6.1-R1' });
  assert.deepEqual(s.respond({ index: 0, system: null, messages: [], tools: [], toolResults: [] }), [
    { tool: 'hub_start_run', input: { pack: 'case-location', product: 'FAMX', inputs: { documents: { external: 'agile:mindmap:90001' } } } },
  ]);
  assert.deepEqual(s.respond({ index: 1, system: null, messages: [], tools: [], toolResults: [] }), [{ text: '定位完成。' }]);
  const turns = parseLog(log);
  turns[1].toolResults[0].text += '\n条目（1 个；编号 | 名称 | 摘要）：\n- 90001 | 合成文档 | 产品线 famx；版本 10.6.1（目录，置信度高）；发布火车 10.6.1-R1';
  const checks = s.check(turns);
  assert.ok(checks.some((c) => !c.ok && c.name.includes('候选')), 'missing candidates are a failed check after starting the scenario');
  const wrong = caseLocation({ document: '90001', product: 'FAMX', line: '10.7.0' }).check(turns);
  assert.ok(wrong.some((c) => !c.ok && c.name.includes('版本线')), 'a different line in the gold is a mismatch');
});

test('the template-gap scenario compares the case count with the independent count', () => {
  const turns = parseLog(JSON.stringify({ index: 1, tools: [], toolResults: [{ id: 't', text: '运行 run_y\n- 24001 | 标题 | 用例 62 个；缺 18 个模板类别：集成测试（integration）', isError: false }] }));
  assert.ok(templateGap({ document: '90001', cases: 62 }).check(turns).every((c) => c.ok));
  assert.ok(templateGap({ document: '90001', cases: 61 }).check(turns).some((c) => !c.ok));
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SubmitResultOutput } from '../../contracts/src/tools.ts';
import { accepted, acceptedCounts } from '../../contracts/src/fixtures.ts';
import { toolText } from './text.ts';

const job = 'a'.repeat(64);
const base = SubmitResultOutput.parse({ call_result: 'ok', acceptance: 'accepted', result: accepted, counts: acceptedCounts(), errors: [], trace: '4bf92f3577b34da6a3ce929d0e0e4736' });

test('MCP preserves source wording that distinguishes two dispatch rounds', () => {
  const note = {
    text: '本作业第1轮已受理。第2轮派发没有发出，不能据此说整个作业未执行。',
    job_facts: { scope: { job }, operation: 'dispatch' as const },
    dispatch_attempt: { scope: { operation: 'dispatch' as const, job, round: 2 }, outcome: 'not_dispatched' as const, not_sent: true as const },
  };
  const text = toolText('submit_result', { ...base, dispatch: [note] });
  assert.equal(text.split('\n').filter(line => line === note.text).length, 1);
});

test('MCP does not classify quoted diagnostic words as a dispatch outcome', () => {
  const note = {
    text: '来源引用了“上机验证结果未知”这段说明；这段引用不是本轮结局。',
    job_facts: { scope: { job } },
    dispatch_attempt: { scope: { operation: 'dispatch' as const, job, round: 1 }, outcome: 'issued' as const },
  };
  const text = toolText('submit_result', { ...base, dispatch: [note] });
  assert.ok(text.split('\n').includes(note.text));
  assert.equal(text.includes(note.text + '；状态未知'), false);
});

test('MCP keeps the source-selected member and administrator actions intact', () => {
  for (const role of ['user', 'admin'] as const) {
    const next = role === 'user' ? '请联系管理员；改正之前重试结果不会变。' : '请在控制台「测试环境」页或用 circle-hub bed update 把上面不一致的这一项改正；改正后原样重试。';
    const note = { text: '暂时不可用：测试环境「合成环境」登记不一致，这次上机验证没有执行。' + next };
    const text = toolText('submit_result', { ...base, dispatch: [note] }, { caller: { role } });
    assert.ok(text.split('\n').includes(note.text));
    assert.equal(text.includes(note.text + '；判断错误'), false);
  }
});

test('a job report reference does not make the adapter invent an attempt result', () => {
  const note = { text: '作业已有报告引用；当前轮次尚未取得完整结局。', job_facts: { scope: { job }, result: 'src:' + 'b'.repeat(64) } };
  const text = toolText('submit_result', { ...base, dispatch: [note] });
  assert.ok(text.split('\n').includes(note.text));
  assert.equal(text.includes('设备输出已取回'), false);
});

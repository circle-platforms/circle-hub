import assert from 'node:assert/strict';
import test from 'node:test';
import { StartRunOutput } from '../../contracts/src/tools.ts';
import { toolText } from './text.ts';

const TRACE = 'a'.repeat(32);

test('SOURCE_NOT_PERMITTED pack refusal is judged, not missing evidence', () => {
  const text = toolText('start_run', StartRunOutput.parse({
    call_result: 'error',
    errors: [{
      code: 'SOURCE_NOT_PERMITTED',
      message: '任务包 recompose 存在，没有分配给你',
      fix: '请管理员把它分配给你；用 list_task_packs 看你能用的任务包',
      path: '/pack',
    }],
    trace: TRACE,
  }));
  assert.doesNotMatch(text, /资料尚未取得/);
  assert.doesNotMatch(text, /状态未知|原因缺资料/);
  assert.match(text, /没有分配给你/);
  assert.match(text, /状态已确认；判断错误/);
  assert.match(text, /下一步请管理员把它分配给你/);
  assert.match(text, /决定者程序/);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { StartRunOutput } from '../../contracts/src/tools.ts';
import { toolText } from './text.ts';

const TRACE = 'a'.repeat(32);

test('SOURCE_NOT_PERMITTED pack refusal uses the 无权限 category sentence', () => {
  const text = toolText('start_run', StartRunOutput.parse({
    call_result: 'error',
    errors: [{
      code: 'SOURCE_NOT_PERMITTED',
      message: '当前账户未获授权使用工作流「recompose」',
      fix: '请联系管理员为该账户或所在团队分配此工作流',
      path: '/pack',
    }],
    trace: TRACE,
  }));
  assert.equal(
    text,
    '无权限：当前账户未获授权使用工作流「recompose」。请联系管理员为该账户或所在团队分配此工作流。当前账户可用的工作流和技能用 list_task_packs 查看。',
  );
  assert.doesNotMatch(text, /这次核对有错误|资料尚未取得|状态已确认|判断错误|决定者程序|原因|任务包|没有分配给你/);
});

test('SOURCE_ABSENT pack refusal uses the 不存在 category sentence', () => {
  const text = toolText('start_run', StartRunOutput.parse({
    call_result: 'error',
    errors: [{
      code: 'SOURCE_ABSENT',
      message: 'Hub 里没有名为「toy-missing」的工作流或技能',
      fix: '请核对名称',
      path: '/pack',
    }],
    trace: TRACE,
  }));
  assert.equal(text, '不存在：Hub 里没有名为「toy-missing」的工作流或技能。请核对名称。');
  assert.doesNotMatch(text, /这次核对有错误|资料尚未取得|状态已确认|判断错误|决定者程序|原因|任务包/);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatCallError } from './text.ts';

test('formatCallError outputs one of the five closed categories with fact and next step', () => {
  assert.equal(
    formatCallError(new Error('需要参数：--file')),
    '参数无效：需要参数：--file。请核对命令参数、选项格式或输入文件内容后重试。',
  );
  assert.equal(
    formatCallError(Object.assign(new Error('not found'), { code: 'ENOENT' })),
    '不存在：not found。请核对文件路径、运行编号或目标条目是否存在后重试。',
  );
  assert.equal(
    formatCallError(Object.assign(new Error('denied'), { status: 403 })),
    '无权限：denied。请检查标准输入令牌、访问权限或文件权限后重试。',
  );
  assert.equal(
    formatCallError(Object.assign(new Error('conflict'), { status: 409 })),
    '已被占用：conflict。请更换名称或确认当前运行及目标状态后重试。',
  );
  assert.equal(
    formatCallError(Object.assign(new Error('gateway timeout'), { status: 504 })),
    '暂时不可用：gateway timeout。请确认 Hub 地址与网络连接或稍后重试。',
  );
});

test('formatCallError strips disallowed words, preserves internal periods and newlines, and respects explicit category', () => {
  const formatted = formatCallError(
    new Error('参数无效：你传入的 undefined 不合法。任务包未完成。\n1) 第一步\n2) 第二步'),
    { category: '参数无效' },
  );
  assert.equal(
    formatted,
    '参数无效：传入的 未填写 不合法。工作流未完成。1) 第一步\n2) 第二步。',
  );
});

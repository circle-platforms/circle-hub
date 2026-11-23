import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CallFailure, callFailureData, failCall, formatCallError, parseCliOptions } from './text.ts';

test('typed refusal preserves fact and next action as independent fields', () => {
  const error = new CallFailure('invalid_parameters', '第一事实。第二事实\n原文不改', '合法下一步', { path: '/file', legal_form: 'cmd --file value' });
  assert.equal(formatCallError(error), '参数无效：第一事实。第二事实\n原文不改。合法下一步。位置：/file。合法写法：cmd --file value。');
  assert.equal(callFailureData(error).category, 'invalid_parameters');
  assert.throws(() => failCall('not_found', '缺少文件', '提供文件'), CallFailure);
});

test('unknown error prose never determines a category, cause or next step', () => {
  for (const text of ['需要参数：--file', '无权限：令牌不足', 'network conflict not found', '你传入的 undefined 不合法。任务包未完成']) {
    const error = new Error(text);
    assert.equal(callFailureData(error).category, null);
    const shown = formatCallError(error);
    assert.match(shown, /^暂时不可用：调用未完成，缺少结构化错误原因。/);
    assert.doesNotMatch(shown, /检查标准输入令牌|确认 Hub 地址|请核对文件路径/);
  }
});

test('native structured codes select exact recovery without reading error text', () => {
  assert.match(formatCallError(Object.assign(new Error('misleading 403'), { code: 'ENOENT', path: 'synthetic.json' })), /^不存在：文件位置不存在或不是目录：synthetic.json。/);
  for (const status of [403, 409, 504]) {
    const error = Object.assign(new Error('arbitrary program status'), { status });
    assert.equal(callFailureData(error).category, null);
    const unknown = formatCallError(error);
    assert.match(unknown, /调用未完成，缺少结构化错误原因/);
    assert.doesNotMatch(unknown, /Hub 返回 HTTP|^无权限：|^已被占用：/);
  }
  assert.match(formatCallError(new CallFailure('permission_denied', '已知 Hub HTTP 边界返回 403', '按本次远端答复核对授权')), /^无权限：已知 Hub HTTP 边界返回 403。/);
});

test('parseCliOptions parses required/optional flags and rejects malformed arguments', () => {
  const spec = { file: true, brief: false };
  const usage = 'cmd --file <f> [--brief <b>]';
  assert.deepEqual(parseCliOptions(['--file', 'a.json'], spec, usage), { file: 'a.json' });
  assert.deepEqual(parseCliOptions(['--file', 'a.json', '--brief', 'b.json'], spec, usage), {
    file: 'a.json',
    brief: 'b.json',
  });
  assert.throws(() => parseCliOptions(['a.json'], spec, usage), /不支持单独的参数/);
  assert.throws(() => parseCliOptions(['--file=a.json'], spec, usage), /不能用 = 连接参数值/);
  assert.throws(() => parseCliOptions(['--unknown', 'x'], spec, usage), /未知选项 --unknown/);
  assert.throws(() => parseCliOptions(['--file', '--brief', 'b.json'], spec, usage), /必须只写一次且紧跟一个值/);
  assert.throws(() => parseCliOptions(['--file', 'a.json', '--file', 'b.json'], spec, usage), /必须只写一次且紧跟一个值/);
  assert.throws(() => parseCliOptions(['--brief', 'b.json'], spec, usage), /缺少必填参数 --file/);
});

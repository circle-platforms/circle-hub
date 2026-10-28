import assert from 'node:assert/strict';
import {test} from 'node:test';
import {sandboxUnavailableNotice} from './hub.ts';

test('Linux unavailable isolation names the actual backend, missing capability and the operator action', () => {
  const message=sandboxUnavailableNotice('linux');
  assert.match(message,/bubblewrap\/AppArmor/);
  assert.match(message,/任务包函数.*都不会运行/);
  assert.match(message,/管理员检查.*策略.*用户命名空间.*重启 Hub/);
  assert.doesNotMatch(message,/sandbox-exec/);
});

test('macOS unavailable isolation preserves its original warning', () => {
  assert.equal(sandboxUnavailableNotice('darwin'),'这台机器上没有可用的 sandbox-exec：任务包函数（投影、检查、同步和读取插件）都不会运行，相关的调用会失败');
});

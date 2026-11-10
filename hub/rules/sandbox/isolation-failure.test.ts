// What a failed isolation probe says to the operator (issue 291). On production the Hub ran under Node 22: the sandbox
// child is always started with --permission, but that Node has no process.permission.drop, so the probe answered
// node_permission_drop_missing and every pack function was refused, while the message named four possible causes at once.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isolationFailureText } from './isolation.ts';

test('each probe failure reads as its own cause, and the missing drop names the Node that ran and what to use instead', () => {
  const missing = isolationFailureText('node_permission_drop_missing', 'v22.22.3');
  assert.match(missing, /运行 Hub 的 Node（v22\.22\.3）在权限模型下没有 process\.permission\.drop/);
  assert.match(missing, /需要 Node 24 及以上，用安装包自带的 Node 运行服务和命令/);
  const reasons = ['node_permission_drop_missing', 'node_permission_drop_failed', 'bubblewrap_or_apparmor_tools_missing', 'bubblewrap_apparmor_or_user_namespace_unavailable', 'linux_runtime_bindings_unavailable', 'bubblewrap_or_apparmor_spawn_failed', 'platform', 'no_sandbox_exec'];
  const texts = reasons.map((reason) => isolationFailureText(reason, 'v24.0.0'));
  assert.equal(new Set(texts).size, reasons.length, 'no two causes share a sentence');
  for (const text of texts) assert.doesNotMatch(text, /_/, 'a known cause is not shown as its code');
  assert.equal(isolationFailureText(undefined), '操作系统隔离不可用');
  assert.equal(isolationFailureText('exit 7'), '操作系统隔离的探测没有通过（exit 7）', 'an unlisted cause is shown as it was reported');
});

test('the default is the running Node', () => {
  assert.ok(isolationFailureText('node_permission_drop_missing').includes(process.version));
});

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { createIsolationProbe, LINUX_PERMISSION_PROBE, linuxProbeOutcome, NODE } from './isolation.ts';

function run(prelude = '') {
  return spawnSync(NODE, ['--permission', '--allow-child-process', '--allow-fs-write=/dev/null', '--no-warnings', '-e', prelude + LINUX_PERMISSION_PROBE], { encoding: 'utf8', env: {} });
}

test('Linux startup refuses a Node runtime without permission.drop and records the missing capability', async () => {
  const result = run('process.permission.drop=undefined;');
  assert.equal(result.error, undefined);
  assert.equal(result.status, 22, result.stderr);
  const probe = createIsolationProbe({ probe: async () => linuxProbeOutcome(result.status), retryMs: 5_000 });
  assert.equal(await probe.available(), false);
  assert.equal(probe.lastFailure(), 'node_permission_drop_missing');
});

test('Linux startup refuses a drop implementation that leaves temporary permissions enabled', () => {
  const result = run('process.permission.drop=()=>{};');
  assert.equal(result.status, 23, result.stderr);
  assert.deepEqual(linuxProbeOutcome(result.status), { available: false, lasting: false, reason: 'node_permission_drop_failed' });
});

test('Linux startup refuses a throwing drop implementation', () => {
  const result = run("process.permission.drop=()=>{throw Error('synthetic')};");
  assert.equal(result.status, 23, result.stderr);
});

test('Linux startup actually revokes Node child and write permissions', t => {
  const result = run();
  if (result.status === 22) return t.skip('This Node runtime lacks permission.drop; startup correctly reports it unavailable');
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(linuxProbeOutcome(result.status), { available: true });
});

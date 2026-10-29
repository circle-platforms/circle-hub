import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { BOOTSTRAP, isolatedCommand, linuxProbeOutcome, NODE, osIsolationAvailable } from './isolation.ts';

test('Node starts without child or write grants even when permission.drop is unavailable', () => {
  const script = `process.permission.drop=undefined; if(process.permission.has('child')||process.permission.has('fs.write','/dev/null'))process.exit(1);`;
  const result = spawnSync(NODE, ['--permission', '--no-warnings', '-e', script], { encoding: 'utf8', env: {} });
  assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr);
});

test('the normal worker command grants neither child execution nor filesystem writes', () => {
  const command = isolatedCommand({ entry: BOOTSTRAP, reads: [], heapMb: 256, cpuSeconds: 10, os: false });
  assert.equal(typeof osIsolationAvailable, 'function');
  assert.ok(!command.args.some(arg => arg.startsWith('--allow-child-process') || arg.startsWith('--allow-fs-write')));
});

test('an unavailable operating-system sandbox still has no production fallback', () => {
  assert.deepEqual(linuxProbeOutcome(0), { available: true });
  assert.deepEqual(linuxProbeOutcome(20), { available: false, lasting: false, reason: 'bubblewrap_apparmor_or_user_namespace_unavailable' });
});

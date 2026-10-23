import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SandboxError } from './errors.ts';
import { osIsolationAvailable } from './isolation.ts';
import { callPackFunction, type SandboxOptions } from './sandbox.ts';

for (const cause of ['timeout', 'queue_full', 'stopping', 'spawn_failed']) test(`bounded retry recovers from ${cause} with recorded backoff`, async () => {
  const os = await osIsolationAvailable();
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'circle-hub-function-retry-')));
  await writeFile(join(dir, 'fn.ts'), 'export default () => 7;');
  const spawn = childProcess.spawn; let calls = 0;
  const attempts: Record<string, unknown>[] = [];
  try {
    childProcess.spawn = ((...args: Parameters<typeof spawn>) => {
      if (args[1]?.some(arg => String(arg).endsWith('/bootstrap.ts')) && ++calls <= (cause === 'timeout' ? 1 : 2)) {
        throw cause === 'timeout' ? new SandboxError('SANDBOX_TIMEOUT', { limit: 'time' }) : new SandboxError('SANDBOX_UNAVAILABLE', { reason: cause });
      }
      return spawn(...args);
    }) as typeof spawn;
    syncBuiltinESMExports();
    const options: SandboxOptions = { requireOsIsolation: os, retryWallTimeout: cause === 'timeout', onAttempt: attempt => attempts.push({ ...attempt, observedAt: performance.now() }) };
    const result = await callPackFunction({ packDir: dir, module: 'fn.ts' }, null, { timeoutMs: 1000 }, options);
    assert.equal(result.output, 7); assert.equal(calls, cause === 'timeout' ? 2 : 3);
    assert.deepEqual(attempts.map(attempt => attempt.attempt), cause === 'timeout' ? [1, 2] : [1, 2, 3]);
    assert.deepEqual(attempts.map(attempt => attempt.delayMs), cause === 'timeout' ? [50, 0] : [50, 100, 0]);
    assert.ok(Number(attempts[1].observedAt) - Number(attempts[0].observedAt) >= 45);
    if (cause !== 'timeout') assert.ok(Number(attempts[2].observedAt) - Number(attempts[1].observedAt) >= 95);
    assert.ok(attempts.every(attempt => attempt.timeoutMs === 1000));
  } finally {
    childProcess.spawn = spawn; syncBuiltinESMExports(); await rm(dir, { recursive: true, force: true });
  }
});

test('retry exhaustion is bounded and deterministic function defects are never retried', async () => {
  const os = await osIsolationAvailable();
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'circle-hub-function-retry-')));
  await writeFile(join(dir, 'fn.ts'), 'export default () => 7;');
  const spawn = childProcess.spawn;
  try {
    for (const transient of [true, false]) {
      let calls = 0;
      const error = transient ? new SandboxError('SANDBOX_TIMEOUT', { limit: 'time' }) : new SandboxError('FUNCTION_THREW');
      childProcess.spawn = ((...args: Parameters<typeof spawn>) => {
        if (args[1]?.some(arg => String(arg).endsWith('/bootstrap.ts'))) { calls++; throw error; }
        return spawn(...args);
      }) as typeof spawn;
      syncBuiltinESMExports();
      await assert.rejects(callPackFunction({ packDir: dir, module: 'fn.ts' }, null, {}, { requireOsIsolation: os }), failure => failure === error);
      assert.equal(calls, 1);
    }
  } finally { childProcess.spawn = spawn; syncBuiltinESMExports(); await rm(dir, { recursive: true, force: true }); }
});

test('stopAll during backoff never resurrects a cancelled function', async () => {
  const { stopAll, livePids } = await import('./sandbox.ts');
  const os = await osIsolationAvailable();
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'circle-hub-function-retry-')));
  await writeFile(join(dir, 'fn.ts'), 'export default () => 7;');
  const spawn = childProcess.spawn; let calls = 0;
  try {
    childProcess.spawn = ((...args: Parameters<typeof spawn>) => {
      if (args[1]?.some(arg => String(arg).endsWith('/bootstrap.ts')) && ++calls === 1) {
        stopAll(); throw new SandboxError('SANDBOX_UNAVAILABLE', { reason: 'stopping' });
      }
      return spawn(...args);
    }) as typeof spawn;
    syncBuiltinESMExports();
    await assert.rejects(callPackFunction({ packDir: dir, module: 'fn.ts' }, null, {}, { requireOsIsolation: os }),
      error => error instanceof SandboxError && error.detail.reason === 'stopping');
    assert.equal(calls, 1); assert.deepEqual(livePids(), []);
    childProcess.spawn = spawn; syncBuiltinESMExports();
    assert.equal((await callPackFunction({ packDir: dir, module: 'fn.ts' }, null, {}, { requireOsIsolation: os })).output, 7);
  } finally { childProcess.spawn = spawn; syncBuiltinESMExports(); await rm(dir, { recursive: true, force: true }); }
});

test('synchronous process startup errors are normalized and retried without private messages', async () => {
  const os = await osIsolationAvailable();
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'circle-hub-function-retry-')));
  await writeFile(join(dir, 'fn.ts'), 'export default () => 7;');
  const spawn = childProcess.spawn; let calls = 0;
  const attempts: Record<string, unknown>[] = [];
  try {
    childProcess.spawn = ((...args: Parameters<typeof spawn>) => {
      if (args[1]?.some(arg => String(arg).endsWith('/bootstrap.ts')) && ++calls < 3) throw Object.assign(new Error('SyntheticPrivateSpawnFailure'), { code: 'EAGAIN' });
      return spawn(...args);
    }) as typeof spawn;
    syncBuiltinESMExports();
    const result = await callPackFunction({ packDir: dir, module: 'fn.ts' }, null, {}, {
      requireOsIsolation: os, onAttempt: attempt => attempts.push({ ...attempt }),
    });
    assert.equal(result.output, 7); assert.equal(calls, 3);
    assert.equal(attempts[0].reason, 'spawn_failed'); assert.equal(attempts[0].code, 'SANDBOX_UNAVAILABLE');
    assert.ok(!JSON.stringify(attempts).includes('SyntheticPrivateSpawnFailure'));
  } finally { childProcess.spawn = spawn; syncBuiltinESMExports(); await rm(dir, { recursive: true, force: true }); }
});

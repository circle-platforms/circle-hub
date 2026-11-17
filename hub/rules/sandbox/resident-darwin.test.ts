// The watchdog end to end, through the macOS sampler: there one round is one /bin/ps for every running child (resident.ts),
// which a test can replace without touching the Hub's code. On Linux the sampler reads /proc, so these tests skip there; the
// verdict itself is tested without a platform in resident-linux.test.ts.
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SandboxError } from './errors.ts';
import { osIsolationAvailable } from './isolation.ts';
import { RESIDENT_UNAVAILABLE_MESSAGE } from './resident.ts';
import type { FunctionAttempt } from './retry.ts';
import { callPackFunction, type SandboxResult } from './sandbox.ts';

const MACOS_SAMPLER = { skip: process.platform === 'darwin' ? false : 'the resident sampler of this platform does not run /bin/ps' };

type Spawn = typeof childProcess.spawn;

/** The code and detail of a sandbox error, as the message of an assertion that expected the call to go on. */
const describe = (error: unknown): string => error instanceof SandboxError ? `${error.code} ${JSON.stringify(error.detail)}` : String(error);

/**
 * Calls a pure function that stays busy for `busyMs`, while `replace` stands in for every /bin/ps the sampler starts (its
 * round number counts from 1 and `real` starts the true command). Resolves with the call's result or error, and every attempt.
 */
async function callWithSampler(busyMs: number, replace: (round: number, real: Spawn, args: Parameters<Spawn>) => ReturnType<Spawn>) {
  const os = await osIsolationAvailable();
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'circle-hub-function-watchdog-')));
  await writeFile(join(dir, 'fn.ts'), `export default () => { const end = Date.now() + ${busyMs}; while (Date.now() < end); return 7; };`);
  const spawn = childProcess.spawn;
  const attempts: FunctionAttempt[] = [];
  let round = 0;
  try {
    childProcess.spawn = ((...args: Parameters<Spawn>) => args[0] === '/bin/ps' ? replace(++round, spawn, args) : spawn(...args)) as Spawn;
    syncBuiltinESMExports();
    return await callPackFunction({ packDir: dir, module: 'fn.ts' }, null, {}, { requireOsIsolation: os, onAttempt: attempt => attempts.push(attempt) })
      .then((result): { result: SandboxResult; attempts: FunctionAttempt[] } => ({ result, attempts }), (error: unknown) => ({ error, attempts }));
  } finally {
    childProcess.spawn = spawn; syncBuiltinESMExports(); await rm(dir, { recursive: true, force: true });
  }
}

test('a Hub held for more than a second inside a sampling round does not end a healthy call (decision 116)', MACOS_SAMPLER, async () => {
  const held = await callWithSampler(2_500, (round, real, args) => {
    // The third round has started and its one-second timeout is armed; the Hub's thread is then held for 1.3 s. When it
    // is free again that round reports the child unobserved, and the last complete measurement is older than the grace.
    if (round === 3) { const end = Date.now() + 1_300; while (Date.now() < end); }
    return real(...args);
  });
  assert.ok('result' in held, 'error' in held ? `the call ended: ${describe(held.error)}` : undefined);
  assert.equal(held.result.output, 7);
  assert.equal(held.attempts.length, 1, 'one attempt: the call was never stopped, so nothing had to be retried');
  assert.equal(held.attempts[0].retry, false);
});

test('a sampler that never sees the tree ends the call after five rounds and a second, and the sandbox runs it again', MACOS_SAMPLER, async () => {
  // `true` prints nothing, so every round is unobserved. The function stays busy for 5 s; the watchdog must end it long before.
  const blind = await callWithSampler(5_000, (_round, real) => real('/usr/bin/true', []));
  assert.ok('error' in blind, 'the call must not complete');
  const error = blind.error;
  assert.ok(error instanceof SandboxError);
  assert.equal(error.code, 'SANDBOX_UNAVAILABLE');
  assert.equal(error.detail.reason, 'resident_observation_unavailable');
  assert.equal(error.message, RESIDENT_UNAVAILABLE_MESSAGE);
  assert.equal(blind.attempts.length, 3, 'three attempts, then the failure is given up as it is');
  assert.deepEqual(blind.attempts.map(attempt => attempt.reason), Array(3).fill('resident_observation_unavailable'));
  // 5 rounds take half a second at 100 ms; the second since the last complete measurement is what keeps the call alive that long.
  assert.ok(blind.attempts.every(attempt => attempt.durationMs >= 1_000), JSON.stringify(blind.attempts.map(attempt => attempt.durationMs)));
});

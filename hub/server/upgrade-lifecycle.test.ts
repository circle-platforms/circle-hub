import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { before, after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { openCliHarness, type CliHarness } from './assemble/test-cli.ts';

let harness: CliHarness;
before(async () => { harness = await openCliHarness(); });
after(async () => { await harness?.close(); });

type Receipt = { stage: string; error?: string; code: number; ownedConnected: boolean; ownedEnds: number; ownedTotal: number; ownedIdle: number; idleTimers: number; idleRefs: number; idleFired: number; printedStopped: boolean };

async function lifecycle(failListen: boolean, port?: number) {
  const deployment = await harness.deployment();
  const child = fork(fileURLToPath(new URL('./testing-upgrade-lifecycle.ts', import.meta.url)), [], {
    execArgv: [], env: { PATH: process.env.PATH, HOME: harness.scratch }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let diagnostics = '';
  child.stderr!.on('data', chunk => { diagnostics += chunk.toString(); });
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    child.once('exit', (code, signal) => resolve({ code, signal })); child.once('error', reject);
  });
  const stopped = new Promise<Receipt>((resolve, reject) => {
    child.once('message', message => resolve(message as Receipt));
    child.once('exit', () => reject(new Error('fixture exited without receipt: ' + diagnostics)));
  });
  child.send({ env: { ...deployment.env, ...(port === undefined ? {} : { CIRCLE_HUB_PORT: String(port) }) }, dataDir: deployment.dataDir, failListen });
  let clean = false;
  try {
    const receipt = await stopped;
    assert.equal(receipt.stage, 'stopped', receipt.error ?? diagnostics);
    assert.equal(receipt.code, failListen ? 1 : 0);
    assert.equal(receipt.ownedConnected, true, 'the real assembly lease connection was actually opened');
    assert.equal(receipt.ownedEnds, 1, 'serve must end the independently owned lease Database exactly once');
    assert.equal(receipt.ownedTotal, 0);
    assert.equal(receipt.ownedIdle, 0);
    assert.equal(receipt.idleTimers, 0);
    assert.equal(receipt.idleRefs, 0);
    assert.equal(receipt.idleFired, 0, 'success must clear timers rather than wait for idle expiry');
    if (!failListen) assert.equal(receipt.printedStopped, true);
    clean = true;
  } finally {
    if (child.connected) child.send({ cleanup: !clean });
    const exit = await exited;
    assert.equal(exit.signal, null);
    assert.equal(exit.code, 0, diagnostics);
  }
}

test('serve after a real MCP lease-context read ends the owned pool and the child exits before idle expiry', { timeout: 30_000 }, async () => {
  await lifecycle(false);
});

test('a listener startup failure also ends the assembly-owned connected pool', { timeout: 30_000 }, async () => {
  const occupied = createServer();
  await new Promise<void>(resolve => occupied.listen(0, '127.0.0.1', resolve));
  try { await lifecycle(true, (occupied.address() as AddressInfo).port); }
  finally { await new Promise<void>(resolve => occupied.close(() => resolve())); }
});

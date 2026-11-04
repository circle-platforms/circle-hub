// What a connection declared: a process keeps what it read, and what an initialize just told it stays, whatever a read that
// began before it comes back with.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DeclaredClients, type DeclaredClient } from './declared-clients.ts';

type Stored = { name: string; version: string | null; at: string } | null;
const DECLARED: DeclaredClient = { name: 'synthetic-client', version: '2.0', platform: 'synthetic-os' };
const STORED: Stored = { name: 'synthetic-client', version: '1.0', at: '2026-11-04T08:00:00.000Z' };

/** Until a read that was just asked for has reached the log. */
const onItsWay = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** A log whose reads wait until the test answers them; `reads` counts them. */
function waitingLog(): { clients: DeclaredClients; reads: () => number; answer(value: Stored): void } {
  const pending: ((value: Stored) => void)[] = [];
  let reads = 0;
  const latestDeclaredClient = (): Promise<Stored> => {
    reads += 1;
    return new Promise((resolve) => pending.push(resolve));
  };
  const clients = new DeclaredClients({ records: { callLog: { latestDeclaredClient } } } as never);
  return { clients, reads: () => reads, answer: (value) => pending.shift()!(value) };
}

test('what an initialize told this process stays, whatever a read that was already on its way brings back', async () => {
  for (const stored of [STORED, null]) {
    const { clients, reads, answer } = waitingLog();
    const reading = clients.of('usr_synthetic', 'tok_synthetic', null);
    await onItsWay();
    assert.equal(reads(), 1);
    clients.remember('usr_synthetic', 'tok_synthetic', null, DECLARED);
    answer(stored);
    assert.deepEqual(await reading, DECLARED, 'the read cannot know the declaration, which reaches the records after it');
    assert.deepEqual(await clients.of('usr_synthetic', 'tok_synthetic', null), DECLARED, 'and a later call finds the platform, which no record holds');
    assert.equal(reads(), 1);
  }
});

test('a read with nothing newer beside it is kept, a connection that declared nothing included', async () => {
  const { clients, reads, answer } = waitingLog();
  const found = clients.of('usr_synthetic', 'tok_found', null);
  await onItsWay();
  answer(STORED);
  assert.deepEqual(await found, { name: 'synthetic-client', version: '1.0', platform: null });
  const none = clients.of('usr_synthetic', 'tok_none', null);
  await onItsWay();
  answer(null);
  assert.equal(await none, null);
  assert.equal(await clients.of('usr_synthetic', 'tok_none', null), null);
  assert.equal(reads(), 2, 'known, so not read again');
});

// What a lease answer says when the lease clock has not passed the receipt: the Hub reads again only within a second, states
// only what its reads observed, and never sends the client back to resubmit a capture whose record would be reused
// (round-seven review of the lease work, item 1). The history is scripted, so each read's answer is fixed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ActionBody, RecordStore, StoredRecord } from '../records/api.ts';
import { operationLease } from './feeding-leases.ts';

const CAPTURED = '2026-01-01T00:00:00.000Z';
const RECEIVED = '2026-01-01T00:00:10.000Z';
const input = { key: 'bed/synthetic/device0', device: 'device0', user: 'synthetic-user', capturedAt: CAPTURED, receivedAt: RECEIVED };
const store = {} as RecordStore;
const shifted = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString();

interface Read { settled: boolean; asOf: string; complete?: boolean; unattributable?: StoredRecord<ActionBody>[] }

function scripted(...reads: Read[]) {
  const windows: Array<{ key: string; from: string; to: string }> = [];
  const service = {
    async history(window: { key: string; from: string; to: string }) {
      windows.push(window);
      const read = reads[Math.min(windows.length, reads.length) - 1]!;
      return { before: null, events: [], complete: read.complete ?? true, unattributable: read.unattributable ?? [], settled: read.settled, asOf: read.asOf };
    },
  };
  return { windows, service };
}

test('a first read the lease clock passes within a second is read again, and the second read decides', async () => {
  const history = scripted({ settled: false, asOf: shifted(RECEIVED, -5) }, { settled: true, asOf: shifted(RECEIVED, 1) });
  const answer = await operationLease(store, input, history.service);
  assert.equal(history.windows.length, 2);
  assert.deepEqual(history.windows[1], { key: input.key, from: CAPTURED, to: RECEIVED });
  assert.deepEqual(answer, { lease: null, lease_id: null });
});

test('a second read the lease clock still has not passed states both observed moments, not a gap it did not measure', async () => {
  const history = scripted({ settled: false, asOf: shifted(RECEIVED, -5) }, { settled: false, asOf: shifted(RECEIVED, -2) });
  const answer = await operationLease(store, input, history.service);
  assert.equal(history.windows.length, 2);
  const missing = answer.lease_unconfirmed?.missing ?? '';
  assert.match(missing, /等待 6 毫秒后重读/);
  assert.ok(missing.includes(shifted(RECEIVED, -2)) && missing.includes(shifted(RECEIVED, -5)) && missing.includes(RECEIVED), missing);
  assert.doesNotMatch(missing, /一秒以上/);
  assert.match(answer.lease_unconfirmed?.next_action ?? '', /时钟/);
  assert.match(answer.lease_unconfirmed?.next_action ?? '', /重新执行并采集这一步/);
});

test('a lease clock a second or more behind the receipt is not waited for, and the measured gap is stated', async () => {
  const history = scripted({ settled: false, asOf: shifted(RECEIVED, -1000) });
  const answer = await operationLease(store, input, history.service);
  assert.equal(history.windows.length, 1);
  assert.match(answer.lease_unconfirmed?.missing ?? '', /晚 1000 毫秒/);
});

test('a gap just under a second is still waited for', async () => {
  const history = scripted({ settled: false, asOf: shifted(RECEIVED, -999) }, { settled: true, asOf: shifted(RECEIVED, 1) });
  const answer = await operationLease(store, input, history.service);
  assert.equal(history.windows.length, 2);
  assert.equal(answer.lease_unconfirmed, undefined);
});

test('no unconfirmed answer tells the client to send the same capture again, since that reuses the unconfirmed record', async () => {
  const damaged = { digest: 'synthetic-damaged', integrity_note: 'synthetic damage', schema: 'action@1', provenance: 'observed', body: { action: 'lease' } } as unknown as StoredRecord<ActionBody>;
  const answers = [
    await operationLease(store, input),
    await operationLease(store, input, scripted({ settled: true, asOf: shifted(RECEIVED, 1), complete: false }).service),
    await operationLease(store, input, scripted({ settled: false, asOf: shifted(RECEIVED, -60_000) }).service),
    await operationLease(store, input, scripted({ settled: false, asOf: shifted(RECEIVED, -1) }).service),
    await operationLease(store, input, scripted({ settled: true, asOf: shifted(RECEIVED, 1), unattributable: [damaged] }).service),
  ];
  for (const answer of answers) {
    const text = JSON.stringify(answer.lease_unconfirmed);
    assert.ok(answer.lease_unconfirmed, JSON.stringify(answer));
    assert.doesNotMatch(text, /重传/);
    assert.match(answer.lease_unconfirmed.next_action, /沿用这条未确认记录/);
  }
});

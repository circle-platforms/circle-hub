// Synthetic journal pages only: actual timed exchanges, duplicate read wrappers, internal events and bounded scans.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RecordStore, StoredRecord } from '../records/api.ts';
import { dispatchCallTiming, readEnvironmentCalls } from './environment-statistics.ts';

const NOW = new Date('2026-11-01T12:00:00.000Z');
const source = `src:${'a'.repeat(64)}`;
function event(minutes: number, ms: number, phase: string, extra: Record<string, unknown> = {}): StoredRecord {
  const started_at = new Date(NOW.getTime() - minutes * 60_000).toISOString();
  const ended_at = new Date(Date.parse(started_at) + ms).toISOString();
  return { kind: 'action', schema: 'action@1', provenance: 'observed', id: `rcd_${'0'.repeat(26)}`, digest: 'd'.repeat(64), created_at: ended_at,
    body: { component: 'dispatch@1', action: phase.startsWith('precheck.') ? 'validate' : 'read', inputs: [source], result: 'completed', started_at, ended_at,
      detail: { job: 'synthetic-job', phase, started_at, ended_at, ...(phase.endsWith('.response') ? { source_record: `rec:${'b'.repeat(64)}`, http_status: 200 } : {}) }, ...extra } };
}
const storeOf = (records: Record<string, StoredRecord[]>): Pick<RecordStore, 'find'> => ({
  async find(query) {
    assert.equal(query.key, 'dispatch.executor');
    assert.equal(query.kind, 'action');
    const items = records[query.value] ?? [];
    const offset = Number(query.cursor ?? 0), size = 2;
    return { items: items.slice(offset, offset + size) as never[], next: offset + size < items.length ? String(offset + size) : null };
  },
});

test('each physical response is counted once, real zero-ms calls count and internal journal events do not', async () => {
  const internal = event(1, 0, 'reservation');
  (internal.body as { detail: unknown }).detail = { phase: 'reservation', job: 'synthetic-job' };
  const records = [internal, event(2, 300, 'result'), event(2, 300, 'result.response'), event(3, 0, 'status'),
    event(4, 100, 'precheck.1'), event(5, 150, 'status.response', { result: 'error' }), event(36 * 60, 10, 'status')];
  const [calls, idle] = await readEnvironmentCalls(storeOf({ busy: records }), ['busy', 'idle'], NOW);
  assert.equal(calls.calls, 4, 'the response and read wrapper describe one exchange');
  assert.deepEqual(calls.results, { completed: 3, error: 1, unknown: 0 });
  assert.equal(calls.median_ms, 100);
  assert.equal(calls.slowest_ms, 300);
  assert.equal(calls.last_at, (records[1].body as { started_at: string }).started_at);
  assert.equal(calls.partial, false);
  assert.deepEqual([idle.calls, idle.median_ms, idle.slowest_ms, idle.last_at], [0, null, null, null]);
  assert.equal(dispatchCallTiming(internal.body), null);
  assert.equal(dispatchCallTiming(event(1, -1, 'status').body), null);
});

test('the window and scan cap apply to one executor only; unreadable observations reject instead of inventing zero', async () => {
  const store = storeOf({ a: [event(1, 0, 'status'), event(2, 200, 'status'), event(3, 400, 'status')], b: [event(1, 900, 'status')] });
  const [a, b] = await readEnvironmentCalls(store, ['a', 'b'], NOW, undefined, 2);
  assert.deepEqual([a.calls, a.partial, a.median_ms, a.slowest_ms], [2, true, 100, 200]);
  assert.deepEqual([b.calls, b.partial, b.median_ms], [1, false, 900]);
  const later = new Date(NOW.getTime() + 25 * 60 * 60 * 1000);
  assert.equal((await readEnvironmentCalls(store, ['a'], later))[0].calls, 0);
  await assert.rejects(readEnvironmentCalls({ find: async () => { throw new Error('synthetic unavailable'); } }, ['a'], NOW), /synthetic unavailable/);
});

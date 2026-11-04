// The sampling loop: fields, null for what could not be read, and no failure that stops it. Clock and readings are injected.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSampler, type Reading, type SamplerOptions } from './sampler.ts';
import { emptyValues, NUMERIC_FIELDS, type ResourceSample } from './store.ts';

function harness(readings: readonly Reading[], options: Partial<SamplerOptions> = {}) {
  let at = Date.parse('2026-01-02T03:04:05.000Z');
  const written: ResourceSample[] = [];
  const logs: string[] = [];
  const sampler = createSampler({
    boot: 'boot-a',
    readings,
    write: async (sample) => {
      written.push(sample);
    },
    now: () => new Date(at),
    log: (line) => logs.push(line),
    readTimeoutMs: 20,
    writeTimeoutMs: 20,
    ...options,
  });
  return { sampler, written, logs, advance: (ms: number) => (at += ms) };
}

test('a sample has every field, with null for a reading that gave nothing and the time since the last one', async () => {
  const { sampler, written, advance } = harness([
    { name: 'memory', read: () => ({ heap_used_bytes: 1024, rss_bytes: 2048 }) },
    { name: 'io-wait', read: () => ({ io_wait_ratio: null }) },
    { name: 'connections', read: () => ({ mcp_sessions: 2, mcp_sessions_by_client: { 'client-a': 2 } }) },
  ]);
  await sampler.tick();
  advance(10_000);
  await sampler.tick();
  const [first, second] = written;
  assert.equal(first!.interval_ms, null, 'no interval before the first sample');
  assert.equal(second!.interval_ms, 10_000);
  assert.equal(first!.sampled_at, '2026-01-02T03:04:05.000Z');
  assert.equal(first!.boot, 'boot-a');
  assert.deepEqual(Object.keys(first!).sort(), [...NUMERIC_FIELDS, 'mcp_sessions_by_client', 'sampled_at', 'boot', 'interval_ms', 'failed_reads', 'dropped_samples'].sort());
  assert.equal(first!.heap_used_bytes, 1024);
  assert.equal(first!.mcp_sessions, 2);
  assert.deepEqual(first!.mcp_sessions_by_client, { 'client-a': 2 });
  assert.equal(first!.io_wait_ratio, null, 'unavailable is null');
  assert.equal(first!.event_loop_utilization, null, 'never read is null, not 0');
  assert.deepEqual(first!.failed_reads, [], 'a platform without the value is not a failure');
});

test('a reading that throws, rejects or never answers leaves its fields null, is named, and stops nothing', async () => {
  let failing = true;
  const { sampler, written } = harness([
    { name: 'sync-failure', read: () => { if (failing) throw new Error('synthetic failure'); return { pool_total: 1 }; } },
    { name: 'async-failure', read: async () => { if (failing) throw new Error('synthetic failure'); return { sandbox_running: 1 }; } },
    { name: 'memory', read: () => ({ heap_used_bytes: 1024 }) },
  ]);
  await sampler.tick();
  failing = false;
  await sampler.tick();
  assert.deepEqual(written[0]!.failed_reads, ['async-failure', 'sync-failure']);
  assert.equal(written[0]!.pool_total, null);
  assert.equal(written[0]!.sandbox_running, null);
  assert.equal(written[0]!.heap_used_bytes, 1024, 'the other readings are unaffected');
  assert.deepEqual(written[1]!.failed_reads, [], 'the next tick reads again');
  assert.equal(written[1]!.pool_total, 1);
});

test('a reading that does not answer is not started again while it is pending: a stuck source must not fill the thread pool', async () => {
  let started = 0;
  let finish: (value: { data_free_bytes: number }) => void = () => {};
  const { sampler, written } = harness([{ name: 'disk', read: () => { started += 1; return new Promise((resolve) => { finish = resolve; }); } }]);
  await sampler.tick();
  await sampler.tick();
  await sampler.tick();
  assert.equal(started, 1);
  assert.deepEqual(written.map((sample) => sample.failed_reads), [['disk'], ['disk'], ['disk']]);
  finish({ data_free_bytes: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  const last = sampler.tick();
  finish({ data_free_bytes: 2 });
  assert.equal((await last).data_free_bytes, 2, 'read again once it answered');
  assert.equal(started, 2);
});

test('a reading with a longer period runs at the first tick and then every n-th, and is null in between', async () => {
  let reads = 0;
  const { sampler, written } = harness([{ name: 'postgres', every: 3, read: () => ({ pg_waiting_locks: (reads += 1) }) }]);
  for (let index = 0; index < 7; index += 1) await sampler.tick();
  assert.deepEqual(written.map((sample) => sample.pg_waiting_locks), [1, null, null, 2, null, null, 3]);
  assert.ok(written.every((sample) => sample.failed_reads.length === 0), 'not read is not failed');
});

test('a sample that cannot be written is counted in the next one and logged, at most once a minute', async () => {
  let down = true;
  const written: ResourceSample[] = [];
  const { sampler, logs, advance } = harness([], { write: async (sample) => { if (down) throw new Error('synthetic database failure'); written.push(sample); } });
  await sampler.tick();
  advance(10_000);
  await sampler.tick();
  advance(10_000);
  down = false;
  await sampler.tick();
  advance(10_000);
  await sampler.tick();
  assert.deepEqual(written.map((sample) => sample.dropped_samples), [2, 0]);
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /资源样本写入失败.*synthetic database failure/);
});

test('a write that does not answer ends the tick; sampling goes on', async () => {
  const { sampler } = harness([], { write: () => new Promise(() => {}) });
  assert.equal((await sampler.tick()).dropped_samples, 0);
  assert.equal((await sampler.tick()).dropped_samples, 1);
});

test('what else failed since the last tick is named in the sample', async () => {
  const { sampler, written } = harness([], { otherFailures: () => ['inflight-log'] });
  await sampler.tick();
  assert.deepEqual(written[0]!.failed_reads, ['inflight-log']);
});

test('the loop ticks on its own, stops when told, and waits for the tick in progress', async () => {
  let reads = 0;
  const { sampler, written } = harness([{ name: 'memory', read: () => ({ heap_used_bytes: (reads += 1) }) }], { intervalMs: 1 });
  sampler.start();
  while (written.length < 2) await new Promise((resolve) => setTimeout(resolve, 1));
  await sampler.stop();
  const count = written.length;
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(written.length, count, 'no tick after stop');
});

test('an empty sample is all null', () => {
  const values = emptyValues();
  assert.ok(NUMERIC_FIELDS.every((field) => values[field] === null));
  assert.equal(values.mcp_sessions_by_client, null);
});

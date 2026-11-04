// The writer without a database: batches, a queue that never waits for the insert, overflow and failed batches counted,
// and what is left written when it closes.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SpanRow } from './usage.ts';
import { TraceWriter, type StoredSpanRow } from './writer.ts';

const row = (index: number): SpanRow => ({
  trace_id: 'a'.repeat(32), span_id: index.toString(16).padStart(16, '0'), parent_span_id: null, is_root: true, name: 'get_nodes', type: 'span',
  started_at: '2026-11-04T08:00:00.000Z', ended_at: '2026-11-04T08:00:00.001Z', level: 'default', status_message: null, origin: 'mcp',
  user_id: null, session_id: null, run_id: null, client_name: null, client_version: null, usage: {},
});

function writer(options: { batchRows?: number; queueRows?: number; insert?: (rows: readonly StoredSpanRow[]) => Promise<void>; log?: (line: string) => void } = {}) {
  const batches: (readonly StoredSpanRow[])[] = [];
  const instance = new TraceWriter({ insert: options.insert ?? (async (rows) => void batches.push(rows)), release: 'abcdef012345', environment: 'test', ...options });
  return { instance, batches };
}

test('a full batch is written at once, with what is the same for the whole process', async () => {
  const { instance, batches } = writer({ batchRows: 3 });
  instance.push(row(1));
  instance.push(row(2));
  assert.equal(batches.length, 0);
  instance.push(row(3));
  await instance.flush();
  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0].map((stored) => [stored.span_id.slice(-1), stored.release, stored.environment]), [['1', 'abcdef012345', 'test'], ['2', 'abcdef012345', 'test'], ['3', 'abcdef012345', 'test']]);
  assert.deepEqual(instance.stats(), { queued: 0, written: 3, dropped: 0, failed: 0 });
});

test('pushing never waits for the insert, and a full queue drops, counts and says so', async () => {
  let release = (): void => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  let inserted = 0;
  const lines: string[] = [];
  const { instance } = writer({ batchRows: 2, queueRows: 4, log: (line) => lines.push(line), insert: async (rows) => { await held; inserted += rows.length; } });
  for (let index = 0; index < 2; index++) instance.push(row(index));
  // The first batch is held inside the insert: everything below only touches the queue, synchronously.
  for (let index = 2; index < 12; index++) instance.push(row(index));
  assert.deepEqual(instance.stats(), { queued: 4, written: 0, dropped: 6, failed: 0 });
  assert.equal(lines.length, 1, 'the operator hears about it, not once per row');
  assert.match(lines[0], /队列已满/);
  release();
  await instance.flush();
  assert.equal(inserted, 6);
  assert.deepEqual(instance.stats(), { queued: 0, written: 6, dropped: 6, failed: 0 });
});

test('a batch the database refuses is counted, tried no further and reported once, without its rows', async () => {
  const lines: string[] = [];
  let calls = 0;
  const { instance } = writer({
    batchRows: 2,
    log: (line) => lines.push(line),
    insert: async (rows) => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error(`invalid value ${JSON.stringify(rows)}`), { code: '22P02' });
    },
  });
  for (let index = 0; index < 4; index++) instance.push(row(index));
  await instance.flush();
  assert.deepEqual(instance.stats(), { queued: 2, written: 0, dropped: 0, failed: 2 }, 'the round ended; the rest waits for the next one');
  await instance.flush();
  assert.deepEqual(instance.stats(), { queued: 0, written: 2, dropped: 0, failed: 2 });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /22P02/);
  assert.ok(!lines[0].includes('a'.repeat(32)), 'the message of a refused statement can quote a row');
});

test('a failing log never reaches the caller', async () => {
  const { instance } = writer({ insert: async () => { throw new Error('down'); }, log: () => { throw new Error('log failed'); } });
  instance.push(row(1));
  await instance.flush();
  assert.equal(instance.stats().failed, 1);
});

test('close writes what is left, a write under way included, and takes no more rows', async () => {
  let release = (): void => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  let first = true;
  const inserted: string[] = [];
  const { instance } = writer({ batchRows: 1, insert: async (rows) => { if (first) { first = false; await held; } inserted.push(...rows.map((stored) => stored.span_id.slice(-1))); } });
  instance.push(row(1));
  instance.push(row(2));
  const closed = instance.close();
  instance.push(row(3));
  release();
  await closed;
  assert.deepEqual(inserted, ['1', '2']);
  assert.deepEqual(instance.stats(), { queued: 0, written: 2, dropped: 1, failed: 0 });
});

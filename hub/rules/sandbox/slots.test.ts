// The slot pool's read-only numbers, which the Hub's resource sampling reports.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSlotPool } from './slots.ts';

test('stats say what runs and waits, and count the calls a full line refused', async () => {
  const pool = createSlotPool({ running: 1, waiting: 1, full: () => new Error('full') });
  assert.deepEqual(pool.stats(), { running: 0, limit: 1, waiting: 0, queueFull: 0 });
  let finish: () => void = () => {};
  const first = pool.run(() => new Promise<void>((resolve) => { finish = resolve; }));
  const second = pool.run(async () => {});
  assert.deepEqual(pool.stats(), { running: 1, limit: 1, waiting: 1, queueFull: 0 });
  await assert.rejects(pool.run(async () => {}), /full/);
  await assert.rejects(pool.run(async () => {}), /full/);
  assert.deepEqual(pool.stats(), { running: 1, limit: 1, waiting: 1, queueFull: 2 });
  finish();
  await Promise.all([first, second]);
  assert.deepEqual(pool.stats(), { running: 0, limit: 1, waiting: 0, queueFull: 2 }, 'refusals stay counted');
});

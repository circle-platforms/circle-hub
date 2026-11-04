// The counters of a pool, which the Hub's resource sampling reports (hub/health).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openTestRecords } from '../testing/records.ts';
import { Database, createPool } from './db.ts';

test('a pool reports what it holds, who waits for it, and the connections that could not be opened', async (t) => {
  const kit = await openTestRecords();
  t.after(() => kit.close());
  const first = kit.poolStats!();
  assert.deepEqual(Object.keys(first).sort(), ['connectionFailures', 'idle', 'limit', 'total', 'waiting']);

  const db = new Database(createPool(kit.database, 1));
  t.after(() => db.end());
  assert.deepEqual({ ...db.stats(), connectionFailures: 0 }, { limit: 1, total: 0, idle: 0, waiting: 0, connectionFailures: 0 });
  await db.query('SELECT 1');
  assert.deepEqual({ ...db.stats(), connectionFailures: 0 }, { limit: 1, total: 1, idle: 1, waiting: 0, connectionFailures: 0 });
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  const busy = db.transaction(async () => { await held; });
  while (db.stats().idle > 0) await new Promise((resolve) => setImmediate(resolve));
  const queued = db.query('SELECT 1');
  assert.equal(db.stats().waiting, 1);
  release();
  await Promise.all([busy, queued]);

  const failures = db.stats().connectionFailures;
  const unreachable = new Database(createPool({ ...kit.database, database: 'no_such_database' }, 1));
  t.after(() => unreachable.end());
  await assert.rejects(unreachable.query('SELECT 1'));
  await assert.rejects(unreachable.query('SELECT 1'));
  assert.equal(unreachable.stats().connectionFailures, failures + 2);
  assert.equal(unreachable.stats().total, 0, 'a connection that failed is not held');
  assert.equal(kit.poolStats!().connectionFailures, failures + 2, 'counted for the process, whichever pool failed');
});

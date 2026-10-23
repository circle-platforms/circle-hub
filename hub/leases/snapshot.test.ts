import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LeaseService } from './api.ts';
import { createPool, Database } from '../records/db.ts';
import { openTestRecords } from '../testing/records.ts';
import { newId } from '../records/api.ts';

test('holder snapshots expose current fences read-only, including release and takeover', async t => {
  const kit = await openTestRecords(); t.after(() => kit.close());
  const db = new Database(createPool(kit.database, 2)); t.after(() => db.end());
  const now = new Date('2026-10-23T00:00:00.000Z');
  const leases = new LeaseService(db, { now: async () => now });
  const holder = { user: newId('usr'), run: newId('run') };
  const first = await leases.acquire({ keys: ['synthetic/a'], holder, prefix: 'synthetic/', ttlSeconds: 300, maxTtlSeconds: 600 });
  assert.ok(first.ok);
  const before = await leases.holderSnapshot(['synthetic/a', 'synthetic/missing']);
  assert.equal(before.length, 1);
  assert.deepEqual([before[0].lease, before[0].fencing, before[0].released, before[0].user, before[0].run], [first.lease, first.token, false, holder.user, holder.run]);
  await leases.forceRelease({ keys: ['synthetic/a'], by: holder.user, reason: '合成强制释放' });
  const released = await leases.holderSnapshot(['synthetic/a']);
  assert.equal(released[0].released, true); assert.ok(released[0].fencing > before[0].fencing);
  const second = await leases.acquire({ keys: ['synthetic/a'], holder, prefix: 'synthetic/', ttlSeconds: 300, maxTtlSeconds: 600 });
  assert.ok(second.ok);
  assert.notEqual((await leases.holderSnapshot(['synthetic/a']))[0].lease, before[0].lease);
  assert.equal(before[0].released, false);
});

test('new lease actions round-trip through records integrity checks', async t => {
  const kit = await openTestRecords(); t.after(() => kit.close());
  const db = new Database(createPool(kit.database, 2)); t.after(() => db.end());
  const leases = new LeaseService(db, { now: async () => new Date('2026-10-23T00:00:00.000Z') });
  const holder = { user: newId('usr'), run: newId('run') };
  assert.ok((await leases.acquire({ keys: ['synthetic/audit'], holder, prefix: 'synthetic/', ttlSeconds: 300, maxTtlSeconds: 600 })).ok);
  assert.ok((await leases.release({ keys: ['synthetic/audit'], holder })).ok);
  const records = await kit.store.list({ kind: 'action', limit: 500 });
  assert.equal(records.items.length, 2);
  for (const record of records.items) assert.deepEqual(await kit.store.get(record.digest), record);
});

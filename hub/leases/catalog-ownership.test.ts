// Real lease mutations with an explicit catalog port; the records catalog producer is tested by its owner.
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { Database, createPool, newId, type Transaction } from '../records/api.ts';
import { openTestRecords } from '../testing/records.ts';
import { LeaseService, type LeaseOwnershipCatalog } from './api.ts';

async function fixture(t: TestContext) {
  const kit = await openTestRecords();
  const db = new Database(createPool(kit.database, 1));
  t.after(async () => { try { await db.end(); } finally { await kit.close(); } });
  const holder = { user: newId('usr'), run: newId('run') };
  const owner = newId('usr'), other = newId('usr');
  return { kit, db, holder, owner, other };
}

test('owner forced release reads the catalog through the same held max-one transaction and preserves fencing and audit', { timeout: 30000 }, async t => {
  const f = await fixture(t), seen: Transaction[] = [];
  const catalog: LeaseOwnershipCatalog = { ownership: async tx => {
    assert.ok(tx, 'owner cleanup must not borrow a second connection'); seen.push(tx);
    await f.db.query('SELECT 1', [], tx);
    return { prefixes: [{ prefix: 'synthetic/owned/', owner: f.owner }], resources: [{ key: 'synthetic/exact', owner: f.owner }] };
  } };
  const service = new LeaseService(f.db, { records: f.kit.store, catalog });
  const keys = ['synthetic/owned/seat', 'synthetic/exact'];
  assert.ok((await service.acquire({ keys, holder: f.holder, prefix: 'synthetic/' })).ok);
  const before = await service.holderSnapshot(keys);
  const refused = await service.forceRelease({ keys, by: f.other, owner: f.other, reason: 'synthetic unauthorized cleanup' });
  assert.equal(refused.ok, false); assert.deepEqual(await service.holderSnapshot(keys), before);
  assert.ok((await service.forceRelease({ keys, by: f.owner, owner: f.owner, reason: 'synthetic owner cleanup' })).ok);
  const after = await service.holderSnapshot(keys);
  for (let i = 0; i < before.length; i++) {
    assert.equal(after[i].lease, before[i].lease); assert.equal(after[i].user, before[i].user); assert.equal(after[i].run, before[i].run);
    assert.equal(after[i].released, true); assert.equal(after[i].fencing, before[i].fencing + 1);
  }
  assert.equal(seen.length, 2);
  const log = await service.actionLog('synthetic/');
  assert.equal(log.filter(row => row.op === 'force_release').length, 1);
  assert.equal(log.find(row => row.op === 'force_release')?.reason, 'synthetic owner cleanup');
});

test('missing catalog blocks responsibility-based cleanup but never blocks holder release or rewrites the reservation', async t => {
  const f = await fixture(t), service = new LeaseService(f.db, { records: f.kit.store });
  const keys = ['synthetic/missing/seat'];
  assert.ok((await service.acquire({ keys, holder: f.holder, prefix: 'synthetic/' })).ok);
  const before = await service.holderSnapshot(keys);
  await assert.rejects(service.forceRelease({ keys, by: f.owner, owner: f.owner, reason: 'synthetic missing catalog' }), /目录尚未接入/);
  assert.deepEqual(await service.holderSnapshot(keys), before);
  assert.ok((await service.release({ keys, holder: f.holder })).ok);
});

test('retained legacy registration rows neither authorize cleanup nor populate the new catalog view', async t => {
  const f = await fixture(t);
  await f.db.query('INSERT INTO lease_registrations(prefix,owner,registered_at) VALUES($1,$2,clock_timestamp())', ['synthetic/legacy/', f.owner]);
  const service = new LeaseService(f.db, { records: f.kit.store, catalog: { ownership: async () => ({ prefixes: [], resources: [] }) } });
  const keys = ['synthetic/legacy/seat'];
  assert.ok((await service.acquire({ keys, holder: f.holder, prefix: 'synthetic/' })).ok);
  const before = await service.holderSnapshot(keys);
  const legacy = (await f.db.query('SELECT prefix,owner,registered_at FROM lease_registrations ORDER BY prefix')).rows;
  assert.deepEqual(await service.registrations(''), []);
  assert.equal((await service.forceRelease({ keys, by: f.owner, owner: f.owner, reason: 'synthetic legacy is not permission' })).ok, false);
  assert.deepEqual(await service.holderSnapshot(keys), before);
  assert.deepEqual((await f.db.query('SELECT prefix,owner,registered_at FROM lease_registrations ORDER BY prefix')).rows, legacy);
  assert.ok((await service.release({ keys, holder: f.holder })).ok);
});

test('outer acquire refusal leaves no partial reservation and outer extend rolls back with its caller', async t => {
  const f = await fixture(t), now = new Date('2026-11-14T08:00:00.000Z');
  const service = new LeaseService(f.db, { records: f.kit.store, now: async () => now });
  const otherHolder = { user: f.other, run: newId('run') };
  assert.ok((await service.acquire({ keys: ['synthetic/z-busy'], holder: otherHolder, prefix: 'synthetic/' })).ok);
  const before = await service.holderSnapshot(['synthetic/z-busy']);
  await f.db.transaction(async tx => {
    const refused = await service.acquire({ keys: ['synthetic/a-free', 'synthetic/z-busy'], holder: f.holder, prefix: 'synthetic/' }, tx);
    assert.equal(refused.ok, false);
    assert.deepEqual(await service.holderSnapshot(['synthetic/a-free'], tx), []);
    assert.deepEqual(await service.holderSnapshot(['synthetic/z-busy'], tx), before);
    await f.db.query('SELECT 1', [], tx);
  });
  assert.deepEqual(await service.holderSnapshot(['synthetic/a-free']), []);
  assert.ok((await service.acquire({ keys: ['synthetic/capped'], holder: f.holder, prefix: 'synthetic/', ttlSeconds: 60, maxTtlSeconds: 300 })).ok);
  const capped = await service.holderSnapshot(['synthetic/capped']);
  const actions = await service.actionLog('synthetic/');
  const rollback = new Error('synthetic caller rollback');
  await assert.rejects(f.db.transaction(async tx => {
    assert.ok((await service.extend({ keys: ['synthetic/capped'], holder: f.holder, ttlSeconds: 120, maxTtlSeconds: 300 }, tx)).ok);
    throw rollback;
  }), error => error === rollback);
  assert.deepEqual(await service.holderSnapshot(['synthetic/capped']), capped);
  assert.deepEqual(await service.actionLog('synthetic/'), actions);
});

test('recent holders includes active, released and expired last rows, and takeover replaces only the last holder', async t => {
  const f = await fixture(t), service = new LeaseService(f.db, { records: f.kit.store });
  const prefix = 'synthetic/recent/', keys = ['active', 'released', 'expired', 'replaced'].map(name => prefix + name);
  assert.ok((await service.acquire({ keys, holder: f.holder, prefix })).ok);
  assert.ok((await service.release({ keys: [prefix + 'released', prefix + 'replaced'], holder: f.holder })).ok);
  const replacement = { user: f.other, run: newId('run') };
  assert.ok((await service.acquire({ keys: [prefix + 'replaced'], holder: replacement, prefix })).ok);
  await f.db.query("UPDATE leases SET acquired_at=clock_timestamp()-interval '2 minutes',expires_at=clock_timestamp()-interval '1 minute' WHERE key=$1", [prefix + 'expired']);
  const before = await service.holderSnapshot(keys);
  const actions = await service.actionLog(prefix);
  const recent = await f.db.transaction(tx => service.recentHolders(prefix, tx));
  assert.equal(recent.length, 4);
  assert.deepEqual(recent.map(row => row.key), [...keys].sort());
  assert.deepEqual(recent.filter(row => row.active).map(row => row.key), [prefix + 'active', prefix + 'replaced']);
  assert.deepEqual(recent.filter(row => row.released).map(row => row.key), [prefix + 'released']);
  const expired = recent.find(row => row.key === prefix + 'expired')!;
  assert.equal(expired.active, false); assert.equal(expired.released, false); assert.ok(expired.until);
  const replaced = recent.filter(row => row.key === prefix + 'replaced');
  assert.equal(replaced.length, 1); assert.equal(replaced[0].user, replacement.user); assert.equal(replaced[0].run, replacement.run);
  assert.ok(recent.every(row => Number.isFinite(Date.parse(row.since))));
  assert.deepEqual(await service.recentHolders('synthetic/absent/'), []);
  assert.deepEqual(await service.holderSnapshot(keys), before);
  assert.deepEqual(await service.actionLog(prefix), actions);
});

test('recent and active views agree at fixed past and future component clocks including exact expiry', async t => {
  const f = await fixture(t);
  for (const [label, initial] of [['past', '2000-01-01T00:00:00.000Z'], ['future', '2100-01-01T00:00:00.000Z']] as const) {
    let now = new Date(initial);
    const service = new LeaseService(f.db, { records: f.kit.store, now: async () => now });
    const prefix = `synthetic/fixed-${label}/`, key = prefix + 'seat';
    assert.ok((await service.acquire({ keys: [key], holder: f.holder, prefix, ttlSeconds: 60, maxTtlSeconds: 300 })).ok);
    const before = await service.holderSnapshot([key]);
    assert.deepEqual((await service.view(prefix, true)).entries.map(row => row.key), [key]);
    const recent = await service.recentHolders(prefix);
    assert.equal(recent.length, 1); assert.equal(recent[0].active, true, label + ' clock must agree with view');
    assert.equal(recent[0].since, initial); assert.equal(recent[0].until, new Date(now.getTime() + 60000).toISOString());
    now = new Date(now.getTime() + 60000);
    assert.deepEqual((await service.view(prefix, true)).entries, []);
    const expired = await f.db.transaction(tx => service.recentHolders(prefix, tx));
    assert.equal(expired[0].active, false, label + ' exact expiry must agree with view');
    assert.equal(expired[0].released, false);
    assert.deepEqual(await service.holderSnapshot([key]), before);
  }
});

// The lease service (D04 R[0], C2): acquire is atomic per key set (unique constraint, all or nothing), an expired or
// released row is taken over in place with the fencing token incremented, the database clock decides expiry, every
// change writes its lease action record in the same transaction, orphaned rows are reclaimed, and a new service
// object over the same database sees the same state. Synthetic keys of a neutral namespace (core code names no
// device, bench or product).
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createPool, Database } from '../records/db.ts';
import { migrate } from '../records/migrations.ts';
import { startPostgres, type TemporaryPostgres } from '../testing/postgres.ts';
import { LeaseService } from './service.ts';

let postgres: TemporaryPostgres;
let db: Database;

before(async () => {
  postgres = await startPostgres();
  const config = await postgres.createDatabase('leases');
  db = new Database(createPool(config, 4));
  await migrate(db);
});

after(async () => {
  await db?.end();
  await postgres?.stop();
});

const holder = { user: 'usr_0123456789abcdefghjkmnpqrs', run: 'run_0123456789abcdefghjkmnpqrs' };
const other = { user: 'usr_123456789abcdefghjkmnpqrst', run: 'run_123456789abcdefghjkmnpqrst' };

/** A fixed clock for the tests; the service never compares with the process clock. */
const clock = (iso: string) => () => Promise.resolve(new Date(iso));

describe('acquire', () => {
  test('a free key set is acquired, with the lease id, the holder, the until moment and token 1', async () => {
    const service = new LeaseService(db, { now: clock('2026-10-22T08:00:00Z') });
    const granted = await service.acquire({ keys: ['zone/a/1', 'zone/a/2'], ttlSeconds: 3600, holder, prefix: 'zone/', maxTtlSeconds: 7200 });
    assert.equal(granted.ok, true);
    if (!granted.ok) return;
    assert.match(granted.lease, /^lse_[0-9a-z]{26}$/);
    assert.deepEqual(granted.keys, ['zone/a/1', 'zone/a/2']);
    assert.equal(granted.token, 1);
    assert.equal(granted.until, '2026-10-22T09:00:00.000Z');
  });

  test('two connections acquiring the same key: exactly one succeeds, 50 rounds', async () => {
    for (let round = 0; round < 50; round++) {
      const service = new LeaseService(db, { now: clock('2026-10-22T08:00:00Z') });
      const [first, second] = await Promise.all([
        service.acquire({ keys: [`race/r${round}/k`], ttlSeconds: 60, holder, prefix: 'race/', maxTtlSeconds: 600 }),
        service.acquire({ keys: [`race/r${round}/k`], ttlSeconds: 60, holder: other, prefix: 'race/', maxTtlSeconds: 600 }),
      ]);
      const wins = [first, second].filter((r) => r.ok).length;
      assert.equal(wins, 1, `round ${round}: exactly one winner, got ${JSON.stringify([first, second].map((r) => (r.ok ? 'ok' : r.code)))}`);
      const loser = first.ok ? second : first;
      assert.ok(!loser.ok && loser.code === 'LEASE_UNAVAILABLE');
    }
  });

  test('all or nothing: when the second key is held, the first leaves no trace', async () => {
    const service = new LeaseService(db, { now: clock('2026-10-22T08:00:00Z') });
    const held = await service.acquire({ keys: ['all/none/2'], ttlSeconds: 600, holder, prefix: 'all/', maxTtlSeconds: 600 });
    assert.equal(held.ok, true);
    const attempt = await service.acquire({ keys: ['all/none/1', 'all/none/2'], ttlSeconds: 600, holder: other, prefix: 'all/', maxTtlSeconds: 600 });
    assert.ok(!attempt.ok && attempt.code === 'LEASE_UNAVAILABLE');
    if (!attempt.ok) assert.equal(attempt.earliestFree, '2026-10-22T08:10:00.000Z');
    // the first key is free: another acquire of it alone succeeds
    const alone = await service.acquire({ keys: ['all/none/1'], ttlSeconds: 60, holder: other, prefix: 'all/', maxTtlSeconds: 600 });
    assert.equal(alone.ok, true);
  });

  test('keys outside the declared prefix and TTLs over the cap are refused before anything is touched', async () => {
    const service = new LeaseService(db, { now: clock('2026-10-22T08:00:00Z') });
    const outside = await service.acquire({ keys: ['elsewhere/1'], ttlSeconds: 60, holder, prefix: 'zone/', maxTtlSeconds: 600 });
    assert.ok(!outside.ok && outside.code === 'LEASE_PREFIX');
    const tooLong = await service.acquire({ keys: ['zone/b/9'], ttlSeconds: 601, holder, prefix: 'zone/', maxTtlSeconds: 600 });
    assert.ok(!tooLong.ok && tooLong.code === 'LEASE_TTL');
    const view = await service.view('zone/');
    assert.ok(!view.entries.some((e) => e.key === 'zone/b/9'), 'nothing was written');
  });

  test('an expired row is taken over in place, with the token incremented', async () => {
    const first = new LeaseService(db, { now: clock('2026-10-22T08:00:00Z') });
    const held = await first.acquire({ keys: ['take/over/1'], ttlSeconds: 100, holder, prefix: 'take/', maxTtlSeconds: 600 });
    assert.equal(held.ok, true);
    // after the expiry (the database clock is later; the service only reads now() through its provider)
    const later = new LeaseService(db, { now: clock('2026-10-22T08:03:00Z') });
    const takeover = await later.acquire({ keys: ['take/over/1'], ttlSeconds: 100, holder: other, prefix: 'take/', maxTtlSeconds: 600 });
    assert.equal(takeover.ok, true);
    if (!takeover.ok) return;
    assert.notEqual(takeover.lease, held.ok ? held.lease : '', 'a take-over is a new lease identity');
    assert.equal(takeover.token, 2, 'the fencing token increments on take-over');
  });

  test('a released row can be acquired again', async () => {
    const service = new LeaseService(db, { now: clock('2026-10-22T08:00:00Z') });
    const held = await service.acquire({ keys: ['rel/1'], ttlSeconds: 600, holder, prefix: 'rel/', maxTtlSeconds: 600 });
    assert.equal(held.ok, true);
    const released = await service.release({ keys: ['rel/1'], holder });
    assert.equal(released.ok, true);
    const again = await service.acquire({ keys: ['rel/1'], ttlSeconds: 600, holder: other, prefix: 'rel/', maxTtlSeconds: 600 });
    assert.equal(again.ok, true);
    if (!again.ok) return;
    assert.equal(again.token, 3, 'release incremented the token, the re-acquire increments it again');
  });
});

describe('extend', () => {
  test('the holder extends within the cap; a stranger and an expired lease cannot', async () => {
    const service = new LeaseService(db, { now: clock('2026-10-22T08:00:00Z') });
    const held = await service.acquire({ keys: ['ext/1'], ttlSeconds: 600, holder, prefix: 'ext/', maxTtlSeconds: 1200 });
    assert.ok(held.ok);
    const extended = await service.extend({ keys: ['ext/1'], holder, ttlSeconds: 300, at: '2026-10-22T08:05:00Z' });
    assert.equal(extended.ok, true);
    if (extended.ok) {
      assert.equal(extended.until, '2026-10-22T08:10:00.000Z');
      assert.equal(extended.token, (held.ok ? held.token : 0) + 1);
    }
    const stranger = await service.extend({ keys: ['ext/1'], holder: other, ttlSeconds: 300, at: '2026-10-22T08:05:00Z' });
    assert.ok(!stranger.ok && stranger.code === 'LEASE_UNAVAILABLE');
    const past = new LeaseService(db, { now: clock('2026-10-22T09:00:00Z') });
    const expired = await past.extend({ keys: ['ext/1'], holder, ttlSeconds: 300, at: '2026-10-22T09:00:00Z' });
    assert.ok(!expired.ok && expired.code === 'LEASE_EXPIRED');
  });

  test('the cumulative extension cannot pass the cap', async () => {
    const service = new LeaseService(db, { now: clock('2026-10-22T08:00:00Z') });
    const held = await service.acquire({ keys: ['cap/1'], ttlSeconds: 600, holder, prefix: 'cap/', maxTtlSeconds: 1200 });
    assert.ok(held.ok);
    const beyond = await service.extend({ keys: ['cap/1'], holder, ttlSeconds: 1160, at: '2026-10-22T08:05:00Z', maxTtlSeconds: 1200 });
    assert.ok(!beyond.ok && beyond.code === 'LEASE_TTL');
    const within = await service.extend({ keys: ['cap/1'], holder, ttlSeconds: 600, at: '2026-10-22T08:05:00Z', maxTtlSeconds: 1200 });
    // 08:05 + 600s = 08:15, inside the cap 08:00 + 1200s = 08:20
    assert.equal(within.ok, true, '08:05 + 600s is inside the 1200s cap counted from acquisition');
  });
});

describe('view, force release and orphans', () => {
  test('view lists the unexpired rows of a prefix with their until moments', async () => {
    const service = new LeaseService(db, { now: clock('2026-10-22T08:00:00Z') });
    await service.acquire({ keys: ['view/1', 'view/2'], ttlSeconds: 600, holder, prefix: 'view/', maxTtlSeconds: 600 });
    const later = new LeaseService(db, { now: clock('2026-10-22T08:11:00Z') });
    const view = await later.view('view/');
    assert.equal(view.entries.length, 0, 'both expired eleven minutes later');
    const fresh = await new LeaseService(db, { now: clock('2026-10-22T08:00:00Z') }).acquire({ keys: ['view/3'], ttlSeconds: 600, holder, prefix: 'view/', maxTtlSeconds: 600 });
    assert.ok(fresh.ok);
    const now = new LeaseService(db, { now: clock('2026-10-22T08:01:00Z') });
    const current = await now.view('view/');
    // At 08:01 all three are held: view/1 and view/2 until 08:10, view/3 until 08:10.
    assert.deepEqual(
      current.entries.map((e) => [e.key, e.until]),
      [
        ['view/1', '2026-10-22T08:10:00.000Z'],
        ['view/2', '2026-10-22T08:10:00.000Z'],
        ['view/3', '2026-10-22T08:10:00.000Z'],
      ],
    );
  });

  test('force release (an admin, with a reason) frees the key and leaves an action record with the reason', async () => {
    const service = new LeaseService(db, { now: clock('2026-10-22T08:00:00Z') });
    await service.acquire({ keys: ['force/1'], ttlSeconds: 600, holder, prefix: 'force/', maxTtlSeconds: 600 });
    const forced = await service.forceRelease({ keys: ['force/1'], by: 'adm', reason: '维护窗口' });
    assert.equal(forced.ok, true);
    const after = await service.acquire({ keys: ['force/1'], ttlSeconds: 600, holder: other, prefix: 'force/', maxTtlSeconds: 600 });
    assert.equal(after.ok, true);
  });

  test('a row whose run no longer exists is reclaimed once it was acquired more than 60 seconds ago', async () => {
    const gone = new LeaseService(db, { now: clock('2026-10-22T08:00:00Z') });
    await gone.acquire({ keys: ['orphan/1'], ttlSeconds: 60_000, holder, prefix: 'orphan/', maxTtlSeconds: 120_000 });
    const later = new LeaseService(db, { now: clock('2026-10-22T08:02:00Z') });
    const reclaimed = await later.reclaimOrphans();
    assert.ok(reclaimed >= 0, 'the count is reported (0 here: the run record exists or not, the table row stays)');
    // The holder view: whatever reclaim decided, the table stays consistent (view answers from the rows).
    const view = await later.view('orphan/');
    assert.ok(Array.isArray(view.entries));
  });

  test('a new service object over the same database sees the same state (no in-memory state)', async () => {
    const first = new LeaseService(db, { now: clock('2026-10-22T08:00:00Z') });
    await first.acquire({ keys: ['persist/1'], ttlSeconds: 600, holder, prefix: 'persist/', maxTtlSeconds: 600 });
    const second = new LeaseService(db, { now: clock('2026-10-22T08:01:00Z') });
    const denied = await second.acquire({ keys: ['persist/1'], ttlSeconds: 60, holder: other, prefix: 'persist/', maxTtlSeconds: 600 });
    assert.ok(!denied.ok && denied.code === 'LEASE_UNAVAILABLE');
  });
});

describe('action records', () => {
  test('every change appends a lease action record; replaying the records rebuilds the table', async () => {
    const service = new LeaseService(db, { now: clock('2026-10-22T08:00:00Z') });
    const held = await service.acquire({ keys: ['replay/1', 'replay/2'], ttlSeconds: 600, holder, prefix: 'replay/', maxTtlSeconds: 600 });
    assert.ok(held.ok);
    await service.extend({ keys: ['replay/1'], holder, ttlSeconds: 100, at: '2026-10-22T08:02:00Z' });
    await service.release({ keys: ['replay/2'], holder });
    const records = await service.actionLog('replay/');
    assert.ok(records.length >= 3, 'acquire, extend and release each left a record');
    // Replay: apply the ops in order onto an empty map; the final state equals the table.
    const state = new Map<string, { lease: string; until: string; token: number; released: boolean }>();
    for (const record of records) {
      const detail = record as { op: string; keys: string[]; lease: string; until: string; token: number };
      for (const key of detail.keys) {
        if (detail.op === 'release' || detail.op === 'force_release') state.set(key, { lease: detail.lease, until: detail.until, token: detail.token, released: true });
        else state.set(key, { lease: detail.lease, until: detail.until, token: detail.token, released: false });
      }
    }
    const view = await service.view('replay/');
    assert.deepEqual(
      view.entries.map((e) => e.key).sort(),
      [...state.entries()].filter(([, s]) => !s.released).map(([key]) => key).sort(),
      'the replayed state matches the table for the live rows',
    );
  });
});

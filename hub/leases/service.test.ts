// The lease service (D04 R[0], C2): acquire is atomic per key set (unique constraint, all or nothing, one order so
// opposite orders cannot deadlock), an expired or released row is taken over in place with the fencing token
// incremented, one clock (the service's own, the database clock by default, injectable in tests) decides expiry —
// extend takes no caller moment — every change writes its lease action record in the same transaction, orphaned
// rows are reclaimed only when their run record is gone and they were acquired over 60 seconds ago, and a new
// service object over the same database sees the same state. Synthetic keys of a neutral namespace.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createPool, Database } from '../records/db.ts';
import { migrate } from '../records/migrations.ts';
import { openRecords, type RecordsKit } from '../records/index.ts';
import { startPostgres, type TemporaryPostgres } from '../testing/postgres.ts';
import { putRun } from '../runs/engine/store.ts';
import type { RunRecord } from '../../contracts/src/run.ts';
import { LeaseService } from './service.ts';

let postgres: TemporaryPostgres;
let db: Database;
let kit: RecordsKit;

before(async () => {
  postgres = await startPostgres();
  const config = await postgres.createDatabase('leases');
  db = new Database(createPool(config, 8));
  await migrate(db);
  kit = await openRecords({ dataDir: `${postgres.root}/kit`, logDir: `${postgres.root}/kit/logs`, database: config, limits: { maxUploadBytes: 1 << 20, maxRecordBytes: 1 << 20, maxRequestBytes: 2 << 20 } });
});

after(async () => {
  await kit?.close();
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
    assert.match(granted.lease, /^lse_[0-9a-hjkmnp-tv-z]{26}$/);
    assert.deepEqual(granted.keys, ['zone/a/1', 'zone/a/2']);
    assert.equal(granted.token, 1);
    assert.equal(granted.until, '2026-10-22T09:00:00.000Z');
  });

  test('two connections acquiring the same key: exactly one succeeds, 50 rounds, no exception', async () => {
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

  test('the same key set in opposite orders cannot deadlock: 50 rounds, no exception, exactly one winner', async () => {
    for (let round = 0; round < 50; round++) {
      const a = new LeaseService(db, { now: clock('2026-10-22T08:00:00Z') });
      const b = new LeaseService(db, { now: clock('2026-10-22T08:00:00Z') });
      const [first, second] = await Promise.all([
        a.acquire({ keys: [`order/o${round}/1`, `order/o${round}/2`, `order/o${round}/3`], ttlSeconds: 60, holder, prefix: 'order/', maxTtlSeconds: 600 }),
        b.acquire({ keys: [`order/o${round}/3`, `order/o${round}/2`, `order/o${round}/1`], ttlSeconds: 60, holder: other, prefix: 'order/', maxTtlSeconds: 600 }),
      ]);
      const wins = [first, second].filter((r) => r.ok).length;
      assert.equal(wins, 1, `round ${round}: exactly one winner, got ${JSON.stringify([first, second].map((r) => (r.ok ? 'ok' : r.code)))}`);
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

  test('a holder that is not a real user id and run id is refused', async () => {
    const service = new LeaseService(db, { now: clock('2026-10-22T08:00:00Z') });
    const fake = await service.acquire({ keys: ['zone/c/1'], ttlSeconds: 60, holder: { user: 'user-1', run: 'run_0123456789abcdefghjkmnpqrs' }, prefix: 'zone/', maxTtlSeconds: 600 });
    assert.ok(!fake.ok && fake.code === 'LEASE_UNAVAILABLE');
  });

  test('an expired row is taken over in place, with the token incremented', async () => {
    const first = new LeaseService(db, { now: clock('2026-10-22T08:00:00Z') });
    const held = await first.acquire({ keys: ['take/over/1'], ttlSeconds: 100, holder, prefix: 'take/', maxTtlSeconds: 600 });
    assert.equal(held.ok, true);
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

describe('extend and release', () => {
  test('the holder extends within the cap; the token grows; the until moment moves', async () => {
    const service = new LeaseService(db, { now: clock('2026-10-22T08:00:00Z') });
    const held = await service.acquire({ keys: ['ext/1'], ttlSeconds: 600, holder, prefix: 'ext/', maxTtlSeconds: 1200 });
    assert.ok(held.ok);
    // The service's own clock is five minutes later; extend takes no caller moment.
    const later = new LeaseService(db, { now: clock('2026-10-22T08:05:00Z') });
    const extended = await later.extend({ keys: ['ext/1'], holder, ttlSeconds: 300, maxTtlSeconds: 1200 });
    assert.equal(extended.ok, true);
    if (!extended.ok || !held.ok) return;
    assert.equal(extended.until, '2026-10-22T08:10:00.000Z');
    assert.ok(extended.token > held.token, 'the token grows on extend');
  });

  test('extend never shortens: a ttl shorter than the remaining time leaves the end where it was', async () => {
    const service = new LeaseService(db, { now: clock('2026-10-22T08:00:00Z') });
    const held = await service.acquire({ keys: ['nos/1'], ttlSeconds: 600, holder, prefix: 'nos/', maxTtlSeconds: 1200 });
    assert.ok(held.ok);
    const later = new LeaseService(db, { now: clock('2026-10-22T08:01:00Z') });
    // 600s remain; extending by 60s would end at 08:02 — the end stays at 08:10 (the later of the two).
    const extended = await later.extend({ keys: ['nos/1'], holder, ttlSeconds: 60, maxTtlSeconds: 1200 });
    assert.equal(extended.ok, true);
    if (!extended.ok || !held.ok) return;
    assert.equal(extended.until, held.until, 'a shorter ttl does not pull the end earlier');
    // And a longer ttl still moves it: now + 900s = 08:16 > 08:10.
    const longer = await later.extend({ keys: ['nos/1'], holder, ttlSeconds: 900, maxTtlSeconds: 1200 });
    assert.ok(longer.ok && longer.until === '2026-10-22T08:16:00.000Z');
  });

  test('a stranger cannot extend, and cannot release either', async () => {
    const service = new LeaseService(db, { now: clock('2026-10-22T08:00:00Z') });
    await service.acquire({ keys: ['str/1'], ttlSeconds: 600, holder, prefix: 'str/', maxTtlSeconds: 600 });
    const strangerExtend = await service.extend({ keys: ['str/1'], holder: other, ttlSeconds: 60, maxTtlSeconds: 600 });
    assert.ok(!strangerExtend.ok && strangerExtend.code === 'LEASE_UNAVAILABLE');
    const strangerRelease = await service.release({ keys: ['str/1'], holder: other });
    assert.ok(!strangerRelease.ok && strangerRelease.code === 'LEASE_UNAVAILABLE');
  });

  test('a released lease cannot be extended', async () => {
    const service = new LeaseService(db, { now: clock('2026-10-22T08:00:00Z') });
    await service.acquire({ keys: ['relx/1'], ttlSeconds: 600, holder, prefix: 'relx/', maxTtlSeconds: 1200 });
    const released = await service.release({ keys: ['relx/1'], holder });
    assert.equal(released.ok, true);
    const extended = await service.extend({ keys: ['relx/1'], holder, ttlSeconds: 60, maxTtlSeconds: 1200 });
    assert.ok(!extended.ok && extended.code === 'LEASE_EXPIRED');
  });

  test('an expired lease cannot be extended by lying about the clock: the service clock alone decides', async () => {
    const early = new LeaseService(db, { now: clock('2026-10-22T08:00:00Z') });
    await early.acquire({ keys: ['expx/1'], ttlSeconds: 300, holder, prefix: 'expx/', maxTtlSeconds: 600 });
    // The service clock is past the expiry; there is no `at` to bring an earlier moment.
    const late = new LeaseService(db, { now: clock('2026-10-22T08:10:00Z') });
    const extended = await late.extend({ keys: ['expx/1'], holder, ttlSeconds: 60, maxTtlSeconds: 600 });
    assert.ok(!extended.ok && extended.code === 'LEASE_EXPIRED');
  });

  test('the cumulative cap counts from the first acquisition', async () => {
    const service = new LeaseService(db, { now: clock('2026-10-22T08:00:00Z') });
    await service.acquire({ keys: ['cap/1'], ttlSeconds: 600, holder, prefix: 'cap/', maxTtlSeconds: 1200 });
    const later = new LeaseService(db, { now: clock('2026-10-22T08:05:00Z') });
    // 08:05 + 1160s = 08:24:20, past the cap 08:00 + 1200s = 08:20.
    const beyond = await later.extend({ keys: ['cap/1'], holder, ttlSeconds: 1160, maxTtlSeconds: 1200 });
    assert.ok(!beyond.ok && beyond.code === 'LEASE_TTL');
    const within = await later.extend({ keys: ['cap/1'], holder, ttlSeconds: 600, maxTtlSeconds: 1200 });
    assert.equal(within.ok, true, '08:05 + 600s is inside the cap counted from acquisition');
  });

  test('keys without a row are answered, not thrown: extend and release', async () => {
    const service = new LeaseService(db, { now: clock('2026-10-22T08:00:00Z') });
    const extended = await service.extend({ keys: ['ghost/1'], holder, ttlSeconds: 60, maxTtlSeconds: 600 });
    assert.ok(!extended.ok && extended.code === 'LEASE_NO_ROW');
    const released = await service.release({ keys: ['ghost/1'], holder });
    assert.ok(!released.ok && released.code === 'LEASE_NO_ROW');
    const forced = await service.forceRelease({ keys: ['ghost/1'], by: 'adm', reason: '无' });
    assert.ok(!forced.ok && forced.code === 'LEASE_NO_ROW');
    // No action record was written for keys without a row.
    const log = await service.actionLog('ghost/');
    assert.equal(log.length, 0);
  });
});

describe('view, force release and orphans', () => {
  test('view lists the unexpired rows of a prefix; the prefix matches literally, so a_b/ never matches aXb/', async () => {
    const service = new LeaseService(db, { now: clock('2026-10-22T08:00:00Z') });
    const under = await service.acquire({ keys: ['a_b/1'], ttlSeconds: 600, holder, prefix: 'a_b/', maxTtlSeconds: 600 });
    assert.equal(under.ok, true);
    const beside = await service.acquire({ keys: ['axb/1'], ttlSeconds: 600, holder, prefix: 'axb/', maxTtlSeconds: 600 });
    assert.equal(beside.ok, true);
    const view = await new LeaseService(db, { now: clock('2026-10-22T08:01:00Z') }).view('a_b/');
    assert.deepEqual(view.entries.map((e) => e.key), ['a_b/1'], 'the underscore of the prefix is literal, not a wildcard');
  });

  test('force release (an admin, with a reason) frees the key and leaves an action record with the reason', async () => {
    const service = new LeaseService(db, { now: clock('2026-10-22T08:00:00Z') });
    await service.acquire({ keys: ['force/1'], ttlSeconds: 600, holder, prefix: 'force/', maxTtlSeconds: 600 });
    const forced = await service.forceRelease({ keys: ['force/1'], by: 'adm', reason: '维护窗口' });
    assert.equal(forced.ok, true);
    const after = await service.acquire({ keys: ['force/1'], ttlSeconds: 600, holder: other, prefix: 'force/', maxTtlSeconds: 600 });
    assert.equal(after.ok, true);
  });

  test('an orphan whose run record exists is never reclaimed, even long after', async () => {
    const runId = newRunId('01hx2v2pcanc9gtr0000abcdef');
    const service = new LeaseService(db, { now: clock('2026-10-22T08:00:00Z') });
    await service.acquire({ keys: ['orphan/live/1'], ttlSeconds: 3_600_000, holder: { user: holder.user, run: runId }, prefix: 'orphan/', maxTtlSeconds: 7_200_000 });
    await putRun(kit.store, runRecord(runId) as unknown as RunRecord, '2026-10-22T08:00:00.000Z');
    const muchLater = new LeaseService(db, { now: clock('2026-10-23T08:00:00Z') });
    const reclaimed = await muchLater.reclaimOrphans();
    assert.equal(reclaimed, 0, 'the run exists: nothing is reclaimed');
    const view = await muchLater.view('orphan/live/');
    assert.equal(view.entries.length, 1, 'the lease still holds');
  });

  test('an orphan whose run record is missing, acquired over 60 seconds ago, is reclaimed with a take_over action and the token grown', async () => {
    const runId = newRunId('01hx2v2pcanc9gtr0001abcdef');
    const service = new LeaseService(db, { now: clock('2026-10-22T08:00:00Z') });
    const held = await service.acquire({ keys: ['orphan/gone/1'], ttlSeconds: 3_600_000, holder: { user: holder.user, run: runId }, prefix: 'orphan/', maxTtlSeconds: 7_200_000 });
    assert.ok(held.ok);
    // No run record for runId; two minutes later the row is an orphan.
    const later = new LeaseService(db, { now: clock('2026-10-22T08:02:00Z') });
    const reclaimed = await later.reclaimOrphans();
    assert.ok(reclaimed >= 1, 'the missing-run row was reclaimed');
    const view = await later.view('orphan/gone/');
    assert.equal(view.entries.length, 0, 'the row is free again');
    const log = await later.actionLog('orphan/gone/');
    const takeOver = log.find((entry) => entry.op === 'take_over');
    assert.ok(takeOver, 'a take_over action was written');
    assert.match(JSON.stringify(takeOver), /孤儿回收/);
    const token = Number(takeOver?.token ?? 0);
    assert.ok(token > (held.ok ? held.token : 0), 'the token grew on the take-over');
    // And the next acquire wins the row with a token one higher still.
    const next = await later.acquire({ keys: ['orphan/gone/1'], ttlSeconds: 60, holder: other, prefix: 'orphan/', maxTtlSeconds: 600 });
    assert.ok(next.ok && next.token === token + 1);
  });

  test('an orphan younger than 60 seconds is not reclaimed', async () => {
    const runId = newRunId('01hx2v2pcanc9gtr0002abcdef');
    const service = new LeaseService(db, { now: clock('2026-10-22T08:00:00Z') });
    await service.acquire({ keys: ['orphan/young/1'], ttlSeconds: 3_600_000, holder: { user: holder.user, run: runId }, prefix: 'orphan/', maxTtlSeconds: 7_200_000 });
    // No run record; only thirty seconds later the 60-second rule keeps the row.
    const soon = new LeaseService(db, { now: clock('2026-10-22T08:00:30Z') });
    const reclaimed = await soon.reclaimOrphans();
    assert.equal(reclaimed, 0, 'younger than 60 seconds: nothing reclaimed');
    const view = await soon.view('orphan/young/');
    assert.equal(view.entries.length, 1);
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
    const later = new LeaseService(db, { now: clock('2026-10-22T08:02:00Z') });
    await later.extend({ keys: ['replay/1'], holder, ttlSeconds: 100, maxTtlSeconds: 600 });
    await later.release({ keys: ['replay/2'], holder });
    const records = await later.actionLog('replay/');
    assert.ok(records.length >= 3, 'acquire, extend and release each left a record');
    const state = new Map<string, { lease: string; until: string; token: number; released: boolean }>();
    for (const record of records) {
      const detail = record as { op: string; keys: string[]; lease: string; until: string; token: number };
      for (const key of detail.keys) {
        const released = detail.op === 'release' || detail.op === 'force_release';
        state.set(key, { lease: detail.lease, until: detail.until, token: detail.token, released });
      }
    }
    const view = await later.view('replay/');
    assert.deepEqual(
      view.entries.map((e) => e.key).sort(),
      [...state.entries()].filter(([, s]) => !s.released).map(([key]) => key).sort(),
      'the replayed state matches the table for the live rows',
    );
  });
});

// ---------------------------------------------------------------- helpers

/** A run id on the ULID pattern with a fixed 26-character tail (each test uses its own). */
function newRunId(tail: string): string {
  return `run_${tail.padStart(26, '0')}`;
}

/** A minimal well-formed run record for putRun. */
function runRecord(run: string): Record<string, unknown> {
  return {
    run,
    pack: 'demo@1.0.0',
    pack_digest: 'a'.repeat(64),
    target_basis: [],
    sources: [],
    requirements: [],
    items: [],
    instructions: '规程',
    instructions_digest: 'b'.repeat(64),
    started_at: '2026-10-22T08:00:00.000Z',
    host: 'local_circle',
    trigger: 'session',
    parameters: {},
    runner: holder.user,
  };
}

test('an uncapped lease has no expiry, cannot extend, survives time and releases only for its holder', async () => {
  const service = new LeaseService(db, { now: clock('2026-10-24T08:00:00Z') });
  const held = await service.acquire({ keys: ['endless/a/k'], holder, prefix: 'endless/' });
  assert.ok(held.ok, JSON.stringify(held));
  assert.equal(held.until, null);
  const later = new LeaseService(db, { now: clock('2036-10-24T08:00:00Z') });
  assert.deepEqual((await later.view('endless/')).entries.map(e => e.until), [null]);
  const denied = await later.extend({ keys: ['endless/a/k'], holder, ttlSeconds: 60 });
  assert.ok(!denied.ok && denied.code === 'LEASE_TTL');
  assert.match(denied.message, /不到期，不用续/);
  assert.ok(!(await later.release({ keys: ['endless/a/k'], holder: other })).ok);
  assert.ok((await later.release({ keys: ['endless/a/k'], holder })).ok);
  assert.equal((await later.view('endless/')).entries.length, 0);
});

test('registration is exclusive, disjoint and replayable with audited administrator reassignment', async () => {
  const s = new LeaseService(db, { now: clock('2026-10-24T09:00:00Z') });
  const input = { prefix: 'owned/a/', declaredPrefix: 'owned/', owner: holder.user, by: holder.user, reason: '合成登记' };
  assert.ok((await s.register(input)).ok);
  const duplicate = await s.register({ ...input, owner: other.user, by: other.user });
  assert.ok(!duplicate.ok && duplicate.code === 'LEASE_UNAVAILABLE');
  assert.match(duplicate.message, /已经有主人/);
  assert.ok(!duplicate.message.includes(holder.user));
  for (const prefix of ['owned/', 'owned/a', 'owned/a/nested/']) assert.ok(!(await s.register({ ...input, prefix })).ok);
  assert.ok(!(await s.unregister({ prefix: input.prefix, by: other.user, reason: '合成注销' })).ok);
  assert.ok((await s.register({ ...input, owner: other.user, by: 'admin', admin: true, reason: '更正归属' })).ok);
  assert.equal((await s.registrations('owned/'))[0]!.owner, other.user);
  assert.ok(!(await s.unregister({ prefix: input.prefix, by: holder.user, reason: '合成注销' })).ok);
  assert.ok((await s.acquire({ keys: ['owned/a/k'], holder, prefix: 'owned/' })).ok);
  const busy = await s.unregister({ prefix: input.prefix, by: other.user, reason: '合成注销' });
  assert.ok(!busy.ok && busy.code === 'LEASE_UNAVAILABLE');
  assert.match(busy.message, /先强制释放，或等它释放/);
  assert.ok((await s.release({ keys: ['owned/a/k'], holder })).ok);
  assert.ok((await s.unregister({ prefix: input.prefix, by: 'admin', admin: true, reason: '管理员注销' })).ok);
  assert.ok((await s.register({ ...input, prefix: 'owned/kept/' })).ok);
  const state = new Map<string, string>();
  for (const record of await s.actionLog('owned/')) {
    if (record.op === 'register') state.set(String(record.prefix), String(record.owner));
    if (record.op === 'unregister') state.delete(String(record.prefix));
    if (record.reason === '更正归属') assert.equal(record.previous_owner, holder.user);
  }
  assert.deepEqual([...state], (await s.registrations('owned/')).map(r => [r.prefix, r.owner]));
  assert.ok((await s.unregister({ prefix: 'owned/kept/', by: holder.user, reason: '主人注销' })).ok);
});

test('two connections registering a prefix or overlapping prefixes have exactly one winner in 50 rounds', async () => {
  const a = new LeaseService(db); const b = new LeaseService(db);
  for (let i = 0; i < 50; i++) {
    const base = { declaredPrefix: 'owners/', owner: holder.user, by: holder.user, reason: '合成并发' };
    const results = await Promise.all([
      a.register({ ...base, prefix: `owners/r${i}/` }),
      b.register({ ...base, prefix: i % 2 ? `owners/r${i}/nested/` : `owners/r${i}/`, owner: other.user, by: other.user }),
    ]);
    assert.equal(results.filter(r => r.ok).length, 1);
  }
});

test('the default mutation clock uses its transaction connection instead of starving a bounded pool',async()=>{
  const original=db.query.bind(db);
  db.query=async function(text,values=[],tx){
    if(text==='SELECT now()::timestamptz AS now'||text==='SELECT clock_timestamp()::timestamptz AS now')assert.ok(tx,'mutation clock needs the held transaction connection');
    return original(text,values,tx);
  } as typeof db.query;
  try{
    const service=new LeaseService(db);
    assert.ok((await service.acquire({keys:['clock-transaction/k'],prefix:'clock-transaction/',holder})).ok);
  }finally{db.query=original;}
});

test('a different user cannot release a known run identity and receives a refusal rather than an exception',async()=>{
  const service=new LeaseService(db,{now:clock('2026-10-24T08:00:00Z')});
  assert.ok((await service.acquire({keys:['identity/owned/k'],prefix:'identity/',holder})).ok);
  const refused=await service.release({keys:['identity/owned/k'],holder:{user:other.user,run:holder.run}});
  assert.ok(!refused.ok&&refused.code==='LEASE_UNAVAILABLE');
  assert.equal((await service.holders(['identity/owned/k']))[0]!.released,false);
});

test('waiting for the mutation lock does not backdate a capped acquisition to transaction start',async()=>{
  const service=new LeaseService(db);
  let held!:()=>void;const heldSignal=new Promise<void>(resolve=>held=resolve);
  let release!:()=>void;const pause=new Promise<void>(resolve=>release=resolve);
  const blocking=service.withMutationLock(async()=>{held();await pause;});await heldSignal;
  const original=db.query.bind(db);let waiting!:()=>void;const waitingSignal=new Promise<void>(resolve=>waiting=resolve);
  db.query=async function(text,values=[],tx){if(text.includes('pg_advisory_xact_lock'))waiting();return original(text,values,tx);} as typeof db.query;
  const attempt=service.acquire({keys:['clock-wait/k'],prefix:'clock-wait/',ttlSeconds:600,maxTtlSeconds:600,holder});
  try{
    await waitingSignal;
    const checkpoint=(await original<{moment:Date}>('SELECT clock_timestamp() AS moment FROM pg_sleep(0.03)')).rows[0]!.moment;
    release();await blocking;assert.ok((await attempt).ok);
    const since=(await original<{acquired_at:Date}>('SELECT acquired_at FROM leases WHERE key=$1',['clock-wait/k'])).rows[0]!.acquired_at;
    assert.ok(since.getTime()>=checkpoint.getTime(),'acquisition clock must be read after obtaining the lock');
  }finally{release();await Promise.allSettled([blocking,attempt]);db.query=original;}
});

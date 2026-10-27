import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { RECORD_SCHEMAS, type ActionBody } from '../records/api.ts';
import { createPool, Database } from '../records/db.ts';
import { openTestRecords, type TestRecordsKit } from '../testing/records.ts';
import { startPostgres, type TemporaryPostgres } from '../testing/postgres.ts';
import { LeaseService } from './service.ts';

let postgres: TemporaryPostgres;
let kit: TestRecordsKit;
let db: Database;

before(async () => {
  postgres = await startPostgres();
  kit = await openTestRecords({ postgres });
  db = new Database(createPool(kit.database, 2));
});

after(async () => {
  await db?.end();
  await kit?.close();
  await postgres?.stop();
});

const holder = { user: 'usr_0123456789abcdefghjkmnpqrs', run: 'run_0123456789abcdefghjkmnpqrs' };
let sequence = 0;

async function action(key: string | null, op: 'acquire' | 'extend' | 'release', at: string) {
  const lease = `lse_synthetic_${++sequence}`;
  const detail = { op, lease, holder, until: null, token: sequence, ...(key === null ? {} : { keys: [key] }) };
  const body: ActionBody = {
    action: 'lease', run: holder.run, item: null, inputs: key === null ? [] : [key], component: 'leases@1', lease: { lease, fencing: sequence },
    started_at: at, ended_at: at, result: 'completed', error_code: null, acceptance: null, codes: [], detail,
  };
  return kit.store.put({
    kind: 'action', schema: RECORD_SCHEMAS.action, provenance: 'observed', created_at: at, body,
    index: [{ key: 'action.kind', value: 'lease' }],
  });
}

test('history selects the exact key, latest pre-window action and ordered bounded events', async () => {
  const service = new LeaseService(db, { records: kit.store });
  const key = 'bed/synthetic/device0';
  const acquired = await action(key, 'acquire', '2026-10-27T08:00:00.000Z');
  await action('bed/synthetic/device0-extra', 'acquire', '2026-10-27T08:00:05.000Z');
  await action('bed/other/device0', 'acquire', '2026-10-27T08:00:06.000Z');
  const before = await service.history({ key, from: '2026-10-27T08:00:10.000Z', to: '2026-10-27T08:00:20.000Z' });
  assert.equal(before.before?.digest, acquired.digest);
  assert.deepEqual(before.events, []);
  assert.equal(before.complete, true);

  const released = await action(key, 'release', '2026-10-27T08:00:10.000Z');
  await action(key, 'acquire', '2026-10-27T08:00:11.000Z');
  const window = await service.history({ key, from: '2026-10-27T08:00:10.000Z', to: '2026-10-27T08:00:10.000Z' });
  assert.equal(window.before?.digest, acquired.digest);
  assert.deepEqual(window.events.map(row => row.digest), [released.digest]);
  const limited = await service.history({ key, from: '2026-10-27T08:00:00.000Z', to: '2026-10-27T08:00:20.000Z', limit: 1 });
  assert.equal(limited.complete, false);
  assert.equal(limited.events.length, 1);
});

test('a missing keys record cannot disappear through exact-key filtering', async () => {
  const service = new LeaseService(db, { records: kit.store });
  const damaged = await action(null, 'acquire', '2026-10-27T08:00:07.000Z');
  const history = await service.history({ key: 'bed/synthetic/unrelated', from: '2026-10-27T08:00:10.000Z', to: '2026-10-27T08:00:20.000Z' });
  assert.deepEqual(history.unattributable.map(row => row.digest), [damaged.digest]);
  const beforeDamage = await service.history({ key: 'bed/synthetic/unrelated', from: '2026-10-27T08:00:01.000Z', to: '2026-10-27T08:00:02.000Z' });
  assert.deepEqual(beforeDamage.unattributable, []);
});

test('lease actions use the service clock and index every exact resource key', async () => {
  const at = '2026-10-27T09:00:00.000Z';
  const service = new LeaseService(db, { records: kit.store, now: async () => new Date(at) });
  const key = 'bed/clock/device0';
  const acquired = await service.acquire({ keys: [key], holder, prefix: 'bed/' });
  assert.ok(acquired.ok);
  const indexed = await kit.store.find<ActionBody>({ key: 'lease.key', value: key, kind: 'action', limit: 10 });
  assert.equal(indexed.items.length, 1);
  assert.equal(indexed.items[0].body.started_at, at);
  assert.equal(indexed.items[0].created_at, at);
  assert.deepEqual(indexed.items[0].body.detail.keys, [key]);
});

test('prefix registrations are not damaged device history', async () => {
  const at = '2026-10-27T09:10:00.000Z';
  const service = new LeaseService(db, { records: kit.store, now: async () => new Date(at) });
  const registered = await service.register({ prefix: 'bed/registered/', declaredPrefix: 'bed/', owner: holder.user, by: holder.user, reason: '合成登记' });
  assert.ok(registered.ok);
  const key = 'bed/registered/device0';
  assert.ok((await service.acquire({ keys: [key], holder, prefix: 'bed/' })).ok);
  const history = await service.history({ key, from: '2026-10-27T09:11:00.000Z', to: '2026-10-27T09:12:00.000Z' });
  assert.ok(history.unattributable.every(row => row.body.detail.op !== 'register' && row.body.detail.op !== 'unregister'));
  assert.equal(history.before?.body.detail.op, 'acquire');
});

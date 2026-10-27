import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openTestRecords } from '../testing/records.ts';
import { startPostgres } from '../testing/postgres.ts';
import { createPool, Database } from '../records/db.ts';
import { LeaseService } from './service.ts';

test('a blocked release takes its timestamp after the row lock and cannot backdate history', { timeout: 10000 }, async t => {
  const postgres = await startPostgres();
  t.after(() => postgres.stop());
  const kit = await openTestRecords({ postgres });
  t.after(() => kit.close());
  const holder = { user: 'usr_0123456789abcdefghjkmnpqrs', run: 'run_0123456789abcdefghjkmnpqrs' };
  const key = 'bed/synthetic/device0';
  const db = new Database(createPool(kit.database, 2));
  t.after(() => db.end());
  const acquiredAt = '2026-10-27T08:00:00.000Z';
  const service = new LeaseService(db, { records: kit.store, now: async () => new Date(acquiredAt) });
  const acquired = await service.acquire({ keys: [key], holder, prefix: 'bed/' });
  assert.ok(acquired.ok);

  const events: string[] = [];
  const original = db.query.bind(db);
  db.query = new Proxy(original, {
    apply(target, _this, args) {
      if (String(args[0]).includes('FOR UPDATE')) events.push('lock');
      return Reflect.apply(target, _this, args);
    },
  });
  let mark!: () => void;
  let openGate!: () => void;
  const started = new Promise<void>(resolve => { mark = resolve; });
  const gate = new Promise<void>(resolve => { openGate = resolve; });
  t.after(() => openGate());
  const committedAt = '2026-10-27T08:00:02.000Z';
  const blocked = new LeaseService(db, {
    records: kit.store,
    now: async () => {
      events.push('now');
      mark();
      await gate;
      return new Date(committedAt);
    },
  });
  const releasing = blocked.release({ keys: [key], holder });
  await started;
  assert.deepEqual(events, ['lock', 'now']);
  const before = await service.history({ key, from: '2026-10-27T08:00:00.500Z', to: '2026-10-27T08:00:01.000Z' });
  assert.equal(before.before?.body.detail.op, 'acquire');
  assert.deepEqual(before.events, []);
  openGate();
  const released = await releasing;
  assert.ok(released.ok);
  const actions = await kit.store.find({ key: 'lease.key', value: key, kind: 'action', limit: 10 });
  assert.equal(actions.items.at(-1)?.created_at, committedAt);
  const after = await service.history({ key, from: '2026-10-27T08:00:00.500Z', to: '2026-10-27T08:00:01.000Z' });
  assert.equal(after.before?.body.detail.op, 'acquire');
  assert.deepEqual(after.events, []);
});

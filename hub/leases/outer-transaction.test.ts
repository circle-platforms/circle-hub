// Pure delegation test: no connection or PostgreSQL process is started.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Database, createPool, type Transaction } from '../records/api.ts';
import { LeaseService } from './api.ts';

test('acquire, extend and mutation lock pass the same admission transaction to Database.transaction', async t => {
  const db = new Database(createPool({ host: '127.0.0.1', port: 1, database: 'synthetic_unused', user: 'synthetic_unused' }, 1));
  t.after(() => db.end());
  db.query = async () => { throw new Error('no direct database query may precede outer transaction delegation'); };
  const stop = new Error('synthetic delegated transaction boundary');
  const seen: Array<Transaction | undefined> = [];
  t.mock.method(db, 'transaction', async <T>(_fn: Parameters<Database['transaction']>[0], outer?: Transaction): Promise<T> => {
    seen.push(outer); throw stop;
  });
  const service = new LeaseService(db), outer: Transaction = { transactionId: 23 };
  const holder = { user: 'usr_0123456789abcdefghjkmnpqrs', run: 'run_0123456789abcdefghjkmnpqrs' };
  await assert.rejects(service.acquire({ keys: ['synthetic/seat'], holder, prefix: 'synthetic/' }, outer), error => error === stop);
  await assert.rejects(service.extend({ keys: ['synthetic/seat'], holder, ttlSeconds: 60 }, outer), error => error === stop);
  await assert.rejects(service.withMutationLock(async () => { throw new Error('callback not reached'); }, outer), error => error === stop);
  assert.deepEqual(seen, [outer, outer, outer]);
});

test('holder release and administrator force release retain their independent transaction paths', async t => {
  const db = new Database(createPool({ host: '127.0.0.1', port: 1, database: 'synthetic_unused', user: 'synthetic_unused' }, 1));
  t.after(() => db.end());
  const stop = new Error('synthetic cleanup boundary'), seen: Array<Transaction | undefined> = [];
  t.mock.method(db, 'transaction', async <T>(_fn: Parameters<Database['transaction']>[0], outer?: Transaction): Promise<T> => { seen.push(outer); throw stop; });
  const service = new LeaseService(db);
  const holder = { user: 'usr_0123456789abcdefghjkmnpqrs', run: 'run_0123456789abcdefghjkmnpqrs' };
  await assert.rejects(service.release({ keys: ['synthetic/seat'], holder }), error => error === stop);
  await assert.rejects(service.forceRelease({ keys: ['synthetic/seat'], by: holder.user, reason: 'synthetic cleanup' }), error => error === stop);
  assert.deepEqual(seen, [undefined, undefined]);
});

// Pure port tests: no PostgreSQL server or connection is opened.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Database, createPool, type Transaction } from '../records/api.ts';
import { LeaseService } from './api.ts';

function unusedDatabase() {
  const db = new Database(createPool({ host: '127.0.0.1', port: 1, database: 'synthetic_unused', user: 'synthetic_unused' }, 1));
  db.query = async () => { throw new Error('pure catalog read must never query a legacy table or borrow a connection'); };
  return db;
}

test('catalog registration reads preserve the exact outer transaction without querying legacy tables', async t => {
  const db = unusedDatabase(); t.after(() => db.end());
  const tx: Transaction = { transactionId: 42 };
  const seen: Array<Transaction | undefined> = [];
  const service = new LeaseService(db, { catalog: { ownership: async outer => {
    seen.push(outer);
    return { prefixes: [{ prefix: 'synthetic/alpha/', owner: 'synthetic-owner' }], resources: [{ key: 'synthetic/exact', owner: 'synthetic-owner' }] };
  } } });
  assert.deepEqual(await service.registrations('synthetic/', tx), [{ prefix: 'synthetic/alpha/', owner: 'synthetic-owner' }]);
  assert.deepEqual(seen, [tx]);
  assert.equal('register' in service, false);
  assert.equal('unregister' in service, false);
});

test('missing or unreadable catalog is not a first-run or empty-directory fallback', async t => {
  const db = unusedDatabase(); t.after(() => db.end());
  await assert.rejects(new LeaseService(db).registrations(''), /目录尚未接入/);
  const failure = new Error('synthetic unreadable catalog');
  const service = new LeaseService(db, { catalog: { ownership: async () => { throw failure; } } });
  await assert.rejects(service.registrations(''), error => error === failure);
});

test('a confirmed empty catalog is an empty registration view rather than permission to consult old registrations', async t => {
  const db = unusedDatabase(); t.after(() => db.end());
  const service = new LeaseService(db, { catalog: { ownership: async () => ({ prefixes: [], resources: [] }) } });
  assert.deepEqual(await service.registrations(''), []);
});

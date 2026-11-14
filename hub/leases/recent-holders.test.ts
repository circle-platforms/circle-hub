// Pure query-projection tests: no PostgreSQL process or database connection is opened.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Database, createPool, type Transaction } from '../records/api.ts';
import { LeaseService } from './api.ts';

function unusedDatabase() {
  return new Database(createPool({ host: '127.0.0.1', port: 1, database: 'synthetic_unused', user: 'synthetic_unused' }, 1));
}

test('recent holders uses one clock sample and one parameterized read of all matching last rows on the supplied tx', async t => {
  const db = unusedDatabase(); t.after(() => db.end());
  const tx: Transaction = { transactionId: 91 };
  const since = new Date('2026-11-14T08:00:00.000Z'), until = new Date('2026-11-14T08:05:00.000Z');
  const states = [{ released: false, active: true }, { released: true, active: false }, { released: false, active: false }];
  let reads = 0, clockReads = 0;
  t.mock.method(db, 'query', async (sql: string, values: readonly unknown[] = [], outer?: Transaction) => {
    reads++;
    assert.equal(outer, tx); assert.deepEqual(values, ['synthetic/prefix_%/', since]);
    assert.match(sql, /WITH observed AS \(SELECT \$2::timestamptz AS at\)/);
    assert.doesNotMatch(sql, /clock_timestamp/);
    assert.match(sql, /FROM leases CROSS JOIN observed WHERE starts_with\(key,\$1\) ORDER BY key/);
    assert.doesNotMatch(sql, /\b(?:LIMIT|UPDATE|INSERT|DELETE|record_index|actions)\b/i);
    return { rows: states.map((state, n) => ({ key: `synthetic/prefix_%/${n}`, user_id: `synthetic-user-${n}`, run_id: `synthetic-run-${n}`, acquired_at: since, expires_at: n === 0 ? null : until, ...state })) };
  });
  const service = new LeaseService(db, { now: async () => { clockReads++; return since; } });
  assert.deepEqual(await service.recentHolders('synthetic/prefix_%/', tx), states.map((state, n) => ({
    key: `synthetic/prefix_%/${n}`, user: `synthetic-user-${n}`, run: `synthetic-run-${n}`,
    since: since.toISOString(), until: n === 0 ? null : until.toISOString(), ...state,
  })));
  assert.equal(reads, 1); assert.equal(clockReads, 1);
});

test('recent holder read failures are not an empty history', async t => {
  const db = unusedDatabase(); t.after(() => db.end());
  const failure = new Error('synthetic history unreadable');
  t.mock.method(db, 'query', async () => { throw failure; });
  await assert.rejects(new LeaseService(db).recentHolders('synthetic/'), error => error === failure);
});

test('default recent clock still samples the database once on the same supplied transaction', async t => {
  const db = unusedDatabase(); t.after(() => db.end());
  const tx: Transaction = { transactionId: 92 }, at = new Date('2026-11-14T08:00:00.000Z');
  let clockReads = 0, holderReads = 0;
  t.mock.method(db, 'query', async (sql: string, values: readonly unknown[] = [], outer?: Transaction) => {
    assert.equal(outer, tx);
    if (sql === 'SELECT clock_timestamp()::timestamptz AS now') {
      clockReads++; assert.deepEqual(values, []); return { rows: [{ now: at }] };
    }
    holderReads++; assert.deepEqual(values, ['synthetic/', at]); return { rows: [] };
  });
  assert.deepEqual(await new LeaseService(db).recentHolders('synthetic/', tx), []);
  assert.equal(clockReads, 1); assert.equal(holderReads, 1);
});

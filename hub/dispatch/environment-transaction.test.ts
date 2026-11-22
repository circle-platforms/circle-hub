import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { test } from 'node:test';
import type { QueryResult } from 'pg';
import { Database, openRecords, type Transaction, type Row } from '../records/api.ts';
import { withRequestPermissions } from '../records/request-permissions.ts';
import { DispatchService } from './service.ts';
import { setup } from './testing/context.ts';

test('the intent transaction of a dispatch never rents a second client', async t => {
  const c = await setup(); t.after(() => c.close());
  const records = await openRecords({ ...c.kit.config, database: c.kit.database }, { migrate: false, maxConnections: 1, keyProvider: c.kit.keyProvider, now: c.now });
  t.after(() => records.close());
  assert.ok(records.poolStats, 'the real fixture exposes pool statistics');
  assert.equal(records.poolStats().limit, 1, 'the intent kit really has one connection');
  records.store.tryHold=c.kit.store.tryHold.bind(c.kit.store);
  const scope = new AsyncLocalStorage<Transaction>();
  const originalTransaction = records.store.withTransaction.bind(records.store);
  records.store.withTransaction = (run, outer) => originalTransaction(tx => scope.run(tx, () => run(tx)), outer);
  let reborrows = 0, held = 0;
  const originalQuery = Database.prototype.query;
  Database.prototype.query = function<R extends Row = Row>(this: Database, text: string, values: readonly unknown[] = [], tx?: Transaction): Promise<QueryResult<R>> {
    const outer = scope.getStore();
    if (outer && this.pool.options.max === 1 && this.pool.options.database === c.kit.database.database) {
      if (tx !== outer) {
        reborrows++;
        throw new Error('a held transaction attempted another client lease');
      }
      held++;
    }
    const execute = originalQuery<R>;
    return execute.call(this, text, values, tx);
  };
  t.after(() => { Database.prototype.query = originalQuery; });
  const service = new DispatchService({ ...c.service.options, records });
  const result = await withRequestPermissions(records.artifacts, c.owner, () => service.dispatch(c.admin, c.run, c.executor.id));
  assert.equal(reborrows, 0, 'no query in the held intent transaction may rent a second client');
  assert.ok(held > 0, 'the dispatch really queried inside its held transactions');
  assert.equal(result.outcome, 'effective');
  assert.equal(c.calls.filter(call => call === 'send_blob').length, 1);
  assert.ok((await service.journal.events(result.job)).some(event => event.body.detail.phase === 'intent'));
});

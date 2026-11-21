import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { test } from 'node:test';
import type { QueryResult } from 'pg';
import { Database, openRecords, type Transaction, type Row } from '../records/api.ts';
import { canUseEnvironment } from '../records/environment-permissions.ts';
import { requestPermissions, withRequestPermissions } from '../records/request-permissions.ts';
import { DispatchService } from './service.ts';
import { ExecutorRegistry } from './executors.ts';
import { MemberEnvironments } from './member-environments.ts';
import { setup } from './testing/context.ts';

for (const mode of ['assigned', 'revoked', 'broken-port'] as const) test(`single-client intent permission recheck: ${mode}`, async t => {
  const revoke=mode==='revoked';
  const c = await setup(); t.after(() => c.close());
  const records = await openRecords({ ...c.kit.config, database: c.kit.database }, { migrate: false, maxConnections: 1, keyProvider: c.kit.keyProvider, now: c.now });
  t.after(() => records.close());
  assert.ok(records.poolStats, 'the real fixture exposes pool statistics');
  assert.equal(records.poolStats().limit, 1, 'the permission and intent kit really has one connection');
  records.store.tryHold=c.kit.store.tryHold.bind(c.kit.store);
  const scope = new AsyncLocalStorage<Transaction>();
  const originalTransaction = records.store.withTransaction.bind(records.store);
  records.store.withTransaction = (run, outer) => originalTransaction(tx => scope.run(tx, () => run(tx)), outer);
  let reborrows = 0, transactionChecks = 0, revoked = false;
  const originalQuery = Database.prototype.query;
  Database.prototype.query = function<R extends Row = Row>(this: Database, text: string, values: readonly unknown[] = [], tx?: Transaction): Promise<QueryResult<R>> {
    const held = scope.getStore();
    if (held && this.pool.options.max === 1 && this.pool.options.database === c.kit.database.database && tx !== held) {
      reborrows++;
      throw new Error('a held transaction attempted another client lease');
    }
    const execute = originalQuery<R>;
    return execute.call(this, text, values, tx);
  };
  t.after(() => { Database.prototype.query = originalQuery; });
  const permission = async (actor: Parameters<typeof canUseEnvironment>[1], executor: string, tx?: Transaction) => {
    if (tx) {
      transactionChecks++;
      assert.equal(tx, scope.getStore(), 'fresh permission query must receive the held outer transaction');
      if (revoke && !revoked) {
        await c.kit.authorizations.unassignResource(c.admin, c.executor.id, c.environmentTeam.id);
        revoked = true;
        const old = requestPermissions(c.owner.id);
        assert.ok(old?.enabled(old.latest('resource_assign', c.environmentTeam.id, c.executor.id)), 'an older request snapshot still carries the grant');
      }
    }
    return canUseEnvironment(records, actor, executor, mode==='broken-port'?undefined:tx);
  };
  const environmentAccess = new MemberEnvironments(records, new ExecutorRegistry(records), c.leases, permission);
  const service = new DispatchService({ ...c.service.options, records, environmentAccess });
  const result = await withRequestPermissions(records.artifacts, c.owner, () => service.dispatch(c.admin, c.run, c.executor.id));
  if(mode==='broken-port'){
    assert.ok(reborrows>0,'the negative control actually attempts a second client lease');
    assert.equal(result.error_code,'SOURCE_UNAVAILABLE');assert.equal(c.calls.includes('send_blob'),false);
    return;
  }
  assert.equal(reborrows, 0, 'no query in the held intent transaction may rent a second client');
  assert.ok(transactionChecks > 0, 'the final check must remain fresh and run inside the intent transaction');
  if (revoke) {
    assert.equal(result.error_code, 'SOURCE_NOT_PERMITTED');
    assert.equal(result.outcome, 'not_dispatched');
    assert.equal(c.calls.includes('send_blob'), false);
    assert.ok(!(await service.journal.events(result.job)).some(event => event.body.detail.phase === 'intent'));
  } else {
    assert.equal(result.outcome, 'effective');
    assert.equal(c.calls.filter(call => call === 'send_blob').length, 1);
  }
});

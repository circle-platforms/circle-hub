import assert from 'node:assert/strict';
import { setTimeout as pause } from 'node:timers/promises';
import { test } from 'node:test';
import { openTestRecords } from '../testing/records.ts';
import { withEnvironmentPermissionLock, type Transaction } from './api.ts';
import { Database, createPool } from './db.ts';

for (const operation of ['revoke', 'disable', 'team membership', 'raw authorization', 'variable mutation'] as const) {
  test(`the same transaction boundary serializes ${operation} after the sampled source`, { timeout: 120000 }, async () => {
    const kit = await openTestRecords();
    const observer = new Database(createPool(kit.database, 1));
    let release!: () => void;
    let held: Promise<void> | undefined, mutation: Promise<unknown> | undefined;
    let heldTx: Transaction | undefined;
    try {
      const admin = (await kit.principals.bootstrapAdmin('synthetic-admin')).user;
      const member = await kit.principals.createUser(admin, 'synthetic-member');
      const team = await kit.teams.create(admin, 'synthetic-team');
      const input = { permission: 'assign' as const, subject: member.id, object: 'synthetic-workflow' };
      const source = await kit.authorizations.grant(admin, input);
      let ready!: (pid: number) => void;
      const entered = new Promise<number>(resolve => { ready = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      held = withEnvironmentPermissionLock(kit.store, async tx => {
        heldTx = tx;
        ready(Number((await observer.query('SELECT pg_backend_pid() AS pid', [], tx)).rows[0].pid));
        assert.equal((await kit.store.get(source.digest, tx))?.digest, source.digest);
        await gate;
      });
      const pid = await entered;
      mutation = operation === 'revoke' ? kit.authorizations.revoke(admin, input)
        : operation === 'disable' ? kit.principals.setDisabled(admin, member.id, true)
        : operation === 'team membership' ? kit.teams.add(admin, team.id, member.id)
        : operation === 'variable mutation' ? kit.variables.setVariable(admin, 'SYNTHETIC_VALUE', 'synthetic value', 'owner-approved update', { notSecret: true })
        : kit.store.put({ kind: 'authorization', schema: source.schema, provenance: source.provenance, body: { ...source.body, note: 'synthetic raw append' } });
      // Observe PostgreSQL's lock dependency, not a wall-clock speed threshold.
      const deadline = Date.now() + 30000;
      while (!(await observer.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity a WHERE $1=ANY(pg_blocking_pids(a.pid))) AS blocked', [pid])).rows[0].blocked) {
        if (Date.now() > deadline) throw new Error('expected source writer did not reach the shared database lock');
        await pause(5);
      }
      assert.equal((await kit.authorizations.latest('assign', member.id, input.object))?.body.revoked, false);
      if (operation === 'variable mutation') {
        assert.ok(heldTx);
        await kit.variables.lockNames(['SYNTHETIC_VALUE'], heldTx);
      }
      release();
      await held;
      await mutation;
      if (operation === 'revoke') assert.equal((await kit.authorizations.latest('assign', member.id, input.object))?.body.revoked, true);
      if (operation === 'disable') assert.equal((await kit.principals.get(member.id))?.disabled, true);
      if (operation === 'team membership') assert.equal((await kit.teams.members(admin, team.id)).length, 1);
      if (operation === 'variable mutation') assert.ok(await kit.authorizations.resourceConfig('var:SYNTHETIC_VALUE'));
    } finally {
      release?.();
      await Promise.allSettled([held, mutation].filter((p): p is Promise<unknown> => p !== undefined));
      await observer.end();
      await kit.close();
    }
  });
}

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Database, MIGRATIONS, createPool, openRecords, type User } from '../records/api.ts';
import { LeaseService } from '../leases/api.ts';
import { assembleHub } from './assemble/hub.ts';
import { openCliHarness } from './assemble/test-cli.ts';
import { loadServerConfig } from './main.ts';

test('an existing M1 member and booking survive direct serve', { timeout: 60_000 }, async () => {
  const harness = await openCliHarness();
  try {
    const deployment = await harness.deployment();
    const config = loadServerConfig(deployment.env);
    const database = new Database(createPool(config.database, 1));
    try {
      const kit = await openRecords(config, { migrate: false, keyProvider: deployment.key });
      let member: User;
      const holder = { user: '', run: 'run_0123456789abcdefghjkmnpqrs' };
      try {
        const admin = (await kit.principals.bootstrapAdmin('合成管理员')).user;
        member = await kit.principals.createUser({ id: admin.id, name: admin.name, role: admin.role }, '已有合成成员');
        holder.user = member.id;
        const booked = await new LeaseService(database, { records: kit.store }).acquire({ keys: ['bed/existing/device'], holder, prefix: 'bed/', ttlSeconds: 600, maxTtlSeconds: 900 });
        assert.equal(booked.ok, true);
      } finally { await kit.close(); }
      const snapshot = async () => ({
        migrations: (await database.query('SELECT * FROM schema_migrations ORDER BY version')).rows,
        columns: (await database.query("SELECT table_name,column_name,data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,ordinal_position")).rows,
        records: (await database.query('SELECT * FROM records ORDER BY seq')).rows,
        leases: (await database.query('SELECT * FROM leases ORDER BY key')).rows,
        member: (await database.query('SELECT * FROM users WHERE id=$1', [member.id])).rows,
      });
      const before = await snapshot();
      assert.deepEqual(before.migrations.map(row => row.version), MIGRATIONS.map(migration => migration.version), 'this is an M1 database, not an M2 database with a disabled flag');
      assert.ok(before.records.length > 0);
      assert.equal(before.leases.length, 1);
      let assembled = 0, listened = 0;
      const stopped = Promise.withResolvers<void>();
      const result = await deployment.run(['serve'], {
        assembly: async () => ({ assemble: async (current, records) => {
          const hub = await assembleHub(current, records, { requireOsIsolation: false, log: () => {} });
          try {
            const capabilities = await hub.deps.memberCapabilities({ id: member.id, name: member.name, role: member.role });
            assert.equal(capabilities.member.enabled, true, 'the existing member is still enabled');
            assert.deepEqual((await hub.leases.view('bed/', true)).entries.map(row => [row.key, row.user, row.run]), [['bed/existing/device', holder.user, holder.run]]);
            assert.deepEqual(await snapshot(), before, 'assembly changes neither schema, existing records, member nor booking');
            assembled++;
            return hub.deps;
          } catch (error) { await hub.deps.close?.(); throw error; }
        } }),
        onListening: () => { listened++; stopped.resolve(); },
        stopSignal: () => stopped.promise,
      });
      assert.equal(result.code, 0, result.text);
      assert.equal(assembled, 1);
      assert.equal(listened, 1);
      assert.deepEqual(await snapshot(), before, 'direct serve and shutdown preserve the existing M1 state');
      const leases = new LeaseService(database);
      assert.equal((await leases.extend({ keys: ['bed/existing/device'], holder, ttlSeconds: 600, maxTtlSeconds: 900 })).ok, true, 'the existing booking remains usable after restart');
    } finally { await database.end(); }
  } finally { await harness.close(); }
});

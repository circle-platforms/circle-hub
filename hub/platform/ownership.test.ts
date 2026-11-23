import {encodePersonalSyncObject} from '../../contracts/src/sync-canonical.ts';
// Integration: the real records schema in a cluster the platform created. hub/records is imported by this test only (the
// platform's code may import nothing but contracts). As `serve --migrate-only` does, the superuser role that owns the Hub
// database migrates and grants the application role (migrateRecords with runtimeRole); as `serve` does, the kit runs as
// the application role without migrating. The application role appends, and every statement that would delete,
// truncate, drop, alter or disable the triggers of a history table is refused with 42501, before and after a backup, a destroy
// and a restore.
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { DEFAULT_LIMITS, type DatabaseConfig } from '../config/index.ts';
import { FileKeyProvider, MIGRATIONS, migrateRecords, openRecords, RUNTIME_GRANTS, sha256Hex, type RecordsConfig } from '../records/index.ts';
import { createBackup, verifyBackup } from './backup.ts';
import { ensureLayout, layoutAt, type Layout } from './layout.ts';
import { createPostgres, ensureDatabaseRunning, type PostgresControl } from './postgres.ts';
import { restoreBackup } from './restore.ts';
import { rolePrivileges, roleProblems } from './roles.ts';
import { newSettingsFile, resolveDatabaseNames } from './settings.ts';
import { summarizeTables, withSession, type SqlSession } from './sql.ts';
import { libpqAvailable, LIBPQ_MISSING, removeDir, socketPort, sqlState, tempDir } from './test-support.ts';

const libpq = await libpqAvailable();

/** Everything the application role must never do, each to be refused with 42501 (insufficient_privilege). */
async function tamperingStatements(session: SqlSession): Promise<string[]> {
  const columns = await session.query(`SELECT c.relname AS table_name, a.attname AS column_name
    FROM pg_catalog.pg_attribute a
    JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
      AND a.attnum > 0 AND NOT a.attisdropped AND a.attidentity = '' AND a.attgenerated = ''
    ORDER BY c.relname, a.attnum`);
  const out: string[] = [];
  for (const [table, grants] of Object.entries(RUNTIME_GRANTS)) {
    const mutable = table === 'teams' || table === 'lease_registrations';
    let updateProbe: string[] = [];
    if (!mutable) {
      const writable = new Set<string>();
      for (const part of grants.split(/,\s*(?![^(]*\))/)) {
        const match = /^UPDATE(?:\s*\(([^)]*)\))?$/.exec(part.trim());
        if (!match) continue;
        assert.ok(match[1], `${table}: whole-table UPDATE needs an explicitly approved mutable exception`);
        for (const column of match[1].split(',')) writable.add(column.trim());
      }
      const column = columns.find(row => row.table_name === table && !writable.has(String(row.column_name)))?.column_name;
      assert.equal(typeof column, 'string', `${table}: a real column without registered UPDATE permission is required`);
      const quoted = '"' + String(column).replaceAll('"', '""') + '"';
      updateProbe = [`UPDATE ${table} SET ${quoted} = ${quoted}`];
    }
    out.push(
      ...(['lease_registrations', 'oauth_clients', 'trace_spans', 'resource_samples', 'process_events', 'team_members', 'external_member_identities'].includes(table) ? [] : [`DELETE FROM ${table}`]),
      ...updateProbe,
      `TRUNCATE ${table}`,
      `TRUNCATE ${table} CASCADE`,
      `DROP TABLE ${table}`,
      `DROP TABLE ${table} CASCADE`,
      `ALTER TABLE ${table} ADD COLUMN probe integer`,
      `ALTER TABLE ${table} RENAME TO ${table}_moved`,
      `ALTER TABLE ${table} DISABLE TRIGGER ALL`,
      `ALTER TABLE ${table} DISABLE TRIGGER USER`,
      `ALTER TABLE ${table} OWNER TO circle_hub`,
    );
  }
  out.push(
    'CREATE TABLE intruder (n integer)',
    'CREATE TEMPORARY TABLE intruder (n integer)',
    'CREATE SCHEMA intruder',
    'CREATE OR REPLACE FUNCTION hub_append_only() RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN RETURN NULL; END $fn$',
    'DROP FUNCTION hub_append_only() CASCADE',
  );
  return out;
}

/** RUNTIME_GRANTS as privilege entries of roles.ts: table privileges, and column ones for the column UPDATEs. */
function grantedEntries(): string[] {
  const out = ['database CONNECT', 'schema public USAGE'];
  for (const [table, grants] of Object.entries(RUNTIME_GRANTS)) {
    for (const part of grants.split(/,\s*(?![^(]*\))/)) {
      const match = /^([A-Z]+)(?:\s*\(([^)]*)\))?$/.exec(part.trim());
      assert.ok(match, `${table}: ${part}`);
      if (match[2] === undefined) out.push(`table public.${table} ${match[1]}`);
      else for (const column of match[2].split(',')) out.push(`column public.${table}.${column.trim()} ${match[1]}`);
    }
  }
  return out.sort();
}

describe('the real records schema in a platform cluster', { skip: libpq ? false : LIBPQ_MISSING }, () => {
  let parent: string;
  let layout: Layout;
  let control: PostgresControl;
  let keyProvider: FileKeyProvider;
  const port = socketPort();
  const appended: { id: string; digest: string }[] = [];
  let privateOwner:import('../records/api.ts').Principal;
  let heldOriginal:string,heldOriginalSha:string,heldPersonalLink:string;
  const runOriginalBytes=Buffer.from('synthetic run backup original\r\né');
  let privateDigest:string;
  let syncEpoch:string,syncSession:string,syncObject:{id:string;bytes_base64:string};

  const database = (user: string): DatabaseConfig => ({ host: layout.run, port, database: control.target.database, user });
  const kitConfig = (): RecordsConfig => ({ dataDir: layout.root, logDir: layout.logs, database: database(control.application.user), limits: { ...DEFAULT_LIMITS } });
  const asOwner = <T>(fn: (session: SqlSession) => Promise<T>) => withSession(control.connector, control.target.database, fn);

  /** The statements the application role ran or that failed with another SQLSTATE than 42501. */
  const notRefused = () =>
    withSession(control.applicationConnector, control.target.database, async (session) => {
      assert.equal(RUNTIME_GRANTS.teams, 'SELECT, INSERT, UPDATE', 'the approved projection grant, never a history grant');
      assert.equal(RUNTIME_GRANTS.team_members, 'SELECT, INSERT, DELETE', 'membership projection cannot be updated');
      assert.equal(RUNTIME_GRANTS.external_member_identities, 'SELECT, INSERT, DELETE', 'external identities can be unbound by deletion without allowing UPDATE');
      assert.equal(await sqlState(session, 'UPDATE teams SET deleted_at = deleted_at'), null);
      assert.equal(await sqlState(session, 'DELETE FROM team_members WHERE false'), null);
      assert.equal(await sqlState(session, 'DELETE FROM external_member_identities WHERE false'), null);
      // The registered-prefix projection must remain writable before and after restoration, without granting DDL.
      await session.query("INSERT INTO lease_registrations (prefix, owner, registered_at) VALUES ('test/ownership/', 'synthetic-owner', now())");
      await session.query("UPDATE lease_registrations SET owner = 'synthetic-next' WHERE prefix = 'test/ownership/'");
      assert.deepEqual(await session.query("SELECT owner FROM lease_registrations WHERE prefix = 'test/ownership/'"), [{ owner: 'synthetic-next' }]);
      await session.query("DELETE FROM lease_registrations WHERE prefix = 'test/ownership/'");
      assert.deepEqual(await session.query("SELECT owner FROM lease_registrations WHERE prefix = 'test/ownership/'"), []);
      const out: string[] = [];
      for (const statement of await tamperingStatements(session)) {
        const code = await sqlState(session, statement);
        if (code !== '42501') out.push(`${statement} -> ${code ?? 'ran'}`);
      }
      return out;
    });

  /** Owner of the database and of every relation and function in public. */
  const owners = () =>
    asOwner((s) =>
      s.query(`SELECT array_agg(DISTINCT owner) AS owners FROM (
                 SELECT pg_get_userbyid(d.datdba)::text AS owner FROM pg_database d WHERE d.datname = current_database()
                 UNION ALL SELECT pg_get_userbyid(c.relowner)::text FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace
                 UNION ALL SELECT pg_get_userbyid(p.proowner)::text FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace) AS o`),
    ).then((rows) => rows[0]?.owners);

  before(async () => {
    parent = await tempDir();
    layout = layoutAt(join(parent, 'root'));
    await ensureLayout(layout);
    // The vault key lives outside this data root: the test checks database ownership, not the key file.
    keyProvider = new FileKeyProvider(join(parent, 'vault.key'));
    control = createPostgres({ layout, port });
    await control.initialise();
    await ensureDatabaseRunning(control, { create: true });
  });

  after(async () => {
    await control?.stop().catch(() => {});
    if (parent) await removeDir(parent);
  });

  test('the owner migrates and grants; the kit runs as the application role, appends and cannot rewrite or remove anything', async () => {
    const role = control.application.user;
    // Before the owner migrated, the application role refuses to start instead of creating tables, and cannot migrate.
    await assert.rejects(openRecords(kitConfig(), { migrate: false, keyProvider }), /还没有应用/);
    await assert.rejects(migrateRecords({ database: database(role) }), (error: unknown) => (error as { code?: string }).code === '42501');
    assert.deepEqual(
      await migrateRecords({ database: database(control.target.user) }, { runtimeRole: role }),
      MIGRATIONS.map((migration) => migration.version),
    );
    assert.deepEqual(await owners(), [control.target.user], 'the database and the schema belong to the superuser role');
    assert.deepEqual(await asOwner((s) => roleProblems(s, role)), []);
    const held = await asOwner((s) => rolePrivileges(s, role));
    assert.deepEqual(held.filter((entry) => !entry.startsWith('function ')), grantedEntries(), 'exactly RUNTIME_GRANTS, nothing through ownership');
    assert.ok(held.includes('function public.hub_append_only() EXECUTE'));

    const kit = await openRecords(kitConfig(), { migrate: false, keyProvider });
    try {
      await kit.vault.initKey();
      const { user } = await kit.principals.bootstrapAdmin('管理员');
      privateOwner=user;
      const team = await kit.teams.create(user, '合成权限团队');
      const member = await kit.principals.createUser(user, '合成权限成员');
      const outsider = await kit.principals.createUser(user, '合成未授权成员');
      const membership = await kit.teams.add(user, team.id, member.id);
      await kit.authorizations.assignResource(user, 'synthetic-team-resource', team.id);
      await withSession(control.applicationConnector, control.target.database, async session => {
        try {
          await session.query('UPDATE teams SET name=$2,deleted_at=now() WHERE id=$1', [team.id, '合成投影改写']);
          await session.query('DELETE FROM team_members WHERE team_id=$1 AND user_id=$2', [team.id, member.id]);
          await session.query('INSERT INTO team_members(team_id,user_id,added_at,added_by) VALUES($1,$2,$3,$4)', [team.id, outsider.id, membership.added_at, user.id]);
          assert.equal((await kit.teams.get(user, team.id))?.name, team.name, 'mutable projection cannot rewrite the verified team definition');
          assert.deepEqual((await kit.teams.members(user, team.id)).map(row => row.user.id), [member.id], 'projection writes cannot grant or revoke membership');
          assert.equal(await kit.authorizations.canUseResource(member.id, 'synthetic-team-resource'), true);
          assert.equal(await kit.authorizations.canUseResource(outsider.id, 'synthetic-team-resource'), false, 'inserting a projection row cannot mint authority');
        } finally {
          await session.query('DELETE FROM team_members WHERE team_id=$1 AND user_id=$2', [team.id, outsider.id]);
          await session.query('INSERT INTO team_members(team_id,user_id,added_at,added_by) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [team.id, member.id, membership.added_at, user.id]);
          await session.query('UPDATE teams SET name=$2,deleted_at=NULL WHERE id=$1', [team.id, team.name]);
        }
      });
      await kit.store.withTransaction(async tx=>{
        const source=await kit.artifacts.ingest({personalOwner:user.id,bytes:runOriginalBytes,mediaType:'text/plain',name:'synthetic-held.txt',origin:{upload:{session:null,message:null}},author:{user:user.id},provenanceType:'declared',visibility:{readers:[user.id],admins:false,packs:[],shareable:false}},tx);
        heldOriginal=source.digest;heldOriginalSha=source.body.sha256;
        heldPersonalLink=(await kit.store.put({kind:'knowledge_space_source',schema:'knowledge-space-source@1',provenance:'declared',body:{space:user.id,path:'/',sha256:heldOriginalSha,artifact:heldOriginal,size:runOriginalBytes.length,by:user.id,at:source.created_at}},tx)).digest;
      });
      await kit.store.put({kind:'run',schema:'run@1',provenance:'observed',body:{run:'run_'+'1'.repeat(26),runner:user.id,sources:[{reference:'src:'+heldOriginalSha,artifact:heldOriginal,upload_declaration:{by:user.id}}]}});
      const api=kit.personalSync!,state=await api.state(user);syncEpoch=state.epoch;
      const client_id='33333333-3333-4333-8333-333333333333';await api.registerClient(user,{client_id,name:'synthetic-backup-client'});
      syncSession=(await api.openSession(user,{client_id,epoch:syncEpoch,known_state:null,base_snapshot:null})).session_id;
      const bytes=encodePersonalSyncObject({schema:'personal-sync-object@1',kind:'bytes',body:{bytes_base64:Buffer.from('synthetic backup transport').toString('base64')}});
      syncObject={id:sha256Hex(bytes),bytes_base64:Buffer.from(bytes).toString('base64')};
      await api.upload(user,syncSession,{schema:'personal-sync-upload@1',epoch:syncEpoch,operation_id:'synthetic-backup-operation',objects:[syncObject]});
      privateDigest=(await kit.store.put({kind:'memory_version',schema:'memory-version@1',provenance:'declared',body:{space:user.id,markdown:'synthetic-private-backup'}})).digest;
      for (let n = 0; n < 5; n++) {
        const record = await kit.store.put({ kind: 'claim', schema: 'synthetic-claim@1', provenance: 'declared', body: { n, text: `合成 ${n}` }, unique_key: `synthetic.${n}`, index: [{ key: 'synthetic.n', value: String(n) }] });
        appended.push({ id: record.id, digest: record.digest });
      }
      await kit.objects.put(Buffer.from('合成对象'), 'text/plain');
      await kit.callLog.append({ traceId: 'a'.repeat(32), userId: user.id, sessionId: null, tool: 'get_nodes', runId: null, arguments: { n: 1 }, callResult: 'error', errorCode: 'SOURCE_UNAVAILABLE', durationMs: 1, adminNote: '合成原因' });
      await kit.pointers.move({ name: 'synthetic/a', expected: null, next: sha256Hex('a') });
      await kit.vault.put('synthetic.entry', '合成');
    } finally {
      await kit.close();
    }
    assert.deepEqual(await notRefused(), []);
    const [count] = await asOwner((s) => s.query('SELECT count(*)::int AS n FROM records'));
    assert.ok(Number(count?.n) >= 5, 'the history is still there');
    // The check is not vacuous: with a DELETE grant the statement gets past the privileges and only the trigger stops it.
    await asOwner((s) => s.query(`GRANT DELETE ON records TO ${role}`));
    try {
      assert.deepEqual(await notRefused(), ['DELETE FROM records -> HU001']);
    } finally {
      await asOwner((s) => s.query(`REVOKE DELETE ON records FROM ${role}`));
    }
    assert.deepEqual(await notRefused(), []);
  });

  test('after a backup, a destroy and a restore the owner owns everything, the grants are the same and the refusals hold', async () => {
    const role = control.application.user;
    const before = await asOwner(async (s) => ({ tables: await summarizeTables(s), privileges: await rolePrivileges(s, role) }));
    const { dir, manifest } = await createBackup({ layout, postgres: control, libpqBin: libpq!, label: 'records' });
    await verifyBackup(dir);
    const clearing=await openRecords(kitConfig(),{migrate:false,keyProvider});
    try{const state=await clearing.personalPayloads!.inspect(privateDigest);await clearing.personalPayloads!.purge(privateOwner,state!.epoch);assert.equal(await clearing.store.get(privateDigest),null);// Owner ruling 3 (issue 141): the purge also removes the run-held copy of the personal original.
    assert.equal(await clearing.store.get(heldOriginal),null);assert.equal(await clearing.store.get(heldPersonalLink),null);assert.equal(await clearing.objects.get(heldOriginalSha),null);}finally{await clearing.close();}
    assert.deepEqual(manifest.database.application_role, { name: role, privileges: before.privileges });

    assert.equal(await control.stop(), true);
    for (const area of [layout.db, layout.objects, layout.vault]) await rm(area, { recursive: true, force: true });
    control = createPostgres({ layout, port });
    const report = await restoreBackup({ layout, backupDir: dir, postgres: control, libpqBin: libpq! });
    assert.equal(report.privileges, before.privileges.length);

    assert.deepEqual(await asOwner(summarizeTables), before.tables);
    assert.deepEqual(await owners(), [control.target.user], 'restored objects belong to the restoring superuser role');
    assert.deepEqual(await asOwner((s) => roleProblems(s, role)), []);
    assert.deepEqual(await asOwner((s) => rolePrivileges(s, role)), before.privileges);
    assert.deepEqual(await notRefused(), []);

    // Re-granting through the records package changes nothing: the dump carried exactly RUNTIME_GRANTS.
    assert.deepEqual(await migrateRecords({ database: database(control.target.user) }, { runtimeRole: role }), []);
    assert.deepEqual(await asOwner((s) => rolePrivileges(s, role)), before.privileges);

    // The kit opens again as the application role without migrating, reads what was appended and appends more.
    const kit = await openRecords(kitConfig(), { migrate: false, keyProvider });
    try {
      for (const record of appended) assert.equal((await kit.store.get(record.digest))?.id, record.id);
      assert.equal(await kit.vault.getText('synthetic.entry'), '合成');
      assert.equal((await kit.store.get<{markdown:string}>(privateDigest))?.body.markdown,'synthetic-private-backup','the earlier backup restores content cleared after it was taken');
      assert.deepEqual((await kit.personalSync!.download(privateOwner,syncSession,{epoch:syncEpoch,objects:[syncObject.id]})).objects,[syncObject]);
      assert.equal((await kit.personalSync!.operation(privateOwner,syncEpoch,'synthetic-backup-operation'))?.counts.accepted,1);
      assert.ok(await kit.store.get(heldOriginal));assert.ok(await kit.store.get(heldPersonalLink));assert.deepEqual(Buffer.from((await kit.objects.get(heldOriginalSha))!),runOriginalBytes);
      const restored=await kit.personalPayloads!.inspect(privateDigest);assert.equal(restored?.cleared,false);
      await kit.personalPayloads!.purge(privateOwner,restored!.epoch);assert.equal(await kit.store.get(privateDigest),null);assert.equal(await kit.store.get(heldPersonalLink),null);assert.equal(await kit.store.get(heldOriginal),null);assert.equal(await kit.objects.get(heldOriginalSha),null);
      assert.equal((await kit.store.getByKey('claim', 'synthetic.0'))?.digest, appended[0].digest, 'unique business identities survive the restore');
      await kit.store.put({ kind: 'claim', schema: 'synthetic-claim@1', provenance: 'declared', body: { n: 99, text: '恢复之后' } });
    } finally {
      await kit.close();
    }
    assert.deepEqual(await notRefused(), []);
  });

  test('a new deployment accepts exactly the application role names the records migration grants', async () => {
    const owner = database(control.target.user);
    const names = ['circle_hub', 'hub_app', '_hub', 'a'.repeat(63), 'hub-app', 'Hub_App', 'hub$app', 'hub.app', '9hub', 'a'.repeat(64)];
    for (const name of names) {
      const settings = (() => {
        try {
          newSettingsFile({ environment: 'test', database: { role: name } });
          return true;
        } catch {
          return false;
        }
      })();
      const variable = (() => {
        try {
          resolveDatabaseNames(layoutAt('/srv/hub'), { CIRCLE_HUB_DATABASE_USER: name });
          return true;
        } catch {
          return false;
        }
      })();
      // grantRuntime refuses a name it does not accept with a TypeError before any SQL; a missing role fails later.
      const granted = await migrateRecords({ database: owner }, { runtimeRole: name }).then(
        () => true,
        (error: unknown) => !(error instanceof TypeError),
      );
      assert.deepEqual([settings, variable], [granted, granted], name);
    }
    assert.deepEqual(await asOwner((s) => roleProblems(s, control.application.user)), []);
  });
});

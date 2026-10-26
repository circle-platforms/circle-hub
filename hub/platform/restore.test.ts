// Restore failure handling with fake tools: a restore that fails half way moves its partial state aside so the data
// root is empty again; nothing that existed before is overwritten.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { BACKUP_SCHEMA, DUMP_FILE, MANIFEST_FILE } from './backup.ts';
import { isMissingOrEmpty } from './files.ts';
import { ensureLayout, layoutAt, type Layout } from './layout.ts';
import { createPostgres } from './postgres.ts';
import { treeEntries, writeSyntheticPacks } from './rehearse.ts';
import { assertRestorable, restoreBackup, setAside } from './restore.ts';
import type { SqlConnector } from './sql.ts';
import { exit, ok, recordingRunner, removeDir, tempDir, type Call } from './test-support.ts';

const binaries = { initdb: '/fake/bin/initdb', pg_ctl: '/fake/bin/pg_ctl', postgres: '/fake/bin/postgres' };
const roots: string[] = [];
after(async () => {
  for (const root of roots) await removeDir(root);
});

async function scratch(): Promise<string> {
  const dir = await tempDir();
  roots.push(dir);
  return dir;
}

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const PRIVILEGES = ['database CONNECT', 'schema public USAGE'];

async function backupWith(files: Record<string, string>, role = 'circle_hub'): Promise<string> {
  const dir = join(await scratch(), 'backup');
  await mkdir(dir, { recursive: true });
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(dir, path, '..'), { recursive: true });
    await writeFile(join(dir, path), text);
  }
  await writeFile(
    join(dir, MANIFEST_FILE),
    JSON.stringify({
      schema: BACKUP_SCHEMA,
      created_at: '2026-10-21T12:00:00.000Z',
      database: {
        name: 'circle_hub',
        server_version: '18.4',
        dump_tool: 'pg_dump (PostgreSQL) 18.6',
        tables: [],
        application_role: { name: role, privileges: PRIVILEGES },
      },
      files: Object.entries(files).map(([path, text]) => ({ path, size: Buffer.byteLength(text), sha256: sha(text) })),
    }),
  );
  return dir;
}

async function fakeLibpq(): Promise<string> {
  const dir = await scratch();
  for (const tool of ['pg_dump', 'pg_restore']) await writeFile(join(dir, tool), '');
  return dir;
}

/** Fake PostgreSQL tools; `fail` names the step that fails. initdb leaves a partial file behind like a real crash. */
function tools(layout: Layout, fail: 'initdb' | 'pg_restore' | 'nothing') {
  const state = { running: false };
  return recordingRunner(
    async (call: Call) => {
      if (call.command === binaries.postgres) return ok('postgres (PostgreSQL) 18.4\n');
      if (call.command.endsWith('pg_restore') && call.args[0] === '--version') return ok('pg_restore (PostgreSQL) 18.6\n');
      if (call.command === binaries.initdb) {
        await writeFile(join(layout.db, 'partial-file'), 'half written');
        if (fail === 'initdb') return exit(1, 'initdb: synthetic failure');
        await writeFile(join(layout.db, 'PG_VERSION'), '18\n');
        return ok();
      }
      if (call.command === binaries.pg_ctl && call.args[0] === 'status') return state.running ? ok('server is running (PID: 1)') : exit(3);
      if (call.command === binaries.pg_ctl && call.args[0] === 'start') {
        state.running = true;
        await writeFile(join(layout.db, 'postmaster.pid'), '1\n');
        return ok();
      }
      if (call.command === binaries.pg_ctl && call.args[0] === 'stop') {
        state.running = false;
        const { rm } = await import('node:fs/promises');
        await rm(join(layout.db, 'postmaster.pid'), { force: true });
        return ok();
      }
      if (call.command.endsWith('pg_restore')) return fail === 'pg_restore' ? exit(1, 'pg_restore: error: synthetic failure') : ok();
      return undefined;
    },
    { real: false },
  );
}

/** No tables; the application role exists, holds PRIVILEGES and nothing else (the queries of roles.ts). */
const connector: SqlConnector = async () => ({
  query: async (text: string) => {
    if (text.includes("current_setting('server_version_num')::int AS version")) return [{ oid: 16384, version: 180004 }];
    if (text.includes("'database ' || p AS entry")) return PRIVILEGES.map((entry) => ({ entry }));
    if (text.includes('AS temporary_database')) {
      return [{ rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false, create_database: false, temporary_database: false, create_schemas: [], member_of: [], owned: 0, examples: [] }];
    }
    return [];
  },
  close: async () => {},
});

for (const fail of ['initdb', 'pg_restore'] as const) {
  test(`a restore failing at ${fail} moves its partial state aside so a retry finds an empty data root`, async () => {
    const layout = layoutAt(join(await scratch(), 'root'));
    await ensureLayout(layout);
    const backupDir = await backupWith({ [DUMP_FILE]: 'PGDMP', 'objects/ab/cd': 'object', 'config/platform.json': '{"backup":true}' });
    const { runner } = tools(layout, fail);
    const postgres = createPostgres({ layout, binaries, runner, connector });
    await assert.rejects(restoreBackup({ layout, backupDir, postgres, runner, libpqBin: await fakeLibpq() }), (error: unknown) => {
      assert.match((error as Error).message, new RegExp(`恢复失败：.*${fail === 'initdb' ? 'initdb 失败' : 'pg_restore 失败'}`));
      assert.match(String((error as { hint?: string }).hint), /半成品已移到 .*set-aside.*可以重试/);
      return true;
    });
    assert.ok(await isMissingOrEmpty(layout.db));
    await assertRestorable(layout);
    const aside = await readdir(layout.setAside);
    assert.equal(aside.length, 1);
    assert.match(aside[0]!, /-failed-restore$/);
  });
}

test('a restore keeps a differing config file of the data root, reports it, and copies the data files', async () => {
  const layout = layoutAt(join(await scratch(), 'root'));
  await ensureLayout(layout);
  await writeFile(join(layout.config, 'platform.json'), '{"local":true}');
  await writeFile(join(layout.logs, 'keep.log'), 'not data');
  await assertRestorable(layout);
  const backupDir = await backupWith({ [DUMP_FILE]: 'PGDMP', 'objects/ab/cd': 'object', 'vault/v': 'sealed', 'config/platform.json': '{"backup":true}' });
  const { runner, calls } = tools(layout, 'nothing');
  const report = await restoreBackup({ layout, backupDir, postgres: createPostgres({ layout, binaries, runner, connector }), runner, libpqBin: await fakeLibpq() });
  assert.deepEqual(report.keptConfig, ['config/platform.json']);
  assert.equal(report.files, 2);
  assert.equal(report.privileges, PRIVILEGES.length);
  // As the superuser role, objects owned by it, the dump's grants kept: no --role, no --no-privileges.
  const restore = calls.find((call) => call.command.endsWith('pg_restore') && call.args[0] !== '--version');
  assert.ok(restore?.args.includes('--no-owner'));
  assert.ok(restore?.args.some((arg) => arg.startsWith('--username=')));
  assert.ok(!restore?.args.some((arg) => arg.startsWith('--role') || arg === '--no-privileges' || arg === '--no-acl'), restore?.args.join(' '));
  assert.equal(await readFile(join(layout.config, 'platform.json'), 'utf8'), '{"local":true}', 'never overwritten');
  assert.equal(await readFile(join(layout.objects, 'ab', 'cd'), 'utf8'), 'object');
  assert.equal(await readFile(join(layout.logs, 'keep.log'), 'utf8'), 'not data');
  await assert.rejects(assertRestorable(layout), /只能恢复到空的数据根/);
});

test('a backup whose application role has another name is refused before anything is created', async () => {
  const layout = layoutAt(join(await scratch(), 'root'));
  await ensureLayout(layout);
  const backupDir = await backupWith({ [DUMP_FILE]: 'PGDMP', 'objects/ab/cd': 'object' }, 'other_app');
  const { runner, calls } = tools(layout, 'nothing');
  await assert.rejects(restoreBackup({ layout, backupDir, postgres: createPostgres({ layout, binaries, runner, connector }), runner, libpqBin: await fakeLibpq() }), (error: unknown) => {
    assert.match((error as Error).message, /备份里的应用角色是 other_app，这个数据根的部署设置是 circle_hub：备份里的授权给的是 other_app，不恢复/);
    assert.match(String((error as { hint?: string }).hint), /database\.role/);
    return true;
  });
  assert.deepEqual(calls, [], 'no tool ran');
  assert.ok(await isMissingOrEmpty(layout.db));
  await assertRestorable(layout);
});

test('extracted pack trees are not data: a root that holds them is still empty for a restore, which leaves them as they are, and so does setAside', async () => {
  const layout = layoutAt(join(await scratch(), 'root'));
  await ensureLayout(layout);
  assert.ok((await writeSyntheticPacks(layout)) > 0);
  const packs = await treeEntries(layout.packs);
  assert.ok([...packs.values()].some((entry) => entry === '目录 0500'), 'read-only directories, as the registry leaves them');
  await assertRestorable(layout);
  const backupDir = await backupWith({ [DUMP_FILE]: 'PGDMP', 'objects/ab/cd': 'object', 'vault/v': 'sealed' });
  const { runner } = tools(layout, 'nothing');
  const postgres = createPostgres({ layout, binaries, runner, connector });
  const report = await restoreBackup({ layout, backupDir, postgres, runner, libpqBin: await fakeLibpq() });
  assert.equal(report.files, 2);
  assert.deepEqual(await treeEntries(layout.packs), packs, 'the restore did not touch them');
  // A failed deploy or a rollback stops the cluster and moves the data aside; the pack trees stay.
  assert.equal(await postgres.stop(), true);
  const aside = await setAside(layout, 'failed-deploy');
  assert.deepEqual((await readdir(aside!)).sort(), ['db', 'objects', 'vault']);
  assert.deepEqual(await treeEntries(layout.packs), packs);
  await assertRestorable(layout);
});

test('setAside moves data areas only and recreates them empty', async () => {
  const layout = layoutAt(join(await scratch(), 'root'));
  await ensureLayout(layout);
  assert.equal(await setAside(layout, 'nothing'), undefined);
  await writeFile(join(layout.objects, 'o'), 'x');
  await writeFile(join(layout.backups, 'b'), 'kept');
  const dir = await setAside(layout, 'Failed Deploy!', new Date('2026-10-21T12:00:00Z'));
  assert.match(dir ?? '', /set-aside\/20261021T120000Z-failed-deploy$/);
  assert.deepEqual(await readdir(dir!), ['objects']);
  assert.ok(await isMissingOrEmpty(layout.objects));
  assert.equal(await readFile(join(layout.backups, 'b'), 'utf8'), 'kept');
});

// Integration: a real PostgreSQL from the pinned binaries in a temporary data root, through postgres.ts, backup.ts and
// restore.ts. Backup and restore cases skip only when pg_dump and pg_restore are absent.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createBackup, listBackups, pruneBackups, verifyBackup } from './backup.ts';
import { isMissingOrEmpty, listFiles, sha256File } from './files.ts';
import { portAnswers } from './health.ts';
import { ensureLayout, layoutAt, socketFile, type Layout } from './layout.ts';
import { createPostgres, ensureDatabaseRunning, type PostgresControl } from './postgres.ts';
import { runCommand } from './process.ts';
import { restoreBackup, setAside } from './restore.ts';
import { rolePrivileges } from './roles.ts';
import { socketConnector, summarizeTables, withSession } from './sql.ts';
import { libpqAvailable, LIBPQ_MISSING, ownerTables, removeDir, socketPort, sqlState, tempDir } from './test-support.ts';

const libpq = await libpqAvailable();
const port = socketPort();
const roots: string[] = [];
const clusters: PostgresControl[] = [];

async function freshRoot(): Promise<Layout> {
  const root = await tempDir();
  roots.push(root);
  const layout = layoutAt(root);
  await ensureLayout(layout);
  return layout;
}

function cluster(layout: Layout): PostgresControl {
  const control = createPostgres({ layout, port });
  clusters.push(control);
  return control;
}

after(async () => {
  for (const control of clusters) await control.stop().catch(() => {});
  for (const root of roots) await removeDir(root);
});

describe('a persistent cluster in a temporary data root', () => {
  let layout: Layout;
  let control: PostgresControl;

  before(async () => {
    layout = await freshRoot();
    control = cluster(layout);
    assert.equal(await control.initialise(), true);
    assert.deepEqual(await ensureDatabaseRunning(control, { create: true }), { started: true, created: true });
  });

  test('listens on a private unix socket only: no TCP, no listen address', async () => {
    const [row] = await withSession(control.connector, control.target.database, (s) =>
      s.query("SELECT current_setting('listen_addresses') AS listen, current_setting('unix_socket_permissions') AS mode"),
    );
    assert.deepEqual(row, { listen: '', mode: '0700' });
    assert.equal((await stat(layout.run)).mode & 0o777, 0o700);
    const socket = await stat(socketFile(layout, port));
    assert.ok(socket.isSocket());
    assert.equal(socket.mode & 0o777, 0o700);
    assert.equal((await stat(layout.db)).mode & 0o777, 0o700);
    // Precise check: the postmaster itself holds no TCP socket. Without lsof, fall back to probing the port.
    const pid = (await control.status()).pid;
    const lsof = ['/usr/sbin/lsof', '/usr/bin/lsof'].find((path) => existsSync(path));
    if (lsof && pid) {
      const sockets = await runCommand(lsof, ['-nP', '-a', '-p', String(pid), '-iTCP']);
      assert.equal(sockets.stdout.trim(), '', 'the postmaster has no TCP socket');
    } else {
      assert.equal(await portAnswers(port), false, 'nothing answers on TCP');
    }
  });

  test('peer authentication admits only the owner, as its superuser role or the non-superuser application role', async () => {
    const [admin] = await withSession(control.connector, 'postgres', (s) => s.query('SELECT rolsuper, current_user AS name FROM pg_roles WHERE rolname = current_user'));
    assert.equal(admin?.rolsuper, true);
    const [app] = await withSession(control.applicationConnector, control.target.database, (s) =>
      s.query(
        `SELECT r.rolsuper, r.rolcreaterole, r.rolcreatedb, pg_get_userbyid(d.datdba) AS owner
           FROM pg_roles r, pg_database d WHERE r.rolname = current_user AND d.datname = current_database()`,
      ),
    );
    // The database belongs to the superuser role: its owner would own the public schema and could drop the append-only tables.
    assert.deepEqual(app, { rolsuper: false, rolcreaterole: false, rolcreatedb: false, owner: admin?.name });
    const stranger = socketConnector({ socketDir: layout.run, port, user: 'postgres' });
    await assert.rejects(stranger('postgres'), /连不上数据库/);
    // PUBLIC may connect to postgres and template1 and create temporary tables there: the application role is kept out.
    for (const other of ['postgres', 'template1']) {
      await assert.rejects(control.applicationConnector(other), /连不上数据库.*no pg_hba\.conf entry/, other);
      assert.deepEqual(await withSession(control.connector, other, (s) => s.query('SELECT current_database()::text AS name')), [{ name: other }]);
    }
  });

  test('the application role connects but owns nothing: it cannot create, alter or drop in the database', async () => {
    await withSession(control.connector, control.target.database, (s) => s.query('CREATE TABLE IF NOT EXISTS owner_probe (id integer)'));
    try {
      await withSession(control.applicationConnector, control.target.database, async (s) => {
        await assert.rejects(s.query('DROP TABLE owner_probe'), /owner_probe|所有者|owner/i);
        await assert.rejects(s.query('ALTER TABLE owner_probe ADD COLUMN x integer'), /owner|所有者/i);
        await assert.rejects(s.query('CREATE TABLE app_made (id integer)'), /permission|权限|denied|拒绝/i);
        await assert.rejects(s.query('CREATE SCHEMA app_schema'), /permission|权限|denied|拒绝/i);
      });
    } finally {
      await withSession(control.connector, control.target.database, (s) => s.query('DROP TABLE IF EXISTS owner_probe'));
    }
  });

  test('initialise again leaves the cluster alone; start again is a no-op', async () => {
    assert.equal(await control.initialise(), false);
    assert.equal(await control.start(), false);
    assert.equal(await control.ensureDatabase(), false);
    assert.equal((await control.status()).running, true);
  });

  test('a data directory of another major version is refused before pg_ctl start', async () => {
    assert.equal(await control.stop(), true);
    assert.equal((await control.status()).running, false);
    const versionFile = join(layout.db, 'PG_VERSION');
    const original = await readFile(versionFile, 'utf8');
    await writeFile(versionFile, `${Number(original.trim()) - 1}\n`);
    try {
      await assert.rejects(cluster(layout).start(), /的格式，当前二进制是 PostgreSQL \d+，不启动/);
      assert.equal((await control.status()).running, false);
    } finally {
      await writeFile(versionFile, original);
    }
    assert.equal(await control.start(), true);
  });

  test('setAside refuses while the cluster runs', async () => {
    await assert.rejects(setAside(layout, 'test'), /还在运行/);
  });

  test('a missing Hub database is refused, not created, unless creation is asked for (init and restore)', async () => {
    await withSession(control.connector, 'postgres', (s) => s.query(`DROP DATABASE ${control.target.database}`));
    await assert.rejects(ensureDatabaseRunning(control), /数据库 circle_hub（或它的角色 circle_hub）不存在，不新建/);
    assert.equal(await control.databaseExists(), false);
    assert.deepEqual(await ensureDatabaseRunning(control, { create: true }), { started: false, created: true });
    assert.deepEqual(await ensureDatabaseRunning(control), { started: false, created: false });
  });
});

describe('backup, destroy, restore and compare', { skip: libpq ? false : LIBPQ_MISSING }, () => {
  let layout: Layout;
  let control: PostgresControl;
  let backupDir: string;
  let tablesBefore: Awaited<ReturnType<typeof summarizeTables>>;
  let privilegesBefore: string[];
  const objectBytes = Buffer.from('synthetic object \u0000 with NUL and 中文');

  before(async () => {
    layout = await freshRoot();
    control = cluster(layout);
    await control.initialise();
    await ensureDatabaseRunning(control, { create: true });
    // The owner creates the tables and grants SELECT and INSERT; the rows are written as the application role.
    await ownerTables(
      control,
      ['CREATE TABLE synthetic_records (id text PRIMARY KEY, body jsonb NOT NULL, at timestamptz NOT NULL, raw bytea)', 'CREATE TABLE synthetic_empty (id int)'],
      ['synthetic_records', 'synthetic_empty'],
    );
    await withSession(control.applicationConnector, control.target.database, async (s) => {
      for (let n = 0; n < 40; n++) {
        await s.query('INSERT INTO synthetic_records VALUES ($1, $2, $3, $4)', [
          `rcd_${String(n).padStart(26, '0')}`,
          JSON.stringify({ n, text: `合成 ${n}`, quote: '"x"' }),
          new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString(),
          Buffer.from([n, 0, 255]),
        ]);
      }
    });
    const digest = (await import('node:crypto')).createHash('sha256').update(objectBytes).digest('hex');
    await mkdir(join(layout.objects, digest.slice(0, 2)), { recursive: true });
    // Records stores objects read-only (0400); the mode must survive backup and restore.
    await writeFile(join(layout.objects, digest.slice(0, 2), digest), objectBytes, { mode: 0o400 });
    await writeFile(join(layout.vault, 'entry.bin'), Buffer.from('sealed synthetic entry'));
    await writeFile(join(layout.config, 'platform.json'), '{"synthetic":true}\n');
    tablesBefore = await withSession(control.connector, control.target.database, summarizeTables);
    privilegesBefore = await withSession(control.connector, control.target.database, (s) => rolePrivileges(s, control.application.user));
    // A pinned clock: the prune test below takes two more backups within this same second.
    const result = await createBackup({ layout, postgres: control, label: 'integration', now: () => new Date('2026-10-21T20:36:02.100Z') });
    backupDir = result.dir;
  });

  test('the backup lists the dump, every file with SHA-256, per-table rows and digests, and the application role privileges', async () => {
    assert.match(backupDir, /\/backups\/\d{8}T\d{6}Z-integration$/);
    const manifest = await verifyBackup(backupDir);
    assert.deepEqual(
      manifest.files.map((file) => file.path.split('/')[0]),
      ['config', 'database.dump', 'objects', 'vault'],
    );
    assert.deepEqual(manifest.database.tables, tablesBefore);
    assert.deepEqual(manifest.database.application_role, { name: 'circle_hub', privileges: privilegesBefore });
    for (const entry of ['database CONNECT', 'schema public USAGE', 'table public.synthetic_records INSERT', 'table public.synthetic_records SELECT']) {
      assert.ok(privilegesBefore.includes(entry), entry);
    }
    assert.ok(!privilegesBefore.some((entry) => /DELETE|TRUNCATE|UPDATE|TRIGGER|database (CREATE|TEMPORARY)|schema \S+ CREATE/.test(entry)), privilegesBefore.join('\n'));
    const records = manifest.database.tables.find((table) => table.table === 'synthetic_records');
    assert.equal(records?.rows, 40);
    assert.equal(manifest.database.tables.find((table) => table.table === 'synthetic_empty')?.rows, 0);
    assert.ok(!(await listFiles(layout.backups)).some((path) => path.startsWith('.partial')));
  });

  test('a tampered copy fails verification and a restore from it touches nothing', async () => {
    const tampered = join(await tempDir(), 'tampered');
    roots.push(join(tampered, '..'));
    await cp(backupDir, tampered, { recursive: true });
    const object = (await listFiles(join(tampered, 'objects')))[0]!;
    // Backed-up objects keep their read-only mode; corruption is simulated by forcing a write.
    await chmod(join(tampered, 'objects', object), 0o600);
    await writeFile(join(tampered, 'objects', object), Buffer.from('changed'));
    await assert.rejects(verifyBackup(tampered), /校验不通过/);
    const target = await freshRoot();
    await assert.rejects(restoreBackup({ layout: target, backupDir: tampered, postgres: cluster(target) }), /校验不通过/);
    assert.ok(await isMissingOrEmpty(target.db), 'no cluster was created');
  });

  test('restore into a data root that has data is refused', async () => {
    await assert.rejects(restoreBackup({ layout, backupDir, postgres: control }), /只能恢复到空的数据根/);
  });

  test('destroy and restore reproduce every row, table digest and file, owned by the superuser role with the application role grants', async () => {
    const filesBefore = await listFiles(layout.objects);
    assert.equal(await control.stop(), true);
    for (const area of [layout.db, layout.objects, layout.vault]) await rm(area, { recursive: true, force: true });
    const restored = cluster(layout);
    const report = await restoreBackup({ layout, backupDir, postgres: restored });
    assert.equal(report.rows, 40);
    assert.equal(report.tables, tablesBefore.length);
    assert.equal(report.files, 2, 'one object and one vault file copied');
    assert.equal(report.privileges, privilegesBefore.length);
    assert.deepEqual(report.keptConfig, [], 'the identical config file was left in place');
    assert.deepEqual(await withSession(restored.connector, restored.target.database, summarizeTables), tablesBefore);
    assert.deepEqual(await listFiles(layout.objects), filesBefore);
    const object = filesBefore[0]!;
    assert.equal((await sha256File(join(layout.objects, object))).sha256, object.split('/')[1]);
    assert.equal((await stat(join(layout.objects, object))).mode & 0o777, 0o400, 'object mode kept');
    assert.equal((await stat(join(layout.vault, 'entry.bin'))).mode & 0o777, 0o600);
    const owners = await withSession(restored.connector, restored.target.database, (s) =>
      s.query(
        `SELECT pg_get_userbyid(d.datdba) AS database, (SELECT array_agg(DISTINCT tableowner::text) FROM pg_tables WHERE schemaname = 'public') AS tables
           FROM pg_database d WHERE d.datname = current_database()`,
      ),
    );
    assert.deepEqual(owners, [{ database: restored.target.user, tables: [restored.target.user] }], 'the database and every table belong to the superuser role');
    assert.deepEqual(await withSession(restored.connector, restored.target.database, (s) => rolePrivileges(s, restored.application.user)), privilegesBefore);
    await withSession(restored.applicationConnector, restored.target.database, async (s) => {
      const [row] = await s.query("SELECT body->>'text' AS text, encode(raw, 'hex') AS raw FROM synthetic_records WHERE id = $1", [`rcd_${'7'.padStart(26, '0')}`]);
      assert.deepEqual(row, { text: '合成 7', raw: '0700ff' });
      for (const statement of ['DELETE FROM synthetic_records', 'TRUNCATE synthetic_records', 'DROP TABLE synthetic_records', 'ALTER TABLE synthetic_records DISABLE TRIGGER ALL', "UPDATE synthetic_records SET body = '{}'"]) {
        assert.equal(await sqlState(s, statement), '42501', statement);
      }
    });
    control = restored;
  });

  test('prune keeps the newest backups, in the order they were taken even within one second', async () => {
    // By name, `20261021T203602Z` would sort before the earlier `20261021T203602Z-integration`.
    const second = await createBackup({ layout, postgres: control, now: () => new Date('2026-10-21T20:36:02.200Z') });
    const third = await createBackup({ layout, postgres: control, label: 'again', now: () => new Date('2026-10-21T20:36:02.300Z') });
    assert.match(second.dir, /\/20261021T203602Z$/);
    assert.deepEqual(await listBackups(layout), [backupDir, second.dir, third.dir]);
    const removed = await pruneBackups(layout, 2);
    assert.deepEqual(removed, [backupDir]);
    assert.deepEqual(await listBackups(layout), [second.dir, third.dir]);
  });
});

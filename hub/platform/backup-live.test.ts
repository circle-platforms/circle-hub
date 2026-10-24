// Integration: backups of a live data root on a real PostgreSQL (pinned binaries) while synthetic writers use the
// records stores' file patterns, object reuse between backups, and refusals. Skips only when pg_dump/pg_restore are absent.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { chmod, cp, link, mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { after, afterEach, describe, test } from 'node:test';
import { createBackup, listBackups, MANIFEST_FILE, verifyBackup, type BackupManifest } from './backup.ts';
import { isMissingOrEmpty, listFiles } from './files.ts';
import { ensureLayout, layoutAt, type Layout } from './layout.ts';
import { createPostgres, ensureDatabaseRunning, type PostgresControl } from './postgres.ts';
import { treeEntries, writeSyntheticPacks } from './rehearse.ts';
import { assertRestorable, restoreBackup, setAside } from './restore.ts';
import { inspectRole, roleFixHint, rolePrivileges, type RoleReport } from './roles.ts';
import { withSession, summarizeTables } from './sql.ts';
import { libpqAvailable, LIBPQ_MISSING, ownerTables, removeDir, socketPort, tempDir } from './test-support.ts';

const libpq = await libpqAvailable();
const roots: string[] = [];
const clusters: PostgresControl[] = [];

// Each case owns independent roots. Do not retain clusters until file end: macOS has a small system-wide SHMMNI.
async function cleanup(): Promise<void> {
  for (const control of clusters.splice(0)) await control.stop().catch(() => {});
  for (const root of roots.splice(0)) await removeDir(root);
}
afterEach(cleanup);
after(cleanup);

async function liveRoot(): Promise<{ layout: Layout; control: PostgresControl }> {
  const root = await tempDir();
  roots.push(root);
  const layout = layoutAt(root);
  await ensureLayout(layout);
  const control = createPostgres({ layout, port: socketPort() });
  clusters.push(control);
  await control.initialise();
  await ensureDatabaseRunning(control, { create: true });
  // Created by the owner with an identity column, like the records tables; appended to by the application role.
  await ownerTables(control, ['CREATE TABLE synthetic_records (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, body text NOT NULL)'], ['synthetic_records']);
  await withSession(control.applicationConnector, control.target.database, (s) =>
    s.query("INSERT INTO synthetic_records (body) SELECT '合成 ' || n FROM generate_series(1, 50) AS n"),
  );
  await writeFile(join(layout.config, 'platform.json'), '{"synthetic":true}\n', { mode: 0o600 });
  return { layout, control };
}

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Stores an object exactly as the records object store does: read-only temporary, write, sync, link, unlink. */
async function storeObject(layout: Layout, bytes: Uint8Array): Promise<string> {
  const digest = sha(bytes);
  const directory = join(layout.objects, digest.slice(0, 2));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.${digest}.${randomBytes(8).toString('hex')}.tmp`);
  const handle = await open(temporary, 'wx', 0o400);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporary, join(directory, digest));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  } finally {
    await unlink(temporary).catch(() => {});
  }
  return digest;
}

/** Replaces a vault entry as the records vault does: temporary beside it, then rename over it. */
async function putVaultEntry(layout: Layout, name: string, bytes: Uint8Array): Promise<void> {
  const target = join(layout.vault, `${name}.sealed`);
  const temporary = `${target}.${randomBytes(8).toString('hex')}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, target);
}

const manifestOf = async (dir: string): Promise<BackupManifest> => JSON.parse(await readFile(join(dir, MANIFEST_FILE), 'utf8')) as BackupManifest;

describe('backups of a live data root', { skip: libpq ? false : LIBPQ_MISSING }, () => {
  test('backup evidence restores rows objects vault bytes and modes into a distinct data root', async () => {
    const { layout, control } = await liveRoot();
    await storeObject(layout, Buffer.from('synthetic immutable object'));
    await putVaultEntry(layout, 'synthetic-one', Buffer.from([0, 255, 17, 0, 128]));
    await putVaultEntry(layout, 'synthetic-two', Buffer.from('synthetic sealed bytes'));
    const before = {
      tables: await withSession(control.connector, control.target.database, summarizeTables),
      objects: await treeEntries(layout.objects),
      vault: await treeEntries(layout.vault),
      config: await treeEntries(layout.config),
    };
    const backup = await createBackup({ layout, postgres: control, label: 'distinct-root-evidence', libpqBin: libpq! });
    await control.stop();
    const target = layoutAt(join(await tempDir(), 'restored'));
    roots.push(join(target.root, '..'));
    assert.notEqual(target.root, layout.root);
    await ensureLayout(target);
    const restored = createPostgres({ layout: target, port: socketPort() });
    clusters.push(restored);
    const receipt = await restoreBackup({ layout: target, backupDir: backup.dir, postgres: restored, libpqBin: libpq! });
    assert.equal(receipt.rows, 50);
    assert.deepEqual(await withSession(restored.connector, restored.target.database, summarizeTables), before.tables);
    assert.deepEqual(await treeEntries(target.objects), before.objects);
    assert.deepEqual(await treeEntries(target.vault), before.vault);
    assert.deepEqual(await treeEntries(target.config), before.config);
    await withSession(restored.applicationConnector, restored.target.database, s => s.query("INSERT INTO synthetic_records (body) VALUES ('isolated destination')"));
    const count = (database: PostgresControl) => withSession(database.applicationConnector, database.target.database, s => s.query('SELECT count(*)::int AS n FROM synthetic_records'));
    assert.equal(Number((await count(restored))[0].n), 51);
    await restored.stop();
    await control.start();
    assert.equal(Number((await count(control))[0].n), 50, 'the original database remains independent');
  });

  test('temporaries of the records stores and Finder metadata are never part of a backup', async () => {
    const { layout, control } = await liveRoot();
    const object = await storeObject(layout, Buffer.from('synthetic object'));
    // A writer that died between write and unlink leaves its temporary behind for good.
    const stale = join(layout.objects, object.slice(0, 2), `.${object}.0123456789abcdef.tmp`);
    await writeFile(stale, 'half written', { mode: 0o400 });
    await writeFile(join(layout.objects, '.DS_Store'), 'finder');
    await putVaultEntry(layout, 'synthetic-entry', Buffer.from('sealed'));
    await writeFile(join(layout.vault, 'synthetic-entry.sealed.fedcba9876543210.tmp'), 'half sealed', { mode: 0o600 });
    await writeFile(join(layout.vault, 'key-check'), 'synthetic check\n', { mode: 0o600 });
    const { dir, manifest, skipped } = await createBackup({ layout, postgres: control, label: 'transients', libpqBin: libpq! });
    assert.deepEqual(
      manifest.files.map((file) => file.path),
      ['config/platform.json', 'database.dump', `objects/${object.slice(0, 2)}/${object}`, 'vault/key-check', 'vault/synthetic-entry.sealed'],
    );
    assert.deepEqual(skipped, []);
    await verifyBackup(dir);
  });

  test('extracted pack trees stay out of the backup; it restores into an empty root without them and into a root that still holds them', async () => {
    const { layout, control } = await liveRoot();
    const object = await storeObject(layout, Buffer.from('synthetic pack file'));
    assert.ok((await writeSyntheticPacks(layout)) > 0);
    const packs = await treeEntries(layout.packs);
    const { dir, manifest } = await createBackup({ layout, postgres: control, label: 'with-packs', libpqBin: libpq! });
    assert.deepEqual(
      manifest.files.map((file) => file.path),
      ['config/platform.json', 'database.dump', `objects/${object.slice(0, 2)}/${object}`],
      'nothing under packs/',
    );
    await verifyBackup(dir);
    assert.deepEqual(await treeEntries(layout.packs), packs, 'the backup left them as they were');

    // Disaster: a new, empty data root. The restore brings the data and no pack trees (the registry rebuilds them).
    const empty = layoutAt(join(await tempDir(), 'target'));
    roots.push(join(empty.root, '..'));
    await ensureLayout(empty);
    const fresh = createPostgres({ layout: empty, port: socketPort() });
    clusters.push(fresh);
    assert.equal((await restoreBackup({ layout: empty, backupDir: dir, postgres: fresh, libpqBin: libpq! })).rows, 50);
    assert.equal((await treeEntries(empty.packs)).size, 0);
    assert.equal(await isMissingOrEmpty(empty.packs), true);
    await fresh.stop();

    // A failed deploy or a rollback: the data is moved aside, the derived pack trees stay, and the restore accepts the root.
    await control.stop();
    await setAside(layout, 'rehearsed-failure');
    await assertRestorable(layout);
    const again = createPostgres({ layout, port: control.target.port });
    clusters.push(again);
    assert.equal((await restoreBackup({ layout, backupDir: dir, postgres: again, libpqBin: libpq! })).rows, 50);
    assert.deepEqual(await treeEntries(layout.packs), packs, 'untouched by the set-aside and the restore');
    assert.equal(await readFile(join(layout.objects, object.slice(0, 2), object), 'utf8'), 'synthetic pack file');
  });

  test('backups taken while writers add objects and replace vault entries all succeed and verify', async () => {
    const { layout, control } = await liveRoot();
    for (let n = 0; n < 300; n++) await storeObject(layout, randomBytes(1024 + n));
    let writing = true;
    let written = 0;
    const writer = async () => {
      while (writing) {
        await storeObject(layout, randomBytes(32 * 1024));
        await putVaultEntry(layout, `entry-${written % 3}`, randomBytes(256));
        written++;
        await delay(1);
      }
    };
    const writers = [writer(), writer()];
    const outcomes: string[] = [];
    try {
      for (let n = 0; n < 4; n++) {
        try {
          const { dir } = await createBackup({ layout, postgres: control, label: `hot-${n}`, libpqBin: libpq! });
          await verifyBackup(dir);
          outcomes.push('ok');
        } catch (error) {
          outcomes.push((error as Error).message);
        }
      }
    } finally {
      writing = false;
      await Promise.all(writers);
    }
    assert.ok(written > 10, 'the writers really ran during the backups');
    assert.deepEqual(outcomes, ['ok', 'ok', 'ok', 'ok']);
    assert.ok(!(await listFiles(layout.backups, [], {})).some((path) => path.startsWith('.partial')));
  });

  test('consecutive backups share unchanged objects as re-hashed hard links; a damaged copy is not reused', async () => {
    const { layout, control } = await liveRoot();
    const objects: string[] = [];
    for (let n = 0; n < 5; n++) objects.push(await storeObject(layout, Buffer.from(`synthetic object ${n}`)));
    const path = (digest: string) => `objects/${digest.slice(0, 2)}/${digest}`;
    const first = await createBackup({ layout, postgres: control, label: 'first', libpqBin: libpq! });
    assert.equal(first.reused, 0);
    const second = await createBackup({ layout, postgres: control, label: 'second', libpqBin: libpq! });
    assert.equal(second.reused, 5);
    for (const digest of objects) {
      const [a, b] = await Promise.all([stat(join(first.dir, path(digest))), stat(join(second.dir, path(digest)))]);
      assert.equal(a.ino, b.ino, 'one copy on disk');
      assert.equal(b.mode & 0o777, 0o400);
    }
    await verifyBackup(second.dir);

    // Damage the shared copy (keeping size and mode): the next backup copies that object fresh from the data root.
    const damaged = join(second.dir, path(objects[0]!));
    const original = await readFile(damaged);
    await chmod(damaged, 0o600);
    await writeFile(damaged, Buffer.from(original.map((byte) => byte ^ 0xff)));
    await chmod(damaged, 0o400);
    const third = await createBackup({ layout, postgres: control, label: 'third', libpqBin: libpq! });
    assert.equal(third.reused, 4);
    assert.notEqual((await stat(join(third.dir, path(objects[0]!)))).ino, (await stat(damaged)).ino);
    const manifest = await verifyBackup(third.dir);
    assert.equal(manifest.files.find((file) => file.path === path(objects[0]!))?.sha256, objects[0]);
  });

  test('an empty database is not backed up when the previous backup had tables', async () => {
    const { layout, control } = await liveRoot();
    await createBackup({ layout, postgres: control, libpqBin: libpq! });
    await withSession(control.connector, control.target.database, (s) => s.query('DROP TABLE synthetic_records'));
    await assert.rejects(createBackup({ layout, postgres: control, libpqBin: libpq! }), (error: unknown) => {
      assert.match((error as Error).message, /里没有表，上一份备份（.+）有 1 张表：可能连错了数据库，不备份/);
      return true;
    });
    assert.equal((await listBackups(layout)).length, 1);
    assert.ok(!(await listFiles(layout.backups)).some((file) => file.startsWith('.partial')));
  });

  test('a restore whose tables do not reproduce the manifest is refused and its partial state set aside', async () => {
    const { layout, control } = await liveRoot();
    const { dir } = await createBackup({ layout, postgres: control, libpqBin: libpq! });
    const copy = join(await tempDir(), 'edited');
    roots.push(join(copy, '..'));
    await cp(dir, copy, { recursive: true });
    const manifest = await manifestOf(copy);
    const table = manifest.database.tables.find((entry) => entry.table === 'synthetic_records')!;
    table.digest = table.digest.replace(/^./, (c) => (c === '0' ? '1' : '0'));
    await writeFile(join(copy, MANIFEST_FILE), JSON.stringify(manifest));
    await verifyBackup(copy);
    const target = layoutAt(join(await tempDir(), 'target'));
    roots.push(join(target.root, '..'));
    await ensureLayout(target);
    const restored = createPostgres({ layout: target, port: socketPort() });
    clusters.push(restored);
    await assert.rejects(restoreBackup({ layout: target, backupDir: copy, postgres: restored, libpqBin: libpq! }), (error: unknown) => {
      assert.match((error as Error).message, /恢复后的数据库与备份清单不一致：表 public\.synthetic_records 内容摘要不同/);
      assert.match(String((error as { hint?: string }).hint), /半成品已移到 .*set-aside/);
      return true;
    });
    assert.ok(await isMissingOrEmpty(target.db));
    await assertRestorable(target);
    assert.equal((await restored.status()).running, false);
  });

  test('a database in which the application role owns an object (an earlier platform version) is not backed up, with the fix', async () => {
    const { layout, control } = await liveRoot();
    await withSession(control.connector, control.target.database, (s) => s.query(`ALTER TABLE synthetic_records OWNER TO ${control.application.user}`));
    await assert.rejects(createBackup({ layout, postgres: control, libpqBin: libpq! }), (error: unknown) => {
      assert.match((error as Error).message, /^备份之前，应用角色 circle_hub 应当只能连接并按授权读写，现在却拥有 \d+ 个对象（.*table synthetic_records.*）：Hub 以它运行，只追加的约束就不成立$/);
      const hint = String((error as { hint?: string }).hint);
      assert.ok(hint.startsWith('先停掉服务（circle-hub service stop），'), hint);
      assert.ok(hint.includes(`在数据库 circle_hub 执行「REASSIGN OWNED BY "circle_hub" TO "${control.target.user}";」`), hint);
      assert.match(hint, /部署新发布时迁移会重新授权/);
      return true;
    });
    assert.deepEqual(await listBackups(layout), []);
    assert.ok(!(await listFiles(layout.backups)).some((file) => file.startsWith('.partial')));
    // The fix the hint names makes the database backable again; the GRANT stands for the migration of the next deploy.
    await withSession(control.connector, control.target.database, (s) => s.query(`REASSIGN OWNED BY ${control.application.user} TO "${control.target.user}"`));
    await withSession(control.connector, control.target.database, (s) => s.query(`GRANT SELECT, INSERT ON synthetic_records TO ${control.application.user}`));
    await verifyBackup((await createBackup({ layout, postgres: control, libpqBin: libpq! })).dir);
  });

  test('large objects and default privileges the application role made itself stop the backup until the printed fix, then it restores', async () => {
    const { layout, control } = await liveRoot();
    const privileges = () => withSession(control.connector, control.target.database, (s) => rolePrivileges(s, control.application.user));
    const before = await privileges();
    await withSession(control.applicationConnector, control.target.database, async (s) => {
      await s.query("SELECT lo_from_bytea(0, '\\x00ff'::bytea)");
      await s.query('ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO PUBLIC');
    });
    await assert.rejects(createBackup({ layout, postgres: control, libpqBin: libpq! }), (error: unknown) => {
      assert.match((error as Error).message, /^备份之前，.*现在却拥有 2 个对象（default privileges on new relations belonging to role circle_hub、large object \d+）：任何角色不需授权都能建这类对象/);
      assert.doesNotMatch(String((error as { hint?: string }).hint), /先停掉服务/, 'the Hub may keep running meanwhile');
      return true;
    });
    const report: RoleReport = await withSession(control.connector, control.target.database, (s) => inspectRole(s, control.application.user));
    const hint = roleFixHint(control, report);
    for (const step of report.fix) {
      assert.ok(hint.includes(`执行「${step.statements.map((statement) => `${statement};`).join(' ')}」`));
      await withSession(control.connector, step.database, async (s) => {
        for (const statement of step.statements) await s.query(statement);
      });
    }
    assert.deepEqual(await privileges(), before, 'the grants are untouched');
    const { dir } = await createBackup({ layout, postgres: control, libpqBin: libpq! });
    const target = layoutAt(join(await tempDir(), 'target'));
    roots.push(join(target.root, '..'));
    await ensureLayout(target);
    const restored = createPostgres({ layout: target, port: socketPort() });
    clusters.push(restored);
    const result = await restoreBackup({ layout: target, backupDir: dir, postgres: restored, libpqBin: libpq! });
    assert.equal(result.rows, 50);
    const [object] = await withSession(restored.connector, restored.target.database, (s) =>
      s.query("SELECT pg_get_userbyid(m.lomowner)::text AS owner, encode(lo_get(m.oid), 'hex') AS bytes FROM pg_largeobject_metadata m"),
    );
    assert.deepEqual(object, { owner: restored.target.user, bytes: '00ff' }, 'the large object came back, owned by the superuser role');
  });

  test('a restore whose application role privileges differ from the manifest is refused and its partial state set aside', async () => {
    const { layout, control } = await liveRoot();
    const { dir } = await createBackup({ layout, postgres: control, libpqBin: libpq! });
    const copy = join(await tempDir(), 'edited');
    roots.push(join(copy, '..'));
    await cp(dir, copy, { recursive: true });
    const manifest = await manifestOf(copy);
    const privileges = manifest.database.application_role.privileges;
    assert.ok(privileges.includes('table public.synthetic_records INSERT'));
    manifest.database.application_role.privileges = [...privileges.filter((entry) => entry !== 'table public.synthetic_records INSERT'), 'table public.synthetic_records DELETE'];
    await writeFile(join(copy, MANIFEST_FILE), JSON.stringify(manifest));
    const target = layoutAt(join(await tempDir(), 'target'));
    roots.push(join(target.root, '..'));
    await ensureLayout(target);
    const restored = createPostgres({ layout: target, port: socketPort() });
    clusters.push(restored);
    await assert.rejects(restoreBackup({ layout: target, backupDir: copy, postgres: restored, libpqBin: libpq! }), (error: unknown) => {
      assert.match(
        (error as Error).message,
        /恢复后应用角色 circle_hub 的权限与备份时不同：缺少 table public\.synthetic_records DELETE；多出 table public\.synthetic_records INSERT/,
      );
      assert.match(String((error as { hint?: string }).hint), /半成品已移到 .*set-aside/);
      return true;
    });
    assert.ok(await isMissingOrEmpty(target.db));
    await assertRestorable(target);
  });
});

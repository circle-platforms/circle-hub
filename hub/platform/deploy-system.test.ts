// Integration: deploy, a failing deploy and rollback through the real system host, with a real PostgreSQL, real
// backups and restores, and a synthetic release whose `serve --migrate-only` migrates over the socket the way hub/server
// does: as the operating-system account's role, which owns the Hub database, granting the application role. npm and
// launchctl are fakes: npm links this checkout's node_modules into the release, launchctl starts a loopback health server.
import assert from 'node:assert/strict';
import { readFileSync, readlinkSync } from 'node:fs';
import { chmod, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { userInfo } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { createContext, postgresFor, type PlatformContext } from './context.ts';
import { deploy, deployLogPath, readDeployments, readProgress, rollback } from './deploy.ts';
import { PlatformError } from './errors.ts';
import { ensureLayout, layoutAt, type Layout } from './layout.ts';
import { ensureDatabaseRunning } from './postgres.ts';
import { readCurrentRelease } from './release.ts';
import { roleProblems } from './roles.ts';
import { newSettingsFile, writeSettingsFile } from './settings.ts';
import { withSession } from './sql.ts';
import { exit, freePort, libpqAvailable, LIBPQ_MISSING, ok, ownerTables, recordingRunner, removeDir, socketPort, sqlState, tempDir, type Call } from './test-support.ts';

const WORKTREE = fileURLToPath(new URL('../../', import.meta.url));
const libpq = await libpqAvailable();

const MIGRATING_BIN = `#!/usr/bin/env node
// Synthetic release entry shaped like hub/server's serve --migrate-only: connects as this operating-system account's role
// (the owner of the Hub database), records which release migrated and grants the application role named by
// CIRCLE_HUB_DATABASE_USER. A VERSION containing gives-ownership hands the table to the application role, which the
// deploy must refuse.
import { readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import pg from 'pg';
const args = process.argv.slice(2);
if (args[0] !== 'serve' || args[1] !== '--migrate-only') { console.error('synthetic release: only serve --migrate-only'); process.exit(2); }
const release = JSON.parse(readFileSync(new URL('../release.json', import.meta.url), 'utf8')).id;
const version = readFileSync(new URL('../VERSION', import.meta.url), 'utf8').trim();
const env = process.env;
const owner = userInfo().username;
const runtime = env.CIRCLE_HUB_DATABASE_USER;
if (!runtime || runtime === owner) { console.error('synthetic release: the application role must differ from the owner'); process.exit(1); }
const client = new pg.Client({ host: env.CIRCLE_HUB_DATABASE_SOCKET_DIR, port: Number(env.CIRCLE_HUB_DATABASE_PORT), user: owner, database: env.CIRCLE_HUB_DATABASE_NAME });
await client.connect();
await client.query('CREATE TABLE IF NOT EXISTS migration_marks (release text NOT NULL)');
await client.query('INSERT INTO migration_marks VALUES ($1)', [release]);
await client.query('GRANT SELECT, INSERT ON migration_marks TO "' + runtime + '"');
if (version.includes('gives-ownership')) await client.query('ALTER TABLE migration_marks OWNER TO "' + runtime + '"');
await client.end();
`;

async function source(parent: string, version: string): Promise<string> {
  const dir = join(parent, `source-${version}`);
  await mkdir(join(dir, 'bin'), { recursive: true });
  await writeFile(join(dir, 'package.json'), '{"name":"synthetic-release","type":"module"}\n');
  await writeFile(join(dir, 'package-lock.json'), '{"lockfileVersion":3}\n');
  await writeFile(join(dir, 'VERSION'), `${version}\n`);
  await writeFile(join(dir, 'bin', 'circle-hub'), MIGRATING_BIN);
  await chmod(join(dir, 'bin', 'circle-hub'), 0o755);
  return dir;
}

describe('deploy through the system host', { skip: libpq ? false : LIBPQ_MISSING }, () => {
  let parent: string;
  let layout: Layout;
  let context: PlatformContext;
  let port: number;
  let server: Server | undefined;
  const failing = new Set<string>();
  const launchctl: string[] = [];

  const startService = async () => {
    server = createServer((_request, response) => {
      const version = readFileSync(join(layout.current, 'VERSION'), 'utf8').trim();
      const release = basename(readlinkSync(layout.current));
      if (failing.has(version)) response.writeHead(503).end('synthetic failure');
      else response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 'ok', release }));
    });
    await new Promise<void>((resolve) => server!.listen(port, '127.0.0.1', resolve));
  };
  const stopService = async () => {
    if (!server) return;
    const closing = server;
    server = undefined;
    closing.closeAllConnections();
    await new Promise<void>((resolve) => closing.close(() => resolve()));
  };

  const marks = async (): Promise<string[]> => {
    const control = postgresFor(context, (await readCurrentRelease(layout))?.dir);
    const rows = await withSession(control.applicationConnector, control.target.database, (s) =>
      s.query("SELECT coalesce(array_agg(release ORDER BY release), '{}') AS releases FROM migration_marks"),
    ).catch(() => [{ releases: [] }]);
    return rows[0]?.releases as string[];
  };
  const records = async (): Promise<number> => {
    const control = postgresFor(context, (await readCurrentRelease(layout))?.dir);
    const [row] = await withSession(control.applicationConnector, control.target.database, (s) => s.query('SELECT count(*)::int AS n FROM synthetic_records'));
    return Number(row?.n);
  };

  before(async () => {
    parent = await tempDir();
    layout = layoutAt(join(parent, 'root'));
    await ensureLayout(layout);
    port = await freePort();
    // The deployment settings pin the socket port; the context below takes it from them.
    await writeSettingsFile(layout, newSettingsFile({ environment: 'test', port, database: { port: socketPort() } }));
    const { runner } = recordingRunner(async (call: Call) => {
      if (call.command === 'npm') {
        await symlink(join(WORKTREE, 'node_modules'), join(call.options.cwd!, 'node_modules'));
        return ok();
      }
      if (call.command === '/bin/launchctl') {
        launchctl.push(call.args.join(' '));
        if (call.args[0] === 'print') return server ? ok('\tstate = running\n\tpid = 4242\n') : exit(113, 'Could not find service');
        if (call.args[0] === 'bootstrap') await startService();
        if (call.args[0] === 'bootout') await stopService();
        return ok();
      }
      return undefined;
    });
    await mkdir(join(parent, 'home', 'Library', 'LaunchAgents'), { recursive: true });
    context = createContext(
      {},
      {
        layout,
        platform: 'darwin',
        home: join(parent, 'home'),
        user: userInfo().username,
        uid: 501,
        runner,
        launchAgentsDir: join(parent, 'home', 'Library', 'LaunchAgents'),
        nodePath: process.execPath,
        libpqBin: libpq!,
        codeRoot: WORKTREE,
        healthTimeoutMs: 3000,
      },
    );
    const control = postgresFor(context);
    await control.initialise();
    await ensureDatabaseRunning(control, { create: true });
    await ownerTables(control, ['CREATE TABLE synthetic_records (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, text text NOT NULL)'], ['synthetic_records']);
    await withSession(control.applicationConnector, control.target.database, (s) =>
      s.query("INSERT INTO synthetic_records (text) SELECT '合成 ' || n FROM generate_series(1, 25) AS n"),
    );
  });

  after(async () => {
    await stopService();
    if (context) await postgresFor(context, (await readCurrentRelease(layout).catch(() => undefined))?.dir).stop().catch(() => {});
    if (parent) await removeDir(parent);
  });

  test('a first deploy builds the release, migrates it, installs the service and passes the health check', async () => {
    const report = await deploy(context, { path: await source(parent, 'v1'), copy: true });
    const current = await readCurrentRelease(layout);
    assert.equal(current?.id, report.release);
    assert.equal(report.previous, undefined);
    assert.deepEqual(await marks(), [report.release]);
    assert.equal(await records(), 25);
    assert.ok(server, 'the service runs');
    const plist = await readFile(join(context.launchAgentsDir, 'io.github.circle-platforms.circle-hub.plist'), 'utf8');
    assert.ok(plist.includes(`<string>${layout.root}</string>`));
    assert.ok(plist.includes('<key>CIRCLE_HUB_DATA_DIR</key>'));
    assert.deepEqual((await readDeployments(context)).map((entry) => entry.release), [report.release]);
    assert.match((await readDeployments(context))[0]!.backup, /^\d{8}T\d{6}Z-pre-deploy$/, 'recorded by name, so the data root can move');
    assert.equal(await readProgress(layout), undefined, 'no unfinished operation is left');
    const log = (await readFile(deployLogPath(context), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.ok(log.every((event) => typeof event.at === 'string'));
    assert.deepEqual(log.at(-1), { at: log.at(-1)?.at, event: 'deploy', phase: 'done', release: report.release });
    assert.ok(
      log.some((event) => event.note === `迁移以本机账户的角色 ${context.user}（拥有 Hub 数据库）执行，并授权应用角色 circle_hub；之后服务以 circle_hub 连接，不迁移`),
      'the deploy log names both roles of the migration',
    );
    // The migration ran as the owner: the application role owns nothing and may read and append, never delete.
    const control = postgresFor(context, current?.dir);
    const owners = await withSession(control.connector, control.target.database, (s) =>
      s.query("SELECT tablename::text AS name, tableowner::text AS owner FROM pg_tables WHERE schemaname = 'public' ORDER BY 1"),
    );
    assert.deepEqual(owners, [
      { name: 'migration_marks', owner: context.user },
      { name: 'synthetic_records', owner: context.user },
    ]);
    assert.deepEqual(await withSession(control.connector, control.target.database, (s) => roleProblems(s, control.application.user)), []);
    assert.equal(await withSession(control.applicationConnector, control.target.database, (s) => sqlState(s, 'DELETE FROM migration_marks')), '42501');
  });

  test('a deploy whose health check fails restores the pre-deploy backup and runs the previous release again', async () => {
    const before = await readCurrentRelease(layout);
    failing.add('v2');
    await assert.rejects(deploy(context, { path: await source(parent, 'v2'), copy: true }), (error: unknown) => {
      assert.ok(error instanceof PlatformError);
      assert.match(error.message, /“健康检查”这一步失败/);
      assert.match(error.hint ?? '', /已恢复部署前备份/);
      return true;
    });
    failing.delete('v2');
    assert.equal((await readCurrentRelease(layout))?.id, before?.id, 'current points back');
    assert.deepEqual(await marks(), [before!.id], "the failed release's migration is gone");
    assert.equal(await records(), 25);
    assert.ok(server, 'the previous release serves again');
    const aside = await readdir(layout.setAside);
    assert.equal(aside.length, 1);
    assert.match(aside[0]!, /-failed-deploy$/);
    const log = await readFile(deployLogPath(context), 'utf8');
    assert.match(log, /"phase":"failed","step":"health"/);
    assert.match(log, /"recovery":"restore","ok":true/);
    assert.equal((await readDeployments(context)).length, 1, 'the failed deploy is not recorded');
  });

  test('a release whose migration leaves the application role owning a table is undone like a failed migration', async () => {
    const before = await readCurrentRelease(layout);
    await assert.rejects(deploy(context, { path: await source(parent, 'v3-gives-ownership'), copy: true }), (error: unknown) => {
      assert.ok(error instanceof PlatformError);
      assert.match(error.message, /“迁移”这一步失败：迁移之后，应用角色 circle_hub 应当只能连接并按授权读写，现在却拥有 1 个对象（table migration_marks）/);
      assert.match(error.hint ?? '', /已恢复部署前备份/);
      return true;
    });
    assert.equal((await readCurrentRelease(layout))?.id, before?.id, 'current points back');
    assert.deepEqual(await marks(), [before!.id]);
    assert.equal(await records(), 25);
    assert.ok(server, 'the previous release serves again');
    const control = postgresFor(context, before?.dir);
    assert.deepEqual(await withSession(control.connector, control.target.database, (s) => roleProblems(s, control.application.user)), [], 'the restored data has the old owner');
    assert.equal((await readDeployments(context)).length, 1);
  });

  test('a good deploy followed by rollback returns to the previous release and its data', async () => {
    const v1 = await readCurrentRelease(layout);
    const report = await deploy(context, { path: await source(parent, 'v2'), copy: true });
    assert.equal(report.previous, v1?.id);
    assert.deepEqual((await marks()).sort(), [v1!.id, report.release].sort());
    const back = await rollback(context);
    assert.equal(back.release, v1?.id);
    assert.equal(back.previous, report.release);
    assert.equal((await readCurrentRelease(layout))?.id, v1?.id);
    assert.deepEqual(await marks(), [v1!.id]);
    assert.equal(await records(), 25);
    const last = (await readDeployments(context)).at(-1);
    assert.equal(last?.rollback, true);
    assert.ok(launchctl.every((line) => /^(print|bootstrap|bootout|kickstart) gui\/501/.test(line)));
    assert.equal(await readProgress(layout), undefined);
  });

  test('deploying the current release again is refused while the service keeps running', async () => {
    const current = await readCurrentRelease(layout);
    const before = launchctl.length;
    await assert.rejects(deploy(context, { path: await source(parent, 'v1'), copy: true }), new RegExp(`发布 ${current!.id} 就是当前发布，不重复部署`));
    assert.ok(!launchctl.slice(before).some((line) => line.startsWith('bootout')), 'the service was not stopped');
    assert.ok(server, 'and still serves');
  });

  test('a data root whose application role owns a table is refused before anything stops, with the fix', async () => {
    const current = await readCurrentRelease(layout);
    const control = postgresFor(context, current?.dir);
    await withSession(control.connector, control.target.database, async (s) => {
      await s.query('CREATE TABLE handed_over (n int)');
      await s.query(`ALTER TABLE handed_over OWNER TO ${control.application.user}`);
    });
    const before = launchctl.length;
    const backups = (await readdir(layout.backups)).length;
    try {
      await assert.rejects(deploy(context, { path: await source(parent, 'v4'), copy: true }), (error: unknown) => {
        assert.ok(error instanceof PlatformError);
        assert.match(error.message, /“检查发布”这一步失败：部署之前，应用角色 circle_hub 应当只能连接并按授权读写，现在却拥有 1 个对象（table handed_over）.*REASSIGN OWNED BY "circle_hub"/);
        assert.match(error.hint ?? '', /还没有改动任何东西/);
        return true;
      });
      assert.ok(!launchctl.slice(before).some((line) => line.startsWith('bootout')), 'the service was not stopped');
      assert.ok(server, 'and still serves');
      assert.equal((await readdir(layout.backups)).length, backups, 'no backup was taken');
      assert.equal((await readCurrentRelease(layout))?.id, current?.id);
    } finally {
      await withSession(control.connector, control.target.database, (s) => s.query('DROP TABLE handed_over'));
    }
  });
});

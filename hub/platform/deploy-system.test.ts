// Integration: deploy, a failing deploy and rollback through the real system host, with a real PostgreSQL, real
// backups and restores, and a synthetic release whose `serve --migrate-only` migrates over the socket. npm and launchctl
// are fakes: npm links this checkout's node_modules into the release, launchctl starts a loopback health server.
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
import { newSettingsFile, writeSettingsFile } from './settings.ts';
import { withSession } from './sql.ts';
import { exit, freePort, libpqAvailable, LIBPQ_MISSING, ok, recordingRunner, removeDir, socketPort, tempDir, type Call } from './test-support.ts';

const WORKTREE = fileURLToPath(new URL('../../', import.meta.url));
const libpq = await libpqAvailable();

const MIGRATING_BIN = `#!/usr/bin/env node
// Synthetic release entry: records which release migrated, through the environment the deploy passes.
import { readFileSync } from 'node:fs';
import pg from 'pg';
const args = process.argv.slice(2);
if (args[0] !== 'serve' || args[1] !== '--migrate-only') { console.error('synthetic release: only serve --migrate-only'); process.exit(2); }
const release = JSON.parse(readFileSync(new URL('../release.json', import.meta.url), 'utf8')).id;
const env = process.env;
const client = new pg.Client({ host: env.CIRCLE_HUB_DATABASE_SOCKET_DIR, port: Number(env.CIRCLE_HUB_DATABASE_PORT), user: env.CIRCLE_HUB_DATABASE_USER, database: env.CIRCLE_HUB_DATABASE_NAME });
await client.connect();
await client.query('CREATE TABLE IF NOT EXISTS migration_marks (release text NOT NULL)');
await client.query('INSERT INTO migration_marks VALUES ($1)', [release]);
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
    await withSession(control.applicationConnector, control.target.database, async (s) => {
      await s.query('CREATE TABLE synthetic_records (id serial PRIMARY KEY, text text NOT NULL)');
      await s.query("INSERT INTO synthetic_records (text) SELECT '合成 ' || n FROM generate_series(1, 25) AS n");
    });
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
});

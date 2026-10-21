import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { ensureLayout, layoutAt, type Layout } from './layout.ts';
import { createPostgres, majorOf, managedConf, managedHba, managedIdent } from './postgres.ts';
import { exit, ok, recordingRunner, removeDir, tempDir, type Call } from './test-support.ts';
import type { CommandResult } from './process.ts';

const binaries = { initdb: '/fake/bin/initdb', pg_ctl: '/fake/bin/pg_ctl', postgres: '/fake/bin/postgres' };
const roots: string[] = [];
after(async () => {
  for (const root of roots) await removeDir(root);
});

async function freshLayout(): Promise<Layout> {
  const root = await tempDir();
  roots.push(root);
  const layout = layoutAt(root);
  await ensureLayout(layout);
  return layout;
}

/** Fake tools: postgres --version answers 18.4, pg_ctl status answers `running`. */
function fakeTools(state: { running: boolean; onStart?: () => CommandResult }) {
  return recordingRunner(
    (call: Call) => {
      if (call.command === binaries.postgres) return ok('postgres (PostgreSQL) 18.4\n');
      if (call.command === binaries.initdb) return ok();
      if (call.command === binaries.pg_ctl && call.args[0] === 'status') {
        return state.running ? ok('pg_ctl: server is running (PID: 4242)\n/fake/bin/postgres "-D" "x"\n') : exit(3, '', 'pg_ctl: no server running\n');
      }
      if (call.command === binaries.pg_ctl && call.args[0] === 'start') return state.onStart ? state.onStart() : ok();
      if (call.command === binaries.pg_ctl && call.args[0] === 'stop') return ok();
      return undefined;
    },
    { real: false },
  );
}

test('majorOf reads the major version of PostgreSQL tools', () => {
  assert.equal(majorOf('postgres (PostgreSQL) 18.4'), 18);
  assert.equal(majorOf('pg_dump (PostgreSQL) 18.6 (Homebrew)'), 18);
  assert.equal(majorOf('postgres (PostgreSQL) 9.6.24'), 9);
  assert.throws(() => majorOf('something else'), /看不懂版本输出/);
});

test('initialise runs initdb with peer authentication and no password, only when PG_VERSION is missing', async () => {
  const layout = await freshLayout();
  const { runner, calls } = fakeTools({ running: false });
  const control = createPostgres({ layout, binaries, runner, admin: 'owner', port: 5432 });
  assert.equal(await control.initialise(), true);
  const initdb = calls.find((call) => call.command === binaries.initdb);
  assert.deepEqual(initdb?.args, [
    `--pgdata=${layout.db}`,
    '--username=owner',
    '--auth-local=peer',
    '--auth-host=reject',
    '--encoding=UTF8',
    '--locale=C',
    '--no-instructions',
  ]);
  assert.ok(!initdb?.args.some((arg) => /pwfile|password/i.test(arg)));
  assert.match(await readFile(join(layout.db, 'postgresql.conf'), 'utf8'), /include 'circle-hub.conf'/);
  assert.equal(await readFile(join(layout.db, 'pg_hba.conf'), 'utf8'), managedHba('owner', 'circle_hub', 'circle_hub'));
  await writeFile(join(layout.db, 'PG_VERSION'), '18\n');
  const before = calls.length;
  assert.equal(await control.initialise(), false);
  assert.ok(!calls.slice(before).some((call) => call.command === binaries.initdb), 'no second initdb');
});

test('initialise refuses a non-empty data directory without PG_VERSION', async () => {
  const layout = await freshLayout();
  await writeFile(join(layout.db, 'stray-file'), 'x');
  const { runner, calls } = fakeTools({ running: false });
  await assert.rejects(createPostgres({ layout, binaries, runner }).initialise(), /不是空的.*免得覆盖/);
  assert.ok(!calls.some((call) => call.command === binaries.initdb));
});

test('start refuses a data directory of another major version and prints export and import steps', async () => {
  const layout = await freshLayout();
  await writeFile(join(layout.db, 'PG_VERSION'), '17\n');
  const { runner, calls } = fakeTools({ running: false });
  await assert.rejects(createPostgres({ layout, binaries, runner }).start(), (error: unknown) => {
    assert.ok(error instanceof Error && 'hint' in error);
    assert.match(error.message, /PostgreSQL 17 的格式，当前二进制是 PostgreSQL 18，不启动/);
    assert.match(String(error.hint), /circle-hub backup.*circle-hub restore/);
    return true;
  });
  assert.ok(!calls.some((call) => call.args[0] === 'start'), 'pg_ctl start never ran');
});

test('start writes the socket-only configuration and waits for pg_ctl', async () => {
  const layout = await freshLayout();
  await writeFile(join(layout.db, 'PG_VERSION'), '18\n');
  const { runner, calls } = fakeTools({ running: false });
  assert.equal(await createPostgres({ layout, binaries, runner, admin: 'owner', role: 'circle_hub', port: 5544 }).start(), true);
  const start = calls.find((call) => call.args[0] === 'start');
  assert.deepEqual(start?.args, ['start', '-D', layout.db, '-l', join(layout.logs, 'postgres-start.log'), '-w', '-t', '60', '-s']);
  const conf = await readFile(join(layout.db, 'circle-hub.conf'), 'utf8');
  assert.match(conf, /^listen_addresses = ''$/m);
  assert.match(conf, /^port = 5544$/m);
  assert.ok(conf.includes(`unix_socket_directories = '${layout.run}'`));
  assert.match(conf, /^unix_socket_permissions = 0700$/m);
  assert.equal(await readFile(join(layout.db, 'pg_ident.conf'), 'utf8'), managedIdent('owner', 'circle_hub'));
  assert.ok(!start?.options.env?.PGPASSWORD && !start?.options.env?.PGHOST, 'no PG* settings leak into the tools');
});

test('start does nothing when the server already runs; stop is fast and only when running', async () => {
  const layout = await freshLayout();
  await writeFile(join(layout.db, 'PG_VERSION'), '18\n');
  const state = { running: true };
  const { runner, calls } = fakeTools(state);
  const control = createPostgres({ layout, binaries, runner });
  assert.equal(await control.start(), false);
  assert.deepEqual(await control.status(), {
    initialised: true,
    running: true,
    pid: 4242,
    dataMajor: 18,
    binaryMajor: 18,
    binaryVersion: 'postgres (PostgreSQL) 18.4',
    socketDir: layout.run,
  });
  assert.equal(await control.stop(), true);
  assert.deepEqual(calls.find((call) => call.args[0] === 'stop')?.args, ['stop', '-D', layout.db, '-m', 'fast', '-w', '-t', '120', '-s']);
  state.running = false;
  assert.equal(await control.stop(), false);
  assert.equal(calls.filter((call) => call.args[0] === 'stop').length, 1);
});

test('a failed start reports the tail of the start log; an unknown pg_ctl status is an error', async () => {
  const layout = await freshLayout();
  await writeFile(join(layout.db, 'PG_VERSION'), '18\n');
  await mkdir(layout.logs, { recursive: true });
  const { runner } = fakeTools({
    running: false,
    onStart: () => {
      writeFileSync(join(layout.logs, 'postgres-start.log'), 'FATAL:  synthetic startup failure\n');
      return exit(1, 'pg_ctl: could not start server');
    },
  });
  await assert.rejects(createPostgres({ layout, binaries, runner }).start(), /没有启动（pg_ctl 退出码 1）：FATAL:  synthetic startup failure/);
  const odd = recordingRunner((call) => (call.command === binaries.postgres ? ok('postgres (PostgreSQL) 18.4') : exit(1, 'odd failure')), { real: false });
  await assert.rejects(createPostgres({ layout, binaries, runner: odd.runner }).status(), /pg_ctl status 失败/);
});

test('an uninitialised cluster is reported, and start refuses with the init hint', async () => {
  const layout = await freshLayout();
  const { runner } = fakeTools({ running: false });
  const control = createPostgres({ layout, binaries, runner });
  assert.equal((await control.status()).initialised, false);
  await assert.rejects(control.start(), /还没初始化/);
});

test('managed files: configuration, peer lines that keep the application role in the Hub database, and the owner-only ident map', () => {
  const layout = layoutAt('/srv/hub root');
  assert.equal(
    managedConf(layout, 5432),
    [
      '# Managed by circle-hub and rewritten at every start; do not edit.',
      "listen_addresses = ''",
      'port = 5432',
      "unix_socket_directories = '/srv/hub root/run'",
      'unix_socket_permissions = 0700',
      'logging_collector = on',
      "log_directory = '/srv/hub root/logs/postgres'",
      "log_filename = 'postgresql-%a.log'",
      'log_truncate_on_rotation = on',
      "log_rotation_age = '1d'",
      'log_rotation_size = 0',
      "timezone = 'UTC'",
      "log_timezone = 'UTC'",
      '',
    ].join('\n'),
  );
  const lines = (text: string) => text.split('\n').filter((line) => line && !line.startsWith('#'));
  assert.deepEqual(lines(managedHba('owner', 'circle_hub', 'hub_db')), ['local   all   "owner"   peer   map=owner', 'local   "hub_db"   "circle_hub"   peer   map=owner']);
  assert.deepEqual(lines(managedHba('same', 'same', 'hub_db')), ['local   all   "same"   peer   map=owner']);
  const ident = managedIdent('owner', 'circle_hub').split('\n').filter((line) => line && !line.startsWith('#'));
  assert.deepEqual(ident, ['owner   "owner"   "owner"', 'owner   "owner"   "circle_hub"']);
  assert.equal(managedIdent('same', 'same').split('\n').filter((line) => line && !line.startsWith('#')).length, 1);
});

test('role and database names that could break the configuration files are refused', () => {
  const layout = layoutAt('/srv/hub');
  assert.throws(() => createPostgres({ layout, admin: 'bad"name' }), /角色名/);
  assert.throws(() => createPostgres({ layout, role: 'two words' }), /角色名/);
  for (const database of ['bad"db', 'two words', 'new\nline', '']) assert.throws(() => createPostgres({ layout, database }), /数据库名/, JSON.stringify(database));
});

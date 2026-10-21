// The CLI: the retired-environment refusal (in-process and through bin/circle-hub), serve --migrate-only as the owner role
// with the runtime role granted, serve refusing without the assembly and serving with one, user and token management
// (a token is printed once), the call-log export without argument content, the extension point for the assembly's
// commands, and delegation to the platform commands. A temporary socket-only PostgreSQL; no keychain, no launchd.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import pg from 'pg';
import { FileKeyProvider, MIGRATIONS, openRecords } from '../records/index.ts';
import { startPostgres, type TemporaryPostgres } from '../testing/postgres.ts';
import type { AssemblyModule, CliCommand, CliIo } from './api.ts';
import { main, registerCommand } from './cli.ts';
import { loadServerConfig } from './main.ts';
import { fakeDeps } from './testing.ts';

const WORKTREE = fileURLToPath(new URL('../../', import.meta.url));
const RUNTIME = 'hub_runtime';
let postgres: TemporaryPostgres;
let scratch: string;

before(async () => {
  postgres = await startPostgres({ socket: true, passwordless: true });
  scratch = await mkdtemp(join(tmpdir(), 'circle-hub-cli-'));
  const client = new pg.Client({ host: postgres.socketDir, port: postgres.config.port, user: postgres.config.user, database: 'postgres' });
  await client.connect();
  await client.query(`CREATE ROLE ${RUNTIME} LOGIN NOSUPERUSER`);
  await client.end();
});
after(async () => {
  await postgres?.stop();
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

let databases = 0;
/** A fresh database and data directory, and the CIRCLE_HUB_* environment of a server running as the runtime role. */
async function environment(extra: Record<string, string> = {}): Promise<NodeJS.ProcessEnv> {
  databases += 1;
  const database = await postgres.createDatabase();
  const dataDir = join(scratch, `data-${databases}`);
  return {
    CIRCLE_HUB_DATA_DIR: dataDir,
    CIRCLE_HUB_PORT: '0',
    CIRCLE_HUB_DATABASE_SOCKET_DIR: postgres.socketDir,
    CIRCLE_HUB_DATABASE_PORT: String(postgres.config.port),
    CIRCLE_HUB_DATABASE_NAME: database.database,
    CIRCLE_HUB_DATABASE_USER: RUNTIME,
    ...extra,
  };
}

function capture(env: NodeJS.ProcessEnv): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { stdout: (line) => out.push(line), stderr: (line) => err.push(line), env, cwd: scratch }, out, err };
}

const keyProvider = () => new FileKeyProvider(join(scratch, 'vault.key'));
const owner = () => postgres.config.user;

async function run(argv: string[], env: NodeJS.ProcessEnv, extra: Record<string, unknown> = {}) {
  const c = capture(env);
  const code = await main(argv, { io: c.io, keyProvider, ownerRole: owner(), ...extra });
  return { code, out: c.out, err: c.err, text: [...c.out, ...c.err].join('\n') };
}

async function migrated(extra: Record<string, string> = {}): Promise<NodeJS.ProcessEnv> {
  const env = await environment(extra);
  const result = await run(['serve', '--migrate-only'], env);
  assert.equal(result.code, 0, result.text);
  return env;
}

describe('retired names and startup', () => {
  test('a retired CIRCLE_SERVER_* variable refuses every command before anything starts', async () => {
    const env = await environment({ CIRCLE_SERVER_PORT: '7420' });
    for (const argv of [['serve'], ['serve', '--migrate-only'], ['user', 'list'], ['status']]) {
      const result = await run(argv, env);
      assert.equal(result.code, 1, argv.join(' '));
      assert.match(result.text, /不再读取 CIRCLE_SERVER_\*/);
      assert.match(result.text, /CIRCLE_SERVER_PORT/);
      assert.doesNotMatch(result.text, /7420/, 'values are never printed');
    }
  });

  test('bin/circle-hub and the server CLI in a child process refuse a retired name, even an empty one', () => {
    const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', CIRCLE_SERVER_DATA_DIR: '' };
    const bin = spawnSync(process.execPath, [join(WORKTREE, 'bin', 'circle-hub'), 'serve'], { env, encoding: 'utf8', timeout: 60_000 });
    assert.equal(bin.status, 1);
    assert.match(bin.stderr, /不再读取 CIRCLE_SERVER_\*/);
    const script = `const { main } = await import(${JSON.stringify(new URL('./cli.ts', import.meta.url).href)}); process.exitCode = await main(['serve']);`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8', timeout: 60_000 });
    assert.equal(child.status, 1, child.stderr);
    assert.match(child.stderr, /不再读取 CIRCLE_SERVER_\*/);
  });

  test('a configuration problem is listed in Chinese and refuses to start', async () => {
    const env = await environment({ CIRCLE_HUB_PORT: 'eighty', CIRCLE_HUB_TYPO: 'x' });
    const result = await run(['serve'], env);
    assert.equal(result.code, 1);
    assert.match(result.text, /CIRCLE_HUB_PORT 必须是/);
    assert.match(result.text, /CIRCLE_HUB_TYPO 不是 Hub 的配置项/);
  });

  test('serve as the runtime role before the migrations refuses to start; an unknown flag is a usage error', async () => {
    const env = await environment();
    const result = await run(['serve'], env);
    assert.equal(result.code, 1);
    assert.match(result.text, /还没有应用/);
    assert.equal((await run(['serve', '--bogus'], env)).code, 2);
    assert.equal((await run(['serve', '--migrate-only', '--migrate'], env)).code, 2);
  });
});

describe('serve --migrate-only', () => {
  test('migrates as the owner role, grants the runtime role and exits 0; again it applies nothing', async () => {
    const env = await environment();
    const first = await run(['serve', '--migrate-only'], env);
    assert.equal(first.code, 0, first.text);
    assert.match(first.out.join('\n'), new RegExp(`以角色 ${owner()} 应用了 ${MIGRATIONS.length} 个迁移`));
    assert.match(first.out.join('\n'), new RegExp(`运行角色 ${RUNTIME} 已按最小权限授权`));
    const second = await run(['serve', '--migrate-only'], env);
    assert.equal(second.code, 0);
    assert.match(second.out.join('\n'), /应用了 0 个迁移/);
    // The runtime role opens the records without migrating, and may not delete history.
    const kit = await openRecords(loadServerConfig(env), { migrate: false });
    try {
      await kit.store.put({ kind: 'claim', schema: 'claim@1', provenance: 'declared', body: { synthetic: true } });
    } finally {
      await kit.close();
    }
    const client = new pg.Client({ host: postgres.socketDir, port: postgres.config.port, user: RUNTIME, database: String(env.CIRCLE_HUB_DATABASE_NAME) });
    await client.connect();
    try {
      await assert.rejects(client.query('DELETE FROM records'), /permission denied/);
      await assert.rejects(client.query('ALTER TABLE records DISABLE TRIGGER ALL'), /must be owner/);
    } finally {
      await client.end();
    }
  });
});

describe('serve', () => {
  test('without the assembly serve refuses with a clear message and closes the records', async () => {
    const env = await migrated();
    const result = await run(['serve'], env);
    assert.equal(result.code, 1);
    assert.match(result.text, /服务器还没有装配/);
  });

  test('with an assembly it listens on loopback, answers /healthz and stops on the stop signal; the database keeps running', async () => {
    const env = await migrated();
    let stop: () => void = () => {};
    const stopped = new Promise<void>((resolve) => (stop = resolve));
    let url = '';
    const assembly: AssemblyModule = { assemble: (config, records) => fakeDeps(config, records).deps };
    const c = capture(env);
    const listeners = process.listeners('unhandledRejection');
    const serving = main(['serve'], {
      io: c.io,
      keyProvider,
      assembly: async () => assembly,
      stopSignal: () => stopped,
      onListening: (info) => {
        url = info.url;
      },
    });
    for (let i = 0; i < 200 && url === ''; i++) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
    const health = await fetch(`${url}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: 'ok', release: null });
    // While serving, a rejection nobody handled is reported to the operator's log instead of ending the process.
    const added = process.listeners('unhandledRejection').filter((listener) => !listeners.includes(listener));
    assert.equal(added.length, 1, 'serve listens for unhandled rejections');
    (added[0] as (reason: unknown, promise: Promise<unknown>) => void)(new Error('合成的未处理错误'), Promise.resolve());
    assert.ok(c.err.some((line) => /未处理的异步错误（服务继续运行）：Error: 合成的未处理错误/.test(line)));
    stop();
    assert.equal(await serving, 0);
    assert.deepEqual(process.listeners('unhandledRejection'), listeners, 'and stops listening when it stops');
    assert.match(c.out.join('\n'), /已停止（数据库保持运行）/);
    await assert.rejects(fetch(`${url}/healthz`));
    const client = new pg.Client({ host: postgres.socketDir, port: postgres.config.port, user: RUNTIME, database: String(env.CIRCLE_HUB_DATABASE_NAME) });
    await client.connect();
    await client.end();
  });
});

describe('users, tokens and logs', () => {
  test('the first admin is bootstrapped with its token shown once; users and tokens are managed; token values never listed', async () => {
    const env = await migrated();
    assert.match((await run(['user', 'list'], env)).text, /还没有用户/);
    const early = await run(['user', 'create', '甲'], env);
    assert.equal(early.code, 1);
    assert.match(early.text, /还没有管理员/);
    const root = await run(['user', 'create', '根管理员', '--role', 'admin'], env);
    assert.equal(root.code, 0, root.text);
    const rootToken = root.out.find((line) => /^[A-Za-z0-9_-]{43}$/.test(line));
    assert.ok(rootToken, 'the bootstrap token is printed once');
    assert.equal((await run(['user', 'create', '甲'], env)).code, 0);
    assert.equal((await run(['user', 'create', '乙', '--role', 'superuser'], env)).code, 2);
    const issued = await run(['token', 'issue', '甲', '--label', '笔记本'], env);
    assert.equal(issued.code, 0, issued.text);
    const token = issued.out.find((line) => /^[A-Za-z0-9_-]{43}$/.test(line))!;
    const listed = await run(['token', 'list'], env);
    assert.equal(listed.code, 0);
    assert.ok(!listed.text.includes(token) && !listed.text.includes(rootToken), 'no token value in a listing');
    assert.match(listed.text, /笔记本/);
    const users = await run(['user', 'list'], env);
    assert.match(users.text, /根管理员\t管理员/);
    assert.match(users.text, /甲\t用户\t启用/);

    const kit = await openRecords(loadServerConfig(env), { migrate: false });
    try {
      const alice = await kit.principals.authenticate(`Bearer ${token}`);
      assert.equal(alice?.name, '甲');
      const tokenId = /令牌 (tok_[0-9a-z]{26})/.exec(issued.text)![1];
      assert.equal((await run(['token', 'revoke', tokenId], env)).code, 0);
      assert.equal(await kit.principals.authenticate(`Bearer ${token}`), null, 'revocation takes effect at once');
      assert.equal((await run(['token', 'revoke', tokenId], env)).code, 1);
      assert.equal((await run(['user', 'disable', '甲'], env)).code, 0);
      assert.equal((await kit.principals.findByName('甲'))?.disabled, true);
      assert.equal((await run(['user', 'enable', '甲'], env)).code, 0);
      assert.equal((await run(['user', 'create', '丙', '--role', 'admin'], env)).code, 0);
      const ambiguous = await run(['token', 'issue', '甲'], env);
      assert.equal(ambiguous.code, 1);
      assert.match(ambiguous.text, /--as/);
      assert.equal((await run(['token', 'issue', '甲', '--as', '丙'], env)).code, 0);
      assert.equal((await run(['token', 'issue', '甲', '--as', '甲'], env)).code, 1);
    } finally {
      await kit.close();
    }
  });

  test('logs export writes JSON lines without argument content, to stdout or to a new private file', async () => {
    const env = await migrated();
    await run(['user', 'create', '根管理员', '--role', 'admin'], env);
    const kit = await openRecords(loadServerConfig(env), { migrate: false });
    try {
      const admin = (await kit.principals.findByName('根管理员'))!;
      for (const tool of ['upload_file', 'start_run']) {
        await kit.callLog.append({ traceId: '4bf92f3577b34da6a3ce929d0e0e4736', userId: admin.id, sessionId: 's-1', tool, runId: null, arguments: { note: 'MARKER-ARG-31ab' }, callResult: 'ok', durationMs: 3 });
      }
    } finally {
      await kit.close();
    }
    const exported = await run(['logs', 'export'], env);
    assert.equal(exported.code, 0, exported.text);
    const lines = exported.out.map((line) => JSON.parse(line) as { tool: string; args_digest: string });
    assert.deepEqual(lines.map((line) => line.tool), ['upload_file', 'start_run']);
    assert.ok(!exported.text.includes('MARKER-ARG-31ab'));
    const filtered = await run(['logs', 'export', '--tool', 'start_run'], env);
    assert.equal(filtered.out.length, 1);
    const file = join(scratch, `calls-${databases}.jsonl`);
    assert.equal((await run(['logs', 'export', '--out', file], env)).code, 0);
    assert.equal(((await stat(file)).mode & 0o777).toString(8), '600');
    assert.equal((await readFile(file, 'utf8')).trim().split('\n').length, 2);
    const again = await run(['logs', 'export', '--out', file], env);
    assert.equal(again.code, 1);
    assert.match(again.text, /已经存在，不覆盖/);
    assert.equal((await run(['logs', 'export', '--from', 'yesterday'], env)).code, 2);
  });
});

describe('commands of other packages', () => {
  test('run show and the reserved commands say clearly that the assembly is missing; an unknown command is a usage error', async () => {
    const env = await migrated();
    await run(['user', 'create', '根管理员', '--role', 'admin'], env);
    const show = await run(['run', 'show', 'run_00000000000000000000000001'], env);
    assert.equal(show.code, 1);
    assert.match(show.text, /还没有装配/);
    for (const name of ['pack', 'resource', 'secret', 'knowledge']) {
      const result = await run([name, 'list'], env);
      assert.equal(result.code, 1, name);
      assert.match(result.text, new RegExp(`命令 ${name} 由装配步骤提供`));
    }
    for (const name of ['frobnicate', 'constructor', 'toString', '__proto__']) {
      const unknown = await run([name], env);
      assert.equal(unknown.code, 2, name);
      assert.match(unknown.text, /未知命令/);
    }
    const help = await run(['help'], env);
    assert.equal(help.code, 0);
    assert.match(help.text, /token issue/);
    assert.equal((await run([], env)).code, 2);
  });

  test('registerCommand and the assembly hook add commands with records and the acting admin; built-in names are refused', async () => {
    const env = await migrated();
    await run(['user', 'create', '根管理员', '--role', 'admin'], env);
    const seen: string[][] = [];
    const demo: CliCommand = {
      name: 'demo-check',
      summary: '合成的演示命令',
      run: async (args, ctx) => {
        const admin = await ctx.actingAdmin();
        seen.push([...args, admin.name, String((await (await ctx.records()).principals.list()).length)]);
        ctx.io.stdout('演示完成');
        return 0;
      },
    };
    registerCommand(demo);
    assert.throws(() => registerCommand(demo), /已经注册过/);
    assert.throws(() => registerCommand({ ...demo, name: 'user' }), /内置命令/);
    assert.throws(() => registerCommand({ ...demo, name: 'backup' }), /内置命令/);
    const result = await run(['demo-check', 'a'], env);
    assert.equal(result.code, 0, result.text);
    assert.deepEqual(seen, [['a', '根管理员', '1']]);
    const packCommand: CliCommand = { name: 'pack', summary: '合成的任务包命令', run: async (args, ctx) => (ctx.io.stdout(`pack ${args.join(' ')}`), 0) };
    const assembly: AssemblyModule = { assemble: () => Promise.reject(new Error('not used')), registerCommands: (register) => register(packCommand) };
    const pack = await run(['pack', 'list'], env, { assembly: async () => assembly });
    assert.equal(pack.code, 0, pack.text);
    assert.deepEqual(pack.out, ['pack list']);
    const help = await run(['help'], env, { assembly: async () => assembly });
    assert.match(help.text, /合成的任务包命令/);
  });

  test('platform commands are delegated to hub/platform', async () => {
    const env = { CIRCLE_HUB_DATA_DIR: join(scratch, 'platform-root') };
    const result = await run(['init', '--bogus'], env);
    assert.equal(result.code, 2, result.text);
    assert.match(result.text, /init --environment/);
  });
});

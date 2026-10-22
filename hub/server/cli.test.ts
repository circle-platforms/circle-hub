// The CLI: the retired-environment refusal (in-process and through bin/circle-hub), serve --migrate-only as the owner role
// with the runtime role granted, serve refusing a placeholder assembly and an operator token and serving with an assembly,
// user and token management as the operator token's admin (a token is printed once; --raw prints the token alone), the
// call-log export without argument content, run show through the command-time assembly, the extension point for the
// assembly's commands, and delegation to the platform commands without the operator token. A temporary socket-only
// PostgreSQL; operator tokens in memory (never the owner's keychain), no launchd.
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
import { memoryOperatorTokens, type OperatorTokenStore } from './assemble/operator-token.ts';
import { AssemblyMissingError } from './errors.ts';
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
/** A placeholder assembly module (no packages wired): what the CLI must refuse clearly. */
const missingAssembly = async (): Promise<AssemblyModule> => ({ assemble: () => { throw new AssemblyMissingError(); } });
const owner = () => postgres.config.user;
/** Where the built-in commands look for the operator token: in memory, never the owner's keychain. */
const tokensIn = (store: OperatorTokenStore) => ({ operatorTokens: () => store });

async function run(argv: string[], env: NodeJS.ProcessEnv, extra: Record<string, unknown> = {}) {
  const c = capture(env);
  const code = await main(argv, { io: c.io, keyProvider, ownerRole: owner(), ...tokensIn(memoryOperatorTokens(null, '测试的空钥匙串')), ...extra });
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
  test('with a placeholder assembly module serve refuses with a message that says what is missing', async () => {
    const env = await migrated();
    const result = await run(['serve'], env, { assembly: missingAssembly });
    assert.equal(result.code, 1);
    assert.match(result.text, /错误：这个装配模块是占位，没有接上运行、知识、任务包和资源这几个包（默认的 hub\/server\/assemble\.ts 会接上）/);
  });

  test('serve refuses an operator token in its environment, by name and without its value, before anything starts', async () => {
    const env = await migrated();
    let assembled = 0;
    const assembly: AssemblyModule = { assemble: (config, records) => (assembled++, fakeDeps(config, records).deps) };
    for (const argv of [['serve'], ['serve', '--migrate-only']]) {
      const result = await run(argv, { ...env, CIRCLE_HUB_TOKEN: 'synthetic-operator-token-91af' }, { assembly: async () => assembly, stopSignal: () => Promise.resolve() });
      assert.equal(result.code, 1, argv.join(' '));
      assert.match(result.text, /serve 不接受 CIRCLE_HUB_TOKEN：服务器不以管理员身份做任何事/);
      assert.match(result.text, /unset CIRCLE_HUB_TOKEN/);
      assert.doesNotMatch(result.text, /synthetic-operator-token-91af/, 'the value is never printed');
    }
    assert.equal(assembled, 0, 'nothing was assembled');
    const empty = await run(['serve'], { ...env, CIRCLE_HUB_TOKEN: '' }, { assembly: async () => assembly, stopSignal: () => Promise.resolve() });
    assert.equal(empty.code, 1, 'an empty one is refused too: the name is set');
    const retired = await run(['serve'], { ...env, CIRCLE_HUB_TOKEN: 'x', CIRCLE_SERVER_PORT: '1' });
    assert.match(retired.text, /不再读取 CIRCLE_SERVER_\*/, 'the retired names are said first');
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
    // A failed check still stops the server, so the test fails instead of keeping the process alive.
    try {
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
      // The operator's log is one line per event and never steers a terminal, whatever an error quotes.
      (added[0] as (reason: unknown, promise: Promise<unknown>) => void)(new Error('伪造\n2026-10-22T09:00:00Z circle-hub 已停止（数据库保持运行）\u001b]0;pwned\u0007'), Promise.resolve());
      const forged = c.err.at(-1) ?? '';
      assert.ok(![...'\n\r\u001b\u0007'].some((char) => forged.includes(char)), JSON.stringify(forged));
      assert.match(forged, /^未处理的异步错误（服务继续运行）：Error: 伪造\\x0a2026-10-22T09:00:00Z circle-hub 已停止（数据库保持运行）\\x1b\]0;pwned\\x07$/);
    } finally {
      stop();
    }
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
  test('the first admin is bootstrapped with its token shown once; users and tokens are managed as the operator token\'s admin; token values never listed', async () => {
    const env = await migrated();
    assert.match((await run(['user', 'list'], env)).text, /还没有用户/);
    const early = await run(['user', 'create', '甲'], env);
    assert.equal(early.code, 1);
    assert.match(early.text, /还没有管理员/);
    const root = await run(['user', 'create', '根管理员', '--role', 'admin'], env);
    assert.equal(root.code, 0, root.text);
    const rootToken = root.out.find((line) => /^[A-Za-z0-9_-]{43}$/.test(line));
    assert.ok(rootToken, 'the bootstrap token is printed once');
    // The deployment's operator token item holds the admin's token (init-admin or operator-token set write it).
    const operator = tokensIn(memoryOperatorTokens(rootToken, '测试钥匙串'));
    assert.equal((await run(['user', 'create', '甲'], env, operator)).code, 0);
    assert.equal((await run(['user', 'create', '乙', '--role', 'superuser'], env, operator)).code, 2);
    const issued = await run(['token', 'issue', '甲', '--label', '笔记本'], env, operator);
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
      assert.equal((await run(['token', 'revoke', tokenId], env, operator)).code, 0);
      assert.equal(await kit.principals.authenticate(`Bearer ${token}`), null, 'revocation takes effect at once');
      assert.equal((await run(['token', 'revoke', tokenId], env, operator)).code, 1);
      assert.equal((await run(['user', 'disable', '甲'], env, operator)).code, 0);
      assert.equal((await kit.principals.findByName('甲'))?.disabled, true);
      assert.equal((await run(['user', 'enable', '甲'], env, operator)).code, 0);
      // A second admin no longer makes the commands ask who acts: the operator token says it.
      assert.equal((await run(['user', 'create', '丙', '--role', 'admin'], env, operator)).code, 0);
      const second = await run(['token', 'issue', '甲'], env, operator);
      assert.equal(second.code, 0, second.text);
      const decided = await kit.principals.tokens((await kit.principals.findByName('甲'))!.id);
      const rootId = (await kit.principals.findByName('根管理员'))!.id;
      assert.ok(decided.every((t) => t.created_by === rootId), 'every token was issued by the operator token\'s admin');
      const named = await run(['token', 'issue', '甲', '--as', '丙'], env, operator);
      assert.equal(named.code, 2, '--as is a usage error for a state-changing command');
      assert.match(named.text, /改变状态的命令不用 --as：它以操作令牌的管理员身份执行/);
    } finally {
      await kit.close();
    }
  });

  test('state-changing built-ins need an admin\'s operator token: none, a user\'s or an invalid one is refused before anything changes; CIRCLE_HUB_TOKEN works for one command', async () => {
    const env = await migrated();
    const root = await run(['user', 'create', '根管理员', '--role', 'admin'], env);
    const rootToken = root.out.find((line) => /^[A-Za-z0-9_-]{43}$/.test(line))!;
    const operator = tokensIn(memoryOperatorTokens(rootToken, '测试钥匙串'));
    assert.equal((await run(['user', 'create', '甲'], env, operator)).code, 0);
    const userToken = (await run(['token', 'issue', '甲', '--raw'], env, operator)).out[0];
    const changing = [['user', 'create', '乙'], ['user', 'disable', '甲'], ['user', 'enable', '甲'], ['token', 'issue', '甲'], ['token', 'revoke', 'tok_00000000000000000000000001']];
    for (const argv of changing) {
      const without = await run(argv, env);
      assert.equal(without.code, 1, `${argv.join(' ')}: ${without.text}`);
      assert.match(without.text, /要管理员令牌，没有找到/);
      assert.match(without.text, /operator-token set/);
      const asUser = await run(argv, { ...env, CIRCLE_HUB_TOKEN: userToken });
      assert.equal(asUser.code, 1, argv.join(' '));
      assert.match(asUser.text, /不属于启用中的管理员/);
      const invalid = await run(argv, { ...env, CIRCLE_HUB_TOKEN: 'B'.repeat(43) });
      assert.equal(invalid.code, 1, argv.join(' '));
      assert.match(invalid.text, /令牌无效/);
      for (const result of [without, asUser, invalid]) assert.ok(!result.text.includes(userToken) && !result.text.includes(rootToken), 'no token is printed');
    }
    const kit = await openRecords(loadServerConfig(env), { migrate: false });
    try {
      assert.deepEqual((await kit.principals.list()).map((u) => u.name).sort(), ['根管理员', '甲'], 'nobody was created');
      assert.equal((await kit.principals.findByName('甲'))?.disabled, false, 'nobody was disabled');
      // CIRCLE_HUB_TOKEN gives one command its token (the configuration accepts the name for commands) and is taken out.
      const once = { ...env, CIRCLE_HUB_TOKEN: rootToken };
      const created = await run(['user', 'create', '乙'], once);
      assert.equal(created.code, 0, created.text);
      assert.equal(Object.hasOwn(once, 'CIRCLE_HUB_TOKEN'), false, 'taken out of the environment');
      assert.ok(!created.text.includes(rootToken));
      assert.equal((await run(['user', 'list'], { ...env, CIRCLE_HUB_TOKEN: rootToken })).code, 0, 'read-only commands accept the name too');
    } finally {
      await kit.close();
    }
  });

  test('token issue --raw prints the token and a newline on stdout and nothing else; the confirmation goes to stderr', async () => {
    const env = await migrated();
    const root = await run(['user', 'create', '根管理员', '--role', 'admin'], env);
    const rootToken = root.out.find((line) => /^[A-Za-z0-9_-]{43}$/.test(line))!;
    const operator = tokensIn(memoryOperatorTokens(rootToken, '测试钥匙串'));
    assert.equal((await run(['user', 'create', '甲'], env, operator)).code, 0);
    const raw = await run(['token', 'issue', '甲', '--raw', '--label', '脚本'], env, operator);
    assert.equal(raw.code, 0, raw.text);
    assert.equal(raw.out.length, 1, 'one line on stdout');
    assert.match(raw.out[0], /^[A-Za-z0-9_-]{43}$/, 'the token alone');
    assert.equal(raw.err.length, 1);
    assert.match(raw.err[0], /^已为 甲 签发令牌 tok_[0-9a-z]{26}（脚本）；令牌只在标准输出上出现这一次$/);
    assert.ok(!raw.err[0].includes(raw.out[0]), 'the confirmation never holds the token');
    const kit = await openRecords(loadServerConfig(env), { migrate: false });
    try {
      assert.equal((await kit.principals.authenticate(`Bearer ${raw.out[0]}`))?.name, '甲', 'the printed token works');
    } finally {
      await kit.close();
    }
    // Through a real process: stdout is exactly the token and one newline (what TOKEN=$(...) captures). The admin token
    // goes the way an operator gives it, CIRCLE_HUB_TOKEN for this one command: never on a command line (ps shows those to
    // every local user, and node would read one that starts with '-' as its own option). The keychain is never asked: the
    // store is an empty one in memory.
    const script = `const { main } = await import(${JSON.stringify(new URL('./cli.ts', import.meta.url).href)});
const { memoryOperatorTokens } = await import(${JSON.stringify(new URL('./assemble/operator-token.ts', import.meta.url).href)});
const { FileKeyProvider } = await import(${JSON.stringify(new URL('../records/index.ts', import.meta.url).href)});
const empty = memoryOperatorTokens(null, 'child');
process.exitCode = await main(['token', 'issue', '甲', '--raw'], { keyProvider: () => new FileKeyProvider(${JSON.stringify(join(scratch, 'vault.key'))}), operatorTokens: () => empty });`;
    const childEnv = { ...env, PATH: process.env.PATH ?? '/usr/bin:/bin', CIRCLE_HUB_TOKEN: rootToken };
    const argv = ['--input-type=module', '-e', script];
    assert.ok(!argv.some((arg) => arg.includes(rootToken)), 'the token is not an argument');
    const child = spawnSync(process.execPath, argv, { env: childEnv, encoding: 'utf8', timeout: 60_000 });
    assert.equal(child.status, 0, child.stderr.replaceAll(rootToken, '<令牌>'));
    assert.match(child.stdout, /^[A-Za-z0-9_-]{43}\n$/, 'exactly the token and a newline');
    assert.notEqual(child.stdout.trim(), rootToken, 'a new token, issued with the given one');
    assert.match(child.stderr, /已为 甲 签发令牌/);
    assert.ok(!child.stdout.includes(rootToken) && !child.stderr.includes(rootToken), 'the given token is never printed');
  });

  test('logs export and run show read as the operator token\'s account, as the assembly\'s read-only commands do: --as must name it; without a token --as or the only admin', async () => {
    const env = await migrated();
    const root = await run(['user', 'create', '根管理员', '--role', 'admin'], env);
    const rootToken = root.out.find((line) => /^[A-Za-z0-9_-]{43}$/.test(line))!;
    const operator = tokensIn(memoryOperatorTokens(rootToken, '测试钥匙串'));
    assert.equal((await run(['user', 'create', '第二管理员', '--role', 'admin'], env, operator)).code, 0);
    assert.equal((await run(['user', 'create', '甲'], env, operator)).code, 0);
    const userToken = (await run(['token', 'issue', '甲', '--raw'], env, operator)).out[0];
    const kit = await openRecords(loadServerConfig(env), { migrate: false });
    try {
      for (const name of ['根管理员', '甲']) {
        const user = (await kit.principals.findByName(name))!;
        await kit.callLog.append({ traceId: '4bf92f3577b34da6a3ce929d0e0e4736', userId: user.id, sessionId: 's-1', tool: 'start_run', runId: null, arguments: {}, callResult: 'ok', durationMs: 3, adminNote: `${name} 的合成备注` });
      }
    } finally {
      await kit.close();
    }
    const lines = (result: { out: string[] }) => result.out.map((line) => JSON.parse(line) as { user: string; admin_note?: string });
    // Two enabled admins and no token: --as decides, as before.
    const ambiguous = await run(['logs', 'export'], env);
    assert.equal(ambiguous.code, 1);
    assert.match(ambiguous.text, /有多位管理员，要用 --as/);
    assert.equal(lines(await run(['logs', 'export', '--as', '第二管理员'], env)).length, 2);
    // A token says who reads: the admin's view, every call with its admin note (CIRCLE_HUB_TOKEN, taken out, or the item).
    const once: NodeJS.ProcessEnv = { ...env, CIRCLE_HUB_TOKEN: rootToken };
    const asRoot = await run(['logs', 'export'], once);
    assert.equal(asRoot.code, 0, asRoot.text);
    assert.equal(Object.hasOwn(once, 'CIRCLE_HUB_TOKEN'), false, 'taken out of the environment');
    assert.equal(lines(asRoot).filter((line) => line.admin_note !== undefined).length, 2);
    assert.equal(lines(await run(['logs', 'export'], env, operator)).length, 2, 'the keychain item reads the same');
    // A user's token: their own calls only, never an admin note.
    const mine = await run(['logs', 'export'], { ...env, CIRCLE_HUB_TOKEN: userToken });
    assert.equal(mine.code, 0, mine.text);
    assert.equal(lines(mine).length, 1);
    assert.equal(lines(mine)[0].admin_note, undefined);
    for (const argv of [['logs', 'export', '--as', '第二管理员'], ['run', 'show', 'run_00000000000000000000000001', '--as', '第二管理员']]) {
      const other = await run(argv, { ...env, CIRCLE_HUB_TOKEN: rootToken });
      assert.equal(other.code, 1, argv.join(' '));
      assert.match(other.text, /--as 第二管理员 与令牌的账号 根管理员 不一致：有令牌时只读命令以令牌的账号读取/);
    }
    // run show reads as the same account.
    const seen: string[] = [];
    const assembly: AssemblyModule = {
      assemble: () => Promise.reject(new Error('not used')),
      assembleCommand: (config, records) => {
        const { deps, fakes } = fakeDeps(config, records);
        const original = fakes.runs.getRun.bind(fakes.runs);
        fakes.runs.getRun = async (user, id) => (seen.push(user.name), original(user, id));
        return deps;
      },
    };
    const shown = await run(['run', 'show', 'run_00000000000000000000000001'], { ...env, CIRCLE_HUB_TOKEN: userToken }, { assembly: async () => assembly });
    assert.match(shown.text, /没有运行 run_00000000000000000000000001/);
    assert.deepEqual(seen, ['甲'], 'the token\'s account reads, not an admin');
    assert.equal((await run(['run', 'show', 'run_00000000000000000000000001', '--as', '第二管理员'], env, { assembly: async () => assembly })).code, 1);
    assert.deepEqual(seen, ['甲', '第二管理员'], 'without a token, --as');
  });

  test('stored text reaches the terminal with every control character as an escape: run show, user list, token list; JSON escapes what JSON.stringify leaves raw', async () => {
    const env = await migrated();
    const root = await run(['user', 'create', '根管理员', '--role', 'admin'], env);
    const rootToken = root.out.find((line) => /^[A-Za-z0-9_-]{43}$/.test(line))!;
    const operator = tokensIn(memoryOperatorTokens(rootToken, '测试钥匙串'));
    const ESC = String.fromCodePoint(0x1b);
    const BEL = String.fromCodePoint(0x07);
    const CSI = String.fromCodePoint(0x9b);
    const RLO = String.fromCodePoint(0x202e);
    const LS = String.fromCodePoint(0x2028);
    const raw = [ESC, BEL, CSI, RLO, LS, '\r'];
    // A label from a user's mind map (the projection keeps an ESC), an id and a build name with sequences of their own.
    const label = `标题ok${ESC}[2J${ESC}]0;pwned${BEL}${ESC}]52;c;ZWNobyBoaQ==${BEL}${CSI}31m${RLO}反向`;
    const item = `doc:n1${ESC}[1A\r伪造`;
    const run0 = 'run_00000000000000000000000001';
    const detail = {
      run: { run: run0, pack: `review@1.0.0${LS}伪造的行`, started_at: '2026-10-22T08:00:00.000Z', build: `b-2.1${ESC}[2K`, items: [{ id: item, label }], requirements: [{ key: 'structure' }] },
      submissions: [],
      latest: { record: 'a'.repeat(64), result: { acceptance: 'accepted', partitions: { delivered: [{ item, label, requirements: [] }], rejected: [], quarantined: [], incomplete: [] } } },
    };
    const assembly: AssemblyModule = {
      assemble: () => Promise.reject(new Error('not used')),
      assembleCommand: (config, records) => {
        const { deps, fakes } = fakeDeps(config, records);
        fakes.runs.getRun = async () => detail as never;
        return deps;
      },
    };
    const shown = await run(['run', 'show', run0], env, { assembly: async () => assembly });
    assert.equal(shown.code, 0, shown.text);
    for (const line of shown.out) assert.ok(!raw.some((char) => line.includes(char)), `a raw control character reached the terminal: ${JSON.stringify(line)}`);
    assert.ok(shown.out.includes(`- 已交付 doc:n1\\x1b[1A\\x0d伪造 标题ok\\x1b[2J\\x1b]0;pwned\\x07\\x1b]52;c;ZWNobyBoaQ==\\x07\\x9b31m\\u202e反向`), shown.text);
    assert.ok(shown.out.some((line) => line.includes('构建 b-2.1\\x1b[2K')));
    assert.ok(shown.out.some((line) => line.includes('任务包 review@1.0.0\\u2028伪造的行')));
    const json = await run(['run', 'show', run0, '--json'], env, { assembly: async () => assembly });
    assert.equal(json.code, 0);
    const text = json.out.join('\n');
    assert.ok(!raw.some((char) => text.includes(char)), 'the JSON text holds no raw control character');
    assert.deepEqual(JSON.parse(text), detail, 'the same JSON value');

    // A user name and a token label may hold a bidirectional control or a line separator (records refuse only C0 and C1).
    assert.equal((await run(['user', 'create', `甲${RLO}乙`], env, operator)).code, 0);
    assert.equal((await run(['token', 'issue', `甲${RLO}乙`, '--label', `笔记本${LS}伪造`, '--raw'], env, operator)).code, 0);
    const users = await run(['user', 'list'], env);
    const tokens = await run(['token', 'list'], env);
    for (const line of [...users.out, ...tokens.out]) assert.ok(!raw.some((char) => line.includes(char)), JSON.stringify(line));
    assert.ok(users.out.some((line) => line.includes('甲\\u202e乙')));
    assert.ok(tokens.out.some((line) => line.includes('笔记本\\u2028伪造')));

    // logs export: what a caller sent (a tool name, a note quoting it) with C1 and bidirectional controls.
    const kit = await openRecords(loadServerConfig(env), { migrate: false });
    try {
      const admin = (await kit.principals.findByName('根管理员'))!;
      await kit.callLog.append({ traceId: '4bf92f3577b34da6a3ce929d0e0e4736', userId: admin.id, sessionId: 's-1', tool: 'start_run', runId: null, arguments: {}, callResult: 'ok', durationMs: 3, adminNote: `pack x${CSI}2J${RLO}${LS} is unknown` });
    } finally {
      await kit.close();
    }
    const exported = await run(['logs', 'export'], env);
    assert.equal(exported.code, 0);
    assert.ok(!raw.some((char) => exported.out.join('\n').includes(char)));
    assert.equal(JSON.parse(exported.out[0]).admin_note, `pack x${CSI}2J${RLO}${LS} is unknown`, 'the same value');
    const file = join(scratch, `calls-safe-${databases}.jsonl`);
    assert.equal((await run(['logs', 'export', '--out', file], env)).code, 0);
    const written = await readFile(file, 'utf8');
    assert.ok(!raw.some((char) => written.includes(char)), 'the file too');
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
  test('run show and the reserved commands say clearly what a placeholder assembly module lacks; an unknown command is a usage error', async () => {
    const env = await migrated();
    await run(['user', 'create', '根管理员', '--role', 'admin'], env);
    const show = await run(['run', 'show', 'run_00000000000000000000000001'], env, { assembly: missingAssembly });
    assert.equal(show.code, 1);
    assert.match(show.text, /错误：run show 要用运行模块，这个装配模块没有提供/);
    assert.match(show.text, /处理：这个装配模块没有给单条命令用的装配（assembleCommand）/);
    for (const name of ['pack', 'resource', 'secret', 'knowledge', 'init-admin', 'operator-token']) {
      const result = await run([name, 'list'], env, { assembly: missingAssembly });
      assert.equal(result.code, 1, name);
      assert.match(result.text, new RegExp(`命令 ${name} 由装配模块注册（默认的 hub/server/assemble\\.ts 注册 pack、resource、secret、knowledge、init-admin、operator-token），这个装配模块没有注册它`));
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

  test('run show reads through the module\'s command-time assembly with the CLI\'s stderr, never serve\'s', async () => {
    const env = await migrated();
    await run(['user', 'create', '根管理员', '--role', 'admin'], env);
    const calls: string[] = [];
    const assembly: AssemblyModule = {
      assemble: () => {
        calls.push('assemble');
        return Promise.reject(new Error('serve 的装配不该被调用'));
      },
      assembleCommand: (config, records, io) => {
        calls.push('assembleCommand');
        io.stderr('合成的装配日志');
        return fakeDeps(config, records).deps;
      },
    };
    const shown = await run(['run', 'show', 'run_00000000000000000000000001'], env, { assembly: async () => assembly });
    assert.equal(shown.code, 1);
    assert.match(shown.text, /错误：没有运行 run_00000000000000000000000001/);
    assert.deepEqual(calls, ['assembleCommand']);
    assert.deepEqual(shown.err.slice(0, 1), ['合成的装配日志'], 'the assembly\'s log lines go to the CLI\'s stderr');
  });

  test('platform commands are delegated to hub/platform, with CIRCLE_HUB_TOKEN accepted and not passed on', async () => {
    const env = { CIRCLE_HUB_DATA_DIR: join(scratch, 'platform-root') };
    const result = await run(['init', '--bogus'], env);
    assert.equal(result.code, 2, result.text);
    assert.match(result.text, /init --environment/);
    // An admin shell's token does not stop a platform command (it is a usage error here, not an unknown name)...
    const withToken: NodeJS.ProcessEnv = { ...env, CIRCLE_HUB_TOKEN: 'synthetic-operator-token-55cd' };
    const delegated = await run(['init', '--bogus'], withToken);
    assert.equal(delegated.code, 2, delegated.text);
    assert.match(delegated.text, /init --environment/);
    assert.doesNotMatch(delegated.text, /CIRCLE_HUB_TOKEN 不是 circle-hub 的配置项/);
    assert.doesNotMatch(delegated.text, /synthetic-operator-token-55cd/);
    // ...and is taken out of the environment before the platform (and whatever it starts) gets it.
    assert.equal(Object.hasOwn(withToken, 'CIRCLE_HUB_TOKEN'), false);
    // A name nobody knows is still refused by the platform.
    const typo = await run(['init', '--bogus'], { ...env, CIRCLE_HUB_TOKN: 'x' });
    assert.equal(typo.code, 1);
    assert.match(typo.text, /CIRCLE_HUB_TOKN 不是 circle-hub 的配置项/);
  });
});

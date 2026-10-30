// The command bridge of the console's management (decision 75): the real CLI main() in this process against a temporary
// socket-only PostgreSQL, acting as the administrator whose token it is given; refusals for another account's token and
// for commands that are not bridged; the caller's environment left as it was; a secret value delivered to the command's
// readSecret only. Operator tokens in memory and a file key, never the owner's keychain.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { FileKeyProvider } from '../records/index.ts';
import { startPostgres, type TemporaryPostgres } from '../testing/postgres.ts';
import type { AssemblyModule, CliCommand } from './api.ts';
import { memoryOperatorTokens } from './assemble/operator-token.ts';
import { main } from './cli.ts';
import { createCommandBridge } from './command-bridge.ts';

const RUNTIME = 'hub_runtime';
let postgres: TemporaryPostgres;
let scratch: string;
let env: NodeJS.ProcessEnv;
let adminToken: string;

const overrides = () => ({
  keyProvider: () => new FileKeyProvider(join(scratch, 'vault.key')),
  ownerRole: postgres.config.user,
  operatorTokens: () => memoryOperatorTokens(null, '测试的空钥匙串'),
});

async function cli(argv: string[]): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, { io: { stdout: (l) => out.push(l), stderr: (l) => err.push(l), env, cwd: scratch }, ...overrides() });
  return { code, out, err };
}

before(async () => {
  postgres = await startPostgres({ socket: true, passwordless: true });
  scratch = await mkdtemp(join(tmpdir(), 'circle-hub-bridge-'));
  const client = new pg.Client({ host: postgres.socketDir, port: postgres.config.port, user: postgres.config.user, database: 'postgres' });
  await client.connect();
  await client.query(`CREATE ROLE ${RUNTIME} LOGIN NOSUPERUSER`);
  await client.end();
  const database = await postgres.createDatabase();
  env = {
    CIRCLE_HUB_DATA_DIR: join(scratch, 'data'),
    CIRCLE_HUB_PORT: '0',
    CIRCLE_HUB_DATABASE_SOCKET_DIR: postgres.socketDir,
    CIRCLE_HUB_DATABASE_PORT: String(postgres.config.port),
    CIRCLE_HUB_DATABASE_NAME: database.database,
    CIRCLE_HUB_DATABASE_USER: RUNTIME,
  };
  const migrated = await cli(['serve', '--migrate-only']);
  assert.equal(migrated.code, 0, migrated.err.join('\n'));
  const root = await cli(['user', 'create', 'root', '--role', 'admin']);
  assert.equal(root.code, 0, root.err.join('\n'));
  adminToken = root.out.at(-1)!;
  assert.match(adminToken, /^[A-Za-z0-9_-]{43}$/);
});

after(async () => {
  await postgres?.stop();
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

test('a bridged command acts as the administrator of the given token, exactly as the CLI does', async () => {
  const bridge = createCommandBridge({ env, cwd: scratch, overrides: overrides() });
  const created = await bridge.run(['user', 'create', 'alice', '--role=user'], { token: adminToken });
  assert.equal(created.code, 0, created.stderr.join('\n'));
  assert.match(created.stdout.join('\n'), /已建立用户 alice/);
  const issued = await bridge.run(['token', 'issue', 'alice', '--label=web'], { token: adminToken });
  assert.equal(issued.code, 0, issued.stderr.join('\n'));
  assert.match(issued.stdout.at(-1)!, /^[A-Za-z0-9_-]{43}$/, 'the issued token is the last line, shown once');
  const listed = await cli(['user', 'list']);
  assert.match(listed.out.join('\n'), /alice/);
  assert.equal(env.CIRCLE_HUB_TOKEN, undefined, 'the caller environment never gets the token');

  const userToken = issued.stdout.at(-1)!;
  const refused = await bridge.run(['user', 'create', 'mallory'], { token: userToken });
  assert.equal(refused.code, 1);
  assert.match(refused.stderr.join('\n'), /只有管理员能执行|令牌无效/);
  const unknown = await bridge.run(['user', 'create', 'mallory'], { token: 'x'.repeat(43) });
  assert.equal(unknown.code, 1);
  assert.doesNotMatch((await cli(['user', 'list'])).out.join('\n'), /mallory/);
});

test('commands that are not bridged are refused before anything runs', async () => {
  let called = false;
  const bridge = createCommandBridge({ env, cwd: scratch, main: async () => { called = true; return 0; } });
  for (const argv of [['backup'], ['deploy'], ['serve'], ['restore', '/tmp/x'], ['init-admin', 'x'], ['operator-token', 'reissue'], []]) {
    const run = await bridge.run(argv, { token: adminToken });
    assert.equal(run.code, 2, argv.join(' '));
  }
  assert.equal(called, false);
});

test('a secret value reaches only the command readSecret, by its name', async () => {
  let readSecret: ((label: string) => Promise<string>) | undefined;
  const assembly = async (): Promise<AssemblyModule> => ({ assemble: () => { throw new Error('not used'); } });
  const bridge = createCommandBridge({
    env,
    cwd: scratch,
    assembly,
    adminCommands: (options) => {
      readSecret = options.readSecret;
      return [{ name: 'secret', summary: '', run: async () => 0 } satisfies CliCommand];
    },
    main: async (argv, given) => {
      assert.ok(!argv.join(' ').includes('synthetic value'));
      const module = await (given.assembly as () => Promise<AssemblyModule>)();
      module.registerCommands?.(() => {});
      assert.equal((given.io as { env: NodeJS.ProcessEnv }).env.CIRCLE_HUB_TOKEN, adminToken);
      return 0;
    },
  });
  assert.equal((await bridge.run(['secret', 'set', '--name=DEMO', '--reason=r'], { token: adminToken, secrets: { DEMO: 'synthetic value' } })).code, 0);
  assert.equal(await readSecret!('DEMO'), 'synthetic value');
  await assert.rejects(readSecret!('OTHER'), /没有给出 OTHER/);
});

test('setup-code prints a code only while no administrator exists', async () => {
  const refused = await cli(['setup-code']);
  assert.equal(refused.code, 1);
  assert.match(refused.err.join('\n'), /已经有管理员/);
  const saved = env;
  try {
    const database = await postgres.createDatabase();
    env = { ...saved, CIRCLE_HUB_DATABASE_NAME: database.database, CIRCLE_HUB_DATA_DIR: join(scratch, 'fresh') };
    assert.equal((await cli(['serve', '--migrate-only'])).code, 0);
    const issued = await cli(['setup-code']);
    assert.equal(issued.code, 0, issued.err.join('\n'));
    assert.match(issued.out[1], /^[0-9A-Z]{5}(-[0-9A-Z]{5}){4}$/);
    assert.match(issued.out.join('\n'), /\/console\/setup/);
  } finally {
    env = saved;
  }
});

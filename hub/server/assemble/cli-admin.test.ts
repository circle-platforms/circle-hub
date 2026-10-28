import { syntheticKeychain, recordingRunner, socketPort, freePort, captureIo } from '../../platform/test-support.ts';
import type {Environment} from '../../../contracts/generated/vocabulary.ts';
import {secretNameOf} from '../../../contracts/src/variables.ts';
import { addSyntheticResource, setSyntheticCredential, setSyntheticCredentials } from '../../connectors/testing/credentials.ts';
// The administrator commands through the server CLI's main, in-process, on a temporary socket-only PostgreSQL: init-admin
// (the token stored, never printed; a token it cannot store is revoked or said to be live), the operator token from
// CIRCLE_HUB_TOKEN or the store and every state-changing command refused without it or for a non-admin, read-only commands
// as the token's account (a keychain item that cannot be read costs a notice), the pack lifecycle, resources and
// credentials (the portal password kept as the digest its system profile names, values from stdin only; what a running Hub
// keeps in memory), commands without the vault key, knowledge sync with produced, skipped and
// failed builds, its exit code and a second sync that produces nothing, roots and diffs, and text that could steer a
// terminal. The external systems are the connectors' loopback stubs; the packs are tiny synthetic ones written to a
// temporary directory. Every line printed, the assemblies' log lines included, is scanned for secrets.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { DEFAULT_LIMITS, type HubConfig } from '../../config/index.ts';
import { agileFixture, passwordDigest, startAgileStub, startBuildSiteStub, startStub, type AgileStub, type StubServer } from '../../connectors/testing/api.ts';
import { fileKeyStore, keychainKeyProvider, keychainStore, runPlatformCommand, createContext, postgresFor, runCommand, OPERATOR_TOKEN_ITEM, VAULT_KEY_ITEM, type KeyProvider, type CommandRunner } from '../../platform/api.ts';
import { openRecords, type SourceArtifactBody, type RecordKind, type RecordsKit, type User } from '../../records/index.ts';
import { osIsolationAvailable } from '../../rules/api.ts';
import { withFiles, writePack } from '../../runs/api.ts';
import type { AssemblyModule, CliContext, ListenInfo } from '../api.ts';
import { adminCommands, type AdminCommandOptions } from '../cli-admin.ts';
import { CliError } from '../errors.ts';
import { loadServerConfig } from '../main.ts';
import { assembleHub, createAssembly } from './hub.ts';
import { OPERATOR_TOKEN_VARIABLE, fileOperatorTokens, keychainOperatorTokens, memoryOperatorTokens, type OperatorTokenStore } from './operator-token.ts';
import { openCliHarness, type CliHarness, type Deployment, type RunResult } from './test-cli.ts';
import { LeaseService } from '../../leases/service.ts';
import { createPool, Database } from '../../records/db.ts';
import { AGILE_PACK, PRODUCT_PACK, REVIEW_PACK, SITE_PACK, reviewPack, syncSiteFiles, writeTestPacks } from './test-packs.ts';

// Await availability before registering suites, including when only the recovery tests are selected.
const temporaryKeychainAvailable = process.platform === 'darwin' && await access('/usr/bin/security').then(() => true, () => false);

const DOCUMENT = 'd7f3k9';
const PASSWORD = 'Synthetic#Pass42';
const WRONG_PASSWORD = 'Wrong#Pass00';

let harness: CliHarness;
let requireOsIsolation: boolean;
let packRoot: string;
let packs: Awaited<ReturnType<typeof writeTestPacks>>;
let agile: AgileStub;
let site: StubServer;
/** Every secret value a test handled: none may appear in any printed line. */
const secrets = new Set<string>([PASSWORD, passwordDigest(PASSWORD), WRONG_PASSWORD, passwordDigest(WRONG_PASSWORD)]);
const deployments: Deployment[] = [];

before(async () => {
  harness = await openCliHarness();
  requireOsIsolation = await osIsolationAvailable();
  packRoot = await mkdtemp(join(tmpdir(), 'circle-hub-assemble-packs-'));
  packs = await writeTestPacks(packRoot);
  agile = await startAgileStub(agileFixture(DOCUMENT, { password: PASSWORD }));
  site = await startBuildSiteStub(syncSiteFiles());
});

after(async () => {
  try {
    for (const deployment of deployments) {
      for (const line of deployment.printed) for (const secret of secrets) assert.ok(!line.includes(secret), `a printed line holds a secret: ${line.slice(0, 80)}`);
    }
  } finally {
    await agile?.close();
    await site?.close();
    await harness?.close();
    if (packRoot) await rm(packRoot, { recursive: true, force: true });
  }
});

interface Admin {
  deployment: Deployment;
  tokens: (OperatorTokenStore & { value: string | null }) | null;
  /** The output of init-admin, when setup ran it. */
  init: RunResult | null;
  /** Values the next `secret set` reads from "stdin", in order. */
  stdin: string[];
  run(argv: string[], env?: Record<string, string>): Promise<RunResult>;
  /** The records of the deployment, opened as the runtime role (closed by the caller). */
  kit(): Promise<RecordsKit>;
}

interface SetupOptions {
  keyProvider?: () => KeyProvider;
  tokens?: OperatorTokenStore & { value: string | null };
  /** Replaces the token store altogether (a keychain store over a fake security tool); `tokens` is then null. */
  store?: (config: HubConfig, service: string) => OperatorTokenStore;
  initAdmin?: boolean;
  deployment?: { key?: boolean; extra?: Record<string, string> };
}

async function setup(options: SetupOptions = {}): Promise<Admin> {
  const deployment = await harness.deployment(options.deployment);
  deployments.push(deployment);
  const tokens = options.store === undefined ? (options.tokens ?? memoryOperatorTokens(null, '测试钥匙串')) : null;
  const stdin: string[] = [];
  const commandOptions: AdminCommandOptions = {
    tokens: options.store ?? (() => tokens as OperatorTokenStore),
    readSecret: async () => {
      const value = stdin.shift();
      if (value === undefined) throw new Error('测试没有准备标准输入');
      return value;
    },
    // No `log`: the commands' assemblies write their log lines to the CLI's stderr, which the secret scan covers.
    assembly: { requireOsIsolation, resourceCacheMs: 0 },
  };
  const module: AssemblyModule = {
    assemble: createAssembly(commandOptions.assembly),
    registerCommands: (register) => {
      for (const command of adminCommands(commandOptions)) register(command);
    },
  };
  const admin: Admin = {
    deployment,
    tokens,
    init: null,
    stdin,
    // The server CLI's built-in state-changing commands read the same operator token store as the assembly's commands.
    run: (argv, env = {}) => deployment.run(argv, { assembly: async () => module, operatorTokens: commandOptions.tokens, ...(options.keyProvider ? { keyProvider: options.keyProvider } : {}) }, env),
    kit: () => openRecords(loadServerConfig(deployment.env), { migrate: false, keyProvider: options.keyProvider?.() ?? deployment.key }),
  };
  if (options.initAdmin !== false) {
    const init = await admin.run(['init-admin', '根管理员']);
    assert.equal(init.code, 0, init.text);
    admin.init = init;
    if (tokens?.value) secrets.add(tokens.value);
  }
  return admin;
}

async function withKit<T>(admin: Admin, fn: (kit: RecordsKit) => Promise<T>): Promise<T> {
  const kit = await admin.kit();
  try {
    return await fn(kit);
  } finally {
    await kit.close();
  }
}

/** A user with a token (built-in commands of the server CLI), the token kept secret. */
async function userWithToken(admin: Admin, name: string): Promise<string> {
  assert.equal((await admin.run(['user', 'create', name])).code, 0);
  const issued = await admin.run(['token', 'issue', name]);
  assert.equal(issued.code, 0, issued.text);
  const token = issued.out.find((line) => /^[A-Za-z0-9_-]{43}$/.test(line));
  assert.ok(token);
  secrets.add(token);
  // Built-in issue prints the token once, by design; that line is not one of the assembly's outputs.
  admin.deployment.printed.splice(admin.deployment.printed.indexOf(token), 1);
  return token;
}

async function expectOk(admin: Admin, argv: string[], env?: Record<string, string>): Promise<RunResult> {
  const result = await admin.run(argv, env);
  assert.equal(result.code, 0, `${argv.join(' ')}\n${result.text}`);
  return result;
}

/** A fake security tool holding generic-password items in memory; `locked` makes every read of a secret fail (exit 36). */
function fakeKeychain() {
  const items = new Map<string, string>();
  const state = { locked: false };
  const keyOf = (args: readonly string[]) => `${args[args.indexOf('-s') + 1]}/${args[args.indexOf('-a') + 1]}`;
  const runner: CommandRunner = async (_command, args, options = {}) => {
    if (args[0] === '-i') {
      const m = /^add-generic-password -s (\S+) -a (\S+) -w ([0-9a-f]{64})\n$/.exec(options.input ?? '');
      if (m === null) return { code: 1, stdout: '', stderr: 'bad command' };
      items.set(`${m[1]}/${m[2]}`, m[3]);
      return { code: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'find-generic-password') {
      const value = items.get(keyOf(args));
      if (value === undefined) return { code: 44, stdout: '', stderr: 'The specified item could not be found in the keychain.' };
      if (!args.includes('-w')) return { code: 0, stdout: 'keychain: "synthetic"\n', stderr: '' };
      return state.locked ? { code: 36, stdout: '', stderr: 'User interaction is not allowed.' } : { code: 0, stdout: `${value}\n`, stderr: '' };
    }
    return { code: 1, stdout: '', stderr: 'unexpected' };
  };
  return { runner, items, state };
}

async function countRecords(kit: RecordsKit, kind: RecordKind): Promise<number> {
  let count = 0;
  let cursor: string | null = null;
  do {
    const page: { items: unknown[]; next: string | null } = await kit.store.list({ kind, limit: 500, cursor });
    count += page.items.length;
    cursor = page.next;
  } while (cursor !== null);
  return count;
}

async function countFiles(dir: string): Promise<number> {
  return (await readdir(dir)).length;
}

describe('init-admin and the operator token', () => {
  test('an existing administrator can reissue into the Linux file store without displaying the token', async () => {
    const admin = await setup({store:(config,service)=>fileOperatorTokens(config.dataDir,service ?? config.keychain.service)});
    const config=loadServerConfig(admin.deployment.env);const store=fileOperatorTokens(config.dataDir,config.keychain.service);
    const original=await store.read();assert.ok(original);secrets.add(original);
    const master=fileKeyStore({root:config.dataDir,service:config.keychain.service,account:'synthetic-master',item:VAULT_KEY_ITEM});
    await master.write(Buffer.alloc(32,17));
    const refused=await admin.run(['operator-token','reissue']);
    assert.equal(refused.code,1);assert.match(refused.text,/remove --confirm-only-operator-token/);assert.doesNotMatch(refused.text,/钥匙串访问/);
    assert.equal((await admin.run(['operator-token','remove'])).code,2);
    assert.equal(await store.read(),original);
    const tokenId=await withKit(admin,async kit=>(await kit.principals.tokens((await kit.principals.findByName('根管理员'))!.id))[0]!.id);
    const revoked=await admin.run(['token','revoke',tokenId]);
    assert.equal(revoked.code,0,revoked.text);assert.match(revoked.text,/remove --confirm-only-operator-token/);
    assert.equal((await admin.run(['operator-token','remove','--confirm-only-operator-token'])).code,0);
    assert.equal(await store.read(),null);
    assert.equal((await admin.run(['operator-token','remove','--confirm-only-operator-token'])).code,0);
    assert.deepEqual(await master.read(),Uint8Array.from(Buffer.alloc(32,17)));
    const result=await admin.run(['operator-token','reissue','--as','根管理员']);
    assert.equal(result.code,0,result.text);const token=await store.read();assert.ok(token && token!==original);secrets.add(token);
    assert.ok(!result.text.includes(token));await expectOk(admin,['user','create','合成用户']);
  });
  test('init-admin creates the first admin and stores its token without printing it; it is refused once an admin exists', async () => {
    const admin = await setup();
    const token = admin.tokens?.value;
    assert.ok(token, 'the token is in the store');
    const principal = await withKit(admin, (kit) => kit.principals.authenticate(`Bearer ${token}`));
    assert.equal(principal?.role, 'admin');
    assert.equal(principal?.name, '根管理员');
    // The keychain item is the normal path; an exported CIRCLE_HUB_TOKEN would make serve refuse to start.
    assert.match(admin.init?.text ?? '', /它的令牌 tok_[0-9a-z]{26} 已存进测试钥匙串，没有显示/);
    assert.match(admin.init?.text ?? '', /之后改变状态的命令（user、token 和 pack、resource、secret、knowledge 里的这类命令）都从这个钥匙串项读管理员令牌/);
    assert.doesNotMatch(admin.init?.text ?? '', /CIRCLE_HUB_TOKEN/);
    const again = await admin.run(['init-admin', '第二位']);
    assert.equal(again.code, 1);
    assert.match(again.text, /已经有管理员/);
    assert.match(again.text, /token issue/);
    assert.match(again.text, /操作令牌丢了（钥匙串项丢失，或它的令牌已撤销）就用 circle-hub operator-token reissue/, 'a way that works without the token');
    assert.equal((await admin.run(['init-admin'])).code, 2);
  });

  test('init-admin refuses when the store already holds a token, and creates nobody', async () => {
    const admin = await setup({ tokens: memoryOperatorTokens('A'.repeat(43), '测试钥匙串'), initAdmin: false });
    const result = await admin.run(['init-admin', '根管理员']);
    assert.equal(result.code, 1);
    assert.match(result.text, /测试钥匙串里已经有操作令牌/);
    assert.equal((await withKit(admin, (kit) => kit.principals.list())).length, 0);
  });

  test('when the token cannot be stored, the admin exists, its token is revoked and the fix is operator-token reissue, which needs no token', async () => {
    const failing = Object.assign(memoryOperatorTokens(null, '测试钥匙串'), {
      async write() {
        throw new Error('钥匙串已锁定（合成）');
      },
    });
    const admin = await setup({ tokens: failing, initAdmin: false });
    const result = await admin.run(['init-admin', '根管理员']);
    assert.equal(result.code, 1);
    assert.match(result.text, /没能存进测试钥匙串：钥匙串已锁定（合成）。这个令牌已撤销，没有显示/);
    assert.match(result.text, /处理：钥匙串能用后（例如解锁了钥匙串）用 circle-hub operator-token reissue --as 根管理员 签发新令牌存进钥匙串（不显示）$/);
    assert.doesNotMatch(result.text, /token issue/, 'never a command that needs the token that could not be stored');
    await withKit(admin, async (kit) => {
      const user = (await kit.principals.findByName('根管理员'))!;
      const tokens = await kit.principals.tokens(user.id);
      assert.equal(tokens.length, 1);
      assert.notEqual(tokens[0].revoked_at, null, 'the unseen token was revoked');
    });
    assert.ok(!result.out.some((line) => /^[A-Za-z0-9_-]{43}$/.test(line)), 'no token printed');
  });

  test('when the token cannot be stored and its revocation is not confirmed, init-admin says the token may be live and names token revoke', async () => {
    let open: () => Promise<RecordsKit> = () => Promise.reject(new Error('not set up'));
    const failing = Object.assign(memoryOperatorTokens(null, '测试钥匙串'), {
      async write() {
        // The token is taken away before the command's own revocation, which then finds nothing to revoke (false).
        const kit = await open();
        try {
          const user = (await kit.principals.findByName('根管理员'))!;
          const [issued] = await kit.principals.tokens(user.id);
          await kit.principals.revokeToken({ id: user.id, name: user.name, role: user.role }, issued.id);
        } finally {
          await kit.close();
        }
        throw new Error('读回超时（合成）');
      },
    });
    const admin = await setup({ tokens: failing, initAdmin: false });
    open = admin.kit;
    const result = await admin.run(['init-admin', '根管理员']);
    assert.equal(result.code, 1);
    assert.match(result.text, /这个没有显示过的令牌 (tok_[0-9a-z]{26}) 没能确认已经撤销/);
    const id = /令牌 (tok_[0-9a-z]{26}) 没能确认/.exec(result.text)![1];
    // First a working operator token (the reissue needs none), then the revocation (which needs one).
    assert.match(result.text, new RegExp(`处理：钥匙串能用后（例如解锁了钥匙串）用 circle-hub operator-token reissue --as 根管理员 签发新令牌存进钥匙串（不显示）；再用 circle-hub token revoke ${id} 撤销这个没有显示过的令牌$`));
    assert.doesNotMatch(result.text, /这个令牌已撤销/);
  });

  test('when the revocation itself fails, init-admin says so with the reason (a fake context, no database)', async () => {
    const at = '2026-10-22T00:00:00.000Z';
    const user = { id: 'usr_00000000000000000000000001', name: '根管理员', role: 'admin', disabled: false, created_at: at } as unknown as User;
    const kit = {
      principals: {
        list: async () => [],
        bootstrapAdmin: async () => ({ user, token: { id: 'tok_00000000000000000000000001', token: 'A'.repeat(43), label: '', created_at: at } }),
        revokeToken: async () => {
          throw new Error('数据库连接断开（合成）');
        },
      },
    } as unknown as RecordsKit;
    const config: HubConfig = {
      dataDir: join(harness.scratch, 'fake-data'),
      logDir: join(harness.scratch, 'fake-data', 'logs'),
      host: '127.0.0.1',
      port: 0,
      database: { host: harness.postgres.socketDir, port: harness.postgres.config.port, database: 'unused', user: 'unused' },
      keychain: { service: 'circle-hub-test', account: 'vault' },
      limits: { ...DEFAULT_LIMITS },
    };
    const store = Object.assign(memoryOperatorTokens(null, '测试钥匙串'), {
      async write() {
        throw new Error('钥匙串已锁定（合成）');
      },
    });
    const ctx: CliContext = {
      io: { stdout: () => {}, stderr: () => {}, env: {}, cwd: harness.scratch },
      config: () => config,
      records: async () => kit,
      deps: async () => Promise.reject(new Error('not used')),
      actingAdmin: async () => Promise.reject(new Error('not used')),
    };
    const initAdmin = adminCommands({ tokens: () => store }).find((command) => command.name === 'init-admin')!;
    await assert.rejects(initAdmin.run(['根管理员'], ctx), (error: unknown) => {
      assert.ok(error instanceof CliError);
      assert.match(error.message, /没能存进测试钥匙串：钥匙串已锁定（合成）。这个没有显示过的令牌 tok_00000000000000000000000001 没能确认已经撤销（数据库连接断开（合成））/);
      assert.equal(
        error.hint,
        '钥匙串能用后（例如解锁了钥匙串）用 circle-hub operator-token reissue --as 根管理员 签发新令牌存进钥匙串（不显示）；再用 circle-hub token revoke tok_00000000000000000000000001 撤销这个没有显示过的令牌',
      );
      return true;
    });
  });

  test('a lost keychain item is recovered without any token: operator-token reissue stores a new admin token, never shown, and every refusal on the way names it', async () => {
    const admin = await setup();
    const original = admin.tokens!.value!;
    await userWithToken(admin, '甲');
    // The item is lost (a reset login keychain, another Mac); init-admin never showed its token.
    admin.tokens!.value = null;
    for (const argv of [['token', 'issue', '根管理员', '--raw'], ['user', 'create', '新管理员', '--role', 'admin'], ['pack', 'grant-publish', '根管理员']]) {
      const refused = await admin.run(argv);
      assert.equal(refused.code, 1, argv.join(' '));
      assert.match(refused.text, /要管理员令牌，没有找到/);
      assert.match(refused.text, /用 circle-hub operator-token reissue 给一位启用中的管理员签发新令牌存进测试钥匙串（不显示）/, argv.join(' '));
    }
    const init = await admin.run(['init-admin', '另一位']);
    assert.match(init.text, /operator-token reissue/);
    // operator-token set wants a token; without one its refusal names the reissue, never `token issue`.
    admin.stdin.push('B'.repeat(43));
    const set = await admin.run(['operator-token', 'set']);
    assert.equal(set.code, 1);
    assert.match(set.text, /手里没有的话，用 circle-hub operator-token reissue 给一位启用中的管理员签发新令牌，直接存进钥匙串（不显示）/);
    assert.doesNotMatch(set.text, /token issue/);

    const reissued = await admin.run(['operator-token', 'reissue']);
    assert.equal(reissued.code, 0, reissued.text);
    const token = admin.tokens!.value;
    assert.ok(token !== null && token !== original, 'a new token is in the item');
    secrets.add(token);
    assert.ok(!reissued.text.includes(token), 'never shown');
    const id = /签发新的操作令牌 (tok_[0-9a-z]{26})/.exec(reissued.text)?.[1];
    assert.ok(id, reissued.text);
    assert.match(reissued.text, /^已为管理员 根管理员（usr_[0-9a-z]{26}）签发新的操作令牌 tok_[0-9a-z]{26}，存进了测试钥匙串，没有显示/);
    assert.match(reissued.text, /原来的操作令牌如果还有效（例如还留在另一台 Mac 的钥匙串里），用 circle-hub token list 根管理员 查看/);
    await withKit(admin, async (kit) => {
      assert.equal((await kit.principals.authenticate(`Bearer ${token}`))?.name, '根管理员');
      const root = (await kit.principals.findByName('根管理员'))!;
      const issued = (await kit.principals.tokens(root.id)).find((t) => t.id === id)!;
      assert.equal(issued.label, '操作令牌（重新签发）', 'the token list says where it came from');
      assert.equal(issued.created_by, root.id);
    });
    // The changing commands, built-in and the assembly's, act with it again.
    await expectOk(admin, ['user', 'create', '乙']);
    await expectOk(admin, ['pack', 'grant-publish', '根管理员']);
    // A reissue never replaces an item, working or not.
    const twice = await admin.run(['operator-token', 'reissue']);
    assert.equal(twice.code, 1);
    assert.match(twice.text, /测试钥匙串里已经有操作令牌，不覆盖/);
    assert.match(twice.text, /钥匙串访问/);
    assert.equal(admin.tokens!.value, token, 'unchanged');
  });

  test('revoking the operator token itself is done and said, with the way back; a dead item is replaced by a reissue once it is removed', async () => {
    const admin = await setup();
    const original = admin.tokens!.value!;
    const bootstrap = await withKit(admin, async (kit) => (await kit.principals.tokens((await kit.principals.findByName('根管理员'))!.id))[0].id);
    // Revocation is how a leaked token is stopped: it is never refused, and here it cuts off the item's own token.
    const revoked = await admin.run(['token', 'revoke', bootstrap]);
    assert.equal(revoked.code, 0, revoked.text);
    assert.ok(revoked.out.includes(`令牌 ${bootstrap} 已撤销，立即失效`));
    assert.ok(
      revoked.err.includes('注意：测试钥匙串里的操作令牌现在已不能用（令牌已撤销或账号已停用）：之后改变状态的命令会被拒绝；恢复：在“钥匙串访问”里删掉这个项，再运行 circle-hub operator-token reissue（给一位启用中的管理员签发新令牌存进钥匙串，不显示；有几位管理员时加 --as <管理员>）'),
      revoked.text,
    );
    const dead = await admin.run(['token', 'issue', '根管理员', '--raw']);
    assert.equal(dead.code, 1);
    assert.match(dead.text, /令牌无效，或者不属于启用中的管理员/);
    assert.match(dead.text, /处理：测试钥匙串里的操作令牌已不能用（已撤销、账号已停用或不再是管理员）：在“钥匙串访问”里删掉这个项，再运行 circle-hub operator-token reissue/);
    assert.equal((await admin.run(['operator-token', 'reissue'])).code, 1, 'the dead item is still there');
    admin.tokens!.value = null; // removed in Keychain Access
    await expectOk(admin, ['operator-token', 'reissue']);
    secrets.add(admin.tokens!.value!);
    assert.notEqual(admin.tokens!.value, original);
    // Revoking another token says nothing more.
    const other = await userWithToken(admin, '甲');
    const otherId = await withKit(admin, async (kit) => (await kit.principals.tokens((await kit.principals.findByName('甲'))!.id))[0].id);
    const quiet = await admin.run(['token', 'revoke', otherId]);
    assert.equal(quiet.code, 0);
    assert.deepEqual(quiet.err, [], 'the operator token still works');
    assert.ok(!quiet.text.includes(other));
    // CIRCLE_HUB_TOKEN for one command: revoking that very token is said for it alone.
    await expectOk(admin, ['user', 'create', '第二管理员', '--role', 'admin']);
    const extra = await expectOk(admin, ['token', 'issue', '第二管理员', '--raw']);
    const extraToken = extra.out[0];
    secrets.add(extraToken);
    admin.deployment.printed.splice(admin.deployment.printed.indexOf(extraToken), 1);
    const extraId = /签发令牌 (tok_[0-9a-z]{26})/.exec(extra.err[0])![1];
    const self = await admin.run(['token', 'revoke', extraId], { [OPERATOR_TOKEN_VARIABLE]: extraToken });
    assert.equal(self.code, 0, self.text);
    assert.deepEqual(self.err, ['注意：CIRCLE_HUB_TOKEN 给这条命令的管理员令牌现在已不能用（令牌已撤销或账号已停用）']);
    assert.ok(!self.text.includes(extraToken));
  });

  test('disabling the operator token\'s own account is said, with the way back through another admin', async () => {
    const admin = await setup();
    await expectOk(admin, ['user', 'create', '第二管理员', '--role', 'admin']);
    const disabled = await admin.run(['user', 'disable', '根管理员']);
    assert.equal(disabled.code, 0, disabled.text);
    assert.match(disabled.err.join('\n'), /注意：测试钥匙串里的操作令牌现在已不能用（令牌已撤销或账号已停用）：之后改变状态的命令会被拒绝；恢复：/);
    admin.tokens!.value = null;
    // Two admins existed; one is enabled now, so --as may be left out.
    const reissued = await expectOk(admin, ['operator-token', 'reissue']);
    assert.match(reissued.text, /^已为管理员 第二管理员（/);
    secrets.add(admin.tokens!.value!);
    await expectOk(admin, ['user', 'enable', '根管理员']);
  });

  test('operator-token reissue names its admin among several, refuses a user and revokes a token it cannot store', async () => {
    const admin = await setup();
    await expectOk(admin, ['user', 'create', '第二管理员', '--role', 'admin']);
    await userWithToken(admin, '甲');
    admin.tokens!.value = null;
    const ambiguous = await admin.run(['operator-token', 'reissue']);
    assert.equal(ambiguous.code, 1);
    assert.match(ambiguous.text, /有多位管理员，要用 --as <名字> 指明以谁的身份操作/);
    const user = await admin.run(['operator-token', 'reissue', '--as', '甲']);
    assert.equal(user.code, 1);
    assert.match(user.text, /甲 不是启用中的管理员/);
    assert.equal((await admin.run(['operator-token', 'reissue', 'extra'])).code, 2);
    assert.equal(admin.tokens!.value, null, 'nothing was stored');
    const named = await expectOk(admin, ['operator-token', 'reissue', '--as', '第二管理员']);
    assert.match(named.text, /^已为管理员 第二管理员（/);
    const stored = admin.tokens!.value!;
    secrets.add(stored);
    assert.equal((await withKit(admin, (kit) => kit.principals.authenticate(`Bearer ${stored}`)))?.name, '第二管理员');
    // A keychain that refuses the write: the issued token is revoked, never shown, and the message says so.
    admin.tokens!.value = null;
    const write = admin.tokens!.write;
    admin.tokens!.write = async () => {
      throw new Error('钥匙串已锁定（合成）');
    };
    try {
      const failed = await admin.run(['operator-token', 'reissue', '--as', '根管理员']);
      assert.equal(failed.code, 1);
      assert.match(failed.text, /^错误：已为管理员 根管理员（usr_[0-9a-z]{26}）签发新的操作令牌 tok_[0-9a-z]{26}，但令牌没能存进测试钥匙串：钥匙串已锁定（合成）。这个令牌已撤销，没有显示/);
      const id = /操作令牌 (tok_[0-9a-z]{26})，但/.exec(failed.text)![1];
      await withKit(admin, async (kit) => {
        const root = (await kit.principals.findByName('根管理员'))!;
        assert.notEqual((await kit.principals.tokens(root.id)).find((t) => t.id === id)?.revoked_at, null, 'the unseen token was revoked');
      });
    } finally {
      admin.tokens!.write = write;
    }
  });

  test('operator-token set stores an enabled admin\'s token read from stdin; it refuses an existing item, a user\'s token and anything invalid', async () => {
    const admin = await setup();
    const original = admin.tokens!.value!;
    admin.stdin.push(original);
    const exists = await admin.run(['operator-token', 'set']);
    assert.equal(exists.code, 1);
    assert.match(exists.text, /测试钥匙串里已经有操作令牌，不覆盖/);
    assert.match(exists.text, /钥匙串访问/);
    assert.deepEqual(admin.stdin, [original], 'no token was read for an item that exists');
    admin.stdin.length = 0;
    const userToken = await userWithToken(admin, '甲');
    // The item is lost (another Mac, a reset keychain).
    admin.tokens!.value = null;
    for (const [given, why] of [
      [userToken, /不属于启用中的管理员/],
      ['B'.repeat(43), /令牌无效/],
      ['不是令牌', /令牌无效/],
    ] as const) {
      admin.stdin.push(given);
      const refused = await admin.run(['operator-token', 'set']);
      assert.equal(refused.code, 1, refused.text);
      assert.match(refused.text, why);
      assert.equal(admin.tokens!.value, null, 'nothing was stored');
    }
    admin.stdin.push(`${original}\n`);
    const set = await admin.run(['operator-token', 'set']);
    assert.equal(set.code, 0, set.text);
    assert.equal(admin.tokens!.value, original, 'the admin\'s token is in the item again');
    assert.match(set.text, /已把管理员 根管理员（usr_[0-9a-z]{26}）的操作令牌存进测试钥匙串，没有显示/);
    // The changing commands, built-in and the assembly's, act with it again.
    assert.equal((await admin.run(['pack', 'grant-publish', '根管理员'])).code, 0);
    assert.equal((await admin.run(['user', 'create', '乙'])).code, 0);
    assert.equal((await admin.run(['operator-token', 'show'])).code, 2);
    assert.equal((await admin.run(['operator-token', 'set', 'extra'])).code, 2);
    for (const line of [...exists.out, ...exists.err, ...set.out, ...set.err]) assert.ok(!line.includes(original) && !line.includes(userToken), 'no token printed');
  });

  test('every state-changing command is refused without a token, with a non-admin token and with an invalid one', async () => {
    const admin = await setup();
    const userToken = await userWithToken(admin, '甲');
    const changing: string[][] = [
      ['pack', 'publish', packs.review],
      ['pack', 'grant-publish', '甲'],
      ['pack', 'revoke-publish', '甲'],
      ['pack', 'assign', '甲', REVIEW_PACK],
      ['pack', 'unassign', '甲', REVIEW_PACK],
      ['pack', 'retire', `${REVIEW_PACK}@1.0.0`],
      ['pack', 'activate', PRODUCT_PACK],
      ['pack', 'deactivate', PRODUCT_PACK],
      ['resource', 'add', AGILE_PACK, '--name', '合成敏捷', '--environment', 'test', '--origin', `agile-oauth=${agile.origin}`, ...syntheticCredentialArgs('username','password')],
      ['resource', 'disable', 'res_00000000000000000000000000'],
      ['resource', 'enable', 'res_00000000000000000000000000'],
      ['resource', 'reset-login', 'res_00000000000000000000000000'],
      ['knowledge', 'sync', '--product', 'DEMO'],
      ['knowledge', 'retract', '--entry', 'a'.repeat(64), '--reason', '合成撤回'],
    ];
    admin.stdin.push('never-read-synthetic-secret');
    for (const argv of changing) {
      const asUser = await admin.run(argv, { [OPERATOR_TOKEN_VARIABLE]: userToken });
      assert.equal(asUser.code, 1, `${argv.join(' ')}: ${asUser.text}`);
      assert.match(asUser.text, /不属于启用中的管理员/, argv.join(' '));
      const invalid = await admin.run(argv, { [OPERATOR_TOKEN_VARIABLE]: 'B'.repeat(43) });
      assert.equal(invalid.code, 1, argv.join(' '));
      assert.match(invalid.text, /令牌无效/);
    }
    const stored = admin.tokens!.value;
    admin.tokens!.value = null;
    for (const argv of changing) {
      const without = await admin.run(argv);
      assert.equal(without.code, 1, argv.join(' '));
      assert.match(without.text, /要管理员令牌，没有找到/);
      // CIRCLE_HUB_TOKEN is offered for this one command only, never as an exported shell variable.
      assert.match(without.text, /CIRCLE_HUB_TOKEN="\$T" circle-hub <命令>/);
      assert.match(without.text, /不要 export CIRCLE_HUB_TOKEN/);
    }
    admin.tokens!.value = stored;
    assert.deepEqual(admin.stdin, ['never-read-synthetic-secret'], 'no secret was read for a refused command');
    await withKit(admin, async (kit) => {
      assert.equal((await kit.store.list({ kind: 'pack_version' })).items.length, 0, 'nothing was published');
      assert.equal(await kit.authorizations.canPublish((await kit.principals.findByName('甲'))!.id), false);
      assert.deepEqual(await kit.vault.list(), [], 'nothing reached the vault');
    });
  });

  test('CIRCLE_HUB_TOKEN acts for the command and is taken out of the environment before the configuration is read', async () => {
    const admin = await setup();
    const token = admin.tokens!.value!;
    admin.tokens!.value = null;
    const env: NodeJS.ProcessEnv = { ...admin.deployment.env, [OPERATOR_TOKEN_VARIABLE]: token };
    const out: string[] = [];
    const { main } = await import('../cli.ts');
    const module: AssemblyModule = { assemble: createAssembly({ requireOsIsolation }), registerCommands: (register) => adminCommands({ tokens: () => admin.tokens!, assembly: { requireOsIsolation } }).forEach(register) };
    const code = await main(['pack', 'grant-publish', '根管理员'], {
      io: { stdout: (line) => out.push(line), stderr: (line) => out.push(line), env, cwd: harness.scratch },
      keyProvider: () => admin.deployment.key,
      assembly: async () => module,
    });
    assert.equal(code, 0, out.join('\n'));
    assert.equal(Object.hasOwn(env, OPERATOR_TOKEN_VARIABLE), false);
    assert.ok(!out.some((line) => line.includes(token)));
  });

  test('read-only commands act as the token\'s account: --as must name that account; without a token --as or the only admin', async () => {
    const admin = await setup();
    const userToken = await userWithToken(admin, '甲');
    const asUser = { [OPERATOR_TOKEN_VARIABLE]: userToken };
    for (const argv of [
      ['resource', 'list', '--as', '根管理员'],
      ['pack', 'list', '--as', '根管理员'],
      ['knowledge', 'roots', 'DEMO', '--as', '根管理员'],
    ]) {
      const result = await admin.run(argv, asUser);
      assert.equal(result.code, 1, `${argv.join(' ')}: ${result.text}`);
      assert.match(result.text, /--as 根管理员 与令牌的账号 甲 不一致：有令牌时只读命令以令牌的账号读取/);
      assert.doesNotMatch(result.text, /还没有资源|密钥库里还没有条目|还没有发布任何任务包/, 'nothing of the admin view was printed');
    }
    assert.deepEqual((await expectOk(admin, ['pack', 'list', '--as', '甲'], asUser)).out, ['没有分配给你的任务包'], '--as naming the token\'s own account');
    for(const argv of [['secret','list'],['var','list']]){const denied=await admin.run(argv,asUser);assert.equal(denied.code,1);assert.match(denied.text,/管理员/);}
    const invalid = await admin.run(['pack', 'list'], { [OPERATOR_TOKEN_VARIABLE]: 'C'.repeat(43) });
    assert.equal(invalid.code, 1);
    assert.match(invalid.text, /错误：CIRCLE_HUB_TOKEN 的令牌无效（不存在、已撤销，或者账号已停用）/);
    // The keychain item holds the admin's token: --as must name that admin too.
    assert.equal((await admin.run(['pack', 'list', '--as', '甲'])).code, 1);
    assert.deepEqual((await expectOk(admin, ['pack', 'list', '--as', '根管理员'])).out, ['还没有发布任何任务包']);
    // No token at all: --as, or the only enabled admin (reads are not an access boundary).
    admin.tokens!.value = null;
    assert.deepEqual((await expectOk(admin, ['pack', 'list'])).out, ['还没有发布任何任务包']);
    const notAdmin = await admin.run(['pack', 'list', '--as', '甲']);
    assert.equal(notAdmin.code, 1);
    assert.match(notAdmin.text, /甲 不是启用中的管理员/);
  });

  test('a keychain item that cannot be read costs a read-only command a notice, not the listing; a changing command is refused naming the operator token', async () => {
    const keychain = fakeKeychain();
    const services: string[] = [];
    const admin = await setup({
      store: (config, service) => {
        services.push(service);
        return keychainOperatorTokens({ service: service ?? config.keychain.service, runner: keychain.runner });
      },
      deployment: { extra: { CIRCLE_HUB_KEYCHAIN_SERVICE: 'circle-hub-rehearsal' } },
    });
    assert.deepEqual([...keychain.items.keys()], ['circle-hub-rehearsal/operator-token'], 'the item sits under the deployment\'s keychain service');
    for (const hex of keychain.items.values()) {
      secrets.add(hex);
      secrets.add(Buffer.from(hex, 'hex').toString('base64url'));
    }
    await expectOk(admin, ['pack', 'grant-publish', '根管理员']);
    keychain.state.locked = true;
    for (const argv of [['pack', 'list'], ['resource', 'list']]) {
      const result = await expectOk(admin, argv);
      assert.ok(
        result.err.some((line) => line === `注意：读不出钥匙串（服务 circle-hub-rehearsal，账户 operator-token）里的操作令牌（读取${OPERATOR_TOKEN_ITEM.label}失败（security 退出码 36）：User interaction is not allowed.）；这个只读命令按唯一启用的管理员读取`),
        result.text,
      );
      assert.ok(!result.text.includes(VAULT_KEY_ITEM.label), 'the item is the operator token, not the vault master key');
    }
    const secretListing=await admin.run(['secret','list']);assert.equal(secretListing.code,1);assert.match(secretListing.text,/操作令牌/);
    const refused = await admin.run(['pack', 'revoke-publish', '根管理员']);
    assert.equal(refused.code, 1);
    assert.match(refused.text, new RegExp(`错误：读不出钥匙串（服务 circle-hub-rehearsal，账户 operator-token）里的操作令牌：读取${OPERATOR_TOKEN_ITEM.label}失败（security 退出码 36）`));
    assert.match(refused.text, /处理：在这台 Mac 的登录会话里解锁钥匙串后重试；或者只给这一条命令一个令牌/);
    assert.ok(!refused.text.includes(VAULT_KEY_ITEM.label), 'the platform\'s vault key wording, whatever it is, never names this item');
    await withKit(admin, async (kit) => assert.equal(await kit.authorizations.canPublish((await kit.principals.findByName('根管理员'))!.id), true, 'nothing changed'));
    assert.ok(services.length > 0 && services.every((service) => service === 'circle-hub-rehearsal'), services.join(' '));
  });
});

describe('source', () => {
  const secret = ["Ftp1a2","b3c4d5","e9"].join('');
  const bytes = Buffer.from(['# 手册（合成）', '', '示例：', '', `    copy ftp://user:${secret}@192.0.2.10/images/system.bin flash:`, ''].join('\n'));
  const sha = createHash('sha256').update(bytes).digest('hex');

  test('a held-back source is listed, its findings shown as positions and shapes, accepted with a note and withdrawn again; no output carries the value', async () => {
    const admin = await setup();
    const read = { bytes, mediaType: 'text/markdown', origin: { read: { object: 'manuals:file:cli/manual.md@1', resource: 'manual-store', action: null } }, author: { user: null }, provenanceType: 'observed' as const, visibility: { readers: [], admins: true, packs: [], shareable: false }, name: 'manual.md' };
    await withKit(admin, async (kit) => void (await kit.artifacts.ingest(read)));
    const held = await expectOk(admin, ['source', 'held']);
    assert.ok(held.out.some((line) => line.startsWith(`${sha}\t`) && line.includes('basic_credential') && line.includes('manuals:file:cli/manual.md@1')), held.text);
    const findings = await expectOk(admin, ['source', 'findings', sha]);
    assert.match(findings.text, /第 5 行第 \d+ 列\tbasic_credential\t/);
    const accepted = await admin.run(['source', 'accept', sha]);
    assert.equal(accepted.code, 2, 'accepting needs a note');
    const noted = await expectOk(admin, ['source', 'accept', sha, '--note', '手册里的示例地址，口令是占位符']);
    assert.match(noted.text, /已接受 [0-9a-f]{64} 的 1 处命中/);
    await withKit(admin, async (kit) => {
      const again = await kit.artifacts.ingest(read);
      assert.equal(again.body.read_tier, 'model_readable', 'a read after the acceptance is kept as normal content');
    });
    assert.match((await expectOk(admin, ['source', 'withdraw', sha])).text, /已撤回对 [0-9a-f]{64} 的接受/);
    for (const output of [held.text, findings.text, noted.text]) {
      assert.ok(!output.includes(secret), 'the matched value never reaches the screen');
      assert.ok(!output.includes('192.0.2.10'), 'neither does the text around it');
    }
  });

  test('source commands distinguish current direct, derived and absent acceptance without disclosing matches or fingerprints', async () => {
    secrets.add(secret);
    const admin = await setup();
    const read = {bytes,mediaType:'text/markdown',origin:{read:{object:'manuals:file:synthetic/source.md'}},author:{user:null},provenanceType:'observed' as const,visibility:{readers:[],admins:true,packs:[],shareable:false}};
    let derivedSha = '';
    await withKit(admin,async kit => { await kit.artifacts.ingest(read); });
    assert.match((await expectOk(admin,['source','findings',sha])).text,/没有受理/);
    await expectOk(admin,['source','accept',sha,'--note','合成示例的受理']);
    await withKit(admin,async kit => {
      await kit.artifacts.ingest(read);
      const output = await kit.artifacts.ingest({bytes:Buffer.from(JSON.stringify({body:`copy ftp://user:${secret}@192.0.2.10/image.bin flash:`})),mediaType:'application/json',origin:{generated:{generator:'synthetic.cli@1',inputs:[`src:${sha}`]}},author:{user:null},provenanceType:'projected',visibility:read.visibility,derivedSources:[sha]});
      assert.equal(output.body.read_tier,'model_readable'); derivedSha = output.body.sha256;
    });
    const direct = await expectOk(admin,['source','findings',sha]); assert.match(direct.text,/直接受理/);
    const inherited = await expectOk(admin,['source','findings',derivedSha]); assert.match(inherited.text,/由派生覆盖/); assert.ok(inherited.text.includes(sha));
    const held = await expectOk(admin,['source','held']);
    assert.ok(held.out.some(line => line.startsWith(sha+'\t') && line.includes('直接受理')));
    assert.ok(held.out.some(line => line.startsWith(derivedSha+'\t') && line.includes('由派生覆盖')));
    await expectOk(admin,['source','withdraw',sha]);
    const withdrawn = await expectOk(admin,['source','findings',derivedSha]); assert.match(withdrawn.text,/没有受理/); assert.match(withdrawn.text,/只保留/);
    const heldAgain = await expectOk(admin,['source','held']);
    assert.ok(heldAgain.out.some(line => line.startsWith(derivedSha+'\t') && line.includes('没有受理') && line.includes('只保留')));
    for (const result of [direct,inherited,held,withdrawn,heldAgain]) {
      assert.ok(!result.text.includes(secret));
      assert.ok(!result.text.includes(createHash('sha256').update(secret).digest('hex')));
    }
  });

  test('a user who is not an administrator, a bad digest and a note that copies the value are refused', async () => {
    const admin = await setup();
    await withKit(admin, async (kit) => void (await kit.artifacts.ingest({ bytes, mediaType: 'text/markdown', origin: { read: { object: 'manuals:file:cli/manual.md@1', resource: 'manual-store', action: null } }, author: { user: null }, provenanceType: 'observed', visibility: { readers: [], admins: true, packs: [], shareable: false }, name: 'manual.md' })));
    assert.equal((await admin.run(['source', 'findings', 'xyz'])).code, 2);
    const copied = await admin.run(['source', 'accept', sha, '--note', `口令是 ${secret}`]);
    assert.equal(copied.code, 1);
    assert.ok(!copied.text.includes(secret), copied.text);
  });
});

describe('lease', () => {
  const holder = { user: 'usr_0123456789abcdefghjkmnpqrs', run: 'run_0123456789abcdefghjkmnpqrs' };

  /** A lease service over the deployment's database (the runtime role may lease). */
  const leaseServiceOf = (admin: Admin): LeaseService =>
    new LeaseService(
      new Database(
        createPool(
          {
            host: admin.deployment.env.CIRCLE_HUB_DATABASE_SOCKET_DIR as string,
            port: Number(admin.deployment.env.CIRCLE_HUB_DATABASE_PORT),
            database: admin.deployment.env.CIRCLE_HUB_DATABASE_NAME as string,
            user: admin.deployment.env.CIRCLE_HUB_DATABASE_USER as string,
          },
          2,
        ),
      ),
    );

  test('list shows the unexpired rows of a prefix with their holders and ends, and nothing without one', async () => {
    const admin = await setup();
    const leases = leaseServiceOf(admin);
    await leases.acquire({ keys: ['meadow/zone-1/target-a', 'meadow/zone-1/target-b'], ttlSeconds: 600, holder, prefix: 'meadow/', maxTtlSeconds: 1200 });
    const all = await expectOk(admin, ['lease', 'list']);
    assert.ok(all.out.some((line) => line.startsWith(`meadow/zone-1/target-a\t`)), all.text);
    assert.ok(all.out.some((line) => line.startsWith(`meadow/zone-1/target-b\t`)), all.text);
    const filtered = await expectOk(admin, ['lease', 'list', '--prefix', 'meadow/zone-2/']);
    assert.ok(filtered.out.every((line: string) => !line.startsWith('meadow/')), 'no row of another prefix');
    for (const line of all.out) assert.ok(!line.includes('lse_'), 'the lease id is internal; the line names key, holder, until');
    assert.ok(all.out.every((line) => line.split('\t').length >= 3), 'key, run, until on every line');
  });

  test('release frees the key with a reason; the reason lands in the action record; --reason is required', async () => {
    const admin = await setup();
    const leases = leaseServiceOf(admin);
    await leases.acquire({ keys: ['meadow/zone-9/target-x'], ttlSeconds: 600, holder, prefix: 'meadow/', maxTtlSeconds: 1200 });
    const missing = await admin.run(['lease', 'release', 'meadow/zone-9/target-x']);
    assert.equal(missing.code, 2, '--reason is required');
    const done = await expectOk(admin, ['lease', 'release', 'meadow/zone-9/target-x', '--reason', '维护窗口']);
    assert.ok(done.out.some((line) => /已释放/.test(line) && /meadow\/zone-9\/target-x/.test(line)), JSON.stringify(done.out));
    const view = await leases.view('meadow/');
    assert.ok(!view.entries.some((e: { key: string }) => e.key === 'meadow/zone-9/target-x'), 'the row is free');
    const log = await leases.actionLog('meadow/zone-9/');
    const forced = log.find((entry: Record<string, unknown>) => entry.op === 'force_release');
    assert.ok(forced, 'a force_release action was written');
    assert.match(JSON.stringify(forced), /维护窗口/, 'the reason is in the action record');
    const again = await admin.run(['lease', 'release', 'meadow/zone-9/target-x', '--reason', '再来一次']);
    assert.equal(again.code, 1);
    assert.match(again.text, /没有租约行/);
  });

  test('a user who is not an administrator gets the same answer as for a row that does not exist', async () => {
    const admin = await setup();
    const leases = leaseServiceOf(admin);
    await leases.acquire({ keys: ['meadow/zone-4/target-y'], ttlSeconds: 600, holder, prefix: 'meadow/', maxTtlSeconds: 1200 });
    const userToken = await userWithToken(admin, '丙');
    const listed = await admin.run(['lease', 'list'], { [OPERATOR_TOKEN_VARIABLE]: userToken });
    assert.equal(listed.code, 1);
    assert.match(listed.text, /只有管理员/);
    const released = await admin.run(['lease', 'release', 'meadow/zone-4/target-y', '--reason', 'r'], { [OPERATOR_TOKEN_VARIABLE]: userToken });
    assert.equal(released.code, 1);
    assert.ok(!released.text.includes('meadow/zone-4/target-y'), released.text);
    assert.match(released.text, /只有管理员|没有租约行/, 'the refusal does not reveal that the row exists');
    const view = await leases.view('meadow/');
    assert.ok(view.entries.some((e: { key: string }) => e.key === 'meadow/zone-4/target-y'), 'nothing was released');
  });
});

describe('original', () => {
  const one = Buffer.from('# 发布说明（合成）\n\n修复了 ALM-1。\n', 'utf8');
  const two = Buffer.from('<cli><tree/></cli>\n', 'utf8');
  const shaOne = createHash('sha256').update(one).digest('hex');
  const shaTwo = createHash('sha256').update(two).digest('hex');
  const readOrigin = (object: string) => ({ read: { object, resource: 'agile', action: null } });

  async function withOriginals(fn: (admin: Admin) => Promise<void>): Promise<void> {
    const admin = await setup();
    await withKit(admin, async (kit) => {
      await kit.artifacts.ingest({ bytes: one, mediaType: 'text/markdown', origin: readOrigin('agile:page:release-100@1'), author: { user: null }, provenanceType: 'observed', visibility: { readers: [], admins: true, packs: [], shareable: false }, name: 'release-100.md' });
      await kit.artifacts.ingest({ bytes: two, mediaType: 'text/xml', origin: readOrigin('build:file:tree-100.xml@1'), author: { user: null }, provenanceType: 'observed', visibility: { readers: [], admins: true, packs: [], shareable: false }, name: 'tree-100.xml' });
    });
    await fn(admin);
  }

  test('lists read originals with external id, digest, size and read time, filtered by prefix, without content', async () => {
    await withOriginals(async (admin) => {
      const all = await expectOk(admin, ['original', 'list']);
      assert.ok(all.out.some((line) => line.startsWith(`agile:page:release-100@1\t${shaOne}\t`) && line.includes(`${one.length} 字节`)), all.text);
      assert.ok(all.out.some((line) => line.startsWith(`build:file:tree-100.xml@1\t${shaTwo}\t`) && line.includes(`${two.length} 字节`)), all.text);
      const filtered = await expectOk(admin, ['original', 'list', '--external', 'agile:']);
      assert.equal(filtered.out.length, 1);
      assert.ok(filtered.out[0].startsWith(`agile:page:release-100@1\t${shaOne}`), filtered.text);
      const suffix = await expectOk(admin, ['original', 'list', '--suffix', '.xml@1', '--limit', '1']);
      assert.equal(suffix.out.length, 1);
      assert.ok(suffix.out[0].startsWith(`build:file:tree-100.xml@1\t${shaTwo}`), suffix.text);
      const limited = await expectOk(admin, ['original', 'list', '--limit', '1']);
      assert.equal(limited.out.length, 1);
      for (const line of [...all.out, ...filtered.out]) {
        assert.ok(!line.includes('修复了'), 'the content never reaches the screen');
        assert.ok(!line.includes('<tree'), 'the content never reaches the screen');
      }
    });
  });

  test('an unmatched suffix names the suffix filter with or without a prefix', async () => {
    await withOriginals(async admin => {
      for (const prefix of [[], ['--external', 'agile:']]) {
        const empty = await expectOk(admin, ['original', 'list', ...prefix, '--suffix', '.synthetic-missing']);
        assert.match(empty.text, /后缀/);
        assert.ok(!empty.text.includes('以这个前缀开头'));
      }
    });
  });

  test('exports a stored original to a new file with mode 0600, printing only size and digest', async () => {
    await withOriginals(async (admin) => {
      const dir = await mkdtemp(join(tmpdir(), 'circle-hub-original-'));
      try {
        const target = join(dir, 'release-100.md');
        const exported = await expectOk(admin, ['original', 'export', shaOne, '--out', target]);
        assert.ok(exported.out.some((line) => line.includes(`${one.length} 字节`) && line.includes(shaOne)), exported.text);
        const written = await readFile(target);
        assert.deepEqual(written, one, 'the file holds the exact bytes');
        const mode = (await stat(target)).mode & 0o777;
        assert.equal(mode, 0o600, 'the file is private to its owner');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  test('refuses an unknown digest, an existing file, a path that cannot be written and a bad digest shape', async () => {
    await withOriginals(async (admin) => {
      const dir = await mkdtemp(join(tmpdir(), 'circle-hub-original-'));
      try {
        const absent = await admin.run(['original', 'export', 'a'.repeat(64), '--out', join(dir, 'a')]);
        assert.equal(absent.code, 1);
        assert.match(absent.text, /Hub 没有保存这份原件/);
        assert.ok(!absent.text.includes('发布说明'), absent.text);
        const exists = join(dir, 'release-100.md');
        await writeFile(exists, '旧内容', { mode: 0o600 });
        const refused = await admin.run(['original', 'export', shaOne, '--out', exists]);
        assert.equal(refused.code, 1);
        assert.match(refused.text, /已存在/);
        assert.equal(await readFile(exists, 'utf8'), '旧内容', 'an existing file is never overwritten');
        const unwritable = await admin.run(['original', 'export', shaOne, '--out', join(dir, 'no-such-dir', 'x')]);
        assert.equal(unwritable.code, 1);
        assert.match(unwritable.text, /写不了|无法写|不能写/);
        assert.equal((await admin.run(['original', 'export', 'xyz', '--out', join(dir, 'b')])).code, 2);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  test('a user who is not an administrator gets the same answer as for a nonexistent original', async () => {
    await withOriginals(async (admin) => {
      const userToken = await userWithToken(admin, '乙');
      const listed = await admin.run(['original', 'list'], { [OPERATOR_TOKEN_VARIABLE]: userToken });
      assert.equal(listed.code, 1);
      assert.match(listed.text, /只有管理员/);
      const dir = await mkdtemp(join(tmpdir(), 'circle-hub-original-'));
      try {
        const exported = await admin.run(['original', 'export', shaOne, '--out', join(dir, 'x')], { [OPERATOR_TOKEN_VARIABLE]: userToken });
        assert.equal(exported.code, 1);
        assert.ok(!exported.text.includes(shaOne), exported.text);
        assert.ok(!exported.text.includes('agile:page:release-100'), exported.text);
        assert.match(exported.text, /Hub 没有保存这份原件|只有管理员/, 'the refusal does not reveal that the original exists');
        assert.equal(await countFiles(dir), 0, 'nothing is written');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});

describe('pack publish --stage', () => {
  test('publishes a copy of exactly the files pack.json lists, so a source directory may hold tests and a README', async () => {
    const admin = await setup();
    await expectOk(admin, ['pack', 'grant-publish', '根管理员']);
    const dir = (await writePack(join(packRoot, 'with-extras'), reviewPack('2.0.0'))).dir;
    await writeFile(join(dir, 'README.md'), '# notes\n');
    await writeFile(join(dir, 'functions-extra.test.ts'), 'export {};\n');
    const plain = await admin.run(['pack', 'publish', dir]);
    assert.equal(plain.code, 1, 'without --stage the extra files are a publish problem');
    assert.match(plain.text, /manifest\.unlisted_file|illegal_path/);
    const staged = await expectOk(admin, ['pack', 'publish', dir, '--stage']);
    assert.match(staged.text, /已发布 demo-check@2\.0\.0/);
    // A path that leaves the directory is refused before any copy; a listed file that is missing is reported by name.
    const original = await readFile(join(dir, 'pack.json'), 'utf8');
    const manifest = JSON.parse(original);
    await writeFile(join(dir, 'pack.json'), JSON.stringify({ ...manifest, files: manifest.files.map((f: { path: string }, k: number) => (k === 1 ? { ...f, path: '../escape.json' } : f)) }));
    const escaped = await admin.run(['pack', 'publish', dir, '--stage']);
    assert.equal(escaped.code, 1);
    assert.match(escaped.text, /不合法的文件路径/);
    await writeFile(join(dir, 'pack.json'), original);
    await rm(join(dir, manifest.files[0].path));
    const missing = await admin.run(['pack', 'publish', dir, '--stage']);
    assert.equal(missing.code, 1);
    assert.ok(missing.text.includes(`${manifest.files[0].path} 不是目录里的普通文件`), missing.text);
  });
});

describe('pack', () => {
  test('publish needs the publish right; then publish, list, assign, activate, unassign and retire', async () => {
    const admin = await setup();
    const userToken = await userWithToken(admin, '甲');
    const refused = await admin.run(['pack', 'publish', packs.review]);
    assert.equal(refused.code, 1);
    assert.match(refused.text, /publish\.no_right/);
    assert.match(refused.text, /pack grant-publish 根管理员/);
    await expectOk(admin, ['pack', 'grant-publish', '根管理员']);
    const published = await expectOk(admin, ['pack', 'publish', packs.review]);
    assert.match(published.text, /已发布 demo-check@1\.0\.0（工作流包，摘要 [0-9a-f]{64}）：样例 4\/4 通过/);
    assert.match(published.text, /pack assign <用户> demo-check/);
    assert.match((await expectOk(admin, ['pack', 'publish', packs.review])).text, /已经以同样的内容发布过/);
    const brokenDir = (await writePack(join(packRoot, 'broken'), withFiles(reviewPack('1.0.1'), { 'samples/negative/codes-bad.json': null }))).dir;
    const broken = await admin.run(['pack', 'publish', brokenDir]);
    assert.equal(broken.code, 1);
    assert.match(broken.text, /\[publish\.unsampled\]/);
    assert.match(broken.text, /任务包没有发布：1 个问题/);
    await expectOk(admin, ['pack', 'publish', packs.agile]);
    assert.match((await expectOk(admin, ['pack', 'publish', packs.product])).text, /pack activate demo/);

    const listed = await expectOk(admin, ['pack', 'list']);
    assert.ok(listed.out.some((line) => line.startsWith('demo-check@1.0.0\t工作流包\t合成用例检查\t已发布\t所有者 根管理员')), listed.text);
    assert.ok(listed.out.some((line) => line.startsWith('demo@1.0.0\t产品包\t合成产品线\t未启用')));
    assert.ok(listed.out.some((line) => line.startsWith('demo-agile@1.0.0\t系统包')));

    await expectOk(admin, ['pack', 'assign', '甲', REVIEW_PACK]);
    const product = await admin.run(['pack', 'assign', '甲', PRODUCT_PACK]);
    assert.equal(product.code, 1);
    assert.match(product.text, /处理：用 activate 启用这个产品包/);
    assert.equal((await admin.run(['pack', 'assign', '甲', AGILE_PACK])).code, 1);
    assert.equal((await admin.run(['pack', 'assign', '甲', `${REVIEW_PACK}@1.0.0`])).code, 2, 'assignments name a pack id');
    const mine = await expectOk(admin, ['pack', 'list'], { [OPERATOR_TOKEN_VARIABLE]: userToken });
    assert.deepEqual(mine.out, ['demo-check@1.0.0\t工作流包\t合成用例检查\t已发布'], 'a user sees the packs assigned to them');
    assert.match((await expectOk(admin, ['pack', 'list'])).text, /分配给 甲/);

    await expectOk(admin, ['pack', 'activate', PRODUCT_PACK]);
    assert.ok((await expectOk(admin, ['pack', 'list'])).out.some((line) => line.startsWith('demo@1.0.0\t产品包\t合成产品线\t已启用')));
    await expectOk(admin, ['pack', 'deactivate', PRODUCT_PACK]);
    assert.ok((await expectOk(admin, ['pack', 'list'])).out.some((line) => line.startsWith('demo@1.0.0\t产品包\t合成产品线\t未启用')));

    await expectOk(admin, ['pack', 'unassign', '甲', REVIEW_PACK]);
    assert.deepEqual((await expectOk(admin, ['pack', 'list'], { [OPERATOR_TOKEN_VARIABLE]: userToken })).out, ['没有分配给你的任务包']);
    await expectOk(admin, ['pack', 'retire', `${REVIEW_PACK}@1.0.0`]);
    assert.ok((await expectOk(admin, ['pack', 'list'])).out.some((line) => line.startsWith('demo-check@1.0.0\t工作流包\t合成用例检查\t已下架')));
    assert.equal((await admin.run(['pack', 'retire', REVIEW_PACK])).code, 2, 'retire names a version');
    assert.equal((await admin.run(['pack'])).code, 2);
    assert.equal((await admin.run(['pack', 'revoke-publish', '根管理员'])).code, 0);
    assert.equal((await admin.run(['pack', 'publish', packs.site])).code, 1, 'without the right again');
  });

  test('text from a pack, a resource or an argument reaches the terminal with every control character shown as an escape', async () => {
    const admin = await setup();
    await expectOk(admin, ['pack', 'grant-publish', '根管理员']);
    const ESC = String.fromCodePoint(0x1b);
    const BEL = String.fromCodePoint(0x07);
    const CSI = String.fromCodePoint(0x9b);
    const RLO = String.fromCodePoint(0x202e);
    // A title that would clear the line, move up, fake a second line, colour the rest and reverse it.
    const title = `${ESC}[2K${ESC}[1A伪造的行\n第二行${CSI}31m${RLO}反向${BEL}`;
    const dir = (await writePack(join(packRoot, 'hostile-title'), { ...reviewPack('1.0.0'), title })).dir;
    await expectOk(admin, ['pack', 'publish', dir]);
    const listed = await expectOk(admin, ['pack', 'list']);
    const line = listed.out.find((l) => l.startsWith('demo-check@1.0.0\t'));
    assert.ok(line, listed.text);
    const shown = ['\\x1b[2K\\x1b[1A伪造的行\\x0a第二行\\x9b31m', '\\', 'u202e反向\\x07'].join('');
    assert.equal(line.split('\t')[2], shown);
    await expectOk(admin, ['pack', 'publish', packs.agile]);
    const renamed = await expectOk(admin, [
      'resource', 'add', AGILE_PACK, '--name', `合成${ESC}]0;改了标题${BEL}`, '--environment', 'test',
      '--origin', `agile-oauth=${agile.origin}`, '--origin', `agile-api=${agile.origin}`, '--allow-plaintext', 'agile-oauth', '--allow-plaintext', 'agile-api', ...syntheticCredentialArgs('username','password')]);
    const usage = await admin.run(['pack', 'retire', `${ESC}[31m坏${BEL}`]);
    assert.equal(usage.code, 2);
    const printed = [...listed.out, ...listed.err, ...usage.out, ...usage.err, ...renamed.out, ...renamed.err];
    for (const text of printed) {
      assert.ok(![ESC, BEL, CSI, RLO].some((char) => text.includes(char)), `a raw control character reached the terminal: ${JSON.stringify(text.slice(0, 120))}`);
    }
    // The line breaks in the title cannot fake a line (the server core's own usage block is one multi-line text by design).
    assert.ok(!line.includes('\n'));
    assert.ok(usage.err.some((l) => l === '错误：下架要写 <包号>@<版本>：\\x1b[31m坏\\x07'), usage.text);
    assert.ok(renamed.out.some((l) => l.includes('合成\\x1b]0;改了标题\\x07')), renamed.text);
  });
});

describe('resource and secret', () => {
  test('add and list a resource, set its credentials from stdin (the password kept as its digest), read through it, disable and enable', async () => {
    const admin = await setup();
    await expectOk(admin, ['pack', 'grant-publish', '根管理员']);
    await expectOk(admin, ['pack', 'publish', packs.agile]);
    const usage = [
      ['resource', 'add', AGILE_PACK, '--name', 'x', '--environment', 'staging', '--origin', `agile-oauth=${agile.origin}`, ...syntheticCredentialArgs('username','password')],
      ['resource', 'add', AGILE_PACK, '--environment', 'test', '--origin', `agile-oauth=${agile.origin}`, ...syntheticCredentialArgs('username','password')],
      ['resource', 'add', AGILE_PACK, '--name', 'x', '--environment', 'test', '--origin', `agile-oauth=${agile.origin}`, '--allow-plaintext', 'agile-api', ...syntheticCredentialArgs('username','password')],
      ['resource', 'add', AGILE_PACK, '--name', 'x', '--environment', 'test', '--origin', 'no-equals-sign', ...syntheticCredentialArgs('username','password')],
      ['resource', 'add', '--name', 'x', '--environment', 'test'],
    ];
    for (const argv of usage) assert.equal((await admin.run(argv)).code, 2, argv.join(' '));
    assert.match((await admin.run(usage[0])).text, /test（测试）、shared（共享）、production（生产）/);
    const added = await expectOk(admin, [
      'resource',
      'add',
      AGILE_PACK,
      '--name',
      '合成敏捷平台',
      '--environment',
      'test',
      '--origin',
      `agile-oauth=${agile.origin}`,
      '--origin',
      `agile-api=${agile.origin}`,
      '--allow-plaintext',
      'agile-oauth',
      '--allow-plaintext',
      'agile-api',
      '--setting-json',
      'roots=["7714"]', ...syntheticCredentialArgs('username','password')]);
    const id = /已添加资源 (res_[0-9a-z]{26})：合成敏捷平台（系统包 demo-agile@1\.0\.0，环境 测试）/.exec(added.text)?.[1];
    assert.ok(id, added.text);
    assert.match(added.text,/密钥 DEMO_.*还没有设置/);assert.match(added.text,/secret set --name/);
    const listed = await expectOk(admin, ['resource', 'list']);
    assert.equal(listed.out.length, 1);
    const fields = listed.out[0].split('\t');
    assert.deepEqual(fields.slice(0, 5), [id, '合成敏捷平台', 'demo-agile@1.0.0', '测试', '启用']);
    assert.deepEqual(fields[5].split(' ').sort(), [`agile-api=${agile.origin}`, `agile-oauth=${agile.origin}`]);
    assert.equal(fields[6],`允许明文 ${agile.origin}`);assert.match(fields[7],/secret set --name/);

    admin.stdin.push('reader', PASSWORD);
    assert.match((await expectOk(admin, await setArgs(admin,id,'username'))).text, /第 1 版/);
    const set = await expectOk(admin, await setArgs(admin,id,'password'));
    assert.match(set.text, /Base64\(SHA-512\)/);
    assert.match(set.text,/使用者/);assert.ok(set.text.includes(id));
    const missing = await admin.run(['secret', 'set', id, 'token']);
    assert.equal(missing.code,2,'retired positional syntax is rejected');assert.match(missing.text,/resource update/);assert.match(missing.text,/--credential/);
    assert.equal((await admin.run(['secret', 'set', 'res_00000000000000000000000000', 'password'])).code, 2);
    assert.equal((await admin.run(['secret', 'set', id])).code, 2);
    assert.equal(admin.stdin.length, 0, 'nothing was read for a refused credential');
    await withKit(admin, async (kit) => {
      assert.equal(await storedNamed(kit,id,'password'), passwordDigest(PASSWORD), 'Base64(SHA-512) as the profile says, never the value');
      assert.equal(await storedNamed(kit,id,'username'), 'reader');
      // The stored digest logs in: a read through the resource works.
      const hub = await assembleHub(loadServerConfig(admin.deployment.env), kit, { requireOsIsolation, resourceCacheMs: 0, log: (line) => admin.deployment.printed.push(line) });
      const by = (await kit.principals.findByName('根管理员'))!;
      const read = await hub.external.read(`agile:mindmap:${DOCUMENT}`, { principal: { id: by.id, name: by.name, role: by.role }, purpose: '测试' });
      assert.equal(read.ok, true, read.ok ? '' : read.reason);
    });
    assert.equal(agile.logins, 1);

    const names = await expectOk(admin, ['secret', 'list']);
    assert.match(names.text,/第 1 版/);assert.match(names.text,/登录状态条目/);assert.ok(!names.text.includes(PASSWORD));
    const userToken = await userWithToken(admin, '甲');
    assert.equal((await admin.run(['secret', 'list'], { [OPERATOR_TOKEN_VARIABLE]: userToken })).code, 1, 'names are for admins');
    const forUser = await admin.run(['resource', 'list'], { [OPERATOR_TOKEN_VARIABLE]: userToken });
    assert.equal(forUser.code, 1, 'resources are for admins');
    assert.match(forUser.text, /只有管理员能列出资源/);

    assert.match((await expectOk(admin, ['resource', 'list'])).out[0], /\t密钥库里的登录状态：已登录（到期 /);
    await expectOk(admin, ['resource', 'disable', id]);
    assert.match((await expectOk(admin, ['resource', 'list'])).out[0], /\t停用/);
    const hiddenSettings=await expectOk(admin,['resource','show',id]);assert.match(hiddenSettings.text,/设置 roots/);assert.ok(!hiddenSettings.text.includes('[\"7714\"]'));
    const literalSettings=await expectOk(admin,['resource','show',id,'--values']);assert.ok(literalSettings.text.includes('[\"7714\"]'));
    await expectOk(admin, ['resource', 'enable', id]);
    await expectOk(admin, ['resource', 'reset-login', id]);
    assert.match((await expectOk(admin, ['resource', 'list'])).out[0], /\t启用\t.*\t密钥库里的登录状态：还没有登录$/);
    assert.equal((await admin.run(['resource', 'disable', 'res_00000000000000000000000000'])).code, 1);
  });

  test('update changes metadata and addresses while merging settings by key, and refuses what makes no sense', async () => {
    const admin = await setup();
    await expectOk(admin, ['pack', 'grant-publish', '根管理员']);
    await expectOk(admin, ['pack', 'publish', packs.agile]);
    const added = await expectOk(admin, ['resource', 'add', AGILE_PACK, '--name', '甲', '--environment', 'test', '--origin', `agile-oauth=${agile.origin}`, '--origin', `agile-api=${agile.origin}`, '--allow-plaintext', 'agile-oauth', '--allow-plaintext', 'agile-api', '--setting-json', 'roots=["7714"]', ...syntheticCredentialArgs('username','password')]);
    const id = /已添加资源 (res_[0-9a-z]{26})/.exec(added.text)?.[1];
    assert.ok(id, added.text);
    const renamed = await expectOk(admin, ['resource', 'update', id, '--name', '乙', '--environment', 'shared', '--setting-json', 'roots=["7714","7001"]']);
    assert.match(renamed.text, new RegExp(`已更新资源 ${id}：乙（系统包 demo-agile@1\\.0\\.0，环境 共享）`));
    const listed = await expectOk(admin, ['resource', 'list']);
    const fields = listed.out[0].split('\t');
    assert.deepEqual(fields.slice(0, 5), [id, '乙', 'demo-agile@1.0.0', '共享', '启用']);
    assert.deepEqual(fields[5].split(' ').sort(), [`agile-api=${agile.origin}`, `agile-oauth=${agile.origin}`], 'what was not given is kept');
    for (const argv of [
      ['resource', 'update', id],
      ['resource', 'update', id, '--environment', 'staging'],
      ['resource', 'update', id, '--allow-plaintext', 'agile-api'],
      ['resource', 'update', id, '--name', ' '],
    ]) assert.equal((await admin.run(argv)).code, 2, argv.join(' '));
    assert.equal((await admin.run(['resource', 'update', 'res_00000000000000000000000000', '--name', '丙'])).code, 1, 'an unknown resource');
  });

  test('resource update origins prunes stale allow-plaintext entries with notification, clear-plaintext, and validates plaintext matching', async () => {
    const admin = await setup();
    await expectOk(admin, ['pack', 'grant-publish', '根管理员']);
    await expectOk(admin, ['pack', 'publish', packs.agile]);

    const added = await expectOk(admin, [
      'resource', 'add', AGILE_PACK,
      '--name', '明文测试资源',
      '--environment', 'test',
      '--origin', `agile-oauth=${agile.origin}`,
      '--origin', `agile-api=${agile.origin}`,
      '--allow-plaintext', 'agile-oauth',
      '--allow-plaintext', 'agile-api',
      '--setting-json', 'roots=["7714"]',
      ...syntheticCredentialArgs('username', 'password'),
    ]);
    const id = /已添加资源 (res_[0-9a-z]{26})/.exec(added.text)?.[1];
    assert.ok(id);

    const renamed = await expectOk(admin, ['resource', 'update', id, '--name', '改名测试', '--setting-json', 'roots=["7714","7002"]']);
    assert.ok(!renamed.text.includes('已清掉角色'));
    assert.ok(!renamed.text.includes('已清空所有明文放行'));
    const listAfterRename = await expectOk(admin, ['resource', 'list']);
    assert.ok(listAfterRename.out[0].includes(`允许明文 ${agile.origin}`), 'allow-plaintext remains when changing name/settings only');

    const moved = await expectOk(admin, [
      'resource', 'update', id,
      '--origin', 'agile-oauth=https://oauth.example.invalid',
      '--origin', 'agile-api=http://192.0.2.11:8080',
    ]);
    assert.match(moved.text, /已清掉角色 agile-api、agile-oauth 的明文放行/);
    const listAfterMove = await expectOk(admin, ['resource', 'list']);
    assert.ok(!listAfterMove.out[0].includes('允许明文'), 'old allow-plaintext entries were pruned');

    const allowed = await expectOk(admin, [
      'resource', 'update', id,
      '--origin', 'agile-oauth=http://192.0.2.12:8080',
      '--origin', 'agile-api=http://192.0.2.12:8080',
      '--allow-plaintext', 'agile-oauth',
      '--allow-plaintext', 'agile-api',
    ]);
    assert.ok(!allowed.text.includes('已清掉角色'));
    const listAfterAllow = await expectOk(admin, ['resource', 'list']);
    assert.ok(listAfterAllow.out[0].includes('允许明文 http://192.0.2.12:8080'));

    const conflict = await admin.run(['resource', 'update', id, '--clear-plaintext', '--allow-plaintext', 'agile-api']);
    assert.equal(conflict.code, 2);
    assert.match(conflict.text, /--clear-plaintext 与 --allow-plaintext 不能同时给/);

    const httpsRole = await admin.run([
      'resource', 'update', id,
      '--origin', 'agile-oauth=https://oauth.example.invalid',
      '--origin', 'agile-api=http://192.0.2.12:8080',
      '--allow-plaintext', 'agile-oauth',
    ]);
    assert.equal(httpsRole.code, 2);
    assert.match(httpsRole.text, /--allow-plaintext agile-oauth：只有 http 地址才需要允许明文/);

    const missingRole = await admin.run([
      'resource', 'update', id,
      '--origin', 'agile-oauth=http://192.0.2.12:8080',
      '--origin', 'agile-api=http://192.0.2.12:8080',
      '--allow-plaintext', 'other-role',
    ]);
    assert.equal(missingRole.code, 2);
    assert.match(missingRole.text, /--allow-plaintext other-role：同一条命令里要用 --origin 给出这个角色的地址（地址整项替换）/);

    const cleared = await expectOk(admin, ['resource', 'update', id, '--clear-plaintext']);
    assert.match(cleared.text, /已清空所有明文放行/);
    const listAfterClear = await expectOk(admin, ['resource', 'list']);
    assert.ok(!listAfterClear.out[0].includes('允许明文'), 'all plaintext cleared');

    await expectOk(admin, [
      'resource', 'update', id,
      '--origin', 'agile-oauth=http://192.0.2.13:8080',
      '--origin', 'agile-api=http://192.0.2.14:8080',
      '--allow-plaintext', 'agile-oauth',
      '--allow-plaintext', 'agile-api',
    ]);
    const partial = await expectOk(admin, [
      'resource', 'update', id,
      '--origin', 'agile-oauth=https://oauth.example.invalid',
      '--origin', 'agile-api=http://192.0.2.14:8080',
    ]);
    assert.match(partial.text, /已清掉角色 agile-oauth 的明文放行/);
    const listAfterPartial = await expectOk(admin, ['resource', 'list']);
    assert.ok(listAfterPartial.out[0].includes('允许明文 http://192.0.2.14:8080'), 'kept agile-api plaintext allowance');
  });

  test('a credential set or a login reset clears the vault\'s login state; a running Hub ends its stop at its next read, without a restart, and both commands say so', async () => {
    const admin = await setup();
    const stub = await startAgileStub(agileFixture(DOCUMENT, { password: PASSWORD }));
    try {
      await expectOk(admin, ['pack', 'grant-publish', '根管理员']);
      await expectOk(admin, ['pack', 'publish', packs.agile]);
      const added = await expectOk(admin, [
        'resource', 'add', AGILE_PACK, '--name', '合成敏捷平台', '--environment', 'test',
        '--origin', `agile-oauth=${stub.origin}`, '--origin', `agile-api=${stub.origin}`,
        '--allow-plaintext', 'agile-oauth', '--allow-plaintext', 'agile-api', '--setting-json', 'roots=["7714"]', ...syntheticCredentialArgs('username','password')]);
      const id = /已添加资源 (res_[0-9a-z]{26})/.exec(added.text)![1];
      admin.stdin.push('reader', WRONG_PASSWORD);
      await expectOk(admin, await setArgs(admin,id,'username'));
      await expectOk(admin, await setArgs(admin,id,'password'));

      // The running Hub: an assembly of its own over the same records and vault, as `serve` has in its own process.
      const kit = await admin.kit();
      try {
        const options = { requireOsIsolation, resourceCacheMs: 0, log: (line: string) => admin.deployment.printed.push(line) };
        const server = await assembleHub(loadServerConfig(admin.deployment.env), kit, options);
        const root = (await kit.principals.findByName('根管理员'))!;
        const principal = { id: root.id, name: root.name, role: root.role };
        const read = (hub = server) => hub.external.read(`agile:mindmap:${DOCUMENT}`, { principal, purpose: '测试' });
        const refused = await read();
        assert.equal(refused.ok, false);
        assert.match(refused.ok ? '' : refused.reason, /LOGIN_FAILED/);
        assert.equal(stub.logins, 1);
        assert.equal((await server.connectors.admin.loginStatus(principal, id))?.stopped, true);
        assert.match(
          (await expectOk(admin, ['resource', 'list'])).out[0],
          /\t密钥库里的登录状态：登录已停止（LOGIN_FAILED:1005）：用 secret set 重设凭据或 resource reset-login 解除（正在运行的 Hub 不用重启）$/,
        );

        admin.stdin.push(PASSWORD);
        const set = await expectOk(admin, await setArgs(admin,id,'password'));
        assert.match(set.text,/第 2 版/);
        assert.match(set.text,/在签发方吊销或换掉旧值/);
        assert.ok(set.text.includes(id));
        assert.doesNotMatch(set.text, /要重启 Hub 才解除/);
        assert.match((await expectOk(admin, ['resource', 'list'])).out[0], /\t密钥库里的登录状态：还没有登录$/, 'the column is the vault\'s state, read fresh');
        // What the messages describe (hub/connectors, "Between processes"): the running Hub reads the session entry again at
        // its next read that needs the credential, ends the stop it held and logs in once with the new value.
        const after = await read();
        assert.equal(after.ok, true, after.ok ? '' : after.reason);
        assert.equal(stub.logins, 2, 'one login with the new value, no restart');
        const reset = await expectOk(admin, ['resource', 'reset-login', id]);
        assert.match(reset.out.join('\n'), new RegExp(`资源 ${id} 在密钥库里的登录状态已清除：Hub 下一次要用这个资源的凭据时用已存的凭据登录一次`));
        assert.match(reset.err.join('\n'),/旧令牌、停止和冷却不再沿用/);
        // The running Hub holds a usable token: it keeps using it, no new login.
        assert.equal((await read()).ok, true);
        assert.equal(stub.logins,3,'reset invalidates the old token at the next read');
        // A restart takes the new version-bound session already stored by that read.
        const restarted = await assembleHub(loadServerConfig(admin.deployment.env), kit, options);
        const again = await read(restarted);
        assert.equal(again.ok, true, again.ok ? '' : again.reason);
        assert.equal(stub.logins,3);
      } finally {
        await kit.close();
      }
    } finally {
      await stub.close();
    }
  });

  test('without the vault master key the listings work, the login column says why, a reset works and secret set is refused before a value is read', async () => {
    const admin = await setup({ deployment: { key: false } });
    await expectOk(admin, ['pack', 'grant-publish', '根管理员']);
    await expectOk(admin, ['pack', 'publish', packs.agile]);
    const added = await expectOk(admin, [
      'resource', 'add', AGILE_PACK, '--name', '合成敏捷平台', '--environment', 'test',
      '--origin', `agile-oauth=${agile.origin}`, '--origin', `agile-api=${agile.origin}`, '--allow-plaintext', 'agile-oauth', '--allow-plaintext', 'agile-api', ...syntheticCredentialArgs('username','password')]);
    const id = /已添加资源 (res_[0-9a-z]{26})/.exec(added.text)![1];
    assert.match((await expectOk(admin, ['pack', 'list'])).out[0], /^demo-agile@1\.0\.0\t系统包/);
    assert.ok(!(await expectOk(admin,['secret','list'])).text.includes(PASSWORD));
    const listed = await expectOk(admin, ['resource', 'list']);
    assert.match(listed.out[0], /\t登录状态读不出：密钥库主密钥不存在；密钥只在显式初始化时创建$/);
    await expectOk(admin, ['resource', 'reset-login', id]);
    admin.stdin.push(PASSWORD);
    for (const argv of [await setArgs(admin,id,'password'), ['knowledge', 'sync', '--product', 'DEMO']]) {
      const refused = await admin.run(argv);
      assert.equal(refused.code, 1, argv.join(' '));
      assert.match(refused.text, /错误：密钥库主密钥不可用，这个命令要用密钥库，没有执行：密钥库主密钥不存在/, argv.join(' '));
      assert.doesNotMatch(refused.text, /Hub 不启动/);
    }
    assert.deepEqual(admin.stdin, [PASSWORD], 'no value was read');
  });
});

describe('knowledge', () => {
  test('sync reports produced, skipped and failed builds and exits non-zero on a failure; a second sync produces nothing; roots and diff read the result', async () => {
    const admin = await setup();
    await expectOk(admin, ['pack', 'grant-publish', '根管理员']);
    await expectOk(admin, ['pack', 'publish', packs.site]);
    await expectOk(admin, ['pack', 'publish', packs.xml]);
    await expectOk(admin, ['pack', 'install', 'xml-format@1.0.3']);
    await expectOk(admin, ['pack', 'publish', packs.html]);
    await expectOk(admin, ['pack', 'install', 'html-format@1.0.2']);
    await expectOk(admin, ['pack', 'publish', packs.product]);
    await expectOk(admin, ['pack', 'activate', PRODUCT_PACK]);
    await expectOk(admin, ['resource', 'add', SITE_PACK, '--name', '合成构建站', '--environment', 'shared', '--origin', `build-site=${site.origin}`]);

    const first = await admin.run(['knowledge', 'sync', '--product', 'DEMO']);
    assert.equal(first.code, 1, first.text);
    assert.match(first.text, /构建：产出 1，只登记名字 1，跳过 2，失败 1/);
    assert.match(first.text, /\[产出\] Rel_DEMO_2_1_0_5（DEMO，2\.1\.0）/);
    assert.match(first.text, /\[登记\] Rel_DEMO_2_1_0_7（DEMO，2\.1\.0）：没有可读的来源，只登记名字/);
    assert.match(first.text, /\[失败\] Rel_DEMO_2_0_0_9（DEMO，2\.0\.0）/);
    assert.match(first.text, /\[跳过\] Rel_ALT_2_1_0_5（ALT，2\.1\.0，基于 Rel_DEMO_2_1_0_5）/);
    assert.match(first.text, /\[跳过\] Rel_DEMO_2_1_0_6/);
    assert.doesNotMatch(first.text, /判断服务|模型归类/, 'no judgment-service wording in the sync report');

    // Idempotence: the same sources and producer give no new root and no new node.
    const trees = () => withKit(admin, async (kit) => ({ roots: await countRecords(kit, 'tree_root'), nodes: await countRecords(kit, 'tree_node') }));
    const before = await trees();
    assert.ok(before.roots > 0 && before.nodes > 0, JSON.stringify(before));
    const again = await admin.run(['knowledge', 'sync', '--product', 'DEMO']);
    assert.equal(again.code, 1, 'the build without a tree still fails');
    assert.match(again.text, /构建：产出 0，/);
    assert.match(again.text, /\[跳过\] Rel_DEMO_2_1_0_5（DEMO，2\.1\.0）：已有根，来源和生产器都没有变/);
    assert.deepEqual(await trees(), before, 'no tree_root or tree_node record was written');

    const line = await admin.run(['knowledge', 'sync', '--product', 'ALT', '--line', '2.1.0']);
    assert.equal(line.code, 0, line.text);
    assert.match(line.text, /失败 0/);
    const dry = await admin.run(['knowledge', 'sync', '--product', 'demo', '--line', '2.1.0', '--include-unreleased', '--dry-run']);
    assert.equal(dry.code, 0, dry.text);
    assert.match(dry.text, /试运行/);
    const newer = await admin.run(['knowledge', 'sync', '--product', 'demo', '--line', '2.1.0', '--include-unreleased']);
    assert.equal(newer.code, 0, newer.text);
    assert.match(newer.text, /\[产出\] Rel_DEMO_2_1_0_6/);
    assert.equal((await admin.run(['knowledge', 'sync', '--product', 'nothing'])).code, 1);
    assert.equal((await admin.run(['knowledge', 'sync'])).code, 2);
    assert.equal((await admin.run(['knowledge', 'sync', '--product', 'DEMO', '--bogus'])).code, 2);

    const roots = await expectOk(admin, ['knowledge', 'roots', 'ALT']);
    assert.match(roots.out[0], /^产品线 demo（DEMO、ALT）：5 个构建，2 条版本线$/);
    // Builds with a root come first, one line each; the name-only ones close the line as one count, not a flood.
    assert.match(roots.out.find((l) => l.includes('版本线 2.1.0：')) ?? '', /^版本线 2\.1\.0：当前根 /);
    assert.ok(roots.out.some((l) => /^  另有 1 个构建只有名字，还没有根$/.test(l)), roots.text);
    assert.ok(!roots.out.some((l) => l.startsWith('  Rel_DEMO_2_1_0_7\t')), 'a name-only build has no row of its own');
    assert.ok(roots.out.some((l) => /^版本线 2\.1\.0：当前根 [0-9a-f]{64}（构建 Rel_(DEMO|ALT)_2_1_0_5，产出于 /.test(l)), roots.text);
    assert.ok(roots.out.some((l) => /^版本线 2\.0\.0：还没有当前根$/.test(l)), 'the failed build has no root');
    const rootOf = (build: string) => new RegExp(`^  ${build}\\t.*\\t根 ([0-9a-f]{64})$`).exec(roots.out.find((l) => l.startsWith(`  ${build}\t`)) ?? '')?.[1];
    const older = rootOf('Rel_DEMO_2_1_0_5');
    const newest = rootOf('Rel_DEMO_2_1_0_6');
    assert.ok(older && newest && older !== newest, roots.text);
    assert.match(roots.out.find((l) => l.startsWith('  Rel_ALT_2_1_0_5\t')) ?? '', /基于 Rel_DEMO_2_1_0_5\t发布于 /);
    assert.match(roots.out.find((l) => l.startsWith('  Rel_DEMO_2_1_0_5\t')) ?? '', /\tDEMO\t自身为基础构建\t发布于 /);

    const diff = await expectOk(admin, ['knowledge', 'diff', older, newest]);
    assert.match(diff.out[0], new RegExp(`^从 ${older} 到 ${newest}：增加 [1-9]\\d*，删除 0，改动 \\d+$`));
    assert.ok(diff.out.includes('+ /commands/widget/reset'), diff.text);
    assert.equal((await admin.run(['knowledge', 'diff', older, 'not-a-root'])).code, 2);
    const unknown = await admin.run(['knowledge', 'diff', 'a'.repeat(64), 'b'.repeat(64)]);
    assert.equal(unknown.code, 1);
    assert.match(unknown.text, /没有这两个知识根/);

    const userToken = await userWithToken(admin, '甲');
    const neutral = await admin.run(['knowledge', 'roots', 'DEMO'], { [OPERATOR_TOKEN_VARIABLE]: userToken });
    assert.equal(neutral.code, 1, 'a user without a pack that binds the line reads nothing');
    assert.equal((await admin.run(['knowledge', 'diff', older, newest], { [OPERATOR_TOKEN_VARIABLE]: userToken })).code, 1);
    assert.equal((await admin.run(['knowledge'])).code, 2);
  });
});

describe('doc', () => {
  test('doc put/list/show publish and replace a named document; only name, digest and size are printed; non-admins get the same answer as for a missing doc', async () => {
    const admin = await setup();
    const file = join(packRoot, 'demo-doc.json');
    const first = JSON.stringify({ items: [{ title: '甲', expected: ['乙'] }] });
    await writeFile(file, first);
    const size1 = Buffer.byteLength(first);
    const put = await expectOk(admin, ['doc', 'put', 'topo-demo', file]);
    assert.match(put.out.join('\n'), /^已发布命名文档 topo-demo（摘要 [0-9a-f]{64}，\d+ 字节）$/m);
    const sha1 = /摘要 ([0-9a-f]{64})/.exec(put.out.join('\n'))![1];
    const listed = await expectOk(admin, ['doc', 'list']);
    assert.ok(listed.out.some((line) => line === `topo-demo\t${sha1}\t${size1} 字节`), listed.out.join('\n'));
    const shown = await expectOk(admin, ['doc', 'show', 'topo-demo']);
    assert.deepEqual(shown.out, [`topo-demo\t${sha1}\t${size1} 字节`]);

    const second = JSON.stringify({ items: [{ title: '甲', expected: ['乙'] }, { title: '丙', expected: ['丁'] }] });
    await writeFile(file, second);
    const size2 = Buffer.byteLength(second);
    const again = await expectOk(admin, ['doc', 'put', 'topo-demo', file]);
    const sha2 = /摘要 ([0-9a-f]{64})/.exec(again.out.join('\n'))![1];
    assert.notEqual(sha2, sha1, 'a replacement moves the pointer');
    const same = await expectOk(admin, ['doc', 'put', 'topo-demo', file]);
    assert.match(same.out.join('\n'), /已经是这份/);
    assert.deepEqual((await expectOk(admin, ['doc', 'show', 'topo-demo'])).out, [`topo-demo\t${sha2}\t${size2} 字节`]);

    const missing = await admin.run(['doc', 'show', 'no-such-doc']);
    assert.equal(missing.code, 1);
    assert.match(missing.text, /没有叫 no-such-doc 的命名文档/);

    const userToken = await userWithToken(admin, '甲');
    const env = { [OPERATOR_TOKEN_VARIABLE]: userToken };
    assert.deepEqual((await expectOk(admin, ['doc', 'list'], env)).out, ['还没有命名文档'], 'a non-admin lists as if none existed');
    const shownByUser = await admin.run(['doc', 'show', 'topo-demo'], env);
    assert.equal(shownByUser.code, 1);
    assert.match(shownByUser.text, /没有叫 topo-demo 的命名文档/, 'same answer as for a missing doc');
    const putByUser = await admin.run(['doc', 'put', 'other-doc', file], env);
    assert.equal(putByUser.code, 1);
    assert.match(putByUser.text, /没有叫 other-doc 的命名文档/);
    await withKit(admin, async (kit) => {
      const current = await kit.pointers.get('doc:other-doc');
      assert.equal(current, null, 'a non-admin put stored nothing');
    });

    const big = join(packRoot, 'big-doc.json');
    await writeFile(big, Buffer.alloc(2 * 1024 * 1024 + 1, 120));
    const over = await admin.run(['doc', 'put', 'topo-big', big]);
    assert.equal(over.code, 1);
    assert.match(over.text, /超过.*上限/);
    assert.equal((await admin.run(['doc', 'show', 'topo-big'])).code, 1, 'the oversize file was not stored');
    for (const bad of ['9bad', 'BAD']) {
      const refused = await admin.run(['doc', 'put', bad, file]);
      assert.equal(refused.code, 1, bad);
      assert.match(refused.text, /命名文档的名字/);
    }
    assert.equal((await admin.run(['doc'])).code, 2);
  });
});

describe('help', () => {
  test('the help text lists the administrator commands', async () => {
    const admin = await setup({ initAdmin: false });
    const help = await expectOk(admin, ['help']);
    for (const name of ['pack', 'resource', 'secret', 'knowledge', 'init-admin', 'operator-token', 'doc']) assert.match(help.text, new RegExp(`\\n  ${name} `), name);
    assert.doesNotMatch(help.text, /这个装配模块没有注册它/, 'every reserved command is registered');
    assert.match(help.text, /operator-token\s+set   从标准输入读一个启用中的管理员的令牌/);
  });
});

test('R32 a fresh administrator command exposes noncanonical action diagnostics without body text',async t=>{
  const admin=await setup();const kit=await admin.kit();t.after(()=>kit.close());
  const {newId,recordDigest}=await import('../../records/api.ts');
  const owner=new Database(createPool({...loadServerConfig(admin.deployment.env).database,user:harness.postgres.config.user},2));t.after(()=>owner.end());
  const input={kind:'action' as const,schema:'action@1',provenance:'observed' as const,created_at:'2026-10-23T00:00:00.000Z',body:{private_message:'SYNTHETIC_PRIVATE_DIAGNOSTIC',value:1}};
  const digest=recordDigest(input),text='{ "value": 1, "private_message": "SYNTHETIC_PRIVATE_DIAGNOSTIC" }';
  await owner.query('INSERT INTO records(id,digest,kind,schema,provenance,created_at,body,size) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[newId('rcd'),digest,input.kind,input.schema,input.provenance,input.created_at,text,Buffer.byteLength(text)]);
  const result=await admin.run(['records','verify','--kind','action']);assert.equal(result.code,0,result.text);
  assert.match(result.text,/正文不是规范写法/);assert.match(result.text,new RegExp(digest));assert.doesNotMatch(result.text,/SYNTHETIC_PRIVATE_DIAGNOSTIC/);
});

test('R33 lease release honors the configured record byte limit atomically',async t=>{
  const admin=await setup({deployment:{extra:{CIRCLE_HUB_MAX_RECORD_BYTES:'65536'}}});
  const kit=await admin.kit();t.after(()=>kit.close());const db=new Database(createPool(loadServerConfig(admin.deployment.env).database,2));t.after(()=>db.end());
  const {newId}=await import('../../records/api.ts');const user=await kit.principals.findByName('根管理员');assert.ok(user);
  const leases=new LeaseService(db,{records:kit.store});const key='synthetic/r33';
  const acquired=await leases.acquire({keys:[key],prefix:'synthetic/',ttlSeconds:60,maxTtlSeconds:3600,holder:{user:user.id,run:newId('run')}});assert.equal(acquired.ok,true);
  const result=await admin.run(['lease','release',key,'--reason','合成限额原因'.repeat(10000)]);
  assert.notEqual(result.code,0);assert.equal((await leases.holderSnapshot([key]))[0].released,false);
});

let syntheticCredentialCounter=0;
function syntheticCredentialArgs(...items:string[]) {const index=++syntheticCredentialCounter;return items.flatMap(item=>['--credential',item+'=DEMO_'+item.toUpperCase()+'_'+index]);}
const namedResourceCache=new Map<string,Record<string,string>>();
async function nameOf(admin:Admin,id:string,item:string):Promise<string>{
 let names=namedResourceCache.get(id);
 if(!names){names=await withKit(admin,async kit=>{const config=await kit.authorizations.resourceConfig(id);assert.ok(config?.body.bound);const source=JSON.parse(Buffer.from((await kit.objects.get(config.body.bound))!).toString());return Object.fromEntries(Object.entries(source.credentials).map(([key,value])=>{assert.equal(typeof value,'string');const name=secretNameOf(value as string);assert.ok(name);return [key,name];}));});namedResourceCache.set(id,names);}
 assert.ok(names[item],'synthetic resource must explicitly name the requested credential');return names[item];
}
async function setArgs(admin:Admin,id:string,item:string):Promise<string[]>{const name=await nameOf(admin,id,item);return ['secret','set','--name',name,'--reason','DEMO_ROTATE',...(item==='username'?['--short',name]:[]),...(item==='password'?['--digest',name+'=sha512_base64']:[])];}
async function storedNamed(kit:RecordsKit,id:string,item:string):Promise<string|null>{
 const config=await kit.authorizations.resourceConfig(id);assert.ok(config?.body.bound);const source=JSON.parse(Buffer.from((await kit.objects.get(config.body.bound))!).toString());const name=secretNameOf(source.credentials[item]);assert.ok(name);
 const admin=(await kit.principals.findByName('根管理员'))!;const version=(await kit.variables.list(admin)).find(v=>v.name===name&&v.kind==='secret');return version?.definition?.schema==='secret@1'?kit.vault.getText(version.definition.entry):null;
}
async function importResource(admin: Admin): Promise<string> {
  await expectOk(admin, ['pack', 'grant-publish', '根管理员']);
  await expectOk(admin, ['pack', 'publish', packs.agile]);
  return addImportResource(admin);
}
async function addImportResource(admin: Admin,environment:Environment='test'): Promise<string> {
  const added = await expectOk(admin, ['resource', 'add', AGILE_PACK, '--name', '合成导入', '--environment', environment, '--origin', `agile-oauth=${agile.origin}`, '--origin', `agile-api=${agile.origin}`, '--allow-plaintext', 'agile-oauth', '--allow-plaintext', 'agile-api', ...syntheticCredentialArgs('username','password')]);
  return /已添加资源 (res_[0-9a-z]{26})/.exec(added.text)![1];
}
async function importFile(admin: Admin, bytes: string | Uint8Array): Promise<string> {
  const path = join(admin.deployment.dataDir, 'synthetic.env');
  await writeFile(path, bytes, { mode: 0o600 }); return path;
}
const importArgs = async (admin:Admin,file:string,id:string) => {
 const user=await nameOf(admin,id,'username'),password=await nameOf(admin,id,'password');
 return ['secret','import','--env-file',file,'--key',`PORTAL_USER=${user}`,'--key',`PORTAL_PASSWORD=${password}`,'--digest',password+'=sha512_base64','--short',user,'--reason','DEMO_IMPORT'];
};

describe('secret import', () => {
  test('imports grouped credentials, hashes the password, shares a key across resources and supports dry run', async () => {
    const admin = await setup(); const id = await importResource(admin); const second = await addImportResource(admin,'production');
    const unrelated = 'SyntheticUnrelatedValue47'; secrets.add(unrelated); secrets.add('reader');
    const file = await importFile(admin, `# --- synthetic ---\nPORTAL_USER = reader\nPORTAL_PASSWORD = "${PASSWORD}"\nUNRELATED = ${unrelated}\n`);
    const args = [...await importArgs(admin,file,id), '--key', `PORTAL_USER=${await nameOf(admin,second,'username')}`, '--short',await nameOf(admin,second,'username')];
    const dry = await expectOk(admin, [...args, '--dry-run']); assert.match(dry.text, /PORTAL_USER：找到，长度 6/);
    assert.deepEqual(await withKit(admin, (kit) => kit.vault.list()), []);
    const result = await expectOk(admin, args); assert.match(result.text, /Base64\(SHA-512\)/);
    await withKit(admin, async (kit) => {
      assert.equal(await storedNamed(kit,id,'password'), passwordDigest(PASSWORD));
      assert.equal(await storedNamed(kit,second,'username'), 'reader');
      for (const name of await kit.vault.list()) assert.ok(!(await kit.vault.getText(name))?.includes(unrelated));
      const hub = await assembleHub(loadServerConfig(admin.deployment.env), kit, { requireOsIsolation, log: (line) => admin.deployment.printed.push(line) });
      const by = (await kit.principals.findByName('根管理员'))!;
      assert.equal((await hub.connectors.executeRead(id, 'mindmap', { id: DOCUMENT }, { principal: by, purpose: '合成导入核对' })).ok, true);
    });

  });

  test('review 5: an invalid later resource value is refused before any credential is written', async () => {
    const admin = await setup(); const first = await importResource(admin); const second = await addImportResource(admin,'production');
    const bad = 'Synthetic\tInvalidValue85'; secrets.add(bad); secrets.add('reader');
    const file = await importFile(admin, `PORTAL_USER=reader\nBAD=${bad}`);
    const result = await admin.run(['secret', 'import', '--env-file', file, '--key', `PORTAL_USER=${await nameOf(admin,first,'username')}`, '--key', `BAD=${await nameOf(admin,second,'password')}`, '--reason', 'DEMO_IMPORT']);
    assert.equal(result.code, 1); assert.ok(!result.text.includes(`已设置资源 ${first}`));
    assert.equal(await withKit(admin, (kit) => storedNamed(kit,first,'username')), null);
    assert.equal(await withKit(admin, (kit) => storedNamed(kit,second,'password')), null);
  });

  test('missing and commented keys write nothing, malformed files disclose no values or paths', async () => {
    const admin = await setup(); const id = await importResource(admin);
    const value = 'SyntheticMalformedValue58'; secrets.add(value); secrets.add(value.slice(0, 12));
    for (const bytes of [`PORTAL_USER=${value}\n# PORTAL_PASSWORD=${value}\n`, `PORTAL_USER=${value}\nPORTAL_USER=${value}\n`, `PORTAL_USER=${value}\0\n`, Buffer.from([0xff, 0xfe]), `PORTAL_USER=${value}\n${'x'.repeat(65536)}`]) {
      const file = await importFile(admin, bytes); const result = await admin.run(await importArgs(admin,file,id));
      assert.equal(result.code, 1); assert.ok(!result.text.includes(file)); assert.ok(!result.text.includes(value.slice(0, 12)));
      assert.deepEqual(await withKit(admin, (kit) => kit.vault.list()), []);
    }
    const emptyFile = await importFile(admin, `PORTAL_USER=\nPORTAL_PASSWORD=${value}`);
    const empty = await admin.run(await importArgs(admin,emptyFile,id));
    assert.equal(empty.code, 1); assert.match(empty.text, /PORTAL_USER：是空的/);
    assert.deepEqual(await withKit(admin, (kit) => kit.vault.list()), []);
    const linked = join(admin.deployment.dataDir, 'linked.env');
    await symlink(join(admin.deployment.dataDir, 'synthetic.env'), linked);
    for (const path of [admin.deployment.dataDir, linked]) {
      const refused = await admin.run(await importArgs(admin,path,id));
      assert.equal(refused.code, 1); assert.ok(!refused.text.includes(path));
    }
    const file = await importFile(admin, `PORTAL_USER=has:colon\nPORTAL_PASSWORD=${value}`); secrets.add('has:colon');
    assert.equal((await admin.run(['secret', 'import', '--env-file', file, '--basic', `PORTAL_USER:PORTAL_PASSWORD=${await nameOf(admin,id,'username')}`, '--reason', 'DEMO_IMPORT'])).code, 1);
    assert.deepEqual(await withKit(admin, (kit) => kit.vault.list()), []);
  });

  test('authorization, vault and every target are checked before opening the environment file', async () => {
    const admin = await setup(); const id = await importResource(admin); const missingFile = join(admin.deployment.dataDir, 'must-not-open');
    for (const mapping of [`PORTAL_USER=DEMO_UNREFERENCED`, `PORTAL_USER=DEMO_UNREFERENCED`]) {
      const refused = await admin.run(['secret', 'import', '--env-file', missingFile, '--key', mapping, '--reason', 'DEMO_IMPORT']);
      assert.equal(refused.code, 1); assert.doesNotMatch(refused.text, /环境文件/);
    }
    const duplicate = await admin.run([...await importArgs(admin,missingFile,id), '--key', `OTHER=${await nameOf(admin,id,'username')}`]);
    assert.notEqual(duplicate.code, 0); assert.doesNotMatch(duplicate.text, /环境文件/);
    const user = await userWithToken(admin, '导入普通用户');
    assert.match((await admin.run(await importArgs(admin,missingFile,id), { [OPERATOR_TOKEN_VARIABLE]: user })).text, /管理员/);
    admin.tokens!.value = null;
    assert.match((await admin.run(await importArgs(admin,missingFile,id))).text, /没有找到/);
    const noKey = await setup({ deployment: { key: false } }); const noKeyId = await importResource(noKey);
    assert.match((await noKey.run(await importArgs(noKey,missingFile,noKeyId))).text, /主密钥不可用/);
    const dry = await noKey.run([...await importArgs(noKey,missingFile,noKeyId), '--dry-run']);
    assert.match(dry.text, /环境文件/); assert.doesNotMatch(dry.text, /主密钥不可用/);
  });
});


describe('reimport after key loss', () => {
  for (const keychain of [false, 'synthetic', true] as const) test(keychain === 'synthetic' ? 'synthetic keychain loss recovers through platform reset and secret import without host tools' : keychain ? 'temporary keychain loss requires reissue and a fresh vault before reimport' : 'file key loss requires a fresh vault before reimport', { skip: keychain === true && !temporaryKeychainAvailable ? 'skipped: /usr/bin/security is unavailable (requires macOS)' : false }, async () => {
    const directory = await mkdtemp(join(harness.scratch, 'key-loss-'));
    const file = join(directory, 'synthetic.keychain-db');
    const service = `circle-hub-synthetic-${randomBytes(12).toString('hex')}`;
    const simulated = keychain === 'synthetic' ? syntheticKeychain(file) : null;
    let resetWithPlatform: (() => Promise<void>) | undefined;
    let stopPlatform: (() => Promise<void>) | undefined;
    const runner: CommandRunner = async (command, args, options) => {
      assert.equal(command, '/usr/bin/security');
      assert.ok(args.at(-1) === file || (args[0] === '-i' && (options?.input ?? '').trimEnd().endsWith(`"${file}"`)), 'no default keychain');
      return simulated ? simulated.runner(command, args, options) : runCommand(command, args, options);
    };
    const master = keychainStore({ service, keychain: file, runner, item: VAULT_KEY_ITEM, account: 'vault-master-key' });
    const operator = keychainStore({ service, keychain: file, runner, item: OPERATOR_TOKEN_ITEM, account: 'operator-token' });
    try {
      if (keychain) {
        const password = randomBytes(20).toString('hex'); secrets.add(password);
        for (const args of [['create-keychain', '-p', password, file], ['unlock-keychain', '-p', password, file], ['set-keychain-settings', file]]) assert.equal((await runner('/usr/bin/security', args)).code, 0);
        await master.init();
      }
      const provider = () => keychainKeyProvider({ service, keychain: file, runner });
      const admin = await setup(keychain ? { deployment: { key: false, ...(simulated ? { migrate: false } : {}) }, ...(simulated ? { initAdmin: false } : {}), keyProvider: provider, store: () => keychainOperatorTokens({ service, keychain: file, runner }) } : {});
      if (simulated) {
        const port = await freePort(), databasePort = socketPort();
        const env = { CIRCLE_HUB_DATA_DIR: admin.deployment.dataDir, CIRCLE_HUB_PORT: String(port), CIRCLE_HUB_DATABASE_PORT: String(databasePort), CIRCLE_HUB_KEYCHAIN_SERVICE: service };
        const host = recordingRunner(call => {
          if (call.command === '/usr/bin/security') return simulated.runner(call.command, call.args, call.options);
          if (call.command === '/bin/launchctl') {
            assert.equal(call.args[0], 'print');
            return { code: 113, stdout: '', stderr: 'synthetic service stopped' };
          }
          return undefined;
        });
        const overrides = { platform: 'darwin' as const, runner: host.runner, home: directory, launchAgentsDir: join(directory, 'agents'), keychain: file };
        const context = createContext(env, overrides);
        stopPlatform = async () => { await postgresFor(context).stop(); };
        const platformRun = async (argv: string[]) => {
          const captured = captureIo(env, directory);
          assert.equal(await runPlatformCommand(argv, captured.io, overrides), 0, captured.err.join('\n'));
          admin.deployment.printed.push(...captured.out, ...captured.err);
          return captured;
        };
        await platformRun(['init', '--environment', 'test', '--port', String(port)]);
        Object.assign(admin.deployment.env, env, {
          CIRCLE_HUB_DATABASE_SOCKET_DIR: join(admin.deployment.dataDir, 'run'),
          CIRCLE_HUB_DATABASE_NAME: context.database.name,
          CIRCLE_HUB_DATABASE_USER: context.database.role,
        });
        const migrated = await admin.deployment.run(['serve', '--migrate-only'], { keyProvider: provider, ownerRole: context.user });
        assert.equal(migrated.code, 0, migrated.text);
        await expectOk(admin, ['init-admin', '根管理员']);
        resetWithPlatform = async () => {
          await platformRun(['service', 'stop']);
          const captured = await platformRun(['key', 'init', '--set-aside-vault']);
          assert.ok(captured.out.some(line => line.includes('原文件保留')));
          assert.ok((await readdir(join(admin.deployment.dataDir, 'set-aside'))).some(name => name.endsWith('-key-loss')));
          assert.deepEqual(await readdir(join(admin.deployment.dataDir, 'vault')), []);
          assert.equal((await master.status()).present, true);
        };
      }
      const id = await importResource(admin);
      const env = await importFile(admin, `PORTAL_USER=reader\nPORTAL_PASSWORD=${PASSWORD}\nUNUSED=SyntheticUnusedValue79`);
      secrets.add('reader'); secrets.add('SyntheticUnusedValue79');
      await expectOk(admin, await importArgs(admin,env,id));
      const loginsBefore = agile.logins;
      const read = async () => withKit(admin, async (kit) => {
        const hub = await assembleHub(loadServerConfig(admin.deployment.env), kit, { requireOsIsolation, log: (line) => admin.deployment.printed.push(line) });
        const by = (await kit.principals.findByName('根管理员'))!;
        assert.equal((await hub.connectors.executeRead(id, 'mindmap', { id: DOCUMENT }, { principal: by, purpose: '合成钥匙恢复核对' })).ok, true);
      });
      await read(); assert.equal(agile.logins, loginsBefore + 1);
      if (keychain) {
        const bytes = await master.read(); secrets.add(Buffer.from(bytes).toString('hex')); bytes.fill(0);
        const operatorBytes = await operator.read();
        secrets.add(Buffer.from(operatorBytes).toString('hex')); secrets.add(Buffer.from(operatorBytes).toString('base64url')); operatorBytes.fill(0);
        await master.delete(); await operator.delete();
        const refused = await admin.run(await importArgs(admin,join(directory,'not-readable'),id));
        assert.equal(refused.code, 1); assert.match(refused.text, /operator-token reissue/);
        if (simulated) await resetWithPlatform!();
        await expectOk(admin, ['operator-token', 'reissue']);
        const store = keychainOperatorTokens({ service, keychain: file, runner }); secrets.add((await store.read())!);
      } else await rm(admin.deployment.key.path);
      if (!simulated) {
        const refused = await admin.run(await importArgs(admin,join(directory,'not-readable'),id));
        assert.equal(refused.code, 1); assert.match(refused.text, /主密钥不可用/); assert.match(refused.text, /set-aside/); assert.doesNotMatch(refused.text, /环境文件/);
        for(const step of ['operator-token reissue','secret import','最后起服务']) assert.ok(refused.text.includes(step),step);
        assert.ok(refused.text.indexOf('operator-token reissue') < refused.text.indexOf('secret import'), refused.text);
        assert.ok(refused.text.indexOf('secret import') < refused.text.indexOf('最后起服务'), refused.text);
        assert.equal((await admin.run(['resource', 'list'])).code, 0);
        const aside = join(admin.deployment.dataDir, 'set-aside');
        await mkdir(aside, { mode: 0o700 });
        await rename(join(admin.deployment.dataDir, 'vault'), join(aside, 'synthetic-key-loss'));
        if (keychain) await master.init(); else await admin.deployment.key.initKey();
      }
      await expectOk(admin, await importArgs(admin,env,id));
      assert.equal(await withKit(admin, (kit) => storedNamed(kit,id,'password')), passwordDigest(PASSWORD));
      await read(); assert.equal(agile.logins, loginsBefore + 2);
      if (simulated) {
        let listening: ListenInfo | undefined;
        let stop = () => {};
        const stopped = new Promise<void>(resolve => { stop = resolve; });
        const serving = admin.deployment.run(['serve'], {
          keyProvider: provider,
          operatorTokens: () => keychainOperatorTokens({ service, keychain: file, runner }),
          assembly: async () => ({ assemble: createAssembly({ requireOsIsolation }) }),
          stopSignal: () => stopped,
          onListening: info => { listening = info; },
        });
        try {
          for (let i = 0; i < 400 && !listening; i++) await new Promise(resolve => setTimeout(resolve, 25));
          assert.ok(listening, 'recovered Hub actually listens');
          assert.equal(listening.host, '127.0.0.1');
          const response = await fetch(listening.url + '/healthz');
          assert.equal(response.status, 200);
          assert.equal((await response.json() as { status: string }).status, 'ok');
        } finally {
          stop();
          const result = await serving;
          assert.equal(result.code, 0, result.text);
        }
      }
    } finally {
      await stopPlatform?.();
      if (keychain) await runner('/usr/bin/security', ['delete-keychain', file]);
      await rm(file, { force: true });
    }
  });
});

describe('resource read', () => {
  test('a read prints only declared names, outcome codes and artifact sizes and digests', async () => {
    const admin = await setup(); const id = await importResource(admin);
    const file = await importFile(admin, `PORTAL_USER=reader\nPORTAL_PASSWORD=${PASSWORD}`);
    await expectOk(admin, await importArgs(admin,file,id));
    const result = await expectOk(admin, ['resource', 'read', id, 'mindmap', DOCUMENT]);
    assert.match(result.text, /demo-agile@1\.0\.0\/mindmap：读取完成/);
    assert.match(result.text, /产物 original [0-9a-f]{64} [0-9]+ 字节/); assert.match(result.text, /读清单 [0-9a-f]{64}/);
    assert.ok(!result.text.includes(DOCUMENT));
    // All response strings of at least eight characters must stay out of command output.
    const kit = await admin.kit();
    try {
      const originals = await kit.store.list<SourceArtifactBody>({ kind: 'source_artifact', limit: 100 });
      for (const original of originals.items) {
        const bytes = await kit.artifacts.trustedBytes(original.body.sha256); if (!bytes) continue;
        let value: unknown; try { value = JSON.parse(Buffer.from(bytes).toString()); } catch { continue; }
        const walk = (v: unknown): void => { if (typeof v === 'string' && v.length >= 8 && !/^[0-9a-f]{64}$/.test(v)) assert.ok(!result.text.includes(v)); else if (v && typeof v === 'object') for (const child of Object.values(v)) walk(child); }; walk(value);
      }
    } finally { await kit.close(); }
    const badRead = await admin.run(['resource', 'read', id, 'undeclared', DOCUMENT]); assert.equal(badRead.code, 1); assert.ok(!badRead.text.includes(DOCUMENT));
    const absent = await admin.run(['resource', 'read', 'res_00000000000000000000000000', 'mindmap', DOCUMENT]); assert.equal(absent.code, 1);
    const user = await userWithToken(admin, '冒烟普通用户'); assert.equal((await admin.run(['resource', 'read', id, 'mindmap', DOCUMENT], { [OPERATOR_TOKEN_VARIABLE]: user })).code, 1);
    const missing = await admin.run(['resource', 'read', id, 'mindmap', 'synthetic-missing-document']);
    // A permitted digest can contain 404: verify the complete declared output instead of scanning digest digits as body text.
    assert.equal(missing.code, 1); assert.match(missing.text, /^demo-agile@1\.0\.0\/mindmap：失败（[A-Z_]+）\n读清单 [0-9a-f]{64}$/);
    admin.stdin.push(WRONG_PASSWORD); await expectOk(admin, await setArgs(admin,id,'password'));
    const login = await admin.run(['resource', 'read', id, 'mindmap', DOCUMENT]);
    assert.equal(login.code, 1); assert.match(login.text, /失败（[A-Z_]+）/); assert.ok(!login.text.includes(DOCUMENT));
  });
});


test('review 1: resource read exposes connector diagnostics only with the explicit events flag', async () => {
  const admin = await setup(); const id = await importResource(admin);
  const file = await importFile(admin, `PORTAL_USER=reader\nPORTAL_PASSWORD=${PASSWORD}`);
  await expectOk(admin, await importArgs(admin,file,id));
  const quiet = await expectOk(admin, ['resource', 'read', id, 'mindmap', DOCUMENT]);
  assert.ok(!quiet.err.some(line => line.includes('read_ok')));
  const events = await expectOk(admin, ['resource', 'read', id, 'mindmap', DOCUMENT, '--events']);
  assert.ok(events.err.some(line => line.includes('read_ok')));
  const failure = await admin.run(['resource', 'read', id, 'mindmap', 'synthetic-missing', '--events']);
  assert.equal(failure.code, 1); assert.ok(failure.err.some(line => line.includes('read_failed')));
});


test('review 5: dry-run and real import validate every value before the first write', async () => {
  const admin = await setup(); const first = await importResource(admin); const second = await addImportResource(admin,'production');
  for (const value of ['SensitiveCtlPrivate95\tValue', 'X'.repeat(4097)]) {
    secrets.add(value); secrets.add(value.slice(0, 12));
    const file = await importFile(admin, `PORTAL_USER=reader\nBAD=${value}`);
    const args = ['secret', 'import', '--env-file', file, '--key', `PORTAL_USER=${await nameOf(admin,first,'username')}`, '--key', `BAD=${await nameOf(admin,second,'password')}`, '--reason', 'DEMO_IMPORT'];
    for (const suffix of [['--dry-run'], []]) {
      const result = await admin.run([...args, ...suffix]); assert.equal(result.code, 1); assert.match(result.text, /BAD/);
      assert.deepEqual(await withKit(admin, kit => kit.vault.list()), []);
    }
    await withKit(admin, async kit => {
      const hub = await assembleHub(loadServerConfig(admin.deployment.env), kit, { requireOsIsolation, log: line => admin.deployment.printed.push(line) });
      const by = (await kit.principals.findByName('根管理员'))!;
      await assert.rejects(setSyntheticCredentials(kit, hub.connectors, by, second, { password: value }));
    });
  }
  const valid = 'V'.repeat(4096); secrets.add(valid);
  const file = await importFile(admin, `PORTAL_USER=${valid}`);
  const args = ['secret', 'import', '--env-file', file, '--key', `PORTAL_USER=${await nameOf(admin,first,'username')}`, '--reason', 'DEMO_IMPORT'];
  await expectOk(admin, [...args, '--dry-run']); await expectOk(admin, args);
  assert.equal((await withKit(admin, kit => storedNamed(kit,first,'username')))?.length, 4096);
});


test('review 6: missing and empty keys refuse explicitly with corrective hints and no writes', async () => {
  const admin = await setup(); const id = await importResource(admin);
  for (const body of [`PORTAL_USER=reader`, `PORTAL_USER=\nPORTAL_PASSWORD=${PASSWORD}`]) {
    const file = await importFile(admin, body); const result = await admin.run(await importArgs(admin,file,id));
    assert.equal(result.code, 1); assert.match(result.text, /未写入任何密钥/); assert.match(result.text, /--dry-run/);
    assert.deepEqual(await withKit(admin, kit => kit.vault.list()), []);
    if (body.includes('PORTAL_USER=\n')) assert.match(result.text, /PORTAL_USER：是空的/);
  }
  const missing = join(admin.deployment.dataDir, 'not-opened.env');
  const resource = await admin.run(['secret', 'import', '--env-file', missing, '--key', 'USER=DEMO_UNREFERENCED', '--reason', 'DEMO_IMPORT']);
  assert.match(resource.text,/还没有部署定义引用/);
  const credential = await admin.run(['secret', 'import', '--env-file', missing, '--key', `USER=DEMO_UNREFERENCED`, '--reason', 'DEMO_IMPORT']);
  assert.match(credential.text,/还没有部署定义引用/); assert.doesNotMatch(credential.text, /环境文件/);
});


test('review 8: Basic targets refuse before file access and a static authorization header reaches the stub', async () => {
  const admin = await setup(); const agileId = await importResource(admin);
  for (const entry of ['password', 'username']) {
    const refused = await admin.run(['secret', 'import', '--env-file', 'must-not-open', '--basic', `USER:PASS=${await nameOf(admin,agileId,entry)}`, '--reason', 'DEMO_IMPORT']);
    assert.equal(refused.code, 1); assert.match(refused.text, /Basic.*原样.*Authorization/);
    assert.ok(refused.text.includes(agileId));assert.ok(refused.text.includes(AGILE_PACK));assert.ok(refused.text.includes(entry));assert.match(refused.text,/--key/);
    assert.doesNotMatch(refused.text, /环境文件/);
  }
  const username = 'SyntheticBasicUser'; const password = 'SyntheticBasicPassword92';
  const header = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  for (const value of [username, password, header, header.slice(6)]) secrets.add(value);
  const stub = await startStub((request) => {
    assert.equal(request.headers.authorization, header);
    return { headers: { 'content-type': 'text/plain' }, body: 'synthetic read response' };
  });
  try {
    const profile = {
      schema: 'system@1', title: '合成头值认证', roles: [{ name: 'repository' }],
      auth: { kind: 'static_header', header: { name: 'Authorization', scheme: 'raw' }, roles: ['repository'], credential: 'authorization' },
      routes: [{ id: 'document', role: 'repository', method: 'GET', path: '/{id}',
        params: { id: { type: 'string', maxLength: 40, pattern: '^[a-z0-9-]+$' } }, response: 'text', max_bytes: 4096, read: true }],
      reads: [{ name: 'document', external: 'synthetic-repo:document', request: { route: 'document', params: { id: '{id}' } } }],
    };
    const pack = await writePack(join(packRoot, 'synthetic-basic'), { id: 'demo-basic', version: '1.0.0', kind: 'system',
      title: '合成头值认证', description: '合成只读认证核对', files: { 'system.json': profile } });
    await expectOk(admin, ['pack', 'publish', pack.dir]);
    const added = await expectOk(admin, ['resource', 'add', 'demo-basic', '--name', '合成认证', '--environment', 'test',
      '--origin', `repository=${stub.origin}`, '--allow-plaintext', 'repository', ...syntheticCredentialArgs('authorization')]);
    const id = /已添加资源 (res_[0-9a-z]{26})/.exec(added.text)![1];
    const args = async (file: string) => ['secret', 'import', '--env-file', file, '--basic', `USER:PASS=${await nameOf(admin,id,'authorization')}`, '--reason', 'DEMO_IMPORT'];
    const colonFile = await importFile(admin, `USER=has:colon\nPASS=${password}`); secrets.add('has:colon');
    const colon = await admin.run(await args(colonFile)); assert.equal(colon.code, 1); assert.match(colon.text, /用户名含冒号/);
    assert.deepEqual(await withKit(admin, kit => kit.vault.list()), []);
    const file = await importFile(admin, `USER=${username}\nPASS=${password}`);
    await expectOk(admin, [...await args(file), '--dry-run']);
    assert.deepEqual(await withKit(admin, kit => kit.vault.list()), []);
    await expectOk(admin, await args(file));
    assert.equal(await withKit(admin, kit => storedNamed(kit,id,'authorization')), header);
    await expectOk(admin, ['resource', 'read', id, 'document', 'synthetic-file', '--events']);
    assert.equal(stub.requests.length, 1);
  } finally { await stub.close(); }
});

test('c3 Secrets documentation follows the supported irreversible key loss procedure',async()=>{
 const text=await readFile(new URL('./README.md',import.meta.url),'utf8');
 const procedure=text.slice(text.indexOf('- **Irrecoverable key loss**'),text.indexOf('- **Login state.**'));
 const steps=['stop the service','circle-hub key init --set-aside-vault','circle-hub operator-token reissue','secret import','start the service'];
 let previous=-1;for(const step of steps){const at=procedure.indexOf(step,previous+1);assert.ok(at>previous,step);previous=at;}
 assert.match(procedure,/loaded service/);assert.match(procedure,/configured port/);assert.match(procedure,/present key/);assert.match(procedure,/Plain `key init` refuses a nonempty vault/);
 assert.ok(!text.includes('the advice is always to restore'));
});

test('pack publish forwards repeated explicit answer-request flags without touching the real keychain',async()=>{
  const admin=await setup();
  await expectOk(admin,['pack','grant-publish','根管理员']);
  await expectOk(admin,['pack','publish',packs.review]);
  const requestIds=await withKit(admin,async kit=>{
    const {createRequestService}=await import('../../requests/api.ts');
    const owner=(await kit.principals.findByName('根管理员'))!;
    const version=(await kit.store.list<{digest:string}>({kind:'pack_version',limit:10})).items[0];
    const requests=createRequestService(kit);
    return Promise.all(['合成缺口甲','合成缺口乙'].map(missing=>requests.write({pack_digest:version.body.digest,kind:'repair',audience:owner.id,due:'2026-10-26T00:00:00.000Z',missing,next_action:'发布修复版本',source:version.digest,code:'check_error'}))).then(records=>records.map(r=>r.digest));
  });
  const dir=(await writePack(join(packRoot,'explicit-answer'),reviewPack('1.0.1'))).dir;
  const answer=await expectOk(admin,['pack','publish',dir,'--answer-request',requestIds[0],'--answer-request',requestIds[1]]);
  assert.match(answer.text,/请求作答.*2 个指定请求/);
  await withKit(admin,async kit=>{const {createRequestService}=await import('../../requests/api.ts');for(const id of requestIds)assert.ok((await createRequestService(kit).inspect(id))?.answered_by);});
});

test('lease release refuses an unfinished dispatch job before changing the row',async t=>{
  const admin=await setup();const kit=await admin.kit();t.after(()=>kit.close());
  const user=(await kit.principals.findByName('根管理员'))!;
  const db=new Database(createPool(loadServerConfig(admin.deployment.env).database,2));t.after(()=>db.end());
  const leases=new LeaseService(db,{records:kit.store});const key='synthetic/pending-release/k';
  const {newId,sha256Hex}=await import('../../records/api.ts');
  assert.ok((await leases.acquire({keys:[key],prefix:'synthetic/',holder:{user:user.id,run:newId('run')}})).ok);
  const time=new Date().toISOString();const job='synthetic-pending-release';
  await kit.store.put({kind:'action',schema:'action@1',provenance:'observed',created_at:time,
    body:{action:'validate',run:null,item:null,inputs:[],component:'dispatch@1',lease:null,started_at:time,ended_at:time,result:'completed',error_code:null,acceptance:null,codes:[],detail:{job,phase:'reservation',binding:{job,initiated_by:user.id,user:user.id,executor:'synthetic',executor_digest:'a'.repeat(64),target_key:'synthetic',input:null,resources:[key]}}},
    index:[{key:'dispatch.resource',value:sha256Hex(key)},{key:'dispatch.job',value:job}]});
  const refused=await admin.run(['lease','release',key,'--reason','合成处置']);
  assert.equal(refused.code,1,refused.text);
  assert.match(refused.text,/还没有终态/);assert.match(refused.text,/job dispose/);
  assert.equal((await leases.holders([key]))[0]!.released,false);
});

test('lease ownership commands audit reassignment and list owner, holder and run without internal identities',async t=>{
  const admin=await setup();
  const {stage}=await import('../../../packs/workflow/test-bed/pack-files.ts');
  const directory=await mkdtemp(join(tmpdir(),'ownership-cli-pack-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  await stage(directory);
  await expectOk(admin,['pack','grant-publish','根管理员']);await expectOk(admin,['pack','publish',directory]);
  await expectOk(admin,['user','create','合成主人']);await expectOk(admin,['user','create','合成后继主人']);
  const kit=await admin.kit();t.after(()=>kit.close());
  const owner=(await kit.principals.findByName('合成主人'))!;
  const next=(await kit.principals.findByName('合成后继主人'))!;
  await expectOk(admin,['lease','register','bed/sample/','--owner',owner.name,'--reason','合成登记']);
  const db=new Database(createPool(loadServerConfig(admin.deployment.env).database,2));t.after(()=>db.end());
  const leases=new LeaseService(db,{records:kit.store});const key='bed/sample/client';
  const {newId}=await import('../../records/api.ts');const run=newId('run');
  assert.ok((await leases.acquire({keys:[key],prefix:'bed/',holder:{user:next.id,run}})).ok);
  const listed=await expectOk(admin,['lease','list']);
  assert.ok(listed.text.includes(owner.name)&&listed.text.includes(next.name)&&listed.text.includes(run),listed.text);
  assert.ok(!listed.text.includes('lse_')&&!listed.text.includes('fencing'));
  await expectOk(admin,['lease','register','bed/sample/','--owner',next.id,'--reason','合成归属更正']);
  assert.equal((await leases.registrations('bed/'))[0]!.owner,next.id);
  const busy=await admin.run(['lease','unregister','bed/sample/','--reason','合成注销']);
  assert.equal(busy.code,1);assert.match(busy.text,/先强制释放，或等它释放/);
  await expectOk(admin,['lease','release',key,'--reason','合成主人要求收回']);
  await expectOk(admin,['lease','unregister','bed/sample/','--reason','合成注销']);
  assert.deepEqual(await leases.registrations('bed/'),[]);
  const actions=await leases.actionLog('bed/');
  assert.ok(actions.some(row=>row.op==='register'&&row.owner===next.id&&row.previous_owner===owner.id&&row.reason==='合成归属更正'));
  assert.ok(actions.some(row=>row.op==='unregister'&&row.owner===next.id));
  assert.equal((await admin.run(['lease','register','bed/sample/','--owner',next.id])).code,2);
});

test('administrator sharing commands cover users package audiences policy listing and withdrawals', async t => {
  const admin = await setup();
  await expectOk(admin,['pack','grant-publish','根管理员']); await expectOk(admin,['pack','publish',packs.review]);
  const token = await userWithToken(admin,'合成分享读者');
  await expectOk(admin,['pack','assign','合成分享读者',REVIEW_PACK]);
  const kit = await admin.kit(); t.after(()=>kit.close());
  const {RunRecord} = await import('../../../contracts/src/run.ts');
  const {newId,productionShareKey} = await import('../../records/api.ts');
  const owner = (await kit.principals.findByName('根管理员'))!;
  const reader = (await kit.principals.findByName('合成分享读者'))!;
  const run = newId('run');
  const body = RunRecord.parse({run,pack:REVIEW_PACK+'@1.0.0',pack_digest:'a'.repeat(64),target_basis:[],sources:[],requirements:[],items:[],instructions:'合成说明',instructions_digest:'b'.repeat(64),started_at:'2026-10-24T00:00:00Z',runner:owner.id,host:'local_circle',trigger:'session',parameters:{},session:'synthetic-session',client_key:'synthetic-key',request_digest:'c'.repeat(64),client_key_expires_at:'2026-10-25T00:00:00Z'});
  await kit.store.put({kind:'run',schema:'run@1',provenance:'observed',body,index:[{key:'runs.id',value:run}]});
  await expectOk(admin,['share','run',run,'--users',reader.name,'--reason','合成只读分享']);
  assert.equal(await kit.authorizations.isSharedWith(reader.id,run),true);
  assert.match((await expectOk(admin,['share','list','--object',run])).text,new RegExp(run));
  await expectOk(admin,['unshare','run',run,'--user',reader.name]);
  assert.equal(await kit.authorizations.isSharedWith(reader.id,run),false);
  await expectOk(admin,['share','run',run,'--pack-users']);
  assert.equal(await kit.authorizations.isSharedWith(reader.id,run),true);
  await expectOk(admin,['unshare','run',run,'--pack-users']);
  assert.equal(await kit.authorizations.isSharedWith(reader.id,run),false);
  await expectOk(admin,['share','production',REVIEW_PACK]);
  assert.equal(await kit.authorizations.isSharedWith(reader.id,productionShareKey(REVIEW_PACK)),true);
  await expectOk(admin,['unshare','production',REVIEW_PACK]);
  assert.equal(await kit.authorizations.isSharedWith(reader.id,productionShareKey(REVIEW_PACK)),false);
  for(const args of [['share','list'],['share','run',run,'--pack-users'],['unshare','run',run,'--pack-users'],['share','production',REVIEW_PACK],['unshare','production',REVIEW_PACK]]) assert.equal((await admin.run(args,{[OPERATOR_TOKEN_VARIABLE]:token})).code,1);
  const missing = await admin.run(['share','run','run_'+'1'.repeat(26),'--pack-users']); assert.equal(missing.code,1); assert.match(missing.text,/对你不可用/);
});

test('pack shapes lists only unruled identities and refuses nonadministrators',async()=>{
 const admin=await setup();
 assert.deepEqual((await expectOk(admin,['pack','shapes','synthetic'])).out,['没有未裁定的形状']);
 const kit=await admin.kit();
 try {
  const fixtures=await import('../../../contracts/src/fixtures.ts');
  await kit.store.put({kind:'validation_result',schema:'validation@1',provenance:'projected',body:{...fixtures.accepted,locks:{pack:'synthetic@10.6.0',pack_digest:fixtures.H},cross_item:[{...fixtures.judgment,qualifier:{...fixtures.judgment.qualifier,marks:['decision_shape_unruled']},statement:{text:'合成形状',data:{requirement:'r',interpreter:'future@1'}}}]}});
 } finally {await kit.close();}
 const listed=await expectOk(admin,['pack','shapes','synthetic']);
 assert.match(listed.text,/r\tfuture@1\t1\trun_/);
 assert.doesNotMatch(listed.text,/合成形状/);
 const token=await userWithToken(admin,'普通读者');
 const denied=await admin.run(['pack','shapes','synthetic'],{[OPERATOR_TOKEN_VARIABLE]:token});
 assert.equal(denied.code,1);assert.match(denied.text,/管理员/);
});

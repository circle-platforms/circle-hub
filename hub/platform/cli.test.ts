import assert from 'node:assert/strict';
import { access, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { ENVIRONMENT, labelOf } from '../../contracts/generated/vocabulary.ts';
import { isPlatformCommand, PLATFORM_COMMANDS, runPlatformCommand } from './cli.ts';
import { createContext, postgresFor, type PlatformContext } from './context.ts';
import { isMissingOrEmpty } from './files.ts';
import { ensureLayout, layoutAt } from './layout.ts';
import { RELEASE_SCHEMA } from './release.ts';
import { newSettingsFile, OPERATOR_TOKEN_ACCOUNT, settingsPath } from './settings.ts';
import { withSession } from './sql.ts';
import { captureIo, exit, freePort, libpqAvailable, LIBPQ_MISSING, ok, ownerTables, recordingRunner, removeDir, socketPort, tempDir, type Call } from './test-support.ts';

const KEY = /[0-9a-f]{64}/;
const WORKTREE = fileURLToPath(new URL('../../', import.meta.url));
const libpq = await libpqAvailable();
/** The operating-system account, whose role owns the Hub database. */
const OWNER = userInfo().username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Fake security (an in-memory item) and fake launchctl; every other command runs for real behind the guard. */
function fakeSystem() {
  const state: { key?: string; loaded: boolean } = { loaded: false };
  const recorder = recordingRunner((call: Call) => {
    if (call.command === '/usr/bin/security') {
      if (call.args[0] === '-i') {
        state.key = /-w ([0-9a-f]{64})/.exec(call.options.input ?? '')?.[1];
        return ok();
      }
      if (call.args[0] === 'find-generic-password') {
        if (!state.key) return exit(44, 'The specified item could not be found in the keychain.');
        return ok(call.args.includes('-w') ? `${state.key}\n` : 'keychain: "synthetic"\nattributes: ...\n');
      }
      return exit(1, 'unexpected security call');
    }
    if (call.command === '/bin/launchctl') {
      if (call.args[0] === 'print') return state.loaded ? ok('\tstate = running\n\tpid = 777\n') : exit(113, 'Could not find service');
      if (call.args[0] === 'bootstrap') state.loaded = true;
      if (call.args[0] === 'bootout') state.loaded = false;
      return ok();
    }
    return undefined;
  });
  return { state, ...recorder };
}

describe('platform CLI', () => {
  let parent: string;
  let root: string;
  let env: NodeJS.ProcessEnv;
  let overrides: Partial<PlatformContext>;
  let system: ReturnType<typeof fakeSystem>;
  let port: string;
  let databasePort: string;

  const runWith = async (extra: NodeJS.ProcessEnv, ...argv: string[]) => {
    const captured = captureIo({ ...env, ...extra }, parent);
    const code = await runPlatformCommand(argv, captured.io, overrides);
    const text = [...captured.out, ...captured.err].join('\n');
    assert.doesNotMatch(text, KEY, 'no key-shaped text is ever printed');
    return { code, out: captured.out.join('\n'), err: captured.err.join('\n'), lines: captured.out };
  };
  const run = (...argv: string[]) => runWith({}, ...argv);

  before(async () => {
    parent = await tempDir();
    root = join(parent, 'root');
    databasePort = String(socketPort());
    env = { CIRCLE_HUB_DATA_DIR: root, CIRCLE_HUB_DATABASE_PORT: databasePort };
    system = fakeSystem();
    port = String(await freePort());
    await mkdir(join(parent, 'home'), { recursive: true });
    overrides = {
      home: join(parent, 'home'),
      runner: system.runner,
      launchAgentsDir: join(parent, 'home', 'Library', 'LaunchAgents'),
      uid: 501,
      nodePath: process.execPath,
      ...(libpq ? { libpqBin: libpq } : {}),
    };
  });

  after(async () => {
    await run('db', 'stop').catch(() => {});
    await removeDir(parent);
  });

  test('usage, help and unknown commands', async () => {
    const none = await run();
    assert.equal(none.code, 2);
    assert.match(none.out, /用法：circle-hub <命令>/);
    assert.match(none.out, /可用 CIRCLE_HUB_DATA_DIR 改/);
    assert.equal((await run('help')).code, 0);
    const unknown = await run('frobnicate');
    assert.equal(unknown.code, 2);
    assert.match(unknown.err, /未知命令：frobnicate/);
    assert.match((await run('serve')).err, /serve 由服务器包提供/);
    assert.ok(isPlatformCommand('deploy') && !isPlatformCommand('serve') && !isPlatformCommand('toString'));
    assert.deepEqual([...PLATFORM_COMMANDS].sort(), ['backup', 'db', 'deploy', 'init', 'key', 'rehearse', 'restore', 'rollback', 'service', 'status']);
    assert.equal((await run('db', 'explode')).code, 2);
    assert.equal((await run('service', 'explode')).code, 2, 'usage is checked before the settings are read');
    assert.equal((await run('key', 'explode')).code, 2);
    assert.equal((await run('deploy', '--copy', '--commit', 'HEAD')).code, 2);
    assert.equal((await run('backup', '--keep', 'many')).code, 2);
    assert.equal((await run('restore')).code, 2);
  });

  test('a retired CIRCLE_SERVER_* variable stops every command before it runs anything', async () => {
    const before = system.calls.length;
    const captured = captureIo({ ...env, CIRCLE_SERVER_PORT: '7420' }, parent);
    assert.equal(await runPlatformCommand(['status'], captured.io, overrides), 1);
    assert.match(captured.err.join('\n'), /不再读取 CIRCLE_SERVER_\*/);
    assert.equal(system.calls.length, before);
  });

  test('a misspelled or unknown CIRCLE_HUB_* name stops every command before it runs anything', async () => {
    const before = system.calls.length;
    for (const name of ['CIRCLE_HUB_DATADIR', 'CIRCLE_HUB_HOME']) {
      const result = await runWith({ [name]: join(parent, 'elsewhere') }, 'status');
      assert.equal(result.code, 1, name);
      assert.match(result.err, new RegExp(`${name} 不是 circle-hub 的配置项（可能拼错了），不执行`));
      assert.match(result.err, /处理：.*CIRCLE_HUB_DATA_DIR/);
      assert.doesNotMatch(result.out, /数据根：/, 'nothing ran, not even on the default root');
    }
    assert.equal(system.calls.length, before);
    const captured = captureIo({ ...env, CIRCLE_HUB_ADMIN_TOKEN_FILE: '/x' }, parent);
    assert.equal(await runPlatformCommand(['help'], { ...captured.io, allowVariables: ['CIRCLE_HUB_ADMIN_TOKEN_FILE'] }, overrides), 0);
  });

  test('init needs an environment class from the vocabulary', async () => {
    const missing = await run('init');
    assert.equal(missing.code, 2);
    for (const code of ENVIRONMENT) assert.ok(missing.err.includes(`${code}（${labelOf('environment', code)}）`));
    assert.equal((await run('init', '--environment', 'staging')).code, 2);
    assert.equal((await run('init', '--environment', 'test', '--port', '80')).code, 2);
    assert.equal((await runWith({ CIRCLE_HUB_PORT: '7999' }, 'init', '--environment', 'test', '--port', port)).code, 1, '--port and CIRCLE_HUB_PORT disagree');
    // hub/config would accept these, but the migration could never grant such a role: every deploy would fail.
    for (const name of ['hub-app', 'Hub_App', 'hub$app']) {
      const refused = await runWith({ CIRCLE_HUB_DATABASE_USER: name }, 'init', '--environment', 'test', '--port', port);
      assert.equal(refused.code, 1, name);
      assert.ok(refused.err.includes(`错误：CIRCLE_HUB_DATABASE_USER 的写法不对：${name}`), refused.err);
      assert.match(refused.err, /处理：应用角色名只能用小写字母、数字和下划线/);
    }
    await assert.rejects(readFile(join(root, 'config', 'platform.json')), 'and nothing was written');
    assert.ok(await isMissingOrEmpty(join(root, 'db')), 'and no cluster was made');
  });

  test('init writes and pins every value of the deployment, then runs a cluster; db start, stop and status', async () => {
    const first = await run('init', '--environment', 'test', '--port', port);
    assert.equal(first.code, 0, first.err);
    assert.match(first.out, /已写入部署设置/);
    assert.match(first.out, /已初始化数据库目录/);
    assert.match(first.out, new RegExp(`环境类别：测试（test）；端口：127\\.0\\.0\\.1:${port}`));
    assert.match(first.out, new RegExp(`数据库 circle_hub（属于角色 ${OWNER}，应用角色 circle_hub，套接字 .*\\.s\\.PGSQL\\.${databasePort}）；钥匙串项：服务 circle-hub，账户 vault-master-key`));
    const settings = JSON.parse(await readFile(join(root, 'config', 'platform.json'), 'utf8'));
    assert.equal(settings.environment, 'test');
    assert.equal(settings.port, Number(port));
    assert.deepEqual(settings.database, { name: 'circle_hub', role: 'circle_hub', socket_port: Number(databasePort) });
    const again = await run('init');
    assert.equal(again.code, 0);
    assert.match(again.out, /沿用已有部署设置/);
    assert.match(again.out, /没有重新初始化/);
    assert.equal((await run('init', '--environment', 'production')).code, 1);

    const running = await run('db', 'status');
    assert.equal(running.code, 0);
    assert.match(running.out, /数据库：运行中（PID \d+）/);
    assert.match(running.out, /没有 TCP 监听/);
    assert.match((await run('db', 'stop')).out, /数据库已停止/);
    assert.equal((await run('db', 'status')).code, 3);
    assert.match((await run('db', 'start')).out, /数据库已启动/);
    assert.match((await run('db', 'start')).out, /本来就在运行/);
  });

  test('a variable that disagrees with the deployment settings is refused by name and changes nothing', async () => {
    const wrongPort = await runWith({ CIRCLE_HUB_PORT: String(Number(port) + 1) }, 'status');
    assert.equal(wrongPort.code, 1);
    assert.match(wrongPort.err, /CIRCLE_HUB_PORT 是 \d+，部署设置里是 \d+/);
    for (const argv of [['backup'], ['service', 'install'], ['key', 'status'], ['db', 'start']]) {
      const stray = await runWith({ CIRCLE_HUB_DATABASE_NAME: 'circle_hub_dev', CIRCLE_HUB_KEYCHAIN_ACCOUNT: 'dev-key' }, ...argv);
      assert.equal(stray.code, 1, argv.join(' '));
      assert.match(stray.err, /CIRCLE_HUB_KEYCHAIN_ACCOUNT 是 dev-key，部署设置里是 vault-master-key；CIRCLE_HUB_DATABASE_NAME 是 circle_hub_dev，部署设置里是 circle_hub/);
    }
    const control = postgresFor(createContext({ CIRCLE_HUB_DATA_DIR: root }, { runner: system.runner }));
    const databases = await withSession(control.connector, 'postgres', (s) => s.query('SELECT datname FROM pg_database ORDER BY 1'));
    assert.ok(!databases.some((row) => row.datname === 'circle_hub_dev'), 'no stray database was created');
  });

  test('key init refuses a nonempty vault before touching the keychain', async () => {
    const vault = join(root, 'vault'); await mkdir(vault, { recursive: true });
    const entry = join(vault, 'synthetic-sealed-entry'); await writeFile(entry, 'synthetic sealed content');
    const before = system.calls.length;
    try {
      const result = await run('key', 'init');
      assert.equal(result.code, 1); assert.match(result.err, /set-aside/); assert.equal(system.calls.length, before);
    } finally { await rm(entry); }
  });

  test('key init and status never print the key and refuse to replace it', async () => {
    const absent = await run('key', 'status');
    assert.equal(absent.code, 3);
    assert.match(absent.out, /密钥库主密钥：没有（服务 circle-hub，账户 vault-master-key）/);
    const created = await run('key', 'init');
    assert.equal(created.code, 0);
    assert.match(created.out, /密钥不会显示/);
    assert.ok(system.state.key && KEY.test(system.state.key));
    assert.equal((await run('key', 'status')).code, 0);
    const again = await run('key', 'init');
    assert.equal(again.code, 1);
    assert.match(again.err, /不覆盖/);
    for (const call of system.calls) assert.ok(!call.args.some((arg) => arg.includes(system.state.key!)));
  });

  test('review 7: a healthy nonempty vault receives conditional recovery guidance without keychain access', async () => {
    const entry = join(root, 'vault', 'synthetic-healthy-entry');
    await writeFile(entry, 'synthetic sealed content');
    const before = system.calls.length;
    try {
      const result = await run('key', 'init');
      assert.equal(result.code, 1); assert.equal(system.calls.length, before);
      assert.match(result.err, /已有主密钥时不需要.*key init/);
      assert.match(result.err, /key status/);
      assert.match(result.err, /主密钥.*丢失.*找不回/);
      assert.match(result.err, /操作令牌也丢失时先.*operator-token reissue/);
      assert.ok(result.err.indexOf('operator-token reissue')<result.err.indexOf('secret import'));
    } finally { await rm(entry); }
  });

  test('service install needs a release; then install, status and stop go through launchctl only', async () => {
    const early = await run('service', 'install');
    assert.equal(early.code, 1);
    assert.match(early.err, /还没有部署任何发布/);
    const id = 'abcdefabcdef';
    await mkdir(join(root, 'releases', id, 'bin'), { recursive: true });
    await writeFile(join(root, 'releases', id, 'release.json'), JSON.stringify({ schema: RELEASE_SCHEMA, id, created_at: '2026-10-21T12:00:00.000Z' }));
    // A real release always has its own node_modules (npm ci); link this checkout's.
    await symlink(join(WORKTREE, 'node_modules'), join(root, 'releases', id, 'node_modules'));
    await symlink(join('releases', id), join(root, 'current'));
    const installed = await run('service', 'install');
    assert.equal(installed.code, 0, installed.err);
    const plist = await readFile(join(parent, 'home', 'Library', 'LaunchAgents', 'io.github.circle-platforms.circle-hub.plist'), 'utf8');
    assert.ok(plist.includes(`<string>${join(root, 'current', 'bin', 'circle-hub')}</string>`));
    assert.ok(plist.includes(`<string>${port}</string>`));
    assert.ok(plist.includes(`<string>${databasePort}</string>`), 'the pinned socket port, not a default');
    assert.match((await run('service', 'status')).out, /服务：运行中（PID 777）/);
    assert.match((await run('service', 'stop')).out, /服务已停止/);
    assert.equal((await run('service', 'status')).code, 3);
    assert.ok(system.calls.filter((call) => call.command.endsWith('launchctl')).every((call) => call.command === '/bin/launchctl'));
  });

  test('status summarises settings, release, database, key, service, backups and health', async () => {
    const status = await run('status');
    assert.equal(status.code, 0, status.err);
    for (const line of [
      /数据根：/,
      new RegExp(`环境类别：测试（test）；端口：127\\.0\\.0\\.1:${port}`),
      /数据库 circle_hub（应用角色 circle_hub，套接字 /,
      /当前发布：abcdefabcdef/,
      /数据库：运行中/,
      new RegExp(`^数据库 circle_hub 属于角色 ${OWNER}$`, 'm'),
      /应用角色 circle_hub：只连接并按授权读写，不拥有任何对象/,
      /密钥库主密钥：已在钥匙串/,
      /服务：未加载/,
      /备份：0 份/,
      new RegExp(`健康检查（http://127\\.0\\.0\\.1:${port}/healthz）：不正常`),
    ]) {
      assert.match(status.out, line);
    }
  });

  test('status names an application role that owns an object, with the fix; the owner shown is the one the cluster reports', async () => {
    const control = postgresFor(createContext({ CIRCLE_HUB_DATA_DIR: root }, { runner: system.runner }));
    const owner = control.target.user;
    // A large object the application role made itself: the Hub keeps running, backups and deploys refuse.
    const [lo] = await withSession(control.applicationConnector, control.target.database, (s) => s.query('SELECT lo_create(0)::text AS oid'));
    const objects = await run('status');
    assert.match(objects.out, new RegExp(`应用角色 circle_hub：不正常，拥有 1 个对象（large object ${lo?.oid}）；Hub 照常运行，但备份和部署会拒绝；处理：以本机账户的角色 `));
    await withSession(control.connector, control.target.database, (s) => s.query(`SELECT lo_unlink(${lo?.oid})`));
    await ownerTables(control, ['CREATE TABLE handed_over (n int)'], ['handed_over']);
    await withSession(control.connector, control.target.database, (s) => s.query('ALTER TABLE handed_over OWNER TO circle_hub'));
    try {
      const status = await run('status');
      assert.equal(status.code, 0, status.err);
      assert.match(status.out, /应用角色 circle_hub：不正常，拥有 1 个对象（table handed_over）；处理：.*执行「REASSIGN OWNED BY "circle_hub" TO "[^"]+";」/);
      // A data root of an earlier platform version: the database itself belongs to the application role.
      await withSession(control.connector, control.target.database, (s) => s.query('ALTER DATABASE circle_hub OWNER TO circle_hub'));
      const old = await run('status');
      assert.match(old.out, /^数据库 circle_hub 属于角色 circle_hub$/m);
      assert.doesNotMatch(old.out, new RegExp(`属于角色 ${OWNER}`), 'never the account name in place of the real owner');
      assert.match(old.out, /应用角色 circle_hub：不正常，.*拥有 2 个对象（database circle_hub、table handed_over）/);
      const again = await run('init');
      assert.equal(again.code, 0, again.err);
      assert.match(again.out, /数据库 circle_hub（属于角色 circle_hub，应用角色 circle_hub，/);
    } finally {
      await withSession(control.connector, control.target.database, async (s) => {
        await s.query(`ALTER DATABASE circle_hub OWNER TO "${owner}"`);
        await s.query('GRANT CONNECT ON DATABASE circle_hub TO circle_hub');
        await s.query('DROP TABLE handed_over');
      });
    }
    assert.match((await run('status')).out, /应用角色 circle_hub：只连接并按授权读写，不拥有任何对象/);
  });

  test('backup through the CLI names the data root first, and restore refuses a data root that has data', { skip: libpq ? false : LIBPQ_MISSING }, async () => {
    const control = postgresFor(createContext({ CIRCLE_HUB_DATA_DIR: root }, { runner: system.runner }));
    await ownerTables(control, ['CREATE TABLE synthetic_records (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, body text NOT NULL)'], ['synthetic_records']);
    await withSession(control.applicationConnector, control.target.database, (s) => s.query("INSERT INTO synthetic_records (body) VALUES ('合成')"));
    const backup = await run('backup', '--keep', '3');
    assert.equal(backup.code, 0, backup.err);
    assert.equal(backup.lines[0], `数据根：${root}`, 'the data root is printed before anything happens');
    const dir = /备份完成：(.+)$/m.exec(backup.out)?.[1];
    assert.ok(dir);
    assert.match(backup.out, /数据库 1 张表 1 行/);
    assert.match(backup.out, /清单含每个文件的 SHA-256/);
    const refused = await run('restore', dir);
    assert.equal(refused.code, 1);
    assert.equal(refused.lines[0], `数据根：${root}`);
    assert.match(refused.err, /只能恢复到空的数据根/);
    assert.match((await run('status')).out, /备份：1 份/);
  });

  test('restore refuses while the service is loaded, because launchd would race it for the database', async () => {
    system.state.loaded = true;
    try {
      const refused = await run('restore', join(parent, 'any-backup'));
      assert.equal(refused.code, 1);
      assert.match(refused.err, /Hub 服务已加载（launchd 会不断重启它，它会和恢复抢数据库），不恢复/);
      assert.match(refused.err, /处理：先运行 circle-hub service stop/);
    } finally {
      system.state.loaded = false;
    }
  });

  test('an unfinished deploy is shown by status, and backup and restore refuse until it is finished', async () => {
    const progress = join(root, 'releases', 'operation.json');
    await writeFile(
      progress,
      JSON.stringify({
        schema: 'circle-hub-operation@1',
        operation: 'deploy',
        started_at: '2026-10-21T11:00:00.000Z',
        step: 'migrate',
        release: 'bbbbbbbbbbbb',
        previous: 'abcdefabcdef',
        backup: '20261021T110000Z-pre-deploy',
        service_was_loaded: true,
        data_touched: true,
      }),
    );
    try {
      assert.match((await run('status')).out, /注意：上次部署（发布 bbbbbbbbbbbb）在“迁移”这一步没有完成（开始于 2026-10-21T11:00:00\.000Z）；运行 circle-hub deploy 完成它/);
      for (const [argv, action] of [
        [['backup'], '备份'],
        [['restore', join(parent, 'any-backup')], '恢复'],
      ] as const) {
        const refused = await run(...argv);
        assert.equal(refused.code, 1);
        assert.match(refused.err, new RegExp(`上次部署.*没有完成.*，现在不${action}`));
        assert.match(refused.err, /处理：先运行 circle-hub deploy 完成它/);
      }
    } finally {
      await rm(progress, { force: true });
    }
  });
});

describe('service commands on settings that give the vault master key the operator token\'s account', () => {
  test('install and start are refused before launchctl or anything else runs; stop, uninstall and status still work', async () => {
    const parent = await tempDir();
    try {
      const root = join(parent, 'root');
      const layout = layoutAt(root);
      await ensureLayout(layout);
      // Edited by hand, or written by an earlier platform version's init with CIRCLE_HUB_KEYCHAIN_ACCOUNT=operator-token.
      await writeFile(settingsPath(layout), JSON.stringify({ ...newSettingsFile({ environment: 'test' }), keychain_account: OPERATOR_TOKEN_ACCOUNT }));
      // A deployed release, so that nothing else stops the install.
      const id = 'abcdefabcdef';
      await mkdir(join(layout.releases, id), { recursive: true });
      await writeFile(join(layout.releases, id, 'release.json'), JSON.stringify({ schema: RELEASE_SCHEMA, id, created_at: '2026-10-21T12:00:00.000Z' }));
      await symlink(join('releases', id), layout.current);
      const system = fakeSystem();
      const agents = join(parent, 'home', 'Library', 'LaunchAgents');
      const overrides = { home: join(parent, 'home'), runner: system.runner, launchAgentsDir: agents, uid: 501, nodePath: process.execPath };
      const run = async (...argv: string[]) => {
        const captured = captureIo({ CIRCLE_HUB_DATA_DIR: root }, parent);
        return { code: await runPlatformCommand(argv, captured.io, overrides), err: captured.err.join('\n') };
      };
      for (const action of ['install', 'start']) {
        const refused = await run('service', action);
        assert.equal(refused.code, 1, action);
        assert.equal(
          refused.err,
          `错误：部署设置（${settingsPath(layout)}）里密钥库主密钥的钥匙串账户是 operator-token：这个账户留给操作令牌，两者会成为同一个钥匙串项，不执行\n` +
            '处理：把部署设置里的 keychain_account 改成另一个名字（例如 vault-master-key）；钥匙串里已有这个账户的密钥库主密钥时，先在“钥匙串访问”里把那一项的账户改成同一个名字',
          action,
        );
      }
      assert.deepEqual(system.calls.map((call) => `${call.command} ${call.args.join(' ')}`), [], 'neither launchctl nor node --version ran');
      await assert.rejects(access(join(agents, 'io.github.circle-platforms.circle-hub.plist')), 'no service definition was written');
      // A service that keeps failing can still be stopped and removed.
      assert.equal((await run('service', 'stop')).code, 0);
      assert.equal((await run('service', 'uninstall')).code, 0);
      assert.equal((await run('service', 'status')).code, 3);
      assert.ok(system.calls.every((call) => call.command === '/bin/launchctl' && call.args[0] === 'print'), 'only status queries');
    } finally {
      await removeDir(parent);
    }
  });
});

async function keyAsideWorld(t: {after(fn:()=>Promise<void>):void},port?:number) {
 const parent=await tempDir();t.after(()=>removeDir(parent));const layout=layoutAt(join(parent,'root'));await ensureLayout(layout);
 const keychain=join(parent,'synthetic.keychain-db');await writeFile(keychain,'synthetic fake-keychain target');
 const dbPort=socketPort();await writeFile(settingsPath(layout),JSON.stringify(newSettingsFile({environment:ENVIRONMENT[0],port:port ?? await freePort(),keychainService:'synthetic-key-recovery',database:{port:dbPort}})));
 const system=fakeSystem();const runner:PlatformContext['runner']=async(command,args,options)=>{if(command==='/usr/bin/security'){await access(join(layout.run,'platform.lock'));assert.ok([...args,options?.input ?? ''].join(' ').includes(keychain));}return system.runner(command,args,options);};
 const run=async(...args:string[])=>{const capture=captureIo({CIRCLE_HUB_DATA_DIR:layout.root,CIRCLE_HUB_DATABASE_PORT:String(dbPort)},parent);const code=await runPlatformCommand(args,capture.io,{runner,home:parent,keychain,uid:501,now:()=>new Date('2026-10-23T00:00:00.000Z')});return{code,out:capture.out.join('\n'),err:capture.err.join('\n')};};
 await writeFile(join(layout.vault,'sealed'),'synthetic sealed bytes');await writeFile(join(layout.db,'sentinel'),'synthetic database');await writeFile(join(layout.objects,'sentinel'),'synthetic object');
 return{parent,layout,system,run};
}
test('closure key init flag archives only the vault under the platform lock and initializes a missing key',async t=>{
 const w=await keyAsideWorld(t);const before=await w.run('key','init');assert.equal(before.code,1);assert.match(before.err,/--set-aside-vault/);assert.equal(w.system.calls.length,0);
 await mkdir(join(w.layout.setAside,'20261023T000000Z-key-loss'),{recursive:true});await writeFile(join(w.layout.setAside,'20261023T000000Z-key-loss','sentinel'),'keep prior archive');
 const result=await w.run('key','init','--set-aside-vault');assert.equal(result.code,0,result.err);assert.ok(w.system.state.key);
 assert.equal(await readFile(join(w.layout.setAside,'20261023T000000Z-key-loss-2','vault','sealed'),'utf8'),'synthetic sealed bytes');assert.deepEqual(await readdir(w.layout.vault),[]);assert.equal((await stat(w.layout.vault)).mode & 0o777,0o700);
 for(const area of [w.layout.db,w.layout.objects])assert.match(await readFile(join(area,'sentinel'),'utf8'),/synthetic/);assert.doesNotMatch(result.out+result.err,KEY);
});
test('closure key init flag refuses a loaded service before any keychain call or move',async t=>{
 const w=await keyAsideWorld(t);w.system.state.loaded=true;const result=await w.run('key','init','--set-aside-vault');assert.equal(result.code,1);assert.match(result.err,/service stop/);assert.equal(w.system.calls.filter(c=>c.command==='/usr/bin/security').length,0);assert.equal(await readFile(join(w.layout.vault,'sealed'),'utf8'),'synthetic sealed bytes');
});
test('closure key init flag preserves a healthy existing key and its current vault',async t=>{
 const w=await keyAsideWorld(t);w.system.state.key='a'.repeat(64);const result=await w.run('key','init','--set-aside-vault');assert.equal(result.code,1);assert.equal(await readFile(join(w.layout.vault,'sealed'),'utf8'),'synthetic sealed bytes');assert.ok(!w.system.calls.some(c=>c.command==='/usr/bin/security' && c.args[0]==='-i'));
});

test('closure key init flag refuses a manually occupied configured port before touching the vault or keychain',async t=>{
 const {createServer}=await import('node:net');const server=createServer(socket=>socket.end());
 await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));t.after(()=>new Promise<void>(done=>server.close(()=>done())));
 const address=server.address();assert.ok(address && typeof address!=='string');const w=await keyAsideWorld(t,address.port);
 const result=await w.run('key','init','--set-aside-vault');assert.equal(result.code,1);assert.match(result.err,/配置端口.*进程应答/);
 assert.equal(w.system.calls.filter(c=>c.command==='/usr/bin/security').length,0);assert.equal(await readFile(join(w.layout.vault,'sealed'),'utf8'),'synthetic sealed bytes');
});

test('closure key init recovery order reissues a missing operator token before importing secrets',async t=>{
 const w=await keyAsideWorld(t);const result=await w.run('key','init');assert.equal(result.code,1);
 assert.ok(result.err.indexOf('operator-token reissue')<result.err.indexOf('secret import'),result.err);
});

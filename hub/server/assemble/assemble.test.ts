// The assembly at start-up: the order of serve (retired names, configuration, records without migrating, then the assembly,
// then listening) and its failure modes (a retired variable, an unmigrated database, no vault key in a file or in the
// keychain, with the restore advice when the vault holds entries, a wrong key), a real start that serves the six tools over
// the real packages, the command-time assembly (no key, no notice), and the call notes (the engine's reasons in the call's
// note and the operator's log, connector failures only and capped). A temporary socket-only PostgreSQL; no real keychain
// (a fake security tool), no network beyond loopback.
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { VAULT_KEY_ITEM, hubKeyProvider, type CommandRunner } from '../../platform/api.ts';
import { checkVaultKey } from '../../records/api.ts';
import { FileKeyProvider, openRecords } from '../../records/index.ts';
import { startPostgres, type TemporaryPostgres } from '../../testing/postgres.ts';
import { openTestRecords } from '../../testing/records.ts';
import { type HubConfig } from '../../config/index.ts';
import type { AssemblyModule, ListenInfo } from '../api.ts';
import { loadServerConfig } from '../main.ts';
import { MAX_ADMIN_NOTE, clipNote } from '../notes.ts';
import { AssemblyError } from './errors.ts';
import { assembleHub, createAssembly, createCommandAssembly } from './hub.ts';
import { CallNotes, MAX_CONNECTOR_NOTES } from './notes.ts';
import { openCliHarness, type CliHarness } from './test-cli.ts';
import { vaultKeyProblem } from './vault.ts';

let harness: CliHarness;
let postgres: TemporaryPostgres;

before(async () => {
  harness = await openCliHarness();
  postgres = await startPostgres();
});
after(async () => {
  await harness?.close();
  await postgres?.stop();
});

const realAssembly = () => import('../assemble.ts') as Promise<AssemblyModule>;
/** A server that should never have started stops after a while, so the test fails instead of hanging. */
const stopSoon = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 3000).unref());

/** An assembly module that records whether it was loaded and called. */
function spyAssembly(): { load: () => Promise<AssemblyModule>; loaded: number; assembled: number } {
  const spy = {
    loaded: 0,
    assembled: 0,
    load: async (): Promise<AssemblyModule> => {
      spy.loaded += 1;
      const module = await realAssembly();
      return {
        assemble: (config, records) => {
          spy.assembled += 1;
          return module.assemble(config, records);
        },
      };
    },
  };
  return spy;
}

/** A fake security tool: every call recorded; `find-generic-password` answers "not found" (44) unless told otherwise. */
function fakeSecurity(answer: (args: readonly string[]) => { code: number; stdout?: string; stderr?: string } | undefined = () => undefined) {
  const calls: { args: string[]; input: string }[] = [];
  const runner: CommandRunner = async (_command, args, options = {}) => {
    calls.push({ args: [...args], input: options.input ?? '' });
    const given = answer(args);
    if (given !== undefined) return { stdout: '', stderr: '', ...given };
    if (args[0] === 'find-generic-password') return { code: 44, stdout: '', stderr: 'The specified item could not be found in the keychain.' };
    return { code: 1, stdout: '', stderr: 'unexpected call' };
  };
  return { runner, calls };
}

describe('start-up order and failure modes', () => {
  test('a retired CIRCLE_SERVER_* variable refuses serve and the admin commands before the assembly or the key is touched', async () => {
    const deployment = await harness.deployment();
    const spy = spyAssembly();
    let keyAsked = 0;
    for (const argv of [['serve'], ['pack', 'list'], ['secret', 'list'], ['init-admin', '甲']]) {
      const result = await deployment.run(argv, { assembly: spy.load, keyProvider: () => (keyAsked++, deployment.key) }, { CIRCLE_SERVER_PORT: '7420' });
      assert.equal(result.code, 1, argv.join(' '));
      assert.match(result.text, /不再读取 CIRCLE_SERVER_\*/);
      assert.doesNotMatch(result.text, /7420/, 'values are never printed');
    }
    assert.equal(spy.loaded, 0, 'the assembly is never loaded');
    assert.equal(keyAsked, 0, 'the key provider is never asked');
  });

  test('serve on a database the owner never migrated refuses before the assembly runs', async () => {
    const deployment = await harness.deployment({ migrate: false });
    const spy = spyAssembly();
    let listening: ListenInfo | null = null;
    const result = await deployment.run(['serve'], { assembly: spy.load, onListening: (info) => (listening = info) });
    assert.equal(result.code, 1);
    assert.match(result.text, /还没有应用/);
    assert.equal(spy.assembled, 0, 'records come before the assembly');
    assert.equal(listening, null);
    for (const argv of [['pack', 'list'], ['init-admin', '甲']]) {
      const command = await deployment.run(argv, { assembly: realAssembly });
      assert.equal(command.code, 1, argv.join(' '));
      assert.match(command.text, /还没有应用/, argv.join(' '));
    }
  });

  test('serve without a vault key stops before listening and never creates the key', async () => {
    const deployment = await harness.deployment({ key: false });
    const spy = spyAssembly();
    let listening: ListenInfo | null = null;
    const result = await deployment.run(['serve'], { assembly: spy.load, onListening: (info) => (listening = info), stopSignal: stopSoon });
    assert.equal(result.code, 1, result.text);
    assert.match(result.text, /密钥库主密钥不可用，Hub 不启动/);
    assert.match(result.text, /处理：/);
    assert.equal(spy.assembled, 1, 'the records were open; the assembly found no key');
    assert.equal(listening, null, 'nothing listens');
    await assert.rejects(access(deployment.key.path), 'the key file was not created');
  });

  test('serve with the platform keychain provider and no keychain item stops and never adds one', async () => {
    const deployment = await harness.deployment();
    const security = fakeSecurity();
    const result = await deployment.run(['serve'], {
      assembly: realAssembly,
      keyProvider: (env) => hubKeyProvider(env, { runner: security.runner }),
      stopSignal: stopSoon,
    });
    assert.equal(result.code, 1, result.text);
    // The platform names its item (VAULT_KEY_ITEM.label): the server's test follows the label, not a spelling of it.
    assert.ok(result.text.includes(`没有${VAULT_KEY_ITEM.label}`), result.text);
    assert.match(result.text, /key init/);
    assert.ok(security.calls.length > 0, 'the keychain was asked');
    assert.ok(security.calls.every((call) => call.args[0] === 'find-generic-password'), 'only reads: no add, no -i');
    assert.ok(security.calls.every((call) => call.input === ''), 'nothing was written to the tool');
  });

  test('a vault that holds entries is never told to create a key: the restore advice replaces the provider\'s key init', async () => {
    const deployment = await harness.deployment();
    const kit = await openRecords(loadServerConfig(deployment.env), { migrate: false, keyProvider: deployment.key });
    try {
      await kit.vault.put('connector.res_00000000000000000000000000.password', 'synthetic-value-2');
    } finally {
      await kit.close();
    }
    // The keychain item is gone (another Mac, a reset keychain); the sealed entry proves a key existed.
    const security = fakeSecurity();
    const result = await deployment.run(['serve'], {
      assembly: realAssembly,
      keyProvider: (env) => hubKeyProvider(env, { runner: security.runner }),
      stopSignal: stopSoon,
    });
    assert.equal(result.code, 1, result.text);
    assert.match(result.text, new RegExp(`密钥库主密钥不可用，Hub 不启动：.*没有${VAULT_KEY_ITEM.label}`));
    assert.match(result.text, /处理：密钥库里已有用原来的主密钥封存的条目：恢复原来的钥匙串项；不要运行 circle-hub key init/);
    assert.doesNotMatch(result.text, /先运行 circle-hub key init/);
    assert.ok(security.calls.every((call) => call.args[0] === 'find-generic-password'), 'only reads');
  });

  test('a key that does not open the vault stops the assembly', async () => {
    const kit = await openTestRecords({ postgres });
    try {
      await kit.vault.put('connector.res_x.password', 'synthetic-value-1');
      const other = new FileKeyProvider(join(kit.dataDir, 'other.key'));
      await other.initKey();
      const wrong = await openRecords({ dataDir: kit.dataDir, logDir: join(kit.dataDir, 'logs'), database: kit.database, limits: kit.config.limits }, { keyProvider: other });
      try {
        await assert.rejects(assembleHub(configOf(kit), wrong, { log: () => {} }), (error: unknown) => {
          assert.ok(error instanceof AssemblyError);
          assert.match(error.message, /密钥与密钥库不符/);
          return true;
        });
      } finally {
        await wrong.close();
      }
    } finally {
      await kit.close();
    }
  });

  test('with a key, serve assembles the real packages, listens, serves the six tools to a token and stops', async () => {
    const deployment = await harness.deployment();
    const kit = await openRecords(loadServerConfig(deployment.env), { migrate: false });
    let token: string;
    try {
      token = (await kit.principals.bootstrapAdmin('管理员')).token.token;
    } finally {
      await kit.close();
    }
    let stop: () => void = () => {};
    const stopped = new Promise<void>((resolve) => (stop = resolve));
    let url = '';
    // The production assembly writes its notices to the process's stderr (the operator's log under launchd).
    const operatorLog: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      operatorLog.push(String(chunk));
      return (write as (...args: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stderr.write;
    const serving = deployment.run(['serve'], { assembly: realAssembly, stopSignal: () => stopped, onListening: (info) => (url = info.url) });
    for (let i = 0; i < 400 && url === ''; i++) await new Promise((resolve) => setTimeout(resolve, 25));
    process.stderr.write = write;
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.ok(!operatorLog.some((line) => /判断服务|Jev/.test(line)), 'no judgment-service notice: the Hub calls no model');
    try {
      assert.equal((await fetch(`${url}/healthz`)).status, 200);
      const client = new Client({ name: 'assembly-test', version: '0.0.0' });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}`, 'circle-session-id': 'assembly-1' } } }));
      try {
        const tools = await client.listTools();
        assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ['get_nodes', 'list_task_packs', 'resolve_reference', 'start_run', 'submit_result', 'upload_file']);
        const listed = (await client.callTool({ name: 'list_task_packs', arguments: {} })) as { isError?: boolean; structuredContent?: { packs?: unknown[] } };
        assert.equal(listed.isError, false);
        assert.deepEqual(listed.structuredContent?.packs, [], 'the real registry: nothing published yet');
        const run = (await client.callTool({ name: 'start_run', arguments: { pack: 'demo-none', inputs: {} } })) as { isError?: boolean; structuredContent?: { errors?: { code: string }[] } };
        assert.equal(run.isError, true);
        assert.equal(run.structuredContent?.errors?.[0]?.code, 'SOURCE_UNAVAILABLE');
      } finally {
        await client.close();
      }
    } finally {
      stop();
    }
    const result = await serving;
    assert.equal(result.code, 0, result.text);
    const after = await openRecords(loadServerConfig(deployment.env), { migrate: false });
    try {
      const admin = (await after.principals.findByName('管理员'))!;
      const lines = (await after.callLog.query({ id: admin.id, name: admin.name, role: 'admin' }, { tool: 'start_run' })).items;
      assert.equal(lines.length, 1);
      assert.match((lines[0].admin_reasons ?? []).join('\n'), /start_run/, 'the engine reason behind the neutral answer is private');
      assert.equal(lines[0].session, 'assembly-1');
    } finally {
      await after.close();
    }
  });
});

function configOf(kit: { dataDir: string; database: HubConfig['database']; config: { limits: HubConfig['limits'] } }): HubConfig {
  return {
    dataDir: kit.dataDir,
    logDir: join(kit.dataDir, 'logs'),
    host: '127.0.0.1',
    port: 0,
    database: kit.database,
    keychain: { service: 'circle-hub-test', account: 'vault' },
    limits: { ...kit.config.limits },
  };
}

describe('the vault key check', () => {
  test('checkVaultKey of hub/records passes with the vault\'s key, refuses a missing or another key, and adds no entry', async () => {
    const kit = await openTestRecords({ postgres });
    try {
      await kit.vault.put('connector.res_y.password', 'synthetic-value-3');
      await checkVaultKey(kit.vault);
      assert.deepEqual(await kit.vault.list(), ['connector.res_y.password'], 'nothing was added');
      const other = new FileKeyProvider(join(kit.dataDir, 'another.key'));
      await other.initKey();
      const config = { dataDir: kit.dataDir, logDir: join(kit.dataDir, 'logs'), database: kit.database, limits: kit.config.limits };
      for (const keyProvider of [other, new FileKeyProvider(join(kit.dataDir, 'absent.key'))]) {
        const wrong = await openRecords(config, { keyProvider });
        try {
          await assert.rejects(checkVaultKey(wrong.vault));
          assert.equal(await vaultKeyProblem(wrong) === null, false, 'the listing\'s check says why');
        } finally {
          await wrong.close();
        }
      }
      assert.equal(await vaultKeyProblem(kit), null);
    } finally {
      await kit.close();
    }
  });
});

describe('the command-time assembly', () => {
  test('a CLI command\'s assembly needs no vault key and prints nothing; serve\'s refuses to start and a command\'s own says it did not run', async () => {
    const kit = await openTestRecords({ postgres });
    // The same records with a key provider whose key does not exist.
    const keyless = await openRecords(
      { dataDir: kit.dataDir, logDir: join(kit.dataDir, 'logs'), database: kit.database, limits: kit.config.limits },
      { keyProvider: new FileKeyProvider(join(kit.dataDir, 'missing.key')) },
    );
    try {
      const admin = (await keyless.principals.bootstrapAdmin('管理员')).user;
      const lines: string[] = [];
      const deps = await createCommandAssembly({ requireOsIsolation: false })(configOf(kit), keyless, { stderr: (line) => lines.push(line) });
      assert.equal(await deps.runs.getRun({ id: admin.id, name: admin.name, role: admin.role }, 'run_00000000000000000000000001'), null, 'a run is read without the key');
      assert.deepEqual(lines, [], 'no start-up notice for a command');
      await assert.rejects(async () => createAssembly({ requireOsIsolation: false, log: () => {} })(configOf(kit), keyless), (error: unknown) => {
        assert.ok(error instanceof AssemblyError);
        assert.match(error.message, /^密钥库主密钥不可用，Hub 不启动：/);
        return true;
      });
      await assert.rejects(assembleHub(configOf(kit), keyless, { requireOsIsolation: false, command: true, log: () => {} }), /^AssemblyError: 密钥库主密钥不可用，这个命令要用密钥库，没有执行：/);
      const module = (await import('../assemble.ts')) as { assembleCommand?: unknown };
      assert.equal(typeof module.assembleCommand, 'function', 'the module offers it for the server core\'s ctx.deps()');
    } finally {
      await keyless.close();
      await kit.close();
    }
  });

  test('run show through the CLI uses the command-time assembly: it reads runs without the vault key, and serve\'s assembly is never called', async () => {
    const deployment = await harness.deployment({ key: false });
    assert.equal((await deployment.run(['user', 'create', '根管理员', '--role', 'admin'])).code, 0);
    let served = 0;
    const real = (await realAssembly()) as AssemblyModule;
    const module: AssemblyModule = {
      ...real,
      assemble: (config, records) => {
        served += 1;
        return real.assemble(config, records);
      },
    };
    const shown = await deployment.run(['run', 'show', 'run_00000000000000000000000001'], { assembly: async () => module });
    assert.equal(shown.code, 1, shown.text);
    assert.match(shown.text, /错误：没有运行 run_00000000000000000000000001/, 'the run was looked up');
    assert.doesNotMatch(shown.text, /密钥库主密钥不可用|Hub 不启动/, 'no vault key needed');
    assert.equal(served, 0, 'serve\'s assembly is not a command\'s');
    const { assembleCommand: _command, ...withoutCommand } = real;
    const refused = await deployment.run(['run', 'show', 'run_00000000000000000000000001'], { assembly: async () => withoutCommand as AssemblyModule });
    assert.equal(refused.code, 1);
    assert.match(refused.text, /run show 要用运行模块，这个装配模块没有提供/);
    assert.match(refused.text, /assembleCommand/);
  });
});

describe('call notes', () => {
  const at = '2026-10-22T00:00:00.000Z';
  const trace = '4bf92f3577b34da6a3ce929d0e0e4736';

  test('a connector or registry message raised inside a call becomes that call\'s note; the engine\'s go to the operator log only', async () => {
    const log: string[] = [];
    const notes = new CallNotes((line) => log.push(line));
    const first: string[] = [];
    const second: string[] = [];
    // Two calls of the same trace at once: each message reaches its own call only.
    await Promise.all([
      notes.within({ traceId: trace, sessionId: 'a', adminNote: (reason) => first.push(reason) }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        notes.registryError(new Error('合成的撞名'), 'packs.product_ambiguous');
        notes.engine({ traceId: trace, run: null, what: 'start_run', detail: '甲的原因' });
      }),
      notes.within({ traceId: trace, sessionId: 'b', adminNote: (reason) => second.push(reason) }, async () => {
        notes.connector({ at, event: 'login_failed', resource: 'res_x', code: 1005 });
        notes.connector({ at, event: 'http', resource: 'res_x', status: 200 });
        notes.engine({ traceId: trace, run: null, what: 'start_run', detail: '乙的原因' });
      }),
    ]);
    assert.deepEqual(first, ['packs packs.product_ambiguous: 合成的撞名']);
    assert.equal(second.length, 1);
    assert.match(second[0], /^connector login_failed res_x/);
    for (const reason of ['甲的原因', '乙的原因']) {
      assert.ok(log.some((line) => line === `运行引擎（追踪 ${trace}，运行 无）：start_run: ${reason}`), `${reason} is in the operator log, with its trace`);
    }
    assert.ok(log.some((line) => /连接器：login_failed res_x/.test(line)), 'login events always reach the operator log');
    assert.ok(log.some((line) => /任务包：packs.product_ambiguous: 合成的撞名/.test(line)), 'registry problems too');
    assert.ok(!log.some((line) => line.includes('http')), 'per-request events are not logged');
    notes.engine({ traceId: null, run: null, what: 'sweep', detail: '没有调用' });
    assert.match(log.at(-1) ?? '', /运行引擎（追踪 无，运行 无）：sweep: 没有调用/);
  });

  test('the operator log takes no line break and no control character from a caller: an engine reason quoting a hostile pack stays one escaped line', async () => {
    const kit = await openTestRecords({ postgres });
    try {
      const log: string[] = [];
      const hub = await assembleHub(configOf(kit), kit, { requireOsIsolation: false, log: (line) => log.push(line) });
      const admin = (await kit.principals.bootstrapAdmin('管理员')).user;
      // start_run's pack is any non-empty string; the engine quotes it in its reason.
      const RLO = String.fromCodePoint(0x202e);
      const pack = `x is unknown\n2026-10-22T09:00:00Z circle-hub 已停止（数据库保持运行）\r\n\u001b]0;pwned\u0007\u009b2J${RLO}`;
      const answer = await hub.runs.startRun({ id: admin.id, name: admin.name, role: admin.role }, { pack, inputs: {} }, { traceId: trace, sessionId: null, adminNote: () => {} });
      assert.equal(answer.errors[0]?.code, 'SOURCE_UNAVAILABLE');
      for (const line of log) assert.ok(![...'\n\r\u001b\u0007\u009b', RLO].some((char) => line.includes(char)), JSON.stringify(line));
      const engine = log.filter((line) => line.startsWith('运行引擎'));
      assert.equal(engine.length, 1, 'one line, no forged second one');
      assert.ok(engine[0].includes('pack x is unknown\\x0a2026-10-22T09:00:00Z circle-hub 已停止（数据库保持运行）\\x0d\\x0a\\x1b]0;pwned\\x07\\x9b2J\\u202e is unknown'), engine[0]);
      // Every source of the log goes through the same place (CallNotes.log).
      const notes = new CallNotes((line) => log.push(line));
      notes.connector({ at, event: 'read_failed', resource: 'res_x', external: 'agile:mindmap:d\n伪造', reason: '\u001b[2J' });
      notes.registryError(new Error('坏\n行'), 'packs.load');
      notes.tamper({ digest: 'a'.repeat(64), quarantine: null, problems: ['文件\u001b[1A'] } as never);
      for (const line of log.slice(-3)) assert.ok(![...'\n\u001b'].some((char) => line.includes(char)), JSON.stringify(line));
    } finally {
      await kit.close();
    }
  });

  test('connector success events stay out of a call\'s note and failures are capped, so the engine\'s own note survives the clipping', async () => {
    const log: string[] = [];
    const notes = new CallNotes((line) => log.push(line));
    const kept: string[] = [];
    const context = { traceId: trace, sessionId: 's', adminNote: (reason: string) => kept.push(reason) };
    // A start_run that logs in once and reads many sources (target, historical lists, linked texts), a few of which fail;
    // the engine notes its reason on the call itself (CallContext.adminNote), after the connectors' events.
    await notes.within(context, async () => {
      notes.connector({ at, event: 'login_attempt', resource: 'res_x', reason: 'no_token' });
      notes.connector({ at, event: 'login_ok', resource: 'res_x', expires_at: null });
      for (let i = 0; i < 40; i++) notes.connector({ at, event: 'read_ok', resource: 'res_x', external: `agile:mindmap:d${i}`, artifacts: 2, bytes: 1024 });
      for (let i = 0; i < 6; i++) notes.connector({ at, event: 'read_failed', resource: 'res_x', external: `plm:bug:${i}`, code: 'SOURCE_FORBIDDEN', reason: '合成的拒绝'.repeat(80) });
      context.adminNote('expected source plm:bug:4242: SOURCE_FORBIDDEN 合成的最终原因');
      notes.engine({ traceId: trace, run: null, what: 'expected source plm:bug:4242', detail: 'SOURCE_FORBIDDEN 合成的最终原因' });
    });
    const note = clipNote(kept.join(' | '), MAX_ADMIN_NOTE);
    assert.ok(note.includes('expected source plm:bug:4242: SOURCE_FORBIDDEN 合成的最终原因'), 'the engine\'s reason is in the clipped note');
    assert.equal(kept.filter((line) => line.includes('合成的最终原因')).length, 1, 'said once: the bridge does not repeat the engine');
    assert.ok(!kept.some((line) => /read_ok|login_ok|login_attempt/.test(line)), 'no success event in the note');
    assert.equal(kept.filter((line) => line.startsWith('connector read_failed')).length, MAX_CONNECTOR_NOTES);
    assert.equal(kept.filter((line) => /further failure events of this call are in the operator's log only/.test(line)).length, 1);
    assert.ok(kept.every((line) => [...line].length <= 1000));
    assert.equal(log.filter((line) => line.startsWith('连接器：read_ok')).length, 40, 'every success event is in the operator log');
    assert.equal(log.filter((line) => line.startsWith('连接器：read_failed')).length, 6, 'and every failure');
    assert.ok(log.some((line) => line.includes(trace) && line.includes('合成的最终原因')), 'the engine\'s reason is in the operator log with its trace');
  });
});

describe('the wiring of the engine', () => {
  test('the server gets the engine\'s detail; the engine reads the knowledge views, the knowledge service the connectors alone', async () => {
    const kit = await openTestRecords({ postgres });
    try {
      const hub = await assembleHub(configOf(kit), kit, { requireOsIsolation: false, log: () => {} });
      assert.equal(hub.deps.runsDetail, hub.runs, 'ServerDeps.runsDetail is the engine');
      assert.equal(hub.deps.runs, hub.runs);
      const view = 'knowledge:facets:nothing:b-1?kind=case&by=module';
      assert.equal(await hub.runsExternal.accepts(view), true, 'the engine accepts a knowledge view');
      assert.equal(await hub.external.accepts(view), false, 'the connectors (the knowledge service\'s reader) do not');
      const admin = (await kit.principals.bootstrapAdmin('管理员')).user;
      const read = await hub.runsExternal.read(view, { principal: { id: admin.id, name: admin.name, role: admin.role }, purpose: 'test' });
      assert.equal(read.ok, false, 'no such product: refused by the views with their reason');
      assert.equal(await hub.runsExternal.accepts('agile:mindmap:d1'), await hub.external.accepts('agile:mindmap:d1'), 'other ids go to the connectors');
    } finally {
      await kit.close();
    }
  });

  test('the engine notes a neutral answer\'s reason on the call itself, once, through the assembled service', async () => {
    const kit = await openTestRecords({ postgres });
    try {
      const log: string[] = [];
      const hub = await assembleHub(configOf(kit), kit, { requireOsIsolation: false, log: (line) => log.push(line) });
      const admin = (await kit.principals.bootstrapAdmin('管理员')).user;
      const notes: string[] = [];
      const answer = await hub.runs.startRun({ id: admin.id, name: admin.name, role: admin.role }, { pack: 'demo-none', inputs: {} }, { traceId: '4bf92f3577b34da6a3ce929d0e0e4736', sessionId: null, adminNote: (reason) => notes.push(reason) });
      assert.equal(answer.errors[0]?.code, 'SOURCE_UNAVAILABLE');
      assert.equal(notes.filter((note) => note.startsWith('start_run: pack demo-none is unknown')).length, 1, `once: ${JSON.stringify(notes)}`);
      assert.ok(log.some((line) => line.includes('start_run: pack demo-none is unknown')), 'and the operator log has it');
    } finally {
      await kit.close();
    }
  });
});

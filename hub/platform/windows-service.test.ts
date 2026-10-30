// The Windows service adapter: its lifecycle contract over a scripted Scm, the host's main loop over a scripted dispatcher
// and server, and the pieces they are made of. The tests marked as runner checks create a real service and a real native
// thread; they run only on an ephemeral Windows GitHub runner (administrator), which is also the only evidence for them.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { copyFile, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { ServiceDefinition } from './launchd.ts';
import { createWindowsScm, loadKoffi } from './windows-scm.ts';
import {
  acceptServiceStop, ERROR_CALL_NOT_IMPLEMENTED, ERROR_SERVICE_SPECIFIC_ERROR, NO_ERROR, parseServiceDefinition, quoteWindowsArgument,
  renderServiceDefinition, RESTART_DELAY_MS, runServiceHost, runTaskHost, SERVICE_ACCEPT_PRESHUTDOWN, SERVICE_ACCEPT_STOP,
  SERVICE_CONTROL_INTERROGATE, SERVICE_CONTROL_PRESHUTDOWN, SERVICE_CONTROL_STOP, SERVICE_RUNNING, SERVICE_START_PENDING,
  SERVICE_STOP_PENDING, SERVICE_STOPPED, serviceAccount, serviceCommandLine, serviceSid, splitWindowsCommandLine, STOP_MESSAGE,
  windowsServiceAgent, windowsServiceEnvironment,
  type Scm, type ScmServiceConfig, type ScmServiceState, type ServerProcess, type ServiceDispatcher, type ServiceStatusReport,
} from './windows-service.ts';

const RUNNER = process.platform === 'win32' && process.env.GITHUB_ACTIONS === 'true';
const RUNNER_ONLY = RUNNER ? false : 'needs an ephemeral Windows GitHub runner with administrator rights: it creates and deletes a real service';
const RUNNER_THREAD = RUNNER ? false : 'needs a Windows GitHub runner: it loads koffi and starts a native Windows thread';
const LABEL = 'io.github.circle-platforms.circle-hub';

test('Windows argv quoting round-trips through the C runtime rule, spaces, quotes and trailing backslashes included', () => {
  const slash = '\\';
  for (const value of ['', 'plain', 'a b', 'a"b', `a${slash}`, `C:${slash}Program Files${slash}node${slash}node.exe`, `x${slash}${slash}"y`, '中文 路径']) {
    assert.deepEqual(splitWindowsCommandLine(quoteWindowsArgument(value)), [value]);
  }
  assert.throws(() => quoteWindowsArgument('a\0b'), /空字符/);
  const line = serviceCommandLine('C:\\Program Files\\nodejs\\node.exe', 'C:\\hub\\releases\\abc\\hub\\platform\\windows-service-host.ts', 'C:\\hub\\service\\x.json');
  assert.equal(line, '"C:\\Program Files\\nodejs\\node.exe" "C:\\hub\\releases\\abc\\hub\\platform\\windows-service-host.ts" "C:\\hub\\service\\x.json"');
  assert.deepEqual(splitWindowsCommandLine(line).at(-1), 'C:\\hub\\service\\x.json');
  for (const bad of ['node.exe', '\\\\server\\share\\node.exe', 'C:\\a\nb']) assert.throws(() => serviceCommandLine(bad, 'C:\\h.ts', 'C:\\d.json'), /本机绝对路径/);
});

test('the service runs as its virtual account by default, never as LocalSystem and never with a password', () => {
  assert.equal(serviceAccount(LABEL), `NT SERVICE\\${LABEL}`);
  assert.equal(serviceAccount(LABEL, 'NT AUTHORITY\\LocalService'), 'NT AUTHORITY\\LocalService');
  assert.equal(serviceAccount(LABEL, 'SYNTHETIC\\hub-msa$'), 'SYNTHETIC\\hub-msa$');
  for (const account of ['LocalSystem', '.\\LocalSystem', 'NT AUTHORITY\\SYSTEM', 'NT AUTHORITY\\NetworkService', 'SYNTHETIC\\operator', '.\\operator', 'NT SERVICE\\other']) {
    assert.throws(() => serviceAccount(LABEL, account), /不受支持/, account);
  }
  // `sc showsid TrustedInstaller` prints this well-known service SID.
  assert.equal(serviceSid('TrustedInstaller'), 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464');
  assert.equal(serviceSid('trustedinstaller'), serviceSid('TrustedInstaller'));
});

const definition = (directory: string, overrides: Partial<ServiceDefinition> = {}): ServiceDefinition => ({
  label: LABEL,
  programArguments: ['/opt/synthetic/node', '/opt/synthetic/current/bin/circle-hub', 'serve'],
  workingDirectory: '/opt/synthetic/current',
  environment: { CIRCLE_HUB_PORT: '7420', CIRCLE_HUB_DATA_DIR: directory, PATH: '/usr/bin:/bin', HOME: '/srv/synthetic-home' },
  standardOutPath: join(directory, 'hub.out.log'),
  standardErrorPath: join(directory, 'hub.err.log'),
  ...overrides,
});

test('the definition file holds the ServiceDefinition under its format and refuses anything else', () => {
  const value = definition('/srv/hub');
  const text = renderServiceDefinition(value);
  assert.equal(JSON.parse(text).format, 'circle-hub-service@1');
  assert.deepEqual(Object.keys(JSON.parse(text).environment), ['CIRCLE_HUB_DATA_DIR', 'CIRCLE_HUB_PORT', 'HOME', 'PATH']);
  assert.deepEqual(parseServiceDefinition(text), { ...value, environment: { CIRCLE_HUB_DATA_DIR: '/srv/hub', CIRCLE_HUB_PORT: '7420', HOME: '/srv/synthetic-home', PATH: '/usr/bin:/bin' } });
  assert.throws(() => parseServiceDefinition('{'), /不是有效的 JSON/);
  assert.throws(() => parseServiceDefinition(JSON.stringify({ ...value, format: 'circle-hub-service@0' })), /circle-hub-service@1/);
  assert.throws(() => renderServiceDefinition(definition('/srv/hub', { workingDirectory: 'relative' })), /绝对路径/);
  assert.throws(() => renderServiceDefinition(definition('/srv/hub', { environment: { 'BAD-NAME': 'x' } })), /环境变量/);
  assert.throws(() => renderServiceDefinition(definition('/srv/hub', { label: 'bad label' })), /服务标签/);
});

test('the server child gets the definition environment with the Windows system locations and nothing else of the host', () => {
  const env = windowsServiceEnvironment({ CIRCLE_HUB_PORT: '7420', PATH: '/usr/bin:/bin', HOME: '/srv/synthetic-home' }, {
    SystemRoot: 'C:\\Windows', Path: 'D:\\synthetic-tools', TEMP: 'C:\\Windows\\ServiceProfiles\\x\\Temp', USERPROFILE: 'C:\\Windows\\ServiceProfiles\\x',
    PGPASSWORD: 'synthetic-secret', GITHUB_TOKEN: 'synthetic-secret', CIRCLE_HUB_TOKEN: 'synthetic-secret',
  });
  assert.deepEqual(env, {
    CIRCLE_HUB_PORT: '7420', HOME: '/srv/synthetic-home', SystemRoot: 'C:\\Windows', windir: 'C:\\Windows',
    PATH: 'C:\\Windows\\System32;C:\\Windows;C:\\Windows\\System32\\Wbem', TEMP: 'C:\\Windows\\ServiceProfiles\\x\\Temp', USERPROFILE: 'C:\\Windows\\ServiceProfiles\\x',
  });
  assert.throws(() => windowsServiceEnvironment({}, { PATH: 'C:\\Windows' }), /SystemRoot/);
});

/** A scripted SCM: services by name; a stop goes through STOP_PENDING to STOPPED at the next query unless it hangs. */
function fakeScm(options: { hang?: boolean } = {}) {
  const services = new Map<string, ScmServiceState & { config?: ScmServiceConfig }>();
  const calls: string[] = [];
  const scm: Scm = {
    async query(name) {
      calls.push('query');
      const service = services.get(name);
      if (service === undefined) return undefined;
      if (service.state === SERVICE_STOP_PENDING && !options.hang) service.state = SERVICE_STOPPED;
      const { config: _config, ...state } = service;
      return { ...state };
    },
    async create(config) {
      calls.push('create');
      services.set(config.name, { state: SERVICE_STOPPED, win32ExitCode: 0, serviceExitCode: 0, commandLine: config.commandLine, account: config.account, config });
    },
    async update(config) {
      calls.push('update');
      Object.assign(services.get(config.name)!, { commandLine: config.commandLine, account: config.account, config });
    },
    async start(name) {
      calls.push('start');
      Object.assign(services.get(name)!, { state: SERVICE_RUNNING, pid: 4242, win32ExitCode: 0, serviceExitCode: 0 });
    },
    async stop(name) {
      calls.push('stop');
      const service = services.get(name)!;
      service.state = SERVICE_STOP_PENDING;
      delete service.pid;
    },
    async remove(name) {
      calls.push('remove');
      services.delete(name);
    },
  };
  return { scm, services, calls, mutations: () => calls.filter((call) => call !== 'query') };
}

async function serviceDirectory(t: { after(fn: () => Promise<void>): void }): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'hub-winsvc-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

const agentFor = (directory: string, scm: Scm, extra: Partial<Parameters<typeof windowsServiceAgent>[0]> = {}) => windowsServiceAgent({
  label: LABEL, directory, hostScript: '/opt/synthetic/current/hub/platform/windows-service-host.ts', scm, sleep: async () => {}, ...extra,
});

test('install writes the definition, registers the service with its fixed command line and account, and starts it', async (t) => {
  const directory = await serviceDirectory(t);
  const { scm, services, mutations } = fakeScm();
  const agent = agentFor(directory, scm);
  assert.equal(agent.plist, join(directory, `${LABEL}.json`));
  assert.equal(agent.service, LABEL);
  assert.deepEqual(await agent.status(), { plist: agent.plist, installed: false, loaded: false, running: false });
  await agent.install(definition(directory));
  assert.deepEqual(parseServiceDefinition(await readFile(agent.plist, 'utf8')), parseServiceDefinition(renderServiceDefinition(definition(directory))));
  assert.deepEqual(services.get(LABEL)!.config, {
    name: LABEL, displayName: 'Circle Hub', description: 'Circle Hub（circle-hub serve），只监听本机',
    commandLine: serviceCommandLine('/opt/synthetic/node', '/opt/synthetic/current/hub/platform/windows-service-host.ts', agent.plist),
    account: `NT SERVICE\\${LABEL}`, restartDelayMs: 10_000, preshutdownTimeoutMs: 60_000,
  });
  assert.deepEqual(mutations(), ['create', 'start']);
  assert.deepEqual(await agent.status(), { plist: agent.plist, installed: true, loaded: true, running: true, pid: 4242 });
  // Installing over a running service stops it, waits for SERVICE_STOPPED, updates it in place and starts it again.
  await agent.install(definition(directory, { programArguments: ['/opt/synthetic/node24', '/opt/synthetic/current/bin/circle-hub', 'serve'] }));
  assert.deepEqual(mutations(), ['create', 'start', 'stop', 'update', 'start']);
  assert.match(services.get(LABEL)!.commandLine, /node24/);
  await assert.rejects(agent.install({ ...definition(directory), label: 'another-label' }), /标签不一致/);
  assert.throws(() => agentFor(directory, scm, { account: 'LocalSystem' }), /不受支持/);
});

test('start, stop and uninstall act only when there is something to do, and report what they did', async (t) => {
  const directory = await serviceDirectory(t);
  const { scm, services, mutations } = fakeScm();
  const agent = agentFor(directory, scm);
  await assert.rejects(agent.start(), /服务还没安装/);
  assert.equal(await agent.stop(), false);
  assert.equal(await agent.uninstall(), false);
  await agent.install(definition(directory));
  assert.equal(await agent.start(), false);
  assert.equal(await agent.stop(), true);
  assert.deepEqual(await agent.status(), { plist: agent.plist, installed: true, loaded: false, running: false });
  assert.equal(await agent.stop(), false);
  assert.equal(await agent.start(), true);
  // A server that ended by itself: the SCM holds ERROR_SERVICE_SPECIFIC_ERROR and the server's code, shown as lastExit.
  Object.assign(services.get(LABEL)!, { state: SERVICE_STOPPED, win32ExitCode: ERROR_SERVICE_SPECIFIC_ERROR, serviceExitCode: 3, pid: 4242 });
  assert.deepEqual(await agent.status(), { plist: agent.plist, installed: true, loaded: false, running: false, lastExit: '3' });
  assert.equal(await agent.uninstall(), true);
  await assert.rejects(stat(agent.plist), { code: 'ENOENT' });
  assert.equal(services.has(LABEL), false);
  assert.deepEqual(mutations(), ['create', 'start', 'stop', 'start', 'remove']);
  // A definition left behind without its service cannot be started; install registers it again.
  await writeFile(agent.plist, renderServiceDefinition(definition(directory)));
  await assert.rejects(agent.start(), /服务控制管理器里没有这个服务/);
});

test('a stop that does not reach SERVICE_STOPPED in time is an error, not a stopped service', async (t) => {
  const directory = await serviceDirectory(t);
  const { scm } = fakeScm({ hang: true });
  let clock = 0;
  const agent = agentFor(directory, scm, { stopTimeoutMs: 1_000, now: () => clock, sleep: async (ms) => { clock += ms; } });
  await agent.install(definition(directory));
  await assert.rejects(agent.stop(), /没有在 1 秒内停下/);
  assert.equal((await agent.status()).loaded, true);
});

test('a same-named service that does not point at this definition is never stopped, replaced or deleted', async (t) => {
  const directory = await serviceDirectory(t);
  const { scm, services, mutations } = fakeScm();
  services.set(LABEL, { state: SERVICE_RUNNING, pid: 99, win32ExitCode: 0, serviceExitCode: 0, account: 'LocalSystem', commandLine: '"C:\\other\\node.exe" "C:\\other\\host.ts" "C:\\other\\definition.json"' });
  const agent = agentFor(directory, scm);
  await writeFile(agent.plist, renderServiceDefinition(definition(directory)));
  for (const action of [() => agent.install(definition(directory)), () => agent.stop(), () => agent.uninstall(), () => agent.start()]) {
    await assert.rejects(action(), /不属于这个部署/);
  }
  assert.deepEqual(mutations(), []);
  assert.equal(services.get(LABEL)!.state, SERVICE_RUNNING);
});

/** A scripted dispatcher: main runs at once; the dispatcher returns once SERVICE_STOPPED is reported. */
function fakeDispatcher() {
  const reports: ServiceStatusReport[] = [];
  let control: ((code: number) => number) | undefined;
  const dispatcher: ServiceDispatcher = {
    run(name, handlers) {
      assert.equal(name, LABEL);
      control = handlers.control;
      return new Promise<void>((resolve) => {
        handlers.main((status) => {
          reports.push(status);
          if (status.state === SERVICE_STOPPED) resolve();
        });
      });
    },
  };
  return { dispatcher, reports, control: (code: number) => control!(code), states: () => reports.map((report) => report.state) };
}

function fakeServer() {
  const events: string[] = [];
  let exit!: (code: number | null) => void;
  const server: ServerProcess = {
    pid: 7,
    exited: new Promise((resolve) => { exit = resolve; }),
    requestStop() { events.push('requestStop'); },
    kill() { events.push('kill'); exit(1); },
  };
  return { server, events, exit: (code: number | null) => exit(code) };
}

test('the host reports START_PENDING then RUNNING, and a stop asks the server first and reports STOPPED when it exits', async () => {
  const { dispatcher, reports, control, states } = fakeDispatcher();
  const { server, events, exit } = fakeServer();
  const timers: { fn: () => void; ms: number }[] = [];
  const host = runServiceHost(dispatcher, {
    definition: definition('/srv/hub'), spawn: () => server, setTimer: (fn, ms) => timers.push({ fn, ms }), clearTimer: () => events.push('clear'),
  });
  assert.deepEqual(states(), [SERVICE_START_PENDING, SERVICE_RUNNING]);
  assert.equal(reports[1]!.controlsAccepted, SERVICE_ACCEPT_STOP | SERVICE_ACCEPT_PRESHUTDOWN);
  assert.equal(control(SERVICE_CONTROL_INTERROGATE), NO_ERROR);
  assert.equal(control(0x80), ERROR_CALL_NOT_IMPLEMENTED);
  assert.equal(control(SERVICE_CONTROL_STOP), NO_ERROR);
  assert.equal(control(SERVICE_CONTROL_STOP), NO_ERROR);
  assert.deepEqual(events, ['requestStop']);
  assert.deepEqual(reports[2], { state: SERVICE_STOP_PENDING, controlsAccepted: 0, win32ExitCode: NO_ERROR, serviceExitCode: 0, checkPoint: 1, waitHintMs: 35_000 });
  assert.deepEqual(timers.map((timer) => timer.ms), [30_000]);
  exit(0);
  assert.equal(await host, 0);
  assert.deepEqual(states(), [SERVICE_START_PENDING, SERVICE_RUNNING, SERVICE_STOP_PENDING, SERVICE_STOPPED]);
  assert.equal(reports[3]!.win32ExitCode, NO_ERROR);
  assert.deepEqual(events, ['requestStop', 'clear']);
});

test('a server that ignores the stop is ended by its Job after the grace time; PRESHUTDOWN stops like STOP', async () => {
  const { dispatcher, control, states, reports } = fakeDispatcher();
  const { server, events } = fakeServer();
  const timers: (() => void)[] = [];
  const host = runServiceHost(dispatcher, { definition: definition('/srv/hub'), spawn: () => server, setTimer: (fn) => timers.push(fn), clearTimer: () => {} });
  assert.equal(control(SERVICE_CONTROL_PRESHUTDOWN), NO_ERROR);
  timers[0]!();
  assert.equal(await host, 0);
  assert.deepEqual(events, ['requestStop', 'kill']);
  assert.deepEqual(states().at(-1), SERVICE_STOPPED);
  assert.equal(reports.at(-1)!.win32ExitCode, NO_ERROR);
});

test('a server that exits by itself is a service failure with its exit code, which the failure actions restart', async () => {
  for (const [code, reported] of [[3, 3], [0, 1], [null, 1]] as const) {
    const { dispatcher, reports } = fakeDispatcher();
    const { server, exit } = fakeServer();
    const host = runServiceHost(dispatcher, { definition: definition('/srv/hub'), spawn: () => server, setTimer: () => 0, clearTimer: () => {} });
    exit(code);
    assert.equal(await host, 1);
    assert.deepEqual(reports.at(-1), { state: SERVICE_STOPPED, controlsAccepted: 0, win32ExitCode: ERROR_SERVICE_SPECIFIC_ERROR, serviceExitCode: reported, checkPoint: 0, waitHintMs: 0 });
  }
  const { dispatcher, reports } = fakeDispatcher();
  const lines: string[] = [];
  const host = runServiceHost(dispatcher, { definition: definition('/srv/hub'), spawn: () => { throw new Error('synthetic spawn failure'); }, log: (line) => lines.push(line) });
  assert.equal(await host, 1);
  assert.deepEqual(reports.map((report) => [report.state, report.win32ExitCode, report.serviceExitCode]), [[SERVICE_START_PENDING, 0, 0], [SERVICE_STOPPED, ERROR_SERVICE_SPECIFIC_ERROR, 1]]);
  assert.deepEqual(lines, ['windows-service: server-start-failed']);
});

test('the task host starts the server again after every exit, RESTART_DELAY_MS later', async () => {
  const sleeps: number[] = [];
  let spawned = 0;
  const lines: string[] = [];
  await runTaskHost({
    definition: definition('/srv/hub'), rounds: 3, sleep: async (ms) => { sleeps.push(ms); }, log: (line) => lines.push(line),
    spawn: () => {
      spawned++;
      if (spawned === 2) throw new Error('synthetic spawn failure');
      return { pid: spawned, exited: Promise.resolve(spawned), requestStop() {}, kill() {} };
    },
  });
  assert.equal(spawned, 3);
  assert.deepEqual(sleeps, [RESTART_DELAY_MS, RESTART_DELAY_MS, RESTART_DELAY_MS]);
  assert.deepEqual(lines, ['windows-task: server-exited 1', 'windows-task: server-start-failed', 'windows-task: server-exited none', 'windows-task: server-exited 3']);
});

test('under the host, the stop message and a lost host reach the SIGTERM listeners once, and the channel keeps nothing alive', () => {
  const target = new EventEmitter() as EventEmitter & { channel: { unref(): void } };
  let unrefs = 0;
  target.channel = { unref() { unrefs++; } };
  const signals: string[] = [];
  target.on('SIGTERM', () => signals.push('SIGTERM'));
  acceptServiceStop(target as unknown as Pick<NodeJS.Process, 'on' | 'emit' | 'channel'>);
  assert.equal(unrefs, 1);
  target.emit('message', 'something else');
  target.emit('message', { type: STOP_MESSAGE });
  assert.deepEqual(signals, []);
  target.emit('message', STOP_MESSAGE);
  target.emit('message', STOP_MESSAGE);
  target.emit('disconnect');
  assert.deepEqual(signals, ['SIGTERM']);
  const lost = new EventEmitter() as EventEmitter & { channel: { unref(): void } };
  lost.channel = { unref() {} };
  const lostSignals: string[] = [];
  lost.on('SIGTERM', () => lostSignals.push('SIGTERM'));
  acceptServiceStop(lost as unknown as Pick<NodeJS.Process, 'on' | 'emit' | 'channel'>);
  lost.emit('disconnect');
  assert.deepEqual(lostSignals, ['SIGTERM']);
});

test('runner check: koffi runs a callback from a thread Windows creates on the JS main thread and returns its result', { skip: RUNNER_THREAD, timeout: 30_000 }, async () => {
  const koffi = loadKoffi() as unknown as typeof import('koffi');
  const kernel = koffi.load('kernel32.dll');
  const ThreadProc = koffi.proto('uint32_t __stdcall CircleHubTestThreadProc(void *parameter)');
  const createThread = kernel.func('void * __stdcall CreateThread(void *attributes, uintptr_t stack, void *start, void *parameter, uint32_t flags, _Out_ void *id)');
  const wait = kernel.func('uint32_t __stdcall WaitForSingleObject(void *handle, uint32_t milliseconds)');
  const exitCode = kernel.func('int __stdcall GetExitCodeThread(void *thread, _Out_ void *code)');
  const threadId = kernel.func('uint32_t __stdcall GetCurrentThreadId()');
  const close = kernel.func('int __stdcall CloseHandle(void *handle)');
  const main = Number(threadId());
  let seen: number | undefined;
  const callback = koffi.register(() => { seen = Number(threadId()); return 42; }, koffi.pointer(ThreadProc));
  try {
    const id = Buffer.alloc(4);
    const thread = createThread(null, 0, callback, null, 0, id);
    assert.ok(typeof thread === 'bigint' && thread !== 0n);
    // The main thread must keep its event loop running for the callback: wait on a koffi worker thread.
    const result = await new Promise<number>((resolve, reject) => wait.async(thread, 10_000, (error: unknown, value: number) => (error ? reject(error) : resolve(value))));
    assert.equal(result, 0);
    const code = Buffer.alloc(4);
    assert.ok(exitCode(thread, code));
    assert.equal(code.readUInt32LE(), 42);
    assert.equal(seen, main);
    assert.notEqual(id.readUInt32LE(), main);
    close(thread);
  } finally {
    koffi.unregister(callback);
  }
});

test('runner check: a real service under its virtual account starts the server child, stops it gracefully and is deleted', { skip: RUNNER_ONLY, timeout: 180_000 }, async (t) => {
  const label = `circle-hub-synthetic-${process.pid}`;
  const sid = serviceSid(label);
  const directory = await mkdtemp(join(tmpdir(), 'hub-winsvc-runner-'));
  const repository = fileURLToPath(new URL('../../', import.meta.url));
  const node = join(directory, 'node.exe');
  await copyFile(process.execPath, node);
  // The virtual account may read the checkout (host script and koffi) and write only this directory.
  execFileSync('icacls.exe', [directory, '/grant', `*${sid}:(OI)(CI)M`], { encoding: 'utf8' });
  execFileSync('icacls.exe', [repository, '/grant', `*${sid}:(OI)(CI)RX`], { encoding: 'utf8' });
  const scm = createWindowsScm(loadKoffi());
  const agent = windowsServiceAgent({ label, directory, hostScript: join(repository, 'hub', 'platform', 'windows-service-host.ts'), scm });
  t.after(async () => {
    await agent.uninstall().catch(() => false);
    execFileSync('icacls.exe', [repository, '/remove:g', `*${sid}`], { encoding: 'utf8' });
    await rm(directory, { recursive: true, force: true, maxRetries: 5 });
  });
  // A synthetic server, not the Hub: it marks its start, and its stop when the host's message arrives.
  const server = join(directory, 'server.mjs');
  await writeFile(server, `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(join(directory, 'started'))}, String(process.pid));
process.on('message', (m) => { if (m === ${JSON.stringify(STOP_MESSAGE)}) { writeFileSync(${JSON.stringify(join(directory, 'graceful'))}, 'yes'); process.exit(0); } });
setInterval(() => {}, 1000);
`);
  await agent.install({
    label, programArguments: [node, server], workingDirectory: directory, environment: { CIRCLE_HUB_SYNTHETIC: '1' },
    standardOutPath: join(directory, 'out.log'), standardErrorPath: join(directory, 'err.log'),
  });
  const until = async (check: () => Promise<boolean>, what: string) => {
    const deadline = Date.now() + 60_000;
    while (!(await check())) {
      if (Date.now() > deadline) assert.fail(`${what}; host log: ${await readFile(join(directory, 'err.log'), 'utf8').catch(() => 'none')}`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  };
  await until(async () => (await agent.status()).running, 'the service reached SERVICE_RUNNING');
  await until(() => stat(join(directory, 'started')).then(() => true, () => false), 'the server child started');
  const state = await scm.query(label);
  assert.equal(state?.account, `NT SERVICE\\${label}`);
  assert.ok((state?.pid ?? 0) > 0);
  assert.equal(await agent.stop(), true);
  assert.equal(await readFile(join(directory, 'graceful'), 'utf8'), 'yes');
  assert.deepEqual(await agent.status(), { plist: agent.plist, installed: true, loaded: false, running: false });
  assert.equal(await agent.start(), true);
  await until(async () => (await agent.status()).running, 'the service ran again');
  assert.equal(await agent.uninstall(), true);
  await until(async () => (await scm.query(label)) === undefined, 'the service was deleted');
});

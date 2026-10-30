// The native layer of the Windows service: struct encoders with the documented x64/ARM64 offsets, and the advapi32 call
// flow against a scripted koffi with a fake native heap (no addon is loaded). That the real SCM accepts these calls is a
// runner check (windows-service.test.ts); nothing here claims Windows behaviour.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createWindowsDispatcher, createWindowsScm, decodeServiceConfig, decodeServiceStatusProcess, encodeFailureActions, encodeServiceStatus,
  failureActionArray, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK, serverJobLimits, stringAt, type KoffiLike,
} from './windows-scm.ts';
import { SERVICE_ACCEPT_STOP, SERVICE_CONTROL_STOP, SERVICE_RUNNING, SERVICE_STOPPED, type ScmServiceConfig, type ServiceStatusReport } from './windows-service.ts';

test('SERVICE_STATUS and SERVICE_STATUS_PROCESS use the documented offsets', () => {
  const status = encodeServiceStatus({ state: SERVICE_RUNNING, controlsAccepted: SERVICE_ACCEPT_STOP, win32ExitCode: 1066, serviceExitCode: 3, checkPoint: 2, waitHintMs: 5000 });
  assert.equal(status.length, 28);
  assert.deepEqual([0, 4, 8, 12, 16, 20, 24].map((offset) => status.readUInt32LE(offset)), [0x10, 4, 1, 1066, 3, 2, 5000]);
  assert.throws(() => encodeServiceStatus({ state: -1, controlsAccepted: 0, win32ExitCode: 0, serviceExitCode: 0, checkPoint: 0, waitHintMs: 0 }), RangeError);
  const process = Buffer.alloc(36);
  for (const [offset, value] of [[4, 1], [12, 1066], [16, 7], [28, 4242]] as const) process.writeUInt32LE(value, offset);
  assert.deepEqual(decodeServiceStatusProcess(process), { state: 1, win32ExitCode: 1066, serviceExitCode: 7, pid: 4242 });
  assert.throws(() => decodeServiceStatusProcess(Buffer.alloc(28)), RangeError);
});

test('QUERY_SERVICE_CONFIGW strings are read at their absolute addresses inside the copied block only', () => {
  const base = 0x7f0000000000n;
  const block = Buffer.alloc(256);
  const path = Buffer.from('"C:\\n.exe" "C:\\h.ts" "C:\\d.json"\0', 'utf16le');
  const account = Buffer.from('NT SERVICE\\x\0', 'utf16le');
  path.copy(block, 64);
  account.copy(block, 64 + path.length);
  block.writeBigUInt64LE(base + 64n, 16);
  block.writeBigUInt64LE(base + BigInt(64 + path.length), 48);
  assert.deepEqual(decodeServiceConfig(block, base), { commandLine: '"C:\\n.exe" "C:\\h.ts" "C:\\d.json"', account: 'NT SERVICE\\x' });
  assert.equal(stringAt(block, base, 0n), undefined);
  for (const pointer of [base - 2n, base + 256n, base + 65n]) assert.throws(() => stringAt(block, base, pointer), RangeError);
  const unterminated = Buffer.alloc(8, 0x41);
  assert.throws(() => stringAt(unterminated, base, base), /没有结尾/);
});

test('failure actions restart three times after the delay, and the server Job dies with the host without holding PostgreSQL', () => {
  const actions = failureActionArray(10_000);
  assert.equal(actions.length, 24);
  for (let index = 0; index < 3; index++) assert.deepEqual([actions.readInt32LE(index * 8), actions.readUInt32LE(index * 8 + 4)], [1, 10_000]);
  assert.throws(() => failureActionArray(10), RangeError);
  const info = encodeFailureActions(0x1234n, 3, 86_400);
  assert.equal(info.length, 40);
  assert.deepEqual([info.readUInt32LE(0), info.readBigUInt64LE(8), info.readBigUInt64LE(16), info.readUInt32LE(24), info.readBigUInt64LE(32)], [86_400, 0n, 0n, 3, 0x1234n]);
  const job = serverJobLimits();
  assert.equal(job.length, 144);
  assert.equal(job.readUInt32LE(16), JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK);
  assert.equal(job.readUInt32LE(16) & 0x800, 0, 'no BREAKAWAY_OK: the server itself cannot leave the Job');
});

/** A scripted koffi: kernel32 and advapi32 by function name over a fake heap, and an SCM with named services. */
function scriptedKoffi(options: { version?: string; errors?: Record<string, number> } = {}) {
  const calls: { name: string; args: unknown[] }[] = [];
  const heap = new Map<bigint, Buffer>();
  const callbacks = new Map<bigint, (...args: never[]) => unknown>();
  const services = new Map<string, { state: number; commandLine: string; account: string }>();
  const statuses: number[][] = [];
  let next = 0x10000n;
  let lastError = 0;
  let dispatch: ((...args: unknown[]) => void) | undefined;
  const block = (address: bigint): [Buffer, number] => {
    for (const [base, data] of heap) if (address >= base && address < base + BigInt(data.length)) return [data, Number(address - base)];
    throw new Error(`fake heap: no block at ${address}`);
  };
  const utf16 = (value: unknown): string | null => {
    if (value === null) return null;
    if (Buffer.isBuffer(value)) return value.toString('utf16le').replace(/\0.*$/s, '');
    const [data, offset] = block(value as bigint);
    let end = offset;
    while (data.readUInt16LE(end) !== 0) end += 2;
    return data.toString('utf16le', offset, end);
  };
  const fail = (name: string, otherwise: unknown) => {
    const code = options.errors?.[name];
    if (code === undefined) return otherwise;
    lastError = code;
    return typeof otherwise === 'bigint' ? 0n : 0;
  };
  const implementations: Record<string, (...args: unknown[]) => unknown> = {
    GetSystemDirectoryW: (buffer) => { Buffer.from('C:\\Windows\\System32', 'utf16le').copy(buffer as Buffer); return 19; },
    GetLastError: () => lastError,
    GetProcessHeap: () => 1n,
    HeapAlloc: (_heap, _flags, size) => { const address = (next += 0x10000n); heap.set(address, Buffer.alloc(Number(size))); return address; },
    HeapFree: (_heap, _flags, address) => Number(heap.delete(address as bigint)),
    RtlMoveMemory: (target, source, size) => {
      const length = Number(size);
      const from = Buffer.isBuffer(source) ? source.subarray(0, length) : (() => { const [data, offset] = block(source as bigint); return data.subarray(offset, offset + length); })();
      if (Buffer.isBuffer(target)) from.copy(target);
      else { const [data, offset] = block(target as bigint); from.copy(data, offset); }
    },
    OpenSCManagerW: () => fail('OpenSCManagerW', 0x100n),
    OpenServiceW: (_manager, name) => {
      if (!services.has(utf16(name)!)) { lastError = 1060; return 0n; }
      return fail('OpenServiceW', 0x200n);
    },
    CreateServiceW: (...args) => {
      services.set(utf16(args[1])!, { state: SERVICE_STOPPED, commandLine: utf16(args[7])!, account: utf16(args[11])! });
      return fail('CreateServiceW', 0x200n);
    },
    ChangeServiceConfigW: () => fail('ChangeServiceConfigW', 1),
    ChangeServiceConfig2W: () => fail('ChangeServiceConfig2W', 1),
    StartServiceW: () => fail('StartServiceW', 1),
    ControlService: () => fail('ControlService', 1),
    DeleteService: () => fail('DeleteService', 1),
    CloseServiceHandle: () => 1,
    QueryServiceStatusEx: (_service, _level, buffer) => { (buffer as Buffer).writeUInt32LE(SERVICE_RUNNING, 4); (buffer as Buffer).writeUInt32LE(4242, 28); return 1; },
    QueryServiceConfigW: (_service, address, size, needed) => {
      const [name] = [...services.keys()];
      const entry = services.get(name!)!;
      const strings = [Buffer.from(`${entry.commandLine}\0`, 'utf16le'), Buffer.from(`${entry.account}\0`, 'utf16le')];
      const required = 64 + strings[0]!.length + strings[1]!.length;
      (needed as Buffer).writeUInt32LE(required);
      if (Number(size) < required) { lastError = 122; return 0; }
      const [data, offset] = block(address as bigint);
      strings[0]!.copy(data, offset + 64);
      strings[1]!.copy(data, offset + 64 + strings[0]!.length);
      data.writeBigUInt64LE((address as bigint) + 64n, offset + 16);
      data.writeBigUInt64LE((address as bigint) + BigInt(64 + strings[0]!.length), offset + 48);
      return 1;
    },
    RegisterServiceCtrlHandlerExW: () => 0x300n,
    SetServiceStatus: (_handle, status) => { const data = status as Buffer; statuses.push([0, 4, 8, 12, 16].map((offset) => data.readUInt32LE(offset))); return 1; },
    StartServiceCtrlDispatcherW: () => { throw new Error('the dispatcher must be called through its async member'); },
  };
  const koffi: KoffiLike = {
    version: options.version ?? '3.3.3',
    load(library) {
      calls.push({ name: `load ${library}`, args: [] });
      return {
        func(declaration) {
          const name = /__stdcall (\w+)\(/.exec(declaration)![1]!;
          const implementation = implementations[name];
          if (implementation === undefined) throw new Error(`fake koffi: ${name} is not scripted`);
          const fn = ((...args: unknown[]) => { calls.push({ name, args }); return implementation(...args); }) as ((...args: unknown[]) => unknown) & { async?: (...args: unknown[]) => void };
          if (name === 'StartServiceCtrlDispatcherW') fn.async = (...args: unknown[]) => { calls.push({ name, args }); dispatch?.(...args); };
          return fn;
        },
      };
    },
    proto: (declaration) => declaration,
    pointer: (type) => type,
    register(callback) { const address = (next += 0x10000n); callbacks.set(address, callback); return address; },
    unregister(address) { callbacks.delete(address); },
  };
  return {
    koffi, calls, heap, services, statuses, callbacks, named: (name: string) => calls.filter((call) => call.name === name),
    onDispatch(handler: (...args: unknown[]) => void) { dispatch = handler; },
    setLastError(code: number) { lastError = code; },
    block, utf16,
  };
}

const CONFIG: ScmServiceConfig = {
  name: 'synthetic-hub', displayName: 'Circle Hub', description: 'synthetic description', account: 'NT SERVICE\\synthetic-hub',
  commandLine: '"C:\\node\\node.exe" "C:\\release\\hub\\platform\\windows-service-host.ts" "C:\\service\\synthetic-hub.json"', restartDelayMs: 10_000, preshutdownTimeoutMs: 60_000,
};

test('an unexpected koffi version is refused before any DLL loads', () => {
  for (const version of ['3.3.2', '3.3.4', '']) {
    const fake = scriptedKoffi({ version });
    assert.throws(() => createWindowsScm(fake.koffi), /koffi 3\.3\.3/);
    assert.throws(() => createWindowsDispatcher(fake.koffi), /koffi 3\.3\.3/);
    assert.deepEqual(fake.calls, []);
  }
});

test('create registers an automatic own-process service without a password and sets its five extra settings', async () => {
  const fake = scriptedKoffi();
  const scm = createWindowsScm(fake.koffi);
  // advapi32 comes from the kernel-reported system directory, never a search path.
  assert.deepEqual(fake.calls.filter((call) => call.name.startsWith('load ')).map((call) => call.name), ['load kernel32.dll', 'load C:\\Windows\\System32\\advapi32.dll']);
  assert.equal(await scm.query('synthetic-hub'), undefined);
  await scm.create(CONFIG);
  const [create] = fake.named('CreateServiceW');
  assert.deepEqual([fake.utf16(create!.args[1]), fake.utf16(create!.args[2]), create!.args[4], create!.args[5], create!.args[6], fake.utf16(create!.args[7]), fake.utf16(create!.args[11]), create!.args[12]],
    ['synthetic-hub', 'Circle Hub', 0x10, 2, 1, CONFIG.commandLine, 'NT SERVICE\\synthetic-hub', null]);
  const levels = fake.named('ChangeServiceConfig2W').map((call) => call.args[1]);
  assert.deepEqual(levels, [1, 2, 4, 5, 7]);
  const [description, failure, flag, sid, preshutdown] = fake.named('ChangeServiceConfig2W').map((call) => call.args[2] as Buffer);
  assert.equal(description!.length, 8);
  assert.equal(failure!.readUInt32LE(24), 3);
  assert.deepEqual([flag!.readUInt32LE(), sid!.readUInt32LE(), preshutdown!.readUInt32LE()], [1, 1, 60_000]);
  // Every native block the settings pointed at is freed again.
  assert.equal(fake.heap.size, 0);
  const state = await scm.query('synthetic-hub');
  assert.deepEqual(state, { state: SERVICE_RUNNING, win32ExitCode: 0, serviceExitCode: 0, pid: 4242, commandLine: CONFIG.commandLine, account: 'NT SERVICE\\synthetic-hub' });
  assert.equal(fake.heap.size, 0);
  // LocalService gets an empty password, as CreateServiceW requires; a managed or virtual account gets none.
  const local = scriptedKoffi();
  await createWindowsScm(local.koffi).create({ ...CONFIG, account: 'NT AUTHORITY\\LocalService' });
  assert.equal(local.utf16(local.named('CreateServiceW')[0]!.args[12]), '');
});

test('races the SCM reports as done are accepted; access denied names the administrator step', async () => {
  const fake = scriptedKoffi({ errors: { StartServiceW: 1056, ControlService: 1062, DeleteService: 1072 } });
  fake.services.set('synthetic-hub', { state: SERVICE_RUNNING, commandLine: CONFIG.commandLine, account: CONFIG.account });
  const scm = createWindowsScm(fake.koffi);
  await scm.start('synthetic-hub');
  await scm.stop('synthetic-hub');
  await scm.remove('synthetic-hub');
  assert.equal(fake.named('ControlService')[0]!.args[1], SERVICE_CONTROL_STOP);
  const denied = scriptedKoffi({ errors: { OpenSCManagerW: 5 } });
  await assert.rejects(createWindowsScm(denied.koffi).create(CONFIG), (error: Error & { hint?: string }) => /OpenSCManagerW（错误 5）/.test(error.message) && /管理员/.test(error.hint ?? ''));
  const missing = scriptedKoffi();
  await assert.rejects(createWindowsScm(missing.koffi).start('synthetic-hub'), /没有服务 synthetic-hub/);
  await assert.rejects(createWindowsScm(missing.koffi).update(CONFIG), /没有服务 synthetic-hub/);
});

test('the dispatcher table names the service and ServiceMain; ServiceMain registers the handler before the first status', async () => {
  const fake = scriptedKoffi();
  const reports: ServiceStatusReport[] = [];
  const controls: number[] = [];
  fake.onDispatch((table, done) => {
    const [entries, offset] = fake.block(table as bigint);
    assert.equal(fake.utf16(entries.readBigUInt64LE(offset)), 'synthetic-hub');
    const main = fake.callbacks.get(entries.readBigUInt64LE(offset + 8))!;
    assert.equal(entries.readBigUInt64LE(offset + 16), 0n, 'the table ends with an empty entry');
    // The SCM calls ServiceMain on its own thread; koffi brings it to the JS thread.
    (main as (argc: number, argv: unknown) => void)(1, null);
    const [register] = fake.named('RegisterServiceCtrlHandlerExW');
    assert.equal(fake.utf16(register!.args[0]), 'synthetic-hub');
    const handler = fake.callbacks.get(register!.args[1] as bigint) as (control: number) => number;
    assert.equal(handler(SERVICE_CONTROL_STOP), 0);
    setImmediate(() => (done as (error: unknown, ok: unknown) => void)(null, 1));
  });
  await createWindowsDispatcher(fake.koffi).run('synthetic-hub', {
    main(report) {
      reports.push({ state: SERVICE_RUNNING, controlsAccepted: SERVICE_ACCEPT_STOP, win32ExitCode: 0, serviceExitCode: 0, checkPoint: 0, waitHintMs: 0 });
      report(reports[0]!);
    },
    control(code) { controls.push(code); return 0; },
  });
  assert.deepEqual(fake.statuses, [[0x10, SERVICE_RUNNING, SERVICE_ACCEPT_STOP, 0, 0]]);
  assert.deepEqual(controls, [SERVICE_CONTROL_STOP]);
  // After the dispatcher returns, both callbacks are unregistered and the table and name are freed.
  assert.equal(fake.callbacks.size, 0);
  assert.equal(fake.heap.size, 0);
});

test('a host that the SCM did not start says so instead of waiting', async () => {
  const fake = scriptedKoffi();
  fake.onDispatch((_table, done) => {
    // Outside the SCM, StartServiceCtrlDispatcherW fails with ERROR_FAILED_SERVICE_CONTROLLER_CONNECT.
    setImmediate(() => { fake.setLastError(1063); (done as (error: unknown, ok: unknown) => void)(null, 0); });
  });
  await assert.rejects(createWindowsDispatcher(fake.koffi).run('synthetic-hub', { main() {}, control: () => 0 }), /只能由服务控制管理器启动/);
  assert.equal(fake.callbacks.size, 0);
  assert.equal(fake.heap.size, 0);
});

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { createSocket } from 'node:dgram';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { attachWindowsJob, createWindowsJobApi, createWindowsRestrictedToken, loadWindowsRestrictedToken, loadWindowsJobApi, quoteWindowsArgument, runWindowsIsolationProbe, windowsEnvironmentBlock, windowsProbeFailure, windowsJobLimits, windowsIsolationFailure, type WindowsJobApi } from './windows.ts';
import { isolatedCommand, osIsolationAvailable, osIsolationFailure } from './isolation.ts';
import { callPackFunction } from './sandbox.ts';

function fake() {
  const calls: string[] = [];
  const api: WindowsJobApi = {
    create: () => { calls.push('create'); return 1n; },
    assign: () => { calls.push('assign'); return true; },
    active: () => { calls.push('active'); return 0; },
    terminate: () => { calls.push('terminate'); },
    close: () => { calls.push('close'); },
  };
  return { api, calls };
}

test('Job assignment refusal closes its handle and never returns a usable tree', () => {
  const { api, calls } = fake();
  api.assign = () => false;
  assert.throws(() => attachWindowsJob(api, 123), /分配失败/);
  assert.deepEqual(calls, ['create', 'close']);
});

test('concurrent cleanup retains one termination promise and waits for the Job to empty', async () => {
  const { api, calls } = fake();
  let active = 1;
  api.active = () => active--;
  const tree = attachWindowsJob(api, 123);
  const stopped = tree.stop();
  assert.equal(tree.stop(), stopped);
  await stopped;
  assert.deepEqual(calls, ['create', 'assign', 'terminate', 'close']);
});

test('unreadable Job state rejects cleanup instead of claiming all children exited', async () => {
  const { api, calls } = fake();
  api.active = () => { throw Error('unreadable'); };
  await assert.rejects(attachWindowsJob(api, 123).stop(), /unreadable/);
  assert.equal(calls.at(-1), 'close');
});

const native = process.platform === 'win32' && ['x64', 'arm64'].includes(process.arch);

test('Windows pack calls fail closed even when synthetic OS opt-out is requested', { skip: !native }, async () => {
  assert.equal(await osIsolationAvailable(), false);
  assert.equal(osIsolationFailure(), windowsIsolationFailure());
  assert.throws(() => isolatedCommand({ entry: 'unused', reads: [], heapMb: 64, cpuSeconds: 1, os: false }), /windows_kernel/);
  // The guard acts before reading a pack or serializing input.
  await assert.rejects(callPackFunction({ packDir: 'nonexistent', module: 'unused.ts', export: 'unused' }, {}, {}, { requireOsIsolation: false }),
    (error: unknown) => (error as { code?: string }).code === 'SANDBOX_UNAVAILABLE');
});

test('native Job cleanup terminates an idle bootstrap and its nested descendant', { skip: !native, timeout: 20_000 }, async t => {
  const api = await loadWindowsJobApi();
  // Trusted bootstrap stays idle until Job assignment. Pack code is never involved.
  const inner = `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});child.once('spawn',()=>process.send(child.pid,()=>process.exit(0)));`;
  const source = `process.send('ready');process.once('message',()=>{const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(inner)}],{stdio:['ignore','ignore','ignore','ipc']});let pid;child.once('message',value=>pid=value);child.once('exit',()=>process.send(pid));});setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['-e', source], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: {} });
  t.after(() => { child.kill(); });
  await once(child, 'message');
  const job = attachWindowsJob(api, child.pid!);
  t.after(() => job.stop());
  const descendant = once(child, 'message');
  child.send('start');
  const [pid] = await descendant;
  assert.equal(typeof pid, 'number');
  const exit = once(child, 'exit');
  await job.stop();
  await exit;
  assert.throws(() => process.kill(pid as number, 0), { code: 'ESRCH' });
});

test('native loader uses the KnownDLL without consulting an overridden environment', () => {
  const original = Object.getOwnPropertyDescriptor(process, 'env')!;
  const loaded: string[] = [];
  Object.defineProperty(process, 'env', { configurable: true, get() { throw Error('environment must not be read'); } });
  try {
    createWindowsJobApi({ version: '3.3.3', load(name) {
      loaded.push(name);
      return { func: () => () => undefined };
    } });
  } finally { Object.defineProperty(process, 'env', original); }
  assert.deepEqual(loaded, ['kernel32.dll']);
});

test('unexpected koffi versions fail before any DLL load', () => {
  for (const version of ['3.3.2', '3.3.4', '3.3.3-custom', '']) {
    let loaded = false;
    assert.throws(() => createWindowsJobApi({ version, load() {
      loaded = true;
      throw Error('must not load');
    } }), /版本不匹配/);
    assert.equal(loaded, false);
  }
});

test('Job limits encode aggregate user CPU and committed memory without breakaway', () => {
  const data = windowsJobLimits({ userCpuSeconds: 2, committedBytes: 512 * 1024 * 1024 });
  assert.equal(data.length, 144);
  assert.equal(data.readUInt32LE(16), 0x2204);
  assert.equal(data.readBigInt64LE(8), 20_000_000n);
  assert.equal(data.readBigUInt64LE(120), 512n * 1024n * 1024n);
  assert.equal(windowsJobLimits().readUInt32LE(16), 0x2000);
});

test('invalid Job limits fail before creating any native handle', () => {
  let created = false;
  const api = createWindowsJobApi({ version: '3.3.3', load: () => ({ func: declaration => () => {
    if (declaration.includes('CreateJobObjectW')) created = true;
    return 1n;
  } }) });
  for (const userCpuSeconds of [0, -1, 0.5, NaN, Infinity, 3601]) {
    assert.throws(() => api.create({ userCpuSeconds, committedBytes: 1024 }), RangeError);
  }
  for (const committedBytes of [0, -1, 0.5, NaN, Infinity]) {
    assert.throws(() => api.create({ userCpuSeconds: 1, committedBytes }), RangeError);
  }
  assert.equal(created, false);
});

test('Job resource policy failure closes the handle and cannot return a usable Job', () => {
  const calls: string[] = [];
  const api = createWindowsJobApi({ version: '3.3.3', load: () => ({ func: declaration => () => {
    if (declaration.includes('CreateJobObjectW')) return 1n;
    if (declaration.includes('CloseHandle')) { calls.push('close'); return 1; }
    return 0;
  } }) });
  assert.throws(() => api.create({ userCpuSeconds: 1, committedBytes: 1024 }), /设置失败/);
  assert.deepEqual(calls, ['close']);
});

test('native Job user CPU limit ends a busy synthetic worker', { skip: !native, timeout: 20_000 }, async t => {
  const api = await loadWindowsJobApi();
  const child = spawn(process.execPath, ['-e', "process.send('ready');process.once('message',()=>{for(;;) Math.sqrt(Math.random());});"],
    { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: {} });
  t.after(() => { child.kill(); });
  await once(child, 'message');
  const job = attachWindowsJob(api, child.pid!, { userCpuSeconds: 1, committedBytes: 512 * 1024 * 1024 });
  t.after(() => job.stop());
  const exited = once(child, 'exit');
  child.send('run');
  const [code] = await exited;
  assert.notEqual(code, 0);
  await job.stop();
});

test('native Job committed memory limit rejects an allocation that succeeded before assignment', { skip: !native, timeout: 20_000 }, async t => {
  const api = await loadWindowsJobApi();
  // Commit virtual pages without touching them; this is not an RSS measurement.
  const source = `const koffi=require('koffi');if(koffi.version!=='3.3.3')process.exit(3);const kernel=koffi.load('kernel32.dll');const alloc=kernel.func('void * __stdcall VirtualAlloc(void *address, uintptr_t size, uint32_t kind, uint32_t protection)');const free=kernel.func('int __stdcall VirtualFree(void *address, uintptr_t size, uint32_t kind)');const valid=p=>p!==null&&p!==0n;const probe=alloc(null,512*1024*1024,0x3000,4);if(!valid(probe))process.exit(4);if(!free(probe,0,0x8000))process.exit(5);process.send('ready');process.once('message',()=>{const p=alloc(null,512*1024*1024,0x3000,4);const denied=!valid(p);if(!denied)free(p,0,0x8000);process.send(denied,()=>process.exit(0));});`;
  const child = spawn(process.execPath, ['-e', source], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: {} });
  t.after(() => { child.kill(); });
  const [ready] = await once(child, 'message');
  assert.equal(ready, 'ready');
  const job = attachWindowsJob(api, child.pid!, { userCpuSeconds: 5, committedBytes: 256 * 1024 * 1024 });
  t.after(() => job.stop());
  const result = once(child, 'message');
  child.send('allocate');
  const [denied] = await result;
  assert.equal(denied, true);
  await job.stop();
});


function tokenKoffi(failure?: string) {
  const calls: string[] = [];
  return { calls, version: '3.3.3', load(name: string) {
    calls.push(name);
    return { func(declaration: string) {
      const name = declaration.split(' __stdcall ')[1]!.split('(')[0]!;
      return (...args: unknown[]) => {
        calls.push(name);
        if (name === failure) return 0;
        if (name === 'GetCurrentProcess') return -1n;
        if (name === 'OpenProcessToken') (args[2] as Buffer).writeBigUInt64LE(10n);
        if (name === 'ConvertStringSidToSidW') (args[1] as Buffer).writeBigUInt64LE(20n);
        if (name === 'CreateRestrictedToken') {
          assert.equal(args[1], 0x9);
          assert.equal(args[6], 1);
          assert.equal((args[7] as Buffer).readBigUInt64LE(), 20n);
          (args[8] as Buffer).writeBigUInt64LE(30n);
        }
        if (name === 'GetTokenInformation') {
          assert.equal(args[1], 11);
          (args[2] as Buffer).writeUInt32LE(1);
          (args[2] as Buffer).writeBigUInt64LE(20n, 8);
          (args[4] as Buffer).writeUInt32LE(24);
        }
        return 1;
      };
    } };
  } };
}

test('write-restricted token closes temporary handles and owns exactly one checked token', () => {
  const fake = tokenKoffi();
  const token = createWindowsRestrictedToken(fake);
  assert.equal(token.handle, 30n);
  assert.equal(fake.calls.filter(name => name === 'CloseHandle').length, 1);
  assert.ok(fake.calls.includes('LocalFree'));
  token.close();
  token.close();
  assert.equal(fake.calls.filter(name => name === 'CloseHandle').length, 2);
  assert.throws(() => token.handle, /已关闭/);
});

test('token native failure or mismatched restricting SID never returns a usable token', () => {
  for (const failure of ['OpenProcessToken', 'ConvertStringSidToSidW', 'CreateRestrictedToken', 'IsTokenRestricted', 'GetTokenInformation', 'EqualSid']) {
    const fake = tokenKoffi(failure);
    assert.throws(() => createWindowsRestrictedToken(fake));
    if (['IsTokenRestricted', 'GetTokenInformation', 'EqualSid'].includes(failure))
      assert.equal(fake.calls.filter(name => name === 'CloseHandle').length, 2);
  }
});

test('wrong token addon version fails before loading native libraries', () => {
  const fake = tokenKoffi();
  fake.version = '3.3.4';
  assert.throws(() => createWindowsRestrictedToken(fake), /版本不匹配/);
  assert.deepEqual(fake.calls, []);
});

test('native write-restricted token has the exact restricting SID and closes cleanly', { skip: !native }, async () => {
  const token = await loadWindowsRestrictedToken();
  try { assert.ok(token.handle > 0n); }
  finally { token.close(); }
  assert.throws(() => token.handle, /已关闭/);
});

test('Windows argv quoting retains quotes, trailing slashes and rejects NUL', () => {
  const slash = String.fromCharCode(92);
  assert.equal(quoteWindowsArgument(''), '""');
  assert.equal(quoteWindowsArgument('a b'), '"a b"');
  assert.equal(quoteWindowsArgument('a"b'), '"a' + slash + '"b"');
  assert.equal(quoteWindowsArgument('a' + slash), '"a' + slash.repeat(2) + '"');
  assert.throws(() => quoteWindowsArgument('a' + String.fromCharCode(0) + 'b'), TypeError);
});

test('native LPAC starts Node only after restricted token and Job verification', { skip: !native, timeout: 20_000 }, async () => {
  assert.equal(await runWindowsIsolationProbe('process.exit(0)'), 0);
});

test('native LPAC denies TCP to an actually listening synthetic endpoint', { skip: !native, timeout: 20_000 }, async t => {
  let connected = false;
  const server = createServer(socket => { connected = true; socket.destroy(); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const source = `const socket=require('node:net').connect(${address.port},'127.0.0.1');socket.once('connect',()=>process.exit(2));socket.once('error',e=>process.exit(['EACCES','EPERM'].includes(e.code)?0:3));setTimeout(()=>process.exit(4),3000);`;
  assert.equal(await runWindowsIsolationProbe(source), 0);
  assert.equal(connected, false);
});

test('native LPAC denies UDP to a bound synthetic endpoint', { skip: !native, timeout: 20_000 }, async t => {
  let received = false;
  const socket = createSocket('udp4');
  socket.on('message', () => { received = true; });
  socket.bind(0, '127.0.0.1');
  await once(socket, 'listening');
  t.after(() => socket.close());
  const port = socket.address().port;
  const source = `const s=require('node:dgram').createSocket('udp4');const done=e=>process.exit(e&&['EACCES','EPERM'].includes(e.code)?0:2);s.on('error',done);s.send('synthetic',${port},'127.0.0.1',done);setTimeout(()=>process.exit(3),3000);`;
  assert.equal(await runWindowsIsolationProbe(source), 0);
  assert.equal(received, false);
});

test('native LPAC denies file create overwrite delete rename and directory creation', { skip: !native, timeout: 20_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'hub-lpac-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const target = join(directory, 'target');
  await writeFile(target, 'synthetic');
  const source = `const fs=require('node:fs'),p=${JSON.stringify(target)},d=${JSON.stringify(directory)};for(const f of [()=>fs.writeFileSync(p,'changed'),()=>fs.writeFileSync(d+'/created','new'),()=>fs.unlinkSync(p),()=>fs.renameSync(p,d+'/renamed'),()=>fs.mkdirSync(d+'/directory')]){try{f();process.exit(2)}catch(e){if(!['EACCES','EPERM'].includes(e.code))process.exit(3)}}process.exit(0);`;
  assert.equal(await runWindowsIsolationProbe(source), 0);
  assert.equal(await readFile(target, 'utf8'), 'synthetic');
});

test('native LPAC denies starting another Node process without Node permission flags', { skip: !native, timeout: 20_000 }, async () => {
  // stdio 'ignore' so the spawn reaches process creation: with the default pipes, libuv first creates a named pipe,
  // which LPAC denies, and libuv retries that indefinitely (issue 73), so the old probe measured libuv, not the denial.
  const source = `const cp=require('node:child_process');const result=cp.spawnSync(process.execPath,['-e','process.exit(0)'],{stdio:'ignore'});process.exit(result.error&&['EACCES','EPERM'].includes(result.error.code)?0:2);`;
  assert.equal(await runWindowsIsolationProbe(source), 0);
});


test('LPAC environment block keeps only sorted system and profile locations', () => {
  const block = windowsEnvironmentBlock({
    Path: 'C:\\Windows\\system32', SystemRoot: 'C:\\Windows', TEMP: 'C:\\Temp', SECRET_TOKEN: 'private-token',
    GITHUB_TOKEN: 'private-token', ComSpec: 'C:\\Windows\\system32\\cmd.exe', windir: undefined,
  });
  assert.equal(block.toString('utf16le'), 'PATH=C:\\Windows\\system32\0SYSTEMROOT=C:\\Windows\0TEMP=C:\\Temp\0\0');
  assert.equal(block.length % 2, 0);
  assert.throws(() => windowsEnvironmentBlock({ PATH: 'C:\\Windows' }), /SystemRoot/);
  assert.throws(() => windowsEnvironmentBlock({ SystemRoot: 'C:\\Windows\0PATH=x' }), TypeError);
});

test('LPAC startup diagnostics expose only fixed stage observations', () => {
  const error = windowsProbeFailure('挂起创建', 2, {
    executableExists: true, executableBinary: true, directoryExists: true,
    path: 'private-path', source: 'private-source', token: 'private-token',
  } as Parameters<typeof windowsProbeFailure>[2]);
  assert.equal(error.message, 'Windows LPAC 挂起创建失败 (2); {"executableExists":true,"executableBinary":true,"directoryExists":true}');
  assert.equal(error.message.includes('private-'), false);
});

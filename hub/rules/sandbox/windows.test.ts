import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { attachWindowsJob, createWindowsJobApi, loadWindowsJobApi, windowsJobLimits, windowsIsolationFailure, type WindowsJobApi } from './windows.ts';
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

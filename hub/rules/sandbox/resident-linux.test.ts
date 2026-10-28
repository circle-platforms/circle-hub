import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { Worker } from 'node:worker_threads';
import { createLinuxResidentMeasure, createResidentTreeMeasure, residentSizes, residentTreeSizes } from './resident.ts';

test('Linux resident measurement falls back to statm pages, including zero, without guessing a page size', async () => {
  const measured = createLinuxResidentMeasure({
    status: async () => 'State:\tR (running)\n',
    statm: async pid => pid === 1 ? '100 17 0 0 0 0 0\n' : '0 0 0 0 0 0 0\n',
    pageBytes: 4096,
  });
  assert.deepEqual(await measured([1, 2]), new Map([[1, 17 * 4096], [2, 0]]));
  const absent = createLinuxResidentMeasure({ status: async () => '', statm: async () => '100 17', pageBytes: undefined });
  assert.equal((await absent([1])).has(1), false);
  const malformed = createLinuxResidentMeasure({ status: async () => { throw new Error('denied'); }, statm: async () => 'not-a-count', pageBytes: 4096 });
  assert.equal((await malformed([1])).has(1), false);
});

test('an inaccessible live process tree fails closed rather than counting only its supervisor', async () => {
  const measure = createResidentTreeMeasure({
    readThreads: async pid => [String(pid)],
    readChildren: async (pid) => {
      if (pid === 1) return '2';
      throw Object.assign(new Error('inaccessible'), { code: 'EACCES' });
    },
    measure: async pids => new Map(pids.map(pid => [pid, 100])),
    gone: async () => false,
    threadGone: async () => false,
  });
  assert.equal((await measure([1])).get(1), Number.MAX_SAFE_INTEGER);
});

test('a child that exited between samples does not count as an inaccessible live tree', async () => {
  const measure = createResidentTreeMeasure({
    readThreads: async pid => [String(pid)],
    readChildren: async (pid) => {
      if (pid === 1) return '2';
      throw Object.assign(new Error('gone'), { code: 'ENOENT' });
    },
    measure: async pids => new Map(pids.filter(pid => pid === 1).map(pid => [pid, 100])),
    gone: async pid => pid === 2,
    threadGone: async () => false,
  });
  assert.equal((await measure([1])).get(1), 100);
});

test('an exited child after enumeration is ignored but an unmeasurable live child fails closed', async () => {
  let childGone = true;
  const measure = createResidentTreeMeasure({
    readThreads: async pid => [String(pid)],
    readChildren: async pid => pid === 1 ? '2' : '',
    measure: async pids => new Map(pids.filter(pid => pid === 1).map(pid => [pid, 100])),
    gone: async pid => pid === 2 && childGone,
    threadGone: async () => false,
  });
  assert.equal((await measure([1])).get(1), 100);
  childGone = false;
  assert.equal((await measure([1])).get(1), Number.MAX_SAFE_INTEGER);
});

test('an unreadable thread list fails closed and a disappearing thread restarts the scan', async () => {
  let first = true;
  const measure = createResidentTreeMeasure({
    readThreads: async pid => {
      if (pid === 2) return ['2'];
      if (first) { first = false; return ['1', '42']; }
      return ['1'];
    },
    readChildren: async (pid, tid) => {
      if (tid === '42') throw Object.assign(new Error('gone'), { code: 'ENOENT' });
      return pid === 1 ? '2' : '';
    },
    measure: async pids => new Map(pids.map(pid => [pid, 100])),
    gone: async () => false,
    threadGone: async (_pid, tid) => tid === '42',
  });
  assert.equal((await measure([1])).get(1), 200);
  const unreadable = createResidentTreeMeasure({
    readThreads: async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); },
    readChildren: async () => '', measure: async () => new Map(), gone: async () => false, threadGone: async () => false,
  });
  assert.equal((await unreadable([1])).get(1), Number.MAX_SAFE_INTEGER);
});

test('Linux resident accounting finds a child started by a non-leader thread', { skip: process.platform !== 'linux', timeout: 10_000 }, async () => {
  const childSource = "const bytes = Buffer.alloc(64 * 1024 * 1024, 7); process.stdout.write('ready\\n'); setInterval(() => bytes[0], 1000);";
  const workerSource = `const {parentPort}=require('node:worker_threads');const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',${JSON.stringify(childSource)}],{stdio:['ignore','pipe','inherit']});c.stdout.once('data',()=>parentPort.postMessage(c.pid));setInterval(()=>{},1000);`;
  const worker = new Worker(workerSource, { eval: true, execArgv: [] });
  let child = 0;
  try {
    [child] = await once(worker, 'message') as [number];
    assert.ok(Number.isSafeInteger(child) && child > 0);
    const leaderChildren = await readFile(`/proc/self/task/${process.pid}/children`, 'utf8');
    assert.ok(!leaderChildren.trim().split(/\s+/).includes(String(child)), 'the process belongs to a non-leader task');
    const individual = await residentSizes([process.pid, child]);
    const total = await residentTreeSizes([process.pid]);
    assert.ok(individual.has(process.pid) && individual.has(child));
    assert.ok(total.get(process.pid)! >= individual.get(process.pid)! + individual.get(child)! - 4 * 1024 * 1024, 'the non-leader child contributes its resident memory');
  } finally {
    if (child) try { process.kill(child, 'SIGKILL'); } catch { /* Already gone. */ }
    await worker.terminate();
  }
});

test('Linux resident accounting includes a supervisor and its child', { skip: process.platform !== 'linux', timeout: 10_000 }, async (t) => {
  const childSource = "const bytes = Buffer.alloc(48 * 1024 * 1024, 7); process.stdout.write('ready\\n'); setInterval(() => bytes[0], 1000);";
  const parentSource = `const {spawn} = require('node:child_process'); const child = spawn(process.execPath, ['-e', ${JSON.stringify(childSource)}], {stdio:['ignore','pipe','inherit']}); child.stdout.once('data', () => process.stdout.write(String(child.pid) + '\\n')); setInterval(() => {}, 1000);`;
  const parent = spawn(process.execPath, ['-e', parentSource], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { try { process.kill(-parent.pid!, 'SIGKILL'); } catch { /* Already gone. */ } });
  const [chunk] = await once(parent.stdout, 'data');
  const child = Number(String(chunk).trim());
  assert.ok(parent.pid && Number.isSafeInteger(child) && child > 0);
  const individual = await residentSizes([parent.pid, child]);
  const total = await residentTreeSizes([parent.pid]);
  assert.ok(individual.has(parent.pid) && individual.has(child), 'both live processes were measured');
  assert.ok(total.get(parent.pid)! >= individual.get(parent.pid)! + individual.get(child)!, 'the child contributes to the monitored total');
});

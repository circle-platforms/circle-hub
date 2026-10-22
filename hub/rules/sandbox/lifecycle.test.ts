// Lifecycle of the sandbox: the bounded waiting line, the shared memory poller, the isolation probe, stopping children when the
// Hub stops, and sweeping children an earlier Hub process left behind. Synthetic packs in a temporary directory.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { runCheck } from '../check.ts';
import { SandboxError } from './errors.ts';
import { BOOTSTRAP, createIsolationProbe, NODE, osIsolationAvailable } from './isolation.ts';
import { sweepOrphans } from './orphans.ts';
import { createResidentWatch, residentSizes } from './resident.ts';
import { callPackFunction, livePids, MAX_CONCURRENT, MAX_WAITING, stopAll } from './sandbox.ts';
import { createSlotPool } from './slots.ts';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'hub-rules-lifecycle-')));
let counter = 0;
let os = false;

function pack(files: Record<string, string>): string {
  const dir = join(root, `pack-${++counter}`);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function until(condition: () => boolean, ms = 5000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > ms) assert.fail('condition not reached in time');
    await delay(20);
  }
}
const SLEEP = 'export default () => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20_000); return 1; };';

before(async () => {
  os = await osIsolationAvailable();
});
after(() => rmSync(root, { recursive: true, force: true }));

describe('waiting line', () => {
  it('runs a bounded number at once, queues a bounded number in order, and fails fast when the line is full', async () => {
    const pool = createSlotPool({ running: 2, waiting: 3, full: () => new Error('line full') });
    const order: number[] = [];
    const gates: (() => void)[] = [];
    const task = (n: number) => () =>
      new Promise<number>((resolve) => {
        order.push(n);
        gates.push(() => resolve(n));
      });
    const calls = [1, 2, 3, 4, 5].map((n) => pool.run(task(n)));
    await delay(0);
    assert.equal(pool.active, 2);
    assert.equal(pool.queued, 3);
    await assert.rejects(pool.run(task(6)), /line full/);
    while (gates.length > 0) {
      (gates.shift() as () => void)();
      await delay(0);
    }
    assert.deepEqual(await Promise.all(calls), [1, 2, 3, 4, 5]);
    assert.deepEqual(order, [1, 2, 3, 4, 5]);
    assert.equal(pool.active, 0);
  });

  it('a task that throws frees its slot; waiting calls can all be refused at once', async () => {
    const pool = createSlotPool({ running: 1, waiting: 4, full: () => new Error('line full') });
    await assert.rejects(
      pool.run(async () => {
        throw new Error('task failed');
      }),
      /task failed/,
    );
    let release: () => void = () => {};
    const holder = pool.run(() => new Promise<void>((resolve) => (release = resolve)));
    const waiting = [pool.run(async () => 1), pool.run(async () => 2)];
    await delay(0);
    assert.equal(pool.rejectWaiting(() => new Error('stopping')), 2);
    for (const call of waiting) await assert.rejects(call, /stopping/);
    release();
    await holder;
    assert.equal(await pool.run(async () => 3), 3);
  });
});

describe('memory poller', () => {
  it('measures every watched child in one round and stops when nothing is watched', async () => {
    const rounds: number[][] = [];
    const watch = createResidentWatch({
      intervalMs: 40,
      measure: async (pids) => {
        rounds.push([...pids]);
        return new Map(pids.map((pid) => [pid, pid * 10]));
      },
    });
    const seen = new Map<number, number>();
    const stops = [11, 12, 13, 14].map((pid) => watch.watch(pid, (bytes) => seen.set(pid, bytes)));
    await delay(220);
    for (const stop of stops) stop();
    const count = rounds.length;
    assert.ok(count >= 2 && count <= 7, `${count} rounds`);
    assert.ok(
      rounds.every((r) => r.length === 4),
      'one measurement covers every child',
    );
    assert.equal(seen.get(13), 130);
    await delay(150);
    assert.equal(rounds.length, count, 'no rounds while nothing is watched');
    assert.equal(watch.watching, 0);
  });

  it('reads the resident size of live processes in one call and leaves out the ones that are gone', async () => {
    // The pid of a process that has just exited: in range, and gone.
    const gone = spawnSync('/usr/bin/true').pid;
    const sizes = await residentSizes([process.pid, gone]);
    assert.ok((sizes.get(process.pid) ?? 0) > 1024 * 1024);
    assert.equal(sizes.has(gone), false);
  });
});

describe('isolation probe', () => {
  it('caches a success and a lasting absence, but retries a failed probe after a delay', async () => {
    let now = 0;
    let probes = 0;
    const results = [{ available: false as const, lasting: false, reason: 'exit 1' }, { available: true as const }];
    const probe = createIsolationProbe({ probe: async () => (probes++, results.shift() ?? { available: true as const }), retryMs: 1000, now: () => now });
    assert.equal(await probe.available(), false);
    assert.equal(probe.lastFailure(), 'exit 1');
    assert.equal(await probe.available(), false);
    assert.equal(probes, 1, 'no new probe inside the retry delay');
    now = 1500;
    const [a, b] = await Promise.all([probe.available(), probe.available()]);
    assert.deepEqual([a, b], [true, true]);
    assert.equal(probes, 2, 'concurrent callers share one probe');
    now = 10_000;
    assert.equal(await probe.available(), true);
    assert.equal(probes, 2, 'a success is kept');
    let lastingProbes = 0;
    const lasting = createIsolationProbe({ probe: async () => (lastingProbes++, { available: false as const, lasting: true, reason: 'platform' }), retryMs: 0 });
    assert.equal(await lasting.available(), false);
    assert.equal(await lasting.available(), false);
    assert.equal(lastingProbes, 1);
  });
});

describe('stopping', () => {
  it('a full waiting line fails fast (budget exhausted for a check); stopAll ends running children and refuses waiting calls', async (t) => {
    if (!os) return t.skip('the sandbox needs sandbox-exec here');
    const dir = pack({ 'sleep.ts': SLEEP, 'fn.ts': 'export default () => [];' });
    const holders = Array.from({ length: MAX_CONCURRENT }, () => callPackFunction({ packDir: dir, module: 'sleep.ts' }, null, { timeoutMs: 30_000 }));
    await until(() => livePids().length === MAX_CONCURRENT);
    const waiters = Array.from({ length: MAX_WAITING }, () => callPackFunction({ packDir: dir, module: 'fn.ts' }, null));
    for (const w of waiters) w.catch(() => {});
    const [overflow] = await runCheck({ function: { module: 'fn.ts' }, tier: 'advisory' }, { subject: {}, context: { pack: 'synthetic-review' }, packDir: dir });
    assert.equal(overflow.verdict, 'unknown');
    assert.equal(overflow.reason, 'budget_exhausted');
    const pids = livePids();
    assert.equal(stopAll(), MAX_CONCURRENT);
    for (const settled of await Promise.allSettled([...holders, ...waiters])) {
      assert.equal(settled.status, 'rejected');
      const error = (settled as PromiseRejectedResult).reason as SandboxError;
      assert.ok(error instanceof SandboxError);
      assert.equal(error.code, 'SANDBOX_UNAVAILABLE');
      assert.equal(error.detail.reason, 'stopping');
    }
    await until(() => pids.every((pid) => !alive(pid)));
    assert.deepEqual(livePids(), []);
  });

  it('children are ended when the Hub process exits', async (t) => {
    if (!os) return t.skip('the sandbox needs sandbox-exec here');
    const dir = pack({ 'sleep.ts': SLEEP });
    const script = join(root, 'exits.mjs');
    writeFileSync(
      script,
      [
        `const { callPackFunction, livePids } = await import(${JSON.stringify(pathToFileURL(join(import.meta.dirname, 'sandbox.ts')).href)});`,
        `callPackFunction({ packDir: ${JSON.stringify(dir)}, module: 'sleep.ts' }, null, { timeoutMs: 30_000 }).catch(() => {});`,
        'while (livePids().length === 0) await new Promise((r) => setTimeout(r, 20));',
        'process.stdout.write(String(livePids()[0]));',
        'process.exit(0);',
      ].join('\n'),
    );
    const child = spawn(NODE, [script], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    await new Promise((resolve) => child.on('close', resolve));
    const pid = Number(out);
    assert.ok(Number.isInteger(pid) && pid > 0, out);
    await until(() => !alive(pid), 2000);
  });

  it('sweeps sandbox children left behind by an earlier Hub process, and nothing else', async (t) => {
    if (process.platform !== 'darwin') return t.skip('orphans are recognised by their parent, launchd, on macOS');
    const marker = `--allow-fs-read=${BOOTSTRAP}`;
    const start = (args: string[]): Promise<number> =>
      new Promise((resolve, reject) => {
        const sh = spawn('/bin/sh', ['-c', '"$0" "$@" </dev/null >/dev/null 2>&1 & echo $!', NODE, ...args], { stdio: ['ignore', 'pipe', 'ignore'], detached: true });
        let out = '';
        sh.stdout.on('data', (d) => (out += d));
        sh.on('error', reject);
        sh.on('close', () => resolve(Number(out.trim())));
      });
    const orphan = await start(['--permission', marker, '-e', 'setTimeout(() => {}, 30000)']);
    const unrelated = await start(['-e', 'setTimeout(() => {}, 30000)', '--', `${marker}x`]);
    try {
      await delay(200);
      assert.ok(alive(orphan) && alive(unrelated));
      assert.ok((await sweepOrphans()) >= 1);
      await until(() => !alive(orphan), 2000);
      assert.ok(alive(unrelated), 'a process that only mentions the path is left alone');
    } finally {
      for (const pid of [orphan, unrelated]) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // Already gone.
        }
      }
    }
  });
});

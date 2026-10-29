// The start-up sweep for an installation under a path outside ASCII (a folder named 开发, say). The sweep compares its marker
// with each command line as the platform lists it, so the path has to come back unchanged. CI checks out under ASCII paths,
// so the installation here is a temporary directory of its own.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { NODE } from './isolation.ts';
import { carries, listProcesses, sweepOrphansOf } from './orphans.ts';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Starts node with `args` from a shell that exits at once, so its parent becomes pid 1, as after the Hub has died. */
function orphan(args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const sh = spawn('/bin/sh', ['-c', '"$0" "$@" </dev/null >/dev/null 2>&1 & echo $!', NODE, ...args], { stdio: ['ignore', 'pipe', 'ignore'], detached: true });
    let out = '';
    sh.stdout.on('data', (d) => (out += d));
    sh.on('error', reject);
    sh.on('close', () => resolve(Number(out.trim())));
  });
}

test(
  'sweeps an orphan of an installation whose path is not ASCII, whatever the locale of the Hub, and nothing else',
  { skip: process.platform !== 'darwin' && process.platform !== 'linux', timeout: 20_000 },
  async () => {
    // Real path, as the sandbox grants it: on macOS the temporary directory sits behind the /var symbolic link.
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'hub-orphans-开发-')));
    const bootstrap = join(root, 'bootstrap.ts');
    writeFileSync(bootstrap, '');
    const marker = `--allow-fs-read=${bootstrap}`;
    const sleep = ['-e', 'setTimeout(() => {}, 30000)'];
    const ours = await orphan(['--permission', marker, ...sleep]);
    // Another installation, whose path begins with this one's.
    const other = await orphan(['--permission', `${marker}x`, ...sleep]);
    try {
      assert.ok(ours > 1 && other > 1);
      await delay(200);
      assert.ok(alive(ours) && alive(other));
      // A launchd service has no locale in its environment, and LC_ALL overrides any other: what the sweep sees must not
      // depend on the locale of the process that runs it.
      const saved = process.env.LC_ALL;
      process.env.LC_ALL = 'C';
      let swept: number;
      try {
        const listed = (await listProcesses()).find((p) => p.pid === ours);
        assert.ok(listed && carries(listed, marker), `the listed command line lost the path: ${JSON.stringify(listed?.args)}`);
        swept = await sweepOrphansOf(bootstrap);
      } finally {
        if (saved === undefined) delete process.env.LC_ALL;
        else process.env.LC_ALL = saved;
      }
      assert.equal(swept, 1);
      const until = Date.now() + 3_000;
      while (alive(ours) && Date.now() < until) await delay(20);
      assert.equal(alive(ours), false);
      assert.ok(alive(other), 'an orphan of another installation is left alone');
    } finally {
      for (const pid of [ours, other]) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // Already gone.
        }
      }
      rmSync(root, { recursive: true, force: true });
    }
  },
);

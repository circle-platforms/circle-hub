import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { BOOTSTRAP, NODE } from './isolation.ts';
import { sweepOrphans } from './orphans.ts';

test('Linux orphan cleanup kills only a matching installation marker', { skip: process.platform !== 'linux', timeout: 10_000 }, async () => {
  const marker = `--allow-fs-read=${BOOTSTRAP}`;
  const start = (args: string[]) => new Promise<number>((resolve, reject) => {
    const sh = spawn('/bin/sh', ['-c', '"$0" "$@" </dev/null >/dev/null 2>&1 & echo $!', NODE, ...args], { stdio: ['ignore', 'pipe', 'ignore'], detached: true });
    let out = ''; sh.stdout.on('data', value => out += value); sh.on('error', reject); sh.on('close', () => resolve(Number(out.trim())));
  });
  const orphan = await start(['--permission', marker, '-e', 'setTimeout(() => {}, 30000)']);
  const unrelated = await start(['-e', 'setTimeout(() => {}, 30000)', '--', `${marker}x`]);
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  try {
    assert.ok(orphan > 1 && unrelated > 1);
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.ok(alive(orphan) && alive(unrelated));
    assert.ok((await sweepOrphans()) >= 1);
    const until = Date.now() + 3_000;
    while (alive(orphan) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(alive(orphan), false);
    assert.ok(alive(unrelated), 'a nonmatching process remains alive');
  } finally {
    for (const pid of [orphan, unrelated]) try { process.kill(pid, 'SIGKILL'); } catch { /* Gone. */ }
  }
});

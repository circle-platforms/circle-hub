import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { residentSizes, residentTreeSizes } from './resident.ts';

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

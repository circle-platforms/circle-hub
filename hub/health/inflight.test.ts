// The in-flight log: what a crash must leave behind, and that it can never hurt a request.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createRequestLog, INFLIGHT_FILE, INFLIGHT_ROTATED } from './inflight.ts';

const clock = (): (() => Date) => {
  let at = Date.parse('2026-01-02T03:04:05.000Z');
  return () => new Date((at += 1000));
};

function scratch(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'circle-hub-inflight-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

const lines = (directory: string): Record<string, unknown>[] => readFileSync(join(directory, INFLIGHT_FILE), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
const info = { traceId: 'c'.repeat(32), origin: 'mcp', name: 'POST /mcp', userId: null };

test('a request leaves one line before it runs and one when it ends, with the trace, origin, name, user and time', (t) => {
  const directory = scratch(t);
  const log = createRequestLog({ directory, boot: 'boot-a', now: clock() });
  const end = log.begin({ ...info, userId: 'usr_synthetic' });
  assert.equal(log.inFlight, 1);
  const before = lines(directory).at(-1);
  assert.deepEqual(before, { t: 'begin', boot: 'boot-a', id: 1, at: '2026-01-02T03:04:07.000Z', trace: 'c'.repeat(32), origin: 'mcp', name: 'POST /mcp', user: 'usr_synthetic' }, 'the line is there before the request ran');
  end();
  assert.equal(log.inFlight, 0);
  assert.deepEqual(lines(directory).at(-1), { t: 'end', boot: 'boot-a', id: 1, at: '2026-01-02T03:04:08.000Z' });
  end();
  assert.equal(lines(directory).filter((line) => line.t === 'end').length, 1, 'ending twice writes once');
  assert.equal(statSync(join(directory, INFLIGHT_FILE)).mode & 0o777, 0o600);
  log.close();
});

test('entries with no end line are what the next process recovers, identified as far as they got; rotating then starts a fresh file', (t) => {
  const directory = scratch(t);
  const now = clock();
  const crashed = createRequestLog({ directory, boot: 'boot-a', now });
  crashed.begin({ traceId: null, origin: 'console', name: 'GET /console/runs', userId: null })();
  const running = crashed.begin(info);
  running.identify({ traceId: 'd'.repeat(32), userId: 'usr_synthetic' });
  running.identify({ name: 'get_nodes' });
  crashed.close();

  const next = createRequestLog({ directory, boot: 'boot-b', now });
  next.begin({ traceId: null, origin: 'sync', name: 'POST /api/sync', userId: null });
  const recovered = next.recover();
  assert.equal(recovered.readable, true);
  assert.deepEqual([...recovered.processes.keys()], ['boot-a'], 'its own lines are not earlier history');
  const earlier = recovered.processes.get('boot-a')!;
  assert.deepEqual(earlier.open, [{ trace: 'd'.repeat(32), origin: 'mcp', name: 'get_nodes', user: 'usr_synthetic', started_at: '2026-01-02T03:04:09.000Z' }]);
  assert.equal(earlier.stoppedAt, null);
  assert.equal(earlier.lastAt, '2026-01-02T03:04:11.000Z');
  assert.ok(!existsSync(join(directory, INFLIGHT_ROTATED)), 'reading changes nothing: the evidence stays until it is recorded');
  assert.equal(next.recover().processes.get('boot-a')?.open.length, 1, 'a second read finds the same');
  next.rotate();
  assert.ok(existsSync(join(directory, INFLIGHT_ROTATED)), 'rotated');
  assert.deepEqual(lines(directory).map((line) => [line.t, line.boot]), [['boot', 'boot-b'], ['begin', 'boot-b']], 'the fresh file has this process and the request it is running');
  next.close();
});

test('a clean stop is a marker of its own, kept with the lines of that process', (t) => {
  const directory = scratch(t);
  const now = clock();
  const stopped = createRequestLog({ directory, boot: 'boot-a', now });
  stopped.markStopped();
  stopped.close();
  const next = createRequestLog({ directory, boot: 'boot-b', now });
  assert.equal(next.recover().processes.get('boot-a')?.stoppedAt, '2026-01-02T03:04:07.000Z');
  next.close();
});

test('a rotation after the stop marker keeps it, and a closed log stays closed', (t) => {
  const directory = scratch(t);
  const now = clock();
  const stopped = createRequestLog({ directory, boot: 'boot-a', now });
  stopped.markStopped();
  stopped.rotate();
  stopped.close();
  stopped.rotate();
  const next = createRequestLog({ directory, boot: 'boot-b', now });
  assert.equal(next.recover().processes.get('boot-a')?.stoppedAt, '2026-01-02T03:04:07.000Z');
  next.close();
});

test('a process that crashes before its first request says so: an empty list, which is not the same as no line at all', (t) => {
  const directory = scratch(t);
  const now = clock();
  createRequestLog({ directory, boot: 'boot-a', now }).close();
  const next = createRequestLog({ directory, boot: 'boot-b', now });
  const recovered = next.recover();
  assert.deepEqual(recovered.processes.get('boot-a')?.open, []);
  assert.equal(recovered.processes.get('someone-else'), undefined);
  next.close();
});

test('a torn line and junk are counted and skipped; the rest of the file still counts', (t) => {
  const directory = scratch(t);
  const now = clock();
  const crashed = createRequestLog({ directory, boot: 'boot-a', now });
  crashed.begin(info);
  crashed.close();
  writeFileSync(join(directory, INFLIGHT_FILE), `${readFileSync(join(directory, INFLIGHT_FILE), 'utf8')}not json\n[1]\n{"t":"begin"}\n{"t":"end","boot":"boot-a","i`);
  const next = createRequestLog({ directory, boot: 'boot-b', now });
  // Written by this process after the torn tail: its first line is glued to it, which costs that line and nothing else.
  const recovered = next.recover();
  assert.equal(recovered.unreadableLines, 4);
  assert.equal(recovered.processes.get('boot-a')?.open.length, 1);
  next.close();
});

test('past the size bound the file rotates at once and the requests still running stay in it', (t) => {
  const directory = scratch(t);
  const now = clock();
  const log = createRequestLog({ directory, boot: 'boot-a', now, maxBytes: 4096 });
  const held = log.begin({ ...info, name: 'POST /still-running' });
  for (let index = 0; index < 200; index += 1) log.begin(info)();
  assert.ok(existsSync(join(directory, INFLIGHT_ROTATED)), 'rotated while running, not only at a start');
  assert.ok(statSync(join(directory, INFLIGHT_FILE)).size <= 4096 + 512, 'the current file stays near the bound');
  assert.ok(statSync(join(directory, INFLIGHT_ROTATED)).size <= 4096 + 512, 'so does the one generation kept');
  log.close();
  const next = createRequestLog({ directory, boot: 'boot-b', now });
  assert.deepEqual(next.recover().processes.get('boot-a')?.open.map((entry) => entry.name), ['POST /still-running'], 'a rotation loses no request still running');
  next.close();
  held();
});

test('a rotation that cannot move the file aside still keeps the bound', (t) => {
  const directory = scratch(t);
  mkdirSync(join(directory, INFLIGHT_ROTATED));
  writeFileSync(join(directory, INFLIGHT_ROTATED, 'in-the-way'), '');
  const log = createRequestLog({ directory, boot: 'boot-a', now: clock(), maxBytes: 2048 });
  for (let index = 0; index < 100; index += 1) log.begin(info)();
  assert.ok(statSync(join(directory, INFLIGHT_FILE)).size <= 2048 + 512);
  assert.equal(log.takeFailures(), 0);
  log.close();
});

test('a log that cannot be written never reaches the request: the failures are counted and it recovers by itself', (t) => {
  const directory = scratch(t);
  const blocked = join(directory, 'blocked');
  writeFileSync(blocked, 'a file where the directory should be');
  const log = createRequestLog({ directory: blocked, boot: 'boot-a', now: clock() });
  const end = log.begin(info);
  end.identify({ userId: 'usr_synthetic' });
  end();
  assert.equal(log.inFlight, 0, 'counted in memory all the same');
  assert.ok(log.takeFailures() >= 3);
  assert.equal(log.takeFailures(), 0, 'taken once');
  rmSync(blocked);
  log.begin(info);
  assert.equal(log.takeFailures(), 0);
  assert.ok(existsSync(join(blocked, INFLIGHT_FILE)), 'opened as soon as it can be');
  log.close();
});

test('an unreadable log is unknown, not empty', { skip: process.getuid?.() === 0 ? 'root reads everything' : false }, (t) => {
  const directory = scratch(t);
  const now = clock();
  createRequestLog({ directory, boot: 'boot-a', now }).close();
  const next = createRequestLog({ directory, boot: 'boot-b', now });
  next.close();
  chmodSync(join(directory, INFLIGHT_FILE), 0o000);
  const third = createRequestLog({ directory, boot: 'boot-c', now });
  const recovered = third.recover();
  third.close();
  chmodSync(join(directory, INFLIGHT_FILE), 0o600);
  assert.equal(recovered.readable, false);
  assert.equal(recovered.processes.size, 0);
});

test('a clock or a caller that misbehaves does not reach the request either', (t) => {
  const directory = scratch(t);
  let broken = false;
  const log = createRequestLog({ directory, boot: 'boot-a', now: () => { if (broken) throw new Error('synthetic clock failure'); return new Date(0); } });
  broken = true;
  const end = log.begin(info);
  end.identify({ name: 'get_nodes' });
  end();
  assert.ok(log.takeFailures() >= 1);
  log.close();
});

test('names are cut to a bound; the line never grows with what a caller sends', (t) => {
  const directory = scratch(t);
  const log = createRequestLog({ directory, boot: 'boot-a', now: clock() });
  log.begin({ ...info, name: 'x'.repeat(5000) });
  assert.equal((lines(directory).at(-1)!.name as string).length, 200);
  log.close();
});

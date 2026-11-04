// Crash reports: the fixture is synthetic and has the shape Node 24 writes under heap exhaustion.
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { MAX_REPORT_FILES, readNewReports, retireReports, summarizeReport } from './reports.ts';

const FIXTURE = readFileSync(new URL('./fixtures/report.synthetic.json', import.meta.url), 'utf8');

function scratch(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'circle-hub-reports-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

const name = (index: number) => `report.20260102.0304${String(index % 60).padStart(2, '0')}.${4000 + index}.0.001.json`;

test('a report is reduced to its reason, heap and resource usage; nothing else of it is kept', () => {
  const summary = summarizeReport('report.20260102.030405.4242.0.001.json', JSON.parse(FIXTURE));
  assert.deepEqual(summary, {
    file: 'report.20260102.030405.4242.0.001.json',
    readable: true,
    event: 'Allocation failed - JavaScript heap out of memory',
    trigger: 'OOMError',
    dumped_at: '2026-01-02T03:04:05.678Z',
    pid: 4242,
    node_version: 'v24.22.0',
    heap: { used_bytes: 2197815296, total_bytes: 2252341248, available_bytes: 42000000, limit_bytes: 2248146944 },
    resource_usage: { rss_bytes: 2431647744, max_rss_bytes: 2431647744, user_cpu_seconds: 512.25, kernel_cpu_seconds: 38.5, free_memory_bytes: 218906624, available_memory_bytes: 15057698816, total_memory_bytes: 17179869184 },
  });
  const kept = JSON.stringify(summary);
  for (const left of ['synthetic-host', '192.0.2.10', '/synthetic/hub', 'commandLine', 'sharedObjects', 'libuv']) assert.ok(!kept.includes(left), left);
});

test('the time is the report\'s timestamp: its dumpEventTime is local time marked as UTC', () => {
  const report = JSON.parse(FIXTURE) as { header: { dumpEventTime: string; dumpEventTimeStamp: string } };
  assert.notEqual(new Date(report.header.dumpEventTime).toISOString(), new Date(Number(report.header.dumpEventTimeStamp)).toISOString());
  assert.equal(summarizeReport('x', report).dumped_at, new Date(Number(report.header.dumpEventTimeStamp)).toISOString());
});

test('text is cut, numbers are checked, and anything missing is null rather than guessed', () => {
  const summary = summarizeReport('x', { header: { event: 'e'.repeat(1000), trigger: 7, processId: 'one', dumpEventTimeStamp: 'never' }, javascriptHeap: { usedMemory: 'many', memoryLimit: 5 }, resourceUsage: null });
  assert.equal(summary.event?.length, 200);
  assert.equal(summary.trigger, null);
  assert.equal(summary.pid, null);
  assert.equal(summary.dumped_at, null);
  assert.deepEqual(summary.heap, { used_bytes: null, total_bytes: null, available_bytes: null, limit_bytes: 5 });
  assert.equal(summary.resource_usage, null);
});

test('only report files are read; a torn or oversized one is kept as the fact that it exists, with its process from its name', async (t) => {
  const directory = scratch(t);
  writeFileSync(join(directory, 'report.20260102.030405.4242.0.001.json'), FIXTURE);
  writeFileSync(join(directory, 'report.20260102.030406.4343.0.001.json'), FIXTURE.slice(0, 200));
  writeFileSync(join(directory, 'report.20260102.030407.4444.0.001.json'), Buffer.alloc(5 * 1024 * 1024, 0x20));
  writeFileSync(join(directory, 'report.20260102.030408.4545.0.001.json'), '[]');
  writeFileSync(join(directory, 'something-else.json'), FIXTURE);
  writeFileSync(join(directory, 'report.20260102.030409.4646.0.001.json.ingested'), FIXTURE);
  const { reports, skipped } = await readNewReports(directory);
  assert.deepEqual(skipped, []);
  assert.deepEqual(reports!.map((report) => [report.pid, report.readable]).sort(), [[4242, true], [4343, false], [4444, false], [4545, false]]);
});

test('new reports are read once: retired files are not read again, and their number stays bounded', async (t) => {
  const directory = scratch(t);
  const total = MAX_REPORT_FILES + 5;
  for (let index = 0; index < total; index += 1) {
    writeFileSync(join(directory, name(index)), FIXTURE);
    utimesSync(join(directory, name(index)), 1_700_000_000 + index, 1_700_000_000 + index);
  }
  const { reports, skipped } = await readNewReports(directory);
  assert.equal(reports!.length, MAX_REPORT_FILES, 'at most this many are read');
  assert.equal(skipped.length, 5);
  assert.equal(reports![0]!.file, name(total - 1), 'the newest first');
  assert.ok(skipped.includes(name(0)), 'the oldest are the ones skipped');
  await retireReports(directory, [...reports!.map((report) => report.file), ...skipped]);
  const left = readdirSync(directory);
  assert.equal(left.length, MAX_REPORT_FILES);
  assert.ok(left.every((file) => file.endsWith('.json.ingested')));
  assert.ok(left.includes(`${name(total - 1)}.ingested`), 'the newest stay');
  assert.ok(!left.includes(`${name(0)}.ingested`), 'the oldest go');
  assert.deepEqual(await readNewReports(directory), { reports: [], skipped: [] }, 'nothing new at the next start');
});

test('a report directory that cannot be read is unknown; retiring in it never throws', async (t) => {
  const directory = scratch(t);
  const blocked = join(directory, 'blocked');
  writeFileSync(blocked, 'a file where the directory should be');
  assert.deepEqual(await readNewReports(blocked), { reports: null, skipped: [] });
  await retireReports(blocked, ['report.20260102.030405.4242.0.001.json']);
});

test('the directory is created when it is missing, for Node to write into later', async (t) => {
  const directory = join(scratch(t), 'logs', 'reports');
  assert.deepEqual(await readNewReports(directory), { reports: [], skipped: [] });
  assert.deepEqual(readdirSync(directory), []);
});

// `circle-hub run batch` (issue 32): the bounded loop that starts one run per listed object, with a scripted start_run.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Principal } from '../records/api.ts';
import { batchLines, boundedOption, objectsOf, startBatch, type BatchPlan } from './cli-run-batch.ts';

const admin: Principal = { id: 'usr_00000000000000000000000001', name: '合成管理员', role: 'admin' };
const plan = (objects: string[], extra: Partial<BatchPlan> = {}): BatchPlan => ({ pack: 'synthetic-facts', slot: 'map', objects, perRun: 1, concurrency: 2, intervalMs: 0, ...extra });
const ok = (run: string, result = true) => ({ call_result: 'ok', errors: [], run: { run }, ...(result ? { result: { reference: `rec:${'a'.repeat(64)}` } } : {}) }) as never;
const refused = (code: string) => ({ call_result: 'error', errors: [{ code, message: `合成：${code}`, fix: '合成' }] }) as never;

test('a list of objects is one id per line: blank lines and comments are skipped, a repeated id is started once', () => {
  assert.deepEqual(objectsOf('# 合成清单\r\ntoy:mindmap:1\n\n  toy:mindmap:2  \ntoy:mindmap:1\n#toy:mindmap:3\n'), ['toy:mindmap:1', 'toy:mindmap:2']);
  assert.deepEqual(objectsOf('\n# only a comment\n'), []);
});

test('every object gets one start_run as the administrator, with the slot bound to it, never more than the limit at a time', async () => {
  const objects = Array.from({ length: 9 }, (_, n) => `toy:mindmap:${n}`);
  const seen: Array<{ user: string; input: unknown; session: string | null }> = [];
  let running = 0, most = 0;
  const summary = await startBatch(async (user, input, context) => {
    seen.push({ user: user.id, input, session: context.sessionId });
    assert.match(context.traceId, /\S/);
    most = Math.max(most, ++running);
    await new Promise((resolve) => setTimeout(resolve, 5));
    running--;
    return ok(`run_${String(seen.length).padStart(26, '0')}`);
  }, admin, plan(objects, { concurrency: 3, product: 'Meadow', version: '2.1' }));
  assert.equal(most, 3, 'three at a time, the limit');
  assert.equal(seen.length, 9);
  assert.ok(seen.every((call) => call.user === admin.id && call.session === null));
  assert.deepEqual(seen.map((call) => call.input).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    objects.map((object) => ({ pack: 'synthetic-facts', product: 'Meadow', version: '2.1', inputs: { map: { external: object } } })));
  assert.deepEqual({ objects: summary.objects, total: summary.total, started: summary.started, failed: summary.failed, by_code: summary.by_code }, { objects: 9, total: 9, started: 9, failed: 0, by_code: [] });
  assert.deepEqual(summary.rows.map((row) => row.objects), objects.map((object) => [object]), 'the rows keep the order of the file');
});

test('a refused or failing start is that object\'s failure: the others go on and the summary counts the causes', async () => {
  const summary = await startBatch(async (_user, input) => {
    const object = (input.inputs.map as { external: string }).external;
    if (object.endsWith(':2')) return refused('SOURCE_ABSENT');
    if (object.endsWith(':3')) throw new Error('合成：连接断开');
    if (object.endsWith(':4')) return refused('SOURCE_ABSENT');
    if (object.endsWith(':5')) return ok('run_00000000000000000000000005', false);
    return ok('run_00000000000000000000000001');
  }, admin, plan(['toy:mindmap:1', 'toy:mindmap:2', 'toy:mindmap:3', 'toy:mindmap:4', 'toy:mindmap:5']));
  assert.deepEqual({ total: summary.total, started: summary.started, failed: summary.failed }, { total: 5, started: 2, failed: 3 });
  assert.deepEqual(summary.by_code, [{ code: 'SOURCE_ABSENT', count: 2 }, { code: 'error', count: 1 }]);
  assert.deepEqual(summary.rows.map((row) => row.run !== undefined), [true, false, false, false, true]);
  const lines = batchLines(summary, { perRun: 1, concurrency: 2, intervalMs: 0 });
  assert.match(lines[0], /^共 5 个对象、5 次运行：开始并得到结果 1 次，开始但没有结果 1 次，没有开始 3 次$/);
  assert.match(lines[1], /（每次运行 1 个，并发 2，间隔 0 毫秒）；按这个速度 100 个对象约 /);
  assert.equal(lines[2], '没有开始的原因：SOURCE_ABSENT 2 次，error 1 次');
  assert.deepEqual(lines.slice(3), ['- 没有开始 toy:mindmap:2：SOURCE_ABSENT 合成：SOURCE_ABSENT', '- 没有开始 toy:mindmap:3：error 合成：连接断开', '- 没有开始 toy:mindmap:4：SOURCE_ABSENT 合成：SOURCE_ABSENT']);
});

test('no two starts are closer than the interval, whatever the concurrency; the estimate for a hundred follows the measured pace', async () => {
  let clock = 0;
  const starts: number[] = [];
  const summary = await startBatch(async () => { starts.push(clock); return ok('run_00000000000000000000000001'); }, admin, plan(['a:b:1', 'a:b:2', 'a:b:3', 'a:b:4'], { concurrency: 4, intervalMs: 250 }), {
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  });
  assert.deepEqual(starts, [0, 250, 500, 750]);
  assert.deepEqual({ elapsed: summary.elapsed_ms, each: summary.per_object_ms, hundred: summary.hundred_ms }, { elapsed: 750, each: 188, hundred: 18750 });
});

test('a numeric option is a whole number within its bounds, or the default', () => {
  const fail = (message: string) => new Error(message);
  assert.equal(boundedOption('--concurrency', undefined, 2, 1, 8, fail), 2);
  assert.equal(boundedOption('--concurrency', '8', 2, 1, 8, fail), 8);
  for (const bad of ['0', '9', '-1', '2.5', '', 'two', '02']) assert.throws(() => boundedOption('--concurrency', bad, 2, 1, 8, fail), /--concurrency 要 1 到 8 的整数/, bad);
});

test('a slot that takes many gets its objects in groups: one run per group, the last one smaller, and a failed group names all its objects', async () => {
  const objects = Array.from({ length: 7 }, (_, n) => `toy:mindmap:${n}`);
  const inputs: unknown[] = [];
  const summary = await startBatch(async (_user, input) => {
    inputs.push(input.inputs.map);
    return inputs.length === 2 ? refused('SUBMISSION_SCHEMA_VIOLATION') : ok(`run_${String(inputs.length).padStart(26, '0')}`);
  }, admin, plan(objects, { perRun: 3, concurrency: 1 }));
  assert.deepEqual(inputs, [objects.slice(0, 3), objects.slice(3, 6), objects.slice(6)].map((group) => group.map((external) => ({ external }))));
  assert.deepEqual({ objects: summary.objects, total: summary.total, started: summary.started, failed: summary.failed }, { objects: 7, total: 3, started: 2, failed: 1 });
  assert.deepEqual(summary.rows[1].objects, objects.slice(3, 6));
  const lines = batchLines(summary, { perRun: 3, concurrency: 1, intervalMs: 0 });
  assert.match(lines[0], /^共 7 个对象、3 次运行：开始并得到结果 2 次，开始但没有结果 0 次，没有开始 1 次$/);
  assert.equal(lines.at(-1), '- 没有开始 toy:mindmap:3 等 3 个：SUBMISSION_SCHEMA_VIOLATION 合成：SUBMISSION_SCHEMA_VIOLATION');
});

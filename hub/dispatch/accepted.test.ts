// Decision 105 (W03, D06): the Hub dispatches an accepted run whose release holds, as the runner's run with a named
// administrator responsible for unknown outcomes, at most once; the runner reads the jobs' progress. Synthetic executor only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setup } from './testing/context.ts';
import { acceptedDispatch } from './accepted.ts';
import { definition } from './testing/definition.ts';
import { readRunJobs } from './read-runs.ts';
import type { ActionBody } from '../records/api.ts';

type C = Awaited<ReturnType<typeof setup>>;
async function bindingOf(c: C, job: string): Promise<Record<string, unknown>> {
  const rows = await c.kit.store.findMany<ActionBody>({ kind: 'action', key: 'dispatch.phase', values: ['reservation'] });
  const found = rows.map((row) => row.body.detail.binding as Record<string, unknown>).find((binding) => binding?.job === job);
  assert.ok(found, 'reservation binding'); return found!;
}
async function settled(c: C) {
  for (let i = 0; i < 200; i++) { const jobs = await readRunJobs(c.kit, c.service, c.admin, c.run); if (jobs.length && jobs.every((job) => job.ended === 'done')) return jobs; await new Promise((resolve) => setTimeout(resolve, 50)); }
  throw new Error('the dispatched job did not complete');
}

test('the Hub dispatches an accepted run whose release holds, as the runner with a named administrator, once', async (t) => {
  const c = await setup(); t.after(() => c.close());
  const first = await c.service.dispatchAccepted(c.run);
  assert.equal(first.started, true, JSON.stringify(first)); assert.equal(first.executor, c.executor.id);
  const binding = await bindingOf(c, first.status!.job);
  assert.equal(binding.initiated_by, c.owner.id); assert.equal(binding.acting_by, c.admin.id);
  const again = await c.service.dispatchAccepted(c.run);
  assert.equal(again.started, false, JSON.stringify(again));
  assert.equal(c.calls.filter((call) => call === 'send_blob').length, 1);
});

test('without an enabled administrator, or when the release does not hold, the Hub dispatches nothing and says why', async (t) => {
  const c = await setup(); t.after(() => c.close());
  const list = c.kit.principals.list.bind(c.kit.principals);
  c.kit.principals.list = async (...args: Parameters<typeof list>) => (await list(...args)).filter((p) => p.role !== 'admin');
  const lonely = await c.service.dispatchAccepted(c.run);
  assert.equal(lonely.started, false); assert.match(lonely.reason ?? '', /没有在职管理员/);
  c.kit.principals.list = list;
  c.detail.latest!.result.errors.push({ code: 'SOURCE_UNAVAILABLE', message: 'synthetic' });
  const held = await c.service.dispatchAccepted(c.run);
  assert.equal(held.started, false); assert.match(held.reason ?? '', /放行条件尚未全部满足/);
  assert.equal(c.calls.includes('send_blob'), false);
});

test('a dispatch refused at the effect boundary before any reservation says that nothing was sent and why', async (t) => {
  // The lease on the target belongs to another lineage, as when the run's own booking does not cover the executor's target.
  const c = await setup({ mode: 'lineage' }); t.after(() => c.close());
  const [note] = await acceptedDispatch(c.kit, c.service, c.run, true);
  assert.ok(note?.job, JSON.stringify(note)); assert.match(note.text, /^Hub 没有派发：/); assert.doesNotMatch(note.text, /已派发|已按任务包/);
  for (const key of definition('x').resources) assert.ok(note.text.includes(key), `the refusal names the uncovered key ${key}: ${note.text}`);
  assert.equal(c.calls.includes('send_blob'), false);
  const [again] = await acceptedDispatch(c.kit, c.service, c.run, true);
  assert.equal(again.job, note.job, JSON.stringify(again)); assert.match(again.text, /已结束/); assert.match(again.text, /原因：/);
});

test('the accepted answer reports the reserved job, then a repeat reads its progress and result reference', async (t) => {
  const c = await setup(); t.after(() => c.close());
  assert.deepEqual(await acceptedDispatch(c.kit, c.service, c.run, false), []);
  const reserved = await acceptedDispatch(c.kit, c.service, c.run, true);
  assert.equal(reserved.length, 1, JSON.stringify(reserved)); assert.ok(reserved[0].job); assert.match(reserved[0].text, /已按任务包的效果行派发作业/);
  const [job] = await settled(c);
  const progress = await acceptedDispatch(c.kit, c.service, c.run, true);
  assert.equal(progress.length, 1); assert.equal(progress[0].job, job.job);
  assert.match(progress[0].text, /阶段 complete/);
  assert.equal(c.calls.filter((call) => call === 'send_blob').length, 1);
});

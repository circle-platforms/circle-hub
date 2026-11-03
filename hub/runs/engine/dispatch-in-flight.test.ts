// Decision 105 read the way CES reads a running task (compile-excel SKILL.md §9: read the task by its id, never resubmit):
// a run whose release requirement is open does not try to dispatch; while a job of the run has not ended, the same
// submission reads progress and a different one is kept as received but not validated. Toy pack, scripted dispatch port.
import { createTestParserRegistry } from '../../testing/parsers.ts';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startPostgres, type TemporaryPostgres } from '../../testing/postgres.ts';
import { createRunsService } from './api.ts';
import { openRetryHarness } from './testing/retry-harness.ts';
import { sandboxSkip } from './testing/harness.ts';
import { standardDocument, toyMap } from './testing/mindmap.ts';
let pg: TemporaryPostgres; let h: Awaited<ReturnType<typeof openRetryHarness>>; const skip = await sandboxSkip();
before(async () => { pg = await startPostgres(); if (!skip) h = await openRetryHarness(pg); });
after(async () => { await h?.close(); await pg?.stop(); });

const effect = (requirements: string[]) => ({ id: 'synthetic_submit', resource_kind: 'executor', action: 'submit', effect_class: 'job', parameters: {}, release: { requirements, artifact: requirements[0] }, trigger: 'hub_template', budget: { count: 1 }, deadline_ms: 86400000, optional: false, policy_checks: [] });

test('an accepted run tries to dispatch only once the release requirements its items list are satisfied; while its job runs, a different submission is kept but not validated', { skip }, async (t) => {
  const original = h.review.effects; t.after(() => { (h.review as { effects?: unknown }).effects = original; });
  const start = async () => (await h.service.startRun(h.alice, { pack: 'toy-review', product: 'Meadow', version: '10.6.1', build: 'Rel_MEADOW_10_6_1_7', inputs: { map: { reference: await h.upload(h.alice, toyMap(standardDocument())) } } }, h.call())).run!;
  const submission = (run: { run: string; items: Array<{ id: string }> }, model: string) => ({ run: run.run, model, items: run.items.map((i) => ({ item: i.id, handling: 'handled', slots: { findings: [] } })), cross_item: [{ nature: 'judgment', statement: '合成等级', grounds: [], code: 'draft_level', rank: 'P4' }] });
  const ready: boolean[] = []; let flight: { jobs: string[]; notes: Array<{ job?: string; text: string }> } | null = null;
  const job = 'c'.repeat(64);
  const service = createRunsService({ parsers: createTestParserRegistry(), records: h.kit, workflows: h.workflows, packs: h.packs, knowledge: h.knowledge, external: h.external,
    dispatch: { jobs: async () => [], reconcile: async () => { throw new Error('合成：不对账'); }, accepted: async (_run, value) => { ready.push(value); return value ? [{ job, text: '合成：已派发' }] : []; }, inFlight: async () => flight } });

  // Which requirements the toy submission satisfies, read from a run without an effect row.
  const probe = await start();
  const probed = await service.submitResult(h.alice, submission(probe, 'synthetic'), h.call('probe-session'));
  assert.equal(probed.acceptance, 'accepted', JSON.stringify(probed.errors));
  const delivered = probed.result!.partitions.delivered;
  const keys = [...new Set(delivered.flatMap((item) => item.requirements.map((row) => row.requirement)))];
  const statusOf = (key: string) => delivered.map((item) => item.requirements.find((row) => row.requirement === key)?.status);
  const done = keys.find((key) => statusOf(key).every((status) => status === 'satisfied')), open = keys.find((key) => statusOf(key).some((status) => status !== 'satisfied'));
  assert.ok(done && open, JSON.stringify(keys.map((key) => [key, statusOf(key)])));

  // A release requirement the items list that is not satisfied (the plan run's workbook check): no dispatch is tried.
  (h.review as { effects?: unknown }).effects = [effect([open!])];
  const planned = await service.submitResult(h.alice, submission(await start(), 'synthetic'), h.call('plan-session'));
  assert.equal(planned.acceptance, 'accepted'); assert.equal(planned.dispatch, undefined, JSON.stringify(planned.dispatch)); assert.deepEqual(ready, [false]);

  (h.review as { effects?: unknown }).effects = [effect([done!])];
  const run = await start();
  const verified = await service.submitResult(h.alice, submission(run, 'synthetic'), h.call('verify-session'));
  const shape = (answer: typeof verified) => JSON.stringify({ errors: answer.result?.errors, items: run.items.length, partitions: Object.fromEntries(Object.entries(answer.result?.partitions ?? {}).map(([key, list]) => [key, (list as Array<{ item: string; requirements?: Array<{ requirement: string; status: string }> }>).map((row) => [row.item, row.requirements?.map((r) => `${r.requirement}:${r.status}`)])])) });
  assert.equal(verified.acceptance, 'accepted'); assert.deepEqual(ready, [false, true], shape(verified)); assert.equal(verified.dispatch?.[0]?.job, job);
  const latest = (await service.getRun(h.alice, run.run))!.latest!.record;

  // The job runs: a different submission is stored as received, refused without a validation, and the job's notes come back.
  flight = { jobs: [job], notes: [{ job, text: '合成：作业进行中' }] };
  const different = await service.submitResult(h.alice, submission(run, 'synthetic-other'), h.call('verify-session'));
  assert.equal(different.call_result, 'error'); assert.equal(different.errors[0].code, 'IDEMPOTENCY_MISMATCH', JSON.stringify(different.errors));
  assert.match(different.errors[0].message, /没有核验，派发不受影响/); assert.deepEqual(different.dispatch, flight.notes);
  const detail = (await service.getRun(h.alice, run.run))!;
  assert.equal(detail.latest!.record, latest, 'the latest accepted result is the one the job took');
  assert.equal(detail.submissions.length, 2, 'the different submission is kept as received');
  assert.equal(detail.submissions.at(-1)!.acceptance, 'not_accepted');

  // The same submission from another session reads progress from the stored result: no new validation.
  const same = await service.submitResult(h.alice, submission(run, 'synthetic'), h.call('another-session'));
  assert.equal(same.acceptance, 'accepted', JSON.stringify(same.errors)); assert.ok(same.dispatch?.length, JSON.stringify(same));
  assert.equal((await service.getRun(h.alice, run.run))!.latest!.record, latest);
});

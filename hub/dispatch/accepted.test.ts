// Decision 105 (W03, D06): the Hub dispatches an accepted run whose release holds, as the runner's run with a named
// administrator responsible for unknown outcomes, at most once; the runner reads the jobs' progress. Synthetic executor only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setup } from './testing/context.ts';
import { setupJournal } from './testing/journal.ts';
import { acceptedDispatch, MAX_NOTE_TEXT, MAX_NOTES, runnerNote } from './accepted.ts';
import { definition } from './testing/definition.ts';
import { readRunJobs } from './read-runs.ts';
import type { ActionBody } from '../records/api.ts';
import type { JobStatus } from './service.ts';

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
  // The release check that does not hold is named by its fixed label; no administrator command.
  assert.match(held.reason ?? '', /核验结果没有未消除错误/); assert.doesNotMatch(held.reason ?? '', /circle-hub|job dispatch/);
  assert.equal(c.calls.includes('send_blob'), false);
});

test('a refusal at the final boundary, after the target was reached, is read and never tried again', async (t) => {
  const c = await setup(); t.after(() => c.close());
  // The executor changes after the verification run froze its snapshot, as at every release of the pack: the final boundary
  // refuses after the connector session, the precheck and the probes.
  await c.registry.update(c.admin, c.executor.id, { ...c.executor.definition, limitations: ['合成：核验运行之后更新的执行器'] });
  const [first] = await acceptedDispatch(c.kit, c.service, c.run, true);
  assert.ok(first?.job, JSON.stringify(first));
  const [job] = await settled(c);
  assert.equal(job.job, first.job); assert.equal(job.status.outcome, 'not_dispatched'); assert.equal(job.boundary_refused, false);
  assert.ok(c.calls.length > 0 && !c.calls.includes('send_blob'), JSON.stringify(c.calls));
  const reached = c.calls.length;
  const again = await acceptedDispatch(c.kit, c.service, c.run, true);
  assert.equal(again.length, 1, JSON.stringify(again)); assert.equal(again[0].job, first.job, 'the refused job is read, no new job');
  assert.match(again[0].text, /不会再派发/); assert.doesNotMatch(again[0].text, /circle-hub/);
  assert.equal(c.calls.length, reached, 'a repeat does not reach the target again');
});

test('the notes of a run stay within the answer limits: the newest, after a line counting the older', async (t) => {
  const c = await setup({ mode: 'lineage' }); t.after(() => c.close());
  for (let i = 0; i < 18; i++) await acceptedDispatch(c.kit, c.service, c.run, true);
  const notes = await acceptedDispatch(c.kit, c.service, c.run, false);
  assert.equal(notes.length, MAX_NOTES, JSON.stringify(notes.map((note) => note.text)));
  assert.match(notes[0].text, /另有 3 个更早的作业/);
  for (const note of notes) assert.ok(note.text.length <= MAX_NOTE_TEXT, note.text);
  assert.equal(c.calls.includes('send_blob'), false);
});

test('the runner note names no administrator command in any job state', () => {
  const job = 'a'.repeat(64);
  const status = (extra: Record<string, unknown>) => ({ job, phase: 'synthetic', outcome: 'unknown', frozen: false, events: 3, next_action: `circle-hub job resume ${job}`, ...extra }) as unknown as JobStatus;
  const rows: Array<{ ended: 'done' | 'unknown' | null; boundary_refused?: boolean; status: JobStatus; expect: RegExp }> = [
    { ended: null, status: status({}), expect: /还在进行/ },
    { ended: 'unknown', status: status({ frozen: true, request_id: 'synthetic-intent:1' }), expect: /派发结果未确认.*请求号 synthetic-intent:1.*不要重交.*管理员 admin-1 处置/ },
    { ended: 'done', status: status({ outcome: 'not_dispatched', reason: '合成：缺整个自动化测试环境的租约' }), expect: /不会再派发/ },
    { ended: 'done', boundary_refused: true, status: status({ outcome: 'not_dispatched', reason: '合成：缺整个自动化测试环境的租约' }), expect: /Hub 会再试一次/ },
    { ended: 'done', status: status({ outcome: 'not_dispatched', not_sent: true, reason: '合成：目标没有给出租约' }), expect: /未发出.*原因：合成：目标没有给出租约.*什么都没有发到目标.*Hub 会再试一次/ },
    { ended: 'done', status: status({ outcome: 'target_rejected', rejection_stage: 'admission' }), expect: /目标拒绝.*目标在“admission”阶段拒绝.*修正后原样重交，Hub 会再试一次/ },
    { ended: 'done', status: status({ outcome: 'proven_not_executed' }), expect: /已证明目标没有执行；原样重交，Hub 会再试一次/ },
    { ended: 'done', status: status({ outcome: 'target_rejected', decided_by: 'admin-1' }), expect: /管理员已处置这个作业/ },
    { ended: 'done', status: status({ outcome: 'effective', result: `src:${'b'.repeat(64)}` }), expect: /读结果引用看逐条结论/ },
    { ended: 'done', status: status({ outcome: 'effective', result: `src:${'b'.repeat(64)}`, missing_fact: '合成：缺归属认证' }), expect: /部分条目没有判定/ },
  ];
  for (const row of rows) {
    const note = runnerNote({ job, boundary_refused: row.boundary_refused ?? false, ended: row.ended, status: row.status }, 'admin-1');
    assert.match(note.text, row.expect); assert.doesNotMatch(note.text, /circle-hub|job resume|job dispose/);
  }
});

test('before anything is sent the reference is called the pre-dispatch checks, never the results of the cases (decision 116)', () => {
  const job = 'a'.repeat(64);
  const status = (extra: Record<string, unknown>) => ({ job, phase: 'device_probe', outcome: 'not_dispatched', frozen: false, events: 3, result: `src:${'c'.repeat(64)}`, ...extra }) as unknown as JobStatus;
  const early = runnerNote({ job, boundary_refused: false, ended: null, status: status({}) }, 'admin-1').text;
  assert.match(early, /派发前核对的结论 src:c{64}（逐台设备的版本和接口核对，不是用例在设备上的结果：用例还没有发到设备）/);
  assert.doesNotMatch(early, /结果引用|逐条结论/);
  const done = runnerNote({ job, boundary_refused: false, ended: 'done', status: status({ outcome: 'effective', phase: 'done' }) }, 'admin-1').text;
  assert.match(done, /结果引用 src:c{64}（每个派发条目一行/);
});

test('a dispatch refused at the effect boundary before any reservation says that nothing was sent and why', async (t) => {
  // The lease on the target belongs to another lineage, as when the run's own booking does not cover the executor's target.
  const c = await setup({ mode: 'lineage' }); t.after(() => c.close());
  const [note] = await acceptedDispatch(c.kit, c.service, c.run, true);
  assert.ok(note?.job, JSON.stringify(note)); assert.match(note.text, /^Hub 没有派发：/); assert.doesNotMatch(note.text, /已派发|已按任务包/);
  for (const key of definition('x').resources) assert.ok(note.text.includes(key), `the refusal names the uncovered key ${key}: ${note.text}`);
  assert.equal(c.calls.includes('send_blob'), false);
  const [again] = await acceptedDispatch(c.kit, c.service, c.run, false);
  assert.equal(again.job, note.job, JSON.stringify(again)); assert.match(again.text, /已结束/); assert.match(again.text, /原因：/);
  // Once the run's own lineage holds the target, a repeat of the ready submission dispatches: the refusal sent nothing.
  const keys = definition('x').resources;
  await c.leases.forceRelease({ keys, by: c.admin.id, reason: '合成：改由本运行的谱系持有' });
  await c.leases.acquire({ keys, prefix: 'synthetic/', ttlSeconds: 3600, maxTtlSeconds: 3600, holder: { user: c.owner.id, run: c.run } });
  // The answer that tries again first says what the refused job came to (issue 142), then reports the new one.
  const [earlier, retried] = await acceptedDispatch(c.kit, c.service, c.run, true);
  assert.equal(earlier.job, note.job); assert.match(earlier.text, /未发出；原因：/); assert.match(earlier.text, /这次重交 Hub 已再试/);
  assert.ok(retried.job && retried.job !== note.job, JSON.stringify(retried)); assert.match(retried.text, /已再次按任务包的效果行派发作业/);
  await settled(c);
  assert.equal(c.calls.filter((call) => call === 'send_blob').length, 1);
  const [after] = (await acceptedDispatch(c.kit, c.service, c.run, true)).filter((row) => row.job === retried.job);
  assert.ok(after, 'a dispatched job is read, never dispatched again');
  assert.equal(c.calls.filter((call) => call === 'send_blob').length, 1);
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

// Issue 142 (decision 155): a dispatch that went wrong comes back in the answer of the submission that triggered it.
async function ended(c: C, count: number) {
  for (let i = 0; i < 200; i++) { const jobs = await readRunJobs(c.kit, c.service, c.admin, c.run, { unbound: true }); if (jobs.length >= count && jobs.every((job) => job.ended !== null)) return jobs; await new Promise((resolve) => setTimeout(resolve, 50)); }
  throw new Error('the dispatched jobs did not end');
}

for (const [mode, reason] of [['busy', /原因：目标拒绝了提交之前的调用（取得租约或只读核对）/], ['build', /未满足的条件：\/build equals/]] as const) {
  test(`not sent (${mode}): the next answer says why and the same submission dispatches again`, async (t) => {
    const c = await setup({ mode }); t.after(() => c.close());
    const [first] = await acceptedDispatch(c.kit, c.service, c.run, true);
    assert.ok(first?.job, JSON.stringify(first));
    const [job] = await ended(c, 1);
    assert.deepEqual({ ended: job.ended, outcome: job.status.outcome, not_sent: job.status.not_sent, refused: job.boundary_refused }, { ended: 'done', outcome: 'not_dispatched', not_sent: true, refused: false });
    assert.equal(c.calls.includes('send_blob'), false, 'nothing was submitted');
    const reached = c.calls.length;
    const again = await acceptedDispatch(c.kit, c.service, c.run, true);
    assert.equal(again.length, 2, JSON.stringify(again));
    assert.equal(again[0].job, first.job);
    assert.match(again[0].text, /未发出/); assert.match(again[0].text, reason); assert.match(again[0].text, /这次重交 Hub 已再试/);
    assert.ok(again[1].job && again[1].job !== first.job, 'a new job'); assert.match(again[1].text, /已再次按任务包的效果行派发作业/);
    for (const note of again) assert.doesNotMatch(note.text, /circle-hub|job resume|job dispose|192\.0\.2\./, 'no administrator command and nothing of the target');
    await ended(c, 2);
    assert.ok(c.calls.length > reached, 'the repeat reached the target again');
    assert.equal(c.calls.includes('send_blob'), false);
    // A submission that is not ready only reads: it starts nothing.
    const read = await acceptedDispatch(c.kit, c.service, c.run, false);
    assert.equal(read.length, 2); assert.match(read[1].text, /什么都没有发到目标；原因消除后原样重交，Hub 会再试一次/);
  });
}

test('not sent (the target cannot be reached): the reason names no address, and the same submission dispatches again', async (t) => {
  const c = await setup(); t.after(() => c.close());
  await c.endpoint.close();
  const first = await acceptedDispatch(c.kit, c.service, c.run, true);
  const [job] = await ended(c, 1);
  assert.deepEqual({ ended: job.ended, outcome: job.status.outcome, not_sent: job.status.not_sent }, { ended: 'done', outcome: 'not_dispatched', not_sent: true }, JSON.stringify(job.status));
  assert.equal(job.status.reason, '目标没有给出完整应答：连不上、超时或应答超限');
  const again = await acceptedDispatch(c.kit, c.service, c.run, true);
  assert.equal(again.length, 2, JSON.stringify(again));
  assert.match(again[0].text, /未发出；原因：目标没有给出完整应答：连不上、超时或应答超限/);
  assert.ok(again[1].job && again[1].job !== job.job);
  for (const note of [...first, ...again]) assert.doesNotMatch(note.text, /127\.0\.0\.1|localhost|ECONN|circle-hub/);
  await ended(c, 2);
});

test('rejected by the target with a certified stage: the answer names the stage and the same submission dispatches again', async (t) => {
  const c = await setupJournal({ lost: true, rejected: true }); t.after(() => c.close());
  const [first] = await acceptedDispatch(c.kit, c.service, c.run, true);
  assert.ok(first?.job, JSON.stringify(first));
  const [job] = await ended(c, 1);
  assert.deepEqual({ ended: job.ended, outcome: job.status.outcome, frozen: job.status.frozen, stage: job.status.rejection_stage }, { ended: 'done', outcome: 'target_rejected', frozen: false, stage: 'admission' });
  assert.equal(c.calls.filter((name) => name === 'send_blob').length, 1);
  const again = await acceptedDispatch(c.kit, c.service, c.run, true);
  assert.equal(again.length, 2, JSON.stringify(again));
  assert.match(again[0].text, /目标拒绝；目标在“admission”阶段拒绝/); assert.match(again[0].text, /这次重交 Hub 已再试/);
  assert.ok(again[1].job && again[1].job !== first.job);
  await ended(c, 2);
  assert.equal(c.calls.filter((name) => name === 'send_blob').length, 2, 'the repeat submitted once more');
});

test('sent without an answer: the note gives the request id, forbids a resend and no repeat sends again', async (t) => {
  const c = await setup({ mode: 'lost' }); t.after(() => c.close());
  const [first] = await acceptedDispatch(c.kit, c.service, c.run, true);
  assert.ok(first?.job, JSON.stringify(first));
  const [job] = await ended(c, 1);
  assert.deepEqual({ ended: job.ended, outcome: job.status.outcome, frozen: job.status.frozen }, { ended: 'unknown', outcome: 'unknown', frozen: true });
  assert.ok(job.status.request_id, 'the request id of the submit intent');
  assert.equal(job.status.requests?.length, 1, 'the unresolved outcome is a request to the administrator');
  const sent = c.calls.filter((name) => name === 'send_blob').length, reached = c.calls.length;
  for (const ready of [true, false]) {
    const again = await acceptedDispatch(c.kit, c.service, c.run, ready);
    assert.equal(again.length, 1, JSON.stringify(again)); assert.equal(again[0].job, first.job);
    assert.match(again[0].text, /派发结果未确认/); assert.ok(again[0].text.includes(`请求号 ${job.status.request_id}`));
    assert.match(again[0].text, /不要重交，也不要另开运行重发，目标可能已经执行过一次/);
    assert.ok(again[0].text.includes(`管理员 ${c.admin.id} 处置（期限 ${job.status.requests![0].deadline}）`));
    assert.doesNotMatch(again[0].text, /circle-hub|job resume|job dispose/);
  }
  assert.equal(c.calls.filter((name) => name === 'send_blob').length, sent, 'nothing is sent again');
  assert.equal(c.calls.length, reached, 'and a read of the progress does not reach the target');
  assert.equal((await readRunJobs(c.kit, c.service, c.admin, c.run, { unbound: true })).length, 1);
});

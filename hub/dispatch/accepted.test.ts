import { isAdmin } from '../records/api.ts';
// Decision 105 (W03, D06): the Hub dispatches an accepted run whose release holds, as the runner's run with a named
// administrator responsible for unknown outcomes, at most once; the runner reads the jobs' progress. Synthetic executor only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SubmitResultOutput, TOOLS } from '../../contracts/src/tools.ts';
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
  c.kit.principals.list = async (...args: Parameters<typeof list>) => (await list(...args)).filter((p) => !isAdmin(p));
  const lonely = await c.service.dispatchAccepted(c.run);
  assert.equal(lonely.started, false); assert.match(lonely.reason ?? '', /没有在职管理员/);
  c.kit.principals.list = list;
  c.detail.latest!.result.errors.push({ code: 'SOURCE_UNAVAILABLE', message: 'synthetic' });
  const held = await c.service.dispatchAccepted(c.run);
  assert.equal(held.started, false); assert.match(held.reason ?? '', /放行条件里有/);
  // The release check that does not hold is named by its fixed label; non-admin runner gets no CLI.
  assert.match(held.reason ?? '', /核验结果没有未消除错误/); assert.doesNotMatch(held.reason ?? '', /circle-hub|job dispatch|已记下|原样重交/);
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
  assert.match(again[0].text, /不会再做上机验证/); assert.doesNotMatch(again[0].text, /circle-hub/);
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
    { ended: 'unknown', status: status({ frozen: true, request_id: 'synthetic-intent:1' }), expect: /上机验证结果未知.*不要重交.*管理员处置/ },
    { ended: 'done', status: status({ outcome: 'not_dispatched', reason: '合成：缺整个自动化测试环境的租约' }), expect: /不会再做上机验证/ },
    { ended: 'done', boundary_refused: true, status: status({ outcome: 'not_dispatched', reason: '合成：缺整个自动化测试环境的租约' }), expect: /Hub 会再试一次/ },
    { ended: 'done', status: status({ outcome: 'not_dispatched', not_sent: true, reason: '合成：目标没有给出租约' }), expect: /未发出.*原因：本次上机前条件尚未满足.*什么都没有发到目标.*Hub 会再试一次/ },
    { ended: 'done', status: status({ outcome: 'target_rejected', rejection_stage: 'admission' }), expect: /目标拒绝.*目标在“admission”阶段拒绝.*修正后原样重交，Hub 会再试一次/ },
    { ended: 'done', status: status({ outcome: 'proven_not_executed' }), expect: /已证明目标没有执行；原样重交，Hub 会再试一次/ },
    { ended: 'done', status: status({ outcome: 'target_rejected', decided_by: 'admin-1' }), expect: /管理员已处置这个作业/ },
    { ended: 'done', status: status({ outcome: 'effective', result: `src:${'b'.repeat(64)}` }), expect: /读结果引用看逐条结论/ },
    { ended: 'done', status: status({ outcome: 'effective', result: `src:${'b'.repeat(64)}`, missing_fact: '合成：缺归属认证' }), expect: /部分条目没有判定/ },
  ];
  for (const row of rows) {
    const note = runnerNote({ job, boundary_refused: row.boundary_refused ?? false, ended: row.ended, status: row.status }, 'admin-1');
    assert.match(note.text, row.expect); assert.doesNotMatch(JSON.stringify(note), /circle-hub|job resume|job dispose|synthetic-intent:1|admin-1/);
  }
});

test('before anything is sent the reference is called the pre-dispatch checks, never the results of the cases (decision 116)', () => {
  const job = 'a'.repeat(64);
  const status = (extra: Record<string, unknown>) => ({ job, phase: 'device_probe', outcome: 'not_dispatched', frozen: false, events: 3, result: `src:${'c'.repeat(64)}`, ...extra }) as unknown as JobStatus;
  const early = runnerNote({ job, boundary_refused: false, ended: null, status: status({}) }, 'admin-1').text;
  assert.match(early, /上机验证前核对的结论 src:c{64}（逐台设备的版本和接口核对，不是用例在设备上的结果：用例还没有发到设备）/);
  assert.doesNotMatch(early, /结果引用|逐条结论/);
  const done = runnerNote({ job, boundary_refused: false, ended: 'done', status: status({ outcome: 'effective', phase: 'done' }) }, 'admin-1').text;
  assert.match(done, /结果引用 src:c{64}（每个派发条目一行/);
});

test('a dispatch refused at the effect boundary before any reservation says that nothing was sent and why', async (t) => {
  // The lease on the target belongs to another lineage, as when the run's own booking does not cover the executor's target.
  const c = await setup({ mode: 'lineage' }); t.after(() => c.close());
  const [note] = await acceptedDispatch(c.kit, c.service, c.run, true);
  assert.ok(note?.job, JSON.stringify(note)); assert.equal(note.outcome, 'not_dispatched'); assert.match(note.text, /未发出/); assert.doesNotMatch(note.text, /已派发|已按任务包/);
  assert.ok(note.missing_facts?.length, 'the member receives a missing prerequisite without raw administrator resource diagnostics');
  assert.doesNotMatch(JSON.stringify(note), /circle-hub|usr_|exe_/);
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
  assert.ok(retried.job && retried.job !== note.job, JSON.stringify(retried)); assert.match(retried.text, /已再次按任务包的效果行开始上机验证/);
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
  assert.equal(reserved.length, 1, JSON.stringify(reserved)); assert.ok(reserved[0].job); assert.match(reserved[0].text, /已按任务包的效果行开始上机验证/);
  const [job] = await settled(c);
  const progress = await acceptedDispatch(c.kit, c.service, c.run, true);
  assert.equal(progress.length, 1); assert.equal(progress[0].job, job.job);
  assert.match(progress[0].text, /阶段 complete/);
  assert.match(progress[0].text, /设备返回 src:[a-f0-9]{64}/);
  assert.equal(c.calls.filter((call) => call === 'send_blob').length, 1);
});

const verdictJob = 'a'.repeat(64);
const verdictStatus = (extra: Record<string, unknown>) => ({ job: verdictJob, phase: 'synthetic', outcome: 'unknown', frozen: false, events: 3, next_action: 'x', ...extra }) as unknown as JobStatus;

test('a finished job points at the device return and judges nothing itself; the note fits the schema a connected client caches', () => {
  const returned = `src:${'c'.repeat(64)}`;
  const note = runnerNote({ job: verdictJob, boundary_refused: false, ended: 'done', status: verdictStatus({ outcome: 'effective', result: `src:${'b'.repeat(64)}`, device_return: returned }) }, 'admin-1');
  assert.ok(note.text.includes(`设备返回 ${returned}`)); assert.match(note.text, /读设备返回，读完再判断/);
  assert.ok(note.text.length <= MAX_NOTE_TEXT);
  assert.deepEqual(SubmitResultOutput.shape.dispatch.safeParse([{job:note.job,result:note.result,text:note.text}]).error?.issues ?? [], []);
  const output=TOOLS.find(tool=>tool.name==='submit_result')!.output;
  assert.equal(output.safeParse({call_result:'error',acceptance:'not_accepted',errors:[{code:'SOURCE_UNAVAILABLE',message:'synthetic'}],trace:'a'.repeat(32),dispatch:[note]}).success,true,'published output preserves structured extensions');
});

test('the pre-dispatch reference is no device return, and an older job without one keeps the old answer', () => {
  const before = runnerNote({ job: verdictJob, boundary_refused: false, ended: 'done', status: verdictStatus({ outcome: 'not_dispatched', result: `src:${'b'.repeat(64)}`, device_return: `src:${'c'.repeat(64)}` }) }, 'admin-1');
  assert.doesNotMatch(before.text, /设备返回/); assert.match(before.text, /上机验证前核对的结论/);
  const older = runnerNote({ job: verdictJob, boundary_refused: false, ended: 'done', status: verdictStatus({ outcome: 'effective', result: `src:${'b'.repeat(64)}` }) }, 'admin-1');
  assert.match(older.text, /读结果引用看逐条结论/);
});

type Attempted = Awaited<ReturnType<C['service']['dispatchAccepted']>>;
test('a repeat reads the attempt still running instead of starting another, and gets the refusal that came after the answer', async (t) => {
  // As on the bed host: the release checks outlast the wait, so the first answer says the check still runs and the refusal
  // (the bytes went out in an earlier job) settles afterwards; it must reach a repeat, never only the operator's log.
  const c = await setup(); t.after(() => c.close());
  let release: (value: Attempted) => void = () => {}; let started = 0;
  c.service.dispatchAccepted = () => { started++; return new Promise<Attempted>((resolve) => { release = resolve; }); };
  assert.match((await acceptedDispatch(c.kit, c.service, c.run, true, 5))[0].text, /^Hub 正在做上机验证前核对/);
  assert.match((await acceptedDispatch(c.kit, c.service, c.run, true, 5))[0].text, /^Hub 正在做上机验证前核对/);
  assert.equal(started, 1, 'a repeat does not start a second attempt');
  release({ started: false, executor: c.executor.id, reason: '合成：这份产物已经由作业 x 派发过，作业已结束；同一份字节只派发一次' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.match((await acceptedDispatch(c.kit, c.service, c.run, true, 5))[0].text, /^上机验证没有发出：上机前的放行条件尚未满足/);
  assert.equal(started, 1);
});

test('a refusal the runner can remove is answered once, and the repeat after it tries again', async (t) => {
  const c = await setup(); t.after(() => c.close());
  let started = 0;
  c.service.dispatchAccepted = async () => { started++; await new Promise((resolve) => setTimeout(resolve, 30)); return { started: false, reason: '合成：自动化测试环境正被作业占用' }; };
  assert.match((await acceptedDispatch(c.kit, c.service, c.run, true, 1))[0].text, /^Hub 正在做上机验证前核对/);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.match((await acceptedDispatch(c.kit, c.service, c.run, true, 1))[0].text, /^上机验证没有发出：上机前的放行条件尚未满足/);
  assert.equal(started, 1);
  await acceptedDispatch(c.kit, c.service, c.run, true, 1);
  assert.equal(started, 2, 'the repeat after the answer tries again');
});

test('bytes that went out in a job that ended are refused, naming the one-dispatch rule', async (t) => {
  const c = await setup(); t.after(() => c.close());
  assert.equal((await c.service.dispatchAccepted(c.run)).started, true);
  await settled(c);
  const again = await c.service.dispatchAccepted(c.run);
  assert.equal(again.started, false, JSON.stringify(again));
  assert.match(again.reason ?? '', /同一份字节只派发一次/);
  assert.equal(c.calls.filter((call) => call === 'send_blob').length, 1);
});

// Issue 142 (decision 155): a dispatch that went wrong comes back in the answer of the submission that triggered it.
async function ended(c: C, count: number) {
  for (let i = 0; i < 200; i++) { const jobs = await readRunJobs(c.kit, c.service, c.admin, c.run, { unbound: true }); if (jobs.length >= count && jobs.every((job) => job.ended !== null)) return jobs; await new Promise((resolve) => setTimeout(resolve, 50)); }
  throw new Error('the dispatched jobs did not end');
}

for (const [mode, reason] of [['busy', /原因：目标拒绝了提交之前的调用（取得租约或只读核对）/], ['build', /主环境只读核对的声明条件未满足/]] as const) {
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
    assert.ok(again[1].job && again[1].job !== first.job, 'a new job'); assert.match(again[1].text, /已再次按任务包的效果行开始上机验证/);
    for (const note of again) assert.doesNotMatch(note.text, /circle-hub|job resume|job dispose|192\.0\.2\./, 'no administrator command and nothing of the target');
    await ended(c, 2);
    assert.ok(c.calls.length > reached, 'the repeat reached the target again');
    assert.equal(c.calls.includes('send_blob'), false);
    // A submission that is not ready only reads: it starts nothing.
    const read = await acceptedDispatch(c.kit, c.service, c.run, false);
    assert.equal(read.length, 2); assert.equal(read[1].not_sent,true); assert.match(read[1].next_action!,/核对|恢复/); assert.doesNotMatch(read[1].next_action!,/circle-hub/);
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
    assert.match(again[0].text, /上机验证结果未知/); assert.equal(again[0].outcome,'unknown'); assert.equal(again[0].not_sent,undefined); assert.ok(!again[0].text.includes(job.status.request_id!));
    assert.match(again[0].text, /不要重交，也不要另开运行重发，目标可能已经执行过一次/);
    assert.match(again[0].text,/管理员处置/); assert.ok(!JSON.stringify(again[0]).includes(c.admin.id));
    assert.doesNotMatch(again[0].text, /circle-hub|job resume|job dispose/);
  }
  assert.equal(c.calls.filter((name) => name === 'send_blob').length, sent, 'nothing is sent again');
  assert.equal(c.calls.length, reached, 'and a read of the progress does not reach the target');
  assert.equal((await readRunJobs(c.kit, c.service, c.admin, c.run, { unbound: true })).length, 1);
});

test('an exception after starting dispatch reports unknown and never starts a second attempt', async t => {
  const c = await setup(); t.after(()=>c.close()); let attempts=0;
  c.service.dispatchAccepted=async()=>{attempts++;throw new Error('private-host usr_private');};
  for (let n=0;n<2;n++) {
    const [note]=await acceptedDispatch(c.kit,c.service,c.run,true,5,c.owner);
    assert.equal(note.outcome,'unknown');assert.equal(note.not_sent,undefined);assert.equal(note.frozen,undefined,'no journal observation proves a durable freeze');assert.match(note.next_action!,/不要重新发送/);
    assert.doesNotMatch(JSON.stringify(note),/private-host|usr_private|circle-hub/);
  }
  const [administrator]=await acceptedDispatch(c.kit,c.service,c.run,true,5,c.admin);
  assert.equal(administrator.outcome,'unknown');assert.equal(administrator.not_sent,undefined);assert.equal(administrator.next_action,`circle-hub run show ${c.run} --json`);
  assert.equal(attempts,1,'an unobserved failure never authorizes a second dispatch');
});

test('the actual caller role is reread and cannot borrow the responsibility administrator identity', async t=>{
  const c=await setup({mode:'lost'});t.after(()=>c.close());
  await acceptedDispatch(c.kit,c.service,c.run,true,undefined,c.owner);const [job]=await ended(c,1);
  const [member]=await acceptedDispatch(c.kit,c.service,c.run,false,undefined,{...c.owner,role:'admin'});
  assert.equal(member.outcome,'unknown');assert.doesNotMatch(JSON.stringify(member),/circle-hub|usr_|exe_/);
  const [administrator]=await acceptedDispatch(c.kit,c.service,c.run,false,undefined,c.admin);
  assert.match(administrator.next_action!,/circle-hub job resume/);assert.ok(administrator.text.includes(job.status.request_id!));
  assert.equal(c.calls.filter(call=>call==='send_blob').length,1);
});

test('members see a stale manifest binding as a distinct release prerequisite with no administrator identifiers',async t=>{
  const c=await setup({mode:'manifest'});t.after(()=>c.close());
  const [note]=await acceptedDispatch(c.kit,c.service,c.run,true,undefined,c.owner);
  assert.equal(note.outcome,'not_dispatched');assert.ok(note.missing_facts?.some(fact=>fact.fact.includes('清单摘要')));
  assert.doesNotMatch(JSON.stringify(note),/usr_|exe_|circle-hub|192\.0\.2\./);
  assert.equal(c.calls.includes('send_blob'),false);
});

test('missing baseline facts reach members from the actual pre-dispatch producer',async t=>{
  const c=await setup({extraTools:['show_bed'],alter:(name,value)=>name==='show_bed'?{output:'synthetic empty bed'}:value});t.after(()=>c.close());
  const definition={...c.executor.definition,allowed_tools:[...c.executor.definition.allowed_tools,'show_bed'],bed_state:{items:[{id:'synthetic_raw',call:{tool:'show_bed',arguments:{ticket:{$value:'lease_id'}},timeout_ms:30000},output:'/output',lead:[],trail:[],cleanup:{actor:'合成管理员',command:'private-admin-cleanup'}}]}};
  await c.registry.update(c.admin,c.executor.id,definition);await c.freezeExecutor();
  await acceptedDispatch(c.kit,c.service,c.run,true,undefined,c.owner);await ended(c,1);
  const [note]=await acceptedDispatch(c.kit,c.service,c.run,false,undefined,c.owner);
  assert.equal(note.outcome,'not_dispatched');assert.equal(note.not_sent,true);
  assert.ok(note.missing_facts?.some(fact=>fact.fact==='本次测试环境尚未登记所需基线'));
  assert.doesNotMatch(JSON.stringify(note),/private-admin-cleanup|usr_|exe_|circle-hub/);
  assert.equal(c.calls.includes('send_blob'),false);
});

test('unreadable certification evidence remains no_verdict and gives members its real safe cause',async t=>{
  const c=await setup();t.after(()=>c.close());
  const proof=await c.kit.artifacts.ingest({bytes:Buffer.from('synthetic certification'),mediaType:'text/plain',origin:{upload:{session:'synthetic'}},author:{user:c.admin.id},provenanceType:'declared',visibility:{readers:[c.admin.id],admins:true,packs:[],shareable:false}});
  await c.registry.update(c.admin,c.executor.id,{...c.executor.definition,premises:{result_ownership:{version:'1',evidence:[`src:${proof.body.sha256}`]}}});await c.freezeExecutor();
  const source=c.kit.artifacts.source.bind(c.kit.artifacts);c.kit.artifacts.source=async(...args)=>args[1]===proof.body.sha256?null:source(...args);
  await acceptedDispatch(c.kit,c.service,c.run,true,undefined,c.owner);await ended(c,1);
  const [note]=await acceptedDispatch(c.kit,c.service,c.run,false,undefined,c.owner);
  assert.equal(note.no_verdict,true);assert.ok(note.missing_facts?.some(fact=>fact.fact.includes('证据文件不可读取')));
  assert.doesNotMatch(JSON.stringify(note),/usr_|exe_|circle-hub|synthetic-secret/);
  assert.equal(c.calls.filter(call=>call==='send_blob').length,1);
  await acceptedDispatch(c.kit,c.service,c.run,true,undefined,c.owner);
  assert.equal(c.calls.filter(call=>call==='send_blob').length,1,'missing evidence never causes another submission');
});

test('the responsibility administrator cannot lend environment use to an unassigned runner',async t=>{
  const c=await setup();t.after(()=>c.close());
  await c.kit.authorizations.unassignResource(c.admin,c.executor.id,c.environmentTeam.id);
  const denied=await c.service.dispatch(c.admin,c.run,c.executor.id);
  assert.equal(denied.outcome,'not_dispatched');assert.equal(denied.error_code,'SOURCE_NOT_PERMITTED');
  assert.equal(c.calls.length,0,'authorization fails before a gateway session is opened');
  assert.equal(c.calls.includes('send_blob'),false);
  const [note]=await acceptedDispatch(c.kit,c.service,c.run,false,undefined,c.owner);
  assert.equal(note.error_code,'SOURCE_NOT_PERMITTED');assert.doesNotMatch(JSON.stringify(note),/usr_|exe_|circle-hub/);
});

test('revoking environment use after precheck is rechecked in the intent transaction',async t=>{
  const c=await setup();t.after(()=>c.close());
  const permission=c.environmentAccess.permission;let checks=0;
  c.service.options.environmentAccess={
    canUse:c.environmentAccess.canUse.bind(c.environmentAccess),
    permission:async(actor,executor,tx)=>{
      checks++;
      await c.kit.authorizations.unassignResource(c.admin,c.executor.id,c.environmentTeam.id);
      return permission(actor,executor,tx);
    },
  };
  const denied=await c.service.dispatch(c.admin,c.run,c.executor.id);
  assert.equal(checks,1);assert.equal(denied.outcome,'not_dispatched');assert.equal(denied.error_code,'SOURCE_NOT_PERMITTED');
  assert.equal(c.calls.includes('send_blob'),false);
  assert.ok(!(await c.service.journal.events(denied.job)).some(event=>event.body.detail.phase==='intent'),'no intent authorizes the revoked environment use');
});

test('an unexpected dispatch exception caught by the scheduler is not evidence of nonexecution',async t=>{
  const c=await setup();t.after(()=>c.close());let invoked=0;
  c.service.dispatch=async()=>{invoked++;c.calls.push('send_blob');throw new Error('private after-send failure');};
  for(let index=0;index<2;index++){
    const [note]=await acceptedDispatch(c.kit,c.service,c.run,true,undefined,c.owner);
    assert.equal(note.outcome,'unknown');assert.equal(note.not_sent,undefined);assert.equal(note.frozen,undefined);
    assert.match(note.next_action!,/不要重新发送/);assert.doesNotMatch(JSON.stringify(note),/private after-send|circle-hub/);
  }
  assert.equal(invoked,1,'a scheduler catch cannot authorize a blind retry');
});

test('a missing environment provider is unavailable evidence, never a claim of no assignment',async t=>{
  const c=await setup();t.after(()=>c.close());
  assert.equal(await c.environmentAccess.canUse(c.owner,c.executor.id),true,'this actor really has an assignment');
  c.service.options.environmentAccess=undefined;
  const result=await c.service.dispatch(c.admin,c.run,c.executor.id);
  assert.equal(result.error_code,'SOURCE_UNAVAILABLE');assert.equal(result.outcome,'not_dispatched');
  assert.equal(c.calls.length,0);
  const [note]=await acceptedDispatch(c.kit,c.service,c.run,false,undefined,c.owner);
  assert.equal(note.error_code,'SOURCE_UNAVAILABLE');assert.ok(note.missing_facts?.some(fact=>fact.fact.includes('尚未核对')));
  assert.doesNotMatch(JSON.stringify(note),/没有.*分配|usr_|exe_|circle-hub/);
});

test('an unreadable environment permission port is unavailable, not a negative permission verdict',async t=>{
  const c=await setup();t.after(()=>c.close());
  assert.equal(await c.environmentAccess.canUse(c.owner,c.executor.id),true);
  c.service.options.environmentAccess={
    canUse:async()=>{throw new Error('private connection failure');},
    permission:c.environmentAccess.permission,
  };
  const result=await c.service.dispatch(c.admin,c.run,c.executor.id);
  assert.equal(result.error_code,'SOURCE_UNAVAILABLE');assert.equal(c.calls.length,0);
  const [note]=await acceptedDispatch(c.kit,c.service,c.run,false,undefined,c.owner);
  assert.equal(note.error_code,'SOURCE_UNAVAILABLE');assert.ok(note.missing_facts?.some(fact=>fact.fact.includes('尚未核对')));
  assert.doesNotMatch(JSON.stringify(note),/private connection|没有.*分配|usr_|exe_|circle-hub/);
});


test('a verified submission without booking reports authorized environment facts without raw lease keys',async t=>{
  const c=await setup({mode:'lineage'});t.after(()=>c.close());
  const [note]=await acceptedDispatch(c.kit,c.service,c.run,true,undefined,c.owner);
  assert.equal(note.submission_verified,true);
  assert.equal(note.error_code,'LEASE_UNAVAILABLE');assert.equal(note.booking?.coverage_complete,false);
  assert.equal(note.booking?.target,c.executor.definition.target);
  assert.equal(note.booking?.required_resources,c.executor.definition.resources.length);
  assert.equal(note.booking?.missing_resources,c.executor.definition.resources.length);
  assert.equal(note.booking?.declared_device_count,c.executor.definition.probes!.seats.length);
  assert.match(note.next_action!,/先预订整个.*脚本编写/);
  for(const key of c.executor.definition.resources)assert.ok(!JSON.stringify(note).includes(key));
  assert.doesNotMatch(JSON.stringify(note),/usr_|exe_|原因.*未查清/);
  assert.equal(c.calls.length,0);
});

test('an unassigned actor gets no environment name or booking diagnosis',async t=>{
  const c=await setup({mode:'lineage'});t.after(()=>c.close());
  await c.kit.authorizations.unassignResource(c.admin,c.executor.id,c.environmentTeam.id);
  const [note]=await acceptedDispatch(c.kit,c.service,c.run,true,undefined,c.owner);
  assert.equal(note.error_code,'SOURCE_NOT_PERMITTED');assert.equal(note.booking,undefined);
  assert.ok(!JSON.stringify(note).includes(c.executor.definition.target));assert.equal(c.calls.length,0);
});

test('unreadable lease coverage stays unknown instead of asserting no booking',async t=>{
  const c=await setup();t.after(()=>c.close());
  c.leases.holderSnapshot=async()=>{throw new Error('private lease read failure');};
  const [note]=await acceptedDispatch(c.kit,c.service,c.run,true,undefined,c.owner);
  assert.equal(note.submission_verified,true);assert.equal(note.error_code,'SOURCE_UNAVAILABLE');
  assert.equal(note.booking?.coverage_complete,null);assert.equal(note.booking?.missing_resources,null);
  assert.doesNotMatch(JSON.stringify(note),/private lease|没有.*预订|没有.*分配|usr_|exe_/);
  assert.equal(c.calls.length,0);
});

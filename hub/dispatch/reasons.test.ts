import { labelOf } from '../../contracts/generated/vocabulary.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalBytes, sha256Hex } from '../records/api.ts';
import { reportMissingFacts, statusDiagnostics } from './reasons.ts';
import { runnerNote } from './accepted.ts';
import { DispatchAttemptFactsSchema, DispatchJobFactsSchema } from '../../contracts/api.ts';
import type { RunJob } from './read-runs.ts';

const jobId = 'a'.repeat(64), content = 'b'.repeat(64);
function job(extra: Record<string, unknown> = {}): RunJob {
  const { outcome = 'not_dispatched', not_sent, rejection_stage, request_id, device_return, result, frozen, phase, awaiting_disposition, ...diagnostics } = extra;
  const hasAttempt = Object.hasOwn(extra, 'outcome') || not_sent === true && extra.error_code === undefined || request_id !== undefined || device_return !== undefined;
  const admission_error = extra.admission_error ?? (!hasAttempt && typeof extra.error_code === 'string' ? { code: extra.error_code, message: String(extra.reason ?? extra.missing_fact ?? 'synthetic admission failure'), fix: String(extra.next_action ?? 'synthetic action') } : undefined);
  const publicJob=DispatchJobFactsSchema.parse({scope:{job:jobId},phase:extra.phase??'complete',frozen:extra.frozen??false,...(awaiting_disposition!==undefined?{awaiting_disposition}:{}),...(extra.result?{result:extra.result}:{}),...(admission_error?{admission_error}:{})});
  return { job: jobId, verification_run: 'synthetic-run', plan_run: 'synthetic-plan', verification_item: 'synthetic-item', items: ['synthetic-case'], sha256: content, boundary_refused: false, ended: 'done', status: {
    job: jobId, events: 3,
    job_facts: { ...(!hasAttempt?diagnostics:{}), ...publicJob },
    ...(hasAttempt ? { dispatch_attempt: { ...diagnostics, ...DispatchAttemptFactsSchema.parse({ scope: { operation: 'dispatch', job: jobId, round: 1, ...(request_id ? { request_id } : {}) }, outcome, ...(not_sent === true ? { not_sent: true } : {}), ...(rejection_stage ? { rejection_stage } : {}), ...(device_return ? { device_return } : {}), ...(typeof extra.error_code === 'string' ? { error_code: extra.error_code } : {}) }) } } : {}),
  } };
}

test('member diagnostics preserve three distinct producer-authored missing facts without administrative details', () => {
  const facts = ['本次测试环境尚未登记基线', '认证所需的证据文件当前不可读取', '本次绑定清单的摘要与可取得原件不一致'];
  const answers = facts.map(fact => statusDiagnostics(job({ missing_fact: 'private administrator detail usr_synthetic', next_action: 'circle-hub executor update exe_synthetic', member_missing_facts: [{ fact, next_action: '联系管理员补齐该事实后重新核对本次环境' }] }), false));
  for (const [index, answer] of answers.entries()) {
    assert.ok(answer.job_facts.missing_facts);
    assert.equal(answer.job_facts.missing_facts[0]?.fact, facts[index]);
    assert.doesNotMatch(JSON.stringify(answer), /usr_synthetic|exe_synthetic|circle-hub/);
  }
  assert.equal(new Set(answers.map(answer => answer.job_facts.missing_facts![0].fact)).size, 3);
});

test('administrator diagnostics retain the actual corrective action while members do not receive it', () => {
  const source = job({ missing_fact: '缺基线（管理员详情）', next_action: 'circle-hub job baseline list', member_missing_facts: [{ fact: '本次环境缺少登记基线', next_action: '联系管理员登记基线后重新核对' }] });
  assert.equal(statusDiagnostics(source, true).job_facts.missing_facts![0].next_action, 'circle-hub job baseline list');
  assert.doesNotMatch(JSON.stringify(statusDiagnostics(source, false)), /管理员详情|circle-hub/);
});

test('an unresolved send never becomes not_sent and has no blind retry action', () => {
  const source = job({ outcome: 'unknown', frozen: true, request_id: 'private-request', reason: 'private-host' }); source.ended = 'unknown';
  const note = runnerNote(source, 'usr_private');
  assert.equal(note.dispatch_attempt?.outcome, 'unknown'); assert.equal(note.dispatch_attempt?.not_sent, undefined);
  assert.equal(Object.hasOwn(note, 'outcome'), false);
  assert.match(note.dispatch_attempt?.next_action ?? note.job_facts?.next_action ?? '', /不要重交/);
  assert.doesNotMatch(JSON.stringify(note), /usr_private|private-request|private-host|circle-hub/);
});

test('a result reference alone never establishes a device verdict', async () => {
  const source = job({ outcome: 'effective', result: `src:${'c'.repeat(64)}` });
  const result = await reportMissingFacts({ objects: { get: async () => null } } as never, source, false);
  assert.equal(result.no_verdict, undefined);
  assert.equal(Object.hasOwn(runnerNote(source, 'usr_private'), 'no_verdict'), false);
});

test('integrity-checked projected no_verdict preserves safe facts and never relays raw administrator prose', async () => {
  const report = { job: jobId, sha256: content, rows: [{ item: 'synthetic-case', dynamic_terminal: 'no_verdict', missing_facts: ['owned'], missing_fact: 'usr_private secret-private', next_action: 'circle-hub executor update exe_private' }] };
  const bytes = canonicalBytes(report), source = job({ outcome: 'effective', result: `src:${sha256Hex(bytes)}` });
  const records = { objects: { get: async () => bytes } } as never;
  const member = await reportMissingFacts(records, source, false);
  assert.equal(member.no_verdict, true); assert.match(member.missing_facts[0].fact, /归属/);
  assert.doesNotMatch(JSON.stringify(member), /usr_private|secret-private|exe_private|circle-hub/);
  assert.match((await reportMissingFacts(records, source, true)).missing_facts[0].next_action, /executor update/);
});

test('another job or corrupted projected bytes cannot supply a verdict', async () => {
  for (const wrongHash of [false, true]) {
    const bytes = canonicalBytes({ job: wrongHash ? jobId : 'd'.repeat(64), sha256: content, rows: [] });
    const source = job({ outcome: 'effective', result: `src:${wrongHash ? 'e'.repeat(64) : sha256Hex(bytes)}` });
    const result = await reportMissingFacts({ objects: { get: async () => bytes } } as never, source, false);
    assert.equal(result.no_verdict, undefined); assert.deepEqual(result.missing_facts, []);
  }
});

test('unknown send evidence takes precedence over an older booking diagnosis',()=>{
  const source=job({outcome:'unknown',frozen:true,booking:{target:'synthetic-bed',coverage_complete:false,required_resources:2,missing_resources:2,declared_device_count:2}});
  source.ended='unknown';
  const note=runnerNote(source,'usr_private');
  assert.match(note.dispatch_attempt?.next_action ?? '',/不要重交/);
  assert.doesNotMatch(note.dispatch_attempt?.next_action ?? '',/先预订|开始新的运行/);
});

test('member text omits internal phases and job digests while administrators retain diagnostics',()=>{
  const source=job({phase:'boundary_refused',error_code:'LEASE_UNAVAILABLE',booking:{target:'合成环境',coverage_complete:false,required_resources:2,missing_resources:2,declared_device_count:2},reason:'private resource key',member_missing_facts:[{fact:'测试环境 合成环境 缺少 2 项资源的预订',next_action:'先预订整个测试环境后重新核验'}]});
  source.boundary_refused=true;
  const member=runnerNote(source,'usr_private');
  assert.match(member.text,/^不存在：/);assert.match(member.text,/合成环境.*2 项/);
  assert.equal(member.text.includes(jobId),false);assert.doesNotMatch(member.text,/boundary_refused|private resource key|circle-hub/);
  const administrator=runnerNote(source,'usr_private',false,true);
  assert.ok(administrator.text.includes(jobId));assert.match(administrator.text,/boundary_refused|private resource key/);
});

test('historical read-only condition facts retain the item name without disclosing admin expected values',()=>{
  const source=job({not_sent:true,failed_conditions:[{pointer:'/seats',operator:'at_least'}],missing_fact:'private expected values',next_action:'circle-hub job inspect private'});
  const member=runnerNote(source,'usr_private');
  assert.match(member.text,/核对项目 \/seats.*至少数量/);assert.match(member.text,/请管理员/);
  assert.doesNotMatch(member.text,/private expected values|circle-hub|private/);
  const retried=runnerNote(source,'usr_private',true);
  assert.match(retried.text,/请管理员/);assert.match(retried.text,/本次运行已重新申请上机验证作业/);
  assert.ok(retried.text.includes('/seats'));
});

test('SOURCE_UNAVAILABLE is not forced into a five-category diagnosis by an older failed condition',()=>{
  const source=job({error_code:'SOURCE_UNAVAILABLE',not_sent:true,failed_conditions:[{pointer:'/seats',operator:'at_least'}]});
  const note=runnerNote(source,'usr_private');
  assert.doesNotMatch(note.text,/^(暂时不可用|已被占用|无权限|参数无效|不存在)：/);
  assert.equal(note.job_facts?.admission_error?.code,'SOURCE_UNAVAILABLE');
  source.status.job_facts.call_error_category='occupied';
  assert.doesNotMatch(runnerNote(source,'usr_private').text,/^已被占用：/,'unknown source admission cannot be overridden by an unrelated category');
});


test('the shared classification does not infer occupancy from LEASE_UNAVAILABLE alone',()=>{
  const source=job({error_code:'LEASE_UNAVAILABLE',member_missing_facts:[{fact:'没有可采用的租约事实',next_action:'请管理员只读核对'}]});
  assert.doesNotMatch(runnerNote(source,'usr_private').text,/^已被占用：/);
});

test('missing prerequisites and expired bookings use not_found while confirmed other-holder conflicts use occupied',()=>{
  const missing=job({error_code:'EFFECT_CONTENT_UNVERIFIED',member_missing_facts:[{fact:'这次运行缺少判断为正确的脚本合并结果',next_action:'先完成脚本合并'}]});
  assert.match(runnerNote(missing,'usr_private').text,/^不存在：.*缺少.*脚本合并结果/);
  const expired=job({error_code:'LEASE_EXPIRED',member_missing_facts:[{fact:'原预订已经过期，缺少当前有效预订',next_action:'重新预订后核验'}]});
  assert.match(runnerNote(expired,'usr_private').text,/^不存在：.*过期/);
  const occupied=job({error_code:'LEASE_UNAVAILABLE',call_error_category:'occupied',member_missing_facts:[{fact:'测试环境由另一运行持有',next_action:'等该运行释放后原样重试'}]});
  assert.match(runnerNote(occupied,'usr_private').text,/^已被占用：.*另一运行持有/);
});

test('permission-provider unavailability stays in job admission scope and never rewrites an already sent attempt', () => {
  for (const administrative of [false, true]) {
    const source = job({ error_code: 'ENVIRONMENT_PERMISSION_UNAVAILABLE', admission_error: { code: 'ENVIRONMENT_PERMISSION_UNAVAILABLE', message: '测试环境的权限核对现在不能进行，这次没有执行', fix: '请联系管理员' }, member_missing_facts: [{ fact: '测试环境的权限核对现在不能进行，这次没有执行', next_action: '请联系管理员' }] });
    delete source.status.dispatch_attempt;
    const note = runnerNote(source, 'synthetic-admin', false, administrative);
    assert.equal(note.job_facts?.admission_error?.code, 'ENVIRONMENT_PERMISSION_UNAVAILABLE');
    assert.equal(Object.hasOwn(note, 'error_code'), false); assert.equal(note.dispatch_attempt, undefined);
    assert.ok(note.text.includes('测试环境的权限核对现在不能进行，这次没有执行'));
    for (const wrong of ['状态未知', '原因缺资料', '读不到这份资料']) assert.equal(note.text.includes(wrong), false);
  }
  const sent = job({ error_code: 'SOURCE_UNAVAILABLE', outcome: 'unknown', frozen: true }); sent.ended = 'unknown';
  const unknown = runnerNote(sent, 'synthetic-admin');
  assert.match(unknown.text,/第 1 轮派发.*结果未知/);
  assert.equal(unknown.text.includes('这次没有执行'), false);
});

test('member full scoped payload keeps known booking counts but never inherits private diagnostic text or lease keys', () => {
  const marker = 'diagnostic with private keys', key = 'synthetic/private-device-key';
  const source = job({ error_code: 'LEASE_UNAVAILABLE', submission_verified: true,
    reason: marker + ' ' + key, missing_fact: marker, next_action: 'circle-hub job inspect ' + key,
    booking: { target: '合成实验室', coverage_complete: false, required_resources: 11, missing_resources: 11, declared_device_count: 11 },
    member_missing_facts: [{ fact: '本作业所需测试环境「合成实验室」（共 11 台设备）还没有预订覆盖', next_action: '先预订整个测试环境，再从脚本编写重开并重新核验' }],
  });
  const member = runnerNote(source, 'usr_private');
  const payload = JSON.stringify(member);
  assert.doesNotMatch(payload, /diagnostic with private keys|private-device-key|circle-hub|usr_private/);
  assert.deepEqual(member.job_facts?.scope, { job: jobId });
  assert.equal(member.job_facts?.admission_error?.code, 'LEASE_UNAVAILABLE');
  assert.match(member.job_facts?.admission_error?.message ?? '', /本作业.*合成实验室.*11 台/);
  assert.match(member.text, /合成实验室.*11 台.*预订/);
  assert.equal(member.dispatch_attempt, undefined, 'no dispatch round is invented for pre-intent admission');
  for (const old of ['outcome', 'not_sent', 'booking', 'submission_verified', 'result', 'error_code']) assert.equal(Object.hasOwn(member, old), false);
  assert.ok(JSON.stringify(runnerNote(source, 'usr_private', false, true)).includes(marker), 'administrator diagnostics remain available in job scope');
});

test('a later no-send attempt cannot hide the verified job report or promote its reference to a passed device verdict', async () => {
  const bytes = canonicalBytes({ job: jobId, sha256: content, rows: [{ item: 'synthetic-case', dynamic_terminal: 'no_verdict', missing_facts: ['report'], missing_fact: 'private report detail', next_action: 'circle-hub job resume private' }] });
  const source = job({ outcome: 'not_dispatched', not_sent: true, result: `src:${sha256Hex(bytes)}` });
  source.status.dispatch_attempt!.scope = { operation: 'dispatch', job: jobId, round: 2 };
  const report = await reportMissingFacts({ objects: { get: async () => bytes } } as never, source, false);
  assert.equal(report.no_verdict, true); assert.match(report.missing_facts[0].fact, /完整报告尚未取得/);
  const note = runnerNote(source, 'usr_private');
  assert.match(note.text, /作业结果引用/); assert.match(note.text, /第 2 轮派发.*没有发出/);
  assert.doesNotMatch(note.text, /已取回.*设备输出|设备已执行|判断错误|什么都没有发到目标/);
  assert.equal(note.job_facts?.result, `src:${sha256Hex(bytes)}`);
  assert.equal(note.dispatch_attempt?.result, undefined, 'job report is never copied into the second attempt');
});

test('conformance scope names the operation without inventing a round and readonly precheck has no attempt', () => {
  const source = job({ outcome: 'proven_not_executed' });
  source.status.job_facts.operation = 'conformance';
  source.status.dispatch_attempt = { scope: { operation: 'conformance', job: jobId, request_id: 'private-request' }, outcome: 'proven_not_executed' };
  const conform = runnerNote(source, 'usr_private');
  assert.ok(conform.text.includes('本次'+labelOf('dispatch_operation','conformance'))); assert.doesNotMatch(conform.text, /第.*轮/);
  assert.equal(Object.hasOwn(conform.dispatch_attempt!.scope, 'round'), false);
  assert.equal(JSON.stringify(conform).includes('private-request'), false);
  source.status.job_facts.operation = 'precheck'; source.status.job_facts.readonly_verified = false;
  delete source.status.dispatch_attempt;
  const readonly = runnerNote(source, 'usr_private');
  assert.equal(readonly.dispatch_attempt, undefined); assert.equal(readonly.job_facts?.readonly_verified, false);
  assert.match(readonly.text, /只读预检/); assert.doesNotMatch(readonly.text, /判断错误|未发出|第.*轮/);
});

test('job-wide control freeze never replaces the current attempt effect or prior report scope', () => {
  const source = job({ outcome: 'issued', frozen: true, result: `src:${'c'.repeat(64)}` });
  source.ended = 'unknown';
  const note = runnerNote(source, 'usr_private');
  assert.equal(note.job_facts?.frozen, true);
  assert.equal(note.dispatch_attempt?.outcome, 'issued');
  assert.equal(note.dispatch_attempt?.not_sent, undefined);
  assert.match(note.text, /本作业保持重发保护/);
  assert.match(note.text, /第 1 轮派发：/);
  assert.doesNotMatch(note.text, /第 1 轮派发上机验证结果未知|整个作业没有执行|什么都没有发到目标/);
  assert.equal(note.job_facts?.result, `src:${'c'.repeat(64)}`);
  assert.equal(note.dispatch_attempt?.result, undefined);
});

test('a real begin-handler promise reports pending and settled only in run scope without borrowing the scheduler role', async () => {
  const { acceptedDispatch } = await import('./accepted.ts');
  const run = 'run_00000000000000000000000001';
  const caller = { id: 'usr_00000000000000000000000001', name: '合成成员', role: 'user' as const };
  const scheduler = { id: 'usr_00000000000000000000000002', name: '合成调度管理员', role: 'admin' as const };
  let finish!: (value: Awaited<ReturnType<import('./service.ts').DispatchService['dispatchAccepted']>>) => void;
  const handled = new Promise<Awaited<ReturnType<import('./service.ts').DispatchService['dispatchAccepted']>>>(resolve => { finish = resolve; });
  let calls = 0;
  const records = { store: { find: async () => ({ items: [], next: null }) }, principals: { list: async () => [scheduler], get: async (id: string) => id === caller.id ? caller : scheduler } } as unknown as Pick<import('../records/api.ts').RecordsKit, 'store' | 'principals'>;
  const service = { options: { runs: { getRun: async () => ({}) } }, dispatchAccepted: () => { calls++; return handled; }, status: () => { throw new Error('no job exists to read'); } } as unknown as import('./service.ts').DispatchService;
  const [pending] = await acceptedDispatch(records, service, run, true, 0, { ...caller, role: 'admin' });
  assert.deepEqual(pending.run_facts, { scope: { run }, worker_settled: false });
  assert.equal(pending.job_facts, undefined); assert.equal(pending.dispatch_attempt, undefined); assert.equal(pending.job, undefined);
  assert.match(pending.text, /本次运行正在/);
  finish({ started: false, error_code: 'SOURCE_NOT_PERMITTED', reason: 'private admin diagnostic with private keys', member_missing_facts: [{ fact: '本次运行的账户没有所需的使用授权', next_action: '请联系管理员核对分配' }] });
  await Promise.resolve();
  const [settled] = await acceptedDispatch(records, service, run, true, 0, caller);
  assert.equal(calls, 1); assert.equal(settled.run_facts?.worker_settled, true);
  assert.equal(settled.run_facts?.admission_error?.code, 'SOURCE_NOT_PERMITTED');
  assert.equal(settled.job_facts, undefined); assert.equal(settled.dispatch_attempt, undefined);
  assert.doesNotMatch(JSON.stringify(settled), /private admin|private keys|circle-hub|调度管理员/);
  for (const field of ['outcome', 'error_code', 'worker_settled', 'not_sent', 'frozen', 'round']) assert.equal(Object.hasOwn(settled, field), false);
});

test('conservative freeze and awaiting disposition remain independent job controls and never become attempt effects', () => {
  for (const [frozen, awaiting] of [[false, false], [true, false], [true, true]] as const) {
    const source = job({ outcome: 'issued', frozen, awaiting_disposition: awaiting });
    const note = runnerNote(source, 'usr_private');
    assert.equal(note.job_facts?.frozen, frozen); assert.equal(note.job_facts?.awaiting_disposition, awaiting);
    assert.equal(note.dispatch_attempt?.outcome, 'issued'); assert.equal(note.dispatch_attempt?.not_sent, undefined);
    assert.equal(note.text.includes('待处置事项'), awaiting);
    assert.equal(Object.hasOwn(note, 'frozen'), false); assert.equal(Object.hasOwn(note, 'awaiting_disposition'), false);
  }
  const source = job({ outcome: 'issued' });
  delete source.status.job_facts.frozen; delete source.status.job_facts.awaiting_disposition;
  const note = runnerNote(source, 'usr_private');
  assert.equal(Object.hasOwn(note.job_facts!, 'frozen'), false);
  assert.equal(Object.hasOwn(note.job_facts!, 'awaiting_disposition'), false);
});

test('source note refuses mismatched job and attempt identities instead of joining unrelated scope facts', () => {
  const source = job({ outcome: 'issued' });
  source.status.job_facts.scope = { job: 'd'.repeat(64) };
  assert.throws(() => runnerNote(source, 'usr_private'), /范围/);
  source.status.job_facts.scope = { job: jobId };
  source.status.dispatch_attempt!.scope = { operation: 'dispatch', job: 'd'.repeat(64), round: 1 };
  assert.throws(() => runnerNote(source, 'usr_private'), /范围/);
});

test('member source projection never copies raw job facts into facts or admission text when an attempt exists', () => {
  const source = job({ outcome: 'not_dispatched', not_sent: true, result: `src:${'c'.repeat(64)}` });
  const marker = 'PRIVATE_ADMIN_DIAGNOSTIC_SENTINEL';
  source.status.job_facts.device_return = `src:${'e'.repeat(64)}`;
  source.status.job_facts.missing_facts = [{ fact: marker + ' job fact', next_action: marker + ' job next' }];
  source.status.job_facts.admission_error = { code: 'SOURCE_NOT_PERMITTED', message: marker + ' admission message', fix: marker + ' admission fix' };
  source.status.dispatch_attempt!.scope = { operation: 'dispatch', job: jobId, round: 2, request_id: marker + ' request' };
  source.status.dispatch_attempt!.missing_facts = [{ fact: marker + ' attempt fact', next_action: marker + ' attempt next' }];
  source.status.dispatch_attempt!.next_action = marker + ' attempt next';
  const member = statusDiagnostics(source, false);
  assert.doesNotMatch(JSON.stringify(member), new RegExp(marker));
  assert.equal(member.job_facts.result, source.status.job_facts.result);
  assert.equal(member.job_facts.device_return, source.status.job_facts.device_return);
  assert.equal(member.dispatch_attempt?.scope.request_id, undefined);
  assert.ok(member.job_facts.missing_facts?.length, 'withheld diagnostic details are not claimed to be no missing facts');
  const administrator = statusDiagnostics(source, true);
  assert.match(JSON.stringify(administrator), new RegExp(marker + ' job fact'));
  assert.match(JSON.stringify(administrator), new RegExp(marker + ' attempt fact'));
  assert.equal(administrator.job_facts.admission_error?.message, marker + ' admission message');
  assert.equal(administrator.dispatch_attempt?.scope.request_id, marker + ' request');
  assert.equal(administrator.job_facts.device_return, source.status.job_facts.device_return);
});

test('final boundary after a target response does not restart the whole job while complete busy or build failures can retry', async () => {
  const { acceptedDispatch } = await import('./accepted.ts');
  const run = 'run_00000000000000000000000001';
  const admin = { id: 'usr_00000000000000000000000002', name: '合成管理员', role: 'admin' as const, disabled: false };
  for (const phase of ['round_refused', 'complete'] as const) {
    const history = phase === 'round_refused' ? [
      { digest: 'c'.repeat(64), body: { detail: { phase: 'precheck.response' } } },
      { digest: 'd'.repeat(64), body: { detail: { phase: 'boundary_refused', done: true } } },
    ] : [
      { digest: 'c'.repeat(64), body: { detail: { phase: 'acquire.response' } } },
      { digest: 'd'.repeat(64), body: { detail: { phase: 'complete', done: true } } },
    ];
    const records = { store: {
      find: async () => ({ items: [{ body: { detail: { binding: { job: jobId, run } } } }], next: null }),
      findMany: async () => history,
    }, principals: { list: async () => [admin] } } as unknown as Pick<import('../records/api.ts').RecordsKit, 'store' | 'principals'>;
    const publicJob = DispatchJobFactsSchema.parse({ scope: { job: jobId }, frozen: false });
    const attempt = DispatchAttemptFactsSchema.parse({ scope: { operation: 'dispatch', job: jobId, round: 1 }, phase, outcome: 'not_dispatched', not_sent: true });
    let started = 0;
    const service = { options: { records }, status: async () => ({ job: jobId, events: 2, job_facts: publicJob, dispatch_attempt: attempt }), dispatchAccepted: async () => { started++; return { started: false, error_code: 'SOURCE_NOT_PERMITTED', member_missing_facts: [{ fact: '合成后续准入拒绝', next_action: '联系管理员' }] }; } } as unknown as import('./service.ts').DispatchService;
    const notes = await acceptedDispatch(records, service, run, true, 0);
    assert.equal(started, phase === 'round_refused' ? 0 : 1);
    assert.equal(notes.length, phase === 'round_refused' ? 1 : 2);
    assert.equal(notes[0].dispatch_attempt?.not_sent, true);
    assert.equal(notes[0].dispatch_attempt?.outcome, 'not_dispatched');
    if (phase === 'round_refused') assert.match(notes[0].job_facts?.next_action ?? '', /不会整份重试.*重新开始核验/);
  }
});

test('a resolved job-status-unavailable wrapper is run uncertainty and never a confirmed admission refusal or retry license', async () => {
  const { acceptedDispatch } = await import('./accepted.ts');
  const run = 'run_00000000000000000000000003';
  const user = { id: 'usr_00000000000000000000000003', name: '合成成员', role: 'user' as const };
  const admin = { id: 'usr_00000000000000000000000002', name: '合成管理员', role: 'admin' as const, disabled: false };
  const records = { store: { find: async () => ({ items: [], next: null }) }, principals: { list: async () => [admin], get: async () => user } } as unknown as Pick<import('../records/api.ts').RecordsKit, 'store' | 'principals'>;
  let calls = 0;
  const service = { options: { runs: { getRun: async () => ({}) } }, dispatchAccepted: async () => {
    calls++; return { started: false, job_status_unavailable: true, reason: 'PRIVATE_STATUS_EXCEPTION' };
  } } as unknown as import('./service.ts').DispatchService;
  for (let n = 0; n < 2; n++) {
    const [note] = await acceptedDispatch(records, service, run, true, 0, user);
    assert.deepEqual(note.run_facts?.scope, { run }); assert.equal(note.run_facts?.worker_settled, true);
    assert.equal(note.run_facts?.admission_error, undefined);
    assert.equal(note.job_facts, undefined); assert.equal(note.dispatch_attempt, undefined); assert.equal(note.job, undefined);
    assert.match(note.text, /事实尚未确认/); assert.doesNotMatch(note.text, /准入核对未通过|PRIVATE_STATUS_EXCEPTION/);
    for (const old of ['outcome', 'not_sent', 'frozen', 'job_status_unavailable']) assert.equal(Object.hasOwn(note, old), false);
  }
  assert.equal(calls, 1, 'an unavailable status is not permission to start another worker');
});

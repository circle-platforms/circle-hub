import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { holdsPhysicalTarget } from './journal.ts';
import { roundOf } from './rounds.ts';
import { setup } from './testing/context.ts';

async function repeatedFixture(alter?: (name:string,value:Record<string,unknown>)=>Record<string,unknown>) {
  const c = await setup({ alter: (name, value) => {
    const observed=name==='read_blob'?{...value,ownership:'staging_directory',ownership_reason:null,rows:[{id:'synthetic-case',outcome:'good',log:'SYNTHETIC_END'}]}:value;
    return alter?alter(name,observed):observed;
  } });
  // Use the same declared repeat policy and certified ownership as the normal multi-round fixture.
  (c.effectDocument.effects[0] as { repetition?: number }).repetition = 2;
  c.detail.run.requirements = [{
    key: 'workbook_verified', name: '合成核验', description: '合成', layers: ['dynamic'], done_rule: 'gating', accepted_producer: 'fact',
    repair_rounds: 0, rules: [], run_interpreters: [],
    repetition: { count: 2, aggregation: 'all', basis: 'explicit', declared: { count: true, aggregation: true, k: false } },
  }] as typeof c.detail.run.requirements;
  const proof = await c.kit.artifacts.ingest({ bytes: new TextEncoder().encode('synthetic attribution certification'), mediaType: 'text/plain', origin: { upload: { session: 'synthetic' } }, author: { user: c.admin.id }, provenanceType: 'declared', visibility: { readers: [c.admin.id], admins: true, packs: [], shareable: false } });
  await c.registry.update(c.admin, c.executor.id, {
    ...c.executor.definition,
    premises: { result_ownership: { version: '1', evidence: [`src:${proof.body.sha256}`] } },
    result: { ...c.executor.definition.result, ownership: { pointer: '/ownership', value: 'staging_directory', reason: '/ownership_reason' }, request_id: '/request', log: '/log', closing_marker: 'SYNTHETIC_END' },
  });
  await c.freezeExecutor();
  return c;
}

test('a scoped second-round no-send preserves the first effect and removes every flat summary', { timeout: 60000 }, async t => {
  const c = await repeatedFixture();
  t.after(() => c.close());
  let interrupted = false;
  const request = http.request;
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  c.service.options.beforeRound = async round => {
    assert.equal(round, 2);
    assert.equal(c.calls.filter(name => name === 'send_blob').length, 1);
    // Fault seam: abort the next native HTTP request before any socket is allocated.
    // RpcClient still performs classification and persists its actual response/write count.
    // Do not forge SubmissionNotSentError, response events, or the final completion.
    t.mock.method(http, 'request', (url: URL, options: http.RequestOptions, listener: (response: http.IncomingMessage) => void) => {
      interrupted = true;
      t.mock.restoreAll();
      syncBuiltinESMExports();
      return request(url, { ...options, signal: AbortSignal.abort() }, listener);
    });
    syncBuiltinESMExports();
  };
  const state = await c.service.dispatch(c.admin, c.run, c.executor.id);
  assert.equal(interrupted, true);
  assert.equal(c.calls.filter(name => name === 'send_blob').length, 1);
  const events = await c.service.journal.events(state.job);
  const intents = events.filter(event => event.body.detail.phase === 'intent');
  assert.deepEqual(intents.map(event => event.body.detail.round), [1, 2]);
  const receipts = events.filter(event => event.body.detail.phase === 'receipt');
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].body.detail.acceptance, 'accepted');
  assert.equal(receipts[0].body.detail.remote_id, 'synthetic-remote');
  const firstRound = events.find(event => event.body.detail.phase === 'round' && event.body.detail.round === 1);
  assert.equal(firstRound?.body.detail.terminal, 'pass');
  const effects = await c.kit.store.findMany<{ intent_key: string | null; request_id: string | null; previous: string | null; outcome: string }>({ kind: 'effect', key: 'effect.job', values: [state.job] });
  const secondEffects = effects.filter(effect => effect.body.request_id === intents[1].body.detail.request_id);
  assert.ok(secondEffects.length);
  assert.equal(secondEffects[0].body.previous, null, 'a new request cannot inherit the previous round effect chain');
  assert.equal(effects.filter(effect => effect.body.request_id === intents[0].body.detail.request_id).at(-1)?.body.outcome, 'effective');
  const budgetIntents = await c.kit.store.findMany({ kind: 'action', key: 'dispatch.effect_row', values: [`${c.run}:${intents[0].body.detail.effect_row}`] });
  assert.equal(budgetIntents.length, 2, 'the zero-write intent still consumes its recorded intent budget');
  const secondIntentIndex = events.indexOf(intents[1]);
  assert.ok(events.indexOf(receipts[0]) < secondIntentIndex);
  const zeroWrite = events.slice(secondIntentIndex + 1).find(event => event.body.detail.phase === 'submit.response');
  assert.ok(zeroWrite, 'the real transport must persist its failed second submit response');
  assert.equal(zeroWrite.body.detail.complete, false);
  assert.equal(zeroWrite.body.detail.http_status, 0);
  assert.equal(zeroWrite.body.detail.request_bytes_written, 0);
  const complete = events.filter(event => event.body.detail.phase === 'complete').at(-1);
  assert.ok(complete);
  assert.ok(events.indexOf(complete) > events.indexOf(zeroWrite));
  assert.equal(complete.body.detail.submit_invoked, true);
  assert.equal(complete.body.detail.outcome, 'not_dispatched');
  assert.ok(complete.body.inputs.includes(`rec:${intents[1].digest}`), 'the no-send evidence refers to the second intent');
  // Deliberately characterize the existing defect, rather than changing production to hide it.
  assert.deepEqual(Object.keys(state).sort(), ['dispatch_attempt','events','job','job_facts']);
  assert.equal(state.dispatch_attempt?.outcome, 'not_dispatched');
  assert.equal(state.dispatch_attempt?.not_sent, true);
  assert.ok(state.job_facts.result, 'the earlier round result remains readable at job scope');
  assert.equal(state.job_facts.reason,undefined);
  assert.equal(state.job_facts.missing_fact,undefined);
  assert.equal(state.job_facts.next_action,undefined);
  assert.equal(Object.hasOwn(state, 'round'), false);
  assert.equal(complete.body.detail.round, 2);
  const legacyStatus = t.mock.method(c.service, 'status', () => { throw new Error('the scoped reader must not call the legacy summary'); });
  const beforeRead = events.map(event => event.digest);
  const scoped = await c.service.scopedFacts(c.admin, state.job);
  assert.deepEqual(scoped.job_facts.scope, { job: state.job });
  assert.equal(scoped.job_facts.reservation_recorded, true);
  assert.equal(Object.hasOwn(scoped.job_facts, 'outcome'), false);
  assert.equal(Object.hasOwn(scoped.job_facts, 'not_sent'), false);
  assert.equal(Object.hasOwn(scoped.job_facts, 'submit_invoked'), false);
  assert.equal(Object.hasOwn(scoped.job_facts, 'worker_settled'), false, 'journal history does not observe this process worker settlement');
  assert.deepEqual(scoped.dispatch_attempt?.scope, { operation:'dispatch', job: state.job, round: 2, request_id: intents[1].body.detail.request_id });
  assert.equal(scoped.dispatch_attempt?.outcome, 'not_dispatched');
  assert.equal(scoped.dispatch_attempt?.not_sent, true);
  assert.equal(scoped.dispatch_attempt?.submit_invoked, true, 'the program called submit even though the transport wrote zero bytes');
  assert.ok(scoped.dispatch_attempt?.grounds?.includes(`rec:${intents[1].digest}`));
  assert.ok(scoped.dispatch_attempt?.grounds?.includes(`rec:${zeroWrite.digest}`));
  assert.ok(scoped.dispatch_attempt?.grounds?.includes(`rec:${complete.digest}`));
  assert.ok(!scoped.dispatch_attempt?.grounds?.includes(`rec:${receipts[0].digest}`));
  const firstScope = await c.service.scopedFacts(c.admin, state.job, 1);
  assert.deepEqual(firstScope.dispatch_attempt?.scope, { operation:'dispatch', job: state.job, round: 1, request_id: intents[0].body.detail.request_id });
  assert.equal(firstScope.dispatch_attempt?.outcome, 'effective', 'the same round has an actual recorded effective observation, not only a receipt');
  assert.equal(firstScope.dispatch_attempt?.not_sent, undefined, 'the second-round complete cannot become a first-round no-send fact');
  assert.equal(firstScope.dispatch_attempt?.submit_invoked, true);
  assert.ok(firstScope.dispatch_attempt?.grounds?.includes(`rec:${receipts[0].digest}`));
  assert.ok(!firstScope.dispatch_attempt?.grounds?.includes(`rec:${complete.digest}`));
  const absentScope = await c.service.scopedFacts(c.admin, state.job, 3);
  assert.equal(absentScope.dispatch_attempt, undefined, 'a requested but unobserved round is not manufactured');
  await assert.rejects(c.service.scopedFacts(c.owner, state.job));
  assert.deepEqual((await c.service.journal.events(state.job)).map(event => event.digest), beforeRead, 'the scoped reader never rewrites or adds events');
  assert.equal(c.calls.filter(name => name === 'send_blob').length, 1, 'the scoped reader never makes an RPC');
  assert.equal((await c.service.journal.events(state.job)).find(event => event.digest === receipts[0].digest)?.body.detail.acceptance, 'accepted');
  assert.equal((await c.service.journal.events(state.job)).find(event => event.digest === firstRound?.digest)?.body.detail.terminal, 'pass');
  assert.equal(holdsPhysicalTarget(events),false,'accounted earlier effects and the terminal zero-write round do not hold forever');
  legacyStatus.mock.restore();
  const retried=await c.service.dispatch(c.admin,c.run,c.executor.id);
  assert.equal(retried.dispatch_attempt?.outcome,'effective');
  const allIntents=(await c.kit.store.findMany<import('../records/api.ts').ActionBody>({kind:'action',key:'dispatch.bytes',values:[c.payload.body.sha256]})).filter(event=>event.body.detail.phase==='intent');
  assert.equal(allIntents.filter(event=>event.body.detail.round===1).length,1,'retry never resubmits the executed first round');
  assert.equal(allIntents.filter(event=>event.body.detail.round===2).length,2);
  assert.equal(c.calls.filter(name=>name==='send_blob').length,2,'one first-round send and exactly one successful second-round send');
  assert.equal((await c.kit.store.findMany({kind:'action',key:'dispatch.effect_row',values:[`${c.run}:${intents[0].body.detail.effect_row}`]})).length,3,'the zero-write intent is not refunded');
  assert.deepEqual((await c.service.journal.events(state.job)).map(event=>event.digest),beforeRead,'negative summary and retry leave original records intact');
  const oldReport=await c.kit.artifacts.source(c.owner,state.job_facts.result!.slice(4));
  assert.ok(oldReport?.bytes,'the original first-round report remains readable');
  t.diagnostic(JSON.stringify({ historical_repro: 'e046950bc', original_gateway_submits: 1, successful_gateway_submits_after_retry:2, intent_rounds: [1, 2], accepted_receipts: receipts.length, first_round: firstRound?.body.detail.terminal, second_submit_bytes: zeroWrite.body.detail.request_bytes_written, outcome: state.dispatch_attempt?.outcome, not_sent: state.dispatch_attempt?.not_sent, summary_round_present: Object.hasOwn(state, 'round') }));
});


test('new single-round intents provide explicit scope while precheck has no invented attempt', { timeout: 60000 }, async t => {
  const c = await setup();
  t.after(() => c.close());
  await c.kit.authorizations.assignResource(c.admin,c.environment.id,c.admin.id);
  const precheck = await c.service.precheck(c.admin, c.executor.id);
  const readOnly = await c.service.scopedFacts(c.admin, precheck.job);
  assert.equal(readOnly.dispatch_attempt, undefined);
  assert.equal(readOnly.job_facts.missing_facts, undefined, 'precheck without an intent has no missing dispatch round');
  assert.equal(readOnly.job_facts.admission_error, undefined);
  assert.equal(readOnly.job_facts.readonly_verified, true);
  const precheckBinding = await c.service.journal.binding(precheck.job);
  assert.equal(Reflect.get(precheckBinding, 'operation'), 'precheck');
  const state = await c.service.dispatch(c.admin, c.run, c.executor.id);
  const events = await c.service.journal.events(state.job);
  const intent = events.find(event => event.body.detail.phase === 'intent');
  assert.ok(intent);
  assert.equal(intent.body.detail.round, 1, 'the writer knows the program round; the reader does not guess');
  assert.equal(Reflect.get(await c.service.journal.binding(state.job), 'operation'), 'dispatch');
  const scoped = await c.service.scopedFacts(c.admin, state.job);
  assert.deepEqual(scoped.dispatch_attempt?.scope, { operation:'dispatch', job: state.job, round: 1, request_id: intent.body.detail.request_id });
});


test('a historical round is resolved only by a readable frozen single-round rule', { timeout: 60000 }, async t => {
  const c = await setup();
  t.after(() => c.close());
  const append = c.service.journal.append.bind(c.service.journal);
  // Historical-writer fixture: omit only the newly added round metadata before the
  // real journal persists the intent. All responses, receipts and completions are
  // still produced by the real service and gateway, never fabricated or rewritten.
  t.mock.method(c.service.journal, 'append', (...args: Parameters<typeof append>) => {
    const [binding, phase, action, result, detail = {}, ...rest] = args;
    if (phase === 'intent') {
      const { round: _newMetadata, ...historicalDetail } = detail;
      return append(binding, phase, action, result, historicalDetail, ...rest);
    }
    return append(...args);
  });
  const state = await c.service.dispatch(c.admin, c.run, c.executor.id);
  const events = await c.service.journal.events(state.job);
  const intent = events.find(event => event.body.detail.phase === 'intent');
  assert.ok(intent);
  assert.equal(Object.hasOwn(intent.body.detail, 'round'), false);
  assert.ok(events.some(event => event.body.detail.phase === 'receipt' && event.body.detail.acceptance === 'accepted'));
  assert.equal(c.calls.filter(name => name === 'send_blob').length, 1);
  const scoped = await c.service.scopedFacts(c.admin, state.job);
  assert.equal(scoped.dispatch_attempt?.scope.operation, 'dispatch');
  assert.deepEqual(scoped.dispatch_attempt?.scope, {operation:'dispatch',job:state.job,round:1,request_id:intent.body.detail.request_id});
  c.service.options.workflows = { byDigest: async () => null };
  const unknown = await c.service.scopedFacts(c.admin, state.job);
  assert.equal(unknown.dispatch_attempt, undefined);
  assert.deepEqual(unknown.job_facts.scope, { job: state.job });
  assert.equal(unknown.job_facts.reservation_recorded, true);
  assert.deepEqual(unknown.job_facts.missing_facts, [{
    fact: '原派发意图缺少可核对的轮次范围，当前不能确定它属于哪一轮',
    next_action: '只读核对该原意图记录，保留范围未知；不要为了补齐轮次而重新派发',
  }]);
  assert.ok(unknown.job_facts.missing_facts);
  assert.equal(unknown.job_facts.next_action, unknown.job_facts.missing_facts[0].next_action);
  assert.ok(unknown.job_facts.grounds?.includes(`rec:${intent.digest}`));
  assert.equal((await c.service.scopedFacts(c.admin, state.job, 1)).dispatch_attempt, undefined);
  assert.deepEqual((await c.service.journal.events(state.job)).map(event => event.digest), events.map(event => event.digest));
});


test('a zero-write response is not a terminal no-send outcome before its real completion is persisted', { timeout: 60000 }, async t => {
  const c = await repeatedFixture();
  const reached = Promise.withResolvers<string>();
  const release = Promise.withResolvers<void>();
  const append = c.service.journal.append.bind(c.service.journal);
  const request = http.request;
  t.mock.method(c.service.journal, 'append', async (...args: Parameters<typeof append>) => {
    const [binding, phase, , , detail = {}] = args;
    if (phase === 'complete' && detail.done === true && detail.outcome === 'not_dispatched') {
      reached.resolve(binding.job);
      await release.promise;
    }
    return append(...args);
  });
  c.service.options.beforeRound = async round => {
    assert.equal(round, 2);
    const abortRequest = t.mock.method(http, 'request', (url: URL, options: http.RequestOptions, listener: (response: http.IncomingMessage) => void) => {
      abortRequest.mock.restore();
      syncBuiltinESMExports();
      return request(url, { ...options, signal: AbortSignal.abort() }, listener);
    });
    syncBuiltinESMExports();
  };
  const running = c.service.dispatch(c.admin, c.run, c.executor.id);
  t.after(async () => {
    release.resolve();
    await running.catch(() => {});
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await c.close();
  });
  try {
    const job = await Promise.race([reached.promise, running.then(() => { throw new Error('dispatch ended without reaching the real completion append'); })]);
    const events = await c.service.journal.events(job);
    assert.equal(events.some(event => event.body.detail.phase === 'complete'), false);
    assert.equal(holdsPhysicalTarget(events),true,'the active scope remains exclusive until the real completion');
    const intent = events.findLast(event => event.body.detail.phase === 'intent');
    assert.ok(intent);
    assert.equal(intent.body.detail.round, 2);
    const zeroWrite = events.slice(events.indexOf(intent) + 1).find(event => event.body.detail.phase === 'submit.response');
    assert.ok(zeroWrite);
    assert.equal(zeroWrite.body.detail.request_bytes_written, 0);
    assert.equal(zeroWrite.body.detail.complete, false);
    assert.equal(zeroWrite.body.detail.http_status, 0);
    const pending = await c.service.scopedFacts(c.admin, job);
    const pendingScope=pending.dispatch_attempt?.scope;
    assert.ok(pendingScope&&pendingScope.operation==='dispatch');
    assert.equal(pendingScope.round,2);
    assert.equal(pending.dispatch_attempt?.submit_invoked, true);
    assert.ok(pending.dispatch_attempt?.grounds?.includes(`rec:${zeroWrite.digest}`));
    assert.equal(pending.dispatch_attempt?.not_sent, undefined, 'zero bytes do not prove the scope has finished');
    assert.equal(pending.dispatch_attempt?.outcome, undefined, 'do not expose a retryable terminal outcome while the worker is paused');
    assert.deepEqual((await c.service.journal.events(job)).map(event => event.digest), events.map(event => event.digest));
    release.resolve();
    await running;
    const terminal = await c.service.scopedFacts(c.admin, job);
    assert.deepEqual(terminal.dispatch_attempt?.scope, pending.dispatch_attempt?.scope);
    assert.equal(terminal.dispatch_attempt?.not_sent, true);
    assert.equal(terminal.dispatch_attempt?.outcome, 'not_dispatched');
    assert.equal(terminal.dispatch_attempt?.submit_invoked, true);
    assert.equal(c.calls.filter(name => name === 'send_blob').length, 1);
    const finalEvents = await c.service.journal.events(job);
    assert.equal(holdsPhysicalTarget(finalEvents),false,'a completed accepted earlier round does not cause a permanent hold');
    const complete = finalEvents.findLast(event => event.body.detail.phase === 'complete');
    assert.ok(complete?.body.inputs.includes(`rec:${intent.digest}`));
    assert.ok(finalEvents.some(event => event.body.detail.phase === 'receipt' && event.body.detail.acceptance === 'accepted'));
    assert.ok(finalEvents.some(event => event.body.detail.phase === 'round' && event.body.detail.round === 1 && event.body.detail.terminal === 'pass'));
  } finally {
    release.resolve();
    await running;
  }
});


test('missing rounds require verified single-round proof and invalid explicit values never coerce', () => {
  assert.equal(roundOf({}), undefined);
  assert.equal(roundOf({}, true), 1);
  for (const round of [undefined, null, 0, -1, 1.5, '1', false]) assert.equal(roundOf({round}, true), undefined);
  assert.equal(roundOf({round:2}), 2);
});


test('a confirmed admission refusal has a real job error but no invented dispatch attempt', { timeout: 60000 }, async t => {
  const c = await setup(); t.after(() => c.close());
  await c.kit.authorizations.unassignResource(c.admin,c.environment.id,c.environmentTeam.id);
  const state = await c.service.dispatch(c.admin,c.run,c.executor.id);
  assert.equal(state.dispatch_attempt,undefined);
  assert.deepEqual(Object.keys(state).sort(),['events','job','job_facts']);
  assert.equal(state.job_facts.admission_error?.code,'SOURCE_NOT_PERMITTED');
  assert.equal(Object.hasOwn(state.job_facts,'outcome'),false);
  assert.equal(Object.hasOwn(state.job_facts,'not_sent'),false);
  assert.equal(c.calls.filter(name=>name==='send_blob').length,0);
  const events=await c.service.journal.events(state.job);
  assert.equal(events.some(event=>event.body.detail.phase==='intent'),false);
  assert.ok(events.some(event=>event.body.detail.phase==='boundary_refused'&&event.body.error_code==='SOURCE_NOT_PERMITTED'));
});

test('unknown premises after a real round context do not become a confirmed policy failure', { timeout: 60000 }, async t => {
  const c = await setup(); t.after(() => c.close());
  c.service.options.recheckChecks=async()=>({policy_check:[{verdict:'unknown',statement:'合成前提未核对',grounds:[],tier:'blocking',missing:'合成证据缺失'}]});
  const state=await c.service.dispatch(c.admin,c.run,c.executor.id);
  const events=await c.service.journal.events(state.job);
  const reservation=events.find(event=>event.body.detail.phase==='reservation');assert.ok(reservation);
  const binding=reservation.body.detail.binding;assert.ok(binding&&typeof binding==='object');
  assert.deepEqual(state.dispatch_attempt?.scope,Reflect.get(binding,'attempt_scope'),'scope comes from the real selected program context, never a default unknown outcome');
  assert.equal(state.dispatch_attempt?.call_error_category,null,'the policy check has no conclusion');
  assert.equal(state.job_facts.admission_error,undefined);
  assert.ok(state.dispatch_attempt?.missing_facts?.length);
  assert.ok(state.dispatch_attempt.missing_facts.every(fact=>fact.fact.length>0&&fact.next_action.length>0));
  assert.equal(state.job_facts.missing_fact,undefined,'round diagnostics are not copied to a job summary');
  assert.equal(Object.hasOwn(state.job_facts,'outcome'),false);
  assert.equal(state.dispatch_attempt.outcome,'not_dispatched','the actual stopped-before-submit fact is separate from the unknown policy conclusion');
  assert.equal(state.dispatch_attempt.submit_invoked,false);
  assert.equal(c.calls.filter(name=>name==='send_blob').length,0);
  assert.equal(events.some(event=>event.body.detail.phase==='intent'),false);
});

test('an explicit invalid historical round never borrows a frozen single-round default', { timeout: 60000 }, async t => {
  const c=await setup(); t.after(()=>c.close());
  const append=c.service.journal.append.bind(c.service.journal);
  // Controlled bad metadata at the real writer seam, not forged terminal logs.
  t.mock.method(c.service.journal,'append',(...args:Parameters<typeof append>)=>{
    const [binding,phase,action,result,detail={},...rest]=args;
    return phase==='intent'?append(binding,phase,action,result,{...detail,round:0},...rest):append(...args);
  });
  const state=await c.service.dispatch(c.admin,c.run,c.executor.id);
  const events=await c.service.journal.events(state.job);
  const intent=events.find(event=>event.body.detail.phase==='intent');assert.ok(intent);
  assert.equal(intent.body.detail.round,0);
  assert.equal(state.dispatch_attempt,undefined);
  assert.ok(state.job_facts.missing_facts?.length);
  assert.ok(state.job_facts.grounds?.includes(`rec:${intent.digest}`));
  assert.equal(Object.hasOwn(state.job_facts,'outcome'),false);
  const before=c.calls.filter(name=>name==='send_blob').length;
  assert.equal(before,1);
  await assert.rejects(c.service.dispatch(c.admin,c.run,c.executor.id),/轮次.*核对|轮次.*未知/);
  assert.equal(c.calls.filter(name=>name==='send_blob').length,before);
});


test('a later real submission cannot adopt an earlier receipt and report for the same bytes', {timeout:60000},async t=>{
  let sent=0,firstRequest:unknown;
  const c=await repeatedFixture((name,value)=>{
    if(name==='send_blob'){
      sent++;
      if(sent===1)firstRequest=value.request;
      else return {...value,request:firstRequest};
    }
    if(name==='read_blob'&&sent>1)return {...value,request:firstRequest};
    return value;
  });t.after(()=>c.close());
  const state=await c.service.dispatch(c.admin,c.run,c.executor.id);
  assert.equal(c.calls.filter(name=>name==='send_blob').length,2);
  const events=await c.service.journal.events(state.job);
  const intents=events.filter(event=>event.body.detail.phase==='intent');
  assert.deepEqual(intents.map(event=>event.body.detail.round),[1,2]);
  assert.notEqual(intents[0].body.detail.request_id,intents[1].body.detail.request_id);
  assert.equal(state.dispatch_attempt?.outcome,'unknown','a stale request identity is not a current-round effect');
  assert.equal(state.dispatch_attempt?.not_sent,undefined,'the second request really was submitted');
  assert.equal(state.job_facts.frozen,true);
  assert.equal(holdsPhysicalTarget(events),true);
  assert.equal(events.filter(event=>event.body.detail.phase==='receipt').length,1);
  assert.ok(events.some(event=>event.body.detail.phase==='round'&&event.body.detail.round===1&&event.body.detail.terminal==='pass'));
  assert.equal(events.some(event=>event.body.detail.phase==='round'&&event.body.detail.round===2&&event.body.detail.outcome==='effective'),false);
  const effects=await c.kit.store.findMany<{request_id:string|null;outcome:string}>({kind:'effect',key:'effect.job',values:[state.job]});
  assert.equal(effects.some(effect=>effect.body.request_id===intents[1].body.detail.request_id&&effect.body.outcome==='effective'),false);
  await assert.rejects(c.service.dispatch(c.admin,c.run,c.executor.id));
  assert.equal(c.calls.filter(name=>name==='send_blob').length,2,'unknown second-round delivery never resubmits either round');
});

test('a parsed scope conflicting with the actual round remains unknown for default and explicit reads', {timeout:60000},async t=>{
  const c=await setup();t.after(()=>c.close());
  const append=c.service.journal.append.bind(c.service.journal);
  t.mock.method(c.service.journal,'append',(...args:Parameters<typeof append>)=>{
    const [binding,phase,action,result,detail={},...rest]=args;
    return phase==='intent'?append(binding,phase,action,result,{...detail,round:2,scope:{operation:'dispatch',job:binding.job,round:1}},...rest):append(...args);
  });
  const state=await c.service.dispatch(c.admin,c.run,c.executor.id);
  assert.equal(state.dispatch_attempt,undefined,'shape parsing cannot override inconsistent source scope facts');
  const events=await c.service.journal.events(state.job);
  const intent=events.find(event=>event.body.detail.phase==='intent');assert.ok(intent);
  for(const round of [1,2]){
    const scoped=await c.service.scopedFacts(c.admin,state.job,round);
    assert.equal(scoped.dispatch_attempt,undefined);
    assert.ok(scoped.job_facts.missing_facts?.length);
    assert.ok(scoped.job_facts.grounds?.includes(`rec:${intent.digest}`));
  }
  assert.equal(c.calls.filter(name=>name==='send_blob').length,1);
});


test('a recorded raw device return survives a later job summary that does not repeat that reference', { timeout: 60000 }, async t => {
  const c = await setup(); t.after(() => c.close());
  const first = await c.service.dispatch(c.admin, c.run, c.executor.id);
  assert.equal(first.dispatch_attempt?.outcome, 'effective');
  assert.ok(first.job_facts.result);
  assert.match(first.job_facts.device_return ?? '', /^src:[a-f0-9]{64}$/);
  const raw = first.job_facts.device_return!;
  const before = (await c.kit.artifacts.source(c.owner, raw.slice(4)))?.bytes;
  assert.ok(before, 'the first dispatch really saved readable raw output');
  const binding = await c.service.journal.binding(first.job);
  // Historical-writer fixture: append only the job-level report summary. The
  // original execution, raw artifact and receipt came from the real dispatcher.
  // This is not a claim that the repeated fixture creates a per-round raw artifact.
  await c.service.journal.append({ ...binding, input: null, run: c.run }, 'result', 'read_back', 'completed', { reference: first.job_facts.result, items: 1 }, [first.job_facts.result]);
  const count = (await c.service.journal.events(first.job)).length;
  const read = await c.service.status(c.admin, first.job);
  assert.equal(read.job_facts.result, first.job_facts.result);
  assert.equal(read.job_facts.device_return, raw, 'a summary that omits raw output cannot erase the recorded historical reference');
  assert.deepEqual((await c.kit.artifacts.source(c.owner, raw.slice(4)))?.bytes, before);
  assert.equal((await c.service.journal.events(first.job)).length, count, 'reading the reference never repairs or writes history');
  assert.equal(c.calls.filter(name => name === 'send_blob').length, 1);
});

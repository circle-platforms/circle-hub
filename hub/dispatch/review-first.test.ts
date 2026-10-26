import {addSyntheticExecutor} from './testing/credentials.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setup } from './testing/context.ts';

test('R01 a failed lease heartbeat during prechecks prevents intent and submission',async t=>{
  const c=await setup({mode:'heartbeat-failure',ttl:60,delay:{inspect_slot:160}});t.after(()=>c.close());
  const state=await c.service.dispatch(c.admin,c.run,c.executor.id);
  assert.equal(state.outcome,'not_dispatched');assert.equal(state.frozen,false);
  assert.equal(c.calls.filter(n=>n==='send_blob').length,0);
  const events=await c.service.journal.events(state.job);
  assert.ok(events.some(e=>e.body.detail.phase==='heartbeat' && e.body.detail.lease_interrupted));
  assert.equal(events.some(e=>e.body.detail.phase==='intent'),false);
});

test('R01 heartbeat failures after submission do not permanently stop renewal attempts',async t=>{
  let sent=false,pulses=0;
  const c=await setup({ttl:600,delay:{inspect_blob:500},onSubmit:async()=>{sent=true;},alter:(name,v)=>name==='touch_slot' && sent && ++pulses===1?{...v,ok:false}:v});t.after(()=>c.close());
  const state=await c.service.dispatch(c.admin,c.run,c.executor.id);
  assert.equal(state.outcome,'effective');assert.equal(c.calls.filter(n=>n==='send_blob').length,1);
  assert.ok(pulses>=2);
  const beats=(await c.service.journal.events(state.job)).filter(e=>e.body.detail.phase==='heartbeat');
  const failed=beats.findIndex(e=>e.body.detail.lease_interrupted===true);
  assert.ok(failed>=0 && beats.slice(failed+1).some(e=>e.body.result==='completed'));
});

test('R02 rekeying an occupied executor cannot hide an unresolved effect',async t=>{
  const c=await setup({mode:'reject'});t.after(()=>c.close());
  const first=await c.service.dispatch(c.admin,c.run,c.executor.id);assert.equal(first.frozen,true);
  await assert.rejects(c.registry.update(c.admin,c.executor.id,{...c.executor.definition,resources:['synthetic/device/c']}),new RegExp(first.job));
  assert.equal(c.calls.filter(n=>n==='send_blob').length,1);
});

test('R02 simultaneous reservations serialize shared targets and origins despite different resource names',async t=>{
  const {newJob,digestOfValue}=await import('./journal.ts');
  for(const shared of ['target','origin'] as const) {
    const c=await setup();t.after(()=>c.close());
    const second=await addSyntheticExecutor(c.kit,c.registry,c.admin,{...c.executor.definition,resources:['synthetic/device/c'],...(shared==='target'?{endpoint:'http://127.0.0.1:1/'}:{target:'synthetic-other-target'})},'synthetic-other-secret');
    const binding=(executor:typeof c.executor):import('./journal.ts').JobBinding=>({job:newJob(),initiated_by:c.admin.id,executor:executor.id,executor_digest:executor.digest,target_key:digestOfValue(executor.definition.resources),scope:{target:executor.definition.target,origin:new URL(executor.definition.endpoint).origin},input:null,user:c.owner.id,resources:executor.definition.resources});
    const original=c.service.journal.blockers.bind(c.service.journal);let arrived=0;
    let release!:()=>void;const both=new Promise<void>(resolve=>{release=resolve;});
    c.service.journal.blockers=async(...args)=>{const blockers=await original(...args);if(++arrived===2)release();await both;return blockers;};
    const reserve=c.service as unknown as {reserve(binding:import('./journal.ts').JobBinding):Promise<void>};
    const results=await Promise.allSettled([reserve.reserve(binding(c.executor)),reserve.reserve(binding(second))]);
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1,`shared ${shared} must permit only one reservation`);
    const failed=results.find(r=>r.status==='rejected') as PromiseRejectedResult;assert.match(String(failed.reason),/预留/);
    assert.equal(c.calls.length,0);await c.close();
  }
});

test('R03 accepted work awaiting a readable terminal cannot be disposed as if its effect were unknown',async t=>{
  for(const choice of ['mark_failed','keep_unknown','reconcile'] as const) {
    const c=await setup({alter:(name,v)=>name==='inspect_blob'?{ok:false,error:'synthetic unavailable'}:v});t.after(()=>c.close());
    const state=await c.service.dispatch(c.admin,c.run,c.executor.id);assert.equal(state.outcome,'issued');assert.equal(state.frozen,false);
    await assert.rejects(c.service.dispose(c.admin,state.job,{choice,remote_id:'synthetic-remote',reason:'synthetic',acceptPossibleDuplicateEffects:true}),/resume/);
    assert.equal((await c.service.status(c.admin,state.job)).frozen,false);await c.close();
  }
});

test('R03 repeated unreadable accepted work escalates to a named disposition request rather than occupying forever',async t=>{
  const c=await setup({alter:(name,v)=>name==='inspect_blob'?{ok:false,error:'synthetic unavailable'}:v});t.after(()=>c.close());
  const first=await c.service.dispatch(c.admin,c.run,c.executor.id);
  await c.service.resume(c.admin,first.job);const third=await c.service.resume(c.admin,first.job);
  assert.equal(third.frozen,true);assert.equal(c.calls.filter(n=>n==='send_blob').length,1);
  assert.ok((await c.service.journal.events(first.job)).some(e=>e.body.detail.request_kind==='disposition'));
});

test('R04 a local post-intent fence refusal proves no submission rather than inventing an unknown remote id',async t=>{
  const c=await setup();t.after(()=>c.close());
  const holders=c.leases.holderSnapshot.bind(c.leases);let injected=false;
  c.leases.holderSnapshot=async (keys,tx)=>{
    const values=await holders(keys,tx);
    const intents=await c.kit.store.findMany({kind:'action',key:'dispatch.phase',values:['intent']});
    if(!injected&&intents.length){injected=true;return values.map(v=>({...v,fencing:v.fencing+1,lease:'different-lease'}));}
    return values;
  };
  const result=await c.service.dispatch(c.admin,c.run,c.executor.id);
  assert.equal(result.outcome,'not_dispatched');assert.equal(result.frozen,false);assert.equal(c.calls.filter(n=>n==='send_blob').length,0);
  assert.ok((await c.service.journal.events(result.job)).some(e=>e.body.detail.submit_invoked===false && e.body.detail.done===true));
});

test('R05 action records separate an intent from a submission with no trustworthy reply',async t=>{
  const c=await setup({mode:'disconnect'});t.after(()=>c.close());
  const state=await c.service.dispatch(c.admin,c.run,c.executor.id);const events=await c.service.journal.events(state.job);
  const intent=events.find(e=>e.body.detail.phase==='intent')!;assert.equal(intent.body.action,'dispatch');assert.equal(intent.body.acceptance,'accepted');
  const reply=events.find(e=>e.body.detail.phase==='submit.response')!;assert.equal(reply.body.action,'dispatch');assert.equal(reply.body.result,'unknown');assert.equal(reply.body.error_code,null);
  const unknown=events.find(e=>e.body.detail.phase==='unknown')!;assert.equal(unknown.body.action,'validate');
});

test('R06 unresolved jobs are discoverable without remembering a lost terminal digest',async t=>{
  const c=await setup({mode:'reject'});t.after(()=>c.close());
  const first=await c.service.dispatch(c.admin,c.run,c.executor.id);
  const jobs=await c.service.list(c.admin,c.executor.id);
  assert.ok(jobs.some(job=>job.job===first.job && job.frozen && job.next_action));
});

test('R07 an observation failure after a successful reconcile never falsifies the match',async t=>{
  let statusReads=0;
  const c=await setup({mode:'reject',alter:(name,v)=>name==='inspect_blob' && ++statusReads>1?{ok:false,error:'synthetic read unavailable'}:v});t.after(()=>c.close());
  const first=await c.service.dispatch(c.admin,c.run,c.executor.id);
  const state=await c.service.dispose(c.admin,first.job,{choice:'reconcile',remote_id:'synthetic-remote'});
  assert.equal(state.frozen,false);assert.equal(state.outcome,'issued');assert.match(state.next_action!,/resume/);
  const events=await c.service.journal.events(first.job);
  const match=events.findIndex(e=>e.body.detail.identity_matched===true);
  assert.ok(match>=0);assert.equal(events.slice(match+1).some(e=>e.body.detail.uncertain===true),false);
});

test('R08 the submit tool cannot be reused by any automatically polled role',async()=>{
  const {definition}=await import('./testing/definition.ts');const {ExecutorDefinition}=await import('./definition.ts');
  for(const role of ['status','heartbeat','precheck'] as const){const d=definition('http://127.0.0.1:1/');d.calls[role].tool=d.calls.submit.tool;assert.equal(ExecutorDefinition.safeParse(d).success,false);}
  const d=definition('http://127.0.0.1:1/');assert.equal(ExecutorDefinition.safeParse({...d,precheck_reads:[{...d.calls.status,tool:d.calls.submit.tool}]}).success,false);
});

test('R09 a risk disposition is visible and does not pretend the original effect was resent',async t=>{
  const c=await setup({mode:'reject'});t.after(()=>c.close());const first=await c.service.dispatch(c.admin,c.run,c.executor.id);
  const state=await c.service.dispose(c.admin,first.job,{choice:'mark_failed',reason:'synthetic risk decision',acceptPossibleDuplicateEffects:true});
  assert.equal(state.outcome,'unknown');assert.ok(state.marks?.includes('disposed'));assert.equal(state.disposition,'mark_failed');assert.equal(state.decided_by,c.admin.id);assert.ok(state.missing_fact && state.next_action);
  const decision=(await c.service.journal.events(first.job)).find(e=>e.body.detail.risk_confirmed===true)!;assert.equal(decision.body.detail.possible_duplicate,undefined);
});

test('R10 the booking must cover submission plus the entire observation window',async t=>{
  const c=await setup();t.after(()=>c.close());
  await c.leases.forceRelease({keys:c.executor.definition.resources,by:c.admin.id,reason:'synthetic short booking'});
  await c.leases.acquire({keys:c.executor.definition.resources,prefix:'synthetic/',ttlSeconds:15,maxTtlSeconds:3600,holder:{user:c.owner.id,run:c.run}});
  assert.equal((await c.service.dispatch(c.admin,c.run,c.executor.id)).outcome,'not_dispatched');
  assert.equal(c.calls.filter(n=>n==='send_blob').length,0);
});

test('R11 positive reconciliation treats foreign timestamps as records regardless of clock tolerance',async t=>{
  for(const tolerance of [0,2000]){
    const c=await setup({mode:'reject',alter:(name,v)=>name==='read_blob'?{...v,submitted:'2026-10-22T23:59:59.000Z'}:v});t.after(()=>c.close());
    const first=await c.service.dispatch(c.admin,c.run,c.executor.id);
    if(tolerance)await c.registry.update(c.admin,c.executor.id,{...c.executor.definition,clock_skew_ms:tolerance});
    assert.equal((await c.service.dispose(c.admin,first.job,{choice:'reconcile',remote_id:'synthetic-remote'})).outcome,'effective');
    assert.equal(c.calls.filter(name=>name==='send_blob').length,1);
  }
});

test('R11 submission timeout consumes only the remaining committed window',async t=>{
  const c=await setup({timeout:150,onSubmit:async()=>{await new Promise(resolve=>setTimeout(resolve,100));}});t.after(()=>c.close());
  const transaction=c.kit.store.withTransaction.bind(c.kit.store);let changed=false;
  c.kit.store.withTransaction=async(fn,parent)=>{const value=await transaction(fn,parent);if(!changed && await c.kit.store.getByKey('action',`dispatch.bytes:${c.payload.body.sha256}:1`)){changed=true;c.clock.ms+=100;}return value;};
  const result=await c.service.dispatch(c.admin,c.run,c.executor.id);
  assert.equal(result.outcome,'unknown');assert.equal(c.calls.filter(n=>n==='send_blob').length,1);
});

test('R12 every main condition is recorded and cited by the intent',async t=>{
  const c=await setup();t.after(()=>c.close());const state=await c.service.dispatch(c.admin,c.run,c.executor.id);const events=await c.service.journal.events(state.job);
  const assessed=events.find(e=>e.body.detail.phase==='precheck.evaluated')!;assert.ok(assessed);
  assert.equal((assessed.body.detail.conditions as any[]).length,c.executor.definition.conditions.length);
  const intent=events.find(e=>e.body.detail.phase==='intent')!;assert.ok(assessed.body.inputs.every(ref=>intent.body.inputs.includes(ref)));
});

test('R13 the newest accepted verification is reread and its current record authorizes unchanged bytes',async t=>{
  let c:Awaited<ReturnType<typeof setup>>;const newer='d'.repeat(64);
  c=await setup({alter:(name,v)=>{if(name==='inspect_slot')c.detail.latest!.record=newer;return v;}});t.after(()=>c.close());
  const state=await c.service.dispatch(c.admin,c.run,c.executor.id);
  const intent=(await c.service.journal.events(state.job)).find(e=>e.body.detail.phase==='intent')!;
  assert.equal(intent.body.detail.verification_result,newer);assert.ok(intent.body.inputs.includes(`rec:${newer}`));
});

test('R14 legacy definitions remain readable and repairable but cannot dispatch without a named verifier',async t=>{
  const c=await setup();t.after(()=>c.close());const {canonicalBytes}=await import('../records/api.ts');
  const old=structuredClone(c.executor.definition) as any;delete old.proof.warrant_id;
  const bytes=canonicalBytes(old);const stored=await c.kit.objects.put(bytes,'application/json');
  await c.kit.authorizations.configureResource(c.admin,`executor.${c.executor.id}`,stored.sha256);
  const entries=await c.registry.list(c.admin);assert.equal(entries.length,1);
  await assert.rejects(c.service.dispatch(c.admin,c.run,c.executor.id),/warrant_id/);assert.equal(c.calls.length,0);
  await c.registry.disable(c.admin,c.executor.id);
  await c.registry.update(c.admin,c.executor.id,{...old,proof:{...old.proof,warrant_id:'synthetic.verify@1'}});
  assert.deepEqual(await c.kit.objects.get(stored.sha256),bytes);
});

test('R19 an administrator choice is a validation rather than a fictitious readback',async t=>{
  const c=await setup({mode:'reject'});t.after(()=>c.close());const first=await c.service.dispatch(c.admin,c.run,c.executor.id);
  await c.service.dispose(c.admin,first.job,{choice:'keep_unknown'});
  const choice=(await c.service.journal.events(first.job)).find(e=>e.body.detail.disposition==='keep_unknown')!;
  assert.equal(choice.body.action,'validate');
});

test('R22 an existing receipt cannot be reconciled to another remote job with equal bytes',async t=>{
  const c=await setup({mode:'lost',alter:(name,v)=>name==='read_blob'?{...v,key:'different-remote'}:v});t.after(()=>c.close());
  const first=await c.service.dispatch(c.admin,c.run,c.executor.id);assert.equal(first.frozen,true);assert.match(first.next_action!,/synthetic-remote/);
  await assert.rejects(c.service.dispose(c.admin,first.job,{choice:'reconcile',remote_id:'different-remote'}),/原|回执/);
  assert.equal(c.calls.filter(n=>n==='read_blob').length,0);
});

test('R22 recovered target evidence is not fabricated as an original receipt',async t=>{
  const c=await setup({mode:'reject'});t.after(()=>c.close());const first=await c.service.dispatch(c.admin,c.run,c.executor.id);
  const state=await c.service.dispose(c.admin,first.job,{choice:'reconcile',remote_id:'synthetic-remote'});
  assert.equal(state.outcome,'effective');const events=await c.service.journal.events(first.job);
  assert.equal(events.filter(e=>e.body.detail.phase==='receipt').length,0);assert.ok(events.some(e=>e.body.detail.phase==='reconciled' && e.body.detail.acceptance==='accepted'));
});

test('R23 answering one request never implicitly answers another request',async()=>{
  const {isFrozen}=await import('./journal.ts');
  const request=(digest:string)=>({digest,body:{detail:{phase:'unknown',uncertain:true,request_kind:'disposition',question_sha256:digest}}}) as any;
  const a=request('a'.repeat(64)),b=request('b'.repeat(64));
  const answer={digest:'c'.repeat(64),body:{detail:{unfreeze:true,answers:[`rec:${a.digest}`]}}} as any;
  assert.equal(isFrozen([a,b,answer]),true);
});

test('R23 disposition answers cite the concrete question and automatic rereads are not repair requests',async t=>{
  const c=await setup({mode:'reject'});t.after(()=>c.close());const first=await c.service.dispatch(c.admin,c.run,c.executor.id);
  const question=(await c.service.journal.events(first.job)).find(e=>e.body.detail.phase==='unknown')!;
  assert.match(String(question.body.detail.question_sha256),/^[a-f0-9]{64}$/);assert.ok(question.body.detail.deadline && question.body.detail.channel);
  await c.service.dispose(c.admin,first.job,{choice:'keep_unknown'});
  const answer=(await c.service.journal.events(first.job)).find(e=>e.body.detail.disposition==='keep_unknown')!;
  assert.ok(answer.body.inputs.includes(`rec:${question.digest}`));assert.ok((answer.body.detail.answers as string[]).includes(`rec:${question.digest}`));
});

test('R25 remote renewal failures do not borrow unrelated core lease conflict codes',async t=>{
  const c=await setup({mode:'heartbeat-failure',ttl:60,delay:{inspect_slot:160}});t.after(()=>c.close());
  const state=await c.service.dispatch(c.admin,c.run,c.executor.id);
  const failures=(await c.service.journal.events(state.job)).filter(e=>e.body.detail.phase==='heartbeat' && e.body.result==='error');
  assert.ok(failures.length);assert.ok(failures.every(e=>e.body.error_code===null && e.body.codes.length===0));
});

test('R26 target lease operations retain lease action kinds and generated operations',async t=>{
  const c=await setup();t.after(()=>c.close());const state=await c.service.dispatch(c.admin,c.run,c.executor.id);
  const events=await c.service.journal.events(state.job);
  for(const [phase,op] of [['acquire','acquire'],['release','release']]) {
    const event=events.find(e=>e.body.detail.phase===phase)!;assert.equal(event.body.action,'lease');assert.equal(event.body.detail.op,op);
  }
});

test('R27 a completed fence check records its observed drift and continuity limits honestly',async t=>{
  const c=await setup({mode:'fencing'});t.after(()=>c.close());const state=await c.service.dispatch(c.admin,c.run,c.executor.id);
  const drift=(await c.service.journal.events(state.job)).find(e=>e.body.detail.phase==='fencing')!;
  assert.equal(drift.body.result,'completed');assert.equal(drift.body.detail.drift,true);assert.ok(drift.body.detail.missing_fact && drift.body.detail.next_action);
});

test('R28 failed preconditions identify their pointers without publishing observed values',async t=>{
  const c=await setup({mode:'build'});t.after(()=>c.close());const state=await c.service.dispatch(c.admin,c.run,c.executor.id);const events=await c.service.journal.events(state.job);
  const check=events.find(e=>e.body.detail.phase==='precheck.evaluated')!;
  const failed=(check.body.detail.conditions as any[]).filter(v=>!v.matched);
  assert.equal(failed[0].pointer,'/build');assert.equal(failed[0].operator,'equals');assert.equal(failed[0].actual,undefined);
  assert.ok(state.failed_conditions?.some(v=>v.pointer==='/build'));
});

test('R34 an ordinary lineage renewal preserves the lease and is not reported as drift',async t=>{
  let c:Awaited<ReturnType<typeof setup>>;
  c=await setup({onSubmit:async()=>{const result=await c.leases.extend({keys:c.executor.definition.resources,holder:{user:c.owner.id,run:c.run},ttlSeconds:3600,maxTtlSeconds:3600});assert.equal(result.ok,true);}});t.after(()=>c.close());
  const state=await c.service.dispatch(c.admin,c.run,c.executor.id);const source=await c.kit.artifacts.source(c.owner,state.result!.slice(4));assert.ok(source?.bytes);
  const result=JSON.parse(new TextDecoder().decode(source.bytes));assert.equal(result.lease_drift,false);
});

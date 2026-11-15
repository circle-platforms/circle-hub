import assert from 'node:assert/strict';
import {test} from 'node:test';
import {currentDispatch,recoveryQuery,recoveryWait} from './recovery.ts';
import {definition} from './testing/definition.ts';
import {ExecutorDefinition} from './definition.ts';
import type {JobBinding,Event} from './journal.ts';
const identity={epoch:'synthetic-journal',since:1000,subject:{account:'synthetic-account',actor:'synthetic-user/job'}};
const event=(detail:Record<string,unknown>,digest='a'.repeat(64))=>({digest,body:{detail}} as unknown as Event);
function context(){
  const d=ExecutorDefinition.parse(definition('http://127.0.0.1:1'));
  d.calls.query={tool:'lookup_blob',arguments:{request:{$value:'request_id'}},timeout_ms:1000};
  d.reconciliation={identity:{epoch:'/epoch',since:'/since',subject:'/subject'},time_scale_ms:1000,protocol_versions:['1'],pending_states:['received','starting'],
    found:'/found',state:'/state',request_id:'/request',sha256:'/digest',id:'/task',stage:'/stage',reached_device:'/reached',gateway_time:'/clock',gc_before:'/floor',
    map:{started:'issued',not_started:'proven_not_executed',rejected:'target_rejected'}};
  d.receipt.stages={admission:'target_rejected'};
  const binding={input:{sha256:'b'.repeat(64)}} as JobBinding;
  const intent=event({phase:'intent',request_id:'original-request',request_identity:identity,request_protocol_verified:true,request_protocol_version:'1'});
  const value={...identity,since:1,found:true,state:'started',request:'original-request',digest:'b'.repeat(64),task:'original-task',reached:true};
  return {d,binding,intent,value};
}
test('running and completed remote tasks retain only the original request and task identity',()=>{
  const c=context(),answer=recoveryQuery(c.binding,c.intent,c.d,c.value);
  assert.equal(answer.remoteId,'original-task');assert.deepEqual(answer.missing,[]);assert.equal(answer.notExecuted,false);
});
test('received or starting is pending rather than a reason to resubmit',()=>{
  for(const state of ['received','starting']){
    const c=context(),answer=recoveryQuery(c.binding,c.intent,c.d,{...c.value,state,task:undefined,reached:null});
    assert.equal(answer.pending,true);assert.equal(answer.notExecuted,false);assert.deepEqual(answer.missing,[]);
  }
});
test('an explicit matched not-started record can prove no execution but a query miss cannot',()=>{
  const c=context();
  const stopped=recoveryQuery(c.binding,c.intent,c.d,{...c.value,state:'not_started',task:undefined,reached:false});
  assert.equal(stopped.notExecuted,true);assert.equal(stopped.remoteId,undefined);
  const absent=recoveryQuery(c.binding,c.intent,c.d,{...c.value,found:false,state:'not_started',reached:false});
  assert.equal(absent.notExecuted,false);assert.ok(absent.missing.some(text=>text.includes('查空')));
});
test('account actor epoch since and request identity mismatches are separate missing facts',()=>{
  const c=context();
  for(const value of [
    {...c.value,subject:{...identity.subject,account:'other-account'}},
    {...c.value,subject:{...identity.subject,actor:'other-actor'}},
    {...c.value,epoch:'other-journal'},{...c.value,since:2},{...c.value,request:'other-request'},
    {...c.value,subject:undefined},{...c.value,digest:'c'.repeat(64)},
  ]){
    const answer=recoveryQuery(c.binding,c.intent,c.d,value);
    assert.equal(answer.remoteId,undefined);assert.equal(answer.notExecuted,false);assert.ok(answer.missing.length);
  }
});
test('missing frozen protocol or original subject evidence is unknown rather than an old-format fallback',()=>{
  const c=context();
  for(const detail of [{...c.intent.body.detail,request_identity:undefined},{...c.intent.body.detail,request_protocol_verified:false}]){
    const answer=recoveryQuery(c.binding,event(detail),c.d,c.value);
    assert.ok(answer.missing.length);assert.equal(answer.remoteId,undefined);
  }
});
test('a previous round completion cannot conceal the current request and a pending report remains unfinished',()=>{
  const old=event({phase:'complete',done:true,outcome:'effective'});
  const intent=event({phase:'intent'},'d'.repeat(64));
  assert.equal(currentDispatch([old,intent]).finished,false);
  assert.equal(currentDispatch([old,intent,event({phase:'result',report_pending:true}),event({phase:'complete',done:true,outcome:'effective',report_pending:true})]).finished,false);
  assert.equal(currentDispatch([old,intent,event({phase:'result',report_pending:false}),event({phase:'complete',done:true,outcome:'effective'})]).finished,true);
});
test('a later explicit disposition remains final and is not revived by automatic recovery',()=>{
  const rows=[event({phase:'intent'}),event({phase:'dispose',disposition:'mark_failed',risk_confirmed:true,unfreeze:true})];
  assert.equal(currentDispatch(rows).finished,true);
});
test('shutdown cancels an observation delay without waiting for an injected slow step',async()=>{
  const controller=new AbortController();let release!:()=>void;
  const step=new Promise<void>(resolve=>{release=resolve;});
  const pending=recoveryWait(60000,controller.signal,()=>step);
  controller.abort();await pending;release();
});

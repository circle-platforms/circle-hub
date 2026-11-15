import assert from 'node:assert/strict';
import {test} from 'node:test';
import {holdsPhysicalTarget,isConservativelyFrozen,type Event} from './journal.ts';
import {sha256Hex,type ActionBody} from '../records/api.ts';

// Synthetic predicate inputs only; these fixtures are not persisted or presented as PG observations.
const job='a'.repeat(64),at='2026-11-15T00:00:00.000Z';
function event(detail:Record<string,unknown>,inputs:string[]=[]):Event{
  const body:ActionBody={action:'validate',run:null,item:null,inputs,component:'dispatch@1',lease:null,started_at:at,ended_at:at,result:'completed',error_code:null,acceptance:null,codes:[],detail:{job,...detail}};
  return {id:'1',kind:'action',schema:'action@1',digest:sha256Hex(JSON.stringify(body)),provenance:'observed',created_at:at,body};
}
const reservation=()=>event({phase:'reservation',binding:{job,resources:['synthetic/seat'],scope:{target:'synthetic-target',origin:'https://executor.invalid'}}});

test('no-intent unknown is held even without an open disposition marker',()=>{
  assert.equal(holdsPhysicalTarget([reservation(),event({phase:'complete',done:true,outcome:'unknown'})]),true);
});
test('no-intent missing effect evidence is held rather than inferred from phase',()=>{
  assert.equal(holdsPhysicalTarget([reservation(),event({phase:'complete',done:true})]),true);
});
test('a genuine no-invocation terminal is releasable without naming its phase',()=>{
  assert.equal(holdsPhysicalTarget([reservation(),event({phase:'synthetic_terminal',done:true,outcome:'not_dispatched',submit_invoked:false})]),false);
});
test('the latest negative summary cannot terminate an earlier unaccounted accepted request',()=>{
  const first=event({phase:'intent',round:1,request_id:'synthetic-first'});
  const second=event({phase:'intent',round:2,request_id:'synthetic-second'});
  assert.equal(holdsPhysicalTarget([reservation(),first,event({phase:'receipt',acceptance:'accepted'}),second,event({phase:'complete',done:true,outcome:'not_dispatched',not_sent:true,submit_invoked:true},[`rec:${second.digest}`])]),true);
});
test('accepted history does not hold forever when every request has trustworthy terminal evidence',()=>{
  const first=event({phase:'intent',round:1,request_id:'synthetic-first'});
  const second=event({phase:'intent',round:2,request_id:'synthetic-second'});
  assert.equal(holdsPhysicalTarget([reservation(),first,event({phase:'receipt',acceptance:'accepted'}),event({phase:'round',round:1,terminal:'pass',outcome:'effective'}),second,event({phase:'complete',done:true,outcome:'not_dispatched',not_sent:true,submit_invoked:true},[`rec:${second.digest}`])]),false);
});


test('a missing receipt freezes control until a real control decision exists',()=>{
  assert.equal(isConservativelyFrozen([reservation()],true),true);
});
test('confirmed risk consent unfreezes control while the physical effect remains unknown',()=>{
  const unknown=event({phase:'unknown',uncertain:true,outcome:'unknown'});
  const consent=event({phase:'dispose',disposition:'mark_failed',risk_confirmed:true,unfreeze:true,done:true,effect_mark:'disposed',answers:[`rec:${unknown.digest}`]});
  const history=[reservation(),unknown,consent];
  assert.equal(isConservativelyFrozen(history,true),false);
  assert.equal(holdsPhysicalTarget(history),false);
});
test('unconfirmed risk does not unfreeze an unanswered request',()=>{
  const unknown=event({phase:'unknown',uncertain:true,outcome:'unknown'});
  assert.equal(isConservativelyFrozen([reservation(),unknown,event({phase:'dispose',disposition:'mark_failed',risk_confirmed:false,unfreeze:false,done:false,effect_mark:'disposed'})],true),true);
});
test('risk consent for a different question cannot clear the current request',()=>{
  const unknown=event({phase:'unknown',uncertain:true,outcome:'unknown'});
  assert.equal(isConservativelyFrozen([reservation(),unknown,event({phase:'dispose',disposition:'mark_failed',risk_confirmed:true,unfreeze:true,done:true,effect_mark:'disposed',answers:[`rec:${'b'.repeat(64)}`]})],true),true);
});
test('old risk consent never clears a later unresolved use or unknown observation',()=>{
  const consent=event({phase:'dispose',disposition:'mark_failed',risk_confirmed:true,unfreeze:true,done:true,effect_mark:'disposed',answers:[]});
  const history=[reservation(),consent,event({phase:'intent',round:2}),event({phase:'unknown',outcome:'unknown'})];
  assert.equal(isConservativelyFrozen(history,true),true);
  assert.equal(holdsPhysicalTarget(history),true);
});
test('reconcile label alone cannot substitute for a genuinely missing receipt',()=>{
  const unknown=event({phase:'unknown',uncertain:true,outcome:'unknown'});
  const repaired=event({phase:'dispose',disposition:'reconcile',identity_matched:true,digest_matched:true,unfreeze:true,effect_mark:'disposed',answers:[`rec:${unknown.digest}`]});
  assert.equal(isConservativelyFrozen([reservation(),unknown,repaired],true),true);
  assert.equal(isConservativelyFrozen([reservation(),unknown,repaired],false),false);
});


test('an unscoped terminal with unknown effects remains conservatively frozen',()=>{
  assert.equal(isConservativelyFrozen([reservation(),event({phase:'complete',done:true,outcome:'unknown'})],false),true);
  assert.equal(isConservativelyFrozen([reservation(),event({phase:'complete',done:true})],false),true);
});


test('a matched current receipt and closed question permit observation without claiming effects ended',()=>{
  const intent=event({phase:'intent',round:1,request_id:'synthetic-request'});
  const unknown=event({phase:'unknown',uncertain:true,outcome:'unknown'});
  const match=event({phase:'dispose',disposition:'reconcile',identity_matched:true,digest_matched:true,unfreeze:true,answers:[`rec:${unknown.digest}`]});
  const receipt=event({phase:'reconciled',acceptance:'accepted',remote_id:'synthetic-remote'},[`rec:${intent.digest}`]);
  const pending=event({phase:'read_pending',missing_fact:'synthetic report unavailable'});
  const history=[reservation(),intent,unknown,match,receipt,pending];
  assert.equal(isConservativelyFrozen(history,false),false);
  assert.equal(holdsPhysicalTarget(history),true,'no physical terminal was proved, so occupancy stays exclusive');
  assert.equal(unknown.body.detail.outcome,'unknown','closing the question does not rewrite its effect claim');
});

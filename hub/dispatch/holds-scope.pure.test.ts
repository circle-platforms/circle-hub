import assert from 'node:assert/strict';
import {test} from 'node:test';
import {holdsPhysicalTarget,type Event} from './journal.ts';
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

import assert from 'node:assert/strict';
import {test} from 'node:test';
import {receiptOf,openRequests,type Event} from './journal.ts';
import {bytesKey,roundOf,roundPolicy,repeats} from './rounds.ts';
import {sha256Hex,type ActionBody} from '../records/api.ts';

// Pure selector inputs, not persisted observations or an end-to-end recovery receipt.
const job='c'.repeat(64),at='2026-11-15T00:00:00.000Z';
function record(detail:Record<string,unknown>,inputs:string[]=[]):Event{
  const body:ActionBody={action:'validate',run:null,item:null,inputs,component:'dispatch@1',lease:null,started_at:at,ended_at:at,result:'completed',error_code:null,acceptance:null,codes:[],detail:{job,...detail}};
  return {id:'1',kind:'action',schema:'action@1',digest:sha256Hex(JSON.stringify(body)),provenance:'observed',created_at:at,body};
}

test('recovery never borrows an accepted receipt across a later wire intent',()=>{
  const first=record({phase:'intent',round:1,request_id:'synthetic-first'});
  const receipt=record({phase:'receipt',acceptance:'accepted',remote_id:'synthetic-shared-remote'},[`rec:${first.digest}`]);
  const second=record({phase:'intent',round:2,request_id:'synthetic-second'});
  assert.equal(receiptOf([first,receipt]),receipt);
  assert.equal(receiptOf([first,receipt,second]),undefined);
});
test('authenticated reconciliation is selected in its own request interval even with a reused remote identifier',()=>{
  const first=record({phase:'intent',round:1,request_id:'synthetic-first'});
  const old=record({phase:'receipt',acceptance:'accepted',remote_id:'synthetic-shared-remote'},[`rec:${first.digest}`]);
  const second=record({phase:'intent',round:2,request_id:'synthetic-second'});
  const current=record({phase:'reconciled',acceptance:'accepted',remote_id:'synthetic-shared-remote'},[`rec:${second.digest}`]);
  assert.equal(receiptOf([first,old,second,current]),current,'the selector uses the current record, not remote-id equality as an attribution proof');
});
test('a new conformance intent cannot inherit a dispatch receipt or fabricate a missing reconciled identity',()=>{
  const first=record({phase:'intent',round:1,request_id:'synthetic-dispatch'});
  const old=record({phase:'receipt',acceptance:'accepted',remote_id:'synthetic-remote'},[`rec:${first.digest}`]);
  const probe=record({phase:'probe_intent',request_id:'synthetic-conformance'});
  const incomplete=record({phase:'reconciled',acceptance:'accepted'},[`rec:${probe.digest}`]);
  assert.equal(receiptOf([first,old,probe,incomplete]),undefined);
});
test('answering one unknown request never clears a distinct later question',()=>{
  const first=record({phase:'unknown',uncertain:true,outcome:'unknown',question_sha256:'1'.repeat(64)});
  const second=record({phase:'unknown',uncertain:true,outcome:'unknown',question_sha256:'2'.repeat(64)});
  const answer=record({phase:'dispose',unfreeze:true,answers:[`rec:${first.digest}`]});
  assert.deepEqual(openRequests([first,second,answer]).map(event=>event.digest),[second.digest]);
});
test('round retry storage identities stay distinct across round, attempt and lineage for identical bytes',()=>{
  const keys=new Set<string>();
  for(const lineage of ['synthetic-a','synthetic-b'])for(const round of [1,2])for(const attempt of [1,2])keys.add(bytesKey('d'.repeat(64),round,attempt,true,lineage));
  assert.equal(keys.size,8,'a known-unsent round retry cannot overwrite a prior round, request attempt or lineage');
});
test('missing-round interpretation requires the ordinary frozen single-submit path, not only count one',()=>{
  const ordinary=roundPolicy({requirements:[{key:'synthetic',repetition:{count:1,aggregation:'all'}}]},[],'synthetic');
  assert.equal(roundOf({}),undefined);
  assert.equal(roundOf({},ordinary.count===1&&ordinary.limit===1&&!repeats(ordinary)),1);
  for(const shaping of [{fresh_context:true},{baseline_first:true},{window_seconds:10}]){
    const shaped=roundPolicy({requirements:[{key:'synthetic',repetition:{count:1,aggregation:'all',...shaping}}]},[],'synthetic');
    assert.equal(repeats(shaped),true);
    assert.equal(roundOf({},shaped.count===1&&shaped.limit===1&&!repeats(shaped)),undefined,'the old shaping path would have recorded an explicit round');
  }
});

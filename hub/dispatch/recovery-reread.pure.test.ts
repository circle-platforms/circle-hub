import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import * as accepted from './accepted.ts';
import type {DispatchService, JobStatus} from './service.ts';
import type {Event} from './journal.ts';
import type {ActionBody, Principal, RecordsKit} from '../records/api.ts';
import {UserId} from '../../contracts/src/common.ts';
import type {EffectOutcome} from '../../contracts/generated/vocabulary.ts';

const RUN='run_01k00000000000000000000000', JOB='a'.repeat(64), NOW='2026-11-15T00:00:00.000Z';
const admin:Principal={id:UserId.parse('usr_'+'0'.repeat(26)),name:'synthetic-admin',role:'admin'};
function event(detail:Record<string,unknown>):Event {
  const body:ActionBody={action:'read_back',run:RUN,item:null,inputs:[],component:'dispatch@1',lease:null,started_at:NOW,ended_at:NOW,result:'completed',acceptance:null,error_code:null,codes:[],detail:{job:JOB,...detail}};
  return {id:'synthetic-event',kind:'action',schema:'action@1',digest:createHash('sha256').update(JSON.stringify(body)).digest('hex'),provenance:'observed',created_at:NOW,body};
}
function fixture(outcome:EffectOutcome='proven_not_executed', recovery=true, withJob=true) {
  const binding={job:JOB,executor:'exe_'+'0'.repeat(26),input:{run:RUN,plan_run:RUN,item:'synthetic-case',items:['synthetic-case'],sha256:'b'.repeat(64)}};
  const history=[event({phase:'reservation',binding}),event({phase:'intent',request_id:'synthetic-request'}),event({phase:'complete',done:true,outcome,submit_invoked:false,...(recovery?{recovery:true}:{})})];
  const status:JobStatus={job:JOB,phase:'complete',outcome,frozen:false,events:history.length,not_sent:outcome==='not_dispatched'};
  let sends=0, historyAvailable=true, sourceHistoryAvailable=true, historyReads=0;
  const records={
    store:{find:async()=>({items:withJob?[history[0]]:[],next:null}),findMany:async()=>sourceHistoryAvailable?history:[]},
    principals:{list:async()=>[admin]},objects:{get:async()=>null},
  } as unknown as RecordsKit;
  const service={options:{records},journal:{histories:async()=>{historyReads++;return historyAvailable?new Map([[JOB,history]]):new Map();}},
    status:async()=>status,dispatchAccepted:async()=>{sends++;return {started:false,reason:'synthetic dispatch port invoked'};},
  } as unknown as DispatchService;
  return {records,service,history,status,get historyReads(){return historyReads;},get sends(){return sends;},missingHistory(){historyAvailable=false;},missingSourceHistory(){sourceHistoryAvailable=false;}};
}

// Each replacement below follows Boss 15:19: recovery metadata cannot create a second retry policy.
for(const outcome of ['proven_not_executed','target_rejected','not_dispatched'] as const) test(`certified recovered ${outcome} follows the same ready retry rule as its normal conclusion`,async()=>{
  for(const recovery of [false,true]) {
    const f=fixture(outcome,recovery), before=f.history.map(row=>row.digest);
    const notes=await accepted.acceptedDispatch(f.records,f.service,RUN,true,0);
    assert.equal(f.sends,1);
    assert.equal(f.historyReads,0);
    assert.ok(notes.some(note=>/已再试/.test(note.text)));
    assert.doesNotMatch(JSON.stringify(notes),/必须.*重新预订|原样重交只读该请求/);
    assert.deepEqual(f.history.map(row=>row.digest),before);
  }
});

test('a new ready run without an old job retains its normal dispatch entry',async()=>{
  const fresh=fixture('proven_not_executed',true,false);
  await accepted.acceptedDispatch(fresh.records,fresh.service,RUN,true,0);
  assert.equal(fresh.sends,1,'the actual dispatcher still checks all premises and creates a new request identity');
});

test('an older recovered round cannot impose a different rule on the current normal conclusion',async()=>{
  const f=fixture('target_rejected',false);
  f.history.splice(1,0,event({phase:'intent',round:1}),event({phase:'complete',recovery:true,done:true,outcome:'proven_not_executed'}));
  f.status.events=f.history.length;
  await accepted.acceptedDispatch(f.records,f.service,RUN,true,0);
  assert.equal(f.sends,1);
  assert.equal(f.historyReads,0);
});

test('unfinished effective unknown and frozen jobs remain read-only regardless of recovery wording',async()=>{
  for(const kind of ['unfinished','effective','unknown','frozen']) {
    const f=fixture(kind==='effective'?'effective':kind==='unknown'?'unknown':'proven_not_executed');
    f.status.reason='synthetic recovery says no execution';
    if(kind==='unfinished') {f.history.pop();f.status.events=f.history.length;f.status.phase='running';}
    if(kind==='frozen') f.status.frozen=true;
    const notes=await accepted.acceptedDispatch(f.records,f.service,RUN,true,0);
    assert.ok(notes.length>0);
    assert.equal(f.sends,0,kind);
  }
});

test('the retired additional recovery-history query is not a new gate on an otherwise certified ready retry',async()=>{
  const f=fixture();f.missingHistory();
  await accepted.acceptedDispatch(f.records,f.service,RUN,true,0);
  assert.equal(f.sends,1);
  assert.equal(f.historyReads,0);
});

test('the original required journal-prefix integrity check still refuses a missing source history',async()=>{
  const f=fixture();f.missingSourceHistory();
  await assert.rejects(accepted.acceptedDispatch(f.records,f.service,RUN,true,0));
  assert.equal(f.sends,0);
});

test('active non-retryable and not-ready progress reads do not require a racing journal retry snapshot',async()=>{
  for(const kind of ['active','finished','not-ready']) {
    const f=fixture(kind==='active'?'issued':kind==='finished'?'effective':'proven_not_executed');
    if(kind==='active') {f.history.pop();f.status.events=f.history.length;f.status.phase='running';}
    f.history.push(event({phase:'heartbeat'}));
    const notes=await accepted.acceptedDispatch(f.records,f.service,RUN,kind!=='not-ready',0);
    assert.ok(notes.length>0);
    assert.equal(f.historyReads,0,kind);
    assert.equal(f.sends,0,kind);
  }
});

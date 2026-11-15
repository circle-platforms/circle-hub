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
  let sends=0, historyAvailable=true, historyReads=0;
  const records={
    store:{find:async()=>({items:withJob?[history[0]]:[],next:null}),findMany:async()=>history},
    principals:{list:async()=>[admin]},objects:{get:async()=>null},
  } as unknown as RecordsKit;
  const service={options:{records},journal:{histories:async()=>{historyReads++;return historyAvailable?new Map([[JOB,history]]):new Map();}},
    status:async()=>status,dispatchAccepted:async()=>{sends++;return {started:false,reason:'synthetic dispatch port invoked'};},
  } as unknown as DispatchService;
  return {records,service,history,status,get historyReads(){return historyReads;},get sends(){return sends;},missingHistory(){historyAvailable=false;}};
}

test('cache replay of a recovery-proven unexecuted request never starts another dispatch worker',async()=>{
  const f=fixture(), before=f.history.map(row=>row.digest);
  for(let repeat=0;repeat<2;repeat++) {
    const notes=await accepted.acceptedDispatch(f.records,f.service,RUN,true,0);
    assert.equal(f.sends,0);
    assert.ok(notes.some(note=>/新的核验.*重新预订/.test(note.next_action??'')));
    assert.ok(notes.some(note=>/原样重交只读/.test(note.text)));
    assert.doesNotMatch(JSON.stringify(notes),/Hub 会再试一次/);
  }
  assert.deepEqual(f.history.map(row=>row.digest),before);
});

for(const outcome of ['target_rejected','not_dispatched'] as const) test(`recovery ${outcome} is also reread-only for the original verification`,async()=>{
  const f=fixture(outcome);
  await accepted.acceptedDispatch(f.records,f.service,RUN,true,0);
  assert.equal(f.sends,0);
});

test('normal existing safe retry and a new run without an old job retain their dispatch route',async()=>{
  const normal=fixture('proven_not_executed',false);
  await accepted.acceptedDispatch(normal.records,normal.service,RUN,true,0);
  assert.equal(normal.sends,1);
  const fresh=fixture('proven_not_executed',true,false);
  await accepted.acceptedDispatch(fresh.records,fresh.service,RUN,true,0);
  assert.equal(fresh.sends,1,'the real dispatch port remains responsible for fresh verification and booking checks');
});

test('an older round recovery conclusion cannot label a later normal current intent',()=>{
  const events=[event({phase:'intent'}),event({phase:'complete',recovery:true,done:true,outcome:'proven_not_executed'}),event({phase:'intent',round:2}),event({phase:'complete',done:true,outcome:'target_rejected'})];
  assert.equal(accepted.recoveredWithoutExecution(events),false);
  assert.equal(accepted.recoveredWithoutExecution(events.slice(0,2)),true);
});

test('recovery wording alone and unfinished or effective observations cannot fabricate a recovery non-execution conclusion',()=>{
  for(const detail of [
    {phase:'complete',done:true,outcome:'proven_not_executed',reason:'recovery says not executed'},
    {phase:'complete',recovery:true,done:false,outcome:'proven_not_executed'},
    {phase:'complete',recovery:true,done:true,outcome:'effective'},
    {phase:'complete',recovery:true,done:true,outcome:'not_dispatched'},
  ]) assert.equal(accepted.recoveredWithoutExecution([event({phase:'intent'}),event(detail)]),false);
});

test('missing current journal evidence refuses retry instead of guessing the original call was not a recovered request',async()=>{
  const f=fixture();f.missingHistory();
  await assert.rejects(accepted.acceptedDispatch(f.records,f.service,RUN,true,0),/恢复事实尚未核对完整/);
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

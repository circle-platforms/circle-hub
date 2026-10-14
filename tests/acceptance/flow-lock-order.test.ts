import assert from 'node:assert/strict';
import {sandboxTest,until} from './harness.ts';
import {meridianFlow} from '../fixtures/meridian-flow.ts';

sandboxTest('Flow locking: a held task barrier prevents claim from taking an operation lock and resumes with the original fence checks',async t=>{
 const f=await meridianFlow(t);await f.h.request('/v1/workers/register',{capabilities:['flow.invoke']},'lab-east-01');const task=await f.submit('task-before-operation-lock');await until(async()=>Boolean((await f.h.db.query("SELECT 1 FROM operations WHERE task_id=$1 AND status='accepted'",[task.taskId])).rowCount));
 const barrier=await f.h.db.connect();await barrier.query('BEGIN');await barrier.query('SELECT task_id FROM tasks WHERE task_id=$1 FOR UPDATE',[task.taskId]);let response:any,rejected:unknown,finished=false;
 const claim=f.h.request('/v1/workers/claim',{},'lab-east-01').then(value=>{response=value;finished=true;},error=>{rejected=error;finished=true;});
 try{
  const outcome=await until(async()=>{if(finished)return {finished:true};const blocked=(await f.h.db.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND lower(query) LIKE '%insert into%' AND pid<>pg_backend_pid() AND pid<>$1",[(await barrier.query('SELECT pg_backend_pid() AS pid')).rows[0].pid])).rowCount;return blocked?{finished:false}:false;},10_000);
  assert.equal(outcome.finished,true,'Claim waits for a task after acquiring lower-order locks');assert.equal(rejected,undefined);assert.equal(response,null);assert.equal((await f.h.db.query("SELECT count(*)::int AS n FROM operations WHERE task_id=$1 AND status='running'",[task.taskId])).rows[0].n,0);
 }finally{await barrier.query('ROLLBACK');barrier.release();await claim;}
 const accepted=await f.h.request('/v1/workers/claim',{},'lab-east-01');assert.ok(accepted?.operationId);assert.equal(accepted.taskId,task.taskId);const fence={fencingToken:accepted.fencingToken};await f.h.reject(`/v1/workers/operations/${accepted.operationId}/preflight`,{fencingToken:accepted.fencingToken+1},'FENCING_STALE','lab-east-01');assert.equal((await f.h.request(`/v1/workers/operations/${accepted.operationId}/preflight`,fence,'lab-east-01')).authorized,true);assert.equal(f.provider.state.submissions,0);
});

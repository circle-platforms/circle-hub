import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RecordsKit, Principal } from '../records/api.ts';
import { readRunJobs } from './read-runs.ts';
const run='run_00000000000000000000000001',plan='run_00000000000000000000000002';
const admin:Principal={id:'usr_00000000000000000000000001',name:'合成管理员',role:'admin'};
test('run dispatch reads traverse all reservation pages, retain exact bindings and never write',async()=>{
  const records={store:{find:async(query:{cursor:string|null})=>({items:query.cursor?[]:[{body:{detail:{binding:{job:'a'.repeat(64),input:{run,plan_run:plan,item:'verification',items:['case-a'],sha256:'b'.repeat(64)}}}}}],next:query.cursor?null:'second'}),findMany:async()=>Array.from({length:3},()=>({digest:'d'.repeat(64),body:{detail:{}}})),put:()=>{throw new Error('read API attempted a write');}}} as unknown as Pick<RecordsKit,'store'>;
  const seen:string[]=[];
  const dispatch={status:async(_by:Principal,job:string)=>{seen.push(job);return{job,phase:'result',outcome:'effective' as const,frozen:false,events:3,result:`src:${'c'.repeat(64)}`,admin_release:[{condition:'private_condition',label:'管理员说明',satisfied:false,fields:[]}],admin_release_missing:true};}};
  const jobs=await readRunJobs(records,dispatch,admin,plan);
  assert.equal(jobs.length,1);assert.equal(jobs[0].verification_run,run);assert.deepEqual(jobs[0].items,['case-a']);
  assert.equal(jobs[0].status.admin_release,undefined);assert.equal(jobs[0].status.admin_release_missing,undefined);
  assert.equal(jobs[0].sha256,'b'.repeat(64));assert.equal(seen.length,1);
  assert.deepEqual(await readRunJobs(records,dispatch,admin,'run_00000000000000000000000003'),[]);
});

test('read-only management projection takes the named exit from the original journal request',async()=>{
  const due='2026-10-26T00:00:00.000Z',at='2026-10-24T00:00:00.000Z',question='e'.repeat(64);
  const records={store:{find:async()=>({items:[{body:{detail:{binding:{job:'a'.repeat(64),input:{run,plan_run:plan,item:'verification',items:['case-a'],sha256:'b'.repeat(64)}}}}}],next:null}),findMany:async()=>[
    {digest:question,body:{detail:{audience_user:admin.id,deadline:due}}},
    {digest:'d'.repeat(64),body:{ended_at:at,detail:{phase:'dispose',disposition:'mark_failed',acting_by:admin.id,answers:['rec:'+question]}}}
  ],put:()=>{throw new Error('unexpected write');}}} as unknown as Pick<RecordsKit,'store'>;
  const jobs=await readRunJobs(records,{status:async()=>({job:'a'.repeat(64),phase:'disposed',outcome:'unknown',frozen:true,events:2,disposition:'mark_failed'})},admin,run);
  assert.deepEqual(jobs[0].management_exit,{action:'request',request_kind:'disposition',audience:{user:admin.id},due});
  assert.equal(jobs[0].status.decided_by,admin.id);assert.equal(jobs[0].status.decided_at,at);assert.equal(jobs[0].status.frozen,true);
});

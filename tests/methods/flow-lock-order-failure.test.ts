import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Execution} from '../../packages/execution/src/index.ts';
import {Operations} from '../../packages/execution/src/operations.ts';
import {ApiError} from '../../packages/contracts/src/index.ts';

const ctx:any={principalId:'prn_worker',tenantId:'tnt_lab',kind:'worker',workerId:'worker'};
const row={operation_id:'op_synthetic',name:'flow.invoke',task_id:'task_synthetic',input_revision_id:'inrev_synthetic',tenant_id:'tnt_lab',scope_id:'scp_lab',worker_id:'worker',fencing_token:1,status:'running',target:'synthetic'};

test('Flow locking: a rejected task and run lock callback never reaches lease or the dispatch authorization handler',async()=>{
 for(const Type of [Execution,Operations]){
  const calls:string[]=[],tx:any={query:async(sql:string,params:any[])=>{assert.deepEqual(params,[row.operation_id]);if(sql==='SELECT name FROM operations WHERE operation_id=$1')return {rows:[{name:row.name}]};assert.equal(sql,'SELECT * FROM operations WHERE operation_id=$1');return {rows:[row]};}},store:any={pool:{query:async()=>({rows:[row]})},transaction:async(fn:any)=>fn(tx)},auth:any={check:async()=>({...ctx,scopes:['scp_lab'],targets:['synthetic']}),policy:async()=>({...ctx,scopes:['scp_lab'],targets:['synthetic']})},execution:any=new Type(store,auth,{} as any,{} as any);
  execution.lease=async()=>{calls.push('lease');return row;};execution.workerCapability=async()=>{};execution.authorize=async()=>({task:{},authorization:{}});
  execution.customPreflights.set('flow.invoke',async()=>{calls.push('handler');return {row};});
  execution.customPreflightLocks.set('flow.invoke',async()=>{calls.push('lock');throw new ApiError('INPUT_REVISION_STALE','Synthetic frozen task lock rejected');});
  await assert.rejects(()=>execution.preflight(ctx,row.operation_id,1,tx),(error:any)=>error.code==='INPUT_REVISION_STALE');
  assert.deepEqual(calls,['lock']);
 }
});

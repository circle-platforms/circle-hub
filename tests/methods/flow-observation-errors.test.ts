import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ExecutionFlows} from '../../packages/execution/src/flow-driver.ts';
import {ApiError,canonicalHash,registeredErrorCode,sha256} from '../../packages/contracts/src/index.ts';

async function record(status:string,error?:any){
 let observation:any;const flows:any=Object.create(ExecutionFlows.prototype);flows.services={knowledge:{materialize:async(_tx:any,_task:any,_role:any,_name:any,_mime:any,bytes:Buffer)=>({artifactId:'art_synthetic',sha256:sha256(bytes),size:bytes.length}),evidence:async()=>({evidenceId:'evd_synthetic'})}};
 const tx:any={query:async(sql:string,args:any[])=>{if(sql.startsWith('UPDATE flow_steps'))observation=JSON.parse(args[3]);return {rows:[{binding:{method:{}}}]};}};
 await flows.record(tx,{taskId:'task_synthetic',inputRevisionId:'inrev_synthetic'},{operation_id:'op_synthetic'},{step_id:'probe',step_key:'a'.repeat(64),kind:'tool.call',occurrence:0},status,{},error);return observation;
}
test('Failed Tool observations keep a registered code and bounded message while large details remain an explicit original-backed omission',async()=>{
 const details={items:Array(257).fill('synthetic')},failure=await record('failed',new ApiError('HOOK_FAILED','Synthetic Tool rejected input',details));assert.equal(failure.facts.status,'failed');assert.deepEqual(failure.facts.result,{});assert.equal(failure.facts.error.code,'HOOK_FAILED');assert.equal(failure.facts.error.registered,true);assert.equal(registeredErrorCode(failure.facts.error.code),true);assert.equal(failure.facts.error.message,'Synthetic Tool rejected input');assert.equal(failure.facts.error.details.omitted,true);assert.equal(failure.facts.error.details.sha256,canonicalHash(details));
});
test('Failed Tool observations distinguish an absent error receipt from an empty successful Tool result',async()=>{
 const failed=await record('failed');assert.equal(failed.facts.error.code,'INTERNAL_ERROR');assert.equal(failed.facts.error.registered,true);assert.equal(failed.facts.error.details.missingError,true);const succeeded=await record('succeeded');assert.deepEqual(succeeded.facts.result,{});assert.ok(!Object.hasOwn(succeeded.facts,'error'));
});
test('Error classification never exposes an unregistered reported code as a platform classification',()=>{
 const flows:any=Object.create(ExecutionFlows.prototype),error=flows.errorMetadata({code:'UNREGISTERED_SYNTHETIC',message:'Synthetic failure',details:{}});assert.equal(error.code,'INTERNAL_ERROR');assert.equal(error.registered,true);assert.equal(error.reportedRegistered,false);assert.ok(!JSON.stringify(error).includes('UNREGISTERED_SYNTHETIC'));
 const projected=flows.errorMetadata({code:'INTERNAL_ERROR',reportedRegistered:false,message:'Synthetic failure',details:{}});assert.equal(projected.reportedRegistered,false);
});
test('An oversized error message cannot remove its registered classification or violate frame metadata limits',()=>{
 const flows:any=Object.create(ExecutionFlows.prototype),error=flows.errorMetadata({code:'HOOK_FAILED',message:'x'.repeat(33*1024),details:{}});assert.equal(error.code,'HOOK_FAILED');assert.equal(error.registered,true);assert.ok(Buffer.byteLength(error.message)<=32*1024);assert.equal(error.details.omitted,true);
});

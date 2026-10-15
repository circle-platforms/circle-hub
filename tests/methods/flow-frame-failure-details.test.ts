import assert from 'node:assert/strict';
import test from 'node:test';
import {ApiError,canonicalHash} from '../../packages/contracts/src/index.ts';
import {ExecutionFlows} from '../../packages/execution/src/flow-driver.ts';

async function failed(error:any,action?:{stepId:string;kind:string},hubCause=true){
 const flow=Object.create(ExecutionFlows.prototype);let delivered:any,persisted:any;
 flow.services={tasks:{fail:async(_tx:any,_task:any,failure:any)=>{delivered=failure;}},knowledge:{artifactReference:()=>{throw new Error('No fixture artifact exists');}}};
 const tx:any={query:async(sql:string,args:any[])=>{if(sql.startsWith('UPDATE tasks SET result='))persisted=JSON.parse(args[1]);return {rows:[],rowCount:0};}};
 await flow.fail(tx,{taskId:'task_synthetic',inputRevisionId:'inrev_synthetic'},error,action,hubCause);assert.deepEqual(persisted.error,delivered);return delivered;
}

test('Hub frame, history and budget failures retain their bounded ApiError cause without inventing an action',async()=>{
 for(const [message,details]of [['Synthetic frame metadata exceeds its bound',{component:'frame',limit:524288}],['Synthetic history original exceeds its bound',{component:'history',limit:8388608}],['Synthetic run has no remaining budget',{component:'budget',limit:1024}]] as const){
  const failure=await failed(new ApiError('RESULT_TOO_LARGE',message,details));assert.equal(failure.code,'RESULT_TOO_LARGE');assert.equal(failure.message,'Product flow did not complete');assert.equal(failure.details.component,details.component);assert.equal(failure.details.limit,details.limit);assert.deepEqual(failure.details.cause,{code:'RESULT_TOO_LARGE',registered:true,message,details});assert.ok(!Object.hasOwn(failure.details,'stepId'));assert.ok(!Object.hasOwn(failure.details,'kind'));
 }
});

test('A non-action cause keeps its message and registered code when details exceed the metadata budget',async()=>{
 const details={items:Array(257).fill('synthetic')},failure=await failed(new ApiError('RESULT_TOO_LARGE','Synthetic frame rejected\u0000 oversized history',details));assert.equal(failure.details.cause.code,'RESULT_TOO_LARGE');assert.equal(failure.details.cause.message,'Synthetic frame rejected oversized history');assert.equal(failure.details.cause.details.omitted,true);assert.equal(failure.details.cause.details.sha256,canonicalHash(details));assert.ok(!Object.hasOwn(failure.details,'stepId'));
});

test('The existing rejected-action shape and no-action helper behavior remain compatible',async()=>{
 const error=new ApiError('INVALID_PAYLOAD','A referenced binary slot is absent from its frozen original bindings'),action={stepId:'missing-original',kind:'tool.call'},failure=await failed(error,action),flow=Object.create(ExecutionFlows.prototype);assert.deepEqual(failure.details,{stepId:action.stepId,kind:action.kind,cause:{code:'INVALID_PAYLOAD',registered:true,message:error.message,details:{}}});assert.equal(flow.rejectedActionDetails(error,undefined),undefined);
});

test('Worker-shaped errors and ordinary exceptions do not become Hub causes or expose their messages',async()=>{
 for(const error of [{code:'RESULT_TOO_LARGE',message:'private-reported-message',details:{reported:true}},new Error('private-runtime-message')]){const failure=await failed(error);assert.equal(failure.message,'Product flow did not complete');assert.ok(!Object.hasOwn(failure.details,'cause'));assert.ok(!JSON.stringify(failure).includes(error.message));assert.ok(!Object.hasOwn(failure.details,'stepId'));assert.ok(!Object.hasOwn(failure.details,'kind'));}
});

test('An explicit product outcome preserves its original rule facts without claiming a Hub validation cause',async()=>{
 const details={code:'HOST_NOT_IN_BED',unmapped:[{reason:'synthetic_gap'}]},failure=await failed(new ApiError('HOOK_FAILED','Product interpretation failed',details),undefined,false);assert.equal(failure.code,'HOOK_FAILED');assert.deepEqual(failure.details,details);assert.ok(!Object.hasOwn(failure.details,'cause'));
});

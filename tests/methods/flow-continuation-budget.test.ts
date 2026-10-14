import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ExecutionFlows} from '../../packages/execution/src/flow-driver.ts';
import {flowBatchBudget} from '../../packages/execution/src/flow-budget.ts';
import {executionTransitionStepKey} from '../../packages/contracts/src/index.ts';

const task={taskId:'task_'+'a'.repeat(32),inputRevisionId:'inrev_'+'b'.repeat(32)},binding={taskId:task.taskId,inputRevisionId:task.inputRevisionId,method:{assetId:'ast_'+'c'.repeat(32),version:'1.0.0',sha256:'a'.repeat(64),capabilityPackId:'synthetic-execute',flowVersion:'synthetic/1',implementationSha256:'d'.repeat(64)},resources:{},sources:{}};
const write={kind:'provider.call',stepId:'last-write',occurrence:0,resource:'gateway',tool:'submit',args:{}};
function fixture(count:number,generation:number){
 const flow:any=Object.create(ExecutionFlows.prototype),rows=Array.from({length:count},(_,i)=>({step_key:'existing-'+i,step_id:'existing-'+i,occurrence:0,status:'succeeded'})),tx:any={query:async()=>({rows})};let frames=0;
 flow.frame=async()=>{frames++;throw new Error('Live execution binding must not be reached without continuation capacity');};return {flow,tx,run:{binding,generation},frames:()=>frames};
}

test('Continuation budget rejects a write batch that fills the final persistent step before live provider checks',async()=>{
 const f=fixture(1023,1);await assert.rejects(()=>f.flow.validateBatch(f.tx,task,f.run,{actions:[write]}),(error:any)=>error.code==='RESULT_TOO_LARGE');assert.equal(f.frames(),0);
});
test('Continuation budget rejects a write emitted by the final transition generation before live provider checks',async()=>{
 const f=fixture(1,255);await assert.rejects(()=>f.flow.validateBatch(f.tx,task,f.run,{actions:[write]}),(error:any)=>error.code==='RESULT_TOO_LARGE');assert.equal(f.frames(),0);
});
test('Continuation budget reserves exactly one next transition while final delivery may use the last step and generation',()=>{
 const f=fixture(1022,254),rows=Array.from({length:1022},(_,i)=>({step_key:'existing-'+i}));assert.deepEqual(flowBatchBudget(task,f.run,rows,[write]),{persistentSteps:1023,reservedTransitions:1});
 const full=Array.from({length:1024},(_,i)=>({step_key:'existing-'+i}));for(const kind of ['delivery.propose','outcome.error'])assert.deepEqual(flowBatchBudget(task,{...f.run,generation:255},full,[{kind}]),{persistentSteps:1024,reservedTransitions:0});
 assert.throws(()=>flowBatchBudget(task,{...f.run,generation:255},rows,[]),(error:any)=>error.code==='RESULT_TOO_LARGE');
});
test('Continuation budget counts same-key replay once but still reserves a subsequent transition',()=>{
 const f=fixture(0,254),key=executionTransitionStepKey({taskId:task.taskId,inputRevisionId:task.inputRevisionId,method:binding.method,flowVersion:binding.method.flowVersion,stepId:write.stepId,occurrence:0}),rows=Array.from({length:1023},(_,i)=>({step_key:i?('existing-'+i):key}));assert.deepEqual(flowBatchBudget(task,f.run,rows,[write,write]),{persistentSteps:1023,reservedTransitions:1});
 assert.throws(()=>flowBatchBudget(task,{...f.run,generation:255},rows,[write]),(error:any)=>error.code==='RESULT_TOO_LARGE');
});

import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ExecutionTransitionInput,ExecutionTransitionOutput,EXECUTION_TRANSITION_LIMITS,canonicalHash,executionTransitionRequestHash,executionTransitionStepKey} from '../../packages/contracts/src/index.ts';
const pin={assetId:'ast_fixture',version:'1.0.0',sha256:'a'.repeat(64)},method={...pin,capabilityPackId:'synthetic-flow',flowVersion:'synthetic/1',implementationSha256:'b'.repeat(64)},value={synthetic:true},binding={taskId:'task_fixture',inputRevisionId:'inrev_fixture',inputSha256:canonicalHash(value),method,resources:{},sources:{}};
const frame=()=>({schema:'hub-execution-transition/1',binding,currentInput:{value,sha256:binding.inputSha256},state:{},observations:[],controlledBytes:[]});
test('Occurrence metadata: optional Hub-owned expected counters remain compatible with older transition inputs',()=>{
 assert.equal(ExecutionTransitionInput.safeParse(frame()).success,true);assert.equal(ExecutionTransitionInput.safeParse({...frame(),expectedOccurrences:[{stepId:'observe',nextOccurrence:1}]}).success,true);
});
test('Occurrence metadata: counters are bounded unique identities and do not become product execution authority',()=>{
 for(const counters of [[{stepId:'observe',nextOccurrence:-1}],[{stepId:'observe',nextOccurrence:0.5}],[{stepId:'observe',nextOccurrence:0},{stepId:'observe',nextOccurrence:1}],Array.from({length:EXECUTION_TRANSITION_LIMITS.arrayItems+1},(_,i)=>({stepId:'observe-'+i,nextOccurrence:0}))])assert.equal(ExecutionTransitionInput.safeParse({...frame(),expectedOccurrences:counters}).success,false);
 assert.equal(ExecutionTransitionOutput.safeParse({schema:'hub-execution-transition/1',state:{},actions:[],expectedOccurrences:[{stepId:'observe',nextOccurrence:999}]}).success,false);
});
test('Occurrence metadata: changing or omitting a controlled original changes the request digest while the existing step key remains fixed',()=>{
 const action={kind:'tool.call',stepId:'interpret',occurrence:0,path:'tools/interpret.ts',export:'interpret',args:[],byteSlots:['original']},first={slot:'original',role:'provider-result',reference:{kind:'artifact',artifactId:'art_original',sha256:'c'.repeat(64),size:20}},second={...first,reference:{...first.reference,sha256:'d'.repeat(64)}};
 const key=executionTransitionStepKey({taskId:binding.taskId,inputRevisionId:binding.inputRevisionId,method,flowVersion:method.flowVersion,stepId:action.stepId,occurrence:0});assert.equal(key,executionTransitionStepKey({taskId:binding.taskId,inputRevisionId:binding.inputRevisionId,method,flowVersion:method.flowVersion,stepId:action.stepId,occurrence:0}));assert.notEqual(executionTransitionRequestHash(binding,action,[first]),executionTransitionRequestHash(binding,action,[second]));assert.notEqual(executionTransitionRequestHash(binding,action,[first]),executionTransitionRequestHash(binding,{...action,byteSlots:[]},[]));
});

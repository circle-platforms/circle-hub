import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ExecutionFlows} from '../../packages/execution/src/flow-driver.ts';
import {canonicalHash,canonicalJson,sha256,parseExecutionTransitionInput} from '../../packages/contracts/src/index.ts';

const pin={assetId:'ast_fixture',version:'1.0.0',sha256:'a'.repeat(64)},method={...pin,capabilityPackId:'fixture-flow',flowVersion:'fixture-flow/1',implementationSha256:'b'.repeat(64)},input={};
const task={taskId:'task_fixture',inputRevisionId:'inrev_fixture'},row={operation_id:'op_fixture'},step={step_id:'fixture',step_key:'c'.repeat(64),occurrence:0};

for(const kind of ['array','depth'])test(`Flow record projects a small ${kind} overflow through the actual B original and keeps its frame valid`,async()=>{
 let value:any=kind==='array'?{items:Array(257).fill('synthetic')}:null;if(kind==='depth'){value='synthetic';for(let i=0;i<13;i++)value={next:value};}
 let original:Buffer|undefined,stored:any;
 const flows=Object.create(ExecutionFlows.prototype);flows.services={knowledge:{materialize:async(_tx:any,_task:any,_role:any,_file:any,_mime:any,bytes:Buffer)=>{original=Buffer.from(bytes);return {artifactId:'art_fixture',sha256:sha256(bytes),size:bytes.length};},evidence:async()=>({evidenceId:'evd_fixture',sha256:'d'.repeat(64),size:17})}};
 const tx={query:async(sql:string,args:any[])=>{if(sql.startsWith('UPDATE flow_steps')){stored=JSON.parse(args[3]);return {rows:[]};}return {rows:[{binding:{method}}]};}};
 await flows.record(tx,task,row,step,'succeeded',value);assert.deepEqual(original,Buffer.from(canonicalJson(value)));assert.ok(stored.facts.result.original.slot.startsWith('hub.result.'));const reference=stored.facts.result.original.reference;assert.equal(reference.sha256,sha256(original!));
 const frame={schema:'hub-execution-transition/1',binding:{taskId:task.taskId,inputRevisionId:task.inputRevisionId,inputSha256:canonicalHash(input),method,resources:{},sources:{}},currentInput:{value:input,sha256:canonicalHash(input)},state:null,observations:[stored],controlledBytes:[{slot:stored.facts.result.original.slot,role:'provider-result',encoding:'base64',reference,contentBase64:original!.toString('base64')}]};
 assert.doesNotThrow(()=>parseExecutionTransitionInput(frame));
});

test('Flow error metadata uses the same unchanged structural budget and discloses omitted detail',()=>{
 const flows=Object.create(ExecutionFlows.prototype),value={items:Array(257).fill('synthetic')},metadata=flows.metadata(value);assert.equal(metadata.omitted,true);assert.equal(metadata.sha256,canonicalHash(value));assert.equal(metadata.size,Buffer.byteLength(canonicalJson(value)));assert.deepEqual(flows.metadata({message:'bounded'}),{message:'bounded'});
});

import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ExecutionFlows} from '../../packages/execution/src/flow-driver.ts';
import {newId} from '../../packages/contracts/src/index.ts';
import {runRunnerCycle} from '../../apps/server/src/runner-cycle.ts';

// This fake models PostgreSQL's aborted-transaction/savepoint behavior, rather
// than accepting writes after 22P05. No database or process sandbox is started.
function storageFaultScenario(){
 const badId=newId('task'),healthyId=newId('task'),badMethod=newId('ast'),healthyMethod=newId('ast'),sha='a'.repeat(64);
 let tasks=new Map([badId,healthyId].map((taskId,index)=>[taskId,{taskId,inputRevisionId:newId('inrev'),principalId:'prn_alice',tenantId:'tenant_lab',scopeId:'scp_lab',phase:'running',input:{flowId:'synthetic-execute',methodPin:{assetId:index?healthyMethod:badMethod,version:'1.0.0',sha256:sha},resources:{},sources:{},value:{},controlledBytes:[]}}])),runs=new Map<string,any>(),failed=new Map<string,number>(),advanced=new Map<string,number>();
 const snapshot=()=>structuredClone({tasks,runs,failed,advanced}),restore=(value:any)=>{tasks=value.tasks;runs=value.runs;failed=value.failed;advanced=value.advanced;};
 const services:any={store:{pool:{query:async()=>({rows:[...tasks.values()].filter(task=>task.phase==='running').map(task=>({task_id:task.taskId}))})}},tasks:{internal:async(_tx:any,id:string)=>({...tasks.get(id)}),fail:async(_tx:any,task:any)=>{tasks.get(task.taskId)!.phase='failed';failed.set(task.taskId,(failed.get(task.taskId)??0)+1);}},auth:{check:async()=>({})},methods:{resolve:async()=>({})},productModules:{load:async(_ctx:any,id:string)=>({binding:{digest:sha},flows:[{schema:'circle-packs/flow/1',id:'synthetic-execute',version:'synthetic-execute/1',driver:'hub-execution-transition/1',transition:{path:'tools/transition.ts',export:'transition'},initialState:id===badMethod?{text:'synthetic\u0000state'}:{stage:'prepare'}}]})}};
 services.store.transaction=async(callback:(tx:any)=>Promise<any>)=>{
  const original=snapshot(),savepoints=new Map<string,any>();let aborted=false;
  const tx={query:async(sql:string,args:any[]=[])=>{
   if(sql.startsWith('ROLLBACK TO SAVEPOINT ')){const name=sql.slice('ROLLBACK TO SAVEPOINT '.length);assert.ok(savepoints.has(name));restore(structuredClone(savepoints.get(name)));aborted=false;return {rows:[],rowCount:0};}
   if(aborted)throw Object.assign(new Error('current transaction is aborted'),{code:'25P02'});
   if(sql.startsWith('SAVEPOINT ')){savepoints.set(sql.slice('SAVEPOINT '.length),snapshot());return {rows:[],rowCount:0};}
   if(sql.startsWith('RELEASE SAVEPOINT ')){savepoints.delete(sql.slice('RELEASE SAVEPOINT '.length));return {rows:[],rowCount:0};}
   if(sql.includes('SELECT cancel_requested'))return {rows:[{cancel_requested:false}],rowCount:1};
   if(sql.startsWith('SELECT * FROM flow_runs'))return {rows:runs.has(args[0])?[runs.get(args[0])]:[],rowCount:runs.has(args[0])?1:0};
   if(sql.startsWith('SELECT input FROM input_revisions'))return {rows:[{input:tasks.get(args[1])!.input}],rowCount:1};
   if(sql.startsWith('INSERT INTO flow_runs')){const state=JSON.parse(args[4]);if(JSON.stringify(state).includes('\\u0000')){aborted=true;throw Object.assign(new Error('unsupported Unicode escape sequence'),{code:'22P05'});}runs.set(args[0],{binding:JSON.parse(args[2]),definition:JSON.parse(args[3]),state,status:'active',generation:0});return {rows:[],rowCount:1};}
   if(sql.startsWith('SELECT count(*)'))return {rows:[{n:advanced.get(args[0])??0}],rowCount:1};
   if(sql.startsWith('SELECT 1 FROM flow_steps'))return {rows:[],rowCount:0};
   if(sql.startsWith('UPDATE flow_runs SET status=')){if(runs.has(args[0]))runs.get(args[0]).status='failed';return {rows:[],rowCount:runs.has(args[0])?1:0};}
   if(sql.startsWith('SELECT evidence_ref,observation'))return {rows:[],rowCount:0};
   if(sql==='SELECT a.* FROM artifact_bindings b JOIN artifacts a USING(artifact_id) WHERE b.task_id=$1 AND b.input_revision_id=$2')return {rows:[],rowCount:0};
   if(sql==='SELECT * FROM evidence WHERE task_id=$1 AND input_revision_id=$2')return {rows:[],rowCount:0};
   if(sql.startsWith('UPDATE tasks SET result=')){JSON.parse(args[1]);return {rows:[],rowCount:1};}
   throw new Error('Unexpected synthetic SQL: '+sql);
  }};
  try{return await callback(tx);}catch(error){restore(original);throw error;}
 };
 const flow=Object.create(ExecutionFlows.prototype) as ExecutionFlows;flow.services=services;flow.profiles={};flow.expireOwn=async()=>{};flow.enqueue=async(_tx:any,task:any)=>{advanced.set(task.taskId,(advanced.get(task.taskId)??0)+1);return {};};
 return {flow,badId,healthyId,task:(id:string)=>tasks.get(id),failed:(id:string)=>failed.get(id)??0,advanced:(id:string)=>advanced.get(id)??0};
}

test('M4 a PostgreSQL JSONB fault fails its flow once while a later healthy flow still advances',async()=>{
 const fixture=storageFaultScenario();await assert.doesNotReject(()=>fixture.flow.runOnce());assert.equal(fixture.task(fixture.badId)!.phase,'failed');assert.equal(fixture.failed(fixture.badId),1);assert.equal(fixture.advanced(fixture.healthyId),1);await fixture.flow.runOnce();assert.equal(fixture.failed(fixture.badId),1,'The rejected task must leave the next tick candidate set');assert.equal(fixture.advanced(fixture.healthyId),2);
});

test('M4 independent runners still run after task or flow faults and diagnostics expose only runner identities',async()=>{
 const fixture=storageFaultScenario(),advanced:string[]=[],failures:string[]=[];
 await runRunnerCycle([{name:'tasks',run:async()=>{throw new Error('Synthetic task failure');}},{name:'execution-flows',run:()=>fixture.flow.runOnce()},...['capability-packs','automations','change-sets','execution-secrets'].map(name=>({name,run:async()=>{advanced.push(name);}}))],name=>{failures.push(name);});
 assert.deepEqual(failures,['tasks']);assert.equal(fixture.failed(fixture.badId),1);assert.equal(fixture.advanced(fixture.healthyId),1);assert.deepEqual(advanced,['capability-packs','automations','change-sets','execution-secrets']);
 advanced.length=0;await runRunnerCycle([{name:'execution-flows',run:async()=>{throw new Error('Synthetic flow transaction failure');}},...['capability-packs','automations','change-sets','execution-secrets'].map(name=>({name,run:async()=>{advanced.push(name);}}))],()=>{throw new Error('Synthetic logger unavailable');});assert.deepEqual(advanced,['capability-packs','automations','change-sets','execution-secrets']);
});

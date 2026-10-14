import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Execution} from '../../packages/execution/src/index.ts';
import {Operations} from '../../packages/execution/src/operations.ts';
import {ExecutionFlows} from '../../packages/execution/src/flow-driver.ts';

const ctx:any={principalId:'prn_worker',tenantId:'tnt_lab',kind:'worker',workerId:'worker'};
const row={operation_id:'op_synthetic',name:'flow.invoke',task_id:'task_synthetic',input_revision_id:'inrev_synthetic',tenant_id:'tnt_lab',scope_id:'scp_lab',worker_id:'worker',fencing_token:1,target:'synthetic'};
function fixture(Type:typeof Execution|typeof Operations,name='flow.invoke'){
 const order:string[]=[],candidate={...row,name},tx:any={query:async()=>({rows:[candidate]})},store:any={pool:{query:async()=>({rows:[candidate]})},transaction:async(fn:any)=>fn(tx)},auth:any={check:async()=>({...ctx,scopes:['scp_lab'],targets:['synthetic']}),policy:async()=>({...ctx,scopes:['scp_lab'],targets:['synthetic']})},tasks:any={internal:async()=>{order.push('task');return {taskId:candidate.task_id};}},execution:any=new Type(store,auth,tasks,{} as any);
 execution.lease=async()=>{order.push('operation');return candidate;};execution.workerCapability=async()=>{};
 execution.customPreflights.set('flow.invoke',async()=>{order.push('handler');return {row:candidate};});
 execution.customPreflightLocks?.set('flow.invoke',async()=>{order.push('task');order.push('run');});
 execution.authorize=async()=>({task:{},authorization:{}});return {execution,store,order,tx};
}

test('Flow locking: both execution wrappers obtain the registered task and run locks before their first operation lock',async()=>{
 for(const Type of [Execution,Operations]){const f=fixture(Type);await f.execution.preflight(ctx,row.operation_id,1,f.tx);assert.ok(f.order.indexOf('task')>=0);assert.ok(f.order.indexOf('run')<f.order.indexOf('operation'));assert.equal(f.order.at(-1),'handler');}
});
test('Flow locking: operations without a registered lock callback retain their original authorization path',async()=>{
 for(const Type of [Execution,Operations]){const f=fixture(Type,'native-synthetic');f.execution.customPreflights.set('native-synthetic',async()=>{f.order.push('handler');return {row:{...row,name:'native-synthetic'}};});await f.execution.preflight(ctx,row.operation_id,1,f.tx);assert.equal(f.order[0],'operation');assert.ok(!f.order.includes('run'));}
});
test('Flow locking: expiration in another execution instance shares the store callback and locks the run before operations',async()=>{
 const f=fixture(Execution),other:any=new Execution(f.store,f.execution.auth,f.execution.tasks,{} as any);other.customExpirations.set('flow.invoke',async()=>{f.order.push('expired');return true;});f.tx.query=async(sql:string)=>{if(sql.includes('FOR UPDATE OF o'))f.order.push('operation');return {rows:[row]};};await other.expire();assert.ok(f.order.includes('run'));assert.ok(f.order.indexOf('run')<f.order.indexOf('operation'));assert.equal(f.order.at(-1),'expired');
});

test('Flow locking: claim orders task and run before the selected operation and never holds a worker update lock while waiting',async()=>{
 const sqls:string[]=[],worker={worker_id:'worker',principal_id:'prn_worker',capabilities:['flow.invoke'],draining:false},candidate={...row,status:'accepted',resource_id:'resource',target_identity:'identity',action_digest:'digest',args:{},kind:'tool.call'};
 const tx:any={query:async(sql:string)=>{sqls.push(sql);if(sql.startsWith('SELECT * FROM workers'))return {rows:[worker]};if(sql.startsWith('SELECT o.*'))return {rows:[candidate]};if(sql.startsWith('SELECT * FROM tasks'))return {rows:[{task_id:row.task_id,input_revision_id:row.input_revision_id}]};if(sql.startsWith('SELECT * FROM flow_runs'))return {rows:[{}]};if(sql.startsWith('SELECT * FROM operations'))return {rows:[candidate]};if(sql.startsWith('SELECT * FROM flow_steps'))return {rows:[{kind:'tool.call',action:{}}]};if(sql.startsWith('SELECT * FROM resources'))return {rows:[{frozen:false}]};if(sql.includes('RETURNING next_fencing'))return {rows:[{next_fencing:1}]};return {rows:[],rowCount:0};}};
 const flow:any=Object.create(ExecutionFlows.prototype);flow.services={store:{transaction:async(fn:any)=>fn(tx)},auth:{check:async()=>({...ctx,scopes:['scp_lab']})},tasks:{emit:async()=>{}}};flow.preflight=async()=>({});await flow.claim(ctx);
 const index=(pattern:string)=>sqls.findIndex(sql=>sql.includes(pattern));assert.ok(index('FROM tasks')<index('FROM flow_runs'));assert.ok(index('FROM flow_runs')<index("FROM operations WHERE operation_id"));assert.ok(index("FROM operations WHERE operation_id")<index('UPDATE workers'));assert.equal(sqls.filter(sql=>sql.startsWith('SELECT * FROM workers')).length,2);assert.ok(!sqls.some(sql=>sql.includes('FOR UPDATE OF o')));
});

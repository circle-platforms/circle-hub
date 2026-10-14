import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Execution} from '../../packages/execution/src/index.ts';
import {Operations} from '../../packages/execution/src/operations.ts';
import {ExecutionFlows} from '../../packages/execution/src/flow-driver.ts';
import {lockFlowTaskRun,lockFlowTaskRuns} from '../../packages/execution/src/flow-locks.ts';

const ctx:any={principalId:'prn_worker',tenantId:'tnt_lab',kind:'worker',workerId:'worker'};
const row={operation_id:'op_synthetic',name:'flow.invoke',task_id:'task_synthetic',input_revision_id:'inrev_synthetic',tenant_id:'tnt_lab',scope_id:'scp_lab',worker_id:'worker',fencing_token:1,target:'synthetic'};
function fixture(Type:typeof Execution|typeof Operations,name='flow.invoke'){
 const order:string[]=[],queries:{sql:string;params:any[]}[]=[],candidate={...row,name,resource_id:'provider:ast_synthetic'},task=(id:string)=>({task_id:id,input_revision_id:row.input_revision_id,tenant_id:row.tenant_id,capability_pack_id:'module-execute'}),run=(id:string)=>({task_id:id,input_revision_id:row.input_revision_id,binding:{resources:{gateway:{assetId:'ast_synthetic'}}}});
 const query=async(sql:string,params:any[]=[])=>{queries.push({sql,params});let rows:any[];
  if(sql==='SELECT name FROM operations WHERE operation_id=$1')rows=[{name:candidate.name}];
  else if(sql==='SELECT * FROM operations WHERE operation_id=$1')rows=[candidate];
  else if(sql.startsWith('SELECT * FROM tasks WHERE task_id=ANY(')){assert.match(sql,/ORDER BY task_id FOR UPDATE/);order.push('task');rows=params[0].map(task);}
  else if(sql.startsWith('SELECT * FROM flow_runs WHERE task_id=ANY(')){assert.match(sql,/ORDER BY task_id,input_revision_id FOR UPDATE$/);order.push('run');rows=params[0].map(run);}
  else if(sql.startsWith('SELECT operation_id,tenant_id,resource_id FROM operations')){assert.match(sql,/ORDER BY operation_id FOR UPDATE$/);order.push('operation');rows=[candidate];}
  else if(sql.startsWith('SELECT step_key FROM flow_steps')){assert.match(sql,/ORDER BY step_key FOR UPDATE$/);order.push('step');rows=[{step_key:'step_synthetic'}];}
  else if(sql.startsWith('INSERT INTO resources('))rows=[];
  else if(sql.startsWith('SELECT resource_id FROM resources')){assert.match(sql,/ORDER BY resource_id FOR UPDATE$/);order.push('resource');rows=(params[1] as string[]).map((resource_id:string)=>({resource_id}));}
  else if(sql.startsWith('SELECT operation_id FROM leases')){assert.match(sql,/ORDER BY resource_id,operation_id FOR UPDATE$/);order.push('lease');rows=[];}
  else if(sql.startsWith('SELECT o.operation_id,o.task_id,o.input_revision_id,o.name FROM operations'))rows=[candidate];
  else if(sql.startsWith('SELECT o.* FROM operations o LEFT JOIN leases')){assert.match(sql,/FOR UPDATE OF o/);order.push('operation');rows=[candidate];}
  else assert.fail('Unexpected lock fixture query: '+sql);
  return {rows,rowCount:rows!.length};
 };
 const tx:any={query},store:any={pool:{query},transaction:async(fn:any)=>fn(tx)},auth:any={check:async()=>({...ctx,scopes:['scp_lab'],targets:['synthetic']}),policy:async()=>({...ctx,scopes:['scp_lab'],targets:['synthetic']})},tasks:any={internal:async()=>{order.push('task');return {taskId:candidate.task_id};}},execution:any=new Type(store,auth,tasks,{} as any);
 execution.lease=async()=>{order.push('operation');return candidate;};execution.workerCapability=async()=>{};
 execution.customPreflights.set('flow.invoke',async()=>{order.push('handler');return {row:candidate};});
 execution.customPreflightLocks.set('flow.invoke',async(client:any,locked:any)=>lockFlowTaskRun(client,locked.task_id,locked.input_revision_id));
 execution.authorize=async()=>({task:{},authorization:{}});return {execution,store,order,queries,tx};
}

test('Flow locking: both execution wrappers obtain the registered task and run locks before their first operation lock',async()=>{
 for(const Type of [Execution,Operations]){const f=fixture(Type);await f.execution.preflight(ctx,row.operation_id,1,f.tx);for(const [before,after]of [['task','run'],['run','operation'],['operation','step'],['step','resource'],['resource','lease']])assert.ok(f.order.indexOf(before)<f.order.indexOf(after));assert.equal(f.order.at(-1),'handler');}
 const f=fixture(Execution);await lockFlowTaskRuns(f.tx,['task_z','task_a','task_z']);assert.deepEqual(f.queries.find(query=>query.sql.startsWith('SELECT * FROM tasks'))!.params,[['task_a','task_z']]);assert.deepEqual(f.queries.find(query=>query.sql.startsWith('SELECT resource_id'))!.params,['tnt_lab',['flow:task_a','flow:task_z','provider:ast_synthetic']]);
 const skipped=fixture(Execution),query=skipped.tx.query;skipped.tx.query=async(sql:string,params:any[])=>sql.startsWith('SELECT * FROM tasks')?(skipped.queries.push({sql,params}),{rows:[],rowCount:0}):query(sql,params);assert.equal(await lockFlowTaskRuns(skipped.tx,['task_z','task_a'],true),undefined);assert.match(skipped.queries[0].sql,/FOR UPDATE SKIP LOCKED$/);assert.equal(skipped.queries.length,1);
});
test('Flow locking: operations without a registered lock callback retain their original authorization path',async()=>{
 for(const Type of [Execution,Operations]){const f=fixture(Type,'native-synthetic');f.execution.customPreflights.set('native-synthetic',async()=>{f.order.push('handler');return {row:{...row,name:'native-synthetic'}};});await f.execution.preflight(ctx,row.operation_id,1,f.tx);assert.equal(f.order[0],'operation');assert.ok(!f.order.includes('run'));}
});
test('Flow locking: expiration in another execution instance shares the store callback and locks the run before operations',async()=>{
 const f=fixture(Execution),other:any=new Execution(f.store,f.execution.auth,f.execution.tasks,{} as any);other.customExpirations.set('flow.invoke',async()=>{f.order.push('expired');return true;});await other.expire();assert.ok(f.order.includes('run'));assert.ok(f.order.indexOf('run')<f.order.indexOf('operation'));assert.equal(f.order.at(-1),'expired');
});

test('Flow locking: claim orders task and run before the selected operation and never holds a worker update lock while waiting',async()=>{
 const sqls:string[]=[],worker={worker_id:'worker',principal_id:'prn_worker',capabilities:['flow.invoke'],draining:false},candidate={...row,status:'accepted',resource_id:'resource',target_identity:'identity',action_digest:'digest',args:{},kind:'tool.call'};
 const tx:any={query:async(sql:string,params:any[]=[])=>{sqls.push(sql);let rows:any[]=[];
  if(sql.startsWith('SELECT * FROM workers'))rows=[worker];
  else if(sql.startsWith('SELECT o.* FROM operations o LEFT JOIN operations parent'))rows=[candidate];
  else if(sql.startsWith('SELECT * FROM tasks WHERE task_id=ANY(')){assert.deepEqual(params,[[row.task_id]]);assert.match(sql,/ORDER BY task_id FOR UPDATE SKIP LOCKED$/);rows=[{task_id:row.task_id,input_revision_id:row.input_revision_id,tenant_id:row.tenant_id,capability_pack_id:'module-execute'}];}
  else if(sql.startsWith('SELECT * FROM flow_runs WHERE task_id=ANY(')){assert.deepEqual(params,[[row.task_id]]);assert.match(sql,/ORDER BY task_id,input_revision_id FOR UPDATE$/);rows=[{task_id:row.task_id,input_revision_id:row.input_revision_id,binding:{resources:{gateway:{assetId:'ast_synthetic'}}}}];}
  else if(sql.startsWith('SELECT operation_id,tenant_id,resource_id FROM operations')){assert.deepEqual(params,[[row.task_id]]);assert.match(sql,/ORDER BY operation_id FOR UPDATE$/);rows=[candidate];}
  else if(sql.startsWith('SELECT step_key FROM flow_steps')){assert.deepEqual(params,[[row.operation_id]]);assert.match(sql,/ORDER BY step_key FOR UPDATE$/);rows=[{step_key:'step_synthetic'}];}
  else if(sql.startsWith('INSERT INTO resources(')){assert.equal(params[0],row.tenant_id);assert.ok(['flow:'+row.task_id,'provider:ast_synthetic','resource'].includes(params[1]));}
  else if(sql.startsWith('SELECT resource_id FROM resources')){assert.deepEqual(params,[row.tenant_id,['flow:'+row.task_id,'provider:ast_synthetic','resource']]);assert.match(sql,/ORDER BY resource_id FOR UPDATE$/);rows=(params[1] as string[]).map((resource_id:string)=>({resource_id}));}
  else if(sql.startsWith('SELECT operation_id FROM leases')){assert.deepEqual(params,[row.tenant_id,['flow:'+row.task_id,'provider:ast_synthetic','resource']]);assert.match(sql,/ORDER BY resource_id,operation_id FOR UPDATE$/);}
  else if(sql.startsWith('SELECT * FROM operations WHERE operation_id'))rows=[candidate];
  else if(sql.startsWith('SELECT * FROM flow_steps WHERE operation_id'))rows=[{kind:'tool.call',action:{}}];
  else if(sql.startsWith('SELECT * FROM resources WHERE tenant_id'))rows=[{frozen:false}];
  else if(sql.includes('RETURNING next_fencing'))rows=[{next_fencing:1}];
  else if(sql.startsWith('SELECT 1 FROM leases WHERE tenant_id'))assert.match(sql,/expires_at>clock_timestamp/);
  else if(!['INSERT INTO leases(','UPDATE operations SET','UPDATE flow_steps SET','UPDATE workers SET'].some(prefix=>sql.startsWith(prefix)))assert.fail('Unexpected claim fixture query: '+sql);
  return {rows,rowCount:rows.length};
 }};
 const flow:any=Object.create(ExecutionFlows.prototype);flow.services={store:{transaction:async(fn:any)=>fn(tx)},auth:{check:async()=>({...ctx,scopes:['scp_lab']})},tasks:{emit:async()=>{}}};flow.preflight=async()=>({});await flow.claim(ctx);
 const index=(pattern:string)=>sqls.findIndex(sql=>sql.includes(pattern));assert.ok(index('FROM tasks')<index('FROM flow_runs'));assert.ok(index('FROM flow_runs')<index('SELECT operation_id,tenant_id,resource_id FROM operations'));assert.ok(index('SELECT operation_id,tenant_id,resource_id FROM operations')<index('SELECT step_key FROM flow_steps'));assert.ok(index('SELECT step_key FROM flow_steps')<index('SELECT resource_id FROM resources'));assert.ok(index('SELECT resource_id FROM resources')<index('SELECT operation_id FROM leases'));assert.ok(index('SELECT operation_id FROM leases')<index("FROM operations WHERE operation_id"));assert.ok(index("FROM operations WHERE operation_id")<index('UPDATE workers'));assert.equal(sqls.filter(sql=>sql.startsWith('SELECT * FROM workers')).length,2);assert.ok(!sqls.some(sql=>sql.includes('FOR UPDATE OF o')));
});

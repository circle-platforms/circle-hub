import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Execution} from '../../packages/execution/src/index.ts';
import {ExecutionFlows} from '../../packages/execution/src/flow-driver.ts';
import {ApiError,WorkerRegistration} from '../../packages/contracts/src/index.ts';

const policy={kind:'worker',workerId:'synthetic-worker',principalId:'prn_worker',tenantId:'tnt_synthetic',scopes:['scp_synthetic']},ctx={principalId:'prn_worker',tenantId:'tnt_synthetic',kind:'worker' as const};

test('M6 registration rejects unknown duplicate or undeclared fields while preserving the legacy empty body',()=>{
 assert.deepEqual(WorkerRegistration.parse({}),{capabilities:[]});assert.equal(WorkerRegistration.safeParse({capabilities:['not.installed.operation']}).success,false);assert.equal(WorkerRegistration.safeParse({capabilities:['flow.invoke','flow.invoke']}).success,false);assert.equal(WorkerRegistration.safeParse({capabilities:['flow.invoke'],implementationVersion:'claimed-version'}).success,false);
});

test('M6 registration stores an explicit operation capability and legacy re-registration replaces it with none',async()=>{
 let capabilityWire:unknown;const store:any={pool:{query:async(_sql:string,args:any[])=>{capabilityWire=args[3];return {rows:[{capabilities:JSON.parse(String(args[3]??'[]'))}],rowCount:1};}}},auth:any={check:async()=>policy},execution=new Execution(store,auth,{} as any,{} as any);
 const granted=await (execution.register as any)(ctx,{capabilities:['flow.invoke']});assert.equal(capabilityWire,JSON.stringify(['flow.invoke']));assert.deepEqual(granted.capabilities,['flow.invoke']);const legacy=await (execution.register as any)(ctx,{});assert.equal(capabilityWire,'[]');assert.deepEqual(legacy.capabilities,[]);
});

test('M6 a registered legacy worker never even selects generic flow operations',async()=>{
 let selected=false;const flow=Object.create(ExecutionFlows.prototype) as ExecutionFlows;flow.services={auth:{check:async()=>policy},store:{transaction:async(callback:any)=>callback({query:async(sql:string)=>{if(sql.startsWith('UPDATE workers'))return {rows:[{worker_id:policy.workerId,capabilities:[],draining:false}]};selected=true;return {rows:[]};}})}};assert.equal(await flow.claim(ctx),null);assert.equal(selected,false,'The worker must be filtered before any flow row or lease can be assigned');
});

test('M6 preflight requires both its persisted capability grant and the live worker declaration',async()=>{
 let capabilities=['flow.invoke'],authorized=0;const row={operation_id:'op_synthetic',name:'flow.invoke',required_worker_capability:'flow.invoke',worker_id:policy.workerId,tenant_id:policy.tenantId},tx:any={query:async()=>({rows:[{capabilities}]})},store:any={transaction:async(callback:any)=>callback(tx)},execution=new Execution(store,{check:async()=>policy} as any,{} as any,{} as any);(execution as any).requiredWorkerCapabilities=new Set(['flow.invoke']);execution.lease=async()=>row;execution.customPreflights.set('flow.invoke',async()=>{authorized++;return {authorization:{}};});await execution.preflight(ctx,row.operation_id,1);assert.equal(authorized,1);capabilities=[];await assert.rejects(()=>execution.preflight(ctx,row.operation_id,1),error=>error instanceof ApiError&&error.code==='FORBIDDEN_ACTION');assert.equal(authorized,1);capabilities=['flow.invoke'];row.required_worker_capability='';await assert.rejects(()=>execution.preflight(ctx,row.operation_id,1),error=>error instanceof ApiError&&error.code==='FORBIDDEN_ACTION');assert.equal(authorized,1);
});

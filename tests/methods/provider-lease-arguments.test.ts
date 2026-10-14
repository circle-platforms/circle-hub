import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ProviderPolicy} from '../../packages/execution/src/flow-contracts.ts';
import * as provider from '../../packages/execution/src/flow-provider.ts';

const base:any={schema:'hub-provider-observation/1',submitTool:'submit',statusTool:'status',resultTool:'results',reconcileTool:'status',taskIdArgument:'task_id',remoteIdPath:['task_id'],requestHashPath:['request_hash'],inputSha256Path:['input_sha256'],byteHashesPath:['byte_hashes'],statePath:['state'],runningValues:['running'],terminalValues:['done'],receiptSchema:{type:'object'},lease:{acquireTool:'acquire',heartbeatTool:'heartbeat',releaseTool:'release',idPath:['id'],fencePath:['fence'],idArgument:'lease_id',fenceArgument:'token',ttlSecondsPath:['ttl']},refusal:{stagePath:['stage'],preDispatchStages:['validation'],dispatchedPath:['dispatched'],remoteIdPath:['task_id'],codePath:['code'],reasonPath:['reason']}};
const mapped={...base,lease:{...base.lease,argumentsByTool:{submit:{idArgument:'ticket',fenceArgument:'epoch'},status:{},results:{},observe:{idArgument:'ticket',fenceArgument:'epoch'},heartbeat:{idArgument:'lease_id',fenceArgument:'token'},release:{idArgument:'lease_id',fenceArgument:'token'}}}};
const strict={name:'submit',effect:'write',inputSchema:{type:'object',properties:{value:{type:'string',minLength:2},ticket:{type:'string',pattern:'^lease_'},epoch:{type:'integer',minimum:1}},required:['value','ticket','epoch'],additionalProperties:false}};
const api=provider as any;
const invalid=(fn:()=>unknown)=>assert.throws(fn,(error:any)=>error.code==='INVALID_PAYLOAD');

test('Provider lease arguments: an approved per-Tool map is strict and distinct from the legacy global argument names',()=>{
 assert.equal(ProviderPolicy.safeParse(mapped).success,true);
 assert.equal(ProviderPolicy.safeParse({...mapped,lease:{...mapped.lease,argumentsByTool:{submit:{idArgument:'same',fenceArgument:'same'}}}}).success,false);
 assert.equal(ProviderPolicy.safeParse({...mapped,lease:{...mapped.lease,argumentsByTool:{submit:{idArgument:'ticket',endpoint:'unused'}}}}).success,false);
 assert.deepEqual(api.providerLeaseMapping(mapped,'status',true),{});assert.deepEqual(api.providerLeaseMapping(mapped,'unlisted',true),{});
 assert.deepEqual(api.providerLeaseMapping(base,'status',true),{idArgument:'lease_id',fenceArgument:'token'});assert.deepEqual(api.providerLeaseMapping(base,'observe',false),{});
});
test('Provider lease admission: only declared injected constraints are delayed and the actual RPC is still fully validated',()=>{
 const original=structuredClone(strict.inputSchema);api.validateProviderActionSchema(strict,mapped,{value:'ok'});assert.deepEqual(strict.inputSchema,original);
 invalid(()=>api.validateProviderActionSchema(strict,mapped,{value:'x'}));invalid(()=>api.validateProviderActionSchema(strict,mapped,{value:'ok',extra:1}));
 for(const shadow of [{ticket:'from-product'},{epoch:999},{token:999}])invalid(()=>api.validateProviderActionSchema(strict,mapped,{value:'ok',...shadow}));
 const args=api.providerArgumentsWithLease(mapped,'submit',{value:'ok'},{lease_id:'lease_fixture',token:2});assert.deepEqual(args,{value:'ok',ticket:'lease_fixture',epoch:2});provider.validateProviderSchema(strict.inputSchema,args);
 invalid(()=>provider.validateProviderSchema(strict.inputSchema,api.providerArgumentsWithLease(mapped,'submit',{value:'ok'},{lease_id:'wrong',token:2})));
 assert.deepEqual(api.providerArgumentsWithLease(mapped,'status',{task_id:'remote_fixture'},{lease_id:'lease_fixture',token:2}),{task_id:'remote_fixture'});
});
test('Provider lease admission: unsupported top-level cross-field constraints fail closed instead of being erased',()=>{
 for(const combination of [{anyOf:[{required:['ticket']}]},{if:{required:['ticket']},then:{required:['value']}},{dependentRequired:{ticket:['value']}}])assert.throws(()=>api.validateProviderActionSchema({...strict,inputSchema:{...strict.inputSchema,...combination}},mapped,{value:'ok'}),(error:any)=>error.code==='SOURCE_NOT_APPROVED');
});
test('Provider lease policy: injection maps cannot name undeclared Tools or shadow another protocol authority',()=>{
 const tools=Object.entries(mapped.lease.argumentsByTool).map(([name,map]:any)=>({name,inputSchema:{type:'object',properties:Object.fromEntries(Object.values(map).map((field:any)=>[field,{type:'string'}]))}}));tools.push({name:'acquire',inputSchema:{type:'object',properties:{}}});api.validateProviderLeasePolicy(mapped,tools);
 const reject=(value:any)=>assert.throws(()=>api.validateProviderLeasePolicy(value,tools),(error:any)=>error.code==='SOURCE_NOT_APPROVED');
 reject({...mapped,lease:{...mapped.lease,argumentsByTool:{not_declared:{}}}});reject({...mapped,lease:{...mapped.lease,argumentsByTool:{acquire:{idArgument:'id'}}}});
 reject({...mapped,lease:{...mapped.lease,argumentsByTool:{submit:{idArgument:'unknown_field'}}}});reject({...mapped,toolArguments:{submit:{ticket:{literal:'shadow'}}}});reject({...mapped,byteArguments:{submit:{ticket:'payload'}}});
 const status=tools.find(tool=>tool.name==='status')!;status.inputSchema.properties={task_id:{type:'string'}};reject({...mapped,lease:{...mapped.lease,argumentsByTool:{status:{idArgument:'task_id'}}}});
});

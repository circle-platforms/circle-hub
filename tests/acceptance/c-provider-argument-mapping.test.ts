import assert from 'node:assert/strict';
import {sandboxTest} from './harness.ts';
import {meridianFlow,assetPin} from '../fixtures/meridian-flow.ts';

sandboxTest('C provider mappings: an approved module literal reaches submit while observation calls carry only their declared task parameters',async t=>{
 const f=await meridianFlow(t),{h,provider}=f,original=f.resource,configuration={...original.configuration,receiptPolicy:{...original.configuration.receiptPolicy,toolArguments:{meridian_submit:{module:{literal:'synthetic-suite'}}},lease:{...original.configuration.receiptPolicy.lease,argumentsByTool:{meridian_submit:{idArgument:'lease_id',fenceArgument:'token'},lease_heartbeat:{idArgument:'lease_id',fenceArgument:'token'},lease_release:{idArgument:'lease_id',fenceArgument:'token'},meridian_status:{},meridian_results:{}}}}};
 const declaration={...original.declaration,provides:{tools:original.declaration.provides.tools.map((tool:any)=>tool.name==='meridian_submit'?{...tool,inputSchema:{...tool.inputSchema,properties:{...tool.inputSchema.properties,module:{type:'string'}},required:[...tool.inputSchema.required,'module']}}:tool)}};
 provider.state.allowModule=true;
 const resource=await h.request('/v1/assets',{assetId:original.assetId,scopeId:'scp_lab',kind:'connector-instance',name:original.name,version:'3.0.0',configuration,declaration,readers:['prn_alice','prn_bob']});await h.request(`/v1/assets/${resource.assetId}/lifecycle`,{version:resource.version,sha256:resource.sha256,state:'approved'},'bob');await h.request(`/v1/assets/${resource.assetId}/lifecycle`,{version:resource.version,sha256:resource.sha256,state:'running'});
 const input=f.input();input.resources.gateway=assetPin(resource);await h.startWorker();const task=await h.request('/v1/tasks/submit',{scopeId:'scp_lab',capabilityPackId:'module-execute',idempotencyKey:'c-mapped-module',input});await h.phase(task.taskId,'delivered',30_000);
 const submitted=provider.state.calls.find((call:any)=>call.name==='meridian_submit');assert.equal(submitted?.args.module,'synthetic-suite');assert.equal(provider.state.submissions,1);
 for(const call of provider.state.calls.filter((call:any)=>['meridian_status','meridian_results'].includes(call.name)))assert.deepEqual(Object.keys(call.args),['task_id']);
 assert.ok(provider.state.releases>=1);assert.equal((await h.request(`/v1/tasks/${task.taskId}/result`)).status,'succeeded');
});

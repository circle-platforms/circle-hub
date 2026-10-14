import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {writeFile} from 'node:fs/promises';
import {sandboxTest,until} from './harness.ts';
import {meridianFlow,assetPin} from '../fixtures/meridian-flow.ts';
import {providerTools} from '../fixtures/execution-provider.ts';
import {validateProviderSchema} from '../../packages/execution/src/flow-provider.ts';

async function mappedFlow(t:any,releaseRole='member'){
 const f=await meridianFlow(t),calls:{name:string;args:any}[]=[],tools=providerTools().map(tool=>{
  if(tool.name==='meridian_prepare')return {...tool,inputSchema:{type:'object',properties:{ticket:{type:'string',pattern:'^lease_'},epoch:{type:'integer',minimum:1}},required:['ticket','epoch'],additionalProperties:false}};
  if(tool.name==='meridian_submit')return {...tool,inputSchema:{...tool.inputSchema,required:['payload_b64','lease_id','token']}};
  if(['meridian_status','meridian_results'].includes(tool.name))return {...tool,inputSchema:{type:'object',properties:{task_id:{type:'string'}},required:['task_id'],additionalProperties:false}};
  return tool.name==='lease_release'?{...tool,minimumRole:releaseRole}:tool;
 });
 const upstream=f.provider.endpoint,proxy=createServer(async(req,res)=>{
  try{const chunks=[];for await(const chunk of req)chunks.push(chunk);const bytes=Buffer.concat(chunks),rpc=JSON.parse(bytes.toString());if(rpc.method==='tools/list'){res.setHeader('content-type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result:{tools}}));return;}
   const name=rpc.params.name,args=rpc.params.arguments,tool=tools.find(tool=>tool.name===name);assert.ok(tool);validateProviderSchema(tool.inputSchema,args);calls.push({name,args});const response=await fetch(upstream,{method:'POST',headers:{authorization:req.headers.authorization!,'content-type':'application/json'},body:bytes});res.writeHead(response.status,{'content-type':'application/json'});res.end(Buffer.from(await response.arrayBuffer()));
  }catch{res.writeHead(400);res.end('{"error":"Synthetic strict argument refusal"}');}
 });await new Promise<void>(resolve=>proxy.listen(0,'127.0.0.1',resolve));t.after(async()=>{proxy.closeAllConnections();await new Promise<void>(resolve=>proxy.close(()=>resolve()));});
 await writeFile(`${f.h.scratch}/execution.json`,JSON.stringify({profiles:{fixture:{endpoint:`http://127.0.0.1:${(proxy.address() as any).port}/mcp`,pollMs:25}}}));await f.h.stop();await f.h.startServer();
 const configuration=structuredClone(f.resource.configuration);configuration.receiptPolicy.lease.argumentsByTool={meridian_prepare:{idArgument:'ticket',fenceArgument:'epoch'},meridian_submit:{idArgument:'lease_id',fenceArgument:'token'},meridian_status:{},meridian_results:{},lease_heartbeat:{idArgument:'lease_id',fenceArgument:'token'},lease_release:{idArgument:'lease_id',fenceArgument:'token'}};
 const resource=await f.h.request('/v1/assets',{assetId:f.resource.assetId,scopeId:'scp_lab',kind:f.resource.kind,name:f.resource.name,version:'3.0.0',configuration,declaration:{...f.resource.declaration,provides:{tools}},readers:['prn_alice','prn_bob']});await f.h.request(`/v1/assets/${resource.assetId}/lifecycle`,{version:resource.version,sha256:resource.sha256,state:'approved'},'bob');await f.h.request(`/v1/assets/${resource.assetId}/lifecycle`,{version:resource.version,sha256:resource.sha256,state:'running'});
 const input=f.input();input.resources.gateway=assetPin(resource);return {...f,calls,tools,input};
}
sandboxTest('Provider lease arguments: required injected submit fields and lease-bound reads run while task-only observers receive no lease',async t=>{
 const f=await mappedFlow(t),{h,calls,provider}=f;await h.startWorker();const task=await h.request('/v1/tasks/submit',{scopeId:'scp_lab',capabilityPackId:'module-execute',idempotencyKey:'lease-mapped-happy',input:f.input});await h.phase(task.taskId,'delivered',30_000);assert.equal((await h.request(`/v1/tasks/${task.taskId}/result`)).status,'succeeded');assert.equal(provider.state.submissions,1);
 const prepare=calls.find(call=>call.name==='meridian_prepare')!;assert.deepEqual(prepare.args,{ticket:'lease_synthetic',epoch:1});assert.equal(calls.filter(call=>call.name==='lease_acquire').length,2);assert.equal(calls.filter(call=>call.name==='lease_release').length,2);
 const submit=calls.find(call=>call.name==='meridian_submit')!;assert.equal(submit.args.lease_id,'lease_synthetic');assert.equal(submit.args.token,1);assert.equal(submit.args.payload_b64,f.payload.toString('base64'));
 for(const name of ['meridian_status','meridian_results'])assert.deepEqual(calls.find(call=>call.name===name)!.args,{task_id:provider.state.remoteId});for(const call of calls){assert.ok(!Object.hasOwn(call.args,'state'));assert.ok(!Object.hasOwn(call.args,'endpoint'));assert.ok(!JSON.stringify(call.args).includes(provider.state.secret));}
 const ops=(await h.db.query('SELECT source_effect,status FROM operations WHERE task_id=$1',[task.taskId])).rows;assert.ok(!ops.some(op=>op.status==='unknown'));assert.ok(!(await h.db.query('SELECT 1 FROM resources WHERE frozen')).rowCount);
});
sandboxTest('Provider lease arguments: a mapped read cannot borrow an acquire heartbeat or release role it lacks',async t=>{
 const f=await mappedFlow(t,'admin'),{h,calls,provider}=f;await h.setRole('prn_bob','member');await h.startWorker();const task=await h.request('/v1/tasks/submit',{scopeId:'scp_lab',capabilityPackId:'module-execute',idempotencyKey:'lease-mapped-role',input:f.input},'bob');await until(async()=>['failed','delivered','unknown'].includes((await h.status(task.taskId)).phase),30_000);const result=await h.request(`/v1/tasks/${task.taskId}/result`);assert.equal(result.status,'failed');assert.equal(result.error.code,'FORBIDDEN_ACTION');assert.equal(calls.length,0);assert.equal(provider.state.submissions,0);assert.ok(!(await h.db.query('SELECT 1 FROM resources WHERE frozen')).rowCount);
});

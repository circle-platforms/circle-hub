import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {executeFlowStep} from '../../packages/execution/src/flow-worker.ts';
import * as provider from '../../packages/execution/src/flow-provider.ts';
import {LocalObjects} from '../../packages/knowledge/src/objects.ts';
import {hydrateReturn} from '../../packages/connectors/src/return-pointers.ts';

const hash=(letter:string)=>letter.repeat(64);
const policy={submitTool:'submit',statusTool:'status',resultTool:'results',reconcileTool:'status',taskIdArgument:'task_id',remoteIdPath:['task_id'],requestHashPath:['request_hash'],inputSha256Path:['input_sha256'],byteHashesPath:['byte_hashes'],statePath:['state'],runningValues:['running'],terminalValues:['done'],receiptSchema:{type:'object',required:['ok','task_id','request_hash','input_sha256','byte_hashes','state'],properties:{ok:{const:true},task_id:{type:'string'},request_hash:{type:'string'},input_sha256:{type:'string'},byte_hashes:{type:'object'},state:{enum:['running','done']}},additionalProperties:true},lease:{acquireTool:'acquire',heartbeatTool:'heartbeat',releaseTool:'release',idPath:['lease_id'],fencePath:['token'],ttlSecondsPath:['expires_in_s'],idArgument:'lease_id',fenceArgument:'token'},refusal:{stagePath:['stage'],preDispatchStages:['validation','lease','environment'],dispatchedPath:['dispatched'],remoteIdPath:['task_id']}};
async function run(t:TestContext,refusedTool:'submit'|'status'){
 const directory=await mkdtemp(join(tmpdir(),'flow-refusal-')),calls:string[]=[],events:any[]=[],tools=['submit','status','results','acquire','heartbeat','release'].map(name=>({name,effect:['status','results'].includes(name)?'read':'write',minimumRole:'member',inputSchema:{type:'object'},annotations:{readOnlyHint:['status','results'].includes(name)}}));
 t.after(()=>rm(directory,{recursive:true,force:true}));
 const server=createServer(async(req,res)=>{const chunks=[];for await(const chunk of req)chunks.push(chunk);const rpc=JSON.parse(Buffer.concat(chunks).toString());let result:any;if(rpc.method==='tools/list')result={tools};else{const name=rpc.params.name;calls.push(name);const meta=rpc.params._meta??{};const value=name===refusedTool?{ok:false,stage:'validation',dispatched:false,reason:'Synthetic refusal'}:name==='acquire'?{ok:true,lease_id:'lease_fixture',token:1,expires_in_s:120}:name==='submit'?{ok:true,task_id:'remote_fixture',request_hash:meta['hub/requestHash'],input_sha256:meta['hub/inputSha256'],byte_hashes:{},state:'running'}:{ok:true};result={structuredContent:value,content:[{type:'text',text:JSON.stringify(value)}]};}res.setHeader('content-type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result}));});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
 const authorization={kind:'provider.call',action:{kind:'provider.call',tool:'submit',resource:'gateway',args:{}},frame:{controlledBytes:[]},provider:{allowAnonymous:true,profile:{endpoint:`http://127.0.0.1:${(server.address() as any).port}/mcp`,pollMs:25},configuration:{receiptPolicy:policy},tools},stepKey:hash('a'),requestHash:hash('b'),binding:{inputSha256:hash('c')}};
 const report:any=await executeFlowStep({operationId:'op_fixture',fencingToken:1,inputRevisionId:'inrev_fixture'},{directory,signal:new AbortController().signal,check:async()=>({authorization}),event:async(event:any)=>{events.push(event);return {bindingAccepted:true};}});
 return {report,calls,events,directory};
}
test('H2 refusal provenance: the bound submit rejection before any remote identity is failed and releases the unused lease',async t=>{
 const result=await run(t,'submit');assert.equal(result.report.status,'failed');assert.equal(result.calls.filter(name=>name==='release').length,1);assert.ok(!result.events.some(event=>event.stage==='submitted'));
});
test('H2 refusal provenance: a status rejection after accepted submission cannot clear the write or release its remote lease',async t=>{
 const result=await run(t,'status');assert.ok(result.events.some(event=>event.stage==='submitted'));assert.equal(result.report.status,'unknown');assert.equal(result.calls.filter(name=>name==='release').length,0);
 const pointer=result.report.output.gatewayRefusalPointer,original=await hydrateReturn(new LocalObjects(result.directory),pointer),envelope=JSON.parse(Buffer.from(original.contentBase64,'base64').toString());assert.equal(envelope.schema,'hub-provider-refusal/1');assert.equal(envelope.tool,'status');assert.equal(envelope.phase,'observe');assert.deepEqual(envelope.refusal,{ok:false,stage:'validation',dispatched:false,reason:'Synthetic refusal'});assert.equal(result.report.error?.details.submitted,true);
});
test('H2 C refusal gate: persisted remote identity and another invocation override worker claims of non-dispatch',()=>{
 const prove=(provider as any).isPreDispatchSubmissionRefusal,refusal={ok:false,stage:'validation',dispatched:false},envelope={schema:'hub-provider-refusal/1',tool:'submit',phase:'submit',refusal};
 assert.equal(prove(policy,envelope,{submitTool:'submit',remoteIdentity:null}),true);
 assert.equal(prove(policy,envelope,{submitTool:'submit',remoteIdentity:{remoteId:'remote_fixture'},submitted:false}),false);
 assert.equal(prove(policy,{...envelope,tool:'status',phase:'observe'},{submitTool:'submit',remoteIdentity:null,submitted:false}),false);
 assert.equal(prove(policy,refusal,{submitTool:'submit',remoteIdentity:null}),false);
 assert.equal(prove(policy,{...envelope,refusal:{...refusal,task_id:null}},{submitTool:'submit',remoteIdentity:null}),false);
});

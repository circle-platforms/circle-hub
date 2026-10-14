import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {TestContext} from 'node:test';
import {createServer} from 'node:http';
import {randomBytes} from 'node:crypto';
import {sha256} from '../../packages/contracts/src/index.ts';
import {FlowDefinition} from '../../packages/execution/src/flow-contracts.ts';
import {validateProviderSchema} from '../../packages/execution/src/flow-provider.ts';
import {APV_MODULE_FLOW,frozenApvModule,apvModuleFlow,apvEnvironment,apvTopology,apvRawResults,apvModuleWorkbook,apvSyntheticBuild} from '../fixtures/apv-module-flow-synthetic-provider-protocol.ts';

// Self-written synthetic protocol data from a read-only schema review of the
// gateway Tool declarations. No Python code, descriptions or configuration is
// copied, imported or executed. All hosts/logs come from documented test data.
function strictTools(){
 const object=(properties:any={},required:string[]=[])=>({type:'object',properties,required,additionalProperties:false}),string={type:'string'},lease={lease_id:string,token:{type:'integer'}};
 return [
  {name:'lease_acquire',effect:'write',inputSchema:object()},
  {name:'lease_heartbeat',effect:'write',inputSchema:object(lease,['lease_id','token'])},
  {name:'lease_release',effect:'write',inputSchema:object(lease,['lease_id','token'])},
  {name:'lease_status',effect:'read',inputSchema:object()},
  {name:'env_prepare',effect:'read',inputSchema:object({...lease,device_build:string},['lease_id','token'])},
  {name:'bed_topology',effect:'read',inputSchema:object({...lease,refresh:{type:'boolean'}},['lease_id','token'])},
  {name:'case_submit',effect:'write',inputSchema:object({...lease,xlsx_b64:string,module:string},['lease_id','token','xlsx_b64'])},
  {name:'case_status',effect:'read',inputSchema:object({task_id:string},['task_id'])},
  {name:'case_results',effect:'read',inputSchema:object({task_id:string},['task_id'])},
  {name:'probe_show',effect:'read',inputSchema:object({...lease,command:string,device_index:{type:'integer',minimum:0}},['lease_id','token','command'])},
  {name:'init_device',effect:'write',inputSchema:object({...lease,step:{type:'string',enum:['prepare','confirm']},device_index:{type:'integer',minimum:0},device_count:{type:'integer',minimum:1},confirmation:string},['lease_id','token','step'])},
 ].map(tool=>({...tool,description:'Synthetic strict cexg protocol Tool',minimumRole:tool.name==='init_device'?'admin':'member',approval:false,annotations:{readOnlyHint:tool.effect==='read',destructiveHint:tool.effect==='write'}}));
}

function strictState(){return {secret:randomBytes(32).toString('hex'),calls:[] as {name:string;args:any;meta:any}[],submissions:0,releases:0,workbook:Buffer.alloc(0),leaseId:'',fence:0,leaseActive:false,taskId:'synthetic_cexg_task_301'};}
function strictReply(state:ReturnType<typeof strictState>,name:string,args:any):Record<string,any>{
 const tool=strictTools().find(tool=>tool.name===name);assert.ok(tool,'The strict fixture has no undeclared Tool');validateProviderSchema(tool.inputSchema,args);
 const publicLease=()=>({lease_id:state.leaseId,token:state.fence,holder:'synthetic',expires_at:Math.floor(Date.now()/1000)+120,expires_in_s:120});
 if(name==='lease_acquire'){state.leaseId='synthetic_cexg_lease';state.fence++;state.leaseActive=true;return {ok:true,...publicLease(),renewed:false};}
 if(name==='lease_status')return {ok:true,leased:state.leaseActive,bed_busy:false,...(state.leaseActive?publicLease():{})};
 if(!['case_status','case_results'].includes(name)){assert.ok(state.leaseActive,'A granted lease must still be active');assert.ok(state.leaseId&&Number.isSafeInteger(state.fence)&&state.fence>0,'The lease must have a non-empty id and positive fence');assert.equal(args.lease_id,state.leaseId);assert.equal(args.token,state.fence);}
 if(name==='lease_heartbeat')return {ok:true,...publicLease()};
 if(name==='lease_release'){state.releases++;state.leaseActive=false;return {ok:true,released:true};}
 if(name==='env_prepare'){if(args.device_build)assert.equal(args.device_build,apvSyntheticBuild,'The requested build differs from the synthetic bed');const {observedBuild:_,...raw}=apvEnvironment;return {...raw,build_checked:typeof args.device_build==='string'&&args.device_build.length>0};}
 if(name==='bed_topology')return apvTopology;
 if(name==='case_submit'){state.submissions++;state.workbook=Buffer.from(args.xlsx_b64,'base64');return {ok:true,task_id:state.taskId,sha256:sha256(state.workbook),bytes:state.workbook.length,case_ids:['301'],deliver_epoch:0,submit_autoid:'301',module:args.module??'synthetic'};}
 assert.ok(state.submissions>0);assert.equal(args.task_id,state.taskId);
 if(name==='case_status')return {ok:true,task_id:state.taskId,state:'done',rc:0,log_tail:''};
 if(name==='case_results')return {ok:true,task_id:state.taskId,...apvRawResults,xlsx_sha256:sha256(state.workbook),submit_autoid:'301',module:'synthetic',run_dir:null,report_dir:null,ignored_rows:0};
 throw new Error('This side-effect-free protocol fixture does not execute probe or lifecycle Tools');
}

async function strictProvider(t:TestContext){
 const state=strictState(),server=createServer(async(req,res)=>{
  if(req.method!=='POST'||req.url!=='/mcp'){res.writeHead(405);res.end();return;}if(req.headers.authorization!==`Bearer ${state.secret}`){res.writeHead(401);res.end();return;}
  const chunks=[];for await(const chunk of req)chunks.push(chunk);let rpc:any;try{rpc=JSON.parse(Buffer.concat(chunks).toString());}catch{res.writeHead(400);res.end();return;}
  let result:any;if(rpc.method==='tools/list')result={tools:strictTools()};else if(rpc.method==='tools/call'){
   const name=rpc.params?.name,args=rpc.params?.arguments??{},meta=rpc.params?._meta??{};state.calls.push({name,args,meta});let raw:any;try{raw=strictReply(state,name,args);}catch{raw={ok:false,error:'Synthetic strict gateway rejected the request'};}result={isError:raw.ok===false,structuredContent:raw,content:[{type:'text',text:JSON.stringify(raw)}]};
  }else{res.writeHead(400);res.end();return;}
  res.setHeader('content-type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result}));
 });await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});return {state,endpoint:`http://127.0.0.1:${(server.address() as any).port}/mcp`};
}

test('C cexg strict fixture: required and unknown fields, granted leases and unextended legacy receipts remain distinct',async()=>{
 const state=strictState(),bytes=await apvModuleWorkbook();
 for(const name of ['env_prepare','bed_topology','case_submit'])assert.throws(()=>strictReply(state,name,name==='case_submit'?{xlsx_b64:bytes.toString('base64')}:name==='env_prepare'?{device_build:'SYNTHETIC_BUILD_301'}:{refresh:false}));
 for(const name of ['case_status','case_results'])assert.throws(()=>validateProviderSchema(strictTools().find(tool=>tool.name===name)!.inputSchema,{task_id:state.taskId,lease_id:'synthetic_cexg_lease',token:1}));
 assert.throws(()=>validateProviderSchema(strictTools().find(tool=>tool.name==='lease_acquire')!.inputSchema,{unexpected:true}));
 assert.throws(()=>strictReply(state,'env_prepare',{lease_id:'',token:0}));
 const lease=strictReply(state,'lease_acquire',{}),args={lease_id:lease.lease_id,token:lease.token};assert.ok(lease.lease_id);assert.ok(Number.isSafeInteger(lease.token)&&lease.token>0);assert.equal(lease.expires_in_s,120);const unbound=strictReply(state,'env_prepare',args);assert.equal(unbound.ready,true);assert.equal(unbound.build_checked,false);assert.ok(!Object.hasOwn(unbound,'observedBuild'));assert.equal(strictReply(state,'env_prepare',{...args,device_build:'SYNTHETIC_BUILD_301'}).build_checked,true);
 assert.equal(lease.holder,'synthetic');assert.ok(lease.expires_at>Math.floor(Date.now()/1000));assert.equal(strictReply(state,'lease_status',{}).leased,true);assert.throws(()=>strictReply(state,'env_prepare',{...args,device_build:'DIFFERENT_SYNTHETIC_BUILD'}));
 assert.throws(()=>strictReply(state,'env_prepare',{lease_id:'',token:0}));assert.throws(()=>strictReply(state,'case_submit',args));
 const submitted=strictReply(state,'case_submit',{...args,xlsx_b64:bytes.toString('base64')}),status=strictReply(state,'case_status',{task_id:state.taskId}),results=strictReply(state,'case_results',{task_id:state.taskId});assert.equal(submitted.sha256,sha256(bytes));assert.deepEqual(submitted.case_ids,['301']);assert.equal(status.state,'done');assert.equal(results.channel,'ready');assert.equal(results.xlsx_sha256,sha256(bytes));
 for(const raw of [submitted,status,results])for(const key of ['request_hash','input_sha256','byte_hashes'])assert.ok(!Object.hasOwn(raw,key),key);assert.ok(!Object.hasOwn(submitted,'state'));assert.ok(!Object.hasOwn(results,'state'));assert.equal(state.submissions,1);assert.deepEqual(state.workbook,bytes);assert.equal(strictReply(state,'lease_release',args).released,true);assert.throws(()=>strictReply(state,'bed_topology',args));
});

const enabled=process.env.CIRCLE_HUB_CEXG_PROTOCOL_ACCEPTANCE==='1';
test('C cexg strict protocol: the approved unchanged external APV flow must complete against lease-required Tools and legacy raw receipts',{skip:enabled?false:'Set CIRCLE_HUB_CEXG_PROTOCOL_ACCEPTANCE=1 with CIRCLE_PACKS_CATALOG and CIRCLE_PACKS_REF to run strict cexg protocol acceptance'},async t=>{
 const frozen=await frozenApvModule();t.diagnostic(`Frozen external APV ${frozen.module.version}, ${frozen.commit}, ${frozen.module.digest}`);assert.equal(frozen.module.version,'1.3.0');
 const file=frozen.files.find(file=>file.path==='flows/apv-case-execute-v2.json');assert.ok(file,'Package ABI: declare the v2 descriptor');const descriptor=JSON.parse(Buffer.from(file.base64,'base64').toString());assert.equal(descriptor.id,APV_MODULE_FLOW,'Package ABI: select the new flow id');FlowDefinition.parse(descriptor);
 const {sandboxHost,until}=await import('./harness.ts');if(!sandboxHost.available){t.skip(sandboxHost.reason);return;}
 const provider=await strictProvider(t),f=await apvModuleFlow(t,frozen,{provider,tools:strictTools()}),{h}=f;await h.startWorker();const task=await f.submit();
 const status=await until(async()=>{const row=await h.status(task.taskId);return ['delivered','failed','cancelled','unknown','waiting-input'].includes(row.phase)?row:false;},30_000),result=await h.request(`/v1/tasks/${task.taskId}/result`),steps=(await h.db.query('SELECT step_id,kind,action,status,intent,terminal,evidence_ref,observation FROM flow_steps WHERE task_id=$1 ORDER BY created_at,step_key',[task.taskId])).rows;
 const pendingBatch=[...steps].reverse().find(step=>step.kind==='transition')?.observation?.facts?.result?.actions,proposed=pendingBatch?.find((action:any)=>action.kind==='provider.call'),phase=steps.find(step=>step.status==='failed'||step.status==='unknown')?.step_id??(status.phase==='failed'&&proposed?`C.validateBatch:${proposed.tool}`:'delivery');t.diagnostic(`Strict protocol stage=${phase}, phase=${status.phase}, code=${result.error?.code??'none'}, RPC Tools=${provider.state.calls.map(call=>call.name).join(',')||'none'}, case_submit=${provider.state.submissions}, writeIntent=${steps.filter(step=>step.intent).length}`);
 // A correctly diagnosed refusal is still a red acceptance. Do not relabel
 // blocked execution as completion or add correlation fields to the raw data.
 assert.equal(status.phase,'delivered',`Strict cexg compatibility is incomplete at ${phase}: ${result.error?.code??status.phase}`);assert.equal(result.status,'succeeded');assert.equal(provider.state.submissions,1);assert.deepEqual(provider.state.workbook,f.workbook);assert.ok(provider.state.releases>=1);
 const submitted=steps.find(step=>step.kind==='provider.call'&&step.action.tool==='case_submit');assert.ok(submitted?.intent&&submitted.terminal);assert.equal(submitted.action.byteArgs.xlsx_b64,'workbook');assert.ok(!Object.hasOwn(submitted.action.args,'xlsx_b64'));
 for(const point of ['verify.deviceCommand','verify.hostCommand','verify.workbook'])assert.ok(steps.some(step=>step.kind==='hook.verify'&&step.action.event===point&&step.status==='succeeded'&&step.evidence_ref),point);
 const operations=await h.request(`/v1/tasks/${task.taskId}/operations`);assert.ok(operations.every((operation:any)=>operation.name==='flow.invoke'));assert.equal(result.result.cases[0].autoid,'301');assert.equal(result.result.cases[0].checkPoints.length,2);assert.ok(result.result.cases[0].checkPoints.every((checkpoint:any)=>checkpoint.status==='passed'));assert.deepEqual(result.result.unmapped,[]);
});

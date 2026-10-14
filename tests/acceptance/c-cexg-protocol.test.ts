import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {TestContext} from 'node:test';
import {createServer} from 'node:http';
import {randomBytes} from 'node:crypto';
import {canonicalHash,sha256} from '../../packages/contracts/src/index.ts';
import {FlowDefinition} from '../../packages/execution/src/flow-contracts.ts';
import {validateProviderSchema} from '../../packages/execution/src/flow-provider.ts';
import {verifyStageReceipt} from '../../packages/execution/src/flow-receipts.ts';
import {providerMappedArguments} from '../../packages/execution/src/flow-arguments.ts';
import {APV_MODULE_FLOW,frozenApvModule,assertFrozenApvModuleVersion,apvModuleFlow,apvEnvironment,apvTopology,apvRawResults,apvModuleWorkbook,apvSyntheticBuild} from '../fixtures/apv-module-flow-synthetic-provider-protocol.ts';

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

function strictReceiptPolicy(frozen:Awaited<ReturnType<typeof frozenApvModule>>){
 const object=(properties:any={},required:string[]=[])=>({type:'object',properties,required,additionalProperties:true}),text={type:'string'},id={task_id:text,ok:{const:true}},base={remoteIdPath:['task_id']},leased={idArgument:'lease_id',fenceArgument:'token'};
 const resource=frozen.files.find(file=>file.path==='resources/case-gateway.json'),toolArguments=resource?JSON.parse(Buffer.from(resource.base64,'base64').toString()).configuration?.receiptPolicy?.toolArguments:undefined;
 return {schema:'hub-provider-observation/1',...(toolArguments?{toolArguments}:{}),submitTool:'case_submit',statusTool:'case_status',resultTool:'case_results',reconcileTool:'case_status',taskIdArgument:'task_id',
  prepare:[{tool:'env_prepare'},{tool:'bed_topology',args:{refresh:false}}],
  identityProjection:{stepId:'workbook',path:'tools/workbook.ts',export:Buffer.from(frozen.files.find(file=>file.path==='tools/workbook.ts')!.base64,'base64').toString().includes('export async function projectWorkbook(')?'projectWorkbook':'readExecutionWorkbook',byteArgument:'xlsx_b64',sha256Path:['sha256'],caseIdsPath:['cases'],idPath:['autoid']},
  receipts:{
   submit:{...base,receiptSchema:object({...id,sha256:text,case_ids:{type:'array',items:text}},['ok','task_id','sha256','case_ids']),sha256Path:['sha256'],caseIdsPath:['case_ids']},
   status:{...base,receiptSchema:object({...id,state:{type:'string',enum:['queued','running','done','lost']},rc:{type:['integer','null']}},['ok','task_id','state']),completion:{path:['state'],runningValues:['queued','running'],terminalValues:['done'],rcPath:['rc']}},
   results:{...base,receiptSchema:object({...id,channel:text,rc:{type:'integer'},xlsx_sha256:text},['ok','task_id','channel','rc','xlsx_sha256']),sha256Path:['xlsx_sha256'],completion:{path:['channel'],runningValues:['pending'],terminalValues:['ready'],rcPath:['rc']}},
  },
  lease:{acquireTool:'lease_acquire',heartbeatTool:'lease_heartbeat',releaseTool:'lease_release',idPath:['lease_id'],fencePath:['token'],idArgument:'lease_id',fenceArgument:'token',ttlSecondsPath:['expires_in_s'],argumentsByTool:{env_prepare:leased,bed_topology:leased,case_submit:leased,lease_heartbeat:leased,lease_release:leased,case_status:{},case_results:{}}},
  refusal:{stagePath:['stage'],preDispatchStages:['lease','environment','validation'],dispatchedPath:['dispatched'],remoteIdPath:['task_id'],codePath:['code'],reasonPath:['reason']},
 };
}

function strictProtocolStage(taskPhase:string,error:any,steps:any[],submissions:number){
 if(typeof error?.details?.stage==='string')return error.details.stage;
 const failed=steps.find(step=>step.status==='failed'||step.status==='unknown');if(failed)return failed.step_id;
 const actions=[...steps].reverse().find(step=>step.kind==='transition')?.observation?.facts?.result?.actions,proposed=actions?.find((action:any)=>action.kind==='provider.call');
 return taskPhase==='failed'&&proposed?`C.validateBatch:${proposed.tool}`:taskPhase==='failed'&&submissions===0?'before-submit':'delivery';
}

type StatusSample={state:'queued'|'running'|'done'|'lost';rc?:number|null};
function strictState(statusSamples:StatusSample[]=[{state:'queued',rc:null},{state:'running',rc:null},{state:'done',rc:0}]){return {statusSamples,statusReads:0,secret:randomBytes(32).toString('hex'),calls:[] as {name:string;args:any;meta:any}[],submissions:0,releases:0,workbook:Buffer.alloc(0),leaseId:'',fence:0,leaseActive:false,taskId:'synthetic_cexg_task_301',module:'synthetic'};}
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
 if(name==='case_submit'){state.submissions++;state.workbook=Buffer.from(args.xlsx_b64,'base64');state.module=args.module??'synthetic';return {ok:true,task_id:state.taskId,sha256:sha256(state.workbook),bytes:state.workbook.length,case_ids:['301'],deliver_epoch:0,submit_autoid:'301',module:state.module};}
 assert.ok(state.submissions>0);assert.equal(args.task_id,state.taskId);
 if(name==='case_status'){const observed=state.statusSamples[Math.min(state.statusReads++,state.statusSamples.length-1)];assert.ok(observed);return {ok:true,task_id:state.taskId,...observed,log_tail:''};}
 if(name==='case_results')return {ok:true,task_id:state.taskId,...apvRawResults,xlsx_sha256:sha256(state.workbook),submit_autoid:'301',module:state.module,run_dir:null,report_dir:null,ignored_rows:0};
 throw new Error('This side-effect-free protocol fixture does not execute probe or lifecycle Tools');
}

async function strictProvider(t:TestContext,statusSamples?:StatusSample[]){
 const state=strictState(statusSamples),server=createServer(async(req,res)=>{
  if(req.method!=='POST'||req.url!=='/mcp'){res.writeHead(405);res.end();return;}if(req.headers.authorization!==`Bearer ${state.secret}`){res.writeHead(401);res.end();return;}
  const chunks=[];for await(const chunk of req)chunks.push(chunk);let rpc:any;try{rpc=JSON.parse(Buffer.concat(chunks).toString());}catch{res.writeHead(400);res.end();return;}
  let result:any;if(rpc.method==='tools/list')result={tools:strictTools()};else if(rpc.method==='tools/call'){
   const name=rpc.params?.name,args=rpc.params?.arguments??{},meta=rpc.params?._meta??{};state.calls.push({name,args,meta});let raw:any;try{raw=strictReply(state,name,args);}catch{raw={ok:false,error:'Synthetic strict gateway rejected the request'};}result={isError:raw.ok===false,structuredContent:raw,content:[{type:'text',text:JSON.stringify(raw)}]};
  }else{res.writeHead(400);res.end();return;}
  res.setHeader('content-type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result}));
 });await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});return {state,endpoint:`http://127.0.0.1:${(server.address() as any).port}/mcp`};
}

test('C cexg strict fixture: required and unknown fields, granted leases and unextended legacy receipts remain distinct',async()=>{
 const state=strictState([{state:'done',rc:0}]),bytes=await apvModuleWorkbook();
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
let strictSnapshot:ReturnType<typeof frozenApvModule>|undefined;
function externalStrictModule(){return strictSnapshot??=frozenApvModule();}
test('C cexg strict environment: approved expected-build mapping is required and the observed build stays inside checks detail',()=>{
 const declared={toolArguments:{env_prepare:{device_build:{inputPath:['value','build']}},case_submit:{module:{literal:'synthetic'}}}},frozen={files:[{path:'resources/case-gateway.json',base64:Buffer.from(JSON.stringify({configuration:{receiptPolicy:declared}})).toString('base64')},{path:'tools/workbook.ts',base64:Buffer.from('export async function projectWorkbook() {}').toString('base64')}]} as unknown as Awaited<ReturnType<typeof frozenApvModule>>;
 const policy=strictReceiptPolicy(frozen),input={value:{build:apvSyntheticBuild}},mapped=providerMappedArguments(policy,'env_prepare',{},input);assert.deepEqual(mapped,{device_build:input.value.build});
 const state=strictState(),lease=strictReply(state,'lease_acquire',{}),args={lease_id:lease.lease_id,token:lease.token},unchecked=strictReply(state,'env_prepare',args),checked=strictReply(state,'env_prepare',{...args,...mapped});
 assert.equal(unchecked.build_checked,false);assert.equal(checked.ready,true);assert.equal(checked.build_checked,true);assert.equal(checked.device_count,1);assert.deepEqual(checked.conf.device_ips,['192.0.2.11']);
 const buildCheck=checked.checks.find((item:any)=>item.check==='device_build');assert.equal(buildCheck.ok,true);assert.equal(buildCheck.detail,`device reports ${input.value.build}, gateway bundle is ${input.value.build}`);
 for(const name of ['build','observedBuild','device_build'])assert.ok(!Object.hasOwn(checked,name));
 const oldPolicy={...policy};delete oldPolicy.toolArguments;const missing=providerMappedArguments(oldPolicy,'env_prepare',{},input);assert.deepEqual(missing,{});assert.equal(strictReply(state,'env_prepare',{...args,...missing}).build_checked,false);
});

test('C cexg strict diagnostics: an environment refusal with zero submits cannot be labelled delivery',()=>{
 assert.equal(strictProtocolStage('failed',{code:'BUILD_MISMATCH',details:{stage:'device-map'}},[],0),'device-map');
 assert.equal(strictProtocolStage('failed',{code:'BUILD_MISMATCH'},[],0),'before-submit');assert.equal(strictProtocolStage('delivered',undefined,[],1),'delivery');
});

test('C cexg strict status: the four raw state words do not invent terminal facts or a passed case',()=>{
 const frozen={files:[{path:'resources/case-gateway.json',base64:Buffer.from(JSON.stringify({configuration:{receiptPolicy:{}}})).toString('base64')},{path:'tools/workbook.ts',base64:Buffer.from('export async function projectWorkbook() {}').toString('base64')}]} as unknown as Awaited<ReturnType<typeof frozenApvModule>>,policy=strictReceiptPolicy(frozen),rule=policy.receipts.status,identity={remoteId:'synthetic_cexg_task_301'};
 assert.deepEqual(rule.receiptSchema.properties.state.enum,['queued','running','done','lost']);
 const raw=(state:string,rc:any)=>({ok:true,task_id:identity.remoteId,state,...(rc===undefined?{}:{rc})});
 for(const state of ['queued','running']){const observed=verifyStageReceipt(policy,raw(state,null),identity,{},'status',undefined);assert.equal(observed.terminal,false);assert.equal(observed.state,state);}
 validateProviderSchema(rule.receiptSchema,raw('lost',null));assert.throws(()=>verifyStageReceipt(policy,raw('lost',null),identity,{},'status',undefined),(error:any)=>error.code==='EVIDENCE_INSUFFICIENT');
 for(const rc of [undefined,null])assert.throws(()=>verifyStageReceipt(policy,raw('done',rc),identity,{},'status',undefined),(error:any)=>error.code==='EVIDENCE_INSUFFICIENT');
 for(const rc of [0,2]){const observed=verifyStageReceipt(policy,raw('done',rc),identity,{},'status',undefined);assert.equal(observed.terminal,true);assert.equal(observed.rc,rc);for(const key of ['verdict','passed','cases'])assert.ok(!Object.hasOwn(observed,key));}
 assert.throws(()=>validateProviderSchema(rule.receiptSchema,raw('invented-complete',0)));
});

test('C cexg strict protocol: the approved unchanged external APV flow must complete against lease-required Tools and legacy raw receipts',{skip:enabled?false:'Set CIRCLE_HUB_CEXG_PROTOCOL_ACCEPTANCE=1 with CIRCLE_PACKS_CATALOG and CIRCLE_PACKS_REF to run strict cexg protocol acceptance'},async t=>{
 const frozen=await externalStrictModule();t.diagnostic(`Frozen external APV ${frozen.module.version}, ${frozen.commit}, ${frozen.module.digest}`);assertFrozenApvModuleVersion(frozen);
 const file=frozen.files.find(file=>file.path==='flows/apv-case-execute-v2.json');assert.ok(file,'Package ABI: declare the v2 descriptor');const descriptor=JSON.parse(Buffer.from(file.base64,'base64').toString());assert.equal(descriptor.id,APV_MODULE_FLOW,'Package ABI: select the new flow id');FlowDefinition.parse(descriptor);
 const {sandboxHost,until}=await import('./harness.ts');if(!sandboxHost.available){t.skip(sandboxHost.reason);return;}
 const provider=await strictProvider(t),f=await apvModuleFlow(t,frozen,{provider,tools:strictTools(),receiptPolicy:strictReceiptPolicy(frozen)}),{h}=f;await h.startWorker();const task=await f.submit();
 const status=await until(async()=>{const row=await h.status(task.taskId);return ['delivered','failed','cancelled','unknown','waiting-input'].includes(row.phase)?row:false;},30_000),result=await h.request(`/v1/tasks/${task.taskId}/result`),steps=(await h.db.query('SELECT step_id,kind,action,status,intent,terminal,evidence_ref,observation,prepare_ref,before_dispatch_ref FROM flow_steps WHERE task_id=$1 ORDER BY created_at,step_key',[task.taskId])).rows;
 const phase=strictProtocolStage(status.phase,result.error,steps,provider.state.submissions),requestedBuilds=provider.state.calls.filter(call=>call.name==='env_prepare').map(call=>call.args.device_build??null);t.diagnostic(`Strict protocol stage=${phase}, phase=${status.phase}, code=${result.error?.code??'none'}, expectedBuild=${f.input.value.build}, env_prepare.device_build=${JSON.stringify(requestedBuilds)}, RPC Tools=${provider.state.calls.map(call=>call.name).join(',')||'none'}, case_submit=${provider.state.submissions}, writeIntent=${steps.filter(step=>step.intent).length}`);
 // A correctly diagnosed refusal is still a red acceptance. Do not relabel
 // blocked execution as completion or add correlation fields to the raw data.
 assert.equal(status.phase,'delivered',`Strict cexg compatibility is incomplete at ${phase}: ${result.error?.code??status.phase}`);assert.equal(result.status,'succeeded');assert.equal(provider.state.submissions,1);assert.deepEqual(provider.state.workbook,f.workbook);assert.ok(provider.state.releases>=1);
 assert.ok(requestedBuilds.length>=2);assert.ok(requestedBuilds.every(build=>build===f.input.value.build));
 const observedStates=provider.state.calls.filter(call=>call.name==='case_status');assert.equal(observedStates.length,3);assert.equal(provider.state.statusReads,3);const submitted=steps.find(step=>step.kind==='provider.call'&&step.action.tool==='case_submit');assert.ok(submitted?.intent&&submitted.terminal);assert.ok(submitted.prepare_ref?.complete);assert.equal(submitted.prepare_ref.records.length,2);assert.equal(submitted.before_dispatch_ref.preparationDigest,submitted.prepare_ref.digest);assert.equal(submitted.action.byteArgs.xlsx_b64,'workbook');assert.ok(!Object.hasOwn(submitted.action.args,'xlsx_b64'));
 const preparedEnvironment=submitted.prepare_ref.records.find((record:any)=>record.tool==='env_prepare');assert.ok(preparedEnvironment);const actualPreparation=provider.state.calls.find(call=>call.name==='env_prepare'&&canonicalHash(call.args)===preparedEnvironment.argsDigest);assert.ok(actualPreparation,'The retained preparation must match the exact RPC argument digest');assert.equal(actualPreparation.args.device_build,f.input.value.build);const preparedContent=await fetch(`${h.url}/v1/artifacts/${preparedEnvironment.reference.artifactId}/content`,{headers:{authorization:`Bearer ${await h.login()}`}});assert.equal(preparedContent.status,200);const preparedBytes=Buffer.from(await preparedContent.arrayBuffer());assert.equal(sha256(preparedBytes),preparedEnvironment.reference.sha256);assert.equal(preparedBytes.length,preparedEnvironment.reference.size);const preparedRaw=JSON.parse(preparedBytes.toString());assert.equal(preparedRaw.build_checked,true);assert.equal(preparedRaw.ready,true);const actualBuild=preparedRaw.checks.find((entry:any)=>entry.check==='device_build');assert.equal(actualBuild.ok,true);assert.equal(actualBuild.detail,`device reports ${f.input.value.build}, gateway bundle is ${f.input.value.build}`);

 for(const point of ['verify.deviceCommand','verify.hostCommand','verify.workbook'])assert.ok(steps.some(step=>step.kind==='hook.verify'&&step.action.event===point&&step.status==='succeeded'&&step.evidence_ref),point);
 const operations=await h.request(`/v1/tasks/${task.taskId}/operations`);assert.ok(operations.every((operation:any)=>operation.name==='flow.invoke'));assert.equal(result.result.cases[0].autoid,'301');assert.equal(result.result.cases[0].checkPoints.length,2);assert.ok(result.result.cases[0].checkPoints.every((checkpoint:any)=>checkpoint.status==='passed'));assert.deepEqual(result.result.unmapped,[]);
});

for(const [label,sample]of [
 ['lost',{state:'lost',rc:null}],
 ['done without an exit fact',{state:'done'}],
 ['done with a null exit fact',{state:'done',rc:null}],
] as const)test(`C cexg strict status: ${label} keeps the submitted write unknown without result polling or releasing the remote lease`,{skip:enabled?false:'Set CIRCLE_HUB_CEXG_PROTOCOL_ACCEPTANCE=1 with CIRCLE_PACKS_CATALOG and CIRCLE_PACKS_REF to run strict cexg status acceptance'},async t=>{
 const frozen=await externalStrictModule();t.diagnostic(`Frozen external APV status ${label}, ${frozen.commit}`);const file=frozen.files.find(file=>file.path==='flows/apv-case-execute-v2.json');assert.ok(file);const descriptor=JSON.parse(Buffer.from(file.base64,'base64').toString());assert.equal(descriptor.id,APV_MODULE_FLOW);FlowDefinition.parse(descriptor);
 const {sandboxHost,until}=await import('./harness.ts');if(!sandboxHost.available){t.skip(sandboxHost.reason);return;}
 const provider=await strictProvider(t,[sample]),f=await apvModuleFlow(t,frozen,{provider,tools:strictTools(),receiptPolicy:strictReceiptPolicy(frozen)}),{h}=f;await h.startWorker();const task=await f.submit();await until(async()=>{const row=await h.status(task.taskId);return ['delivered','failed','cancelled','unknown'].includes(row.phase)?row:false;},30_000);
 const status=await h.status(task.taskId),result=await h.request(`/v1/tasks/${task.taskId}/result`),submitted=(await h.db.query("SELECT s.*,o.status AS operation_status,o.result AS operation_result FROM flow_steps s JOIN operations o USING(operation_id) WHERE s.task_id=$1 AND s.kind='provider.call' AND s.action->>'tool'='case_submit'",[task.taskId])).rows[0];
 assert.equal(status.phase,'unknown');assert.equal(submitted.operation_status,'unknown');assert.equal(submitted.status,'unknown');assert.equal(submitted.intent,true);assert.equal(submitted.terminal,false);assert.equal(submitted.observation.facts.error.code,'EVIDENCE_INSUFFICIENT');assert.equal(provider.state.submissions,1);assert.equal(provider.state.statusReads,1);assert.equal(provider.state.releases,1,'Only the earlier read preparation lease may have been released');assert.equal(provider.state.leaseActive,true);const submitIndex=provider.state.calls.findIndex(call=>call.name==='case_submit');assert.ok(submitIndex>=0);assert.ok(!provider.state.calls.slice(submitIndex+1).some(call=>call.name==='lease_release'),'A failed terminal proof must not release the submitted write lease');assert.equal(provider.state.calls.filter(call=>call.name==='case_results').length,0);assert.ok((await h.db.query("SELECT 1 FROM resources WHERE resource_id=$1 AND frozen",['provider:'+f.resource.assetId])).rowCount);assert.notEqual(result.status,'succeeded');
 const raw=await fetch(`${h.url}/v1/artifacts/${submitted.observation.reference.artifactId}/content`,{headers:{authorization:`Bearer ${await h.login()}`}});assert.equal(raw.status,200);const bytes=Buffer.from(await raw.arrayBuffer());assert.equal(sha256(bytes),submitted.observation.reference.sha256);const observed=JSON.parse(bytes.toString());assert.equal(observed.state,sample.state);assert.equal(observed.task_id,provider.state.taskId);assert.equal(Object.hasOwn(observed,'rc'),Object.hasOwn(sample,'rc'));if(Object.hasOwn(sample,'rc'))assert.equal(observed.rc,(sample as any).rc);
});

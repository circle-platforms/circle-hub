import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {dirname,relative,resolve} from 'node:path';
import {writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import type {TestContext} from 'node:test';
import {zipSync,unzipSync} from 'fflate';
import ExcelJS from 'exceljs';
import {ModuleCatalog,sha256} from '../../packages/contracts/src/index.ts';
import {verifyModule} from '../../packages/modules/src/verify.ts';
import {validateProviderSchema} from '../../packages/execution/src/flow-provider.ts';
import {commandCheck} from '../../packages/methods/src/command-tree.ts';
import type {Harness} from '../acceptance/harness.ts';
import {executionWorkbook} from './execution-workbook.ts';

const git=promisify(execFile);
export const APV_MODULE_FLOW='apv-case-execute-v2';
const assetPin=(asset:any)=>({assetId:asset.assetId,version:asset.assetVersion??asset.version,sha256:asset.assetSha256??asset.sha256,...(asset.digest?{digest:asset.digest}:{})});

// Read only the immutable Git objects selected once at startup. Working-tree
// edits, scripts and tests in the independent repository are never executed.
export async function frozenApvModule(environment:NodeJS.ProcessEnv=process.env){
 const catalog=resolve(environment.CIRCLE_PACKS_CATALOG??'../circle-packs/modules.json');
 const root=(await git('git',['-C',dirname(catalog),'rev-parse','--show-toplevel'])).stdout.trim();
 const catalogPath=relative(root,catalog).replaceAll('\\','/');assert.ok(catalogPath&&!catalogPath.startsWith('../'),'The catalog must be inside its Git repository');
 const requestedRef=environment.CIRCLE_PACKS_REF??environment.CIRCLE_PACKS_COMMIT??'ba06eed';
 const commit=(await git('git',['-C',root,'rev-parse','--verify','--end-of-options',`${requestedRef}^{commit}`])).stdout.trim();assert.match(commit,/^[a-f0-9]{40}$/);
 const show=async(path:string)=>(await git('git',['-C',root,'show',`${commit}:${path}`],{encoding:'buffer',maxBuffer:16*1024*1024})).stdout;
 const parsed=ModuleCatalog.parse(JSON.parse((await show(catalogPath)).toString('utf8'))),module=parsed.modules.find(item=>item.kind==='product-line'&&item.id==='apv');assert.ok(module,'The frozen catalog must contain the APV product-line module');
 const tree=(await git('git',['-C',root,'ls-tree','-rz',commit,'--',module.root],{encoding:'buffer',maxBuffer:16*1024*1024})).stdout.toString('utf8').split('\0').filter(Boolean);
 const paths=tree.flatMap(entry=>{const split=entry.indexOf('\t'),header=entry.slice(0,split),path=entry.slice(split+1).slice(module.root.length+1);if(path.split('/').some(segment=>segment.startsWith('.')))return [];assert.match(header,/^100(?:644|755) blob [a-f0-9]{40}$/,'Frozen modules cannot include symbolic links or submodules');return [path];}).sort();
 assert.deepEqual(paths,module.files.map(file=>file.path),'The catalog must include every non-hidden module file at the resolved commit');
 const files=[];for(const file of module.files){const bytes=await show(`${module.root}/${file.path}`);files.push({path:file.path,base64:bytes.toString('base64'),sha256:file.sha256});}
 return {...verifyModule(module,files),commit,requestedRef,catalogPath};
}

export const apvProjectionDescription='Synthetic projection original: '+'x'.repeat(33*1024);
export async function apvModuleWorkbook(host='routera'){
 const original=await executionWorkbook({command:'service inspect alpha',hostCommand:{host,command:'echo synthetic'}}),document=new ExcelJS.Workbook();await document.xlsx.load(original as any);document.worksheets[0].getCell('D3').value=apvProjectionDescription;const described=Buffer.from(await document.xlsx.writeBuffer());
 // An unrelated synthetic ZIP member makes the valid workbook cross the
 // ordinary 32-KiB string boundary without adding fabricated device steps.
 const filler=Buffer.alloc(48*1024);let seed=17;for(let i=0;i<filler.length;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;filler[i]=seed>>>24;}
 const bytes=Buffer.from(zipSync({...unzipSync(described),'synthetic/padding.bin':filler}));assert.ok(bytes.toString('base64').length>32768);return bytes;
}

export const apvSyntheticBuild='SYNTHETIC_BUILD_301';
export const apvDeviceCommand='service inspect alpha';
export const apvHostCommand='echo synthetic';
export const apvEnvironment={ok:true,ready:true,build_checked:true,observedBuild:apvSyntheticBuild,device_count:1,conf:{device_ips:['192.0.2.11']},checks:[{check:'device_build',ok:true,detail:`device reports ${apvSyntheticBuild}, gateway bundle is ${apvSyntheticBuild}`}]};
export const apvTopology={ok:true,topology:{devices:[{name:'APV0',type:'负载均衡',ipv4:['192.0.2.11/24']},{name:'routera',type:'synthetic-client',ipv4:['192.0.2.12/24']}]}};
export const apvRawResults={channel:'ready',rc:0,cases:[{case_id:'301',result:'PASS',log_stale:false,sessions:[],log:[
 '2026-01-01 00:00:01 192.0.2.11 - sends command in config: service inspect alpha',
 '2026-01-01 00:00:02 routera executes command: echo synthetic',
 '#### Success Num 1: successed to find healthy in:',
 'echo synthetic','healthy','routera#',
 '#### Success Num 2: fail to find panic in:',
 'echo synthetic','healthy','routera#',
].join('\n')}]};

export function apvProviderTools(){
 const object=(properties:any={},required:string[]=[])=>({type:'object',properties,required,additionalProperties:false}),string={type:'string'},lease={lease_id:string,token:{type:'integer'}};
 return [
  {name:'env_prepare',effect:'read',inputSchema:object({device_build:string,...lease})},
  {name:'bed_topology',effect:'read',inputSchema:object({refresh:{type:'boolean'},...lease})},
  {name:'case_submit',effect:'write',inputSchema:object({xlsx_b64:string,module:string,...lease},['xlsx_b64'])},
  // This approved synthetic A3 protocol permits the worker's optional lease
  // fields. The deployed gateway's narrower directory is not being verified.
  ...['case_status','case_results'].map(name=>({name,effect:'read',inputSchema:object({task_id:string,...lease},['task_id'])})),
  {name:'lease_acquire',effect:'write',inputSchema:object()},
  {name:'lease_heartbeat',effect:'write',inputSchema:object(lease,['lease_id','token'])},
  {name:'lease_release',effect:'write',inputSchema:object(lease,['lease_id','token'])},
 ].map(tool=>({...tool,description:'Synthetic APV module provider protocol',minimumRole:'member',approval:false,annotations:{readOnlyHint:tool.effect==='read',destructiveHint:tool.effect==='write'}}));
}

export async function apvModuleProvider(t:TestContext){
 const state={secret:'synthetic-apv-provider-secret-'.repeat(3),calls:[] as {name:string;args:any;meta:any}[],submissions:0,releases:0,workbook:Buffer.alloc(0),taskId:'synthetic_apv_task_301',requestHash:'',inputSha256:'',byteHashes:{} as Record<string,string>};
 // Hub correlation fields are synthetic protocol observations for A3's
 // mechanical proof. They do not assert that an existing gateway emits them.
 const receipt=(results=false)=>({ok:true,task_id:state.taskId,request_hash:state.requestHash,input_sha256:state.inputSha256,byte_hashes:state.byteHashes,state:'done',...(results?apvRawResults:{})});
 const server=createServer(async(req,res)=>{
  if(req.method!=='POST'||req.url!=='/mcp'){res.writeHead(405);res.end();return;}
  if(req.headers.authorization!==`Bearer ${state.secret}`){res.writeHead(401);res.end();return;}
  const chunks=[];for await(const chunk of req)chunks.push(chunk);let rpc:any;try{rpc=JSON.parse(Buffer.concat(chunks).toString());}catch{res.writeHead(400);res.end();return;}
  if(rpc.method==='tools/list'){res.setHeader('content-type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result:{tools:apvProviderTools()}}));return;}
  const name=rpc.params?.name,args=rpc.params?.arguments??{},meta=rpc.params?._meta??{};state.calls.push({name,args,meta});let result:any;
  const definition=apvProviderTools().find(tool=>tool.name===name);if(!definition){res.writeHead(400);res.end();return;}try{validateProviderSchema(definition.inputSchema,args);}catch{const refusal={ok:false,stage:'validation',dispatched:false,code:'INVALID_PAYLOAD',reason:'Synthetic provider arguments do not match the declared gateway protocol'};res.setHeader('content-type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result:{isError:true,structuredContent:refusal,content:[{type:'text',text:JSON.stringify(refusal)}]}}));return;}
  if(name==='lease_acquire')result={ok:true,lease_id:'synthetic_apv_lease',token:1,expires_in_s:120};
  else if(name==='lease_heartbeat')result={ok:true,expires_in_s:120};
  else if(name==='lease_release'){state.releases++;result={ok:true};}
  else if(name==='env_prepare')result=apvEnvironment;
  else if(name==='bed_topology')result=apvTopology;
  else if(name==='case_submit'){assert.equal(args.lease_id,'synthetic_apv_lease');assert.equal(args.token,1);state.submissions++;state.workbook=Buffer.from(args.xlsx_b64??'','base64');state.requestHash=meta['hub/requestHash'];state.inputSha256=meta['hub/inputSha256'];state.byteHashes={xlsx_b64:sha256(state.workbook)};result={...receipt(),state:'running',dispatched:true};}
  else if(name==='case_status')result=receipt();
  else if(name==='case_results')result=receipt(true);
  else{res.writeHead(400);res.end();return;}
  res.setHeader('content-type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result:{structuredContent:result,content:[{type:'text',text:JSON.stringify(result)}]}}));
 });await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
 return {state,endpoint:`http://127.0.0.1:${(server.address() as any).port}/mcp`};
}

export interface ApvFlowProvider {endpoint:string;state:{secret:string;calls:{name:string;args:any;meta:any}[];submissions:number;releases:number;workbook:Buffer}}
export async function apvModuleFlow(t:TestContext,frozen:Awaited<ReturnType<typeof frozenApvModule>>,options:{provider?:ApvFlowProvider;tools?:ReturnType<typeof apvProviderTools>;commandMissing?:boolean;hostOutsideBed?:boolean;contractDisabled?:boolean}={}){
 const {setup}=await import('../acceptance/harness.ts');
 // Node omits undefined environment keys in children. Clear both names so an
 // operator's ambient real profile cannot become this synthetic test's input.
 const cleared:NodeJS.ProcessEnv={};for(const suffix of ['EXECUTION_GATEWAYS','CONNECTOR_PROFILES','OAUTH_PROFILES','PRODUCT_LINES']){cleared[`CIRCLE_HUB_${suffix}`]=undefined;cleared[`CIRCLE_SERVER_${suffix}`]=undefined;}cleared.CIRCLE_RUNTIME_CONFIG=undefined;
 const provider=options.provider??await apvModuleProvider(t),h=await setup(t,cleared as Record<string,string>);h.autoMethodProfiles=false;h.autoHooks=false;
 await writeFile(`${h.scratch}/execution.json`,JSON.stringify({profiles:{apvfixture:{endpoint:provider.endpoint,pollMs:25}}}),{mode:0o600});h.env.CIRCLE_HUB_EXECUTION_GATEWAYS=`${h.scratch}/execution.json`;await h.stop();await h.startServer();
 const receiptPolicy={schema:'hub-provider-observation/1',submitTool:'case_submit',statusTool:'case_status',resultTool:'case_results',reconcileTool:'case_status',taskIdArgument:'task_id',remoteIdPath:['task_id'],requestHashPath:['request_hash'],inputSha256Path:['input_sha256'],byteHashesPath:['byte_hashes'],statePath:['state'],runningValues:['running'],terminalValues:['done'],receiptSchema:{type:'object',required:['ok','task_id','request_hash','input_sha256','byte_hashes','state'],properties:{ok:{const:true},task_id:{type:'string'},request_hash:{type:'string'},input_sha256:{type:'string'},byte_hashes:{type:'object'},state:{enum:['running','done']}},additionalProperties:true},lease:{acquireTool:'lease_acquire',heartbeatTool:'lease_heartbeat',releaseTool:'lease_release',idPath:['lease_id'],fencePath:['token'],idArgument:'lease_id',fenceArgument:'token',ttlSecondsPath:['expires_in_s']},refusal:{stagePath:['stage'],preDispatchStages:['lease','environment','validation'],dispatchedPath:['dispatched'],remoteIdPath:['task_id'],codePath:['code'],reasonPath:['reason']}};
 const configuration={schema:'hub-provider/1',transport:'streamable-http',runtimeProfileType:'execution',runtimeProfileRef:'apvfixture',credentialMode:'static-secret',receiptPolicy},declaration={reads:['synthetic-bed'],writes:['synthetic-device-config'],credentials:[] as string[],allowedTestHosts:['routera'],provides:{tools:options.tools??apvProviderTools()}};
 const draft=await h.request('/v1/assets',{scopeId:'scp_lab',kind:'connector-instance',name:'Synthetic APV module provider',version:'1.0.0',configuration,declaration,readers:['prn_alice','prn_bob']}),credential=await h.request(`/v1/assets/${draft.assetId}/credentials`,{version:'1.0.0',mode:'static-secret',value:provider.state.secret}),resource=await h.request('/v1/assets',{assetId:draft.assetId,scopeId:'scp_lab',kind:'connector-instance',name:draft.name,version:'2.0.0',configuration,declaration:{...declaration,credentials:[credential.assetId]},readers:['prn_alice','prn_bob']});
 await h.request(`/v1/assets/${resource.assetId}/lifecycle`,{version:resource.version,sha256:resource.sha256,state:'approved'},'bob');await h.request(`/v1/assets/${resource.assetId}/lifecycle`,{version:resource.version,sha256:resource.sha256,state:'running'});
 const host=options.hostOutsideBed?'outside-bed':'routera',workbook=await apvModuleWorkbook(host),tree={commands:[{name:options.commandMissing?'service inspect beta':apvDeviceCommand,scope:'configuration',arguments:[]}]},treeBytes=Buffer.from(JSON.stringify(tree)),checked={result:{build:apvSyntheticBuild,buildId:apvSyntheticBuild,sourceSha256:sha256(treeBytes),...commandCheck(tree.commands,[apvDeviceCommand])},evidence:[]},contract={schema:'ist.excel.function-contract',complete:true,objects:[{e:'APV_0',status:'enabled'},{e:'test_env',status:'enabled'}],entries:[{e:'APV_0',f:'cmd_config',status:'enabled'},{e:'test_env',f:host,status:options.contractDisabled?'disabled':'enabled'},{e:'APV_0',f:'reboot',status:'disabled'}]};
 const originals=[{path:'case.xlsx',role:'workbook',bytes:workbook},{path:'command-tree.json',role:'command-tree',bytes:treeBytes},{path:'command-check.json',role:'command-check',bytes:Buffer.from(JSON.stringify(checked))},{path:'excel-contract.json',role:'function-contract',bytes:Buffer.from(JSON.stringify(contract))}],files=[];
 for(const original of originals){const uploaded=await h.request('/v1/sources',{scopeId:'scp_lab',fileName:original.path,contentBase64:original.bytes.toString('base64')});assert.equal(uploaded.sha256,sha256(original.bytes));files.push({path:original.path,role:original.role,sourceRevisionId:uploaded.sourceRevisionId,sha256:uploaded.sha256});}
 const source=await h.request('/v1/source-artifacts',{scopeId:'scp_lab',name:'Synthetic APV execution originals',version:'1.0.0',metadata:{buildName:apvSyntheticBuild,synthetic:true},files,readers:['prn_alice','prn_bob']});await h.request(`/v1/assets/${source.assetId}/lifecycle`,{version:source.version,sha256:source.sha256,state:'approved'},'bob');
 const installed=await h.raw('/v1/modules/install',{token:await h.login(),headers:{'x-scope-id':'scp_lab'},body:{module:frozen.module,files:frozen.files}});assert.equal(installed.status,201,JSON.stringify(installed.body));const method=installed.body.data;assert.equal(method.digest,frozen.module.digest);assert.ok(method.changeSetId);const change=await h.request(`/v1/change-sets/${method.changeSetId}`,undefined,'bob');assert.equal(change.changeSetId,method.changeSetId);await h.request(`/v1/assets/${method.assetId}/lifecycle`,{version:method.assetVersion,sha256:method.assetSha256,state:'approved'},'bob');
 const input={flowId:APV_MODULE_FLOW,methodPin:assetPin(method),resources:{gateway:assetPin(resource)},sources:{originals:assetPin(source)},value:{build:apvSyntheticBuild},controlledBytes:originals.map(original=>({slot:original.role,role:original.role,source:'originals',path:original.path}))};
 return {h,provider,method,resource,source,workbook,input,originals,checked,submit:()=>h.request('/v1/tasks/submit',{scopeId:'scp_lab',capabilityPackId:'module-execute',title:'Synthetic APV module execution',idempotencyKey:'apv-module-flow-301',input})};
}

export async function terminalFlowState(h:Harness,taskId:string){
 const row=await h.status(taskId);if(!['delivered','failed','cancelled','unknown','waiting-input'].includes(row.phase))return false;
 if(row.phase!=='delivered'){const result=await h.request(`/v1/tasks/${taskId}/result`);throw new Error(`APV module stopped at ${row.phase}: ${JSON.stringify(result.error)}`);}return row;
}

// Observe only the public transition frame returned to the trusted worker.
// Injection/profile/auth headers are forwarded but never retained by this test.
export async function observedApvWorker(t:TestContext,h:Harness){
 const frames:{operationId:string;kind:string;frame:any;rows:any[]}[]=[],proxy=createServer(async(req,res)=>{
  try{const parts=[];for await(const chunk of req)parts.push(chunk);const body=Buffer.concat(parts),headers:Record<string,string>={};for(const key of ['authorization','content-type','accept'])if(typeof req.headers[key]==='string')headers[key]=req.headers[key];const response=await fetch(new URL(req.url??'/',h.url),{method:req.method,headers,...(body.length?{body}:{})}),bytes=Buffer.from(await response.arrayBuffer()),route=/^\/v1\/workers\/operations\/([^/]+)\/preflight$/.exec(req.url??'');
   if(route&&response.ok){const authorization=JSON.parse(bytes.toString()).data?.authorization;if(authorization?.frame){const frame=authorization.frame,rows=(await h.db.query("SELECT step_id,occurrence,status FROM flow_steps WHERE task_id=$1 AND input_revision_id=$2 AND kind<>'transition' ORDER BY step_id,occurrence",[frame.binding.taskId,frame.binding.inputRevisionId])).rows;frames.push({operationId:route[1],kind:authorization.kind,frame,rows});}}
   res.writeHead(response.status,Object.fromEntries([...response.headers].filter(([key])=>!['connection','transfer-encoding'].includes(key))));res.end(bytes);
  }catch{res.writeHead(502);res.end('{"error":"Synthetic frame observer failed"}');}
 });await new Promise<void>(resolve=>proxy.listen(0,'127.0.0.1',resolve));t.after(async()=>{proxy.closeAllConnections();await new Promise<void>(resolve=>proxy.close(()=>resolve()));});const worker=await h.startWorker('lab-east-01',{CIRCLE_HUB_URL:`http://127.0.0.1:${(proxy.address() as any).port}`});return {worker,frames};
}

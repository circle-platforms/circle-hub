import assert from 'node:assert/strict';
import {readdir,readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import type {TestContext} from 'node:test';
import {createServer} from 'node:http';
import {setup,type Harness} from '../acceptance/harness.ts';
import {sha256} from '../../packages/contracts/src/index.ts';
import {executionProvider,providerTools} from './execution-provider.ts';

export async function meridianModule(version='1.0.0',id='meridian',flowId='meridian-execute'){
 const root=resolve('packs/meridian'),files:any[]=[];
 async function walk(folder:string,prefix=''){for(const entry of await readdir(folder,{withFileTypes:true})){if(entry.name.startsWith('.'))continue;const path=prefix+entry.name;if(entry.isDirectory())await walk(join(folder,entry.name),path+'/');else files.push({path,base64:(await readFile(join(folder,entry.name))).toString('base64')});}}
 await walk(root);const manifestFile=files.find(file=>file.path==='product-line.json'),manifest=JSON.parse(Buffer.from(manifestFile.base64,'base64').toString());manifest.id=id;manifest.version=version;manifestFile.base64=Buffer.from(JSON.stringify(manifest)).toString('base64');
 const flow=files.find(file=>file.path==='flows/execution.json'),descriptor=JSON.parse(Buffer.from(flow.base64,'base64').toString());descriptor.id=flowId;descriptor.version=flowId+'/1';flow.base64=Buffer.from(JSON.stringify(descriptor)).toString('base64');
 if(id!=='meridian'){
  const transition=files.find(file=>file.path==='tools/transition.ts');transition.base64=Buffer.from(Buffer.from(transition.base64,'base64').toString().replaceAll('meridian_prepare','alternate_prepare').replaceAll('meridian_submit','alternate_submit')).toString('base64');
  const interpreter=files.find(file=>file.path==='tools/interpret.ts');interpreter.base64=Buffer.from("export function interpret(receipt,mode,originalBytes){const original=originalBytes?JSON.parse(new TextDecoder().decode(originalBytes)):receipt,items=original.result?.items;return {kind:'synthetic-counter-series',series:(Array.isArray(items)?items:[]).map(item=>({label:item.id,ticks:1})),unmapped:[...(!Array.isArray(items)?[{reason:'result_unavailable'}]:[]),...(mode==='missing-mapping'?[{reason:'synthetic_missing_mapping'}]:[])]};}").toString('base64');
 }
 for(const file of files)file.sha256=sha256(Buffer.from(file.base64,'base64'));files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
 const module={id,kind:'product-line',root:'products/'+id,manifestPath:'products/'+id+'/product-line.json',version,files:files.map(({path,sha256})=>({path,sha256})),digest:sha256(files.map(file=>`${file.sha256}  ${file.path}\n`).join(''))};return {module,files};
}
export const assetPin=(asset:any)=>({assetId:asset.assetId,version:asset.assetVersion??asset.version,sha256:asset.assetSha256??asset.sha256,...(asset.digest?{digest:asset.digest}:{})});
export async function installMeridian(h:Harness,version='1.0.0',id='meridian',flowId='meridian-execute',approve=true){
 const fixture=await meridianModule(version,id,flowId),result=await h.raw('/v1/modules/install',{token:await h.login(),headers:{'x-scope-id':'scp_lab'},body:fixture});assert.equal(result.status,201,JSON.stringify(result.body));const asset=result.body.data;
 if(approve)await h.request(`/v1/assets/${asset.assetId}/lifecycle`,{version:asset.assetVersion,sha256:asset.assetSha256,state:'approved'},'bob');return asset;
}
export async function meridianFlow(t:TestContext,options:{executionIsChange?:boolean}={}){
 const provider=await executionProvider(t),h=await setup(t);h.autoMethodProfiles=false;
 const profile={endpoint:provider.endpoint,pollMs:25};await writeFile(`${h.scratch}/execution.json`,JSON.stringify({profiles:{fixture:profile}}),{mode:0o600});h.env.CIRCLE_HUB_EXECUTION_GATEWAYS=`${h.scratch}/execution.json`;await h.stop();await h.startServer();
 const receiptPolicy={schema:'hub-provider-observation/1',submitTool:'meridian_submit',statusTool:'meridian_status',resultTool:'meridian_results',reconcileTool:'meridian_status',taskIdArgument:'task_id',remoteIdPath:['task_id'],requestHashPath:['request_hash'],inputSha256Path:['input_sha256'],byteHashesPath:['byte_hashes'],statePath:['state'],runningValues:['running'],terminalValues:['done'],receiptSchema:{type:'object',required:['ok','task_id','request_hash','input_sha256','byte_hashes','state'],properties:{ok:{const:true},task_id:{type:'string'},request_hash:{type:'string'},input_sha256:{type:'string'},byte_hashes:{type:'object'},state:{enum:['running','done']}},additionalProperties:true},lease:{acquireTool:'lease_acquire',heartbeatTool:'lease_heartbeat',releaseTool:'lease_release',idPath:['lease_id'],fencePath:['token'],idArgument:'lease_id',fenceArgument:'token',ttlSecondsPath:['expires_in_s']},refusal:{stagePath:['stage'],preDispatchStages:['lease','validation','environment'],dispatchedPath:['dispatched'],remoteIdPath:['task_id'],codePath:['code'],reasonPath:['reason']}};
 const configuration={schema:'hub-provider/1',transport:'streamable-http',runtimeProfileType:'execution',runtimeProfileRef:'fixture',credentialMode:'static-secret',receiptPolicy},declaration={reads:['synthetic-runtime'],writes:['synthetic-state'],credentials:[] as string[],provides:{tools:providerTools()},...(options.executionIsChange?{executionIsChange:true}:{})};
 const draft=await h.request('/v1/assets',{scopeId:'scp_lab',kind:'connector-instance',name:'Synthetic generic execution resource',version:'1.0.0',configuration,declaration,readers:['prn_alice','prn_bob']});const credential=await h.request(`/v1/assets/${draft.assetId}/credentials`,{version:'1.0.0',mode:'static-secret',value:provider.state.secret});
 const resource=await h.request('/v1/assets',{assetId:draft.assetId,scopeId:'scp_lab',kind:'connector-instance',name:draft.name,version:'2.0.0',configuration,declaration:{...declaration,credentials:[credential.assetId]},readers:['prn_alice','prn_bob']});await h.request(`/v1/assets/${resource.assetId}/lifecycle`,{version:resource.version,sha256:resource.sha256,state:'approved'},'bob');await h.request(`/v1/assets/${resource.assetId}/lifecycle`,{version:resource.version,sha256:resource.sha256,state:'running'});
 const payload=Buffer.alloc(64*1024+13,77),uploaded=await h.request('/v1/sources',{scopeId:'scp_lab',fileName:'request.json',contentBase64:payload.toString('base64')}),source=await h.request('/v1/source-artifacts',{scopeId:'scp_lab',name:'Synthetic execution original',version:'1.0.0',metadata:{synthetic:true},files:[{path:'request.json',role:'request',sourceRevisionId:uploaded.sourceRevisionId,sha256:uploaded.sha256}],readers:['prn_alice','prn_bob']});await h.request(`/v1/assets/${source.assetId}/lifecycle`,{version:source.version,sha256:source.sha256,state:'approved'},'bob');const method=await installMeridian(h);
 const input=(mode='normal',selected=method,flowId='meridian-execute')=>({flowId,methodPin:assetPin(selected),resources:{gateway:assetPin(resource)},sources:{input:assetPin(source)},value:{mode,label:'synthetic'},controlledBytes:[{slot:'request',role:'request',source:'input',path:'request.json'}]});
 const submit=(key:string,mode='normal',selected=method,flowId='meridian-execute')=>h.request('/v1/tasks/submit',{scopeId:'scp_lab',capabilityPackId:'module-execute',title:'Synthetic module execution',idempotencyKey:key,input:input(mode,selected,flowId)});
 return {h,provider,resource,credential,source,method,payload,uploaded,input,submit};
}
// Observe the worker's exact synthetic report JSON, never its auth headers.
// This lets acceptance replay the real receipt rather than manufacture one.
export async function observedFlowWorker(t:TestContext,h:Harness,workerId='lab-east-01'){
 const reports:{operationId:string;body:any}[]=[],proxy=createServer(async(req,res)=>{
  try{const parts=[];for await(const chunk of req)parts.push(chunk);const body=Buffer.concat(parts),route=/^\/v1\/workers\/operations\/([^/]+)\/report$/.exec(req.url??'');if(route&&body.length)reports.push({operationId:route[1],body:JSON.parse(body.toString())});
   const headers:Record<string,string>={};for(const key of ['authorization','content-type','accept'])if(typeof req.headers[key]==='string')headers[key]=req.headers[key];const response=await fetch(new URL(req.url??'/',h.url),{method:req.method,headers,...(body.length?{body}:{})});res.writeHead(response.status,Object.fromEntries([...response.headers].filter(([key])=>!['connection','transfer-encoding'].includes(key))));res.end(Buffer.from(await response.arrayBuffer()));
  }catch{res.writeHead(502);res.end('{"error":"Synthetic report observer transport failed"}');}
 });await new Promise<void>(resolve=>proxy.listen(0,'127.0.0.1',resolve));t.after(async()=>{proxy.closeAllConnections();await new Promise<void>(resolve=>proxy.close(()=>resolve()));});const url=`http://127.0.0.1:${(proxy.address() as any).port}`,worker=await h.startWorker(workerId,{CIRCLE_HUB_URL:url});return {worker,reports};
}

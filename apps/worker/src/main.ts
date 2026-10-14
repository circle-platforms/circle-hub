import '../../../packages/contracts/src/hub-environment.ts';
import { setTimeout as delay } from 'node:timers/promises';
import { ApiError, HEARTBEAT_MS, AnyWorkerClaim, sha256 } from '../../../packages/contracts/src/index.ts';
import {installedWorkerMethods} from '../../../packs/worker.ts';
import {executeTool} from '../../../packages/connectors/src/tool-packages.ts';
import {PrivateVault} from '../../../packages/assets/src/vault.ts';
import {LocalObjects} from '../../../packages/knowledge/src/objects.ts';
import {runCircle} from '../../../packages/runtime/src/circle-rpc.ts';
import {privateRequest} from '../../../packages/runtime/src/private-ipc.ts';
import {join} from 'node:path';
import {SourceCache} from '../../../packages/connectors/src/source-cache.ts';
import {freezeReturns} from '../../../packages/connectors/src/return-pointers.ts';
import {executeFlowStep} from '../../../packages/execution/src/flow-worker.ts';
import {FLOW_OPERATION} from '../../../packages/execution/src/flow-contracts.ts';

function env(name: string): string { const value = process.env[name]; if (!value) throw new Error(`Required environment variable: ${name}`); return value; }
const base = new URL(env('CIRCLE_HUB_URL'));
if (!['http:','https:'].includes(base.protocol) || base.hostname !== '127.0.0.1' || base.username || base.password) throw new Error('Worker requires HTTP or HTTPS on the authorized 127.0.0.1 loopback server without embedded credentials');
const username = env('CIRCLE_WORKER_USERNAME'); const password = env('CIRCLE_WORKER_PASSWORD');
let token = ''; let expires = 0; let stopped = false;let draining=false;
const stopController=new AbortController();
const stop=()=>{stopped=true;stopController.abort();};
process.on('SIGTERM',stop);process.on('SIGINT',stop);process.once('disconnect',stop);
process.on('message',message=>{if((message as any)?.type==='worker-drain'){draining=true;console.log(JSON.stringify({type:'worker-draining',username,processId:process.pid}));}});
async function authenticate(): Promise<void> {
  if (token && Date.now() < expires - 5000) return;
  const response = await fetch(new URL('/v1/auth/dev-login',base), { method: 'POST', redirect:'error', headers: { 'content-type':'application/json' }, body: JSON.stringify({ username,password }) });
  const envelope = await response.json() as any;
  if (!response.ok) throw new ApiError('UNAUTHENTICATED','Worker development login failed');
  token = envelope.data.token; expires = Date.parse(envelope.data.expiresAt);
}
async function request(path: string,body: unknown): Promise<any> {
  await authenticate();
  const response = await fetch(new URL(path,base), { method:'POST',redirect:'error',headers:{ authorization:`Bearer ${token}`,'content-type':'application/json' },body: JSON.stringify(body) });
  const envelope = await response.json() as any;
  if (!response.ok) throw new ApiError(envelope.error.code,envelope.error.message);
  return envelope.data;
}
const methods=installedWorkerMethods(process.env.CIRCLE_SYNTHETIC_RESOURCE_DIR);await methods.initialize();
await request('/v1/workers/register',{capabilities:[FLOW_OPERATION]});
console.log(JSON.stringify({ type:'worker-ready',username }));
let runtimeJob:Promise<void>|undefined;
const professionalJobs=new Map<string,Promise<void>>();
async function executeProfessional(claim:any,initialAuthorization?:any):Promise<void>{
  const fence={fencingToken:claim.fencingToken},abort=new AbortController(),onStop=()=>abort.abort();stopController.signal.addEventListener('abort',onStop,{once:true});
  let pendingHeartbeat:Promise<void>|undefined;const timer=setInterval(()=>{if(pendingHeartbeat)return;pendingHeartbeat=request(`/v1/workers/operations/${claim.operationId}/heartbeat`,fence).then(()=>{}).catch(()=>abort.abort()).finally(()=>{pendingHeartbeat=undefined;});},HEARTBEAT_MS);
  let fullAuthorization:any=initialAuthorization;const checkFlow=async()=>{const checked=await request(`/v1/workers/operations/${claim.operationId}/preflight`,{...fence,...(fullAuthorization?{lightweight:true}:{})});if(!fullAuthorization)fullAuthorization=checked.authorization;return {...checked,authorization:{...fullAuthorization,...checked.authorization}};};let pendingCheck:Promise<void>|undefined;const cancelPoll=claim.name===FLOW_OPERATION?setInterval(()=>{if(pendingCheck)return;pendingCheck=request(`/v1/workers/operations/${claim.operationId}/preflight`,{...fence,lightweight:true}).then(()=>{}).catch(()=>abort.abort()).finally(()=>{pendingCheck=undefined;});},500):undefined;
  try{
    const report=await (claim.name===FLOW_OPERATION?executeFlowStep:methods.execute)(claim,{check:claim.name===FLOW_OPERATION?checkFlow:()=>request(`/v1/workers/operations/${claim.operationId}/preflight`,fence),signal:abort.signal,directory:env('CIRCLE_HUB_DATA_DIR'),event:event=>request(`/v1/workers/operations/${claim.operationId}/events`,{...fence,inputRevisionId:claim.inputRevisionId,event}),source:async()=>{await authenticate();const response=await fetch(new URL(`/v1/workers/operations/${claim.operationId}/source?fence=${claim.fencingToken}`,base),{redirect:'error',headers:{authorization:`Bearer ${token}`}});if(!response.ok)throw new ApiError('EVIDENCE_INSUFFICIENT','Source download failed');return Buffer.from(await response.arrayBuffer());}});
    if(!stopped)await request(`/v1/workers/operations/${claim.operationId}/report`,report);
  }finally{clearInterval(timer);clearInterval(cancelPoll);await pendingHeartbeat;await pendingCheck;stopController.signal.removeEventListener('abort',onStop);}
}
async function executeRuntime(claim:any,preflight:any):Promise<void>{
  const fence={fencingToken:claim.fencingToken},abort=new AbortController();const onStop=()=>abort.abort();stopController.signal.addEventListener('abort',onStop,{once:true});
  let pendingHeartbeat:Promise<void>|undefined;const timer=setInterval(()=>{if(pendingHeartbeat)return;pendingHeartbeat=request(`/v1/workers/operations/${claim.operationId}/heartbeat`,fence).then(()=>{}).catch(()=>abort.abort()).finally(()=>{pendingHeartbeat=undefined;});},HEARTBEAT_MS);
  let pendingCheck:Promise<void>|undefined;const cancelPoll=setInterval(()=>{if(pendingCheck)return;pendingCheck=request(`/v1/workers/operations/${claim.operationId}/preflight`,fence).then(()=>{}).catch(()=>abort.abort()).finally(()=>{pendingCheck=undefined;});},500);
  const authorization=preflight.authorization,channel={authorization:`Bearer ${token}`,operationId:claim.operationId,fencingToken:claim.fencingToken};let report:any;
  try{
    const secret=await privateRequest(authorization.privateSocketPath,channel),objects=new LocalObjects(env('CIRCLE_HUB_DATA_DIR'));
    const files=await Promise.all(authorization.files.map(async(file:any)=>({...file,bytes:await objects.getObject({Bucket:'evidence',Key:file.sha256})})));
    const output=await runCircle({runtime:secret.runtime,approvedModel:secret.approvedModel,folder:join(env('CIRCLE_HUB_DATA_DIR'),'runs',claim.operationId),manifest:authorization.manifest,files,inputs:claim.args.inputs,
      serverUrl:base.origin,serverToken:secret.serverToken,scopeId:authorization.scopeId,principalId:authorization.principalId,signal:abort.signal,
      event:async event=>{await request(`/v1/workers/operations/${claim.operationId}/events`,{...fence,inputRevisionId:claim.inputRevisionId,event});}});
    report={...fence,inputRevisionId:claim.inputRevisionId,status:'succeeded',output};
  }catch(error){const failure=error instanceof ApiError?error:new ApiError('RUNTIME_FAILED','Circle runtime failed');
    if(failure.details.localExitObserved===true){await request(`/v1/workers/operations/${claim.operationId}/local-stopped`,{...fence,inputRevisionId:claim.inputRevisionId,localExitObserved:true});return;}
    report={...fence,inputRevisionId:claim.inputRevisionId,status:'failed',output:{},error:{code:failure.code,message:failure.message}};}
  finally{clearInterval(timer);clearInterval(cancelPoll);await pendingHeartbeat;await pendingCheck;stopController.signal.removeEventListener('abort',onStop);try{await privateRequest(authorization.privateSocketPath,{...channel,revoke:true});}catch{/* A cancelled/expired run token already authorizes no new work. */}}
  if(!stopped)await request(`/v1/workers/operations/${claim.operationId}/report`,report);
}
while (!stopped&&!draining) {
  try {
    const next = await request('/v1/workers/claim',{exclude:[...(runtimeJob?['assets.execute']:[]),...professionalJobs.keys()]});
    if (!next) { await delay(100); continue; }
    const claim = AnyWorkerClaim.parse(next); const fence = { fencingToken:claim.fencingToken };
    const preflight=await request(`/v1/workers/operations/${claim.operationId}/preflight`,fence);
    if(claim.name===FLOW_OPERATION||methods.backgroundNames.has(claim.name)){
      const job=executeProfessional(claim,claim.name===FLOW_OPERATION?preflight.authorization:undefined).catch(error=>{console.error(JSON.stringify({type:'worker-professional-error',code:error instanceof ApiError?error.code:'TRANSPORT_CLOSED'}));}).finally(()=>{professionalJobs.delete(claim.name);});professionalJobs.set(claim.name,job);continue;
    }
    if(claim.name==='assets.execute'){
      // Keep one runtime slot and continue claiming its child tool calls. A single
      // worker must not deadlock while its Circle waits on a read from that worker.
      runtimeJob=executeRuntime(claim,preflight).catch(error=>{console.error(JSON.stringify({type:'worker-runtime-error',code:error instanceof ApiError?error.code:'RUNTIME_FAILED'}));}).finally(()=>{runtimeJob=undefined;});continue;
    }
    let heartbeatError: unknown; let pendingHeartbeat: Promise<void> | undefined;
    const timer = setInterval(() => {
      if (pendingHeartbeat) return;
      pendingHeartbeat = request(`/v1/workers/operations/${claim.operationId}/heartbeat`,fence).then(() => {}).catch(error => { heartbeatError = error; }).finally(() => { pendingHeartbeat = undefined; });
    },HEARTBEAT_MS);
    try {
      if(claim.name==='tools.invoke'&&'args' in claim){
        let report;
        try{
          const authorization=preflight.authorization,credential=authorization.injection?await new PrivateVault(`${env('CIRCLE_HUB_DATA_DIR')}/private-credentials`).get(authorization.injection.key,authorization.injection.binding):undefined;
          await request(`/v1/workers/operations/${claim.operationId}/preflight`,fence);
          const objects=new LocalObjects(env('CIRCLE_HUB_DATA_DIR')),originals=authorization.sourceArtifact?await Promise.all(authorization.sourceArtifact.files.map(async(file:any)=>({path:`/${file.path}`,sha256:file.sha256,bytes:await objects.getObject({Bucket:'evidence',Key:file.sha256}),mediaType:file.mediaType,etag:null,sourceType:'external-artifact'}))):undefined;
          const output=await executeTool(authorization.packageId,authorization.handler,claim.args.input,authorization.profile,credential,{cache:new SourceCache(join(env('CIRCLE_HUB_DATA_DIR'),'connector-cache')),cacheNamespace:authorization.cacheNamespace,sourceArtifact:authorization.sourceArtifact,originals});
          report={...fence,inputRevisionId:claim.inputRevisionId,status:'succeeded',output:{result:output.result,sourceType:output.sourceType,raw:await freezeReturns(objects,output.raw,output.sourceType)}};
        }catch(error){const failure=error instanceof ApiError?error:new ApiError('INTERNAL_ERROR','Registered tool failed');report={...fence,inputRevisionId:claim.inputRevisionId,status:'failed',output:{},error:{code:failure.code,message:failure.message,details:failure.details}};}
        if(heartbeatError)throw heartbeatError;await request(`/v1/workers/operations/${claim.operationId}/report`,report);continue;
      }
      const report=await methods.execute(claim,{check:()=>request(`/v1/workers/operations/${claim.operationId}/preflight`,fence),signal:stopController.signal,directory:env('CIRCLE_HUB_DATA_DIR'),event:event=>request(`/v1/workers/operations/${claim.operationId}/events`,{...fence,inputRevisionId:claim.inputRevisionId,event}),source:async()=>{await authenticate();const response=await fetch(new URL(`/v1/workers/operations/${claim.operationId}/source?fence=${claim.fencingToken}`,base),{redirect:'error',headers:{authorization:`Bearer ${token}`}});if(!response.ok)throw new ApiError("EVIDENCE_INSUFFICIENT","Source download failed");return Buffer.from(await response.arrayBuffer());}});
      if(stopped)continue;
      if(heartbeatError)throw heartbeatError;
      await request(`/v1/workers/operations/${claim.operationId}/report`,report);
    } finally { clearInterval(timer); await pendingHeartbeat; }
  } catch (error) {
    console.error(JSON.stringify({ type:'worker-operation-error',code:error instanceof ApiError ? error.code : 'TRANSPORT_CLOSED' }));
    await delay(300);
  }
}
await runtimeJob;
await Promise.allSettled(professionalJobs.values());
if(process.connected)process.send?.({type:'worker-stopped',graceful:draining});
if (process.connected) process.disconnect();

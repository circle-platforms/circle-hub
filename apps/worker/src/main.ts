import { setTimeout as delay } from 'node:timers/promises';
import { ApiError, HEARTBEAT_MS, AnyWorkerClaim, sha256 } from '../../../packages/contracts/src/index.ts';
import { compileMindmap } from '../../../packages/methods/src/mindmap.ts';
import { SyntheticDevice } from '../../../packages/execution/src/synthetic-device.ts';
import { ConnectorSDK } from '../../../packages/connectors/src/index.ts';
import {executeTool} from '../../../packages/connectors/src/tool-packages.ts';
import {PrivateVault} from '../../../packages/assets/src/vault.ts';
import {LocalObjects} from '../../../packages/knowledge/src/objects.ts';
import {runCircle} from '../../../packages/runtime/src/circle-rpc.ts';
import {privateRequest} from '../../../packages/runtime/src/private-ipc.ts';
import {join} from 'node:path';
import {SourceCache} from '../../../packages/connectors/src/source-cache.ts';

function env(name: string): string { const value = process.env[name]; if (!value) throw new Error(`Required environment variable: ${name}`); return value; }
const base = new URL(env('CIRCLE_SERVER_URL'));
if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1') throw new Error('Phase one worker only connects to the authorized loopback development server');
const username = env('CIRCLE_WORKER_USERNAME'); const password = env('CIRCLE_WORKER_PASSWORD');
let token = ''; let expires = 0; let stopped = false;
const stopController=new AbortController();
const stop=()=>{stopped=true;stopController.abort();};
process.on('SIGTERM',stop);process.on('SIGINT',stop);process.once('disconnect',stop);
async function authenticate(): Promise<void> {
  if (token && Date.now() < expires - 5000) return;
  const response = await fetch(new URL('/v1/auth/dev-login',base), { method: 'POST', headers: { 'content-type':'application/json' }, body: JSON.stringify({ username,password }) });
  const envelope = await response.json() as any;
  if (!response.ok) throw new ApiError('UNAUTHENTICATED','Worker development login failed');
  token = envelope.data.token; expires = Date.parse(envelope.data.expiresAt);
}
async function request(path: string,body: unknown): Promise<any> {
  await authenticate();
  const response = await fetch(new URL(path,base), { method:'POST',headers:{ authorization:`Bearer ${token}`,'content-type':'application/json' },body: JSON.stringify(body) });
  const envelope = await response.json() as any;
  if (!response.ok) throw new ApiError(envelope.error.code,envelope.error.message);
  return envelope.data;
}
const connectors=process.env.CIRCLE_SYNTHETIC_RESOURCE_DIR?new ConnectorSDK(process.env.CIRCLE_SYNTHETIC_RESOURCE_DIR):undefined;
if(connectors)await connectors.initialize();
await request('/v1/workers/register',{});
console.log(JSON.stringify({ type:'worker-ready',username }));
let runtimeJob:Promise<void>|undefined;
async function executeRuntime(claim:any,preflight:any):Promise<void>{
  const fence={fencingToken:claim.fencingToken},abort=new AbortController();const onStop=()=>abort.abort();stopController.signal.addEventListener('abort',onStop,{once:true});
  let pendingHeartbeat:Promise<void>|undefined;const timer=setInterval(()=>{if(pendingHeartbeat)return;pendingHeartbeat=request(`/v1/workers/operations/${claim.operationId}/heartbeat`,fence).then(()=>{}).catch(()=>abort.abort()).finally(()=>{pendingHeartbeat=undefined;});},HEARTBEAT_MS);
  let pendingCheck:Promise<void>|undefined;const cancelPoll=setInterval(()=>{if(pendingCheck)return;pendingCheck=request(`/v1/workers/operations/${claim.operationId}/preflight`,fence).then(()=>{}).catch(()=>abort.abort()).finally(()=>{pendingCheck=undefined;});},500);
  const authorization=preflight.authorization,channel={authorization:`Bearer ${token}`,operationId:claim.operationId,fencingToken:claim.fencingToken};let report:any;
  try{
    const secret=await privateRequest(authorization.privateSocketPath,channel),objects=new LocalObjects(env('CIRCLE_SERVER_DATA_DIR'));
    const files=await Promise.all(authorization.files.map(async(file:any)=>({...file,bytes:await objects.getObject({Bucket:'evidence',Key:file.sha256})})));
    const output=await runCircle({runtime:secret.runtime,folder:join(env('CIRCLE_SERVER_DATA_DIR'),'runs',claim.operationId),manifest:authorization.manifest,files,inputs:claim.args.inputs,
      serverUrl:base.origin,serverToken:secret.serverToken,scopeId:authorization.scopeId,principalId:authorization.principalId,signal:abort.signal,
      event:async event=>{await request(`/v1/workers/operations/${claim.operationId}/events`,{...fence,inputRevisionId:claim.inputRevisionId,event});}});
    report={...fence,inputRevisionId:claim.inputRevisionId,status:'succeeded',output};
  }catch(error){const failure=error instanceof ApiError?error:new ApiError('RUNTIME_FAILED','Circle runtime failed');
    if(failure.details.localExitObserved===true){await request(`/v1/workers/operations/${claim.operationId}/local-stopped`,{...fence,inputRevisionId:claim.inputRevisionId,localExitObserved:true});return;}
    report={...fence,inputRevisionId:claim.inputRevisionId,status:'failed',output:{},error:{code:failure.code,message:failure.message}};}
  finally{clearInterval(timer);clearInterval(cancelPoll);await pendingHeartbeat;await pendingCheck;stopController.signal.removeEventListener('abort',onStop);try{await privateRequest(authorization.privateSocketPath,{...channel,revoke:true});}catch{/* A cancelled/expired run token already authorizes no new work. */}}
  if(!stopped)await request(`/v1/workers/operations/${claim.operationId}/report`,report);
}
while (!stopped) {
  try {
    const next = await request('/v1/workers/claim',{exclude:runtimeJob?['assets.execute']:[]});
    if (!next) { await delay(100); continue; }
    const claim = AnyWorkerClaim.parse(next); const fence = { fencingToken:claim.fencingToken };
    const preflight=await request(`/v1/workers/operations/${claim.operationId}/preflight`,fence);
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
          const authorization=preflight.authorization,credential=authorization.injection?await new PrivateVault(`${env('CIRCLE_SERVER_DATA_DIR')}/private-credentials`).get(authorization.injection.key,authorization.injection.binding):undefined;
          await request(`/v1/workers/operations/${claim.operationId}/preflight`,fence);
          const output=await executeTool(authorization.packageId,authorization.handler,claim.args.input,authorization.profile,credential,{cache:new SourceCache(join(env('CIRCLE_SERVER_DATA_DIR'),'connector-cache')),cacheNamespace:authorization.cacheNamespace});
          report={...fence,inputRevisionId:claim.inputRevisionId,status:'succeeded',output:{result:output.result,sourceType:output.sourceType,raw:output.raw.map(raw=>({path:raw.path,sha256:raw.sha256,sourceType:raw.sourceType??output.sourceType,contentBase64:raw.bytes.toString('base64')}))}};
        }catch(error){const failure=error instanceof ApiError?error:new ApiError('INTERNAL_ERROR','Registered tool failed');report={...fence,inputRevisionId:claim.inputRevisionId,status:'failed',output:{},error:{code:failure.code,message:failure.message,details:failure.details}};}
        if(heartbeatError)throw heartbeatError;await request(`/v1/workers/operations/${claim.operationId}/report`,report);continue;
      }
      if(claim.name!=='mindmaps.compile'&&'kind' in claim){
        let report;
        try{const check=()=>request(`/v1/workers/operations/${claim.operationId}/preflight`,fence);
          const output=claim.target==='LBX-LAB-01'?await new SyntheticDevice(env('CIRCLE_SYNTHETIC_RESOURCE_DIR')).execute(claim,check,stopController.signal):await connectors!.execute(claim,check);
          report={...fence,inputRevisionId:claim.inputRevisionId,status:'succeeded',output};
        }catch(error){if(stopped)continue;const failure=error instanceof ApiError?error:new ApiError('INTERNAL_ERROR','Synthetic driver failed');
          report={...fence,inputRevisionId:claim.inputRevisionId,status:failure.code==='UPSTREAM_TIMEOUT'?'unknown':'failed',error:{code:failure.code,message:failure.message},output:{}};}
        if(heartbeatError)throw heartbeatError;await request(`/v1/workers/operations/${claim.operationId}/report`,report);continue;
      }
      if(!('source' in claim))throw new ApiError('INVALID_PAYLOAD','Compile claim has no source');
      await authenticate();
      const response = await fetch(new URL(`/v1/workers/operations/${claim.operationId}/source?fence=${claim.fencingToken}`,base),{ headers:{ authorization:`Bearer ${token}` } });
      if (!response.ok) throw new ApiError('EVIDENCE_INSUFFICIENT','Source download failed');
      const bytes = Buffer.from(await response.arrayBuffer());
      if (sha256(bytes) !== claim.source.sha256) throw new ApiError('SOURCE_HASH_MISMATCH','Worker source hash mismatch');
      // The executing process repeats live authorization immediately before computing/writing an artifact.
      await request(`/v1/workers/operations/${claim.operationId}/preflight`,fence);
      let report;
      try {
        const compiled = await compileMindmap(bytes,claim.source.fileName);
        report = { ...fence,inputRevisionId:claim.inputRevisionId,status:compiled.status,artifactBase64:compiled.workbook.toString('base64') };
      } catch (error) {
        const failure = error instanceof ApiError ? error : new ApiError('INTERNAL_ERROR','Compiler failed');
        report = { ...fence,inputRevisionId:claim.inputRevisionId,status:'failed',error:{ code:failure.code,message:failure.message } };
      }
      if (heartbeatError) throw heartbeatError;
      await request(`/v1/workers/operations/${claim.operationId}/report`,report);
    } finally { clearInterval(timer); await pendingHeartbeat; }
  } catch (error) {
    console.error(JSON.stringify({ type:'worker-operation-error',code:error instanceof ApiError ? error.code : 'TRANSPORT_CLOSED' }));
    await delay(300);
  }
}
await runtimeJob;
if (process.connected) process.disconnect();

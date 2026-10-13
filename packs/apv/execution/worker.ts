import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {ApiError,canonicalHash,requireCondition,sha256} from '../../../packages/contracts/src/index.ts';
import {PrivateVault} from '../../../packages/assets/src/vault.ts';
import {RotatingToken} from '../../../packages/assets/src/rotating-token.ts';
import {McpGateway} from '../../../packages/connectors/src/case-gateway.ts';
import {executeTool} from '../../../packages/connectors/src/tool-packages.ts';
import {SourceCache} from '../../../packages/connectors/src/source-cache.ts';
import {readExecutionWorkbook} from './workbook.ts';
import {LocalObjects} from '../../../packages/knowledge/src/objects.ts';
import {environmentBuild} from './environment.ts';
import {OAuthToken} from '../../../packages/assets/src/oauth-token.ts';

export interface CaseWorkerContext {check:()=>Promise<any>;source:()=>Promise<Buffer>;signal:AbortSignal;directory:string;event:(event:any)=>Promise<any>}
const rawOutput=(output:any)=>({result:output.result,raw:output.raw.map((raw:any)=>({path:raw.path,sha256:raw.sha256,sourceType:raw.sourceType??output.sourceType,contentBase64:raw.bytes.toString('base64')}))});
export async function executeCases(claim:any,context:CaseWorkerContext){
  const fence={fencingToken:claim.fencingToken,inputRevisionId:claim.inputRevisionId};let stage='source',submitIntent=false,terminalObserved=false,submitted:any,gateway:McpGateway|undefined,lease:any,heartbeat:NodeJS.Timeout|undefined,pendingHeartbeat:Promise<void>|undefined,heartbeatError:any;
  try{
    const preflight=await context.check(),authorization=preflight.authorization,vault=new PrivateVault(join(context.directory,'private-credentials'));
    if(claim.name==='cases.verify'||claim.name==='cases.execute'){
      const bytes=await context.source(),book=await readExecutionWorkbook(bytes);requireCondition(book.sha256===claim.args.sourceSha256,'SOURCE_HASH_MISMATCH','Worker workbook differs from the task source');
      if(authorization.sourceArtifact){const objects=new LocalObjects(context.directory),originals=await Promise.all(authorization.sourceArtifact.files.map(async(file:any)=>({path:`/${file.path}`,sha256:file.sha256,bytes:await objects.getObject({Bucket:'evidence',Key:file.sha256}),sourceType:'external-artifact',mediaType:file.mediaType,etag:null}))),proof={result:{},raw:originals,sourceType:'external-artifact'};
        if(claim.name==='cases.verify')return {...fence,status:'succeeded',output:rawOutput(proof)};await context.event({stage:'validation',output:rawOutput(proof)});
      }else{
      const credential=authorization.buildInjection?await vault.get(authorization.buildInjection.key,authorization.buildInjection.binding):undefined;
      const checked=await executeTool('build-site','build.check',{build:claim.args.build,platform:claim.args.platform,commands:book.commands.map(command=>command.command)},authorization.buildProfile,credential,{cache:new SourceCache(join(context.directory,'connector-cache')),cacheNamespace:authorization.buildCacheNamespace,freshCommands:true});
      if(claim.name==='cases.verify')return {...fence,status:'succeeded',output:rawOutput(checked)};
      await context.event({stage:'validation',output:rawOutput(checked)});
      }
    }
    const profile=authorization.profile;
    if(authorization.gatewayInjection.provider==='server')gateway=new McpGateway(profile,async()=>{const checked=await context.check(),injection=checked.authorization.gatewayInjection;requireCondition(injection.provider==='server','APPROVAL_STALE','Resource authorization provider changed');return vault.get(injection.key,injection.binding);});
    else if(authorization.gatewayInjection.provider==='static-secret')gateway=new McpGateway(profile,async()=>{const checked=await context.check(),injection=checked.authorization.gatewayInjection;requireCondition(injection.provider==='static-secret','APPROVAL_STALE','Static credential binding changed');return vault.get(injection.key,injection.binding);});
    else{const oauth=authorization.gatewayInjection.oauth,client=oauth?.clientReference?JSON.parse(await vault.get(oauth.clientReference.key,oauth.clientReference.binding)):undefined,tokens=oauth?new OAuthToken(vault,authorization.gatewayInjection,oauth.profile,oauth.grantType,client?.client_secret):new RotatingToken(vault,authorization.gatewayInjection,{issuer:profile.issuer,caFile:profile.issuerCaFile??profile.caFile,caSha256:profile.issuerCaSha256??profile.caSha256});gateway=new McpGateway(profile,()=>tokens.access());}
    if(claim.name==='cases.observe'){
      requireCondition(authorization.remoteTaskId,'EVIDENCE_INSUFFICIENT','Unknown submission has no remote task identity');
      const status=await gateway.call('case_status',{task_id:authorization.remoteTaskId},context.signal),results=await gateway.call('case_results',{task_id:authorization.remoteTaskId},context.signal);requireCondition(status.state==='done','EVIDENCE_INSUFFICIENT','Independent gateway observation is not terminal');return {...fence,status:'succeeded',output:{status,results}};
    }
    stage='lease';await context.check();lease=await gateway.call('lease_acquire',{},context.signal);requireCondition(typeof lease.lease_id==='string'&&Number.isSafeInteger(lease.token),'EVIDENCE_INSUFFICIENT','Gateway lease has no fence');
    const leaseArgs={lease_id:lease.lease_id,token:lease.token};heartbeat=setInterval(()=>{if(pendingHeartbeat)return;pendingHeartbeat=gateway!.call('lease_heartbeat',leaseArgs,context.signal).then(()=>{}).catch(error=>{heartbeatError=error;}).finally(()=>{pendingHeartbeat=undefined;});},Math.max(1000,Math.min(20000,(lease.expires_in_s??1800)*1000/3)));
    stage='environment';await context.check();const environment=await gateway.call('env_prepare',{...leaseArgs,device_build:claim.args.buildName},context.signal),observation=environmentBuild(environment,claim.args.buildName);
    await context.event({stage:'environment',environment});if(!observation.passed)throw new ApiError('BUILD_MISMATCH','Gateway has not observed the bound device build',observation);
    const bytes=await context.source(),book=await readExecutionWorkbook(bytes);requireCondition(book.commands.every(command=>command.deviceIndex<environment.device_count),'GATEWAY_REFUSED','Workbook targets a device absent from the gateway environment');
    await context.check();await context.event({stage:'submit-intent'});submitIntent=true;
    await context.check();
    submitted=await gateway.call('case_submit',{...leaseArgs,xlsx_b64:bytes.toString('base64'),...(claim.args.module?{module:claim.args.module}:{})},context.signal);
    const staged=await context.event({stage:'submitted',receipt:submitted});requireCondition(staged.bindingAccepted===true&&submitted.sha256===sha256(bytes)&&canonicalHash(submitted.case_ids)===canonicalHash(book.cases.map(item=>item.autoid)),'SOURCE_HASH_MISMATCH','Gateway staged workbook or case identities differ');
    while(true){
      await context.check();if(heartbeatError)throw heartbeatError;
      const status=await gateway.call('case_status',{task_id:submitted.task_id},context.signal);await context.event({stage:'status',remoteTaskId:submitted.task_id,state:status.state});
      if(status.state==='lost'||status.state==='unknown')throw new ApiError('EVIDENCE_INSUFFICIENT','Gateway runner has no observed terminal receipt');
      if(status.state==='done'){terminalObserved=true;const results=await gateway.call('case_results',{task_id:submitted.task_id},context.signal);return {...fence,status:'succeeded',output:{submit:submitted,environment,status,results}};}
      requireCondition(status.state==='running','EVIDENCE_INSUFFICIENT','Gateway state is not recognized');await delay(profile.pollMs,undefined,{signal:context.signal});
    }
  }catch(error){const failure=error instanceof ApiError?error:new ApiError('SOURCE_UNREACHABLE','Gateway execution channel was interrupted'),code=failure.code==='GATEWAY_REFUSED'?(stage==='lease'?'LEASE_UNAVAILABLE':stage==='environment'?'BUILD_MISMATCH':'GATEWAY_UNREACHABLE'):failure.code;return {...fence,status:submitIntent?'unknown':'failed',output:{remoteTaskId:submitted?.task_id,remoteStoppingVerified:false},error:{code,message:failure.message,details:{...failure.details,stage,...(code==='BUILD_MISMATCH'&&!Object.hasOwn(failure.details,'observedBuild')?{expectedBuild:claim.args.buildName,observedBuild:null}:{})}}};}
  finally{
    clearInterval(heartbeat);await pendingHeartbeat;
    // Releasing the logical lease never claims that a remote runner stopped.
    if(gateway&&lease&&(!submitIntent||terminalObserved))try{await gateway.call('lease_release',{lease_id:lease.lease_id,token:lease.token});}catch{/* Preserve the primary failure. */}
  }
}

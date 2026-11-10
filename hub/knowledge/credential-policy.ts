// Deployment data chooses ordinary example sources. The core knows no product or system names.
import {SourceLoader,type ExternalLoad} from './sources.ts';
import type {KnowledgeContext} from './context.ts';
import type {Principal,ActionBody,SourceArtifact,VariableSnapshot} from '../records/api.ts';
import {credentialObject,namedAdmin,requestKnowledgeFact} from './requests.ts';
import {ACTION,COMPONENTS} from './store.ts';
export interface CredentialAcceptanceOptions {autoAcceptSources?:readonly {systemPack:string;slot:string}[];deadlineHours?:number}
const requests=(context:KnowledgeContext,sha:string)=>context.store.all<ActionBody>({key:'knowledge.credential.request',value:sha,kind:'action'});
const resolved=(context:KnowledgeContext,digest:string)=>context.store.exists('knowledge.credential.resolved',digest,'action');
export async function reconcileCredentialRequests(context:KnowledgeContext,sha?:string):Promise<number>{
 const rows=sha?await requests(context,sha):await context.store.all<ActionBody>({key:'knowledge.credential.request.all',value:'1',kind:'action'});
 const [resolvedRows,expiredRows]=await Promise.all([
  context.records.store.findMany<ActionBody>({key:'knowledge.credential.resolved',values:rows.map(row=>row.digest),kind:'action'}),
  context.records.store.findMany<ActionBody>({key:'knowledge.credential.expired',values:rows.map(row=>row.digest),kind:'action'}),
 ]);
 const done=new Set(resolvedRows.map(row=>row.body.detail.resolved_request)),past=new Set(expiredRows.map(row=>row.body.detail.expired_request));
 const admin=await namedAdmin(context);
 let expired=0;
 for(const row of rows){
  const detail=row.body.detail;if(!detail)continue;const credential=detail.credential as {sha256:string;record:string;external:string}|undefined;
  if(!credential||typeof detail.deadline!=='string'||done.has(row.digest)||past.has(row.digest))continue;
  // An acceptance closes the request at once: nothing else tells this store of it, and no sync may ever read this source.
  // A source that cannot be checked leaves its request as it is: it never stops the sync that reconciles.
  if(admin){const current=await context.records.artifacts.source(admin,credential.sha256,{consumer:'model',record:credential.record}).catch(()=>null);if(current?.bytes){await clearRequests(context,credential.sha256);continue;}}
  if(Date.parse(detail.deadline)>context.now().getTime())continue;
  await requestKnowledgeFact(context,{kind:'clarification',subject:`凭据命中核对 ${row.digest}`,missing:'凭据命中接受请求已到期，需要核对当前接受决定',action:'具名管理员核对当前来源和受理决定；到期不算接受，修正来源或显式决定后重新同步',inputs:[`rec:${row.digest}`],credential,expiredFrom:row.digest,deadlineHours:context.credentialAcceptance?.deadlineHours??72});
  const now=context.now().toISOString();
  await context.store.putAction({action:ACTION.read,run:null,item:null,inputs:[`rec:${row.digest}`],component:COMPONENTS.sync,lease:null,started_at:now,ended_at:now,result:'completed',error_code:null,acceptance:null,codes:[],detail:{expired_request:row.digest,accepted_by_expiry:false}},[{key:'knowledge.credential.expired',value:row.digest}]);expired++;
 }
 return expired;
}
async function clearRequests(context:KnowledgeContext,sha:string):Promise<void>{
 for(const row of await requests(context,sha)){
  if(await resolved(context,row.digest))continue;
  const now=context.now().toISOString();await context.store.putAction({action:ACTION.read,run:null,item:null,inputs:[`rec:${row.digest}`,`src:${sha}`],component:COMPONENTS.sync,lease:null,started_at:now,ended_at:now,result:'completed',error_code:null,acceptance:null,codes:[],detail:{resolved_request:row.digest,accepted:true}},[{key:'knowledge.credential.resolved',value:row.digest}]);
 }
}
/** The named, dated question of a held source (B02 R[4], C04 R[6]). */
const askReview=(context:KnowledgeContext,artifact:SourceArtifact,external:string,failedAcceptance:string|null=null)=>{
 const body=artifact.body,sha=body.sha256;
 return requestKnowledgeFact(context,{kind:body.requested_read_tier==='retain_only'?'repair':'clarification',subject:`凭据命中 ${sha}`,missing:body.requested_read_tier==='retain_only'?'来源被明确要求仅保留，不能自动接受':'来源凭据命中尚无有效接受',action:body.requested_read_tier==='retain_only'?'管理员核对明确保留的原因；如为凭据回显，联系来源负责人去掉回显并按需更换凭据后重读，不能自动解除':'管理员分页核对命中，只按检测类显式接受已确认的示例，或修正来源后重新同步',inputs:[`src:${sha}`,...(failedAcceptance?[`rec:${failedAcceptance}`]:[])],credential:{sha256:sha,record:artifact.digest,external},deadlineHours:context.credentialAcceptance?.deadlineHours??72});
};
/** A reader was told this object awaits review: the request a sync raises, unless one for the object is still open (D05 R[3]). */
export async function requestSourceReview(context:KnowledgeContext,artifact:SourceArtifact,external:string):Promise<void>{
 const open=async()=>{
  const rows=await context.store.all<ActionBody>({key:'knowledge.credential.object',value:credentialObject(external),kind:'action'});
  const closed=await context.records.store.findMany<ActionBody>({key:'knowledge.credential.resolved',values:rows.map(row=>row.digest),kind:'action'});
  const done=new Set(closed.map(row=>row.body.detail.resolved_request));return rows.filter(row=>!done.has(row.digest));
 };
 for(const sha of new Set((await open()).map(row=>(row.body.detail.credential as {sha256:string}).sha256)))await reconcileCredentialRequests(context,sha);
 if((await open()).length===0)await askReview(context,artifact,external);
}
export function knowledgeSourceLoader(context:KnowledgeContext,by:Principal,purpose:string,variables?:VariableSnapshot):SourceLoader{
 let loader:SourceLoader;
 const cleared=new Set<string>();
 const handle=async(load:Extract<ExternalLoad,{ok:true}>,slot?:string):Promise<void>=>{
  const body=load.artifact.body,sha=body.sha256;
  await reconcileCredentialRequests(context,sha);
  const previous=await requests(context,sha),active=[];
  for(const row of previous)if(!await resolved(context,row.digest))active.push(row);
  const expired=active.some(row=>row.body.detail.expired_from!==undefined||typeof row.body.detail.deadline==='string'&&Date.parse(row.body.detail.deadline)<=context.now().getTime());
  const manifest=await loader.manifest(load.manifest);
  const belongs=manifest?.external===load.id&&(manifest.artifacts.some(item=>item.record===load.artifact.digest&&item.sha256===sha)||manifest.requests.some(item=>item.artifact===load.artifact.digest&&item.sha256===sha));
  const configured=belongs&&slot!==undefined&&(context.credentialAcceptance?.autoAcceptSources??[]).some(source=>source.systemPack===manifest!.system_pack.id&&source.slot===slot);
  let failedAcceptance:string|null=null;
  // Explicit retention includes actual request-credential echoes and is never lifted automatically.
  if(configured&&!expired&&body.visibility.admins&&body.author.user===null&&body.requested_read_tier==='model_readable'&&body.scan.findings.length>0){
   const administrator=context.admin??by;
   try{
    const page=await context.records.artifacts.scanFindings(administrator,sha);
    await context.records.artifacts.acceptFindings(administrator,sha,'部署已点名的实验室示例资料',{detectors:Object.keys(page.detectors),automatic:true});
    const accepted=await context.records.artifacts.source(administrator,sha,{consumer:'model',record:load.artifact.digest});
    if(accepted?.bytes){await clearRequests(context,sha);return;}
   }catch{
    const at=context.now().toISOString();
    const action=await context.store.putAction({action:ACTION.read,run:null,item:null,inputs:[`src:${sha}`,`rec:${load.artifact.digest}`],component:COMPONENTS.sync,lease:null,started_at:at,ended_at:at,result:'error',error_code:'SOURCE_UNAVAILABLE',acceptance:null,codes:[],detail:{automatic:true,administrator:administrator.id,reason:'check_error',operation:'acceptFindings',missing:'缺少自动接受后来源可读的核验事实',next_action:'管理员核对扫描、接受权限、撤回决定和原件完整性，恢复来源后重新同步'}},[{key:'knowledge.credential.acceptance-failed',value:sha}]);
    failedAcceptance=action.digest;
   }
  }
  if(active.length>0)return;
  await askReview(context,load.artifact,load.id,failedAcceptance);
 };
 loader=new SourceLoader({external:context.external,artifacts:context.records.artifacts,parsers:context.parsers,records:context.records.store,variables,onCredential:handle,onReadable:async load=>{if(load.artifact.body.scan.findings.length>0&&!cleared.has(load.artifact.body.sha256)){cleared.add(load.artifact.body.sha256);await clearRequests(context,load.artifact.body.sha256);}}},by,purpose);
 return loader;
}

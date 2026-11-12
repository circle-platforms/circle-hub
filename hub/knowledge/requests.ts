// A durable, deduplicated question for a named administrator, with a concrete recovery action.
import type { RequestKind,Attribution,Reason } from '../../contracts/generated/vocabulary.ts';
import {canonicalize,sha256Hex,scanForCredentials,isSha256,type Principal,type Page,type ActionBody,type SourceArtifactBody} from '../records/api.ts';
import type {KnowledgeRecords} from './context.ts';
import {KnowledgeError} from './errors.ts';
import type {KnowledgeContext} from './context.ts';
import {ACTION,COMPONENTS} from './store.ts';

export interface CredentialReviewRow {
 reference:string;source:string;external:string|null;audience:string;created_at:string;deadline:string;resolved:boolean;expired:boolean;superseded:boolean;
}

export async function credentialReviewRequests(records:Pick<KnowledgeRecords,'store'|'principals'|'artifacts'>,by:Principal,query:{cursor?:string|null;limit?:number;now?:Date}={}):Promise<Page<CredentialReviewRow>>{
 const active=await records.principals.get(by.id);if(!active||active.disabled||active.role!=='admin')throw new KnowledgeError('来源核看请求不可用',{code:'SOURCE_UNAVAILABLE'});
 const limit=query.limit??50;if(!Number.isInteger(limit)||limit<1||limit>100)throw new RangeError('核看请求每页条数须为 1 到 100 的整数');
 const page=await records.store.find<ActionBody>({key:'knowledge.credential.request.all',value:'1',kind:'action',newestFirst:true,limit,cursor:query.cursor??null});
 const [resolved,expired]=await Promise.all([records.store.findMany<ActionBody>({key:'knowledge.credential.resolved',values:page.items.map(row=>row.digest),kind:'action'}),records.store.findMany<ActionBody>({key:'knowledge.credential.expired',values:page.items.map(row=>row.digest),kind:'action'})]);
 const done=new Set(resolved.map(row=>row.body.detail.resolved_request)),past=new Set(expired.map(row=>row.body.detail.expired_request));const items:CredentialReviewRow[]=[];
 for(const row of page.items){
  const detail=row.body.detail,credential=detail.credential as {sha256?:unknown;record?:unknown;external?:unknown}|undefined;
  if(!credential||typeof credential.sha256!=='string'||typeof credential.record!=='string'||!isSha256(credential.record)||!isSha256(credential.sha256)||typeof detail.audience_user!=='string'||typeof detail.deadline!=='string'||!Number.isFinite(Date.parse(detail.deadline)))continue;
  const source=await records.store.get<SourceArtifactBody>(credential.record);if(!source||source.kind!=='source_artifact'||source.body.sha256!==credential.sha256||!await records.artifacts.canRead(active,source))continue;
  const external=typeof credential.external==='string'?credential.external:null,scan=external===null?null:scanForCredentials(Buffer.from(external));
  items.push({reference:`rec:${row.digest}`,source:`src:${credential.sha256}`,external:scan?.inspected&&!scan.truncated&&!scan.findings.length?external:null,audience:detail.audience_user,created_at:row.created_at,deadline:detail.deadline,resolved:done.has(row.digest),expired:Date.parse(detail.deadline)<=(query.now??new Date()).getTime(),superseded:past.has(row.digest)});
 }
 return {items,next:page.next};
}

/** The administrator a request names: the configured one while enabled, else any enabled administrator. */
export async function namedAdmin(context:KnowledgeContext){
 const preferred=context.admin===null?null:await context.records.principals.get(context.admin.id);
 return preferred?.role==='admin'&&!preferred.disabled?preferred:(await context.records.principals.list?.()??[]).find(user=>user.role==='admin'&&!user.disabled);
}
/** Index value of the object a credential request is about: its bytes can change from one read to the next. */
export const credentialObject=(external:string):string=>sha256Hex(canonicalize(external));

export async function requestKnowledgeFact(context:KnowledgeContext,input:{subject:string;missing:string;action:string;inputs:string[];kind?:RequestKind;deadlineHours?:number;attribution?:Attribution;reason?:Reason;credential?:{sha256:string;record:string;external:string};expiredFrom?:string}):Promise<{reference:string;audience_user:string;deadline:string}>{
 const admin=await namedAdmin(context);
 if(!admin)throw new Error('缺少可接收知识核对请求的具名管理员；请先配置启用的同步管理员再重试');
 let key=sha256Hex(canonicalize({...input,admin:admin.id}));
 let known=await context.store.newest<{detail:{audience_user:string;deadline:string}}>({key:'knowledge.request',value:key,kind:'action'});
 while(known!==null&&input.credential&&await context.store.exists('knowledge.credential.resolved',known.digest,'action')){
  key=sha256Hex(canonicalize({previous:known.digest,key}));
  known=await context.store.newest<{detail:{audience_user:string;deadline:string}}>({key:'knowledge.request',value:key,kind:'action'});
 }
 if(known!==null)return {reference:`rec:${known.digest}`,audience_user:known.body.detail.audience_user,deadline:known.body.detail.deadline};
 const now=context.now().toISOString(),deadline=new Date(context.now().getTime()+(input.deadlineHours??72)*3600000).toISOString();
 const record=await context.store.putAction({action:ACTION.read,run:null,item:null,inputs:input.inputs,component:COMPONENTS.sync,lease:null,
  started_at:now,ended_at:now,result:'completed',error_code:null,acceptance:null,codes:[],
  detail:{...(input.credential?{credential:input.credential}:{}),...(input.expiredFrom?{expired_from:input.expiredFrom}:{}),request_kind:input.kind??'clarification',...(input.attribution?{attribution:input.attribution}:{}),...(input.reason?{reason:input.reason}:{}),subject:input.subject,missing:input.missing,next_action:input.action,
   audience_user:admin.id,audience_name:admin.name,deadline,channel:{component:COMPONENTS.sync},question_sha256:key}},[{key:'knowledge.request',value:key},...(input.credential?[{key:'knowledge.credential.request',value:input.credential.sha256},{key:'knowledge.credential.request.all',value:'1'},{key:'knowledge.credential.object',value:credentialObject(input.credential.external)}]:[])]);
 return {reference:`rec:${record.digest}`,audience_user:admin.id,deadline};
}

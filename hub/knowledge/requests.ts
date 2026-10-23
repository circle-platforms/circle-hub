// A durable, deduplicated question for a named administrator, with a concrete recovery action.
import type { RequestKind,Attribution,Reason } from '../../contracts/generated/vocabulary.ts';
import {canonicalize,sha256Hex} from '../records/api.ts';
import type {KnowledgeContext} from './context.ts';
import {ACTION,COMPONENTS} from './store.ts';

export async function requestKnowledgeFact(context:KnowledgeContext,input:{subject:string;missing:string;action:string;inputs:string[];kind?:RequestKind;deadlineHours?:number;attribution?:Attribution;reason?:Reason;credential?:{sha256:string;record:string;external:string};expiredFrom?:string}):Promise<{reference:string;audience_user:string;deadline:string}>{
 const preferred=context.admin===null?null:await context.records.principals.get(context.admin.id);
 const admin=preferred?.role==='admin'&&!preferred.disabled?preferred:(await context.records.principals.list?.()??[]).find(user=>user.role==='admin'&&!user.disabled);
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
   audience_user:admin.id,audience_name:admin.name,deadline,channel:{component:COMPONENTS.sync},question_sha256:key}},[{key:'knowledge.request',value:key},...(input.credential?[{key:'knowledge.credential.request',value:input.credential.sha256},{key:'knowledge.credential.request.all',value:'1'}]:[])]);
 return {reference:`rec:${record.digest}`,audience_user:admin.id,deadline};
}

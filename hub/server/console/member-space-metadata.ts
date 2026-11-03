// Administrator metadata excludes document titles, content counts and personal version activity.
import {SpaceGrantBody} from '../../../contracts/src/spaces.ts';
import {MemoryGrantBody} from '../../../contracts/src/memory.ts';
import {PersonalPackGrantBody} from '../../../contracts/src/sharing.ts';
import {KnowledgeGranteeSchema,KnowledgeGrantActionSchema,uiLabelOf} from '../../../contracts/generated/vocabulary.ts';
import type {User} from '../../records/api.ts';
import type {PageContext} from './pages.ts';

export async function memberSpaceMetadata(ctx:PageContext,user:User):Promise<Array<[string,unknown]>>{
 const spaces=ctx.deps.knowledge.spaces;if(!ctx.admin||!spaces)return [];
 const current=await spaces.current(user.id),memory=await ctx.deps.knowledge.memory?.usage(ctx.principal,user.id);
 const counts=[];
 for(const source of [
  {kind:'knowledge_space_grant',key:'knowledge.space.grantee',schema:SpaceGrantBody,label:uiLabelOf('knowledge_view','knowledge')},
  {kind:'memory_grant',key:'memory.grant.grantee',schema:MemoryGrantBody,label:uiLabelOf('knowledge_view','memory')},
  {kind:'personal_pack_grant',key:'personal.pack.grantee',schema:PersonalPackGrantBody,label:uiLabelOf('pack_kind','workflow')+'与'+uiLabelOf('pack_kind','skill')},
 ] as const){
  const latest=new Map<string,boolean>();
  for(const record of await ctx.deps.records.store.findMany({kind:source.kind,key:source.key,values:[KnowledgeGranteeSchema.enum.administrators]})){
   const parsed=source.schema.safeParse(record.body);if(!parsed.success)continue;const body=parsed.data;
   if(body.space!==user.id||body.by!==user.id||body.audience!==KnowledgeGranteeSchema.enum.administrators||body.member!==null)continue;
   latest.set('pack' in body?body.pack:body.path,body.action===KnowledgeGrantActionSchema.enum.grant);
  }
  counts.push(source.label+' '+(user.disabled?0:[...latest.values()].filter(Boolean).length));
 }
 return [['私人空间已用（含版本记录）',(current?.body.used_bytes??0)+(memory?.history??0)+' 字节'],['分享给全体管理员的文件夹与工作流',counts.join(' · ')]];
}

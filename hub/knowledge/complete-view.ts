// Run bindings consume an entire immutable view, never interpret a partial page as a closed scope.
import {ImpactView,FacetView,IndexView} from '../../contracts/src/views.ts';
import type {ExternalRead,ExternalReadContext,ExternalReaderPort} from '../ports.ts';
import {canonicalBytes,canonicalize,type Artifacts,type RecordStore} from '../records/api.ts';
import {parseViewId,splitRevision} from './views.ts';
import {ACTION,COMPONENTS,SCHEMAS} from './store.ts';

const MAX_BINDING_BYTES=16*1024*1024;
export async function completeKnowledgeView(id:string,context:ExternalReadContext,external:ExternalReaderPort,records:{artifacts:Artifacts;store:RecordStore}):Promise<ExternalRead>{
 const fail=(message:string):ExternalRead=>({ok:false,id,reason:message,inputError:{message,fix:'索引用 only= 列出本次条目需要的取值，并用 fields= 收窄字段；影响视图用 attached_fields= 收窄后重新开运行'}});
 const parsed=parseViewId(id);let beginning=id;
 if(parsed.ok&&parsed.value.type!=='links'){
  const {body,revision}=splitRevision(id),at=body.indexOf('?');
  if(at>=0){const query=body.slice(at+1).split('&').filter(pair=>!pair.startsWith('after='));beginning=body.slice(0,at)+(query.length?'?'+query.join('&'):'')+(revision?'@'+revision:'');}
 }
 const delivered=new Set<string>();
 const placements=new Set<string>();
 let first:Extract<ExternalRead,{ok:true}>|null=null,merged:any=null,next:string|null=beginning;
 const visited=new Set<string>(),inputs:string[]=[];
 while(next!==null){
  if(visited.has(next))return fail('知识视图续读没有前进；请管理员修复页游标后重试');visited.add(next);
  const read=await external.read(next,context);if(!read.ok)return read;
  first??=read;
  if(read.revision!==first.revision)return fail('知识视图续读时修订改变；请从首页重新绑定');
  const chosen=read.artifacts.find(v=>v.name==='content')??read.artifacts.find(v=>v.name==='original');
  if(!chosen)return fail('知识视图页没有内容原件');
  const source=await records.artifacts.source(context.principal,chosen.artifact.body.sha256,{consumer:'function',record:chosen.artifact.digest});
  if(!source?.bytes)return fail('知识视图页当前不可读；请管理员核对读取档位后重试');
  let page:any;
  try{const raw=JSON.parse(Buffer.from(source.bytes).toString('utf8'));const schema=raw.schema==='index-view@1'?IndexView:raw.schema==='facet-view@1'?FacetView:raw.schema==='impact-view@1'?ImpactView:null;
   if(!schema)return read;page=schema.parse(raw);
  }catch{return fail('知识视图页不符合公开结构；请管理员修复视图后重试');}
  const pageKeys:string[]=page.schema==='index-view@1'?Object.entries(page.keys).flatMap(([key,values])=>(values as string[]).map(value=>canonicalize([key,value]))):page.schema==='facet-view@1'?page.rows.map((row:any)=>canonicalize(row.values)):[...page.changes.map((change:any)=>'path:'+change.path),...Object.entries(page.entries).filter(([,entry])=>(entry as any).build===null).map(([digest])=>'unversioned:'+digest)];
  if(page.next&&pageKeys.length===0)return fail('知识视图给出了空的续读页，无法推进；请管理员修复分页后重试');
  for(const key of pageKeys){if(delivered.has(key))return fail('知识视图续读重复交付同一项；请管理员修复游标后重试');delivered.add(key);}
  if(page.schema==='impact-view@1')for(const placement of page.placements){if(placements.has(placement.path))return fail('知识视图续读重复交付同一节点的附着条目；请管理员修复游标后重试');placements.add(placement.path);}
  inputs.push(`src:${source.sha256}`);
  if(merged===null)merged=page;
  else{
   const scope=(v:any)=>JSON.stringify({schema:v.schema,product:v.product,build:v.build,from:v.from,to:v.to,kind:v.kind,key:v.key,by:v.by,fields:v.fields,only:v.only,changed:v.changed_kinds,attached:v.attached_kinds,attached_fields:v.attached_fields,catalog:v.catalog,skipped:v.skipped,total:v.total,total_keys:v.total_keys,total_entries:v.total_entries,totals:v.totals,unversioned:v.unversioned,scope:v.scope});
   if(scope(merged)!==scope(page))return fail('知识视图续读的查询范围或计数改变；从首页重新绑定');
   if(page.schema==='index-view@1'){
    for(const [key,values] of Object.entries(page.keys))merged.keys[key]=[...new Set([...(merged.keys[key]??[]),...(values as string[])])].sort();
    for(const [digest,entry] of Object.entries(page.entries)){if(merged.entries[digest]&&canonicalize(merged.entries[digest])!==canonicalize(entry))return fail('知识视图续读改变了同一条目的内容；从首页重新绑定');}
    Object.assign(merged.entries,page.entries);
   }else if(page.schema==='facet-view@1')merged.rows.push(...page.rows);
   else{merged.changes.push(...page.changes);merged.placements.push(...page.placements);Object.assign(merged.entries,page.entries);}
   merged.notes=[...new Set([...merged.notes,...page.notes])];
  }
  next=page.next??null;
  if(next===null&&page.truncated)return fail('知识视图仍有未交付的内容，不能作为完整绑定；请按视图说明处理来源或凭据后重试');
  if(next===null&&page.schema==='index-view@1'&&merged.kind==='case'&&visited.size>1){
   // A page's flag describes only that page. Once the frozen sequence is exhausted, its final
   // flag also establishes that the producer knew how to report missing indexed facts; legacy
   // pages without it cannot be upgraded merely because their old truncated flag was false.
   if(typeof page.key_space_complete==='boolean')merged.key_space_complete=!Object.hasOwn(merged,'only')&&merged.skipped===0&&merged.scope?.complete!==false&&Object.keys(merged.keys).length===merged.total_keys;
   else delete merged.key_space_complete;
  }
  if(next!==null&&(!next.startsWith('knowledge:')||next.split(':',3).join(':')!==id.split(':',3).join(':')))return fail('知识视图续读跳出了原视图；从首页重新绑定');
  merged.next=next;
  if(canonicalBytes(merged).byteLength>MAX_BINDING_BYTES)return fail('本次知识视图绑定超过 16 MiB；请按条目所需取值收窄范围');
 }
 if(first===null)return fail('知识视图没有首页');
 if(visited.size===1)return first;
 merged.truncated=false;
 const schema=merged.schema==='index-view@1'?IndexView:merged.schema==='facet-view@1'?FacetView:ImpactView;
 if(!schema.safeParse(merged).success)return fail('完整知识视图超过单份绑定的结构上限；请按条目所需取值收窄范围');
 const origin={generated:{generator:COMPONENTS.views,inputs}};
 const derivedCoverage=await records.artifacts.prepareDerived({origin,author:{user:null},derivedSources:inputs.map(v=>v.slice(4))});
 const artifact=await records.artifacts.ingest({bytes:canonicalBytes(merged),mediaType:'application/json',origin,derivedCoverage,author:{user:null},provenanceType:'projected',visibility:{readers:[context.principal.id],admins:true,packs:[],shareable:false},name:'complete-knowledge-view.json'});
 if(artifact.body.read_tier!=='model_readable')return fail('完整知识视图有未受理的凭据命中；请管理员核对后重试');
 const now=new Date().toISOString();
 const manifest=await records.store.put({kind:'action',schema:SCHEMAS.action,provenance:'observed',body:{action:ACTION.generate,run:context.run,item:null,inputs,component:COMPONENTS.views,lease:null,started_at:now,ended_at:now,result:'completed',error_code:null,acceptance:null,codes:[],detail:{external:id,revision:first.revision,artifact:artifact.digest,pages:visited.size}}});
 return {...first,manifest:manifest.digest,artifacts:[{name:'original',artifact},...first.artifacts.filter(v=>v.name!=='original'&&v.name!=='content')]};
}

// Run bindings consume an entire immutable view, never interpret a partial page as a closed scope.
import {ImpactView,FacetView,IndexView} from '../../contracts/src/views.ts';
import type {ExternalRead,ExternalReadContext,ExternalReaderPort,InputError} from '../ports.ts';
import {canonicalBytes,canonicalize,type Artifacts,type RecordStore} from '../records/api.ts';
import {parseViewId,splitRevision} from './views.ts';
import {ACTION,COMPONENTS,SCHEMAS} from './store.ts';

const MAX_BINDING_BYTES=16*1024*1024;
/** Narrowing helps only when a binding is too large; a broken page sequence is the view's own fault and the admin's to repair. */
const NARROW_FIX='索引用 only= 列出本次条目需要的取值，并用 fields= 收窄字段；影响视图用 attached_fields= 收窄后重新开运行';
const ADMIN_FIX='这是视图本身的问题，改你的输入解决不了：请管理员按错误说明修复视图后，你再重新开运行';
const REBIND_FIX='重新开运行，从首页重新绑定这个视图';
const VIEW_ID_FIX='照该输入槽说明里的写法逐字填视图标识：knowledge:<视图>:<产品>:<构建>?<参数>=<取值>；错误里点名的参数按说明写，取值不要留空或自己编；改好后重新开始运行';
/**
 * `unknownEntries:'disclose'` is the input slot's opt-in (WorkflowInput.unknown_entries): a facet or index view whose last page is
 * truncated only because some entries are unknown (`unknown_only`, with `unknown_entries` above zero) is bound as it is,
 * still `truncated` and carrying the count, for a pack that says the unknown entries out loud. Without the opt-in, and for
 * any other truncation (rows cut, credential hits), a truncated last page is refused.
 */
/**
 * Why a view whose last page is still truncated is refused, as a claim (D05 R[8]): which truncation it is, the view pages it
 * rests on, the view's own notes as the missing fact and a fix for that cause. Narrowing with only= or fields= cannot remove
 * unknown entries, so their fix says what can: what the notes name, or a slot that declares it takes unknown entries.
 */
function truncatedRefusal(page:{unknown_only?:boolean;unknown_entries?:number},notes:string[],grounds:string[],delivered:number,disclosing:boolean):[string,string,Omit<InputError,'message'|'fix'|'code'>]{
 const said=notes.length?`视图说明：${notes.join('；')}`:'视图没有给出说明';
 const unknown=page.unknown_only===true&&(page.unknown_entries??0)>0?page.unknown_entries!:0;
 const claim={grounds:grounds.slice(0,20),provenance:'projected' as const,coverage:{complete:false,examined:delivered,note:unknown>0?`另有 ${unknown} 个条目取值未知`:'最后一页仍被截断'}};
 if(unknown>0&&!disclosing)return [`知识视图仍有未交付的内容，不能作为完整绑定：只因 ${unknown} 个条目取值未知而截断，这个输入槽不接受带未知条目的视图`,'收窄 only= 或 fields= 去不掉这些未知条目：照视图说明补齐它们后再重新开运行（说明里写了谁来补、怎么补），或改用声明接受未知条目的任务包',{...claim,missing:`${unknown} 个条目的取值；${said}`}];
 return ['知识视图仍有未交付的内容，不能作为完整绑定：最后一页被截断，不只是因为条目取值未知（还有条目没有交付）',`${NARROW_FIX}；视图说明里点名的来源或凭据问题要管理员处理`,{...claim,missing:`没有交付的条目；${said}`}];
}

export async function completeKnowledgeView(id:string,context:ExternalReadContext,external:ExternalReaderPort,records:{artifacts:Artifacts;store:RecordStore},options:{unknownEntries?:'disclose'}={}):Promise<ExternalRead>{
 const fail=(message:string,fix:string,claim:Omit<InputError,'message'|'fix'|'code'>={}):ExternalRead=>({ok:false,id,reason:message,inputError:{message,fix,...claim}});
 const parsed=parseViewId(id);let beginning=id;
 if(parsed.ok&&parsed.value.type!=='links'){
  const {body,revision}=splitRevision(id),at=body.indexOf('?');
  if(at>=0){const query=body.slice(at+1).split('&').filter(pair=>!pair.startsWith('after='));beginning=body.slice(0,at)+(query.length?'?'+query.join('&'):'')+(revision?'@'+revision:'');}
 }
 const delivered=new Set<string>();
 const placements=new Set<string>();
 let first:Extract<ExternalRead,{ok:true}>|null=null,merged:any=null,next:string|null=beginning,disclosed=0,narrowedFlags=0;
 const visited=new Set<string>(),inputs:string[]=[];
 while(next!==null){
  if(visited.has(next))return fail('知识视图续读没有前进；请管理员修复页游标后重试',ADMIN_FIX);visited.add(next);
  const read=await external.read(next,context);
  // An id the knowledge grammar refuses is the caller's own mistake, and its reason comes from that id alone: name it rather than
  // answer the bare "unavailable" kept for what the caller may not see. Only when the reader refused it too (stub readers know ids
  // the grammar does not).
  if(!read.ok)return !parsed.ok&&next===beginning&&read.inputError===undefined&&read.retry===undefined?{...read,inputError:{message:`知识视图标识写错了：${parsed.reason}`,fix:VIEW_ID_FIX}}:read;
  first??=read;
  if(read.revision!==first.revision)return fail('知识视图续读时修订改变；请从首页重新绑定',REBIND_FIX);
  const chosen=read.artifacts.find(v=>v.name==='content')??read.artifacts.find(v=>v.name==='original');
  if(!chosen)return fail('知识视图页没有内容原件',ADMIN_FIX);
  const source=await records.artifacts.source(context.principal,chosen.artifact.body.sha256,{consumer:'function',record:chosen.artifact.digest});
  if(!source?.bytes)return fail('知识视图页当前不可读；请管理员核对读取档位后重试',ADMIN_FIX);
  let page:any;
  try{const raw=JSON.parse(Buffer.from(source.bytes).toString('utf8'));const schema=raw.schema==='index-view@1'?IndexView:raw.schema==='facet-view@1'?FacetView:raw.schema==='impact-view@1'?ImpactView:null;
   if(!schema)return read;page=schema.parse(raw);
  }catch{return fail('知识视图页不符合公开结构；请管理员修复视图后重试',ADMIN_FIX);}
  if(page.schema==='index-view@1'&&typeof page.only_complete==='boolean')narrowedFlags++;
  const pageKeys:string[]=page.schema==='index-view@1'?Object.entries(page.keys).flatMap(([key,values])=>(values as string[]).map(value=>canonicalize([key,value]))):page.schema==='facet-view@1'?page.rows.map((row:any)=>canonicalize(row.values)):[...page.changes.map((change:any)=>'path:'+change.path),...Object.entries(page.entries).filter(([,entry])=>(entry as any).build===null).map(([digest])=>'unversioned:'+digest)];
  if(page.next&&pageKeys.length===0)return fail('知识视图给出了空的续读页，无法推进；请管理员修复分页后重试',ADMIN_FIX);
  for(const key of pageKeys){if(delivered.has(key))return fail('知识视图续读重复交付同一项；请管理员修复游标后重试',ADMIN_FIX);delivered.add(key);}
  if(page.schema==='impact-view@1')for(const placement of page.placements){if(placements.has(placement.path))return fail('知识视图续读重复交付同一节点的附着条目；请管理员修复游标后重试',ADMIN_FIX);placements.add(placement.path);}
  inputs.push(`src:${source.sha256}`);
  if(merged===null)merged=page;
  else{
   const scope=(v:any)=>JSON.stringify({schema:v.schema,product:v.product,build:v.build,from:v.from,to:v.to,kind:v.kind,key:v.key,by:v.by,fields:v.fields,only:v.only,changed:v.changed_kinds,attached:v.attached_kinds,attached_fields:v.attached_fields,catalog:v.catalog,skipped:v.skipped,total:v.total,total_keys:v.total_keys,total_entries:v.total_entries,totals:v.totals,unversioned:v.unversioned,scope:v.scope});
   if(scope(merged)!==scope(page))return fail('知识视图续读的查询范围或计数改变；从首页重新绑定',REBIND_FIX);
   if(page.schema==='index-view@1'){
    for(const [key,values] of Object.entries(page.keys))merged.keys[key]=[...new Set([...(merged.keys[key]??[]),...(values as string[])])].sort();
    for(const [digest,entry] of Object.entries(page.entries)){if(merged.entries[digest]&&canonicalize(merged.entries[digest])!==canonicalize(entry))return fail('知识视图续读改变了同一条目的内容；从首页重新绑定',REBIND_FIX);}
    Object.assign(merged.entries,page.entries);
   }else if(page.schema==='facet-view@1')merged.rows.push(...page.rows);
   else{merged.changes.push(...page.changes);merged.placements.push(...page.placements);Object.assign(merged.entries,page.entries);}
   merged.notes=[...new Set([...merged.notes,...page.notes])];
  }
  next=page.next??null;
  if(next===null&&page.truncated){
   // Only the unknown-entries truncation of a slot that opted in is bound; every other truncation stays refused.
   if(options.unknownEntries!=='disclose'||page.unknown_only!==true||!(page.unknown_entries>0))return fail(...truncatedRefusal(page,[...new Set([...(merged.notes??[]),...(page.notes??[])])],inputs,delivered.size,options.unknownEntries==='disclose'));
   disclosed=page.unknown_entries;
  }
  if(next===null&&page.schema==='index-view@1'&&merged.kind==='case'&&visited.size>1){
   // A page's flag describes only that page. Once the frozen sequence is exhausted, its final
   // flag also establishes that the producer knew how to report missing indexed facts; legacy
   // pages without it cannot be upgraded merely because their old truncated flag was false.
   if(typeof page.key_space_complete==='boolean')merged.key_space_complete=!Object.hasOwn(merged,'only')&&merged.skipped===0&&merged.scope?.complete!==false&&Object.keys(merged.keys).length===merged.total_keys;
   else delete merged.key_space_complete;
   // A narrowed view's last-page flag covers only that page. Every page carried the structural flag, and the bound sequence
   // is complete: all reported keys are listed, no source was skipped, the scope is complete and no unknown entry was disclosed.
   if(narrowedFlags===visited.size)merged.only_complete=Object.hasOwn(merged,'only')&&merged.skipped===0&&merged.scope?.complete!==false&&Object.keys(merged.keys).length===merged.total_keys&&disclosed===0;
   else delete merged.only_complete;
  }
  if(next!==null&&(!next.startsWith('knowledge:')||next.split(':',3).join(':')!==id.split(':',3).join(':')))return fail('知识视图续读跳出了原视图；从首页重新绑定',REBIND_FIX);
  merged.next=next;
  if(canonicalBytes(merged).byteLength>MAX_BINDING_BYTES)return fail('本次知识视图绑定超过 16 MiB；请按条目所需取值收窄范围',NARROW_FIX);
 }
 if(first===null)return fail('知识视图没有首页',ADMIN_FIX);
 if(visited.size===1)return first;
 // The earlier pages' own flags are spent: what is left of the sequence is the last page's unknown entries, if any.
 merged.truncated=disclosed>0;
 if(disclosed>0){merged.unknown_entries=disclosed;merged.unknown_only=true;}else{delete merged.unknown_entries;delete merged.unknown_only;}
 const schema=merged.schema==='index-view@1'?IndexView:merged.schema==='facet-view@1'?FacetView:ImpactView;
 if(!schema.safeParse(merged).success)return fail('完整知识视图超过单份绑定的结构上限；请按条目所需取值收窄范围',NARROW_FIX);
 const origin={generated:{generator:COMPONENTS.views,inputs}};
 const derivedCoverage=await records.artifacts.prepareDerived({origin,author:{user:null},derivedSources:inputs.map(v=>v.slice(4))});
 const artifact=await records.artifacts.ingest({bytes:canonicalBytes(merged),mediaType:'application/json',origin,derivedCoverage,author:{user:null},provenanceType:'projected',visibility:{readers:[context.principal.id],admins:true,packs:[],shareable:false},name:'complete-knowledge-view.json'});
 if(artifact.body.read_tier!=='model_readable')return fail('完整知识视图有未受理的凭据命中；请管理员核对后重试','凭据命中要管理员核看、受理后才能绑定；改你的输入解决不了，管理员处理后你再重新开运行');
 const now=new Date().toISOString();
 const manifest=await records.store.put({kind:'action',schema:SCHEMAS.action,provenance:'observed',body:{action:ACTION.generate,run:context.run,item:null,inputs,component:COMPONENTS.views,lease:null,started_at:now,ended_at:now,result:'completed',error_code:null,acceptance:null,codes:[],detail:{external:id,revision:first.revision,artifact:artifact.digest,pages:visited.size}}});
 return {...first,manifest:manifest.digest,artifacts:[{name:'original',artifact},...first.artifacts.filter(v=>v.name!=='original'&&v.name!=='content')]};
}

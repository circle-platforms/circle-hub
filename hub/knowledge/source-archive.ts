// Read-only archive projections and exact quote locations. No read initializes or registers an archive.
import {z} from 'zod';
import {SpaceId,SpaceSourceBody} from '../../contracts/src/spaces.ts';
import {isKnowledgeSearchScope,type KnowledgeSearchScope,type SourceLocationStatus} from '../../contracts/generated/vocabulary.ts';
import {canonicalize,isSha256,sha256Hex,type Principal,type SourceArtifactBody} from '../records/api.ts';
import {parseReference,pathOf,pathSegments,quoteLocations,resolveReference} from '../refs/api.ts';
import type {KnowledgeContext} from './context.ts';
import type {KnowledgeSpaces} from './spaces.ts';
import {KnowledgeError} from './errors.ts';
function unavailable():never{throw new KnowledgeError('该内容不存在或无权查看',{code:'SOURCE_UNAVAILABLE'});}
function badPage():never{throw new KnowledgeError('列表已变化，请返回原文列表重新打开',{code:'SPACE_VERSION_CONFLICT'});}
export interface ArchiveQuery {scope?:KnowledgeSearchScope;space?:string;path?:string;root?:string;source?:string;cursor?:string;limit?:number}
export interface ArchiveRow {record:string;root:string;body:z.infer<typeof SpaceSourceBody>;metadata:SourceArtifactBody}
export async function archiveSources(spaces:KnowledgeSpaces,ctx:KnowledgeContext,by:Principal,query:ArchiveQuery={}){
 const account=await ctx.records.principals.get(by.id);if(!account||account.disabled)unavailable();by=account;
 const scope=query.scope??'all',path=query.path===undefined?undefined:pathOf(pathSegments(query.path)),limit=query.limit??30;
 if(!isKnowledgeSearchScope(scope)||!Number.isSafeInteger(limit)||limit<1||limit>50)badPage();
 if(query.space&&!SpaceId.safeParse(query.space).success)unavailable();
 const visible=await spaces.visible(by,scope,undefined,{initialize:false});
 let snapshots=visible.filter(item=>!query.space||item.space===query.space);
 if(query.root){
  if(!query.space||!snapshots.length)unavailable();const version=await spaces.version(query.root);if(!version||version.body.space!==query.space)unavailable();
  snapshots=snapshots.map(item=>({...item,version}));
 }
 const binding=sha256Hex(canonicalize({by:by.id,scope,space:query.space??null,path:path??null,roots:snapshots.map(item=>[item.space,item.version.root,item.paths])}));
 let offset=0;
 if(query.cursor){try{const page=JSON.parse(Buffer.from(query.cursor,'base64url').toString());if(page.binding!==binding||!Number.isSafeInteger(page.offset)||page.offset<0)badPage();offset=page.offset;}catch{badPage();}}
 const rows:Array<{record:string;root:string;body:z.infer<typeof SpaceSourceBody>}>=[];
 for(const snapshot of snapshots){
  const records=await ctx.records.store.getMany(snapshot.version.body.sources);
  for(const record of records.values()){
   if(record.kind!=='knowledge_space_source')continue;const parsed=SpaceSourceBody.safeParse(record.body);if(!parsed.success)continue;const body=parsed.data;
   if(body.space!==snapshot.space||path!==undefined&&body.path!==path||!snapshot.paths.some(parent=>parent==='/'||body.path===parent||body.path.startsWith(parent+'/')))continue;
   if(!await spaces.mayReadSource(by,body.sha256,undefined,'model',body.artifact))continue;
   rows.push({record:record.digest,root:snapshot.version.root,body});
  }
 }
 rows.sort((a,b)=>b.body.at.localeCompare(a.body.at)||a.record.localeCompare(b.record));
 if(query.source&&!query.cursor){const index=rows.findIndex(row=>row.record===query.source);if(index<0)unavailable();offset=Math.floor(index/limit)*limit;}
 const items:ArchiveRow[]=[];
 for(const row of rows.slice(offset,offset+limit)){
  const artifact=await ctx.records.store.get<SourceArtifactBody>(row.body.artifact);
  if(artifact?.kind!=='source_artifact'||artifact.schema!=='source_artifact@1'||artifact.body.sha256!==row.body.sha256)continue;
  // Permission may have changed while fetching metadata. Only authorized rows contribute to the answer.
  if(await spaces.mayRead(by,row.body.space,row.body.path)&&await spaces.mayReadSource(by,row.body.sha256,undefined,'model',row.body.artifact))items.push({...row,metadata:artifact.body});
 }
 const latest=(await spaces.visible(by,scope,undefined,{initialize:false})).filter(item=>!query.space||item.space===query.space);
 const currentBinding=sha256Hex(canonicalize({by:by.id,scope,space:query.space??null,path:path??null,roots:latest.map(item=>[item.space,query.root??item.version.root,item.paths])}));
 if(binding!==currentBinding)badPage();
 for(const row of rows)if(!await spaces.mayRead(by,row.body.space,row.body.path)||!await spaces.mayReadSource(by,row.body.sha256,undefined,'model',row.body.artifact))badPage();
 const next=offset+limit<rows.length?Buffer.from(JSON.stringify({binding,offset:offset+limit})).toString('base64url'):null;
 const counts={all:rows.length,personal:0,shared:0,team:0};for(const row of rows)counts[row.body.space===by.id?'personal':row.body.space==='team'?'team':'shared']++;
 return {items,next,total:rows.length,counts};
}
export interface OriginalQuery {sha256:string;artifact:string;root?:string;path?:string;entry?:string;ground?:number;match?:number;matchesOffset?:number;offset?:number;whole?:boolean}
export const ORIGINAL_PAGE_BYTES=16*1024;
/** A bounded UTF-8 view of decoded text; these are presentation bytes, never claimed as raw-file coordinates. */
export function originalWindow(text:string,offset=0,highlight?:{from:number;to:number}){
 const bytes=Buffer.from(text);if(!Number.isSafeInteger(offset)||offset<0||offset>bytes.length)badPage();
 const boundaries=[0];for(let start=0;start<bytes.length;){let end=Math.min(bytes.length,start+ORIGINAL_PAGE_BYTES);while(end>start&&end<bytes.length&&(bytes[end]&0xc0)===0x80)end--;boundaries.push(end);start=end;}
 const wanted=highlight?.from??offset;let page=0;while(page+1<boundaries.length-1&&boundaries[page+1]<=wanted)page++;
 const pageOffset=boundaries[page];offset=pageOffset;let end=boundaries[page+1]??0;
 if(highlight){
  const before=bytes.subarray(offset,highlight.from).toString('utf8');let at=before.length;
  for(let n=0;n<3;n++){const line=before.lastIndexOf('\n',at-1);if(line<0){at=0;break;}at=line;}
  offset=Math.max(offset+Buffer.byteLength(before.slice(0,at)),highlight.from-256);while(offset<bytes.length&&(bytes[offset]&0xc0)===0x80)offset++;
  const after=bytes.subarray(highlight.to,Math.min(bytes.length,highlight.to+256)).toString('utf8');let to=0;
  for(let n=0;n<3;n++){const line=after.indexOf('\n',to);if(line<0){to=after.length;break;}to=line+1;}
  end=Math.min(bytes.length,offset+ORIGINAL_PAGE_BYTES,highlight.to+Buffer.byteLength(after.slice(0,to)));while(end>offset&&end<bytes.length&&(bytes[end]&0xc0)===0x80)end--;
 }
 const part=bytes.subarray(offset,end).toString('utf8');
 const overlap=highlight&&highlight.from<end&&highlight.to>offset?{from:Math.max(offset,highlight.from)-offset,to:Math.min(end,highlight.to)-offset}:null;
 return {text:part,offset,end,total:bytes.length,page,pageOffset,excerpt:offset!==pageOffset||end!==(boundaries[page+1]??0),pages:Math.max(1,boundaries.length-1),previous:page?boundaries[page-1]:null,next:end<bytes.length?end:null,highlight:overlap};
}
export async function readOriginal(spaces:KnowledgeSpaces,ctx:KnowledgeContext,by:Principal,query:OriginalQuery){
 if(!isSha256(query.sha256)||!isSha256(query.artifact))unavailable();
 const account=await ctx.records.principals.get(by.id);if(!account||account.disabled)unavailable();by=account;
 const source=await spaces.source(by,query.sha256,undefined,'model',query.artifact);if(!source)unavailable();
 let reference='src:'+query.sha256,quotation:string|undefined,team=false;
 const hasContext=query.root!==undefined||query.entry!==undefined||query.ground!==undefined;
 if(hasContext){
  if(!query.root||!query.entry||query.path===undefined||!Number.isSafeInteger(query.ground)||query.ground!<0)unavailable();
  const entry=await spaces.entry(by,query.root,query.path,query.entry);if(!entry)unavailable();
  const ground=entry.body.grounds[query.ground!];if(!ground)unavailable();const ref=parseReference(ground.reference);if(ref.scheme!=='src'||ref.sha256!==query.sha256)unavailable();
  reference=ground.reference;quotation=ground.quotation;team=entry.body.space==='team';
  if(team&&entry.body.source_attributions?.length){const facts=await spaces.entryAttributions(by,query.root,query.path,query.entry);const expected=facts.filter(row=>row.sha256===query.sha256);if(expected.length&&!expected.some(row=>row.artifact===query.artifact))unavailable();}
 }
 const result=await resolveReference(reference,{reader:{user:by.id,role:by.role},teamParsersOnly:team,parsers:ctx.parsers,sources:{read:hash=>spaces.source(by,hash,undefined,'model',query.artifact)}});
 // Re-read after any parser sandbox wait before disclosing a fragment, match count or even a selector's existence.
 const current=await spaces.source(by,query.sha256,undefined,'model',query.artifact);if(!current)unavailable();
 if(hasContext&&!await spaces.entry(by,query.root!,query.path!,query.entry!))unavailable();
 const text=current.bytes&&result.resolved&&result.readable?result.text:null;
 let status:SourceLocationStatus|null=null,matches:ReturnType<typeof quoteLocations>|null=null,selected:ReturnType<typeof quoteLocations>['matches'][number]|undefined;
 const matchesOffset=query.match!==undefined?Math.floor(query.match/32)*32:query.matchesOffset??0;
 if(!Number.isSafeInteger(matchesOffset)||matchesOffset<0||query.match!==undefined&&(!Number.isSafeInteger(query.match)||query.match<0))badPage();
 if(quotation!==undefined){
  matches=text===null?{total:0,matches:[]}:quoteLocations(text,quotation,matchesOffset);
  if(matchesOffset>0&&matchesOffset>=matches.total)badPage();
  status=matches.total===0?'unresolved':matches.total===1?'resolved':'ambiguous';
  selected=query.whole?undefined:matches.matches.find(match=>match.ordinal===(query.match??(matches!.total===1?0:-1)));
  if(query.match!==undefined&&!query.whole&&!selected)badPage();
 }
 return {source:current,reference,quotation,status,matches,matchesOffset,selected,parsed:parseReference(reference).scheme==='src'&&(parseReference(reference)as{parser?:string}).parser!==undefined,window:text===null?null:originalWindow(text,query.offset??0,selected)};
}

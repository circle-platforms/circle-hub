// A knowledge-index input may declare index_default. The Hub then fills a missing only= and fields= before the view is
// bound, so a run does not load every case entry and does not ask a person for the identifiers. build_defects reads the
// keys of this build's defect index (fixed-bug entries and the release page). input_ids reads identifiers already
// written on another slot. A caller-supplied only or fields is left as written.
import {IndexView} from '../../../contracts/src/views.ts';
import type {InputBinding} from '../../../contracts/src/run.ts';
import type {WorkflowInput} from '../../../contracts/src/pack.ts';
import {MAX_REFERENCE_LENGTH} from '../../../contracts/src/reference.ts';
import {completeKnowledgeView} from '../../knowledge/complete-view.ts';
import {compareText} from '../../knowledge/digest.ts';
import {ACTION,COMPONENTS,SCHEMAS} from '../../knowledge/store.ts';
import {MAX_ONLY_VALUES,parseViewId,splitRevision} from '../../knowledge/views.ts';
import type {ExternalRead,ExternalReadContext,ExternalReaderPort} from '../../ports.ts';
import {canonicalBytes,canonicalize,type Artifacts,type RecordStore} from '../../records/api.ts';

const BINDING_CAP = 16 * 1024 * 1024;
type Records = {artifacts:Artifacts;store:RecordStore};
export type IndexKeys = {ok:true;keys:string[]} | {ok:false;message:string;fix:string};
export type NarrowedIndex = {ok:true;ids:string[];label:string} | {ok:false;message:string;fix:string};

const isRecord = (value:unknown):value is Record<string,unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Digit identities compare without leading zeros; every other identifier is already exact. Both spellings are requested. */
function spellings(id:string):string[] {
  if(!/^[0-9]+$/.test(id))return [id];
  const bare = id.replace(/^0+/,'') || '0';
  return bare === id ? [id] : [id, bare];
}

export function appendQuery(id:string,name:string,value:string):string {
  const {body,revision} = splitRevision(id);
  const next = body.includes('?') ? `${body}&${name}=${value}` : `${body}?${name}=${value}`;
  return revision === null ? next : `${next}@${revision}`;
}

/** Splits index values into only= lists that each fit the external-id length and the index parser's value cap. */
export function chunkOnly(id:string,values:readonly string[]):string[] {
  const {body,revision} = splitRevision(id);
  const suffix = revision === null ? '' : `@${revision}`;
  const budget = MAX_REFERENCE_LENGTH - suffix.length;
  const joiner = body.includes('?') ? '&' : '?';
  const lengthOf = (items:readonly string[]):number => `${body}${joiner}only=${items.map(encodeURIComponent).join(',')}`.length;
  const chunks:string[][] = [];
  let current:string[] = [];
  for(const value of values){
    const next = [...current,value];
    if(current.length > 0 && (current.length >= MAX_ONLY_VALUES || lengthOf(next) > budget)){chunks.push(current);current = [value];}
    else current = next;
  }
  if(current.length > 0)chunks.push(current);
  return chunks.map(items => appendQuery(id,'only',items.map(encodeURIComponent).join(',')));
}

function identifiersOf(inputs:Record<string,InputBinding|InputBinding[]>,slot:string):{ok:true;values:string[]} | {ok:false;message:string;fix:string} {
  const given = inputs[slot];
  const list = given === undefined ? [] : Array.isArray(given) ? given : [given];
  const values:string[] = [];
  for(const binding of list){
    if(!('external' in binding))continue;
    const {body} = splitRevision(binding.external);
    const tail = body.split(':').slice(2).join(':');
    if(tail === '')continue;
    for(const part of tail.split('+')){
      try{const value = decodeURIComponent(part);if(value !== '')values.push(value);}
      catch{return {ok:false,message:`输入槽 ${slot} 的外部标识转义无效`,fix:'更正该外部标识后重新开始；不要另向用户索取编号'};}
    }
  }
  return {ok:true,values};
}

export async function narrowIndexId(slot:WorkflowInput,id:string,inputs:Record<string,InputBinding|InputBinding[]>,load:(id:string)=>Promise<IndexKeys>):Promise<NarrowedIndex> {
  const declared = slot.index_default;
  const parsed = parseViewId(id);
  if(declared === undefined || !parsed.ok || parsed.value.type !== 'index')return {ok:true,ids:[id],label:id};
  const needFields = parsed.value.fields === null;
  const needOnly = parsed.value.only === null;
  if(!needFields && !needOnly)return {ok:true,ids:[id],label:id};
  const fields = [...declared.fields].sort(compareText).join(',');
  const base = needFields ? appendQuery(id,'fields',fields) : id;
  if(!needOnly)return {ok:true,ids:[base],label:base};
  let raw:string[];
  if(declared.only_from.source === 'build_defects'){
    const defectId = appendQuery(`knowledge:index:${encodeURIComponent(parsed.value.product)}:${encodeURIComponent(parsed.value.build)}?kind=defect&key=bug`,'fields','bug');
    const pinned = parsed.value.revision === null ? defectId : `${defectId}@${parsed.value.revision}`;
    const loaded = await load(pinned);
    if(!loaded.ok)return loaded;
    raw = loaded.keys;
    if(raw.length === 0)return {ok:false,message:'该构建的缺陷索引没有编号',fix:'先生产该构建的修复清单（fixed-bugs 缺陷条目或发布页）再开始；不要向用户索取编号'};
  }else{
    const found = identifiersOf(inputs,declared.only_from.slot);
    if(!found.ok)return found;
    raw = found.values;
    if(raw.length === 0)return {ok:true,ids:[base],label:base};
  }
  const values = [...new Set(raw.flatMap(spellings))].sort(compareText);
  const ids = chunkOnly(base,values);
  if(ids.some(item => item.length > MAX_REFERENCE_LENGTH))return {ok:false,message:'编号写不进一条知识视图标识',fix:'请维护人提高外部标识长度上限后重试；不要向用户索取编号'};
  return {ok:true,ids,label:base};
}

async function modelOf(read:Extract<ExternalRead,{ok:true}>,context:ExternalReadContext,artifacts:Artifacts):Promise<unknown> {
  const chosen = read.artifacts.find(item => item.name === 'content') ?? read.artifacts.find(item => item.name === 'original');
  if(chosen === undefined)return null;
  const source = await artifacts.source(context.principal,chosen.artifact.body.sha256,{consumer:'function',record:chosen.artifact.digest});
  if(!source?.bytes)return null;
  try{return JSON.parse(new TextDecoder().decode(source.bytes));}
  catch{return null;}
}

export async function defectIndexKeys(id:string,context:ExternalReadContext,external:ExternalReaderPort,records:Records):Promise<IndexKeys> {
  const read = await completeKnowledgeView(id,context,external,records);
  if(!read.ok)return {ok:false,message:read.inputError?.message ?? `缺陷索引不可读：${read.reason}`,fix:read.inputError?.fix ?? '重新生成该构建的缺陷索引后再开始；不要向用户索取编号'};
  const model = await modelOf(read,context,records.artifacts);
  if(!isRecord(model) || model.schema !== 'index-view@1' || !isRecord(model.keys))return {ok:false,message:'缺陷索引不是 index-view@1',fix:'重新读取 kind=defect、key=bug、fields=bug 的索引；不要向用户索取编号'};
  return {ok:true,keys:Object.keys(model.keys)};
}

function fail(id:string,message:string,fix:string):ExternalRead {
  return {ok:false,id,reason:message,inputError:{message,fix}};
}

/** Reads each only= slice and stores one index view. One slice is the caller's job. */
export async function mergeIndexBindings(ids:readonly string[],label:string,context:ExternalReadContext,external:ExternalReaderPort,records:Records):Promise<ExternalRead> {
  let first:Extract<ExternalRead,{ok:true}> | null = null;
  const pages:Record<string,unknown>[] = [];
  const sources:string[] = [];
  for(const id of ids){
    const read = await completeKnowledgeView(id,context,external,records);
    if(!read.ok)return read;
    if(first === null)first = read;
    else if(read.revision !== first.revision)return fail(label,'知识视图分段读取时修订改变；从首页重新绑定','重新开始这次运行');
    const model = await modelOf(read,context,records.artifacts);
    if(!isRecord(model) || model.schema !== 'index-view@1')return fail(label,'知识视图分段结果不是索引','重新开始这次运行');
    pages.push(model);
    const chosen = read.artifacts.find(item => item.name === 'content') ?? read.artifacts.find(item => item.name === 'original');
    if(chosen)sources.push(`src:${chosen.artifact.body.sha256}`);
  }
  if(first === null || pages.length === 0)return fail(label,'知识视图没有首页','重新开始这次运行');
  const merged:Record<string,unknown> = {...pages[0],keys:{},entries:{},only:[],cut_keys:[],notes:[],next:null,truncated:false};
  const notes = new Set<string>();
  const cut = new Set<string>();
  const only = new Set<string>();
  for(const page of pages){
    if(page.truncated === true)merged.truncated = true;
    for(const note of Array.isArray(page.notes) ? page.notes : [])if(typeof note === 'string')notes.add(note);
    for(const key of Array.isArray(page.cut_keys) ? page.cut_keys : [])if(typeof key === 'string')cut.add(key);
    for(const value of Array.isArray(page.only) ? page.only : [])if(typeof value === 'string')only.add(value);
    if(isRecord(page.keys))for(const [key,values] of Object.entries(page.keys)){
      const prior = Array.isArray((merged.keys as Record<string,unknown>)[key]) ? (merged.keys as Record<string,string[]>)[key] : [];
      (merged.keys as Record<string,string[]>)[key] = [...new Set([...prior,...(Array.isArray(values) ? values.filter((item):item is string => typeof item === 'string') : [])])].sort(compareText);
    }
    if(isRecord(page.entries))for(const [digest,entry] of Object.entries(page.entries)){
      const held = (merged.entries as Record<string,unknown>)[digest];
      if(held !== undefined && canonicalize(held) !== canonicalize(entry))return fail(label,'知识视图分段改变了同一条目的内容；从首页重新绑定','重新开始这次运行');
      (merged.entries as Record<string,unknown>)[digest] = entry;
    }
  }
  notes.add(`only 超出单条标识长度，已按 ${ids.length} 段读取后合并`);
  merged.only = [...only].sort(compareText);
  merged.cut_keys = [...cut].sort(compareText);
  merged.notes = [...notes];
  merged.total_keys = Object.keys(merged.keys as object).length;
  const digests = new Set<string>();
  for(const list of Object.values(merged.keys as Record<string,string[]>))for(const digest of list)digests.add(digest);
  merged.total_entries = digests.size;
  if(canonicalBytes(merged).byteLength > BINDING_CAP)return fail(label,'本次知识视图绑定超过 16 MiB；请按条目所需取值收窄范围','索引用 only= 列出本次条目需要的取值，并用 fields= 收窄字段；影响视图用 attached_fields= 收窄后重新开运行');
  if(!IndexView.safeParse(merged).success)return fail(label,'完整知识视图超过单份绑定的结构上限；请按条目所需取值收窄范围','索引用 only= 列出本次条目需要的取值，并用 fields= 收窄字段后重新开运行');
  const origin = {generated:{generator:COMPONENTS.views,inputs:sources}};
  const derivedCoverage = await records.artifacts.prepareDerived({origin,author:{user:null},derivedSources:sources.map(item => item.slice(4))});
  const artifact = await records.artifacts.ingest({bytes:canonicalBytes(merged),mediaType:'application/json',origin,derivedCoverage,author:{user:null},provenanceType:'projected',visibility:{readers:[context.principal.id],admins:true,packs:[],shareable:false},name:'complete-knowledge-view.json'});
  if(artifact.body.read_tier !== 'model_readable')return fail(label,'完整知识视图有未受理的凭据命中；请管理员核对后重试','请管理员核对凭据扫描后重试');
  const now = new Date().toISOString();
  const manifest = await records.store.put({kind:'action',schema:SCHEMAS.action,provenance:'observed',body:{action:ACTION.generate,run:context.run,item:null,inputs:sources,component:COMPONENTS.views,lease:null,started_at:now,ended_at:now,result:'completed',error_code:null,acceptance:null,codes:[],detail:{external:label,revision:first.revision,artifact:artifact.digest,pages:ids.length}}});
  return {...first,id:label,manifest:manifest.digest,artifacts:[{name:'original',artifact},...first.artifacts.filter(item => item.name !== 'original' && item.name !== 'content')]};
}

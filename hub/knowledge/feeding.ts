import type {ProductHandle} from '../ports.ts';
import {CompositionView} from './composition.ts';
import {feedingFunctionCall,FeedingFunctionFailure,type FeedingErrorDetail} from './feeding-errors.ts';
import type {FeedingCut,KnowledgeStructureObject} from './feeding-types.ts';
export type {FeedingCut,FeedingReader,KnowledgeStructureObject} from './feeding-types.ts';
export {FEEDING_INDEX} from './feeding-types.ts';
export {RecordFeedingReader,boundLines} from './feeding-reader.ts';
import {ReadManifest} from '../../contracts/src/resources.ts';
import {Sha256} from '../../contracts/src/common.ts';
import {runById,canViewRun} from '../runs/api.ts';
import {pathSegments} from '../refs/api.ts';
// Append-only feeding beside immutable tree content. The record insertion sequence is the frozen horizon (gaps are valid).
import {Claim,type Claim as ClaimBody} from '../../contracts/src/claim.ts';
import {KnowledgeStructureSchema,FeedingRetractionSchema,type FeedingRetraction,type VersionBinding,type FeedingOffset} from '../../contracts/src/feeding.ts';
import type {FeedingQuote as QuoteEvidence} from '../../contracts/generated/shared-interfaces.ts';
import {parseReference,parserKey,parseDocument,quoteMatches,recognizeAsync,sliceUtf8} from '../refs/api.ts';
import {parseExternal} from '../connectors/api.ts';
import {canonicalize,sha256Hex,scanForCredentials,type Principal,type Transaction,type StoredRecord,type SourceArtifact} from '../records/api.ts';
import type {ActionResult,BindingStatus} from '../../contracts/generated/vocabulary.ts';
import {callPackFunction,callPackFunctionBatch} from '../rules/api.ts';
import {INDEX} from './store.ts';
import {operationSchema} from './declaration-grade.ts';
import {completeOperationDevice} from './feeding-leases.ts';
import {SeedlingBody} from '../../contracts/src/knowledge.ts';
import type {KnowledgeContext} from './context.ts';
import type {TreeReading} from './read.ts';
import {seedlingOfRoot,currentSeedling,seedlingRecord,seedlingName} from './seedling.ts';
import {KnowledgeError} from './errors.ts';
const PROJECTION='knowledge.feeding.projection';

interface LeaseBody { leases?: unknown; groups?: unknown; predecessor?: unknown }

function leaseRows(body: LeaseBody | null | undefined): Array<{ lease?: unknown; op?: unknown; keys?: unknown }> {
  return Array.isArray(body?.leases) ? body.leases.filter((row): row is { lease?: unknown; op?: unknown; keys?: unknown } => row !== null && typeof row === 'object') : [];
}

/** Installed builds of devices this run actually booked (`bed/<bed>/<device>`), read from its frozen manifest. */
export function bookedInstalls(body: LeaseBody | null | undefined): string[] {
  const group = Array.isArray(body?.groups) ? body.groups[0] : undefined;
  const beds = group !== null && typeof group === 'object' && 'manifest' in group && group.manifest !== null && typeof group.manifest === 'object' && 'beds' in group.manifest ? (group.manifest as { beds?: unknown }).beds : undefined;
  if (!Array.isArray(beds)) return [];
  const keys = leaseRows(body).flatMap(row => Array.isArray(row.keys) ? row.keys.filter((key): key is string => typeof key === 'string') : []);
  const out: string[] = [];
  for (const key of keys) {
    const parts = key.split('/');
    if (parts.length !== 3 || parts[0] !== 'bed') continue;
    const bed = beds.find(row => row !== null && typeof row === 'object' && (row as { name?: unknown }).name === parts[1]) as { devices?: unknown } | undefined;
    const devices = Array.isArray(bed?.devices) ? bed.devices : [];
    const device = devices.find(row => row !== null && typeof row === 'object' && (row as { name?: unknown }).name === parts[2]) as { installed?: { build?: unknown } } | undefined;
    if (typeof device?.installed?.build === 'string' && device.installed.build.length > 0) out.push(device.installed.build);
  }
  return out;
}

function bookedLease(body: LeaseBody | null | undefined): string | null {
  for (const row of leaseRows(body)) {
    if (typeof row.lease !== 'string' || !Array.isArray(row.keys)) continue;
    if (row.keys.some(key => typeof key === 'string' && key.startsWith('bed/') && key.split('/').length === 3)) return row.lease;
  }
  return null;
}

/** The acquire lease of this run, or of its predecessor booking, when that lease holds a bed device. */
export async function reproductionLease(store: Parameters<typeof runById>[0], runId: string): Promise<string | null> {
  const run = await runById(store, runId);
  const own = bookedLease(run?.body);
  if (own) return own;
  const predecessor = run?.body.predecessor;
  if (typeof predecessor !== 'string') return null;
  return bookedLease((await runById(store, predecessor))?.body);
}

export const FEEDING_BOUNDS={waitMs:250,concurrency:2,queued:32,callMs:5000,rows:1000} as const;
const FEEDING_CALL_MS=FEEDING_BOUNDS.callMs,MAX_FEEDING_ROWS=FEEDING_BOUNDS.rows;
interface FeedingJob {key:string;captureKey:string;pack:ProductHandle|null;principal:Principal;sha:string;scope:FeedingScope;state:'queued'|'running';done:Promise<FeedingReceipt>;resolve:(value:FeedingReceipt)=>void;announced:Promise<void>;}

const LOG='knowledge.feeding.log',OBJECT='knowledge.feeding.object',USAGE='knowledge.feeding.usage',BINDING='knowledge.feeding.binding',RETRACT='knowledge.feeding.retraction',TODO='knowledge.feeding.todo';
const object=(v:unknown):v is Record<string,any>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
interface SeedlingAttachment {locked_root:string;locked_composition:string|null;seedling_root:string;seedling_composition:string;line:string}
interface Projected {rows:Projection[];pack:string;digest:string;attachment:SeedlingAttachment|null}
const annotations=['classification','manual_link','relations','applicability','correction','command_link','case_link','paragraph'] as const;
// The most uploads of one uploader's equal bytes compared for an older note that does not name its upload record.
const NOTE_CANDIDATES=64;
export const operationRecord=(schema:unknown):schema is 'fed-observation@1'|'fed-procedure@1'|'fed-pitfall@1'=>operationSchema(schema);
/** Content identity of an operation record: its canonical statement, quotations, exact capture and declared target, nothing else. */
/**
 * The capture facts of a new note for an upload. A client that declared the capture time gives `at`; one that did not
 * leaves `at` out, and the note keeps the Hub's receipt time apart from it, as operation records do (round-four review,
 * item 5). An upload record without the declaration flag comes from before uploads could declare a capture time, when its
 * captured_at was always the Hub's own time: undeclared too (round five). A note already written is never rewritten.
 */
function noteCapture(artifact:SourceArtifact):Record<string,unknown>{
 return artifact.body.captured_at_declared===true?{at:artifact.body.captured_at,captured_at_declared:true,received_at:artifact.created_at}:{captured_at_declared:false,received_at:artifact.created_at};
}
export function operationIdentity(body:Record<string,unknown>):Record<string,unknown>{
  const capture=Object.fromEntries([['artifact',object(body.source)?body.source.artifact:undefined],['device',body.device],['bed',body.bed]].filter(([,value])=>value!==undefined));
  if(body.schema==='fed-observation@1')return {action:body.action,result:body.result,...capture};
  if(body.schema==='fed-procedure@1')return {goal:body.goal,steps:body.steps,...capture};
  if(body.schema==='fed-pitfall@1')return {phenomenon:body.phenomenon,suggestion:body.suggestion,quote:body.quote,...capture};
  throw new Error('not an operation record');
}
function operationQuotes(body:Record<string,any>):Array<Record<string,any>>{
  const out:Array<Record<string,any>>=[];
  const take=(quote:unknown)=>{if(object(quote)&&typeof quote.text==='string')out.push(quote);};
  if(body.schema==='fed-observation@1')take(body.result);
  if(body.schema==='fed-procedure@1')for(const step of body.steps??[])if(object(step))take(step.quote);
  if(body.schema==='fed-pitfall@1')take(body.quote);
  return out;
}
function fail(message:string):never{throw new KnowledgeError(message+'；修正原件或按生成结构修正整份提交后重交，不能猜测补值',{code:'SUBMISSION_SCHEMA_VIOLATION'});}
export interface FeedingScope {product?:string|null;root?:string|null;composition?:string|null;run?:string|null;line?:string|null;meta?:Record<string,unknown>|null;metaSource?:string;metaRecord?:string;readManifest?:string;sourceRecord?:string;requested?:string;declaredLine?:string|null;}
export interface FeedingReceipt {objects:string[];offset:number|null;pending:Array<{source:string;missing:string;next_action:string}>;}
export interface FeedingView {record:string;offset:number;body:Record<string,any>;claim:ClaimBody;validity:'valid'|'invalid';retractions:string[];}
function captureScope(scope:FeedingScope){return {product:scope.product??null,root:scope.root??null,composition:scope.composition??null,run:scope.run??null,line:scope.line??null,metaSource:scope.metaSource??null,metaRecord:scope.metaRecord??null,readManifest:scope.readManifest??null,sourceRecord:scope.sourceRecord??null,declaredLine:scope.declaredLine??null};}
interface Projection {body:Record<string,any>;identity:unknown;lines:string[];selector:string;grammar:string;conflict:boolean;missing?:Array<{missing:string;next_action:string}>;}
interface Source {artifact:SourceArtifact;bytes:Uint8Array;parser:string;model:unknown;external:ReturnType<typeof parseExternal>;}
export class FeedingLayer {
 readonly context:KnowledgeContext;readonly reading:TreeReading;
 private readonly jobs=new Map<string,FeedingJob>();
 private readonly queue:FeedingJob[]=[];
 private activeJobs=0;
 private readonly projecting=new Map<string,Promise<Projected>>();
 private readonly normalized=new Map<string,Promise<Map<string,string|null>>>();
 constructor(context:KnowledgeContext,reading:TreeReading){this.context=context;this.reading=reading;}
 async offset(tx?:Transaction):Promise<number>{const n=await this.context.records.store.watermark?.(tx);if(n===undefined)throw new KnowledgeError('缺记录追加序号能力；管理员恢复记录库后重试',{code:'SOURCE_UNAVAILABLE'});return n;}
 private async position(digest:string,tx?:Transaction){const n=await this.context.records.store.position?.(digest,tx);if(n===undefined||n===null)throw new KnowledgeError('缺记录追加序号能力；管理员恢复记录库后重试',{code:'SOURCE_UNAVAILABLE'});return n;}
 private async all(key:string,value:string,tx?:Transaction){return this.context.store.all<ClaimBody>({key,value,kind:'claim'},tx);}
 private body(record:StoredRecord<ClaimBody>):Record<string,any>|null{const claim=Claim.safeParse(record.body);if(!claim.success||!object(claim.data.statement.data))return null;return KnowledgeStructureSchema.safeParse(claim.data.statement.data.feeding??claim.data.statement.data).data as Record<string,any>??null;}
 private async manifestOrigin(principal:Principal,artifact:SourceArtifact,digest:string){
  const record=await this.context.records.store.get(digest);if(record?.kind!=='action'||record.schema!=='read-manifest@1'||record.provenance!=='observed')return null;
  const parsed=ReadManifest.safeParse(record.body);if(!parsed.success||parsed.data.result!=='completed'||parsed.data.error_code!==null||principal.role!=='admin'&&parsed.data.principal!==principal.id)return null;
  if(!parsed.data.artifacts.some(row=>row.record===artifact.digest&&row.sha256===artifact.body.sha256&&row.media_type===artifact.body.media_type))return null;
  return parseExternal(parsed.data.revision===null?parsed.data.external:parsed.data.external+'@'+parsed.data.revision);
 }
 private async origin(principal:Principal,artifact:SourceArtifact,manifest?:string,seen=new Set<string>()):Promise<ReturnType<typeof parseExternal>>{
  if(seen.has(artifact.digest)||seen.size>=32)fail('原件血缘成环或超界');seen.add(artifact.digest);const body=artifact.body;
  if(body.author.user!==null||body.provenance_type==='declared'||body.provenance_type==='candidate')return null;
  if(manifest){const external=await this.manifestOrigin(principal,artifact,manifest);if(!external)fail('缺少与本次原件记录相符、当前有权读取的读取清单；按本次实际读取重新绑定');return external;}
  if('read'in body.origin)return parseExternal(body.origin.read.object);
  if(!('generated'in body.origin))return null;
  const origins=new Map<string,NonNullable<ReturnType<typeof parseExternal>>>();
  // The index is by immutable capture record, not by bytes. Nested reads may have unrelated identities.
  for(const row of await this.context.store.all<unknown>({key:'connectors.artifact',value:artifact.digest,kind:'action'})){const external=await this.manifestOrigin(principal,artifact,row.digest);if(external)origins.set(canonicalize(external),external);}
  if(origins.size)return origins.size===1?[...origins.values()][0]:null;
  // Legacy src-only links have no capture identity. Never pick a preceding/global equal-byte artifact.
  for(const input of body.origin.generated.inputs){const ref=parseReference(input);if(ref.scheme!=='rec')continue;const record=await this.context.records.store.get(ref.record);if(record?.kind!=='source_artifact'||record.schema!=='source_artifact@1')continue;const parent=record as SourceArtifact;const source=await this.context.records.artifacts.source(principal,parent.body.sha256,{consumer:'function',record:parent.digest});if(!source?.bytes)continue;const external=await this.origin(principal,parent,undefined,new Set(seen));if(external)origins.set(canonicalize(external),external);}
  return origins.size===1?[...origins.values()][0]:null;
 }
 /** Recheck the exact capture and read tier at use time without reparsing it. */
 private async sourceAccess(principal:Principal,sha:string,record?:string,manifest?:string,stage='input_source',run?:string|null){
  if(record){const captured=await this.context.records.store.get<any>(record);if(captured?.kind!=='source_artifact'||captured.body.sha256!==sha)throw new KnowledgeError(`喂入来源读取未完成（${stage}，SOURCE_UNAVAILABLE）：采集记录与摘要不匹配；原件 ${sha}，记录 ${record}；按本次读取重新绑定`,{code:'SOURCE_UNAVAILABLE'});}
  let found=await this.context.records.artifacts.source(principal,sha,{consumer:'function',...(record?{record}:{})});
  if(!found&&record&&run){const stored=await runById(this.context.records.store,run);if(stored&&await canViewRun(principal,stored.body,this.context.records.store)&&stored.body.sources.some(binding=>binding.artifact===record&&(!manifest||binding.read_manifest===manifest)&&(()=>{const ref=parseReference(binding.reference);return ref.scheme==='src'&&ref.sha256===sha;})())){const scoped=await this.context.records.artifacts.sourceForRun(principal,sha,run,{consumer:'function',record});if(scoped?.artifact.digest===record)found=scoped;}}
  if(!found?.bytes||found.readTier!=='model_readable')throw new KnowledgeError(`喂入来源读取未完成（${stage}，SOURCE_UNAVAILABLE）：来源不存在、保留中或当前不可读；原件 ${sha}，记录 ${record??'未指定'}，当前档位 ${found?.readTier??'未获读取授权或缺记录'}；核对这条采集记录和读取身份后重读`,{code:'SOURCE_UNAVAILABLE'});
  return {...found,bytes:found.bytes};
 }
 private async source(principal:Principal,sha:string,record?:string,manifest?:string,stage='input_source',run?:string|null):Promise<Source>{
  const found=await this.sourceAccess(principal,sha,record,manifest,stage,run);
  const parsed=await recognizeAsync(this.context.parsers,found.bytes,found.mediaType);if(!parsed)fail('来源格式不能按已声明解析器读取');
  let external:ReturnType<typeof parseExternal>;try{external=await this.origin(principal,found.artifact,manifest&&Sha256.safeParse(manifest).success?manifest:undefined);}catch(error){if(!(error instanceof KnowledgeError))throw error;throw new KnowledgeError(`喂入来源读取未完成（${stage}，SOURCE_UNAVAILABLE）：读取清单与采集记录未核对；原件 ${sha}，记录 ${record??found.artifact.digest}，清单 ${manifest??'未指定'}；按本次读取重新绑定`,{code:'SOURCE_UNAVAILABLE'});}
  return {artifact:found.artifact,bytes:found.bytes,parser:parserKey(parsed.parser),model:parsed.document.model,external};
 }
 private async metadataSource(principal:Principal,sha:string,record?:string,manifest?:string):Promise<Source>{const source=await this.source(principal,sha,record,manifest,'metadata');const parser=this.context.parsers.get('json@1');if(!parser)fail('缺 JSON 元数据解析器；管理员恢复后重读');return {...source,parser:'json@1',model:(await parseDocument(parser,source.bytes)).model};}
 /** Root readability authorizes parsing its exact frozen input, not arbitrary elevated artifact reads. */
 private async commandSource(principal:Principal,seed:import('../../contracts/src/knowledge.ts').SeedlingBody){
  const origin=seed.origin.find(row=>row.role==='command-tree');if(!origin)fail('树苗缺命令原件');const body=await this.context.store.composition(seed.composition);if(!body||body.root!==seed.root||body.product!==seed.product)fail('树苗组成与锁定根不匹配');
  const composition=new CompositionView(this.context.store,seed.composition,body);const captures=(await composition.sources()).filter(row=>row.producer===origin.producer&&row.slot===origin.slot&&row.external===origin.external&&row.sha256===origin.sha256);if(!captures.length)fail('锁定组成缺命令树采集记录；管理员恢复树苗组成后重读');
  const configured=this.context.admin?await this.context.records.principals.get(this.context.admin.id):null;const custodian=configured&&!configured.disabled&&configured.role==='admin'?configured:(await this.context.records.principals.list?.()??[]).find(row=>row.role==='admin'&&!row.disabled)??principal;
  return this.source(custodian,origin.sha256,captures[0].artifact,undefined,'command_tree');
 }
 private async currentPack(pack?:ProductHandle|null){return !pack||(await this.context.packs.productById(pack.product.id))?.digest===pack.digest;}
 private superseded(sha:string){return this.pendingReceipt(sha,'投影所用包已被新摘要替代，旧结果未写入喂入层','按当前已发布包重读该来源；不把旧包失败当成终局');}
 private quoteRef(quote:QuoteEvidence){return 'identity'in quote?{sha:quote.identity.source_sha256,parser:quote.identity.parser,selector:quote.identity.path,span:quote.identity.span,range:null}:{...(()=>{const ref=parseReference(quote.reference);if(ref.scheme!=='src'||!ref.parser||!ref.selector)fail('喂入引文必须是带解析器和选择器的 src 引用');return {sha:ref.sha256,parser:ref.parser,selector:ref.selector,range:ref.range??null};})(),span:null};}
 async quote(principal:Principal,quote:QuoteEvidence,cache?:Map<string,Awaited<ReturnType<typeof parseDocument>>>):Promise<void>{
  const ref=this.quoteRef(quote),source=await this.context.records.artifacts.source(principal,ref.sha,{consumer:'model'});if(!source?.bytes||source.readTier!=='model_readable')fail('引文原件不存在或当前不可读');
  const parser=this.context.parsers.get(ref.parser);if(!parser)fail('引文解析器版本不存在');
  const cacheKey=ref.sha+'\0'+ref.parser;
  const document=cache?.get(cacheKey)??await parseDocument(parser,source.bytes);
  cache?.set(cacheKey,document);
  const fragment=await document.locate(ref.selector);if(!fragment)fail('引文选择器不能解析');
  if(ref.span){const range=fragment.byteRange??(ref.parser==='json@1'&&ref.selector==='p'?[0,source.bytes.byteLength]:null);if(!range)fail('该解析器没有原始范围；改用生成的 source+selector 逐字引用，不得猜 byte span');const end=ref.span.offset+ref.span.length;if(ref.span.offset<range[0]||end>range[1])fail('引文跨度不在原始片段中');let text:string;try{text=new TextDecoder('utf-8',{fatal:true}).decode(source.bytes.slice(ref.span.offset,end));}catch{fail('引文不是完整 UTF-8 字节');}if(text!==quote.text)fail('引文不是原件逐字内容');}
  else {const text=ref.range?sliceUtf8(fragment.text,ref.range[0],ref.range[1]):fragment.text;if(text===null||!text.includes(quote.text))fail('引文不是选择器原文的逐字片段');}
 }

 private feedingLimits(){return {...this.context.sandbox.producer,timeoutMs:Math.min(this.context.sandbox.producer.timeoutMs??FEEDING_CALL_MS,FEEDING_CALL_MS)};}
 private feedingOptions(){return {...this.context.sandbox,retryWallTimeout:false};}
 async seedFor(product:string,line:string){return (await this.seedsFor(product,[line])).get(line)??null;}
 private async seedsFor(product:string,requested:readonly string[],selectedPack?:ProductHandle|null){
  const result=new Map<string,import('../../contracts/src/knowledge.ts').SeedlingBody>();
  const lines=[...new Set(requested)];if(!lines.length)return result;
  for(const line of lines){const target=await currentSeedling(this.context,product,line);if(!target)continue;const direct=await seedlingRecord(this.context,target);if(direct){result.set(line,direct);continue;}const rows=await this.context.store.all<unknown>({key:INDEX.seedling,value:product+'/'+line,kind:'claim'});for(const row of rows){const parsed=SeedlingBody.safeParse(row.body);if(row.schema==='seedling@1'&&parsed.success&&parsed.data.root===target)result.set(line,parsed.data);}}
  if(result.size===lines.length)return result;
  const pack=selectedPack===undefined?await this.context.packs.productById(product):selectedPack,fn=pack?.product.feeding?.normalize_line;if(!pack||!fn)return result;
  const seeds:import('../../contracts/src/knowledge.ts').SeedlingBody[]=[];
  for(const pointer of await this.context.records.pointers.list('seedling/'+product+'/')){if(!pointer.target)continue;const direct=await seedlingRecord(this.context,pointer.target);if(direct){seeds.push(direct);continue;}const rows=await this.context.store.all<unknown>({key:INDEX.seedlingRoot,value:product+'/'+pointer.target,kind:'claim'});let selected:import('../../contracts/src/knowledge.ts').SeedlingBody|undefined;for(const row of rows){const parsed=SeedlingBody.safeParse(row.body);if(row.schema==='seedling@1'&&parsed.success&&seedlingName(product,parsed.data.line)===pointer.name)selected=parsed.data;}if(selected)seeds.push(selected);}
  const values=[...new Set([...lines,...seeds.map(seed=>seed.line)])].sort();if(values.length>2048)fail('版本线核验超过单文档批量上限；管理员缩小树苗范围后重读');
  const key=sha256Hex(canonicalize({pack:pack.digest,fn,values}));let pending=this.normalized.get(key);
  if(!pending){pending=(async()=>{const rows=await feedingFunctionCall(pack.id+'@'+pack.version+'/'+fn.module+'#'+(fn.export??'default'),values,async()=>{const batch=await callPackFunctionBatch({packDir:pack.directory,...fn},values.map(line=>({line})),this.feedingLimits(),this.feedingOptions());for(const row of batch)if(!row.ok)throw row.error;return batch;});const out=new Map<string,string|null>();for(const [i,row]of rows.entries()){if(!row.ok)throw row.error;const output=row.result.output;if(!object(output)||output.line!==null&&typeof output.line!=='string')fail('版本规范化回调没有给出声明值');out.set(values[i],output.line);}return out;})();if(this.normalized.size>=128)this.normalized.delete(this.normalized.keys().next().value!);this.normalized.set(key,pending);pending.catch(()=>this.normalized.delete(key));}
  const canonical=await pending;for(const line of lines){const value=canonical.get(line);if(value===null||value===undefined)continue;const candidates=seeds.filter(seed=>canonical.get(seed.line)===value);if(new Set(candidates.map(seed=>seed.root)).size>1)fail('同一规范版本线存在冲突树苗，管理员核对后重试');if(candidates.length)result.set(line,candidates[0]);}
  return result;
 }
 private async requireLines(product:string,lines:readonly string[],pack?:ProductHandle|null){const found=await this.seedsFor(product,lines,pack);for(const line of new Set(lines))if(!found.has(line))throw new KnowledgeError('版本线 '+line+' 没有树苗；管理员先育苗，再重读原件',{code:'REFERENCE_UNRESOLVED'});}
 private async seed(product:string,line:string){const seed=await this.seedFor(product,line);if(!seed)throw new KnowledgeError('版本线 '+line+' 没有树苗；管理员先育苗，再重读原件',{code:'REFERENCE_UNRESOLVED'});return seed;}

 // A seedling indexed on the locked root stays the anchor. A per-build root with none hangs on the current seedling of its
 // version line: scope.line when that line produced the root, otherwise the only line the root was produced for.
 private async root(principal:Principal,product:string,locked:string,composition?:string|null,line?:string|null):Promise<{seed:ReturnType<typeof SeedlingBody.parse>;attached:boolean}>{
  if(!await this.reading.mayReadRoot(principal,locked))fail('锁定树苗不存在或当前不可读');
  const rows=await this.context.store.all<unknown>({key:INDEX.seedlingRoot,value:product+'/'+locked,kind:'claim'});
  const parsed=rows.flatMap(row=>{const body=SeedlingBody.safeParse(row.body);return row.schema==='seedling@1'&&body.success?[body.data]:[];});
  if(parsed.length){
   const seeds=composition?parsed.filter(seed=>seed.composition===composition):parsed;
   if(!seeds.length)throw new KnowledgeError('锁定根缺本次组成对应的树苗；管理员先育苗后开新运行',{code:'REFERENCE_UNRESOLVED'});
   if(!composition&&new Set(seeds.map(seed=>seed.composition)).size>1)throw new KnowledgeError('根有多个树苗组成，缺本次锁定的组成身份；带运行号重读',{code:'REFERENCE_UNRESOLVED'});
   return {seed:seeds.at(-1)!,attached:false};
  }
  const productions=await this.context.store.productionsOfRoot(locked);
  const lines=[...new Set(productions.flatMap(row=>typeof row.detail.build?.line==='string'&&row.detail.build.line!==''?[row.detail.build.line]:[]))];
  const only=lines.length===1?lines[0]??null:null;
  const chosen=line&&lines.includes(line)?line:only;
  const seed=chosen?await this.seedFor(product,chosen):null;
  if(!seed)throw new KnowledgeError('锁定根缺本次组成对应的树苗；管理员先育苗后开新运行',{code:'REFERENCE_UNRESOLVED'});
  if(seed.root!==locked&&!await this.reading.mayReadRoot(principal,seed.root))fail('锁定树苗不存在或当前不可读');
  return {seed,attached:seed.root!==locked};
 }
 private async projection(principal:Principal,source:Source,scope:FeedingScope,selectedPack?:ProductHandle|null):Promise<Projected>{
  if(!scope.product)return {rows:[],pack:'hub.feeding@1',digest:source.artifact.digest,attachment:null};
  const pack=selectedPack===undefined?await this.context.packs.productById(scope.product):selectedPack;if(!pack?.product.feeding)return {rows:[],pack:'hub.feeding@1',digest:source.artifact.digest,attachment:null};
  if(!await this.reading.mayReadProducts(principal,[scope.product]))fail('产品当前不可读');
  if(scope.root&&!await this.reading.mayReadRoot(principal,scope.root))fail('锁定根当前不可读');
  const anchor=scope.root?await this.root(principal,scope.product,scope.root,scope.composition,scope.line):null;
  const attachment:SeedlingAttachment|null=anchor?.attached?{locked_root:scope.root!,locked_composition:scope.composition??null,seedling_root:anchor.seed.root,seedling_composition:anchor.seed.composition,line:anchor.seed.line}:null;
  let meta:Record<string,unknown>|null=null;
  if(scope.metaSource){const original=await this.metadataSource(principal,scope.metaSource,scope.metaRecord,scope.readManifest);if(!source.external||original.external?.id!==source.external.id)fail('目录元数据与本次原件不是同一来源');if(!object(original.model))fail('目录元数据不是结构对象');meta=original.model;}
  const key=sha256Hex(canonicalize({version:3,pack:pack.digest,source:source.artifact.body.sha256,external:source.external,parser:source.parser,root:scope.root??null,composition:scope.composition??null,meta:scope.metaSource??null,seedling:attachment?.seedling_composition??null}));
  let pending=this.projecting.get(key);
  if(!pending){pending=(async()=>{
   const saved=(await this.context.records.store.find<any>({key:PROJECTION,value:key,kind:'action',limit:1})).items[0];
   if(saved){const bytes=await this.context.records.objects.get(saved.body.detail.sha256);if(!bytes||sha256Hex(bytes)!==saved.body.detail.sha256)fail('投影缓存缺完整内容；管理员修复对象库后重读');return JSON.parse(new TextDecoder().decode(bytes)) as Projected;}
   let tree:Record<string,unknown>|null=null;
   const project=async()=>await feedingFunctionCall(pack.id+'@'+pack.version+'/'+pack.product.feeding!.project.module+'#'+(pack.product.feeding!.project.export??'default'),[source.model,meta,tree?.model],()=>callPackFunction({packDir:pack.directory,...pack.product.feeding!.project},{product:scope.product,root:scope.root??null,model:source.model,meta,parser:source.parser,tree,source:{system:source.external?.system,type:source.external?.type,key:source.external?.key,revision:source.external?.revision,external:source.external?.id,bytes:source.artifact.body.sha256}},this.feedingLimits(),this.feedingOptions()));
   let result=await project();
   if(!object(result.output)||!Array.isArray(result.output.rows)||result.output.rows.length>MAX_FEEDING_ROWS)fail('产品包喂入投影没有给出单文档有界结构对象（最多 '+MAX_FEEDING_ROWS+' 条）');
   if(result.output.rows.length&&anchor){const origin=anchor.seed.origin.find(row=>row.role==='command-tree');if(origin){const original=await this.commandSource(principal,anchor.seed);if(original.parser!=='xml@1')fail('锁定命令树不是原始 XML');tree={model:original.model,sha256:origin.sha256};result=await project();}}
   if(!object(result.output)||!Array.isArray(result.output.rows)||result.output.rows.length>MAX_FEEDING_ROWS)fail('产品包喂入投影结构不完整或超过单文档上限');
  const rows=result.output.rows as Projection[];
  for(const row of rows){if(row.missing&&(!Array.isArray(row.missing)||row.missing.length>1000||row.missing.some(gap=>!object(gap)||typeof gap.missing!=='string'||!gap.missing||typeof gap.next_action!=='string'||!gap.next_action)))fail('产品包缺失事实出口不合格式');if(!object(row.body)||!Array.isArray(row.lines)||row.lines.some(line=>typeof line!=='string')||typeof row.selector!=='string'||typeof row.grammar!=='string'||typeof row.conflict!=='boolean')fail('产品包喂入行结构不完整');row.body={...row.body,object:sha256Hex(canonicalize(row.identity))};if(!KnowledgeStructureSchema.safeParse(row.body).success)fail('原件投影不合 knowledge-structure@1；修正类型或缺失字段');}

   const value:Projected={rows,pack:pack.id+'@'+pack.version,digest:pack.digest,attachment};const stored=await this.context.records.objects.put(new TextEncoder().encode(canonicalize(value)),'application/json');const at=this.context.now().toISOString();
   await this.context.records.store.put({kind:'action',schema:'action@1',provenance:'projected',unique_key:'feeding.projection:'+key,body:{action:'read',run:null,item:null,component:'hub.feeding@2',inputs:['src:'+source.artifact.body.sha256],lease:null,started_at:at,ended_at:at,result:'completed',error_code:null,acceptance:null,codes:[],detail:{key,sha256:stored.sha256}},index:[{key:PROJECTION,value:key}]});return value;
  })();this.projecting.set(key,pending);void pending.finally(()=>this.projecting.delete(key)).catch(()=>{});}
  const projected=await pending;
  await this.requireLines(scope.product,[...projected.rows.flatMap(row=>row.lines),...(scope.declaredLine?[scope.declaredLine]:[])],pack);
  return projected;
 }
 private claim(body:Record<string,any>,by:Principal,warrant:string,grounds:string[],bound:string[],judgment=false,run:string|null=null,key='',metaSource?:string,gaps?:Projection['missing'],capture?:{external:string|null;read_manifest:string|null;seedling_attachment?:SeedlingAttachment}):ClaimBody{
  if(operationRecord(body.schema))return Claim.parse({statement:{text:'Circle 操作记录；等级为声明，不作为核验、评分或放行的证据',data:{feeding:body,actor:by.id,run,key}},grounds,warrant:{producer:'function',id:warrant,independence:'judge_not_author'},qualifier:{nature:'unknown',provenance:'client_captured',marks:['semantics_unasserted']},validity:{status:'valid',bound:[...new Set(bound)],premises:[]}});
  return Claim.parse({statement:{text:judgment?'客户端带原文引文的喂入主张；语义仍为判断':'按原件结构登记喂入事实',data:{feeding:body,actor:by.id,run,key,...capture,...(metaSource?{meta_source:metaSource}:{}),...(gaps?.length?{missing:gaps}:{})}},grounds,warrant:{producer:judgment?'model':'function',id:warrant,independence:'judge_not_author'},qualifier:{nature:judgment?'judgment':'fact',provenance:body.schema==='fed-note@1'||body.basis==='declared'?'declared':judgment?'declared':'projected',basis_rank:body.basis==='declared'?'rule_over_claims':judgment?'judgment':'rule_over_observation',marks:[]},validity:{status:'valid',bound:[...new Set(bound)],premises:[]}});
 }
 private async put(body:Record<string,any>,by:Principal,warrant:string,grounds:string[],bound:string[],key:string,index:Array<{key:string;value:string}>,tx:Transaction,judgment=false,run:string|null=null,metaSource?:string,gaps?:Projection['missing'],capture?:{external:string|null;read_manifest:string|null;seedling_attachment?:SeedlingAttachment}){return this.context.records.store.put({kind:'claim',schema:'claim@1',provenance:operationRecord(body.schema)?'client_captured':body.schema==='usage@1'?'observed':judgment||body.schema==='fed-note@1'?'declared':'projected',body:this.claim(body,by,warrant,grounds,bound,judgment,run,key,metaSource,gaps,capture),unique_key:'feeding:'+key,index:[{key:LOG,value:'1'},{key:'knowledge.feeding.actor',value:by.id},{key:'knowledge.feeding.key',value:key},...index]},tx);}
 private key(body:Record<string,any>){const {at:_at,...withoutTime}=body;return sha256Hex(canonicalize(withoutTime));}
 private async usage(principal:Principal,id:string,scope:FeedingScope,tx:Transaction){if(!scope.run)return;const body={schema:'usage@1',object:id,run:scope.run,line:scope.line??null,at:this.context.now().toISOString()};await this.put(body,principal,'hub.feeding@1',[],[id],`usage:${scope.run}:${id}`,[{key:USAGE,value:scope.run},{key:'knowledge.feeding.usage.object',value:id}],tx,false,scope.run);}
 private async todo(principal:Principal,source:Record<string,any>,product:string|null,missing:string,next:string,tx:Transaction,errorDetail?:FeedingErrorDetail){
  const {bytes:_bytes,revision:_revision,element:_element,...identity}=source;const key=sha256Hex(canonicalize({product,identity}));
  await this.todoState(key,false,tx);
  const saved=await this.context.records.store.put({kind:'action',schema:'action@1',provenance:'observed',unique_key:'feeding.todo:'+key,body:{action:'read',run:null,item:null,component:'hub.feeding@1',inputs:[],lease:null,started_at:this.context.now().toISOString(),ended_at:this.context.now().toISOString(),result:'completed',error_code:null,acceptance:null,codes:[],detail:{feeding_todo:{key,product,source:identity,missing,next_action:next,by:principal.id,...(errorDetail?{detail:errorDetail}:{})}}},index:[{key:TODO,value:'1'},{key:'knowledge.feeding.todo.key',value:key}]},tx);
  const latest=(await this.context.records.store.find<any>({key:'knowledge.feeding.todo.detail',value:key,kind:'action',limit:1,newestFirst:true},tx)).items[0];
  const state={missing,next_action:next,detail:errorDetail??null},before=latest?.body.detail?.feeding_todo??saved.body.detail.feeding_todo;
  if(canonicalize(state)!==canonicalize({missing:before.missing,next_action:before.next_action,detail:before.detail??null})){
   const at=this.context.now().toISOString();await this.context.records.store.put({kind:'action',schema:'action@1',provenance:'observed',body:{action:'read',run:null,item:null,component:'hub.feeding@2',inputs:['rec:'+saved.digest,...(latest?['rec:'+latest.digest]:[])],lease:null,started_at:at,ended_at:at,result:'unknown',error_code:null,acceptance:null,codes:[],detail:{feeding_todo:{...saved.body.detail.feeding_todo,...state}}},index:[{key:'knowledge.feeding.todo.detail',value:key}]},tx);
  }
 }
 private async bindings(principal:Principal,row:Projection,source:Source,scope:FeedingScope,tx:Transaction,evidence:{reference:string;text:string},attachment?:SeedlingAttachment|null){
  const candidates=[...new Set(row.lines)],line=candidates.length===1?candidates[0]:null;
  const make=(value:string|null,state:BindingStatus)=>({schema:'version-binding@1',object:row.body.object,product:scope.product,line:value,basis:'source_structure',grounds:{quote:evidence,grammar:row.grammar},state,candidates:state==='conflict'?candidates:[],...(state==='undeclared'?{missing:'原始目录或结构字段没有版本声明',next_action:'维护者补结构版本；下一次读取自动登记；运行目标不能补绑定'}:{})});
  const bodies=candidates.length?(row.conflict?[make(null,'conflict')]:candidates.map(value=>make(value,'bound'))):[make(null,'undeclared')];
  if(scope.declaredLine){bodies.push({schema:'version-binding@1',object:row.body.object,product:scope.product,line:scope.declaredLine,basis:'declared',grounds:{by:principal.id,run:scope.run},state:'bound',candidates:[]} as never);}
  const extra=attachment?[attachment.seedling_root,attachment.seedling_composition]:[];
  const capture=attachment?{external:null,read_manifest:null,seedling_attachment:attachment}:undefined;
  for(const body of bodies){if(!KnowledgeStructureSchema.safeParse(body).success)fail('绑定结构不合格');await this.put(body,principal,'hub.feeding@1',['src:'+source.artifact.body.sha256],[source.artifact.body.sha256,source.artifact.digest,...(scope.metaSource?[scope.metaSource]:[]),...(scope.root?[scope.root]:[]),...extra],'binding:'+this.key(body)+':'+source.artifact.digest+':'+(scope.metaSource??'')+':'+(scope.run??'')+(attachment?':'+attachment.seedling_composition:''),[{key:BINDING,value:row.body.object}],tx,false,scope.run??null,undefined,undefined,capture);}
  if(!candidates.length||row.conflict)await this.todo(principal,row.body.source,scope.product!,row.conflict?'目录存在冲突版本层':'版本未声明','维护者修正目录后再次读取；不在运行中问人、不推送',tx);
  else {const {bytes:_bytes,revision:_revision,element:_element,...identity}=row.body.source;await this.todoState(sha256Hex(canonicalize({product:scope.product,identity})),true,tx);}
 }
 async sourceLines(principal:Principal,sha:string,scope:FeedingScope):Promise<string[]>{const source=await this.source(principal,sha,scope.sourceRecord,scope.readManifest);const projected=await this.projection(principal,source,{...scope,root:null});return [...new Set(projected.rows.flatMap(row=>row.lines))];}
 private pendingReceipt(sha:string,missing='文档投影进行中（尚未完成，未当作已喂入）',next='继续处理本次运行；后续 get_nodes 会返回进度和喂入清单，Hub 重启后重读该来源续做'):FeedingReceipt{return {objects:[],offset:null,pending:[{source:sha,missing,next_action:next}]};}
 private async jobLifecycleRecord(job:Pick<FeedingJob,'key'|'captureKey'|'pack'|'principal'|'sha'|'scope'>,state:'queued'|'running'|'superseded',receipt?:FeedingReceipt){return this.writeJobRecord(job,state,'unknown',receipt);}
 private async jobResultRecord(job:Pick<FeedingJob,'key'|'captureKey'|'pack'|'principal'|'sha'|'scope'>,state:ActionResult,receipt?:FeedingReceipt){return this.writeJobRecord(job,state,state,receipt);}
 private async writeJobRecord(job:Pick<FeedingJob,'key'|'captureKey'|'pack'|'principal'|'sha'|'scope'>,state:string,result:ActionResult,receipt?:FeedingReceipt){const at=this.context.now().toISOString();await this.context.records.store.put({kind:'action',schema:'action@1',provenance:'observed',body:{action:'read',run:job.scope.run??null,item:null,component:'hub.feeding@2',inputs:['src:'+job.sha],lease:null,started_at:at,ended_at:at,result,error_code:null,acceptance:null,codes:[],detail:{feeding_job:{key:job.key,capture_key:job.captureKey,pack_digest:job.pack?.digest??null,product:job.pack?.product.id??job.scope.product??null,by:job.principal.id,source:job.sha,scope:job.scope,state,pending:receipt?.pending??this.pendingReceipt(job.sha).pending}}},index:[{key:'knowledge.feeding.job',value:job.scope.run??job.principal.id}]});}
 private pump(){while(this.activeJobs<FEEDING_BOUNDS.concurrency&&this.queue.length){const job=this.queue.shift()!;this.activeJobs++;job.state='running';void (async()=>{
   await job.announced;
   await this.jobLifecycleRecord(job,'running');
   await this.context.records.store.withTransaction(async tx=>{await this.context.records.store.lock('knowledge.feeding.log',tx);await this.usage(job.principal,job.sha,job.scope,tx);});
   return this.observeSource(job.principal,job.sha,job.scope,job.pack??undefined);
  })().catch(error=>this.pendingReceipt(job.sha,error instanceof Error?error.message:'投影没有完成回执','修正或恢复原件后重读该来源；不把未完成投影当已喂入')).then(async receipt=>{try{if(!await this.currentPack(job.pack))await this.jobLifecycleRecord(job,'superseded',receipt);else await this.jobResultRecord(job,receipt.pending.length?'unknown':'completed',receipt);}catch{/* Original sources and the run remain readable; absence of a completion record is still unknown. */}job.resolve(receipt);}).finally(()=>{this.jobs.delete(job.key);this.activeJobs--;this.pump();});}}
 /** Read hooks wait at most one small slice; queued work has a separate finite worker/call budget. */
 async observeSourceBounded(principal:Principal,sha:string,scope:FeedingScope={}):Promise<FeedingReceipt>{
  if(scope.readManifest&&!Sha256.safeParse(scope.readManifest).success)scope={...scope,readManifest:undefined};
  const pack=scope.product?await this.context.packs.productById(scope.product):null,captureKey=sha256Hex(canonicalize({by:principal.id,sha,scope:captureScope(scope)}));const key=sha256Hex(canonicalize({captureKey,pack:pack?.digest??null}));let job=this.jobs.get(key);
  if(!job&&!scope.metaSource&&!scope.sourceRecord)job=[...this.jobs.values()].find(candidate=>candidate.pack?.digest===pack?.digest&&candidate.principal.id===principal.id&&candidate.sha===sha&&candidate.scope.product===scope.product&&candidate.scope.root===scope.root&&candidate.scope.composition===scope.composition&&candidate.scope.run===scope.run);
  if(!job){if(this.queue.length>=FEEDING_BOUNDS.queued){const receipt=this.pendingReceipt(sha,'文档投影队列已达上限，本次尚未开始','稍后重读该来源；本次运行不等待队列、不当作已喂入');const refused={key,captureKey,pack,principal,sha,scope};void this.jobResultRecord(refused,'unknown',receipt).catch(()=>{});return receipt;}
   let resolve!:(value:FeedingReceipt)=>void;const done=new Promise<FeedingReceipt>(yes=>{resolve=yes;});job={key,captureKey,pack,principal,sha,scope,state:'queued',done,resolve,announced:Promise.resolve()};this.jobs.set(key,job);this.queue.push(job);job.announced=this.jobLifecycleRecord(job,'queued').catch(()=>{});this.pump();
  }
  let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([job.done,new Promise<FeedingReceipt>(yes=>{timer=setTimeout(()=>yes(this.pendingReceipt(sha)),FEEDING_BOUNDS.waitMs);})]);}finally{if(timer)clearTimeout(timer);}
 }
 async drain():Promise<void>{while(this.jobs.size)await Promise.all([...this.jobs.values()].map(job=>job.done));}
 async pending(principal:Principal,run:string):Promise<FeedingReceipt['pending']>{
  const owned=await runById(this.context.records.store,run);if(!owned||!await canViewRun(principal,owned.body,this.context.records.store))return [];
  type Status={source:string;state:string;pending:FeedingReceipt['pending'];pack_digest?:string|null;product?:string|null;by?:string;scope?:FeedingScope};
  const states=new Map<string,Status>();for(const row of await this.context.store.all<any>({key:'knowledge.feeding.job',value:run,kind:'action'})){const value=row.body.detail?.feeding_job;if(value)states.set(value.key,value);}
  for(const job of this.jobs.values())if(job.scope.run===run)states.set(job.key,{source:job.sha,state:job.state,pending:this.pendingReceipt(job.sha).pending,pack_digest:job.pack?.digest??null,product:job.scope.product,by:job.principal.id,scope:job.scope});
  const packages=new Map<string,string|null>();for(const value of states.values()){const product=value.product??value.scope?.product??owned.body.product;if(product&&!packages.has(product))packages.set(product,(await this.context.packs.productById(product))?.digest??null);}
  const contextKey=(value:Status)=>canonicalize({source:value.source,by:value.by??null,product:value.product??value.scope?.product??owned.body.product??null,root:value.scope?.root??null,composition:value.scope?.composition??null});
  const current=new Set([...states.values()].filter(value=>value.pack_digest&&value.pack_digest===packages.get(value.product??value.scope?.product??owned.body.product??'')).map(contextKey));
  const out=new Map<string,FeedingReceipt['pending'][number]>();for(const [key,value]of states){if(value.state==='completed'||!await this.visible(value.source,principal))continue;const digest=packages.get(value.product??value.scope?.product??owned.body.product??'');
   const old=value.pack_digest?value.pack_digest!==digest:current.has(contextKey(value));if(old&&current.has(contextKey(value)))continue;
   const rows=old?this.pendingReceipt(value.source,'包摘要已变更，缺新包的投影完成回执；旧失败不是终局','按当前已发布包重读该来源').pending:(value.state==='running'||value.state==='queued')&&!this.jobs.has(key)?this.pendingReceipt(value.source,'缺少文档投影完成回执，当前进程没有这项进行中的任务','重读该来源以续做投影；不把原进程的进行中状态当完成').pending:value.pending;
   for(const row of rows)out.set(canonicalize(row),row);
  }return [...out.values()];
 }
 async observeSource(principal:Principal,sha:string,scope:FeedingScope={},selectedPack?:ProductHandle):Promise<FeedingReceipt>{
  const pack=selectedPack??(scope.product?await this.context.packs.productById(scope.product):undefined);
  try{return await this.observeCaptured(principal,sha,scope,pack??undefined);}catch(error){return this.failedAttempt(principal,sha,scope,error,pack);}
 }
 private async failedAttempt(principal:Principal,sha:string,scope:FeedingScope,error:unknown,pack?:ProductHandle|null):Promise<FeedingReceipt>{
  if(!await this.currentPack(pack))return this.superseded(sha);
  let external:ReturnType<typeof parseExternal>=null;const record=scope.sourceRecord?await this.context.records.store.get<any>(scope.sourceRecord):null;
  if(record?.kind==='source_artifact'&&record.body.sha256===sha){if(scope.readManifest&&Sha256.safeParse(scope.readManifest).success)external=await this.manifestOrigin(principal,record as SourceArtifact,scope.readManifest);else if('read'in record.body.origin)external=parseExternal(record.body.origin.read.object);}
  // Administrative todo identity may name the verified read request even when its capture pin is broken.
  // This labels the failure; it never substitutes another artifact for the failed read.
  if(!external&&scope.readManifest){const action=await this.context.records.store.get(scope.readManifest);const parsed=action?.kind==='action'&&action.schema==='read-manifest@1'&&action.provenance==='observed'?ReadManifest.safeParse(action.body):null;if(parsed?.success&&(principal.role==='admin'||parsed.data.principal===principal.id)&&parsed.data.artifacts.some(item=>item.sha256===sha))external=parseExternal(parsed.data.external);}
  const missing=error instanceof Error?error.message:'喂入读取或投影没有完成回执',next='核对本次原件、目录元数据及锁定命令树各自的采集记录和读取身份后，按当前包重读；不把失败缓存当终局';
  await this.context.records.store.withTransaction(async tx=>{await this.context.records.store.lock('knowledge.feeding.log',tx);await this.usage(principal,sha,scope,tx);await this.todo(principal,{system:external?.system??'capture',document:external?.key??scope.sourceRecord??sha},scope.product??null,missing,next,tx,error instanceof FeedingFunctionFailure?error.detail:undefined);});
  return {objects:[],offset:await this.offset(),pending:[{source:sha,missing,next_action:next}]};
 }
 private async observeCaptured(principal:Principal,sha:string,scope:FeedingScope,pack?:ProductHandle):Promise<FeedingReceipt>{
  if(scope.readManifest&&!Sha256.safeParse(scope.readManifest).success)scope={...scope,readManifest:undefined};
  if(scope.run&&!scope.metaSource&&!scope.sourceRecord){const prior=await this.context.store.all<any>({key:'knowledge.feeding.job',value:scope.run,kind:'action'});for(const row of prior){const job=row.body.detail?.feeding_job,old=job?.scope;if(job?.by===principal.id&&job.source===sha&&old?.product===scope.product&&old.root===scope.root&&old.composition===scope.composition)scope={...scope,metaSource:old.metaSource,metaRecord:old.metaRecord,readManifest:old.readManifest,sourceRecord:old.sourceRecord,declaredLine:old.declaredLine};}}
  const source=await this.source(principal,sha,scope.sourceRecord,scope.readManifest,'input_source',scope.run),pending:FeedingReceipt['pending']=[];
  if(!scope.product){const products=new Set<string>();for(const entry of await this.all('knowledge.feeding.source',sha)){const value=this.body(entry);if(value?.product&&await this.recordVisible(entry,principal))products.add(value.product);}if(products.size===1)scope={...scope,product:[...products][0]};}
  if('upload'in source.artifact.body.origin){return this.upload(principal,source.artifact,scope);}
  if(!scope.metaSource)for(const previous of await this.all('knowledge.feeding.source',sha)){const meta=previous.body.statement.data?.meta_source;if(typeof meta==='string'&&await this.recordVisible(previous,principal))scope={...scope,metaSource:meta};}
  if(!source.external&&'generated'in source.artifact.body.origin&&scope.product&&(await this.context.packs.productById(scope.product))?.product.feeding){const receipt=this.pendingReceipt(sha,'来源身份未声明：缺本次生成件对应的读取动作；同内容多个出处不是冲突，不能按摘要反挑一条','经原外部标识重新读取并绑定原件记录与读取清单；旧记录保留，不猜补出处');await this.context.records.store.withTransaction(async tx=>{await this.context.records.store.lock('knowledge.feeding.log',tx);await this.usage(principal,sha,scope,tx);await this.todo(principal,{system:'capture',document:source.artifact.digest},scope.product!,receipt.pending[0].missing,receipt.pending[0].next_action,tx);});return {...receipt,offset:await this.offset()};}
  let projection:Awaited<ReturnType<FeedingLayer['projection']>>;
  try{projection=await this.projection(principal,source,scope,pack);}catch(error){return this.failedAttempt(principal,sha,scope,error,pack);}
  if(!await this.currentPack(pack))return this.superseded(sha);
  const observationKey=sha256Hex(canonicalize({version:3,by:principal.id,source:source.artifact.digest,sha,scope:captureScope(scope),pack:projection.digest,seedling:projection.attachment?.seedling_composition??null}));const completed=(await this.context.records.store.find<any>({key:'knowledge.feeding.observed',value:observationKey,kind:'action',limit:1})).items[0];if(completed)return {...completed.body.detail.receipt,offset:await this.offset()};
  // Locate all binding evidence before taking the append lock. One parsed
  // document is shared across every row, so lazy parsers issue bounded batches.
  const evidenceSource=scope.metaSource?await this.metadataSource(principal,scope.metaSource,scope.metaRecord,scope.readManifest):source;
  const evidenceParser=scope.metaSource?'json@1':evidenceSource.parser;
  const document=await parseDocument(this.context.parsers.get(evidenceParser)!,evidenceSource.bytes);
  const selectors=[...new Set(projection.rows.map(row=>scope.metaSource?'p/ancestors':row.selector))];
  await document.prefetch?.(selectors);
  const evidenceBySelector=new Map<string,{reference:string;text:string}>();
  let fallback:{reference:string;text:string}|undefined;
  for(const selector of selectors){
   const fragment=await document.locate(selector);
   if(fragment?.text){evidenceBySelector.set(selector,{reference:'src:'+evidenceSource.artifact.body.sha256+'/'+evidenceParser+'/'+selector,text:fragment.text});continue;}
   if(!fallback){const json=await parseDocument(this.context.parsers.get('json@1')!,evidenceSource.bytes);await json.prefetch?.(['p']);const whole=await json.locate('p');if(!whole?.text)fail('绑定来源片段不存在或为空');fallback={reference:'src:'+evidenceSource.artifact.body.sha256+'/json@1/p',text:whole.text};}
   evidenceBySelector.set(selector,fallback);
  }
  const ids=projection.rows.map(row=>row.body.object as string);for(const row of projection.rows)for(const gap of row.missing??[])pending.push({source:sha,...gap});
  const committed=await this.context.records.store.withTransaction(async tx=>{await this.context.records.store.lock('knowledge.feeding.log',tx);
   if(!await this.currentPack(pack))return false;
   const recheck=async()=>{await this.sourceAccess(principal,sha,source.artifact.digest,scope.readManifest,'input_source',scope.run);if(scope.metaSource)await this.sourceAccess(principal,scope.metaSource,evidenceSource.artifact.digest,scope.readManifest,'metadata');};
   await recheck();
   if(!projection.rows.length){await this.usage(principal,sha,scope,tx);if(!scope.product){const missing='缺少产品及树苗上下文，不能按业务来源猜产品',next_action='用绑定产品和树苗的运行号重新 get_nodes 读取此原件';pending.push({source:sha,missing,next_action});await this.todo(principal,{system:source.external?.system??'unknown',document:source.external?.key??sha},null,missing,next_action,tx);}return true;}
   for(const row of projection.rows){await recheck();const bytes=new TextEncoder().encode(canonicalize(row.identity));const stored=await this.context.records.objects.put(bytes,'application/json');if(stored.sha256!==row.body.object)fail('规范内容摘要不一致');await this.put(row.body,principal,projection.pack,['src:'+sha],[sha,source.artifact.digest,...(scope.metaSource?[scope.metaSource]:[]),projection.digest,...(scope.readManifest&&Sha256.safeParse(scope.readManifest).success?[scope.readManifest]:[]),...(scope.root?[scope.root]:[]),...(scope.composition?[scope.composition]:[]),...(projection.attachment?[projection.attachment.seedling_root,projection.attachment.seedling_composition]:[])],'object:'+this.key(row.body)+':'+source.artifact.digest+':'+(scope.run??'')+':'+(scope.composition??'')+':'+(scope.readManifest??'')+(projection.attachment?':'+projection.attachment.seedling_composition:''),[{key:OBJECT,value:row.body.object},{key:'knowledge.feeding.product',value:scope.product!},{key:'knowledge.feeding.source',value:sha}],tx,false,scope.run??null,scope.metaSource,row.missing,{external:source.external?.id??null,read_manifest:scope.readManifest&&Sha256.safeParse(scope.readManifest).success?scope.readManifest:null,...(projection.attachment?{seedling_attachment:projection.attachment}:{})});await this.bindings(principal,row,source,scope,tx,evidenceBySelector.get(scope.metaSource?'p/ancestors':row.selector)!,projection.attachment);if(scope.sourceRecord&&scope.requested&&parseExternal(scope.requested)?.revision===null)await this.sourceHead(row.body,source,tx);await this.usage(principal,row.body.object,scope,tx);}
   const at=this.context.now().toISOString();await this.context.records.store.put({kind:'action',schema:'action@1',provenance:'observed',unique_key:'feeding.observed:'+observationKey,body:{action:'read',run:scope.run??null,item:null,component:'hub.feeding@2',inputs:['src:'+sha],lease:null,started_at:at,ended_at:at,result:'completed',error_code:null,acceptance:null,codes:[],detail:{receipt:{objects:ids,pending}}},index:[{key:'knowledge.feeding.observed',value:observationKey}]},tx);
   return true;
  });if(!committed)return this.superseded(sha);return {objects:ids,offset:await this.offset(),pending};
 }
 private sourceKey(body:Record<string,any>){if(!body.source||body.schema==='fed-note@1'||operationRecord(body.schema))return null;const {bytes:_bytes,revision:_revision,...identity}=body.source;return sha256Hex(canonicalize({product:body.product,identity}));}
 private async sourceHead(body:Record<string,any>,source:Source,tx:Transaction){const key=this.sourceKey(body);if(!key)return;await this.context.records.store.lock('knowledge.feeding.head:'+key,tx);const old=(await this.context.records.store.find<any>({key:'knowledge.feeding.head',value:key,kind:'action',limit:1,newestFirst:true},tx)).items[0];if(old?.body.detail?.object===body.object)return;await this.context.records.store.put({kind:'action',schema:'action@1',provenance:'observed',body:{action:'read',run:null,item:null,component:'hub.feeding@1',inputs:['src:'+source.artifact.body.sha256],lease:null,started_at:this.context.now().toISOString(),ended_at:this.context.now().toISOString(),result:'completed',error_code:null,acceptance:null,codes:[],detail:{object:body.object,source_record:source.artifact.digest,parent:old?.digest??null}},index:[{key:'knowledge.feeding.head',value:key}]},tx);}
 private async changed(body:Record<string,any>,offset=Number.MAX_SAFE_INTEGER){const key=this.sourceKey(body);if(!key)return [];let head:StoredRecord<any>|undefined;for(const row of await this.context.store.all<any>({key:'knowledge.feeding.head',value:key,kind:'action'}))if(await this.position(row.digest)<=offset)head=row;return head&&head.body.detail?.object!==body.object?[head.digest]:[];}
 async upload(principal:Principal,artifact:SourceArtifact,scope:FeedingScope={}):Promise<FeedingReceipt>{
  if(!('upload'in artifact.body.origin)||artifact.body.author.user===null||artifact.body.author.user!==principal.id&&principal.role!=='admin')fail('上传出处必须是当前上传者的 Hub 原件');
  const body={schema:'fed-note@1',object:artifact.body.sha256,product:null,root:null,path:null,source:{system:'upload',bytes:artifact.body.sha256,artifact:artifact.digest},by:artifact.body.author.user,run:null,...noteCapture(artifact)};
  await this.context.records.store.withTransaction(async tx=>{await this.context.records.store.lock('knowledge.feeding.log',tx);await this.put(body,principal,'hub.upload@1',['src:'+artifact.body.sha256],[artifact.body.sha256,artifact.digest],'note:'+artifact.digest,[{key:OBJECT,value:body.object},{key:'knowledge.feeding.product',value:principal.id}],tx,false,scope.run??null);await this.usage(principal,body.object,scope,tx);});return {objects:[body.object],offset:await this.offset(),pending:[]};
 }
 async freeze(principal:Principal,run:string,root:string|null):Promise<FeedingOffset>{return this.context.records.store.withTransaction(async tx=>{await this.context.records.store.lock('knowledge.feeding.log',tx);const body={schema:'feeding-offset@1',run,root,offset:await this.offset(tx)} as const;const stored=await this.context.records.store.put({kind:'claim',schema:'feeding-offset@1',provenance:'observed',body,unique_key:'feeding.freeze:'+run,index:[{key:'knowledge.feeding.offset',value:run}]},tx);return stored.body;});}
 async usages(principal:Principal,run:string):Promise<string[]>{const owned=await runById(this.context.records.store,run);if(!owned||!await canViewRun(principal,owned.body,this.context.records.store))return [];const rows=await this.all(USAGE,run);const out:string[]=[];for(const row of rows){const body=this.body(row);if(body&&await this.visible(body.object,principal))out.push(body.object);}for(const row of await this.pending(principal,run))out.push(row.source);return [...new Set(out)];}
 /**
  * A note proposal annotates the note the Hub wrote for one upload, exactly as it was written (round-five review, item 5).
  * A note written now names its upload record, so only that record's note is read. An older note does not: the uploader's
  * uploads of these bytes are compared, a bounded number of them, and more than one equal note is refused rather than
  * guessed (round six).
  */
 private async uploadedSource(principal:Principal,body:Record<string,any>){
  const base=canonicalize(Object.fromEntries(Object.entries(body).filter(([key])=>!annotations.includes(key as never))));
  const named=typeof body.source?.artifact==='string'?body.source.artifact as string:undefined;
  const candidates=named!==undefined?[named]:(await this.context.records.artifacts.records(body.source.bytes)).filter(row=>'upload'in row.body.origin&&row.body.author.user===body.by).map(row=>row.digest);
  if(candidates.length>NOTE_CANDIDATES)fail(`同一上传者上传了超过 ${NOTE_CANDIDATES} 份相同字节，无法逐份核对说明；请管理员核对这些上传`);
  const matches:string[]=[];
  for(const digest of candidates){const written=await this.uploadNote(digest);if(written!==null&&canonicalize(written)===base)matches.push(digest);}
  if(matches.length===0)fail('缺少与上传者和这份上传说明一致的上传原件');
  if(matches.length>1)fail('多次上传写下了完全相同的说明，无法确定是哪一次上传；请管理员核对这些上传');
  return this.source(principal,body.source.bytes,matches[0]!);
 }
 /** The note body `upload()` wrote for one upload record, or null when none was written. */
 private async uploadNote(artifact:string):Promise<Record<string,unknown>|null>{
  const record=await this.context.records.store.getByKey<any>('claim','feeding:note:'+artifact);
  const feeding=record?.body?.statement?.data?.feeding;
  return object(feeding)&&feeding.schema==='fed-note@1'?feeding:null;
 }
 private async visible(id:string,principal:Principal):Promise<boolean>{const rows=await this.all(OBJECT,id);if(!rows.length)return Boolean((await this.context.records.artifacts.source(principal,id,{consumer:'model'}))?.bytes);for(const row of rows)if(await this.recordVisible(row,principal))return true;return false;}
 private async recordVisible(record:StoredRecord<ClaimBody>,principal:Principal):Promise<boolean>{
  const account=await this.context.records.principals.get(principal.id);if(!account||account.disabled)return false;const body=this.body(record);if(!body)return false;if(body.schema==='fed-note@1'&&principal.role!=='admin'&&body.by!==principal.id)return false;
  if(body.product&&!await this.reading.mayReadProducts(principal,[body.product]))return false;
  for(const digest of record.body.validity.bound){const original=await this.context.records.store.get<any>(digest);if(original?.kind!=='source_artifact'||original.body.sha256!==body.source?.bytes)continue;let source=await this.context.records.artifacts.source(principal,original.body.sha256,{consumer:'model',record:original.digest});const run=record.body.statement.data?.run;if(!source&&typeof run==='string'){const scoped=await this.context.records.artifacts.sourceForRun(principal,original.body.sha256,run,{consumer:'model',record:original.digest});if(scoped?.artifact.digest===original.digest)source=scoped;}return Boolean(source?.bytes&&source.readTier==='model_readable');}
  return false;
 }
 async entries(principal:Principal,product:string,offset=Number.MAX_SAFE_INTEGER):Promise<FeedingView[]>{const out:FeedingView[]=[];for(const row of await this.all('knowledge.feeding.product',product)){const body=this.body(row);if(!body||await this.position(row.digest)>offset||!await this.recordVisible(row,principal))continue;const retractions=[...await this.withdrawals(body.object,row.digest,typeof row.body.statement.data?.run==='string'?row.body.statement.data.run:null,row.body.validity.bound,offset),...await this.changed(body,offset)];out.push({record:row.digest,offset:await this.position(row.digest),body,claim:row.body,validity:retractions.length?'invalid':'valid',retractions});}return out;}
 private async withdrawals(id:string,entry:string,run:string|null=null,bound:readonly string[]=[],offset=Number.MAX_SAFE_INTEGER){
  const rows=await this.all(RETRACT,'1'),found:string[]=[];
  for(const row of rows){if(await this.position(row.digest)>offset)continue;const body=this.body(row);if(!body)continue;if(body.objects?.some((target:string)=>target===id||bound.includes(target))||body.entries?.some((target:string)=>target===entry||bound.includes(target))||run!==null&&body.runs?.includes(run))found.push(row.digest);}
  return [...new Set(found)];
 }
 private async retractionTargets(body:FeedingRetraction){for(const id of 'objects'in body?body.objects:[]){if(!(await this.all(OBJECT,id)).length)fail('撤回对象不存在；按喂入清单的对象摘要修正');}for(const id of 'entries'in body?body.entries:[]){const record=await this.context.records.store.get(id);if(!record||!this.body(record as StoredRecord<ClaimBody>)&&!(record.schema==='knowledge-contribution@1'&&object(record.body)&&typeof record.body.feeding_record==='string'))fail('撤回目标不是已登记的喂入或回注条目；按喂入清单中的记录摘要修正');}for(const id of 'runs'in body?body.runs:[]){if(!await runById(this.context.records.store,id))fail('撤回运行不存在');}}
 /** Same target check as retract, without appending. */
 async screenRetraction(principal:Principal,raw:unknown):Promise<void>{if(principal.role!=='admin')fail('只有管理员能追加撤回记录');const body=FeedingRetractionSchema.parse(raw);if(body.by!==principal.id||body.reason.includes('\n')||body.reason.includes('\r'))fail('撤回人或一行原因不合格');await this.retractionTargets(body);}
 /** Retraction records that already cover this target, using the same match as withdrawals. */
 async retractionCover(principal:Principal,kind:'entry'|'run'|'object',id:string):Promise<string[]>{
  if(principal.role!=='admin')fail('只有管理员能追加撤回记录');
  if(kind==='object')return this.withdrawals(id,'',null,[]);
  if(kind==='run')return this.withdrawals('','',id,[]);
  const stored=await this.context.records.store.get(id);if(!stored)return [];
  const claim=stored as StoredRecord<ClaimBody>;const feeding=this.body(claim);
  if(feeding){const data=claim.body.statement.data;const run=typeof data?.run==='string'?data.run:null;return this.withdrawals(typeof feeding.object==='string'?feeding.object:'',id,run,[...claim.body.validity.bound]);}
  if(stored.schema==='knowledge-contribution@1'&&object(stored.body)&&typeof stored.body.feeding_record==='string'){
   const child=await this.context.records.store.get<ClaimBody>(stored.body.feeding_record);const body=child?this.body(child):null;
   if(child&&body){const data=child.body.statement.data;const run=typeof data?.run==='string'?data.run:null;return this.withdrawals(typeof body.object==='string'?body.object:'',child.digest,run,[...child.body.validity.bound,id]);}
   return this.withdrawals('',id,null,[]);
  }
  return [];
 }
 async retract(principal:Principal,raw:unknown):Promise<string>{if(principal.role!=='admin')fail('只有管理员能追加撤回记录');const body=FeedingRetractionSchema.parse(raw);if(body.by!==principal.id||body.reason.includes('\n')||body.reason.includes('\r'))fail('撤回人或一行原因不合格');await this.retractionTargets(body);return this.context.records.store.withTransaction(async tx=>{await this.context.records.store.lock('knowledge.feeding.log',tx);return (await this.put(body,principal,'hub.retraction@1',[],[],'retraction:'+this.key(body),[{key:RETRACT,value:'1'}],tx)).digest;});}
 private async todoState(key:string,resolved:boolean,tx:Transaction){
  await this.context.records.store.lock('knowledge.feeding.todo:'+key,tx);
  const old=(await this.context.records.store.find<any>({key:'knowledge.feeding.todo.state',value:key,kind:'action',newestFirst:true,limit:1},tx)).items[0];if(old?.body.detail?.resolved===resolved)return;
  await this.context.records.store.put({kind:'action',schema:'action@1',provenance:'observed',body:{action:'read',run:null,item:null,component:'hub.feeding@1',inputs:old?['rec:'+old.digest]:[],lease:null,started_at:this.context.now().toISOString(),ended_at:this.context.now().toISOString(),result:'completed',error_code:null,acceptance:null,codes:[],detail:{key,resolved}},index:[{key:'knowledge.feeding.todo.state',value:key}]},tx);
 }
 async todos(principal:Principal):Promise<Array<Record<string,any>>>{if(principal.role!=='admin')return [];await this.refreshRetractionTodos();const rows=await this.context.store.all<any>({key:TODO,value:'1',kind:'action'}),out=[];for(const row of rows){const value=row.body.detail?.feeding_todo;if(!value)continue;const state=(await this.context.records.store.find<any>({key:'knowledge.feeding.todo.state',value:value.key,kind:'action',newestFirst:true,limit:1})).items[0];if(state?.body.detail?.resolved!==true){const latest=(await this.context.records.store.find<any>({key:'knowledge.feeding.todo.detail',value:value.key,kind:'action',newestFirst:true,limit:1})).items[0];out.push({record:row.digest,...value,...latest?.body.detail?.feeding_todo});}}return out;}
 private async originalSource(principal:Principal,body:Record<string,any>,scope:FeedingScope={}):Promise<Source>{
  if(body.schema==='fed-note@1')return this.uploadedSource(principal,body);
  if(operationRecord(body.schema)){const artifact=await this.operationArtifact(principal,body.source.bytes,scope.run??null,body.source.artifact);return this.source(principal,body.source.bytes,artifact.digest);}
  if(scope.sourceRecord)return this.source(principal,body.source.bytes,scope.sourceRecord,scope.readManifest);
  const native=await this.nativeObservation(principal,body);
  if(native)for(const digest of native.body.validity.bound){const record=await this.context.records.store.get<any>(digest);if(record?.kind==='source_artifact'&&record.body.sha256===body.source.bytes){const manifest=native.body.statement.data?.read_manifest;return this.source(principal,body.source.bytes,digest,typeof manifest==='string'?manifest:undefined);}}
  return this.source(principal,body.source.bytes,scope.sourceRecord,scope.readManifest);
 }
 private async bedInstalledBuild(runId:string|null):Promise<string|null>{
  if(!runId)return null;
  const effects=await this.context.records.store.find<any>({key:'effect.run',value:runId,kind:'effect',limit:20});
  const jobs=[...new Set(effects.items.map(row=>row.body?.job).filter((job):job is string=>typeof job==='string'))];
  const found=new Set<string>();
  for(const job of jobs){
    const events=await this.context.records.store.find<any>({key:'dispatch.job',value:job,kind:'action',limit:100});
    for(const event of events.items){const detail=event.body?.detail;if(detail?.phase!=='bed_snapshot'||typeof detail.installed_build!=='string'||detail.installed_build.length===0)continue;found.add(detail.installed_build);}
  }
  const run=await runById(this.context.records.store,runId);
  for(const build of bookedInstalls(run?.body))found.add(build);
  const predecessor=run?.body.predecessor;
  if(typeof predecessor==='string')for(const build of bookedInstalls((await runById(this.context.records.store,predecessor))?.body))found.add(build);
  return found.size===1?[...found][0]:null;
 }
 private async operationBinding(scope:FeedingScope):Promise<Record<string,unknown>>{
  const run=scope.run?await runById(this.context.records.store,scope.run):null;
  const claims=run?.body.target_basis??[];
  const valueOf=(field:string)=>{const data=claims.find(claim=>claim.statement?.data?.field===field)?.statement?.data;return typeof data?.value==='string'?data.value:null;};
  const locked=valueOf('build'),line=valueOf('version'),bed=await this.bedInstalledBuild(scope.run??null);
  if(locked&&bed&&locked!==bed)return {source:'conflict',run_lock:{build:locked,line},bed_installed:{build:bed,line:null}};
  if(bed)return {source:'bed_installed',build:bed,line};
  if(locked)return {source:'run_lock',build:locked,line};
  return {source:'undeclared',build:null,line:null,missing:'运行没有锁定构建，台架结构里也没有在装构建',next_action:'用锁定了构建的运行重交，或在台架结构里登记在装构建后再交；不要在提交里写版本'};
 }
 private async operationArtifact(principal:Principal,bytes:string,runId:string|null,requested?:unknown):Promise<SourceArtifact>{
  const candidates=(await this.context.records.artifacts.records(bytes)).filter(row=>'upload' in row.body.origin&&row.body.provenance_type==='client_captured'&&row.body.author.user!==null&&(row.body.author.user===principal.id||principal.role==='admin'));
  if(runId){
   const run=await runById(this.context.records.store,runId);
   const bound=run?.body.sources.filter(binding=>{
    if(typeof binding.artifact!=='string'||requested!==undefined&&binding.artifact!==requested)return false;
    const ref=parseReference(binding.reference);return ref.scheme==='src'&&ref.sha256===bytes;
   })??[];
   if(bound.length!==1)fail(bound.length>1&&requested===undefined?'同字节原件有多份绑定；从同一次上传回执填写 source.artifact 后重交，不能按摘要猜测':'操作记录必须唯一对应本次运行绑定的上传原件记录；重新绑定本次采集后重交');
   const artifact=candidates.find(row=>row.digest===bound[0].artifact);
   if(!artifact)fail('运行绑定的原件不是当前上传者有权使用的 client_captured 记录；重新上传本次采集后重交');
   return artifact;
  }
  const selected=requested===undefined?candidates[0]:candidates.find(row=>row.digest===requested);
  if(!selected)fail('操作记录的根据必须是当前上传者的 client_captured 原件；观察到的、投影的、声明的和候选的原件仍拒收');
  return selected;
 }
 private async completeOperation(principal:Principal,raw:unknown,scope:FeedingScope):Promise<unknown>{
  if(!object(raw)||!operationRecord(raw.schema))return raw;
  for(const key of ['binding','version','build','line','family','by','run','at','object','lease','lease_id','lease_unconfirmed','captured_at_declared','received_at'])if(key in raw){
   if(key==='lease'||key==='lease_id'||key==='lease_unconfirmed')fail(`提交写了 ${key}。租约由 Hub 填写，删掉该字段后重交；Hub 按上传者、声明采集时刻和收到时刻核对租约记录。`);
   fail(`提交写了 ${key}。操作记录的版本和采集事实只由 Hub 填写；缺的是运行锁定的构建或台架在装构建。删掉该字段后重交；这不是终局。`);
  }
  const bytes=object(raw.source)&&raw.source.system==='upload'&&typeof raw.source.bytes==='string'?raw.source.bytes:null;
  if(!bytes)fail('操作记录缺上传原件');
  const artifact=await this.operationArtifact(principal,bytes,scope.run??null,object(raw.source)?raw.source.artifact:undefined);
  const actor=artifact.body.author.user;
  if(actor===null)fail('操作记录的上传原件缺记录者');
  if(raw.product!==scope.product||raw.root!==(scope.root??null)||!scope.product||!scope.root)fail('操作记录必须挂在本次运行锁定的产品和根上');
  const device=await completeOperationDevice(this.context.records.store,{run:scope.run??null,device:raw.device,bed:raw.bed,user:actor,capturedAt:artifact.body.captured_at,receivedAt:artifact.created_at,captureTimeDeclared:artifact.body.captured_at_declared===true},this.context.leases);
  const resolved={...raw,source:{...raw.source as Record<string,unknown>,artifact:artifact.digest},...device};
  return {...resolved,object:sha256Hex(canonicalize(operationIdentity(resolved))),binding:await this.operationBinding(scope),by:actor,run:scope.run??null,at:artifact.body.captured_at_declared===true?artifact.body.captured_at:undefined,captured_at_declared:artifact.body.captured_at_declared===true,received_at:artifact.created_at};
 }
 private async checkOperation(body:Record<string,any>,source:{bytes:Uint8Array;artifact:{body:{provenance_type:string;origin:object}}}):Promise<void>{
  if(source.artifact.body.provenance_type!=='client_captured'||!('upload' in source.artifact.body.origin))fail('操作记录的根据必须是出处为 client_captured 的上传原件；其他出处仍拒收');
  let text:string;try{text=new TextDecoder('utf-8',{fatal:true}).decode(source.bytes);}catch{fail('上传原件不是完整 UTF-8，引文无法逐字核对；改交文本原件');}
  const quotes=operationQuotes(body);if(!quotes.length)fail('操作记录缺逐字引文');
  for(const quote of quotes){const ref=this.quoteRef(quote as never);if(ref.sha!==body.source.bytes)fail('引文必须出自这份上传原件，不能引用别的对象');if(!quoteMatches(text,quote.text))fail('引文没有逐字出自上传原件；改一个字也不收。用原件原文重交');}
 }
 async prepare(principal:Principal,raw:unknown,scope:FeedingScope&{classifications?:readonly string[];variables?:readonly {name:string;decision:string}[]}):Promise<Record<string,any>>{
  const filled=await this.completeOperation(principal,raw,scope);
  const scan=scanForCredentials(new TextEncoder().encode(canonicalize(filled)));if(!scan.inspected||scan.truncated||scan.findings.length)fail('喂入主张没有通过完整凭据防护扫描；管理员核对原件后修正重交');const checked=KnowledgeStructureSchema.safeParse(filled);if(!checked.success)fail('喂入结构不合格：'+checked.error.issues.map(issue=>issue.path.join('/')).join('、'));const body=checked.data as Record<string,any>;
  if(body.schema==='version-binding@1')fail('模型不能推断或提交版本绑定；绑定只由原始结构或包声明的用户参数生成');
  if(body.schema==='usage@1'||body.schema==='feeding-offset@1')fail('使用和冻结序号由 Hub 观察并填写，客户端不得自报');
  if(body.schema==='retraction@1'){if(principal.role!=='admin'||body.by!==principal.id||body.reason.includes('\n')||body.reason.includes('\r'))fail('撤回只允许管理员，并且原因必须是一行');await this.retractionTargets(FeedingRetractionSchema.parse(body));return body;}
  if(!object(body.source)||typeof body.source.bytes!=='string')fail('缺喂入原件');
  const source=await this.originalSource(principal,body,scope);
  if(body.schema==='fed-note@1'){
   if(!('upload'in source.artifact.body.origin)||source.artifact.body.author.user!==principal.id&&principal.role!=='admin')fail('声明来源只允许上传者和管理员');
   const written=await this.uploadNote(source.artifact.digest);
   const base=Object.fromEntries(Object.entries(body).filter(([key])=>!annotations.includes(key as never)));if(written===null||canonicalize(base)!==canonicalize(written))fail('上传对象的采集事实或摘要被改写');
  }else if(operationRecord(body.schema)){
   await this.checkOperation(body,source);
  }else{
   if(!source.external)fail('团队喂入对象必须来自 Hub 自己的连接器原件，上传不能伪装');
   if(body.product!==scope.product||body.root!==(scope.root??null))fail('投影产品与锁定树苗不一致');
   const base=Object.fromEntries(Object.entries(body).filter(([key])=>!annotations.includes(key as never)));
   const native=await this.nativeObservation(principal,base);
   if(!native){const projected=await this.projection(principal,source,scope),row=projected.rows.find(row=>row.body.object===body.object&&canonicalize(row.body.source)===canonicalize(body.source));if(!row)fail('对象摘要、出处或规范内容与原件投影不一致');if(canonicalize(base)!==canonicalize(row.body))fail('程序可填字段被改写；只能提出带引文的语义建议');}

  }
  const pack=scope.product?await this.context.packs.productById(scope.product):null;
  let classifications=scope.classifications;if(!classifications&&pack?.product.feeding?.classifications){const out=await callPackFunction({packDir:pack.directory,...pack.product.feeding.classifications},{},this.context.sandbox.producer,this.context.sandbox);if(!Array.isArray(out.output)||out.output.length>1000||out.output.some(value=>typeof value!=='string'))fail('产品包没有返回有界分类闭集');classifications=out.output;}
  const quoteCache=new Map<string,Awaited<ReturnType<typeof parseDocument>>>();
  const quoted:Array<{key:string;proposal:any}> = [];
  for(const key of annotations)for(const proposal of body[key]??[]){
   if(!object(proposal))fail('主张不是结构对象');
   quoted.push({key,proposal});
  }
  const selectors=new Map<string,string[]>();
  for(const {proposal} of quoted){
   let ref:{sha:string;parser:string;selector:string};
   try{ref=this.quoteRef(proposal.quote);}catch{continue;}
   const id=ref.sha+'\0'+ref.parser;const list=selectors.get(id)??[];list.push(ref.selector);selectors.set(id,list);
  }
  for(const [id,wanted] of selectors){
   try{
    const split=id.indexOf('\0'),sha=id.slice(0,split),parserId=id.slice(split+1);
    const bytes=await this.context.records.artifacts.source(principal,sha,{consumer:'model'});
    const parser=this.context.parsers.get(parserId);
    if(!bytes?.bytes||bytes.readTier!=='model_readable'||!parser)continue;
    const document=await parseDocument(parser,bytes.bytes);
    quoteCache.set(id,document);
    await document.prefetch?.(wanted);
   }catch{/* quote() reports the same missing source or parser */ }
  }
  for(const {key,proposal} of quoted){
   await this.quote(principal,proposal.quote,quoteCache);
   if(!['manual_link','command_link','case_link','relations'].includes(key)&&this.quoteRef(proposal.quote).sha!==body.source.bytes)fail('主张必须引用本对象原件，不能用兄弟或祖先代替');
   if(key==='classification'&&body.schema!=='fed-note@1'&&(!classifications||!classifications.includes(proposal.value)))fail('分类值不等于锁定包声明的闭集原文，或包未声明闭集');
   if(key==='manual_link'){
    if(proposal.root!==scope.root)fail('手册关联不在锁定树苗');const segments=pathSegments(proposal.path);if(segments[0]!=='manual'||!await this.reading.nodeAt(proposal.root,segments))fail('手册章节不能按锁定路径解析');
    const node=await this.reading.treeReader({composition:scope.composition??null}).read(proposal.root,proposal.path,null,{user:principal.id,role:principal.role}),q=this.quoteRef(proposal.quote);let owned=false;
    const matched=(node?.grounds??[]).flatMap(ground=>{try{const g=parseReference(ground);return g.scheme==='src'&&g.sha256===q.sha&&g.parser===q.parser&&g.selector===q.selector?[g]:[];}catch{return [];}});
    if(matched.length){const original=await this.context.records.artifacts.source(principal,q.sha,{consumer:'model'}),parsed=this.context.parsers.get(q.parser),cacheKey=q.sha+'\0'+q.parser;const document=original?.bytes&&original.readTier==='model_readable'&&parsed?(quoteCache.get(cacheKey)??await parseDocument(parsed,original.bytes)):null;if(document){quoteCache.set(cacheKey,document);await document.prefetch?.(matched.map(g=>g.selector!));for(const g of matched){const fragment=await document.locate(g.selector!);if(!fragment)continue;const text=g.range?fragment.text.slice(g.range[0],g.range[1]):fragment.text;if(text.includes(proposal.quote.text))owned=true;}}}if(!owned)fail('手册引文与目标章节没有精确来源对应');
   }
   if(key==='command_link'){
    if(!scope.root||!pack)fail('命令关联缺锁定树苗');const found=await this.root(principal,scope.product!,scope.root,scope.composition,scope.line);const seed=found.seed;const tree=seed.origin.find(origin=>origin.role==='command-tree');if(!tree)fail('树苗缺命令原件');const known=await this.context.store.node(seed.root);if(!known||proposal.command.tree_root!==tree.sha256)fail('命令身份不在锁定命令树');if(!await this.reading.nodeAt(seed.root,pathSegments(proposal.command.path)))fail('命令路径解析不出');const fn=pack.product.feeding?.verify_command;if(!fn)fail('产品包未声明完整命令核验回调');const original=await this.commandSource(principal,seed);const verified=await callPackFunction({packDir:pack.directory,...fn},{command:proposal.command,tree:{model:original.model,sha256:tree.sha256}},this.context.sandbox.producer,this.context.sandbox);if(!object(verified.output)||!verified.output.identity||canonicalize(verified.output.identity)!==canonicalize(proposal.command))fail('命令身份不能按锁定原树完整解析');
   }
   if(key==='relations'||key==='case_link'){if(proposal.object===body.object)fail('关系两端不能是同一对象');if(!await this.visible(proposal.object,principal))fail('关系目标不存在或当前不可读');}
   if(key==='applicability'){
    if(!scope.product||!scope.root)fail('适用条件缺锁定树苗');const found=await this.root(principal,scope.product,scope.root,scope.composition,scope.line);const seed=found.seed,composition=await this.context.store.composition(seed.composition);if(!composition?.applicability_context)fail('树苗没有冻结条件闭集');
    for(const field of Object.keys(proposal.value)){
     if(field==='memory'){const m=proposal.value.memory;if(!proposal.quote.text.includes(m.raw))fail('memory.raw 不是逐字引文');if(m.minimum&&m.maximum&&BigInt(m.minimum.bytes)+(m.minimum.inclusive?0n:1n)>BigInt(m.maximum.bytes)-(m.maximum.inclusive?0n:1n))fail('内存边界相互矛盾');continue;}
     if(field==='builds'){const known=new Set(composition.known_builds?.map(row=>row.name));if(proposal.value.builds.some((name:string)=>!known.has(name)))fail('构建条件不在冻结已知构建清单');continue;}
     const values=composition.applicability_context.closed_sets[field as keyof typeof composition.applicability_context.closed_sets];if(!values)fail('适用字段没有冻结闭集');const entries=Array.isArray(proposal.value[field])?proposal.value[field]:[...proposal.value[field].with??[],...proposal.value[field].without??[]];if(entries.some((value:string)=>!values.includes(value)))fail('适用值不等于冻结闭集原文');
    }
   }
  }
  return body;
 }
 private async nativeObservation(principal:Principal,body:Record<string,any>){for(const row of await this.all(OBJECT,body.object)){const value=this.body(row);if(!value||row.body.warrant.producer!=='function'||!await this.recordVisible(row,principal))continue;const base=Object.fromEntries(Object.entries(body).filter(([key])=>!annotations.includes(key as never)));if(canonicalize(value)===canonicalize(base))return row;}return null;}
 private async proofReadable(record:StoredRecord<ClaimBody>,principal:Principal){for(const proof of record.body.validity.bound){const original=await this.context.records.store.get<any>(proof);if(original?.kind==='source_artifact'&&(await this.context.records.artifacts.source(principal,original.body.sha256,{consumer:'model',record:proof}))?.bytes)return true;}return false;}
 async originalRecord(principal:Principal,body:Record<string,any>,scope:FeedingScope={}){return (await this.originalSource(principal,body,scope)).artifact.digest;}
 async appendPrepared(principal:Principal,body:Record<string,any>,scope:FeedingScope,model:string,tx:Transaction):Promise<string>{
  await this.context.records.store.lock('knowledge.feeding.log',tx);
  if(body.schema==='retraction@1')return (await this.put(body,principal,'hub.retraction@1',[],[],'retraction:'+this.key(body),[{key:RETRACT,value:'1'}],tx)).digest;
  const source=await this.originalSource(principal,body,scope);const quotes=annotations.flatMap(key=>(body[key]??[]).map((value:any)=>value.quote));
  const native=await this.nativeObservation(principal,body);
  if(!native&&body.schema!=='fed-note@1'&&!operationRecord(body.schema)){const projected=await this.projection(principal,source,scope),row=projected.rows.find(row=>row.body.object===body.object);if(!row)fail('缺规范内容；重新读取后重交');const stored=await this.context.records.objects.put(new TextEncoder().encode(canonicalize(row.identity)),'application/json');if(stored.sha256!==body.object)fail('规范内容摘要不一致');}
  const bound=[body.source.bytes,source.artifact.digest,...(native?[native.digest]:[]),...quotes.map(q=>this.quoteRef(q).sha),...(scope.root?[scope.root]:[])];
  const stored=await this.put(body,principal,model,['src:'+body.source.bytes],bound,'annotation:'+sha256Hex(canonicalize({body,actor:principal.id,model,run:scope.run??null})),[{key:OBJECT,value:body.object},{key:'knowledge.feeding.product',value:body.product??principal.id},{key:'knowledge.feeding.annotation',value:'1'}],tx,true,scope.run??null);await this.usage(principal,body.object,scope,tx);return stored.digest;
 }
 async admit(principal:Principal,payload:readonly unknown[],scope:FeedingScope&{classifications?:readonly string[]}):Promise<string[]>{const bodies:Record<string,any>[]=[];for(const raw of payload)bodies.push(await this.prepare(principal,raw,scope));return this.context.records.store.withTransaction(async tx=>{const refs=[];for(const body of bodies)refs.push(await this.appendPrepared(principal,body,scope,'client-declared-model',tx));return refs;});}
 async frozenOffset(run:string):Promise<number|null>{const row=(await this.context.records.store.find<FeedingOffset>({key:'knowledge.feeding.offset',value:run,kind:'claim',limit:1})).items[0];return row?.body.offset??null;}
 async cut(product:string,offset:number|null,principal?:Principal):Promise<FeedingCut|null>{
  if(!principal)return null;const ceiling=offset??Number.MAX_SAFE_INTEGER,entries=await this.entries(principal,product,ceiling);
  const objects=new Map<string,KnowledgeStructureObject>(),bindings=new Map<string,VersionBinding[]>(),retracted=new Set<string>(),contradicted=new Set<string>(),usages=[];
  for(const entry of entries){if(entry.validity==='invalid'){retracted.add(entry.body.object);continue;}const old=objects.get(entry.body.object);const relations=[...old?.relations??[],...entry.body.relations??[]];objects.set(entry.body.object,{...old,...entry.body,relations} as KnowledgeStructureObject);}
  for(const id of objects.keys()){retracted.delete(id);const rows=await this.all(BINDING,id),list:VersionBinding[]=[];for(const row of rows){if(await this.position(row.digest)>ceiling)continue;let readable=false;for(const proof of row.body.validity.bound){const original=await this.context.records.store.get<any>(proof);if(original?.kind==='source_artifact'&&(await this.context.records.artifacts.source(principal,original.body.sha256,{consumer:'model',record:proof}))?.bytes)readable=true;}const value=this.body(row);if(value&&readable)list.push(value as VersionBinding);}bindings.set(id,list);
   for(const row of await this.all('knowledge.feeding.usage.object',id)){if(await this.position(row.digest)>ceiling)continue;const value=this.body(row);if(!value)continue;const run=await runById(this.context.records.store,value.run);if(run&&await canViewRun(principal,run.body,this.context.records.store))usages.push(value as import('../../contracts/src/feeding.ts').FeedingUsage);}
   if(objects.get(id)!.relations?.some(relation=>relation.kind==='contradicts'))contradicted.add(id);
  }
  return entries.length?{offset,objects,bindings,retracted,contradicted,usages}:null;
 }
 async bindingsFor(principal:Principal,id:string,offset=Number.MAX_SAFE_INTEGER){if(!await this.visible(id,principal))return null;const rows=[];for(const record of await this.all(BINDING,id)){if(await this.position(record.digest)>offset||!await this.proofReadable(record,principal))continue;const body=this.body(record);if(body)rows.push({record:record.digest,body,claim:record.body});}const structure=rows.filter(row=>row.body.basis==='source_structure'),declared=rows.filter(row=>row.body.basis==='declared');return {items:rows.sort((a,b)=>Number(a.body.basis==='declared')-Number(b.body.basis==='declared')),conflict:rows.some(row=>row.body.state==='conflict')||declared.some(row=>{const same=structure.filter(source=>source.claim.validity.bound.length===row.claim.validity.bound.length&&source.claim.validity.bound.every((v,i)=>v===row.claim.validity.bound[i]));return same.some(source=>source.body.state==='bound')&&!same.some(source=>source.body.state==='bound'&&source.body.line===row.body.line);}),candidates:[...new Set(rows.flatMap(row=>row.body.state==='conflict'?row.body.candidates:row.body.line?[row.body.line]:[]))]};}
 async refreshRetractionTodos():Promise<void>{
  for(const record of await this.all('knowledge.feeding.annotation','1')){
   const actor=record.body.statement.data?.actor;if(typeof actor!=='string')continue;const user=await this.context.records.principals.get(actor);const tokens=await this.context.records.principals.tokens?.(actor);
   if(user&&!user.disabled&&tokens&&!tokens.some(token=>token.revoked_at!==null))continue;
   const by=this.context.admin;if(!by)continue;
   await this.context.records.store.withTransaction(async tx=>{await this.todo(by,{system:'feeding-annotation',document:record.digest},null,user?.disabled?'回注账号已停用':tokens?'该账号存在已吊销令牌，需核对这条回注的令牌来源':'回注账号或令牌状态尚未核对','管理员核对后按记录追加 retraction；不自动删除或裁决',tx);});
  }
 }

 async readRecord(digest:string,principal:Principal):Promise<StoredRecord|null>{
  const record=await this.context.records.store.get<ClaimBody>(digest);if(!record||!Claim.safeParse(record.body).success)return null;const key=record.body.statement.data?.key;if(typeof key!=='string')return null;
  const owned=await this.context.records.store.find({key:'knowledge.feeding.key',value:key,kind:'claim',limit:500});if(!owned.items.some(row=>row.digest===digest))return null;
  const body=this.body(record);if(!body)return null;if(body.source)return await this.recordVisible(record,principal)?record:null;
  if(body.schema==='usage@1'){const run=await runById(this.context.records.store,body.run);if(!run||!await canViewRun(principal,run.body,this.context.records.store))return null;}
  if(body.schema==='version-binding@1'&&!await this.proofReadable(record,principal))return null;
  if(body.object&&!await this.visible(body.object,principal))return null;
  return principal.role==='admin'||body.object?record:null;
 }
 async recordState(digest:string,principal:Principal,parent?:string){const record=await this.readRecord(digest,principal) as StoredRecord<ClaimBody>|null;if(!record)return null;const body=this.body(record)!;const retractions=[...await this.withdrawals(body.object??'',digest,record.body.statement.data?.run as string|null,[...record.body.validity.bound,...(parent?[parent]:[])]),...await this.changed(body)];return {validity:retractions.length?'invalid':'valid',retractions};}

}

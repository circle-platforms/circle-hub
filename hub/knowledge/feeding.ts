import {runById,canViewRun} from '../runs/api.ts';
import {pathSegments} from '../refs/api.ts';
// Append-only feeding beside immutable tree content. The record insertion sequence is the frozen horizon (gaps are valid).
import {Claim,type Claim as ClaimBody} from '../../contracts/src/claim.ts';
import {KnowledgeStructureSchema,FeedingRetractionSchema,type FeedingRetraction,type VersionBinding,type FeedingOffset} from '../../contracts/src/feeding.ts';
import type {FeedingQuote as QuoteEvidence} from '../../contracts/generated/shared-interfaces.ts';
import {parseReference,parserKey,recognize} from '../refs/api.ts';
import {parseExternal} from '../connectors/api.ts';
import {canonicalize,sha256Hex,type Principal,type Transaction,type StoredRecord,type SourceArtifact} from '../records/api.ts';
import {callPackFunction} from '../rules/api.ts';
import {SeedlingBody} from '../../contracts/src/knowledge.ts';
import type {KnowledgeContext} from './context.ts';
import type {TreeReading} from './read.ts';
import {seedlingOfRoot,currentSeedling,seedlingRecord} from './seedling.ts';
import {KnowledgeError} from './errors.ts';
const LOG='knowledge.feeding.log',OBJECT='knowledge.feeding.object',USAGE='knowledge.feeding.usage',BINDING='knowledge.feeding.binding',RETRACT='knowledge.feeding.retraction',TODO='knowledge.feeding.todo';
const object=(v:unknown):v is Record<string,any>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const annotations=['classification','manual_link','relations','applicability','correction','command_link','case_link','paragraph'] as const;
function fail(message:string):never{throw new KnowledgeError(message+'；修正原件或按生成结构修正整份提交后重交，不能猜测补值',{code:'SUBMISSION_SCHEMA_VIOLATION'});}
export interface FeedingScope {product?:string|null;root?:string|null;run?:string|null;line?:string|null;meta?:Record<string,unknown>|null;metaSource?:string;sourceRecord?:string;requested?:string;declaredLine?:string|null;}
export interface FeedingReceipt {objects:string[];offset:number;pending:Array<{source:string;missing:string;next_action:string}>;}
export interface FeedingView {record:string;offset:number;body:Record<string,any>;claim:ClaimBody;validity:'valid'|'invalid';retractions:string[];}
interface Projection {body:Record<string,any>;identity:unknown;lines:string[];selector:string;grammar:string;conflict:boolean;}
interface Source {artifact:SourceArtifact;bytes:Uint8Array;parser:string;model:unknown;external:ReturnType<typeof parseExternal>;}
export class FeedingLayer {
 readonly context:KnowledgeContext;readonly reading:TreeReading;
 constructor(context:KnowledgeContext,reading:TreeReading){this.context=context;this.reading=reading;}
 async offset(tx?:Transaction):Promise<number>{const page=await this.context.records.store.find({key:LOG,value:'1',kind:'claim',limit:1,newestFirst:true},tx);if(!page.items.length)return 0;return this.position(page.items[0].digest,tx);}
 private async position(digest:string,tx?:Transaction){const n=await this.context.records.store.position?.(digest,tx);if(n===undefined||n===null)throw new KnowledgeError('缺记录追加序号能力；管理员恢复记录库后重试',{code:'SOURCE_UNAVAILABLE'});return n;}
 private async all(key:string,value:string,tx?:Transaction){return this.context.store.all<ClaimBody>({key,value,kind:'claim'},tx);}
 private body(record:StoredRecord<ClaimBody>):Record<string,any>|null{const claim=Claim.safeParse(record.body);if(!claim.success||!object(claim.data.statement.data))return null;return KnowledgeStructureSchema.safeParse(claim.data.statement.data.feeding??claim.data.statement.data).data as Record<string,any>??null;}
 private async origin(principal:Principal,artifact:SourceArtifact,seen=new Set<string>()):Promise<ReturnType<typeof parseExternal>>{
  if(seen.has(artifact.digest)||seen.size>=32)fail('原件血缘成环或超界');seen.add(artifact.digest);const body=artifact.body;
  if(body.author.user!==null||body.provenance_type==='declared'||body.provenance_type==='candidate')return null;
  if('read'in body.origin)return parseExternal(body.origin.read.object);
  if(!('generated'in body.origin))return null;
  let found:ReturnType<typeof parseExternal>=null;
  for(const ref of body.origin.generated.inputs){const parsed=parseReference(ref);if(parsed.scheme!=='src')continue;const source=await this.context.records.artifacts.source(principal,parsed.sha256,{consumer:'function'});if(!source?.bytes)fail('原件血缘来源不可读');const next=await this.origin(principal,source.artifact,new Set(seen));if(next){if(found&&found.id!==next.id)fail('原件有多个不同的身份来源，不能挑一条');found=next;}}
  return found;
 }
 private async source(principal:Principal,sha:string,record?:string):Promise<Source>{
  const found=await this.context.records.artifacts.source(principal,sha,{consumer:'function',...(record?{record}:{})});if(!found?.bytes||found.readTier!=='model_readable')fail('来源不存在、保留中或当前不可读');
  const parsed=recognize(this.context.parsers,found.bytes,found.mediaType);if(!parsed)fail('来源格式不能按已声明解析器读取');
  return {artifact:found.artifact,bytes:found.bytes,parser:parserKey(parsed.parser),model:parsed.document.model,external:await this.origin(principal,found.artifact)};
 }
 private quoteRef(quote:QuoteEvidence){return 'identity'in quote?{sha:quote.identity.source_sha256,parser:quote.identity.parser,selector:quote.identity.path,span:quote.identity.span,range:null}:{...(()=>{const ref=parseReference(quote.reference);if(ref.scheme!=='src'||!ref.parser||!ref.selector)fail('喂入引文必须是带解析器和选择器的 src 引用');return {sha:ref.sha256,parser:ref.parser,selector:ref.selector,range:ref.range??null};})(),span:null};}
 async quote(principal:Principal,quote:QuoteEvidence):Promise<void>{
  const ref=this.quoteRef(quote),source=await this.context.records.artifacts.source(principal,ref.sha,{consumer:'model'});if(!source?.bytes||source.readTier!=='model_readable')fail('引文原件不存在或当前不可读');
  const parser=this.context.parsers.get(ref.parser);if(!parser)fail('引文解析器版本不存在');const fragment=parser.parse(source.bytes).locate(ref.selector);if(!fragment)fail('引文选择器不能解析');
  if(ref.span){const range=fragment.byteRange??(ref.parser==='json@1'&&ref.selector==='p'?[0,source.bytes.byteLength]:null);if(!range)fail('该解析器没有原始范围；改用生成的 source+selector 逐字引用，不得猜 byte span');const end=ref.span.offset+ref.span.length;if(ref.span.offset<range[0]||end>range[1])fail('引文跨度不在原始片段中');let text:string;try{text=new TextDecoder('utf-8',{fatal:true}).decode(source.bytes.slice(ref.span.offset,end));}catch{fail('引文不是完整 UTF-8 字节');}if(text!==quote.text)fail('引文不是原件逐字内容');}
  else {const text=ref.range?fragment.text.slice(ref.range[0],ref.range[1]):fragment.text;if(!text.includes(quote.text))fail('引文不是选择器原文的逐字片段');}
 }

 async seedFor(product:string,line:string){
  const record=await currentSeedling(this.context,product,line);if(record){const direct=await seedlingRecord(this.context,record);if(direct)return direct;const ref=await seedlingOfRoot(this.context,product,record);if(ref)return seedlingRecord(this.context,ref);}
  const pack=await this.context.packs.productById(product),fn=pack?.product.feeding?.normalize_line;if(!pack||!fn)return null;
  const normalize=async(line:string)=>{const result=await callPackFunction({packDir:pack.directory,...fn},{line},this.context.sandbox.producer,this.context.sandbox);return object(result.output)&&typeof result.output.line==='string'?result.output.line:null;};
  const canonical=await normalize(line);if(canonical===null)return null;const candidates=[];
  for(const pointer of await this.context.records.pointers.list('seedling/'+product+'/')){if(!pointer.target)continue;const ref=await seedlingOfRoot(this.context,product,pointer.target);const seed=await seedlingRecord(this.context,ref??pointer.target);if(seed&&await normalize(seed.line)===canonical)candidates.push(seed);}
  if(new Set(candidates.map(seed=>seed.root)).size>1)fail('同一规范版本线存在冲突树苗，管理员核对后重试');return candidates[0]??null;
 }
 private async seed(product:string,line:string){const seed=await this.seedFor(product,line);if(!seed)throw new KnowledgeError('版本线 '+line+' 没有树苗；管理员先育苗，再重读原件',{code:'REFERENCE_UNRESOLVED'});return seed;}

 private async root(principal:Principal,product:string,root:string){if(!await this.reading.mayReadRoot(principal,root))fail('锁定树苗不存在或当前不可读');const record=await seedlingOfRoot(this.context,product,root);const seed=record?await seedlingRecord(this.context,record):null;if(!seed)throw new KnowledgeError('锁定根不是本产品的树苗；管理员先育苗后开新运行',{code:'REFERENCE_UNRESOLVED'});return seed;}
 private async projection(principal:Principal,source:Source,scope:FeedingScope):Promise<{rows:Projection[];pack:string;digest:string}>{
  if(!scope.product) return {rows:[],pack:'hub.feeding@1',digest:source.artifact.digest};
  const pack=await this.context.packs.productById(scope.product);if(!pack?.product.feeding)return {rows:[],pack:'hub.feeding@1',digest:source.artifact.digest};
  if(!await this.reading.mayReadProducts(principal,[scope.product]))fail('产品当前不可读');let tree:Record<string,unknown>|null=null;
  let meta:Record<string,unknown>|null=null;
  if(scope.metaSource){const original=await this.source(principal,scope.metaSource);if(!source.external||original.external?.id!==source.external.id)fail('目录元数据与本次原件不是同一来源');if(!object(original.model))fail('目录元数据不是结构对象');meta=original.model;}
  const project=async()=>await callPackFunction({packDir:pack.directory,...pack.product.feeding!.project},{product:scope.product,root:scope.root??null,model:source.model,meta,parser:source.parser,tree,source:{system:source.external?.system,type:source.external?.type,key:source.external?.key,revision:source.external?.revision,external:source.external?.id,bytes:source.artifact.body.sha256}},this.context.sandbox.producer,this.context.sandbox);
  let result=await project();
  if(!object(result.output)||!Array.isArray(result.output.rows)||result.output.rows.length>10000)fail('产品包喂入投影没有给出有界结构对象');
  if(result.output.rows.length&&scope.root){
  if(scope.root){const seed=await this.root(principal,scope.product,scope.root);const origin=seed.origin.find(row=>row.role==='command-tree');if(origin){const original=await this.source(this.context.admin??principal,origin.sha256);if(original.parser!=='xml@1')fail('锁定命令树不是原始 XML');tree={model:original.model,sha256:origin.sha256};}}
   result=await project();if(!object(result.output)||!Array.isArray(result.output.rows))fail('产品包喂入投影结构不完整');
  }
  const rows=result.output.rows as Projection[];
  for(const row of rows){if(!object(row.body)||!Array.isArray(row.lines)||row.lines.some(line=>typeof line!=='string')||typeof row.selector!=='string'||typeof row.grammar!=='string'||typeof row.conflict!=='boolean')fail('产品包喂入行结构不完整');row.body={...row.body,object:sha256Hex(canonicalize(row.identity))};if(!KnowledgeStructureSchema.safeParse(row.body).success)fail('原件投影不合 knowledge-structure@1；修正类型或缺失字段');for(const line of row.lines)await this.seed(scope.product!,line);}
  return {rows,pack:pack.id+'@'+pack.version,digest:pack.digest};
 }
 private claim(body:Record<string,any>,by:Principal,warrant:string,grounds:string[],bound:string[],judgment=false,run:string|null=null,key=''):ClaimBody{return Claim.parse({statement:{text:judgment?'客户端带原文引文的喂入主张；语义仍为判断':'按原件结构登记喂入事实',data:{feeding:body,actor:by.id,run,key}},grounds,warrant:{producer:judgment?'model':'function',id:warrant,independence:'judge_not_author'},qualifier:{nature:judgment?'judgment':'fact',provenance:body.schema==='fed-note@1'||body.basis==='declared'?'declared':judgment?'declared':'projected',basis_rank:body.basis==='declared'?'rule_over_claims':judgment?'judgment':'rule_over_observation',marks:[]},validity:{status:'valid',bound:[...new Set(bound)],premises:[]}});}
 private async put(body:Record<string,any>,by:Principal,warrant:string,grounds:string[],bound:string[],key:string,index:Array<{key:string;value:string}>,tx:Transaction,judgment=false,run:string|null=null){return this.context.records.store.put({kind:'claim',schema:'claim@1',provenance:body.schema==='usage@1'?'observed':judgment||body.schema==='fed-note@1'?'declared':'projected',body:this.claim(body,by,warrant,grounds,bound,judgment,run,key),unique_key:'feeding:'+key,index:[{key:LOG,value:'1'},{key:'knowledge.feeding.actor',value:by.id},{key:'knowledge.feeding.key',value:key},...index]},tx);}
 private key(body:Record<string,any>){const {at:_at,...withoutTime}=body;return sha256Hex(canonicalize(withoutTime));}
 private async usage(principal:Principal,id:string,scope:FeedingScope,tx:Transaction){if(!scope.run)return;const body={schema:'usage@1',object:id,run:scope.run,line:scope.line??null,at:this.context.now().toISOString()};await this.put(body,principal,'hub.feeding@1',[],[id],`usage:${scope.run}:${id}`,[{key:USAGE,value:scope.run},{key:'knowledge.feeding.usage.object',value:id}],tx,false,scope.run);}
 private async todo(principal:Principal,source:Record<string,any>,product:string|null,missing:string,next:string,tx:Transaction){
  const {bytes:_bytes,revision:_revision,...identity}=source;const key=sha256Hex(canonicalize({product,identity}));
  await this.todoState(key,false,tx);
  await this.context.records.store.put({kind:'action',schema:'action@1',provenance:'observed',unique_key:'feeding.todo:'+key,body:{action:'read',run:null,item:null,component:'hub.feeding@1',inputs:[],lease:null,started_at:this.context.now().toISOString(),ended_at:this.context.now().toISOString(),result:'completed',error_code:null,acceptance:null,codes:[],detail:{feeding_todo:{key,product,source:identity,missing,next_action:next,by:principal.id}}},index:[{key:TODO,value:'1'},{key:'knowledge.feeding.todo.key',value:key}]},tx);
 }
 private async bindings(principal:Principal,row:Projection,source:Source,scope:FeedingScope,tx:Transaction){
  const candidates=[...new Set(row.lines)],line=candidates.length===1?candidates[0]:null;
  const evidenceSource=scope.metaSource?await this.source(principal,scope.metaSource):source;
  const evidenceParser=scope.metaSource?'json@1':evidenceSource.parser,evidenceSelector=scope.metaSource?'p/directory_labels':row.selector;
  let fragment=this.context.parsers.get(evidenceParser)!.parse(evidenceSource.bytes).locate(evidenceSelector);
  let selector=evidenceSelector,parser=evidenceParser;if(!fragment?.text){parser='json@1';selector='p';fragment=this.context.parsers.get(parser)!.parse(evidenceSource.bytes).locate(selector);}if(!fragment?.text)fail('绑定来源片段不存在或为空');
  const evidence={reference:'src:'+evidenceSource.artifact.body.sha256+'/'+parser+'/'+selector,text:fragment.text};
  const make=(value:string|null,state:'bound'|'undeclared'|'conflict')=>({schema:'version-binding@1',object:row.body.object,product:scope.product,line:value,basis:'source_structure',grounds:{quote:evidence,grammar:row.grammar},state,candidates:state==='conflict'?candidates:[],...(state==='undeclared'?{missing:'原始目录或结构字段没有版本声明',next_action:'维护者补结构版本；下一次读取自动登记；运行目标不能补绑定'}:{})});
  const bodies=candidates.length?(row.conflict?[make(null,'conflict')]:candidates.map(value=>make(value,'bound'))):[make(null,'undeclared')];
  if(scope.declaredLine){await this.seed(scope.product!,scope.declaredLine);bodies.push({schema:'version-binding@1',object:row.body.object,product:scope.product,line:scope.declaredLine,basis:'declared',grounds:{by:principal.id,run:scope.run},state:'bound',candidates:[]} as never);}
  for(const body of bodies){if(!KnowledgeStructureSchema.safeParse(body).success)fail('绑定结构不合格');await this.put(body,principal,'hub.feeding@1',['src:'+source.artifact.body.sha256],[source.artifact.body.sha256,source.artifact.digest,...(scope.metaSource?[scope.metaSource]:[]),...(scope.root?[scope.root]:[])],'binding:'+this.key(body)+':'+source.artifact.digest+':'+(scope.metaSource??'')+':'+(scope.run??''),[{key:BINDING,value:row.body.object}],tx,false,scope.run??null);}
  if(!candidates.length||row.conflict)await this.todo(principal,row.body.source,scope.product!,row.conflict?'目录存在冲突版本层':'版本未声明','维护者修正目录后再次读取；不在运行中问人、不推送',tx);
  else {const {bytes:_bytes,revision:_revision,...identity}=row.body.source;await this.todoState(sha256Hex(canonicalize({product:scope.product,identity})),true,tx);}
 }
 async sourceLines(principal:Principal,sha:string,scope:FeedingScope):Promise<string[]>{const source=await this.source(principal,sha,scope.sourceRecord);const projected=await this.projection(principal,source,{...scope,root:null});return [...new Set(projected.rows.flatMap(row=>row.lines))];}
 async observeSource(principal:Principal,sha:string,scope:FeedingScope={}):Promise<FeedingReceipt>{
  const source=await this.source(principal,sha,scope.sourceRecord),pending:FeedingReceipt['pending']=[];
  if('upload'in source.artifact.body.origin){return this.upload(principal,source.artifact,scope);}
  let projection:Awaited<ReturnType<FeedingLayer['projection']>>;
  try{projection=await this.projection(principal,source,scope);}catch(error){if(!(error instanceof KnowledgeError)||error.code!=='REFERENCE_UNRESOLVED')throw error;const missing=error.message,next='管理员先育苗或恢复锁定树苗，再重读该来源；不把运行目标当绑定';await this.context.records.store.withTransaction(async tx=>{await this.context.records.store.lock('knowledge.feeding.log',tx);await this.usage(principal,sha,scope,tx);await this.todo(principal,{system:source.external?.system??'unknown',document:source.external?.key??sha},scope.product??null,missing,next,tx);});return {objects:[],offset:await this.offset(),pending:[{source:sha,missing,next_action:next}]};}
  const ids=projection.rows.map(row=>row.body.object as string);
  await this.context.records.store.withTransaction(async tx=>{await this.context.records.store.lock('knowledge.feeding.log',tx);
   if(!projection.rows.length){await this.usage(principal,sha,scope,tx);return;}
   for(const row of projection.rows){const bytes=new TextEncoder().encode(canonicalize(row.identity));const stored=await this.context.records.objects.put(bytes,'application/json');if(stored.sha256!==row.body.object)fail('规范内容摘要不一致');await this.put(row.body,principal,projection.pack,['src:'+sha],[sha,source.artifact.digest,...(scope.metaSource?[scope.metaSource]:[]),projection.digest,...(scope.root?[scope.root]:[])],'object:'+this.key(row.body)+':'+source.artifact.digest+':'+(scope.run??''),[{key:OBJECT,value:row.body.object},{key:'knowledge.feeding.product',value:scope.product!}],tx,false,scope.run??null);await this.bindings(principal,row,source,scope,tx);if(scope.sourceRecord&&scope.requested&&parseExternal(scope.requested)?.revision===null)await this.sourceHead(row.body,source,tx);await this.usage(principal,row.body.object,scope,tx);}
  });return {objects:ids,offset:await this.offset(),pending};
 }
 private sourceKey(body:Record<string,any>){if(!body.source||body.schema==='fed-note@1')return null;const {bytes:_bytes,revision:_revision,...identity}=body.source;return sha256Hex(canonicalize({product:body.product,identity}));}
 private async sourceHead(body:Record<string,any>,source:Source,tx:Transaction){const key=this.sourceKey(body);if(!key)return;await this.context.records.store.lock('knowledge.feeding.head:'+key,tx);const old=(await this.context.records.store.find<any>({key:'knowledge.feeding.head',value:key,kind:'action',limit:1,newestFirst:true},tx)).items[0];if(old?.body.detail?.object===body.object)return;await this.context.records.store.put({kind:'action',schema:'action@1',provenance:'observed',body:{action:'read',run:null,item:null,component:'hub.feeding@1',inputs:['src:'+source.artifact.body.sha256],lease:null,started_at:this.context.now().toISOString(),ended_at:this.context.now().toISOString(),result:'completed',error_code:null,acceptance:null,codes:[],detail:{object:body.object,source_record:source.artifact.digest,parent:old?.digest??null}},index:[{key:'knowledge.feeding.head',value:key}]},tx);}
 private async changed(body:Record<string,any>){const key=this.sourceKey(body);if(!key)return [];const head=(await this.context.records.store.find<any>({key:'knowledge.feeding.head',value:key,kind:'action',limit:1,newestFirst:true})).items[0];return head&&head.body.detail?.object!==body.object?[head.digest]:[];}
 async upload(principal:Principal,artifact:SourceArtifact,scope:FeedingScope={}):Promise<FeedingReceipt>{
  if(!('upload'in artifact.body.origin)||artifact.body.author.user===null||artifact.body.author.user!==principal.id&&principal.role!=='admin')fail('上传出处必须是当前上传者的 Hub 原件');
  const body={schema:'fed-note@1',object:artifact.body.sha256,product:null,root:null,path:null,source:{system:'upload',bytes:artifact.body.sha256},by:artifact.body.author.user,run:null,at:artifact.body.captured_at};
  await this.context.records.store.withTransaction(async tx=>{await this.context.records.store.lock('knowledge.feeding.log',tx);await this.put(body,principal,'hub.upload@1',['src:'+artifact.body.sha256],[artifact.body.sha256,artifact.digest],'note:'+artifact.digest,[{key:OBJECT,value:body.object},{key:'knowledge.feeding.product',value:principal.id}],tx,false,scope.run??null);await this.usage(principal,body.object,scope,tx);});return {objects:[body.object],offset:await this.offset(),pending:[]};
 }
 async freeze(principal:Principal,run:string,root:string|null):Promise<FeedingOffset>{return this.context.records.store.withTransaction(async tx=>{await this.context.records.store.lock('knowledge.feeding.log',tx);const body={schema:'feeding-offset@1',run,root,offset:await this.offset(tx)} as const;const stored=await this.context.records.store.put({kind:'claim',schema:'feeding-offset@1',provenance:'observed',body,unique_key:'feeding.freeze:'+run,index:[{key:'knowledge.feeding.freeze',value:run}]},tx);return stored.body;});}
 async usages(principal:Principal,run:string):Promise<string[]>{const owned=await runById(this.context.records.store,run);if(!owned||!await canViewRun(principal,owned.body,this.context.records.store))return [];const rows=await this.all(USAGE,run);const out:string[]=[];for(const row of rows){const body=this.body(row);if(body&&await this.visible(body.object,principal))out.push(body.object);}return [...new Set(out)];}
 private async visible(id:string,principal:Principal):Promise<boolean>{const rows=await this.all(OBJECT,id);if(!rows.length)return Boolean((await this.context.records.artifacts.source(principal,id,{consumer:'model'}))?.bytes);for(const row of rows)if(await this.recordVisible(row,principal))return true;return false;}
 private async recordVisible(record:StoredRecord<ClaimBody>,principal:Principal):Promise<boolean>{
  const body=this.body(record);if(!body)return false;if(body.schema==='fed-note@1'&&principal.role!=='admin'&&body.by!==principal.id)return false;
  if(body.product&&!await this.reading.mayReadProducts(principal,[body.product]))return false;
  for(const digest of record.body.validity.bound){const original=await this.context.records.store.get<any>(digest);if(original?.kind!=='source_artifact'||original.body.sha256!==body.source?.bytes)continue;const source=await this.context.records.artifacts.source(principal,original.body.sha256,{consumer:'model',record:original.digest});return Boolean(source?.bytes&&source.readTier==='model_readable');}
  return false;
 }
 async entries(principal:Principal,product:string,offset=Number.MAX_SAFE_INTEGER):Promise<FeedingView[]>{const out:FeedingView[]=[];for(const row of await this.all('knowledge.feeding.product',product)){const body=this.body(row);if(!body||await this.position(row.digest)>offset||!await this.recordVisible(row,principal))continue;const retractions=[...await this.withdrawals(body.object,row.digest,typeof row.body.statement.data?.run==='string'?row.body.statement.data.run:null,row.body.validity.bound),...await this.changed(body)];out.push({record:row.digest,offset:await this.position(row.digest),body,claim:row.body,validity:retractions.length?'invalid':'valid',retractions});}return out;}
 private async withdrawals(id:string,entry:string,run:string|null=null,bound:readonly string[]=[]){
  const rows=await this.all(RETRACT,'1'),found:string[]=[];
  for(const row of rows){const body=this.body(row);if(!body)continue;if(body.objects?.some((target:string)=>target===id||bound.includes(target))||body.entries?.some((target:string)=>target===entry||bound.includes(target))||run!==null&&body.runs?.includes(run))found.push(row.digest);}
  return [...new Set(found)];
 }
 private async retractionTargets(body:FeedingRetraction){for(const id of 'objects'in body?body.objects:[]){if(!(await this.all(OBJECT,id)).length)fail('撤回对象不存在；按喂入清单的对象摘要修正');}for(const id of 'entries'in body?body.entries:[]){const record=await this.context.records.store.get(id);if(!record)fail('撤回记录不存在');}for(const id of 'runs'in body?body.runs:[]){if(!await runById(this.context.records.store,id))fail('撤回运行不存在');}}
 async retract(principal:Principal,raw:unknown):Promise<string>{if(principal.role!=='admin')fail('只有管理员能追加撤回记录');const body=FeedingRetractionSchema.parse(raw);if(body.by!==principal.id||body.reason.includes('\n')||body.reason.includes('\r'))fail('撤回人或一行原因不合格');await this.retractionTargets(body);return this.context.records.store.withTransaction(async tx=>{await this.context.records.store.lock('knowledge.feeding.log',tx);return (await this.put(body,principal,'hub.retraction@1',[],[],'retraction:'+this.key(body),[{key:RETRACT,value:'1'}],tx)).digest;});}
 private async todoState(key:string,resolved:boolean,tx:Transaction){
  await this.context.records.store.lock('knowledge.feeding.todo:'+key,tx);
  const old=(await this.context.records.store.find<any>({key:'knowledge.feeding.todo.state',value:key,kind:'action',newestFirst:true,limit:1},tx)).items[0];if(old?.body.detail?.resolved===resolved)return;
  await this.context.records.store.put({kind:'action',schema:'action@1',provenance:'observed',body:{action:'read',run:null,item:null,component:'hub.feeding@1',inputs:old?['rec:'+old.digest]:[],lease:null,started_at:this.context.now().toISOString(),ended_at:this.context.now().toISOString(),result:'completed',error_code:null,acceptance:null,codes:[],detail:{key,resolved}},index:[{key:'knowledge.feeding.todo.state',value:key}]},tx);
 }
 async todos(principal:Principal):Promise<Array<Record<string,any>>>{if(principal.role!=='admin')return [];await this.refreshRetractionTodos();const rows=await this.context.store.all<any>({key:TODO,value:'1',kind:'action'}),out=[];for(const row of rows){const value=row.body.detail?.feeding_todo;if(!value)continue;const state=(await this.context.records.store.find<any>({key:'knowledge.feeding.todo.state',value:value.key,kind:'action',newestFirst:true,limit:1})).items[0];if(state?.body.detail?.resolved!==true)out.push({record:row.digest,...value});}return out;}
 async prepare(principal:Principal,raw:unknown,scope:FeedingScope&{classifications?:readonly string[];variables?:readonly {name:string;decision:string}[]}):Promise<Record<string,any>>{
  const checked=KnowledgeStructureSchema.safeParse(raw);if(!checked.success)fail('喂入结构不合格：'+checked.error.issues.map(issue=>issue.path.join('/')).join('、'));const body=checked.data as Record<string,any>;
  if(body.schema==='version-binding@1')fail('模型不能推断或提交版本绑定；绑定只由原始结构或包声明的用户参数生成');
  if(body.schema==='usage@1'||body.schema==='feeding-offset@1')fail('使用和冻结序号由 Hub 观察并填写，客户端不得自报');
  if(body.schema==='retraction@1'){if(principal.role!=='admin'||body.by!==principal.id||body.reason.includes('\n')||body.reason.includes('\r'))fail('撤回只允许管理员，并且原因必须是一行');await this.retractionTargets(FeedingRetractionSchema.parse(body));return body;}
  if(!object(body.source)||typeof body.source.bytes!=='string')fail('缺喂入原件');
  const source=await this.source(principal,body.source.bytes);
  if(body.schema==='fed-note@1'){
   if(!('upload'in source.artifact.body.origin)||source.artifact.body.author.user!==principal.id&&principal.role!=='admin')fail('声明来源只允许上传者和管理员');
   const expected={schema:'fed-note@1',object:source.artifact.body.sha256,product:null,root:null,path:null,source:{system:'upload',bytes:source.artifact.body.sha256},by:source.artifact.body.author.user,run:null,at:source.artifact.body.captured_at};
   const base=Object.fromEntries(Object.entries(body).filter(([key])=>!annotations.includes(key as never)));if(canonicalize(base)!==canonicalize(expected))fail('上传对象的采集事实或摘要被改写');
  }else{
   if(!source.external)fail('团队喂入对象必须来自 Hub 自己的连接器原件，上传不能伪装');
   if(body.product!==scope.product||body.root!==(scope.root??null))fail('投影产品与锁定树苗不一致');
   const projected=await this.projection(principal,source,scope),native=projected.rows.find(row=>row.body.object===body.object&&canonicalize(row.body.source)===canonicalize(body.source));
   if(!native)fail('对象摘要、出处或规范内容与原件投影不一致');
   const base=Object.fromEntries(Object.entries(body).filter(([key])=>!annotations.includes(key as never)));if(canonicalize(base)!==canonicalize(native.body))fail('程序可填字段被改写；只能提出带引文的语义建议');
  }
  const pack=scope.product?await this.context.packs.productById(scope.product):null;
  for(const key of annotations)for(const proposal of body[key]??[]){
   if(!object(proposal))fail('主张不是结构对象');await this.quote(principal,proposal.quote);
   if(!['manual_link','command_link','case_link','relations'].includes(key)&&this.quoteRef(proposal.quote).sha!==body.source.bytes)fail('主张必须引用本对象原件，不能用兄弟或祖先代替');
   if(key==='classification'&&body.schema!=='fed-note@1'&&(!scope.classifications||!scope.classifications.includes(proposal.value)))fail('分类值不等于锁定包声明的闭集原文，或包未声明闭集');
   if(key==='manual_link'){
    if(proposal.root!==scope.root)fail('手册关联不在锁定树苗');const segments=pathSegments(proposal.path);if(segments[0]!=='manual'||!await this.reading.nodeAt(proposal.root,segments))fail('手册章节不能按锁定路径解析');
    const node=await this.reading.treeReader().read(proposal.root,proposal.path,null,{user:principal.id,role:principal.role}),q=this.quoteRef(proposal.quote);let owned=false;
    for(const ground of node?.grounds??[]){const g=parseReference(ground);if(g.scheme!=='src'||g.sha256!==q.sha||g.parser!==q.parser||g.selector!==q.selector)continue;const original=await this.context.records.artifacts.source(principal,g.sha256,{consumer:'model'}),parsed=this.context.parsers.get(q.parser);const fragment=original?.bytes&&parsed?parsed.parse(original.bytes).locate(q.selector):null;if(!fragment)continue;const text=g.range?fragment.text.slice(g.range[0],g.range[1]):fragment.text;if(text.includes(proposal.quote.text))owned=true;}if(!owned)fail('手册引文与目标章节没有精确来源对应');
   }
   if(key==='command_link'){
    if(!scope.root||!pack)fail('命令关联缺锁定树苗');const seed=await this.root(principal,scope.product!,scope.root);const tree=seed.origin.find(origin=>origin.role==='command-tree');if(!tree)fail('树苗缺命令原件');const known=await this.context.store.node(scope.root);if(!known||proposal.command.tree_root!==tree.sha256)fail('命令身份不在锁定命令树');if(!await this.reading.nodeAt(scope.root,pathSegments(proposal.command.path)))fail('命令路径解析不出');const fn=pack.product.feeding?.verify_command;if(!fn)fail('产品包未声明完整命令核验回调');const original=await this.source(this.context.admin??principal,tree.sha256);const verified=await callPackFunction({packDir:pack.directory,...fn},{command:proposal.command,tree:{model:original.model,sha256:tree.sha256}},this.context.sandbox.producer,this.context.sandbox);if(!object(verified.output)||!verified.output.identity||canonicalize(verified.output.identity)!==canonicalize(proposal.command))fail('命令身份不能按锁定原树完整解析');
   }
   if(key==='relations'||key==='case_link'){if(proposal.object===body.object)fail('关系两端不能是同一对象');if(!await this.visible(proposal.object,principal))fail('关系目标不存在或当前不可读');}
   if(key==='applicability'){
    if(!scope.product||!scope.root)fail('适用条件缺锁定树苗');const seed=await this.root(principal,scope.product,scope.root),composition=await this.context.store.composition(seed.composition);if(!composition?.applicability_context)fail('树苗没有冻结条件闭集');
    for(const field of Object.keys(proposal.value)){
     if(field==='memory'){const m=proposal.value.memory;if(!proposal.quote.text.includes(m.raw))fail('memory.raw 不是逐字引文');if(m.minimum&&m.maximum&&BigInt(m.minimum.bytes)+(m.minimum.inclusive?0n:1n)>BigInt(m.maximum.bytes)-(m.maximum.inclusive?0n:1n))fail('内存边界相互矛盾');continue;}
     if(field==='builds'){const known=new Set(composition.known_builds?.map(row=>row.name));if(proposal.value.builds.some((name:string)=>!known.has(name)))fail('构建条件不在冻结已知构建清单');continue;}
     const values=composition.applicability_context.closed_sets[field as keyof typeof composition.applicability_context.closed_sets];if(!values)fail('适用字段没有冻结闭集');const entries=Array.isArray(proposal.value[field])?proposal.value[field]:[...proposal.value[field].with??[],...proposal.value[field].without??[]];if(entries.some((value:string)=>!values.includes(value)))fail('适用值不等于冻结闭集原文');
    }
   }
  }
  return body;
 }
 async appendPrepared(principal:Principal,body:Record<string,any>,scope:FeedingScope,model:string,tx:Transaction):Promise<string>{
  await this.context.records.store.lock('knowledge.feeding.log',tx);
  if(body.schema==='retraction@1')return (await this.put(body,principal,'hub.retraction@1',[],[],'retraction:'+this.key(body),[{key:RETRACT,value:'1'}],tx)).digest;
  const source=await this.source(principal,body.source.bytes);const quotes=annotations.flatMap(key=>(body[key]??[]).map((value:any)=>value.quote));
  const bound=[body.source.bytes,source.artifact.digest,...quotes.map(q=>this.quoteRef(q).sha),...(scope.root?[scope.root]:[])];
  const stored=await this.put(body,principal,model,['src:'+body.source.bytes],bound,'annotation:'+this.key(body)+':'+principal.id,[{key:OBJECT,value:body.object},{key:'knowledge.feeding.product',value:body.product??principal.id},{key:'knowledge.feeding.annotation',value:'1'}],tx,true,scope.run??null);await this.usage(principal,body.object,scope,tx);return stored.digest;
 }
 async admit(principal:Principal,payload:readonly unknown[],scope:FeedingScope&{classifications?:readonly string[]}):Promise<string[]>{const bodies:Record<string,any>[]=[];for(const raw of payload)bodies.push(await this.prepare(principal,raw,scope));return this.context.records.store.withTransaction(async tx=>{const refs=[];for(const body of bodies)refs.push(await this.appendPrepared(principal,body,scope,'client-declared-model',tx));return refs;});}
 async bindingsFor(principal:Principal,id:string,offset=Number.MAX_SAFE_INTEGER){if(!await this.visible(id,principal))return null;const rows=[];for(const record of await this.all(BINDING,id)){if(await this.position(record.digest)>offset)continue;const body=this.body(record);if(body)rows.push({record:record.digest,body,claim:record.body});}const structure=rows.filter(row=>row.body.basis==='source_structure'),declared=rows.filter(row=>row.body.basis==='declared');return {items:rows.sort((a,b)=>Number(a.body.basis==='declared')-Number(b.body.basis==='declared')),conflict:rows.some(row=>row.body.state==='conflict')||declared.some(row=>{const same=structure.filter(source=>source.claim.validity.bound.length===row.claim.validity.bound.length&&source.claim.validity.bound.every((v,i)=>v===row.claim.validity.bound[i]));return same.some(source=>source.body.state==='bound')&&!same.some(source=>source.body.state==='bound'&&source.body.line===row.body.line);}),candidates:[...new Set(rows.flatMap(row=>row.body.state==='conflict'?row.body.candidates:row.body.line?[row.body.line]:[]))]};}
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
  if(body.object&&!await this.visible(body.object,principal))return null;
  return principal.role==='admin'||body.object?record:null;
 }
 async recordState(digest:string,principal:Principal,parent?:string){const record=await this.readRecord(digest,principal) as StoredRecord<ClaimBody>|null;if(!record)return null;const body=this.body(record)!;const retractions=[...await this.withdrawals(body.object??'',digest,record.body.statement.data?.run as string|null,[...record.body.validity.bound,...(parent?[parent]:[])]),...await this.changed(body)];return {validity:retractions.length?'invalid':'valid',retractions};}

}

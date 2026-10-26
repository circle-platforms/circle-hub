// Deterministic admission of a model field claim. Matching evidence never makes the semantic value a fact.
import {ProductDeclaration,Applicability} from '../../contracts/src/product.ts';
import type {ContributionInput,KnowledgeContributionBody} from '../../contracts/src/contributions.ts';
import type {RootSource} from '../../contracts/src/knowledge.ts';
import {parseReference} from '../refs/api.ts';
import {readPackDirectory} from '../runs/api.ts';
import {callPackFunction} from '../rules/api.ts';
import {canonicalize,type Principal} from '../records/api.ts';
import type {KnowledgeContext} from './context.ts';
import type {CompositionView,ReadRow} from './composition.ts';
import type {TreeReading} from './read.ts';
import {KnowledgeError} from './errors.ts';
import {applicabilityCriterion} from './applicability-fields.ts';
import {requestKnowledgeFact} from './requests.ts';
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const path=(v:unknown):v is string[]=>Array.isArray(v)&&v.every(part=>typeof part==='string');
const equal=(a:unknown,b:unknown)=>canonicalize(a)===canonicalize(b);
const indexCache=new WeakMap<CompositionView,Promise<Array<ReadRow>>>();
async function rowsOf(composition:CompositionView){let saved=indexCache.get(composition);if(!saved){saved=(async()=>{const rows:ReadRow[]=[];for await(const row of composition.rows())rows.push(row);for await(const row of composition.unplacedRows())rows.push({...row,path:'/'});return rows;})();indexCache.set(composition,saved);}return saved;}
export async function admitApplicability(context:KnowledgeContext,reading:TreeReading,composition:CompositionView,input:ContributionInput,source:KnowledgeContributionBody['source'],originals:Map<string,RootSource>,custodian:Principal,reader:Principal):Promise<NonNullable<KnowledgeContributionBody['applicability_claim']>>{
 const claim=input.applicability_claim!;
 const invalid=(message:string):never=>{throw new KnowledgeError(message+'；按生成槽位结构及原件引用修正后重交',{code:'SUBMISSION_SCHEMA_VIOLATION'});};
 const missing=async(fact:string):Promise<never>=>{const action='管理员恢复原包、冻结条件上下文或原件定位；包维护者补齐保真范围与结构来源后重产，运行者以新根或恢复的同一组成重开回注';const request=await requestKnowledgeFact(context,{kind:'clarification',subject:'适用条件主张补证 '+claim.field,missing:fact,action,inputs:[`tree:${input.root}${input.path}@${claim.entry}`]});throw new KnowledgeError(fact+'；下一步：'+action+'；管理员 '+request.audience_user+'；请求 '+request.reference+'；期限 '+request.deadline,{code:'REFERENCE_UNRESOLVED'});};
 const rows=await rowsOf(composition),target=rows.find(row=>row.path===input.path&&row.entry===claim.entry);
 if(!target)return invalid('entry 不在这次锁定根的指定节点上');
 if(await reading.treeReader({composition:composition.record}).read(input.root,input.path,claim.entry,{user:reader.id,role:reader.role})===null)return missing('目标条目当前不可读');
 const content=await context.store.entry(claim.entry),data=content?.data;
 const marker=object(data?.applicability_state)?data.applicability_state:null;
 if(!content||!data)return missing('目标条目的原始内容');
 const producer=composition.body.producer,pack=await context.packs.pack(`${producer.pack}@${producer.version}`);if(!pack||pack.digest!==producer.digest)return missing('原生产器包版本及其完整性');
 const loaded=await readPackDirectory(pack.directory);if(!loaded.ok||loaded.pack.digest!==producer.digest)return missing('与原组成一致的已核验产品包');
 const file=loaded.pack.files.find(file=>file.path==='product.json');if(!file)return missing('原产品声明');
 const product=ProductDeclaration.safeParse(JSON.parse(Buffer.from(file.bytes).toString('utf8')));if(!product.success||!product.data.applicability)return missing('原包没有声明条件语法和闭集来源');
 const policy=product.data.applicability,snapshot=composition.body.applicability_context,inventory=composition.body.known_builds;
 if(!snapshot||!inventory||snapshot.grammar!==policy.grammar)return missing('条件闭集、已知构建快照或条目语法与原包的一致性');

 const criterion=applicabilityCriterion(snapshot,inventory)!;if(marker&&typeof marker.criteria_digest==='string'&&criterion!==marker.criteria_digest)return missing('条目的条件校验准则与冻结变量/构建上下文不一致');
 const checked=Applicability.safeParse({[claim.field]:claim.value});if(!checked.success||checked.data[claim.field]===undefined)return invalid('value 不是该字段的合法结构');
 const value=checked.data[claim.field]!;
 const declarations:string[]=[];
 if(claim.field==='memory'){
  const m=checked.data.memory!;if(m.minimum&&m.maximum&&(BigInt(m.minimum.bytes)+(m.minimum.inclusive?0n:1n)>BigInt(m.maximum.bytes)-(m.maximum.inclusive?0n:1n)))return invalid('内存边界声明为空或相互矛盾');
  if(!claim.evidence.text.includes(m.raw))return invalid('memory.raw 不是逐字引文的一部分');
 }else if(claim.field==='builds'){
  const values=checked.data.builds!;if(!values.length||values.length>256||values.some(name=>!inventory.some(row=>row.name===name)))return invalid('构建值不在冻结知识库已知构建清单中');
  if(!policy.build_validator)return missing('产品未声明构建名语法校验器');
  const result=await callPackFunction({packDir:pack.directory,module:policy.build_validator.module,export:policy.build_validator.export},{names:values},context.sandbox.producer,{requireOsIsolation:context.sandbox.requireOsIsolation});
  if(!object(result.output)||!Array.isArray(result.output.accepted)||!Array.isArray(result.output.rejected)||result.output.rejected.length||!equal(result.output.accepted,values))return invalid('构建名不符合原包声明的完整语法');
  declarations.push(...inventory.filter(row=>values.includes(row.name)).map(row=>row.record));
 }else{
  const names=claim.field==='components'?[...(checked.data.components?.with??[]),...(checked.data.components?.without??[])]:value;
  if(!Array.isArray(names)||!names.length||names.length>256)return invalid('条件列表必须非空且在有界范围内');
  const allowed=snapshot.closed_sets[claim.field];if(!allowed)return missing('该字段没有冻结的部署闭集');
  if(names.some(name=>typeof name!=='string'||!name.trim().length||!allowed.includes(name)))return invalid('条件值不等于部署闭集的精确成员');
  if(claim.field==='components'&&checked.data.components?.with?.some(name=>checked.data.components?.without?.includes(name)))return invalid('部件 with/without 同时声明同一成员');
  const variable=policy.closed_sets[claim.field];declarations.push(...(composition.body.variables??[]).filter(use=>use.name===variable).map(use=>use.decision));
 }
 const evidence=claim.evidence,id=evidence.identity;
 if(input.source.quote!==evidence.text||!source.sources.includes(id.source_sha256))return invalid('引文文字或原件摘要与已核来源不一致');
 const reference=`src:${id.source_sha256}/${id.parser}/${id.path}`,q=parseReference(input.source.reference);
 if(q.scheme==='tree'){if(q.root!==input.root||q.entry===undefined)return invalid('条件 tree 引文必须指向同根具体条目');}else if(q.scheme!=='src'||(input.source.reference!==reference&&input.source.reference!==`src:${id.source_sha256}`))return invalid('source.reference 与原始引文身份不一致');
 const original=originals.get(id.source_sha256);if(!original)return missing('原件不在锁定根的来源清单中');
 const bytes=await context.records.artifacts.source(custodian,id.source_sha256,{consumer:'function',record:original.artifact});if(!bytes?.bytes)return missing('引文原件当前不可读');
 const parser=context.parsers.get(id.parser);if(!parser)return missing('引文解析器版本不可用');
 const document=parser.parse(bytes.bytes),fragment=document.locate(id.path);if(!fragment?.byteRange)return missing('解析器未提供该片段的原始 byte range');
 const end=id.span.offset+id.span.length;if(id.span.offset<fragment.byteRange[0]||end>fragment.byteRange[1]||end>bytes.bytes.byteLength)return invalid('byte span 不在所引片段内');
 let text:string;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes.bytes.slice(id.span.offset,end));}catch{return invalid('byte span 不对应完整 UTF-8 原文');}if(text!==evidence.text)return invalid('逐字引文与原始 byte span 不一致');
 let unmappedRange=false;
 const matches=(ref:string)=>{try{const r=parseReference(ref);if(r.scheme!=='src'||r.sha256!==id.source_sha256||r.parser!==id.parser||r.selector!==id.path)return false;if(r.range){let original:string;try{original=new TextDecoder('utf-8',{fatal:true}).decode(bytes.bytes!.slice(fragment.byteRange![0],fragment.byteRange![1]));}catch{unmappedRange=true;return false;}if(original!==fragment.text){unmappedRange=true;return false;}return id.span.offset>=fragment.byteRange![0]+r.range[0]&&end<=fragment.byteRange![0]+r.range[1];}return true;}catch{return false;}};
 let chapter=false;
 for(const row of rows){if(q.scheme==='tree'&&(row.path!==q.path||row.entry!==q.entry))continue;
  for(const origin of row.applicability_sources??[])if(origin.field===claim.field&&matches(origin.fragment)&&equal(origin.section,claim.section)&&row.entry===claim.entry)chapter=true;
  if(!row.fragments.some(matches))continue;const c=await context.store.entry(row.entry);
  if(c&&path(c.data.section_path)&&equal(c.data.section_path,claim.section))chapter=true;
 }
 if(!chapter&&unmappedRange)return missing('所引子范围缺原始字节映射');
 if(!chapter)return invalid('章节路径与原件片段及目标条目没有可核对的结构关系');
 return {...claim,value,admission:{composition:composition.record,criteria_digest:criterion,declarations:[...new Set(declarations)]}};
}

// Package lifecycle stays in the platform; parser algorithms execute only in the package sandbox.
import type {PackRegistry,OpenedPack} from '../runs/api.ts';
import {SkillLocks,type SkillDependency,type SkillLock} from '../../contracts/src/skills.ts';
import type {SkillDeclaration} from '../../contracts/src/pack.ts';
import type {RecordsKit,Principal} from '../records/api.ts';
import {AccessError,ConflictError,IntegrityError} from '../records/api.ts';
import type {RunRecord} from '../../contracts/src/run.ts';
import {callPackFunction,type SandboxOptions} from '../rules/api.ts';
import {createDefaultRegistry} from './parsers/index.ts';
import {parseReference,ReferenceSyntaxError} from './reference.ts';
import type {RecordStore,Transaction,StoredRecord,Page} from '../records/api.ts';
import type {RecordKind} from '../../contracts/generated/protocol.ts';
import {createParserRegistry,ParseError,ParseLimitError,ParseSyntaxError,ParseEncodingError,QUOTATION_UNITS,type ParserRegistry,type Parser,type ParsedDocument,type Fragment,type JsonValue,type JsonObject,type ParseLimits,type QuotationUnits} from './parser.ts';

const object=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const missing=(message:string)=>new ConflictError(message,{fix:'管理员安装所需通用技能包；缺历史锁时用 circle-hub skill bind-legacy <解析器 id@版本> <技能包 id@版本> 追加迁移声明，再按原引用重读'});
const readRun=async(records:RecordsKit,run:string)=>(await records.store.find<RunRecord>({kind:'run',key:'runs.id',value:run,limit:1})).items[0]??null;
export interface SkillParserOptions {registry:PackRegistry;records:RecordsKit;sandbox?:SandboxOptions;now?:()=>Date}
export interface LegacySkillBinding {run:string;skills:SkillLock[];decided_by:string;reason:string;run_record:string}

const LOCATE_BATCH=256;

function failPack(parser:string,value:Record<string,unknown>):never {
  const e=value.error as Record<string,unknown>,message=typeof e.message==='string'?e.message:'技能包解析失败';
  if(typeof e.limit==='string'&&typeof e.max==='number'&&['maxBytes','maxDepth','maxNodes','maxAttributes','maxSelectorChars'].includes(e.limit))throw new ParseLimitError(parser,e.limit as keyof ParseLimits,e.max,message,typeof e.offset==='number'?e.offset:null);
  if(e.name==='ParseEncodingError')throw new ParseEncodingError(parser,message,typeof e.offset==='number'?e.offset:null);
  throw new ParseSyntaxError(parser,message,typeof e.offset==='number'?e.offset:null);
}

function readWireFragment(parser:string,f:unknown):{lookup:string;fragment:Fragment} {
  if(!object(f)||typeof f.lookup!=='string'||typeof f.selector!=='string'||typeof f.text!=='string'||f.byteRange!==null&&(!Array.isArray(f.byteRange)||f.byteRange.length!==2||f.byteRange.some(n=>typeof n!=='number'||!Number.isSafeInteger(n)||n<0)))throw new ParseError(parser,'技能包片段结构无效');
  return {lookup:f.lookup,fragment:{selector:f.selector,text:f.text,byteRange:f.byteRange as Fragment['byteRange'],data:f.data as Fragment['data']}};
}

function checkQuotation(parser:string,quotation:unknown):void {
  if(!object(quotation))throw new ParseError(parser,'技能包没有返回逐字引文单元');
  for(const field of ['plain','properties']){
    const q=quotation[field];
    if(!object(q)||typeof q.stream!=='string'||!Array.isArray(q.units))throw new ParseError(parser,'技能包引文单元结构无效');
    for(const [index,u]of q.units.entries())if(!object(u)||typeof u.selector!=='string'||typeof u.text!=='string'||!Number.isInteger(u.parent)||Number(u.parent)<-1||Number(u.parent)>=index||!Number.isInteger(u.start)||!Number.isInteger(u.end)||Number(u.start)<-1||Number(u.start)>=0&&(Number(u.end)<Number(u.start)||Number(u.end)>q.stream.length||q.stream.slice(Number(u.start),Number(u.end))!==u.text))throw new ParseError(parser,'技能包引文单元边界或原文不一致');
  }
}

function stringList(parser:string,value:unknown):string[] {
  if(!Array.isArray(value)||value.some(s=>typeof s!=='string'))throw new ParseError(parser,'技能包文档结构不完整；修正技能包后重读');
  return value as string[];
}

function hydrate(value:unknown,parser:string,fetchFragments?:(selectors:string[])=>Promise<unknown>):ParsedDocument {
  if(!object(value))throw new ParseError(parser,'技能包没有返回文档结构；请包作者修正后发布新版本');
  if(object(value.error))failPack(parser,value);
  const d=value.document;
  if(!object(d)||d.parser!==parser||!object(d.summary)||!Array.isArray(d.selectors)||!Array.isArray(d.properties))throw new ParseError(parser,'技能包文档结构不完整；修正技能包后重读');
  const eager=Object.hasOwn(d,'fragments');
  if(eager&&!Array.isArray(d.fragments))throw new ParseError(parser,'技能包文档结构不完整；修正技能包后重读');
  if(!eager&&!fetchFragments)throw new ParseError(parser,'按需文档缺少 locate 声明；技能包作者在 skill.json 写上 locate 后重读');
  const fragments=new Map<string,Fragment>();
  if(eager){
    for(const raw of d.fragments as unknown[]){
      const row=readWireFragment(parser,raw);
      if(fragments.has(row.lookup))throw new ParseError(parser,'技能包返回重复片段选择器');
      fragments.set(row.lookup,row.fragment);
    }
    if([d.selectors,d.properties].some(list=>(list as unknown[]).some(s=>typeof s!=='string'||!fragments.has(s as string))))throw new ParseError(parser,'技能包选择器不对应已返回片段');
  }else{
    stringList(parser,d.selectors);stringList(parser,d.properties);
  }
  checkQuotation(parser,d.quotation);
  const cached=new Map<string,Fragment|null>();
  const pending=new Map<string,Promise<void>>();
  if(eager)for(const [lookup,fragment]of fragments)cached.set(lookup,fragment);
  const load=async(selectors:string[]):Promise<void>=>{
    const wanted=[...new Set(selectors)];
    const waiting=[...new Set(wanted.flatMap(selector=>pending.has(selector)?[pending.get(selector)!]:[]))];
    const missing=wanted.filter(selector=>!cached.has(selector)&&!pending.has(selector));
    const batches:string[][]=[];
    for(let at=0;at<missing.length;at+=LOCATE_BATCH)batches.push(missing.slice(at,at+LOCATE_BATCH));
    const jobs=batches.map(async batch=>{
      let finish:()=>void=()=>{};
      const gate=new Promise<void>(resolve=>{finish=resolve;});
      for(const selector of batch)pending.set(selector,gate);
      try{
        const output=await fetchFragments!(batch);
        if(!object(output))throw new ParseError(parser,'技能包 locate 没有返回片段');
        if(object(output.error))failPack(parser,output);
        if(!Array.isArray(output.fragments))throw new ParseError(parser,'技能包 locate 没有返回片段');
        const seen=new Set<string>();
        for(const raw of output.fragments){
          const row=readWireFragment(parser,raw);
          if(!batch.includes(row.lookup))throw new ParseError(parser,'技能包返回了未请求的片段');
          if(seen.has(row.lookup))throw new ParseError(parser,'技能包返回重复片段选择器');
          seen.add(row.lookup);
          cached.set(row.lookup,row.fragment);
        }
        for(const selector of batch)if(!cached.has(selector))cached.set(selector,null);
      }finally{for(const selector of batch)pending.delete(selector);finish();}
    });
    await Promise.all([...waiting,...jobs]);
  };
  const locate=eager?(selector:string)=>fragments.get(selector)??null:(selector:string):Fragment|null|Promise<Fragment|null>=>{
    if(cached.has(selector))return cached.get(selector)??null;
    return load([selector]).then(()=>cached.get(selector)??null);
  };
  return {parser,model:d.model as JsonValue,locate,listSelectors:(prefix='',options={})=>((options.properties?d.properties:d.selectors) as string[]).filter((s:string)=>s.startsWith(prefix)).slice(0,options.limit??Infinity),summary:()=>d.summary as JsonObject,
    ...(!eager?{prefetch:load}:{}),
    ...(object(d.quotation)?{[QUOTATION_UNITS]:(options:{properties:boolean})=>(options.properties?(d.quotation as Record<string,unknown>).properties:(d.quotation as Record<string,unknown>).plain) as QuotationUnits}:{})};
}

function parserOf(opened:OpenedPack,row:SkillDeclaration['parsers'][number],options:SkillParserOptions):Parser{
  const split=row.parser.lastIndexOf('@'),id=row.parser.slice(0,split),version=Number(row.parser.slice(split+1));
  return {id,version,mediaTypes:row.media_types,limits:row.limits,skill_digest:opened.info.digest,...(row.migration_test?{migration_test:row.migration_test}:{}),
    parse(){throw new ParseError(row.parser,'技能包解析必须经平台异步沙箱调用');},
    async parseAsync(bytes,parseOptions={}){
      const limits={...row.limits};
      for(const key of Object.keys(row.limits) as (keyof ParseLimits)[]){const requested=parseOptions[key];if(requested!==undefined){if(!Number.isSafeInteger(requested)||requested<=0)throw new ParseError(row.parser,'解析限额必须是正整数');limits[key]=Math.min(row.limits[key]!,requested);}}
      if(bytes.length>limits.maxBytes)throw new ParseLimitError(row.parser,'maxBytes',limits.maxBytes,'原件超过技能包声明的字节限额');
      const verified=await options.registry.open(opened.info.digest);
      if(!verified||verified.declarations.kind!=='skill')throw new IntegrityError('冻结技能包缺失或被改变');
      try{
        const input={bytes:Buffer.from(bytes).toString('base64'),options:{...parseOptions,...limits}};
        const limitsBox={timeoutMs:5000,inputBytes:96*1024*1024,outputBytes:64*1024*1024};
        const out=await callPackFunction({packDir:verified.handle.directory,module:row.function.module,export:row.function.export},input,limitsBox,options.sandbox);
        const locate=row.locate;
        const fetchFragments=locate?async(selectors:string[])=>{
          const again=await options.registry.open(opened.info.digest);
          if(!again||again.declarations.kind!=='skill')throw new IntegrityError('冻结技能包缺失或被改变');
          const located=await callPackFunction({packDir:again.handle.directory,module:locate.module,export:locate.export},{...input,selectors},limitsBox,options.sandbox);
          return located.output;
        }:undefined;
        return hydrate(out.output,row.parser,fetchFragments);
      }catch(error){if(error instanceof ParseError||error instanceof IntegrityError)throw error;throw new ParseError(row.parser,'技能包解析未完成；请管理员核对沙箱及该技能包，修正后重读',null,error instanceof Error?error.message:null);}
    }};
}

export function createSkillParserRegistry(options:SkillParserOptions):ParserRegistry {
  const {registry,records}=options;let current=createDefaultRegistry();
  const load=async(locks:readonly SkillLock[]):Promise<ParserRegistry>=>{
    SkillLocks.parse(locks);const parsed:Parser[]=[];
    for(const lock of locks){const opened=await registry.open(lock.digest);
      if(!opened||opened.info.id!==lock.pack||opened.info.version!==lock.version||opened.declarations.kind!=='skill')throw missing(`冻结技能包 ${lock.pack}@${lock.version}（摘要 ${lock.digest}）不可读取`);
      for(const row of opened.declarations.skill.parsers)parsed.push(parserOf(opened,row,options));
    }
    // Installed format parsers precede the generic transitional JSON parser. Duplicate parser@version is refused.
    const out=createParserRegistry([...parsed,...createDefaultRegistry().list()]);
    out.skills=locks.map(lock=>({...lock}));
    out.unavailable=key=>`缺少解析器 ${key} 的已安装/冻结通用技能包；下一步：管理员安装所需技能并重开运行，或用 circle-hub skill bind-legacy ${key} <技能包 id@版本> 为历史引用追加迁移声明`;
    return out;
  };
  const freeze=async(dependencies:readonly SkillDependency[])=>{
    const available=await registry.installedSkills();
    const skills=available.map(pack=>({pack:pack.info.id,version:pack.info.version,digest:pack.info.digest}));
    for(const pack of available)for(const dep of pack.info.manifest.dependencies??[])if(!skills.some(lock=>lock.pack===dep.pack&&(dep.version===undefined||dep.version===lock.version)))throw missing(`技能包 ${pack.info.id} 缺少已安装依赖 ${dep.pack}`);
    for(const dep of dependencies)if(!skills.some(lock=>lock.pack===dep.pack&&(dep.version===undefined||dep.version===lock.version)))throw missing(`缺少已安装技能包 ${dep.pack}${dep.version?'@'+dep.version:''}；新运行没有开始`);
    return {skills,parsers:await load(skills)};
  };
  const facade:ParserRegistry={register:parser=>current.register(parser),get:key=>current.get(key),forMediaType:type=>current.forMediaType(type),list:()=>current.list(),
    refresh:async()=>{current=(await freeze([])).parsers;},freeze,
    unavailable:key=>current.unavailable?.(key),
    async forReference(parser){
      await facade.refresh!();
      const binding=(await records.store.find<any>({kind:'action',key:'refs.legacy-parser',value:parser,limit:1,newestFirst:false})).items[0];
      if(binding){const lock=SkillLocks.parse([binding.body.detail?.migration?.skill]);const out=await load(lock);out.bindingRecords=[binding.digest];out.bindingDisclosure='迁移时点事后声明；rec:'+binding.digest+'；按所列摘要复核，不证明旧执行当时使用该包';return out;}
      if(current.get(parser)?.migration_test){const out=await load([]);out.unavailable=key=>'缺少旧解析器 '+key+' 的迁移时点事后声明；下一步：circle-hub skill bind-legacy '+key+' <技能包 id@版本>；也可给出已锁定技能摘要的运行号';return out;}
      return current;
    },
    async forRun(run){
      const stored=await readRun(records,run);if(!stored)throw missing('运行不存在，无法确定解析器摘要');
      const bindings=await records.store.find<any>({kind:'action',key:'runs.skills',value:run,limit:65,newestFirst:false});
      if(bindings.next||bindings.items.length>64)throw missing('运行的技能绑定记录超过有界读取上限');
      const valid=bindings.items.filter(row=>row.body.detail?.run_record===stored.digest);
      if(valid.length){
        const locks:SkillLock[]=SkillLocks.parse(stored.body.skills??[]);
        for(const row of valid)for(const lock of SkillLocks.parse(row.body.detail.skills)){
          const prior=locks.find(value=>value.pack===lock.pack);
          if(prior&&prior.digest!==lock.digest)throw missing('运行的技能摘要声明冲突，不能选择一条');
          if(!prior)locks.push(lock);
        }
        const out=await load(locks);out.bindingRecords=valid.map(row=>row.digest);out.bindingRecord=valid[0].digest;
        out.bindingDisclosure='迁移时点事后声明（历史解析技能由管理员追加绑定）；按所列包摘要复核，不证明旧执行当时使用；'+valid.map(row=>'rec:'+row.digest).join('；');out.unavailable=key=>`历史运行 ${run} 未锁定技能包摘要（解析器 ${key}）；下一步：管理员执行 circle-hub skill bind-legacy ${key} <技能包 id@版本>；原运行和结果不改`;return out;
      }
      const out=await load(stored.body.skills??[]);if(stored.body.skills===undefined)delete out.skills;out.unavailable=key=>`历史运行 ${run} 未锁定技能包摘要（解析器 ${key}）；下一步：管理员用 circle-hub skill bind-legacy ${key} <技能包 id@版本> 追加迁移时点事后声明后重读；原运行和结果不改`;
      return out;
    }};
  return facade;
}

/** Explicit, append-only administrator declaration; never pretends to reconstruct old execution history. */
export async function bindLegacySkills(options:SkillParserOptions,by:Principal,run:string,refs:readonly string[],reason:string):Promise<string>{
  const account=await options.registry.account(by);if(account?.role!=='admin')throw new AccessError('只有管理员可以追加历史技能包绑定');
  if(!reason.trim()||!refs.length)throw missing('历史绑定必须给出技能包精确版本及理由');
  const skills:SkillLock[]=[];const publications:string[]=[];
  for(const ref of refs){const at=ref.lastIndexOf('@');if(at<1)throw missing('历史绑定必须声明精确技能包版本');const info=await options.registry.getVersion(ref.slice(0,at),ref.slice(at+1));if(info?.kind!=='skill')throw missing('没有该技能包的已发布版本');skills.push({pack:info.id,version:info.version,digest:info.digest});publications.push('rec:'+info.record);}
  SkillLocks.parse(skills);
  return options.records.store.withTransaction(async tx=>{
    await options.records.store.lock('run-skills:'+run,tx);
    const stored=await readRun(options.records,run);if(!stored)throw missing('没有该历史运行');
    if(stored.body.skills!==undefined)throw missing('运行已有冻结技能包摘要，不接受事后改绑');
    const prior=await options.records.store.find({kind:'action',key:'runs.skills',value:run,limit:1},tx);if(prior.items.length)throw missing('历史运行已有追加绑定，不接受改绑');
    const at=(options.now?.()??new Date()).toISOString();
    const saved=await options.records.store.put({kind:'action',schema:'action@1',provenance:'declared',created_at:at,body:{action:'validate',run,item:null,inputs:['rec:'+stored.digest,...publications],component:'skill@1',lease:null,started_at:at,ended_at:at,result:'completed',error_code:null,acceptance:null,codes:[],detail:{run_record:stored.digest,skills,decided_by:account.id,reason,provenance:'declared'}},index:[{key:'runs.skills',value:run}]},tx);
    return saved.digest;
  });
}

/** Only whole, structurally valid references count; prose is never searched for embedded commands or references. */
function referencesParser(value:unknown,parser:string):boolean{
 const pending:unknown[]=[value];
 while(pending.length){const next=pending.pop();if(typeof next==='string'){
   try{const reference=parseReference(next);if(reference.scheme==='src'&&reference.parser===parser)return true;}catch(error){if(!(error instanceof ReferenceSyntaxError))throw error;/* Not a reference value. */}
  }else if(next&&typeof next==='object')for(const child of Object.values(next))pending.push(child);
 }return false;
}
async function runReferencesParser(store:RecordStore,record:StoredRecord<RunRecord>,parser:string,tx:Transaction):Promise<boolean>{
 if(referencesParser(record.body,parser))return true;
 const indexes:Array<{kind:RecordKind;key:string}>=[{kind:'submission',key:'runs.submission.run'},{kind:'validation_result',key:'runs.result.run'},{kind:'action',key:'runs.action.run'}];
 for(const index of indexes){let cursor:string|null=null;const seen=new Set<string>();do{
   const page:Page<StoredRecord>=await store.find({...index,value:record.body.run,limit:32,cursor},tx);
   if(page.items.some(row=>referencesParser(row.body,parser)))return true;
   cursor=page.next;if(cursor){if(seen.has(cursor))throw missing('历史引用记录分页重复，不能完成补绑范围');seen.add(cursor);}
  }while(cursor);}
 return false;
}

/** One administrator command materializes a separate immutable binding for every eligible historical run. */
export async function bindLegacyParser(options:SkillParserOptions,by:Principal,parser:string,ref:string){
 const account=await options.registry.account(by);if(account?.role!=='admin')throw new AccessError('只有管理员可以追加迁移时点声明');
 const at=ref.lastIndexOf('@');if(at<1)throw missing('迁移声明必须指定技能包精确版本');
 const info=await options.registry.getVersion(ref.slice(0,at),ref.slice(at+1));
 if(info?.kind!=='skill')throw missing('没有该技能包已发布版本');
 const opened=await options.registry.open(info.digest);const row=opened?.declarations.kind==='skill'?opened.declarations.skill.parsers.find(row=>row.parser===parser):undefined;
 if(!row?.migration_test)throw missing('技能包缺少该解析器的精确声明或迁移等价测试名；包作者补声明并发布后再绑定');
 return options.records.store.withTransaction(async tx=>{
  await options.records.store.lock('skills.legacy-migration',tx);
  const prior=await options.records.store.find<any>({kind:'action',key:'refs.legacy-migration',value:'1',limit:65},tx);
  const existing=prior.items.find(item=>item.body.detail?.migration?.parser===parser);
  if(existing&&existing.body.detail.migration.skill.digest!==info.digest)throw missing('该解析器已有迁移时点声明，不能改绑');
  if(!existing&&(prior.next||prior.items.length>=64))throw missing('迁移声明达到 64 条上限');
  if(prior.items.some(item=>item.body.detail?.migration?.skill?.pack===info.id&&item.body.detail.migration.skill.digest!==info.digest))throw missing('同一技能包已有另一固定摘要，不能在迁移声明里混用版本；使用独立包或显式运行绑定');
  const cutoff=await options.records.store.watermark?.(tx);if(cutoff===undefined)throw missing('缺记录追加序号，不能划定迁移时点');
  const time=(options.now?.()??new Date()).toISOString(),skill={pack:info.id,version:info.version,digest:info.digest};
  const migration={label:'迁移时点事后声明',parser,skill,decided_by:account.id,at:time,test:row.migration_test,cutoff};
  const declaration=existing??await options.records.store.put({kind:'action',schema:'action@1',provenance:'declared',created_at:time,body:{action:'validate',run:null,item:null,inputs:['rec:'+info.record],component:'skill@1',lease:null,started_at:time,ended_at:time,result:'completed',error_code:null,acceptance:null,codes:[],detail:{migration}},index:[{key:'refs.legacy-migration',value:'1'},{key:'refs.legacy-parser',value:parser}]},tx);
  const lockedParsers=new Map<string,Set<string>>();
  const alreadyLocked=async(run:RunRecord)=>{
   for(const lock of SkillLocks.parse(run.skills??[])){
    const identity=lock.pack+'@'+lock.version+':'+lock.digest;let parsers=lockedParsers.get(identity);
    if(!parsers){const pack=await options.registry.open(lock.digest);if(!pack||pack.info.id!==lock.pack||pack.info.version!==lock.version||pack.declarations.kind!=='skill')throw missing('缺少历史运行已锁技能包，不能判断是否需要补绑；管理员恢复原包后重试');parsers=new Set(pack.declarations.skill.parsers.map(value=>value.parser));lockedParsers.set(identity,parsers);}
    if(parsers.has(parser))return true;
    if(lock.pack===skill.pack&&lock.digest!==skill.digest)throw missing('运行已有同包另一摘要，不能用迁移声明覆盖；保持原锁并由管理员核对');
   }return false;
  };
  let cursor:string|null=null,bound_runs=0,already_bound_runs=0,scanned_runs=0;const seen=new Set<string>();
  do{
   const page:Page<StoredRecord<RunRecord>>=await options.records.store.list<RunRecord>({kind:'run',limit:32,cursor},tx);
   for(const run of page.items){
    const position=await options.records.store.position?.(run.digest,tx);if(position===null||position===undefined)throw missing('历史运行缺追加序号，不能核对补绑范围');
    if(position>cutoff)continue;scanned_runs++;
    if(!await runReferencesParser(options.records.store,run,parser,tx)||await alreadyLocked(run.body))continue;
    await options.records.store.lock('run-skills:'+run.body.run,tx);
    const bindings=await options.records.store.find<any>({kind:'action',key:'runs.skills',value:run.body.run,limit:65},tx);
    if(bindings.next||bindings.items.length>64)throw missing('运行的技能绑定记录超过有界读取上限');
    const locks=SkillLocks.parse(run.body.skills??[]);
    for(const binding of bindings.items.filter(binding=>binding.body.detail?.run_record===run.digest))for(const lock of SkillLocks.parse(binding.body.detail.skills)){
      const existing=locks.find(value=>value.pack===lock.pack);if(existing&&existing.digest!==lock.digest)throw missing('运行的技能摘要声明冲突，不能选择一条');if(!existing)locks.push(lock);
    }
    if(await alreadyLocked({...run.body,skills:locks})){already_bound_runs++;continue;}

    await options.records.store.put({kind:'action',schema:'action@1',provenance:'declared',created_at:time,body:{action:'validate',run:run.body.run,item:null,inputs:['rec:'+run.digest,'rec:'+info.record,'rec:'+declaration.digest],component:'skill@1',lease:null,started_at:time,ended_at:time,result:'completed',error_code:null,acceptance:null,codes:[],detail:{run_record:run.digest,skills:[skill],...migration,migration_record:declaration.digest}},index:[{key:'runs.skills',value:run.body.run},{key:'runs.skill-parser',value:run.body.run+'/'+parser}]},tx);bound_runs++;
   }
   cursor=page.next;if(cursor){if(seen.has(cursor))throw missing('历史运行分页重复，不能完成补绑范围');seen.add(cursor);}
  }while(cursor);
  return {...migration,record:declaration.digest,bound_runs,already_bound_runs,scanned_runs};
 });
}

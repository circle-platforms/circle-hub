// Package lifecycle stays in the platform; parser algorithms execute only in the package sandbox.
import type {PackRegistry,OpenedPack} from '../runs/api.ts';
import {SkillLocks,type SkillDependency,type SkillLock} from '../../contracts/src/skills.ts';
import type {SkillDeclaration} from '../../contracts/src/pack.ts';
import type {RecordsKit,Principal} from '../records/api.ts';
import {AccessError,ConflictError,IntegrityError} from '../records/api.ts';
import type {RunRecord} from '../../contracts/src/run.ts';
import {callPackFunction,SandboxError,type SandboxOptions} from '../rules/api.ts';
import {createDefaultRegistry} from './parsers/index.ts';
import {parseReference,ReferenceSyntaxError} from './reference.ts';
import type {RecordStore,Transaction,StoredRecord,Page} from '../records/api.ts';
import type {RecordKind} from '../../contracts/generated/protocol.ts';
import {createParserRegistry,ParseError,ParseLimitError,ParseSyntaxError,ParseEncodingError,QUOTATION_UNITS,DEFAULT_MAX_SELECTOR_CHARS,type ParserRegistry,type Parser,type ParsedDocument,type Fragment,type JsonValue,type JsonObject,type ParseLimits,type QuotationUnits} from './parser.ts';

const object=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const missing=(message:string)=>new ConflictError(message,{fix:'管理员安装所需通用技能包；缺历史锁时用 circle-hub skill bind-legacy <解析器 id@版本> <技能包 id@版本> 追加迁移声明，再按原引用重读'});
const readRun=async(records:RecordsKit,run:string)=>(await records.store.find<RunRecord>({kind:'run',key:'runs.id',value:run,limit:1})).items[0]??null;
export interface SkillParserOptions {registry:PackRegistry;records:RecordsKit;sandbox?:SandboxOptions;now?:()=>Date;/** Optional output-size instrumentation; never receives package data. */onWireOutput?:(bytes:number)=>void}
export interface LegacySkillBinding {run:string;skills:SkillLock[];decided_by:string;reason:string;run_record:string}

const LOCATE_BATCH=256;

function failPack(parser:string,value:Record<string,unknown>,limits?:ParseLimits):never {
  // A pack is untrusted and can put original bytes, paths or credentials in any message.
  const e=value.error as Record<string,unknown>,message=e.crc_mismatch===true
    ? '解析器报告 ZIP CRC 校验不一致；下一步：重新获取完整原件后重读'
    : '技能包不能解析原件；下一步：管理员核对技能包和原件格式，修正后重读';
  if(typeof e.limit==='string'&&['maxBytes','maxDepth','maxNodes','maxAttributes','maxSelectorChars'].includes(e.limit)){
    const limit=e.limit as keyof ParseLimits,max=limits?.[limit];
    if(typeof max==='number')throw new ParseLimitError(parser,limit,max,message);
  }
  if(e.name==='ParseEncodingError')throw new ParseEncodingError(parser,message);
  throw new ParseSyntaxError(parser,message);
}

function readWireFragment(parser:string,f:unknown):{lookup:string;fragment:Fragment} {
  if(!object(f)||typeof f.lookup!=='string'||typeof f.selector!=='string'||typeof f.text!=='string'||f.byteRange!==null&&(!Array.isArray(f.byteRange)||f.byteRange.length!==2||f.byteRange.some(n=>typeof n!=='number'||!Number.isSafeInteger(n)||n<0)))throw new ParseError(parser,'技能包片段结构无效');
  return {lookup:f.lookup,fragment:{selector:f.selector,text:f.text,byteRange:f.byteRange as Fragment['byteRange'],data:f.data as Fragment['data']}};
}

// New compact arrays are additive: historic published skills still use literal strings.
function stringList(parser:string,value:unknown,maxChars:number):string[] {
  if(Array.isArray(value)&&value.every(s=>typeof s==='string')){
    if(value.reduce((n,s)=>n+(s as string).length,0)>maxChars)throw new ParseLimitError(parser,'maxSelectorChars',maxChars,'技能包选择器超过声明的总长度；拆分原件后重读');
    return value as string[];
  }
  if(!object(value)||value.encoding!=='prefix-delta@1'||!Array.isArray(value.entries))throw new ParseError(parser,'技能包文档结构不完整；修正技能包后重读');
  const out:string[]=[];let previous='',total=0;
  for(const entry of value.entries){
    if(!Array.isArray(entry)||entry.length!==2||!Number.isSafeInteger(entry[0])||entry[0]<0||entry[0]>previous.length||typeof entry[1]!=='string')throw new ParseError(parser,'技能包选择器压缩结构无效；修正技能包后重读');
    total+=entry[0]+entry[1].length;
    if(total>maxChars)throw new ParseLimitError(parser,'maxSelectorChars',maxChars,'技能包选择器超过声明的总长度；拆分原件后重读');
    previous=previous.slice(0,entry[0])+entry[1];out.push(previous);
  }
  return out;
}

function checkQuotation(parser:string,quotation:unknown,selectors:string[],properties:string[],sharedSelector:WeakSet<object>,sharedText:WeakSet<object>):void {
  if(!object(quotation))throw new ParseError(parser,'技能包没有返回逐字引文单元');
  for(const [field,list] of [['plain',selectors],['properties',properties]] as const){
    const q=quotation[field];
    if(!object(q)||typeof q.stream!=='string'||!Array.isArray(q.units))throw new ParseError(parser,'技能包引文单元结构无效');
    for(const [index,u] of q.units.entries()){
      if(!object(u)||!Number.isInteger(u.parent)||Number(u.parent)<-1||Number(u.parent)>=index||!Number.isInteger(u.start)||!Number.isInteger(u.end)||Number(u.start)<-1)throw new ParseError(parser,'技能包引文单元边界或原文不一致');
      if(u.selector===undefined&&Number.isSafeInteger(u.selector_index)&&Number(u.selector_index)>=0&&Number(u.selector_index)<list.length){u.selector=list[Number(u.selector_index)];sharedSelector.add(u);}
      if(typeof u.selector!=='string')throw new ParseError(parser,'技能包引文单元选择器无效');
      if(Number(u.start)>=0){
        if(Number(u.end)<Number(u.start)||Number(u.end)>q.stream.length)throw new ParseError(parser,'技能包引文单元边界或原文不一致');
        const expected=q.stream.slice(Number(u.start),Number(u.end));
        if(u.text===undefined){u.text=expected;sharedText.add(u);}
        else if(typeof u.text!=='string'||u.text!==expected)throw new ParseError(parser,'技能包引文单元边界或原文不一致');
      }else if(typeof u.text!=='string')throw new ParseError(parser,'技能包引文单元缺少原文');
      delete u.selector_index;
    }
  }
}

// Conservative retained heap estimate, including strings and object/list overhead.
function stringBytes(value:string):number {for(let i=0;i<value.length;i++)if(value.charCodeAt(i)>255)return value.length*2;return value.length;}
function estimate(value:unknown,sharedSelector?:WeakSet<object>,sharedText?:WeakSet<object>):number {
  let total=0;const seen=new Set<object>(),work:unknown[]=[value];
  while(work.length){const v=work.pop();if(typeof v==='string'){total+=stringBytes(v);continue;}if(!v||typeof v!=='object'){total+=8;continue;}if(seen.has(v))continue;seen.add(v);total+=64;
    if(Array.isArray(v)){total+=v.length*8;for(const item of v)work.push(item);}else for(const [key,item] of Object.entries(v)){total+=key.length*2+16;if((key==='selector'&&sharedSelector?.has(v))||(key==='text'&&sharedText?.has(v))){total+=8;continue;}work.push(item);}}
  return total;
}

const LOCATE_DEADLINE_MS=120_000;
function hydrate(value:unknown,parser:string,fetchFragments?:(selectors:string[])=>Promise<unknown>,sourceBytes=0,limits?:ParseLimits):ParsedDocument {
  if(!object(value))throw new ParseError(parser,'技能包没有返回文档结构；请包作者修正后发布新版本');
  if(object(value.error))failPack(parser,value,limits);
  const d=value.document;
  if(!object(d)||d.parser!==parser||!object(d.summary))throw new ParseError(parser,'技能包文档结构不完整；修正技能包后重读');
  const maxSelectorChars=limits?.maxSelectorChars??DEFAULT_MAX_SELECTOR_CHARS;
  const selectors=stringList(parser,d.selectors,maxSelectorChars),properties=stringList(parser,d.properties,maxSelectorChars);
  d.selectors=selectors;d.properties=properties;
  const declared=new Set([...selectors,...properties]);
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
    if([selectors,properties].some(list=>list.some(s=>!fragments.has(s))))throw new ParseError(parser,'技能包选择器不对应已返回片段');
  }
  const sharedSelector=new WeakSet<object>(),sharedText=new WeakSet<object>();
  checkQuotation(parser,d.quotation,selectors,properties,sharedSelector,sharedText);
  const cached=new Map<string,Fragment|null>();
  const pending=new Map<string,Promise<void>>();
  const listeners=new Set<()=>void>();
  let retained=estimate(d,sharedSelector,sharedText)+sourceBytes*2+declared.size*32+fragments.size*32;
  if(eager)for(const [lookup,fragment]of fragments)cached.set(lookup,fragment);
  // One active batch per document. The shared promises carry rejection to every waiter.
  let tail:Promise<void>=Promise.resolve();
  let stopped=false;let stoppedCause:unknown;
  let operationDeadline=Infinity;
  const expired=()=>new SandboxError('SANDBOX_TIMEOUT',{limit:'operation'});
  const within=async<T>(promise:Promise<T>,deadline:number):Promise<T>=>{
    const remaining=deadline-performance.now();if(remaining<=0){void promise.catch(()=>{});throw expired();}
    let timer:ReturnType<typeof setTimeout>|undefined;
    const timely=promise.then(value=>{if(performance.now()>=deadline)throw expired();return value;});
    try{return await Promise.race([timely,new Promise<never>((_,reject)=>{const tick=()=>{const left=deadline-performance.now();if(left<=0)reject(expired());else timer=setTimeout(tick,Math.ceil(left));};timer=setTimeout(tick,Math.ceil(remaining));})]);}finally{if(timer)clearTimeout(timer);}
  };
  const fetch=async(batch:string[],deadline:number):Promise<Map<string,Fragment>>=>{
    if(performance.now()>=deadline)throw expired();
    let output:unknown;
    const call=fetchFragments!(batch);
    try{output=await within(call,deadline);}catch(error){
      if(error instanceof SandboxError&&error.code==='SANDBOX_TIMEOUT'&&error.detail.limit==='operation')await call.catch(()=>{});
      if(error instanceof SandboxError&&batch.length>1&&(error.code==='SANDBOX_OUTPUT_TOO_LARGE'||error.code==='SANDBOX_VIOLATION'&&error.detail.limit==='memory')){
        const half=Math.floor(batch.length/2),left=await fetch(batch.slice(0,half),deadline),right=await fetch(batch.slice(half),deadline);
        for(const [key,fragment] of right)left.set(key,fragment);return left;
      }
      if(error instanceof SandboxError&&error.code==='SANDBOX_OUTPUT_TOO_LARGE')throw new SandboxError('SANDBOX_OUTPUT_TOO_LARGE',{reason:'single_fragment'});
      throw error;
    }
    if(!object(output))throw new ParseError(parser,'技能包 locate 没有返回片段');
    if(object(output.error))failPack(parser,output,limits);
    if(!Array.isArray(output.fragments))throw new ParseError(parser,'技能包 locate 没有返回片段');
    const rows=new Map<string,Fragment>(),wanted=new Set(batch);
    for(const raw of output.fragments){
      const row=readWireFragment(parser,raw);
      if(!wanted.has(row.lookup))throw new ParseError(parser,'技能包返回了未请求的片段');
      if(rows.has(row.lookup))throw new ParseError(parser,'技能包返回重复片段选择器');
      rows.set(row.lookup,row.fragment);
    }
    for(const selector of batch)if(!rows.has(selector)&&declared.has(selector))throw new ParseError(parser,'技能包未返回清单中声明的片段；下一步：技能包作者修正 locate 后发布新版本并重读');
    return rows;
  };
  const load=async(inputs:string[]):Promise<void>=>{
    if(!fetchFragments)return;
    if(stopped)throw stoppedCause;
    const deadline=Math.min(performance.now()+LOCATE_DEADLINE_MS,operationDeadline);
    if(performance.now()>=deadline)throw expired();
    const wanted=[...new Set(inputs)];
    const waiting=[...new Set(wanted.flatMap(selector=>pending.has(selector)?[pending.get(selector)!]:[]))];
    const missing=wanted.filter(selector=>!cached.has(selector)&&!pending.has(selector));
    const jobs:Promise<void>[]=[];
    let failed=false, failure:unknown;
    const owned=new Map<string,Promise<void>>();
    const failGroup=(error:unknown)=>{failed=true;failure=error;for(const [selector,job] of owned)if(pending.get(selector)===job)pending.delete(selector);};
    // Existing in-flight selectors belong to this request too: a failure of one
    // prevents this request's still-queued batches from reaching the sandbox.
    const dependencies=Promise.all(waiting).catch(error=>{failGroup(error);throw error;});
    void dependencies.catch(()=>{});
    for(let at=0;at<missing.length;at+=LOCATE_BATCH){
      const batch=missing.slice(at,at+LOCATE_BATCH);
      const job=tail.then(async()=>{
        await dependencies;
        if(failed)throw failure;
        if(stopped)throw stoppedCause;
        const rows=await fetch(batch,deadline);
        if(performance.now()>=deadline)throw expired();
        // Reserve the full batch against the document budget before exposing any row.
        // A rejecting budget listener stops queued work, and no partial rows survive.
        let added=0;
        for(const selector of batch)added+=estimate(selector)+estimate(rows.get(selector)??null)+32;
        retained+=added;
        try{for(const listener of listeners)listener();}
        catch(error){retained-=added;stopped=true;stoppedCause=error;throw error;}
        for(const selector of batch)cached.set(selector,rows.get(selector)??null);
      }).catch(error=>{failGroup(error);throw error;});
      tail=job.catch(()=>{});
      for(const selector of batch){pending.set(selector,job);owned.set(selector,job);}
      const cleanup=()=>{for(const selector of batch)if(pending.get(selector)===job)pending.delete(selector);};
      void job.then(cleanup,cleanup);jobs.push(job);
    }
    await within(Promise.all([...waiting,...jobs]).then(()=>{}),deadline);
  };
  const locate=(selector:string):Fragment|null|Promise<Fragment|null>=>{
    if(stopped)return Promise.reject(stoppedCause);
    if(cached.has(selector))return cached.get(selector)??null;
    if(!fetchFragments)return null;
    return load([selector]).then(()=>cached.get(selector)??null);
  };
  return {parser,model:d.model as JsonValue,locate,listSelectors:(prefix='',options={})=>(options.properties?properties:selectors).filter((s:string)=>s.startsWith(prefix)).slice(0,options.limit??Infinity),summary:()=>d.summary as JsonObject,
    ...(!eager?{prefetch:load}:{}),setOperationDeadline:(deadline:number)=>{operationDeadline=Math.min(operationDeadline,deadline);},retainedBytes:()=>Math.ceil(retained*1.5),onRetainedBytesChange:(listener:()=>void)=>{listeners.add(listener);return()=>listeners.delete(listener);},
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
        if(options.onWireOutput)try{options.onWireOutput(Buffer.byteLength(JSON.stringify(out.output),'utf8'));}catch{/* Instrumentation must not alter parsing. */}
        const locate=row.locate;
        const fetchFragments=locate?async(selectors:string[])=>{
          const again=await options.registry.open(opened.info.digest);
          if(!again||again.declarations.kind!=='skill')throw new IntegrityError('冻结技能包缺失或被改变');
          const located=await callPackFunction({packDir:again.handle.directory,module:locate.module,export:locate.export},{...input,selectors},limitsBox,options.sandbox);
          return located.output;
        }:undefined;
        return hydrate(out.output,row.parser,fetchFragments,input.bytes.length,limits);
      }catch(error){if(error instanceof ParseError||error instanceof IntegrityError||error instanceof SandboxError)throw error;throw new ParseError(row.parser,'技能包解析未完成；请管理员核对沙箱及该技能包，修正后重读');}
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

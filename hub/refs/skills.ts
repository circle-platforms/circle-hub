// Package lifecycle stays in the platform; parser algorithms execute only in the package sandbox.
import type {SkillParserRegistryPort,OpenedSkillPack} from '../ports.ts';
import {SkillLocks,type SkillDependency,type SkillLock} from '../../contracts/src/skills.ts';
import type {SkillDeclaration} from '../../contracts/src/pack.ts';
import type {RecordsKit,Principal} from '../records/api.ts';
import {ConflictError,IntegrityError} from '../records/api.ts';
import type {RunRecord} from '../../contracts/src/run.ts';
import {callPackFunction,SandboxError,type SandboxOptions} from '../rules/api.ts';
import {createDefaultRegistry} from './parsers/index.ts';
import {createParserRegistry,ParseError,ParseLimitError,ParseSyntaxError,ParseEncodingError,QUOTATION_UNITS,DEFAULT_MAX_SELECTOR_CHARS,type ParserRegistry,type Parser,type ParsedDocument,type Fragment,type JsonValue,type JsonObject,type ParseLimits,type QuotationUnits} from './parser.ts';
import {withParserSite} from './sandbox-diagnostic.ts';

const object=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const missing=(message:string)=>new ConflictError(message,{fix:'管理员安装所需通用技能包，并使用已冻结技能摘要的运行重读'});
const readRun=async(records:RecordsKit,run:string)=>(await records.store.find<RunRecord>({kind:'run',key:'runs.id',value:run,limit:1})).items[0]??null;
export interface SkillParserOptions {registry:SkillParserRegistryPort;records:RecordsKit;sandbox?:SandboxOptions;now?:()=>Date;/** Optional output-size instrumentation; never receives package data. */onWireOutput?:(bytes:number)=>void}

const LOCATE_BATCH=256;
/**
 * Sandbox limits of every parse and locate call of a skill parser. The time limit is a backstop for a parser that does not
 * finish; parsing itself is linear in the input. The owner raised it from 5 s on 2026-10-29 (#86) so that a slower machine
 * than the one a document was tried on does not refuse it: what stops a large document is the sandbox's memory limit, which
 * every skill's parsing reaches well within this time (hub/refs/README.md, Skill parser limits).
 */
export const PARSE_SANDBOX_LIMITS={timeoutMs:30_000,inputBytes:96*1024*1024,outputBytes:64*1024*1024} as const;

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

function parserOf(opened:OpenedSkillPack,row:SkillDeclaration['parsers'][number],options:SkillParserOptions):Parser{
  const split=row.parser.lastIndexOf('@'),id=row.parser.slice(0,split),version=Number(row.parser.slice(split+1));
  return {id,version,mediaTypes:row.media_types,limits:row.limits,skill_digest:opened.info.digest,
    parse(){throw new ParseError(row.parser,'技能包解析必须经平台异步沙箱调用');},
    async parseAsync(bytes,parseOptions={}){
      const limits={...row.limits};
      for(const key of Object.keys(row.limits) as (keyof ParseLimits)[]){const requested=parseOptions[key];if(requested!==undefined){if(!Number.isSafeInteger(requested)||requested<=0)throw new ParseError(row.parser,'解析限额必须是正整数');limits[key]=Math.min(row.limits[key]!,requested);}}
      if(bytes.length>limits.maxBytes)throw new ParseLimitError(row.parser,'maxBytes',limits.maxBytes,'原件超过技能包声明的字节限额');
      const verified=await (opened.info.space&&opened.info.space!=='team'?options.registry.personal?.open(opened.info.space,opened.info.digest):options.registry.open(opened.info.digest));
      if(!verified||verified.declarations.kind!=='skill')throw new IntegrityError('冻结技能包缺失或被改变');
      try{
        const input={bytes:Buffer.from(bytes).toString('base64'),options:{...parseOptions,...limits}};
        const site=(phase:'parse'|'locate',fn:{module:string;export?:string})=>({parser:row.parser,pack:`${opened.info.id}@${opened.info.version}`,module:fn.module,export:fn.export??'default',phase});
        const out=await callPackFunction({packDir:verified.handle.directory,module:row.function.module,export:row.function.export},input,PARSE_SANDBOX_LIMITS,options.sandbox).catch(error=>{throw withParserSite(error,site('parse',row.function));});
        if(options.onWireOutput)try{options.onWireOutput(Buffer.byteLength(JSON.stringify(out.output),'utf8'));}catch{/* Instrumentation must not alter parsing. */}
        const locate=row.locate;
        const fetchFragments=locate?async(selectors:string[])=>{
          const again=await (opened.info.space&&opened.info.space!=='team'?options.registry.personal?.open(opened.info.space,opened.info.digest):options.registry.open(opened.info.digest));
          if(!again||again.declarations.kind!=='skill')throw new IntegrityError('冻结技能包缺失或被改变');
          const located=await callPackFunction({packDir:again.handle.directory,module:locate.module,export:locate.export},{...input,selectors},PARSE_SANDBOX_LIMITS,options.sandbox).catch(error=>{throw withParserSite(error,site('locate',locate));});
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
    for(const lock of locks){const opened=await (lock.space?registry.personal?.open(lock.space,lock.digest):registry.open(lock.digest));
      if(!opened||opened.info.id!==lock.pack||opened.info.version!==lock.version||opened.declarations.kind!=='skill')throw missing(`冻结技能包 ${lock.pack}@${lock.version}（摘要 ${lock.digest}）不可读取`);
      for(const row of opened.declarations.skill.parsers)parsed.push(parserOf(opened,row,options));
    }
    // Installed format parsers precede the generic transitional JSON parser. Duplicate parser@version is refused.
    const out=createParserRegistry([...parsed,...createDefaultRegistry().list()]);
    out.skills=locks.map(lock=>({...lock}));
    out.unavailable=key=>`缺少解析器 ${key} 的已安装/冻结通用技能包；下一步：管理员安装所需技能并重开运行`;
    return out;
  };
  const freeze=async(dependencies:readonly SkillDependency[],context?:{principal:Principal;space?:string})=>{
    const available=await registry.installedSkills();
    const skills:SkillLock[]=available.map(pack=>({pack:pack.info.id,version:pack.info.version,digest:pack.info.digest}));
    const resolved=new Set<string>();
    const pending=dependencies.map(dep=>({dep,scope:context?.space&&context.space!=='team'?context.space:undefined}));
    while(pending.length){
      const {dep,scope:inherited}=pending.shift()!,scope=dep.space??inherited;
      let chosen:SkillLock|undefined;
      if(scope&&context&&registry.personal){
        const found=await registry.personal.resolve(context.principal,scope,dep.pack+(dep.version?'@'+dep.version:''));
        if(found?.kind==='skill')chosen={pack:found.id,version:found.version,digest:found.digest,space:scope};
        else if(dep.space)throw missing('个人通用技能不可读取；由所有者授权后重新开始');
      }
      if(!chosen){const team=available.find(pack=>pack.info.id===dep.pack&&(dep.version===undefined||dep.version===pack.info.version));
        if(team)chosen={pack:team.info.id,version:team.info.version,digest:team.info.digest};
      }
      if(!chosen)throw missing(`${scope?'缺少可读取的通用技能':'缺少已安装技能包'} ${dep.pack}${dep.version?'@'+dep.version:''}；新运行没有开始`);
      const key=(chosen.space??'team')+'/'+chosen.pack,prior=skills.find(lock=>(lock.space??'team')+'/'+lock.pack===key);
      if(prior&&prior.digest!==chosen.digest)throw missing('同一技能空间存在冲突的依赖版本，不能开始运行');
      if(chosen.space){const team=skills.findIndex(lock=>lock.pack===chosen!.pack&&!lock.space);if(team>=0)skills.splice(team,1);}
      if(!prior)skills.push(chosen);
      if(skills.length>64)throw missing('冻结的通用技能超过 64 个，不能开始运行');
      if(resolved.has(key))continue;resolved.add(key);
      const opened=chosen.space?await registry.personal?.open(chosen.space,chosen.digest):await registry.open(chosen.digest);
      for(const nested of opened?.info.manifest.dependencies??[])pending.push({dep:nested,scope:chosen.space});
    }
    for(const lock of skills){
      const opened=lock.space?await registry.personal?.open(lock.space,lock.digest):await registry.open(lock.digest);
      for(const dep of opened?.info.manifest.dependencies??[]){
        const scope=dep.space??lock.space;
        const match=skills.some(value=>value.pack===dep.pack&&(value.space===scope||!dep.space&&!value.space)&&(dep.version===undefined||dep.version===value.version));
        if(!match)throw missing(`通用技能 ${lock.pack} 缺少已锁定依赖 ${dep.pack}`);
      }
    }
    return {skills,parsers:await load(skills)};
  };
  const facade:ParserRegistry={register:parser=>current.register(parser),get:key=>current.get(key),forMediaType:type=>current.forMediaType(type),list:()=>current.list(),
    refresh:async()=>{current=(await freeze([])).parsers;},freeze,
    unavailable:key=>current.unavailable?.(key),
    async forReference(parser,reader,options){
      const scoped=await freeze([]);
      const selected=scoped.parsers;
      if(selected.get(parser))return selected;
      if(options?.teamOnly)return selected;
      if(reader?.user&&registry.personal){
        const account=await records.principals.get(reader.user);
        if(account&&!account.disabled){
          const matches=(await registry.personal.skills(account)).filter(pack=>pack.declarations.kind==='skill'&&pack.declarations.skill.parsers.some(row=>row.parser===parser));
          if(matches.length>1)throw missing('多份个人技能声明了同一解析器；提供锁定技能空间的运行号后重读');
          if(matches.length){const info=matches[0].info;return (await freeze([{pack:info.id,version:info.version,space:info.space!}],{principal:account,space:info.space})).parsers;}
        }
      }
      return selected;
    },
    async forRun(run,reader){
      const stored=await readRun(records,run);if(!stored)throw missing('运行不存在，无法确定解析器摘要');
      const authorize=async(locks:readonly SkillLock[])=>{
        for(const lock of locks)if(lock.space){
          const ids=new Set([stored.body.runner,...(reader?.user?[reader.user]:[])]);
          for(const id of ids){const account=id?await records.principals.get(id):null;if(!account||account.disabled||!await registry.personal?.mayUse(account,lock.space,lock.pack))throw missing('冻结通用技能的使用授权已收回或不可读取；由所有者补齐授权后重读');}
        }
      };
      const locks=SkillLocks.parse(stored.body.skills);
      await authorize(locks);const out=await load(locks);
      out.unavailable=key=>`运行 ${run} 未锁定解析器 ${key} 所需的技能包摘要；下一步：管理员安装所需技能并重新开始运行`;
      return out;
    }};
  return facade;
}

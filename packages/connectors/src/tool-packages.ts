import {z} from 'zod';
import {ApiError,canonicalHash,requireCondition} from '../../contracts/src/index.ts';
import {commandHeads,commandParam,commandCheck} from '../../methods/src/command-tree.ts';
import {HttpSource,type RawReturn} from './readonly-sdk.ts';
import {Documents,DocumentOptions} from './documents.ts';
import {BuildSite,BuildSiteOptions,buildCoverage,resolveBuilds,type BuildRecord} from './build-site.ts';
import {QueryMirror} from './query-mirror.ts';
import {EnvironmentView} from './environment-view.ts';
import {SourceCache} from './source-cache.ts';
import {projectSource} from './product-projections.ts';
import type {ProductObservation} from '../../knowledge/src/product-records.ts';

export interface ToolDefinition {suffix:string;title:string;description:string;schema:z.ZodObject<any>;effect:'read'|'write';mode:'sync'|'task';permission:string;handler:string}
export const ConnectorOptions=z.object({buildSite:BuildSiteOptions.optional(),documents:DocumentOptions.optional()}).strict();
export type ConnectorOptions=z.infer<typeof ConnectorOptions>;
export interface ToolPackage {id:string;prefix:string;productLinePrefixes?:Record<string,string>;profileOptions?:ConnectorOptions;productLineOptions?:Record<string,ConnectorOptions>;tools:ToolDefinition[];projection?:{version:string;extract:(raw:RawReturn[],profile:ConnectorProfile)=>Promise<ProductObservation[]>}}
const tool=(suffix:string,title:string,schema:z.ZodObject<any>,permission:string,handler:string,effect:'read'|'write'='read',mode:'sync'|'task'='sync'):ToolDefinition=>({suffix,title,description:title,schema,permission,handler,effect,mode});
const short=z.string().min(1).max(500),build=z.string().min(1).max(200);
const selection={build,platform:short.nullable().optional(),scope:short.optional(),versionLine:short.optional()};
const versionQuery=z.object({versionLine:short.optional(),page:z.number().int().min(1).max(1_000_000).default(1),limit:z.number().int().min(1).max(100).default(20),formal:z.boolean().optional(),platform:short.nullable().optional(),current:z.boolean().optional(),commandTreeAvailable:z.boolean().optional()}).strict();
const compactCoverage=(coverage:ReturnType<typeof buildCoverage>)=>({complete:coverage.complete,counts:{readPages:coverage.readPages.length,missing:coverage.missing.length,conflicts:coverage.conflicts.length,superseded:coverage.superseded.length},missing:coverage.missing.slice(0,20),conflicts:coverage.conflicts.slice(0,20).map(item=>({buildId:item.buildId,name:item.name,platform:item.platform,code:item.code})),superseded:coverage.superseded.slice(0,20).map(item=>({buildId:item.buildId,name:item.name,platform:item.platform,count:item.revisions.length})),detailsTruncated:[coverage.missing,coverage.conflicts,coverage.superseded].some(items=>items.length>20)});
export const toolPackages:ToolPackage[]=[
  {id:'build-site',prefix:'buildsite',tools:[
    tool('versions','分页列出精简构建：默认20、最多100；按正式发布日期倒序；可筛选版本线、主平台和可用命令树',versionQuery,'builds.read','build.versions'),
    tool('command_tree','取固定构建的命令树投影',z.object(selection).strict(),'builds.read','build.tree'),
    tool('fixed_releases','按编号体系核对相关构建修复清单；保留覆盖范围',z.object({legacyIssueId:z.string().regex(/^\d*$/).optional(),issueId:z.string().regex(/^\d*$/).optional(),issueSystem:z.enum(['bugzilla','zentao']).default('bugzilla'),builds:z.array(build).min(1).max(20),platform:short.nullable().optional(),versionLine:short.optional()}).strict().refine(args=>args.issueId!==undefined||args.legacyIssueId!==undefined,'Provide an issue identifier').refine(args=>args.issueId===undefined||args.legacyIssueId===undefined||args.issueId===args.legacyIssueId,'Issue identifiers disagree'),'builds.read','build.fixed'),
    tool('command_heads','查命令头；超过 128 条明确失败',z.object({...selection,prefix:z.string().max(500)}).strict(),'builds.read','build.heads'),
    tool('command_param','最长匹配命令头及参数；最多八词',z.object({...selection,head:short}).strict(),'builds.read','build.parameters'),
    tool('command_check','按固定 XML 与确定性规则核对命令',z.object({...selection,commands:z.array(z.string().max(2000)).min(1).max(200)}).strict(),'builds.read','build.check'),
  ]},
  {id:'documents',prefix:'docs',tools:[
    tool('list','列出只读文档目录',z.object({path:short.optional()}).strict(),'docs.fetch','document.list'),
    tool('get','取文档原件与摘要',z.object({file:short}).strict(),'docs.fetch','document.get'),
    tool('search','在选定版本目录内有界递归查询文档并复用原件',z.object({query:short,path:short.optional(),version:short.optional()}).strict(),'docs.fetch','document.search'),
    tool('section','取命令小节或行窗口，最多 80 行',z.object({file:short,anchor:short.optional(),line:z.number().int().positive().optional(),window:z.number().int().min(1).max(80).default(40)}).strict().refine(value=>!!value.anchor!==!!value.line,'Provide an anchor or line'),'docs.fetch','document.section'),
  ]},
  {id:'query-mirror',prefix:'query',tools:[
    tool('bug_search','查询只读缺陷镜像',z.object({keyword:short.optional(),product:z.union([short,z.number().int().nonnegative()]).optional(),status:short.optional(),severity:z.number().int().min(1).max(5).optional(),assignedTo:short.optional(),openedBy:short.optional(),lastEditedDate_start:short.optional(),lastEditedDate_end:short.optional()}).strict(),'defects.search','mirror.search'),
    tool('bug_detail','批量取缺陷详情（每批最多 100）',z.object({ids:z.array(z.union([z.number().int().nonnegative(),z.string().regex(/^\d+$/)])).min(1).max(100)}).strict(),'defects.search','mirror.detail'),
  ]},
  {id:'environment-view',prefix:'env',tools:[
    tool('inventory','经只读跳板列出环境资源',z.object({}).strict(),'environment.read','environment.inventory'),
    tool('topology','查看环境拓扑',z.object({environmentId:short}).strict(),'environment.read','environment.topology'),
    tool('device_status','查看设备状态',z.object({deviceId:short}).strict(),'environment.read','device.status'),
    tool('framework_files','查看框架镜像文件目录',z.object({}).strict(),'environment.read','framework.files'),
    tool('framework_get','取框架镜像文件',z.object({path:short}).strict(),'environment.read','framework.get'),
  ]},
  {id:'knowledge',prefix:'knowledge',tools:[
    tool('shared_fragments','分页取本人明确许可共享的片段与原始证据',z.object({limit:z.number().int().min(1).max(100).default(20),after:z.string().min(1).max(2048).optional()}).strict(),'knowledge.read','consolidation.fragments'),
    tool('claim_submit','提交个人沉淀候选；不自动提升为团队知识',z.object({claim:z.object({subject:short,predicate:short,value:z.unknown(),conditions:z.record(z.string(),z.unknown()).default({})}).strict(),evidence:z.array(z.object({evidenceId:z.string(),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict()).min(1).max(100)}).strict(),'knowledge.submit','candidate.submit','write','task'),
  ]},
];
for(const pack of toolPackages)if(pack.id!=='knowledge')pack.projection={version:pack.id==='build-site'?'source-projection/3':'source-projection/1',extract:(raw,profile)=>projectSource(pack.id,raw,profile)};
export interface ConnectorProfile {origin:string;root?:string;index?:string;payloadField?:string;requestConcurrency?:number;requestIntervalMs?:number;buildSite?:BuildSiteOptions;documents?:DocumentOptions}
export interface ToolReturn {result:any;raw:RawReturn[];sourceType:string}
const defaultToolCache=new SourceCache();
export async function executeTool(packageId:string,handler:string,args:any,profile:ConnectorProfile,credential?:string,options:{cache?:SourceCache;cacheNamespace?:string}={}):Promise<ToolReturn>{
  if(handler==='candidate.submit')return {result:args,raw:[],sourceType:'skill-run'};
  if(handler==='consolidation.fragments')return {result:args,raw:[],sourceType:'shared-session'};
  const source=new HttpSource(profile.origin,{...(credential?{authorization:()=>credential}:{}),timeoutMs:5000,requestConcurrency:profile.requestConcurrency??2,requestIntervalMs:profile.requestIntervalMs??(packageId==='build-site'?200:0)});
  if(packageId==='build-site'){
    if(handler==='build.versions')args=versionQuery.parse(args);
    const site=new BuildSite(source,options.cache??defaultToolCache,canonicalHash([options.cacheNamespace??profile.origin,credential??null]));
    let catalog:Awaited<ReturnType<BuildSite['catalog']>>;
    const references: string[]=handler==='build.fixed'?args.builds:handler==='build.versions'?[]:[args.build],locations=references.length?await site.locations(references,args.platform,profile.buildSite):[];
    if(references.length&&references.every(reference=>locations.some(location=>location.buildId===reference||location.name===reference))){
      const pages:RawReturn[]=[],builds:BuildRecord[]=[];
      for(const location of [...new Map(locations.map(location=>[location.listingPath,location])).values()]){const page=await site.listing(location.listingPath,site.contextFor(location.listingPath,profile.buildSite,location));pages.push(page.evidence);builds.push(...page.result);}
      const resolved=resolveBuilds(builds);catalog={index:{lines:[],platforms:[],evidence:pages[0]},builds:resolved,pages,coverage:buildCoverage(resolved,[],pages.map(page=>page.path))};
    }else catalog=await site.catalog(profile.index??'/',{versionLine:args.versionLine,buildSite:profile.buildSite});
    const {index,builds}=catalog,raw:RawReturn[]=catalog.pages.map(page=>({...page,sourceType:'build-record'}));await site.remember(builds,catalog.pages.map(page=>page.path),profile.buildSite);
    const select=(reference:string)=>{
      const candidates=builds.filter(build=>(build.buildId===reference||build.name===reference)&&(args.platform===undefined||args.platform===null?args.platform===undefined||build.platform===null:build.platform?.toLowerCase()===args.platform.toLowerCase()));
      requireCondition(candidates.length,'SOURCE_ABSENT','Build is absent from the authorized source');
      if(candidates.length!==1)throw new ApiError('INVALID_PAYLOAD','Build name requires an explicit platform or build id',{reason:'ambiguous_build',builds:candidates.map(build=>({buildId:build.buildId,platform:build.platform}))});
      if(candidates[0].conflict)throw new ApiError('INVALID_PAYLOAD','Build has unresolved page revisions',{reason:'build_revision_conflict',buildId:candidates[0].buildId});return candidates[0];
    };
    if(handler==='build.versions'){
      const selected=builds.filter(build=>(args.formal===undefined||build.formal===args.formal)&&(args.current===undefined||build.current===args.current)&&(args.commandTreeAvailable===undefined||build.commandTreeAvailable===args.commandTreeAvailable)&&(args.platform===undefined||args.platform===null?args.platform===undefined||build.platform===null:build.platform?.toLowerCase()===args.platform.toLowerCase())).sort((a,b)=>Number(b.formal)-Number(a.formal)||(b.releasedOn??'').localeCompare(a.releasedOn??'')||Number(b.current)-Number(a.current)||(a.platform??'').localeCompare(b.platform??'')||a.name.localeCompare(b.name)||a.buildId.localeCompare(b.buildId));
      const total=selected.length,offset=(args.page-1)*args.limit,hasMore=offset+args.limit<total,filters={versionLine:args.versionLine,formal:args.formal,platform:args.platform,current:args.current,commandTreeAvailable:args.commandTreeAvailable};
      return {result:{versionLines:index.lines.map(line=>({versionLine:line.versionLine,title:line.title})),builds:selected.slice(offset,offset+args.limit).map(({name,buildId,formal,releasedOn,current,platform,commandTreeAvailable})=>({name,buildId,formal,releasedOn,current,platform,commandTreeAvailable})),page:args.page,limit:args.limit,total,totalPages:Math.ceil(total/args.limit),hasMore,nextPage:hasMore?args.page+1:null,revision:canonicalHash({filters,pages:catalog.pages.map(page=>[page.path,page.sha256]).sort()}),coverage:compactCoverage(catalog.coverage)},raw,sourceType:'build-record'};
    }
    if(handler==='build.fixed'){
      const candidates:BuildRecord[]=[...new Map<string,BuildRecord>(args.builds.map((reference:string)=>{const build=select(reference);return [build.buildId,build];})).values()];
      const fixed=await site.releasesFor({system:args.issueSystem??'bugzilla',id:args.issueId??args.legacyIssueId},candidates);raw.push(...fixed.evidence.map((evidence:RawReturn)=>({...evidence,sourceType:'build-record'})));const {evidence,...result}=fixed;return {result,raw,sourceType:'build-record'};
    }
    const build=select(args.build);requireCondition(build.files.commands,'SOURCE_ABSENT','Build has no command tree');
    const tree=await site.commandTree(build),xml=tree.evidence;raw.push({...xml,sourceType:'command-tree'});const commands=args.scope===undefined?tree.result:tree.result.filter(command=>command.scope===args.scope);
    requireCondition(args.scope===undefined||commands.length>0,'SOURCE_ABSENT','Command scope is absent from the authorized source');
    const result=handler==='build.heads'?commandHeads(commands,args.prefix):handler==='build.parameters'?commandParam(commands,args.head):handler==='build.check'?commandCheck(commands,args.commands):{commands};
    return {result:{build:build.name,buildId:build.buildId,platform:build.platform,scope:args.scope??null,parserVersion:tree.parserVersion,sourceSha256:xml.sha256,coverage:catalog.coverage,...result},raw,sourceType:'command-tree'};
  }
  if(packageId==='documents'){
    const documents=new Documents(source);
    if(handler==='document.list'){const listed=await documents.list(args.path??profile.root??'/');return {result:{files:listed.result},raw:[listed.evidence],sourceType:'document'};}
    if(handler==='document.get'){const file=await documents.get(args.file);if(file.evidence.etag)await (options.cache??defaultToolCache).put(canonicalHash({namespace:canonicalHash([options.cacheNamespace??profile.origin,credential??null]),origin:source.identity(),path:file.evidence.path,revision:file.evidence.etag}),file.evidence);return {result:file.result,raw:[file.evidence],sourceType:'document'};}
    if(handler==='document.search'){
      const searched=await documents.search(args,profile.root??'/',profile.documents,options.cache??defaultToolCache,canonicalHash([options.cacheNamespace??profile.origin,credential??null]));return {...searched,sourceType:'document'};
    }
    const original=(await documents.get(args.file)).evidence,lines=original.bytes.toString('utf8').split(/\r?\n/);let start=0,end=0;
    if(args.anchor){start=lines.findIndex(line=>line.toLowerCase().startsWith(`**${args.anchor.toLowerCase()}**`));requireCondition(start>=0,'SOURCE_ABSENT','Document section is absent');end=lines.findIndex((line,index)=>index>start&&/^\*\*[^*]+\*\*/.test(line));if(end<0)end=lines.length;
      if(end-start>80)throw new ApiError('RESULT_TOO_LARGE','Document section exceeds eighty lines',{outcome:'result_too_large',count:end-start,limit:80});
    }else{requireCondition(args.line<=lines.length,'SOURCE_ABSENT','Document line is absent');start=Math.max(0,args.line-1-Math.floor(args.window/2));end=Math.min(lines.length,start+args.window);}
    return {result:{file:original.path,lines:lines.slice(start,end).map((text,index)=>({line:start+index+1,text})),sourceSha256:original.sha256},raw:[original],sourceType:'document'};
  }
  if(packageId==='query-mirror'){
    const mirror=new QueryMirror(source,profile.payloadField??'data');
    if(handler==='mirror.detail'){const detail=await mirror.detail(args.ids);return {result:{items:detail.items},raw:[detail.evidence],sourceType:'query-mirror'};}
    const {keyword,...filters}=args,listed=await mirror.list(filters);requireCondition(Array.isArray(listed.result),'SOURCE_UNREACHABLE','Mirror list payload is malformed');
    return {result:{items:listed.result.filter((bug:any)=>!keyword||String(bug.title??'').toLowerCase().includes(keyword.toLowerCase()))},raw:[listed.evidence],sourceType:'query-mirror'};
  }
  if(packageId==='environment-view'){const result=await new EnvironmentView(source).call(handler,args);return {result:result.result,raw:[result.evidence],sourceType:'environment-view'};}
  throw new ApiError('INVALID_PAYLOAD','Tool handler is not registered');
}

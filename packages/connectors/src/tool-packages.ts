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
import type {SourceArtifactSnapshot} from '../../knowledge/src/source-artifacts.ts';
import {gatewayMetadata} from './gateway-metadata.ts';
import type {GatewayProfile} from './case-gateway.ts';

export interface ToolDefinition {suffix:string;title:string;description:string;schema:z.ZodObject<any>;effect:'read'|'write';mode:'sync'|'task';minimumRole?:'viewer'|'member'|'admin';approval?:boolean;annotations?:Record<string,unknown>;permission:string;handler:string;sourceParameter?:string}
export const ConnectorOptions=z.object({buildSite:BuildSiteOptions.optional(),documents:DocumentOptions.optional()}).strict();
export type ConnectorOptions=z.infer<typeof ConnectorOptions>;
export interface ToolPackage {id:string;prefix:string;productLinePrefixes?:Record<string,string>;profileOptions?:ConnectorOptions;productLineOptions?:Record<string,ConnectorOptions>;tools:ToolDefinition[];projection?:{version:string;extract:(raw:RawReturn[],profile:ConnectorProfile)=>Promise<ProductObservation[]>}}
export const defineTool=(suffix:string,title:string,schema:z.ZodObject<any>,permission:string,handler:string,effect:'read'|'write',mode:'sync'|'task'='sync'):ToolDefinition=>{requireCondition(effect==='read'||effect==='write','INVALID_PAYLOAD','Tool effect must be explicitly declared');return ({suffix,title,description:title,schema,permission,handler,effect,mode,minimumRole:effect==='read'?'viewer':'member',approval:effect==='write',annotations:{readOnlyHint:effect==='read',destructiveHint:effect==='write'}});};
const tool=defineTool;
const short=z.string().min(1).max(500),build=z.string().min(1).max(200);
const pagination={page:z.number().int().min(1).max(1_000_000).default(1),limit:z.number().int().min(1).max(100).default(20)};
const mirrorQuery=z.object({keyword:short.optional(),product:z.union([z.string().regex(/^[1-9]\d*$/,'Use a positive product id from the products tool'),z.number().int().positive()]).optional(),status:z.enum(['active','resolved','closed']).optional(),severity:z.number().int().min(1).max(5).optional(),assignedTo:short.optional(),openedBy:short.optional(),lastEditedDate_start:short.optional(),lastEditedDate_end:short.optional(),...pagination}).strict().superRefine((value,ctx)=>{
  if(value.keyword!==undefined&&value.product===undefined||![value.product,value.status,value.lastEditedDate_start,value.lastEditedDate_end].some(v=>v!==undefined&&String(v).trim()!==''))ctx.addIssue({code:'custom',message:'Provide product, status or date filters; keyword also requires product'});
});
const selection={build,platform:short.nullable().optional(),scope:short.optional(),versionLine:short.optional()};
const versionQuery=z.object({versionLine:short.optional(),page:z.number().int().min(1).max(1_000_000).default(1),limit:z.number().int().min(1).max(100).default(20),formal:z.boolean().optional(),platform:short.nullable().optional(),current:z.boolean().optional(),commandTreeAvailable:z.boolean().optional()}).strict();
const compactCoverage=(coverage:ReturnType<typeof buildCoverage>)=>({complete:coverage.complete,counts:{readPages:coverage.readPages.length,missing:coverage.missing.length,conflicts:coverage.conflicts.length,superseded:coverage.superseded.length},missing:coverage.missing.slice(0,20),conflicts:coverage.conflicts.slice(0,20).map(item=>({buildId:item.buildId,name:item.name,platform:item.platform,code:item.code})),superseded:coverage.superseded.slice(0,20).map(item=>({buildId:item.buildId,name:item.name,platform:item.platform,count:item.revisions.length})),detailsTruncated:[coverage.missing,coverage.conflicts,coverage.superseded].some(items=>items.length>20)});
export const toolPackages:ToolPackage[]=[
  {id:'build-site',prefix:'buildsite',tools:[
    tool('versions','分页列出精简构建：默认20、最多100；按正式发布日期倒序；可筛选版本线、主平台和可用命令树',versionQuery,'builds.read','build.versions','read'),
    tool('command_tree','取固定构建的命令树投影',z.object(selection).strict(),'builds.read','build.tree','read'),
    tool('fixed_releases','按编号体系核对相关构建修复清单；保留覆盖范围',z.object({legacyIssueId:z.string().regex(/^\d*$/).optional(),issueId:z.string().regex(/^\d*$/).optional(),issueSystem:z.enum(['bugzilla','zentao']).default('bugzilla'),builds:z.array(build).min(1).max(20),platform:short.nullable().optional(),versionLine:short.optional()}).strict().refine(args=>args.issueId!==undefined||args.legacyIssueId!==undefined,'Provide an issue identifier').refine(args=>args.issueId===undefined||args.legacyIssueId===undefined||args.issueId===args.legacyIssueId,'Issue identifiers disagree'),'builds.read','build.fixed','read'),
    tool('command_heads','查命令头；超过 128 条明确失败',z.object({...selection,prefix:z.string().max(500)}).strict(),'builds.read','build.heads','read'),
    tool('command_param','最长匹配命令头及参数；最多八词',z.object({...selection,head:short}).strict(),'builds.read','build.parameters','read'),
    tool('command_check','按固定 XML 与确定性规则核对命令',z.object({...selection,commands:z.array(z.string().max(2000)).min(1).max(200)}).strict(),'builds.read','build.check','read'),
  ]},
  {id:'documents',prefix:'docs',tools:[
    tool('list','分页列文档目录；path 省略用已登记根，须为站点绝对目录路径',z.object({path:short.optional(),...pagination}).strict(),'docs.fetch','document.list','read'),
    tool('get','取文档原件与摘要',z.object({file:short}).strict(),'docs.fetch','document.get','read'),
    tool('search','分页查选定目录；每页最多20个原件（limit上限100），按 nextCursor 传 after 补读，coverage.complete 才是完整搜索',z.object({query:short,path:short.optional(),version:short.optional(),limit:pagination.limit,after:z.string().min(1).max(2048).optional()}).strict(),'docs.fetch','document.search','read'),
    tool('section','取命令小节或行窗口，最多 80 行',z.object({file:short,anchor:short.optional(),line:z.number().int().positive().optional(),window:z.number().int().min(1).max(80).default(40)}).strict().refine(value=>!!value.anchor!==!!value.line,'Provide an anchor or line'),'docs.fetch','document.section','read'),
  ]},
  {id:'query-mirror',prefix:'query',tools:[
    tool('products','分页列出当前镜像身份可读的产品 id/name，用于有界缺陷搜索',z.object(pagination).strict(),'defects.search','mirror.products','read'),
    tool('bug_search','分页查询镜像；必须带 product、status 或日期；keyword 还必须带 product，避免全表扫描',mirrorQuery,'defects.search','mirror.search','read'),
    tool('bug_detail','批量取缺陷详情（每批最多 100）',z.object({ids:z.array(z.union([z.number().int().nonnegative(),z.string().regex(/^\d+$/)])).min(1).max(100)}).strict(),'defects.search','mirror.detail','read'),
  ]},
  {id:'environment-view',prefix:'env',tools:[
    tool('inventory','经只读跳板列出环境资源',z.object({}).strict(),'environment.read','environment.inventory','read'),
    tool('topology','查看环境拓扑',z.object({environmentId:short}).strict(),'environment.read','environment.topology','read'),
    tool('device_status','查看设备状态',z.object({deviceId:short}).strict(),'environment.read','device.status','read'),
    tool('framework_files','查看框架镜像文件目录',z.object({}).strict(),'environment.read','framework.files','read'),
    tool('framework_get','取框架镜像文件',z.object({path:short}).strict(),'environment.read','framework.get','read'),
  ]},
  {id:'case-gateway',prefix:'gateway',tools:[
    {...tool('health','核对网关凭据链路，只调用 lease_status、不占租约',z.object({}).strict(),'tools.read','gateway.health','read'),minimumRole:'member'},
    {...tool('topology','在 worker 租约内读取床拓扑，立即释放；仅返回主机名，原始观察保留为受控证据',z.object({}).strict(),'tools.read','gateway.topology','read'),minimumRole:'member'},
  ]},
  {id:'knowledge',prefix:'knowledge',tools:[
    tool('shared_fragments','分页取本人明确许可共享的片段与原始证据',z.object({limit:z.number().int().min(1).max(100).default(20),after:z.string().min(1).max(2048).optional()}).strict(),'knowledge.read','consolidation.fragments','read'),
    tool('claim_submit','提交个人沉淀候选；不自动提升为团队知识',z.object({claim:z.object({subject:short,predicate:short,value:z.unknown(),conditions:z.record(z.string(),z.unknown()).default({})}).strict(),evidence:z.array(z.object({evidenceId:z.string(),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict()).min(1).max(100)}).strict(),'knowledge.submit','candidate.submit','write','task'),
  ]},
];
for(const pack of toolPackages){if(pack.id==='build-site')for(const definition of pack.tools)if(Object.hasOwn(definition.schema.shape,'build'))definition.sourceParameter='build';if(pack.id!=='knowledge')pack.projection={version:pack.id==='build-site'?'source-projection/3':pack.id==='query-mirror'?'source-projection/2':'source-projection/1',extract:(raw,profile)=>projectSource(pack.id,raw,profile)};}
export interface ConnectorProfile {origin:string;root?:string;index?:string;payloadField?:string;requestConcurrency?:number;requestIntervalMs?:number;authorizationScheme?:'raw'|'bearer';buildSite?:BuildSiteOptions;documents?:DocumentOptions;gateway?:GatewayProfile;sourceArtifact?:SourceArtifactSnapshot;allowPlaintextAuthentication?:boolean;runtimeProfileAssetId?:string;runtimeProfileVersion?:string}
export interface ToolReturn {result:any;raw:RawReturn[];sourceType:string}
const defaultToolCache=new SourceCache();
export async function executeTool(packageId:string,handler:string,args:any,profile:ConnectorProfile,credential?:string,options:{cache?:SourceCache;cacheNamespace?:string;freshCommands?:boolean;sourceArtifact?:SourceArtifactSnapshot;originals?:RawReturn[]}={}):Promise<ToolReturn>{
  if(packageId==='case-gateway'){requireCondition(profile.gateway&&credential,'SOURCE_LOGIN_EXPIRED','Gateway metadata requires its approved profile and credential');return gatewayMetadata(handler,profile.gateway,credential);}
  if(handler==='candidate.submit')return {result:args,raw:[],sourceType:'skill-run'};
  if(handler==='consolidation.fragments')return {result:args,raw:[],sourceType:'shared-session'};
  if(handler==='mirror.search'&&!mirrorQuery.safeParse(args).success)throw new ApiError('INVALID_PAYLOAD','Provide product, status or date filters; keyword also requires product. Use page and limit for compact results',{requiredFilters:['product','status','lastEditedDate_start','lastEditedDate_end']});
  const source=new HttpSource(profile.origin,{...(credential?{authorization:()=>profile.authorizationScheme==='bearer'?`Bearer ${credential}`:credential}:{}),allowPlaintextAuthentication:profile.allowPlaintextAuthentication===true,timeoutMs:packageId==='query-mirror'?30000:5000,requestConcurrency:profile.requestConcurrency??2,requestIntervalMs:profile.requestIntervalMs??(packageId==='build-site'?200:0)});
  if(options.sourceArtifact){
    const artifact=options.sourceArtifact,originals=options.originals??[];
    source.read=async(reference,request={})=>{const path=source.path(reference),method=request.method??'GET',binding=artifact.metadata.requests?.[`${method} ${path} ${canonicalHash(request.json??null)}`]??artifact.metadata.requests?.[`${method} ${path}`]??artifact.metadata.requests?.[path],selected=binding?`/${binding.path}`:path,raw=originals.find(file=>file.path===selected);requireCondition(raw,'SOURCE_ABSENT','Bound source artifact has no original for this request');return {...raw,path,artifactFilePath:raw.path,httpStatus:binding?.status??200};};
    if(packageId==='build-site'&&handler==='build.versions'){
      args=versionQuery.parse(args);const file=artifact.files.find(file=>file.role==='command-tree'),raw=originals.find(raw=>raw.path===`/${file?.path}`);requireCondition(file&&raw&&raw.sha256===file.sha256,'INVALID_PAYLOAD','Selected source artifact needs a command-tree original');
      const name=typeof artifact.metadata.buildName==='string'?artifact.metadata.buildName:artifact.sourceArtifactId,platform=typeof artifact.metadata.platform==='string'?artifact.metadata.platform:null,versionLine=typeof artifact.metadata.versionLine==='string'?artifact.metadata.versionLine:null;
      const build={name,buildId:artifact.sourceArtifactId,formal:false,releasedOn:null,current:true,platform,commandTreeAvailable:true};
      const matches=(args.versionLine===undefined||args.versionLine===versionLine)&&(args.formal===undefined||args.formal===build.formal)&&(args.current===undefined||args.current===build.current)&&(args.commandTreeAvailable===undefined||args.commandTreeAvailable===build.commandTreeAvailable)&&(args.platform===undefined||(args.platform===null?platform===null:platform?.toLowerCase()===args.platform.toLowerCase()));
      const total=Number(matches);return {result:{versionLines:versionLine?[{versionLine,title:versionLine}]:[],builds:matches&&args.page===1?[build]:[],page:args.page,limit:args.limit,total,totalPages:total,hasMore:false,nextPage:null,revision:artifact.assetSha256,coverage:{complete:true,counts:{readPages:0,missing:0,conflicts:0,superseded:0},missing:[],conflicts:[],superseded:[],detailsTruncated:false},source:{association:'operator-declared',live:false}},raw:[raw],sourceType:'external-artifact'};
    }
    if(packageId==='build-site'&&['build.tree','build.heads','build.parameters','build.check'].includes(handler)){
      const file=artifact.files.find(file=>file.role==='command-tree');requireCondition(file,'INVALID_PAYLOAD','Selected artifact needs a command-tree file');const raw=originals.find(raw=>raw.path===`/${file.path}`);requireCondition(raw&&raw.sha256===file.sha256,'SOURCE_HASH_MISMATCH','Selected command tree original is absent or changed');
      const commands=await new BuildSite(source).commandsFrom(raw.bytes);requireCondition(commands.length>0,'INVALID_PAYLOAD','Selected command tree has no recognized items');const selected=args.scope?commands.filter(command=>command.scope===args.scope):commands;
      const result=handler==='build.tree'?{commands:selected,parserVersion:'menu-path/2'}:handler==='build.heads'?commandHeads(selected,args.prefix):handler==='build.parameters'?commandParam(selected,args.head):commandCheck(selected,args.commands);
      return {result:{...result,build:artifact.sourceArtifactId,buildId:artifact.sourceArtifactId,source:{sourceArtifactId:artifact.sourceArtifactId,assetId:artifact.assetId,assetVersion:artifact.assetVersion,commandTreeSha256:file.sha256,buildName:artifact.metadata.buildName??null,association:'operator-declared',live:false}},raw:[raw],sourceType:'external-artifact'};
    }
  }
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
    const tree=await site.commandTree(build,options.freshCommands),xml=tree.evidence;raw.push({...xml,sourceType:'command-tree'});const commands=args.scope===undefined?tree.result:tree.result.filter(command=>command.scope===args.scope);
    requireCondition(args.scope===undefined||commands.length>0,'SOURCE_ABSENT','Command scope is absent from the authorized source');
    const result=handler==='build.heads'?commandHeads(commands,args.prefix):handler==='build.parameters'?commandParam(commands,args.head):handler==='build.check'?commandCheck(commands,args.commands):{commands};
    return {result:{build:build.name,buildId:build.buildId,platform:build.platform,scope:args.scope??null,parserVersion:tree.parserVersion,sourceSha256:xml.sha256,coverage:catalog.coverage,...result},raw,sourceType:'command-tree'};
  }
  if(packageId==='documents'){
    const documents=new Documents(source);if(['document.get','document.section'].includes(handler)){const base=source.path(profile.root??'/'),root=base.endsWith('/')?base:base+'/',file=source.path(args.file);requireCondition(file.startsWith(root),'SOURCE_FORBIDDEN','Document is outside the registered source root');args={...args,file};}
    if(handler==='document.list'){const selected=z.object({path:short.optional(),...pagination}).strict().parse(args),root=source.path(profile.root??'/'),requested=source.path(selected.path??root),path=requested.endsWith('/')?requested:`${requested}/`;if(!path.startsWith(root.endsWith('/')?root:`${root}/`))throw new ApiError('INVALID_PAYLOAD','Use a directory within the registered document root',{root});
      let listed;try{listed=await documents.list(path);}catch(error){if(error instanceof ApiError)throw new ApiError(error.code,error.message,{...error.details,root});throw error;}
      const files=listed.result.filter(entry=>entry.path!==path).sort((a,b)=>a.path.localeCompare(b.path)),offset=(selected.page-1)*selected.limit,hasMore=offset+selected.limit<files.length;return {result:{root,path,files:files.slice(offset,offset+selected.limit),page:selected.page,limit:selected.limit,total:files.length,nextPage:hasMore?selected.page+1:null,revision:listed.evidence.sha256},raw:[listed.evidence],sourceType:'document'};}
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
    if(handler==='mirror.products'){const {page,limit}=z.object(pagination).strict().parse(args),listed=await mirror.products();requireCondition(Array.isArray(listed.result),'SOURCE_UNREACHABLE','Mirror product payload is malformed');const items=listed.result.map((item:any)=>({id:item.id,name:item.name})).sort((a:any,b:any)=>Number(a.id)-Number(b.id)),offset=(page-1)*limit;return {result:{items:items.slice(offset,offset+limit),total:items.length,page,limit,nextPage:offset+limit<items.length?page+1:null,revision:listed.evidence.sha256},raw:[listed.evidence],sourceType:'query-mirror'};}
    if(handler==='mirror.detail'){const detail=await mirror.detail(args.ids);return {result:{items:detail.items},raw:[detail.evidence],sourceType:'query-mirror'};}
    const {keyword,page,limit,...filters}=mirrorQuery.parse(args),listed=await mirror.list(filters);requireCondition(Array.isArray(listed.result),'SOURCE_UNREACHABLE','Mirror list payload is malformed');
    const items=listed.result.filter((bug:any)=>!keyword||String(bug.title??'').toLowerCase().includes(keyword.toLowerCase())).sort((a:any,b:any)=>Number(a.id)-Number(b.id)),offset=(page-1)*limit;return {result:{items:items.slice(offset,offset+limit),total:items.length,page,limit,nextPage:offset+limit<items.length?page+1:null,revision:listed.evidence.sha256},raw:[listed.evidence],sourceType:'query-mirror'};
  }
  if(packageId==='environment-view'){const result=await new EnvironmentView(source).call(handler,args);return {result:result.result,raw:[result.evidence],sourceType:'environment-view'};}
  throw new ApiError('INVALID_PAYLOAD','Tool handler is not registered');
}

import {z} from 'zod';
import {ApiError,canonicalHash,requireCondition} from '../../contracts/src/index.ts';
import {commandHeads,commandParam,commandCheck} from '../../methods/src/command-tree.ts';
import {HttpSource,type RawReturn} from './readonly-sdk.ts';
import {Documents} from './documents.ts';
import {BuildSite,type BuildRecord} from './build-site.ts';
import {QueryMirror} from './query-mirror.ts';
import {EnvironmentView} from './environment-view.ts';
import {SourceCache} from './source-cache.ts';

export interface ToolDefinition {suffix:string;title:string;description:string;schema:z.ZodObject<any>;effect:'read'|'write';mode:'sync'|'task';permission:string;handler:string}
export interface ToolPackage {id:string;prefix:string;tools:ToolDefinition[]}
const tool=(suffix:string,title:string,schema:z.ZodObject<any>,permission:string,handler:string,effect:'read'|'write'='read',mode:'sync'|'task'='sync'):ToolDefinition=>({suffix,title,description:title,schema,permission,handler,effect,mode});
const short=z.string().min(1).max(500),build=z.string().min(1).max(200);
export const toolPackages:ToolPackage[]=[
  {id:'build-site',prefix:'buildsite',tools:[
    tool('versions','列出版本线和构建发布记录',z.object({versionLine:short.optional()}).strict(),'builds.read','build.versions'),
    tool('command_tree','取固定构建的命令树投影',z.object({build}).strict(),'builds.read','build.tree'),
    tool('fixed_releases','按需核对相关构建的修复清单；保留查询覆盖范围',z.object({legacyIssueId:z.string().regex(/^\d*$/),builds:z.array(build).min(1).max(20),versionLine:short.optional()}).strict(),'builds.read','build.fixed'),
    tool('command_heads','查命令头；超过 128 条明确失败',z.object({build,prefix:z.string().max(500)}).strict(),'builds.read','build.heads'),
    tool('command_param','最长匹配命令头及参数；最多八词',z.object({build,head:short}).strict(),'builds.read','build.parameters'),
    tool('command_check','按固定 XML 与确定性规则核对命令',z.object({build,commands:z.array(z.string().max(2000)).min(1).max(200)}).strict(),'builds.read','build.check'),
  ]},
  {id:'documents',prefix:'docs',tools:[
    tool('list','列出只读文档目录',z.object({path:short.optional()}).strict(),'docs.fetch','document.list'),
    tool('get','取文档原件与摘要',z.object({file:short}).strict(),'docs.fetch','document.get'),
    tool('search','按文件、行号、片段查询文档',z.object({query:short,version:short.optional()}).strict(),'docs.fetch','document.search'),
    tool('section','取命令小节或行窗口，最多 80 行',z.object({file:short,anchor:short.optional(),line:z.number().int().positive().optional(),window:z.number().int().min(1).max(80).default(40)}).strict().refine(value=>!!value.anchor!==!!value.line,'Provide an anchor or line'),'docs.fetch','document.section'),
  ]},
  {id:'query-mirror',prefix:'zentao',tools:[
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
    tool('claim_submit','提交个人沉淀候选；不自动提升为团队知识',z.object({claim:z.object({subject:short,predicate:short,value:z.unknown(),conditions:z.record(z.string(),z.unknown()).default({})}).strict(),evidence:z.array(z.object({evidenceId:z.string(),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict()).min(1).max(100)}).strict(),'knowledge.submit','candidate.submit','write','task'),
  ]},
];
export interface ConnectorProfile {origin:string;root?:string;index?:string;payloadField?:string;requestConcurrency?:number;requestIntervalMs?:number}
export interface ToolReturn {result:any;raw:RawReturn[];sourceType:string}
export async function executeTool(packageId:string,handler:string,args:any,profile:ConnectorProfile,credential?:string,options:{cache?:SourceCache;cacheNamespace?:string}={}):Promise<ToolReturn>{
  if(handler==='candidate.submit')return {result:args,raw:[],sourceType:'skill-run'};
  const source=new HttpSource(profile.origin,{...(credential?{authorization:()=>credential}:{}),timeoutMs:5000,requestConcurrency:profile.requestConcurrency??2,requestIntervalMs:profile.requestIntervalMs??(packageId==='build-site'?200:0)});
  if(packageId==='build-site'){
    const site=new BuildSite(source,options.cache,options.cacheNamespace??canonicalHash([profile.origin,credential??null])),index=await site.index(profile.index??'/');const raw:RawReturn[]=[{...index.evidence,sourceType:'build-record'}],builds:BuildRecord[]=[];
    for(const line of index.lines){if(args.versionLine&&line.versionLine!==args.versionLine)continue;const page=await site.listing(line.path,{versionLine:line.versionLine});raw.push({...page.evidence,sourceType:'build-record'});builds.push(...page.result);}
    if(handler==='build.versions')return {result:{versionLines:index.lines.map(line=>({versionLine:line.versionLine,title:line.title})),platforms:index.platforms,builds},raw,sourceType:'build-record'};
    if(handler==='build.fixed'){
      const candidates=builds.filter(build=>args.builds.includes(build.name));requireCondition(candidates.length===new Set(args.builds).size,'SOURCE_ABSENT','A selected build is absent from the authorized source');
      const fixed=await site.releasesFor(args.legacyIssueId,candidates);raw.push(...fixed.evidence.map((evidence:RawReturn)=>({...evidence,sourceType:'build-record'})));const {evidence,...result}=fixed;return {result,raw,sourceType:'build-record'};
    }
    const build=builds.find(build=>build.name===args.build);requireCondition(build,'SOURCE_ABSENT','Build is absent from the authorized source');requireCondition(build.files.commands,'SOURCE_ABSENT','Build has no command tree');
    const tree=await site.commandTree(build),xml=tree.evidence;raw.push({...xml,sourceType:'command-tree'});const commands=tree.result;
    const result=handler==='build.heads'?commandHeads(commands,args.prefix):handler==='build.parameters'?commandParam(commands,args.head):handler==='build.check'?commandCheck(commands,args.commands):{commands};
    return {result:{build:build.name,sourceSha256:xml.sha256,...result},raw,sourceType:'command-tree'};
  }
  if(packageId==='documents'){
    const documents=new Documents(source);
    if(handler==='document.list'){const listed=await documents.list(args.path??profile.root??'/');return {result:{files:listed.result},raw:[listed.evidence],sourceType:'document'};}
    if(handler==='document.get'){const file=await documents.get(args.file);return {result:file.result,raw:[file.evidence],sourceType:'document'};}
    if(handler==='document.search'){
      const listed=await documents.list(profile.root??'/'),raw=[listed.evidence],hits:any[]=[];
      for(const file of listed.result){if(file.directory||args.version&&!file.path.includes(args.version))continue;const original=(await documents.get(file.path)).evidence;raw.push(original);
        for(const [index,line] of original.bytes.toString('utf8').split(/\r?\n/).entries())if(line.toLowerCase().includes(args.query.toLowerCase()))hits.push({file:file.path,line:index+1,snippet:line,sourceSha256:original.sha256});
      }if(hits.length>100)throw new ApiError('RESULT_TOO_LARGE','Document search result exceeds the limit',{outcome:'result_too_large',count:hits.length,limit:100});
      return {result:{hits},raw,sourceType:'document'};
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

import {ApiError,canonicalHash,requireCondition} from '../../contracts/src/index.ts';
import {HttpSource,type Incremental,type RawReturn} from './readonly-sdk.ts';
import {html,elements,attribute,textOf,xmlTree,xmlNodes,children,type HtmlNode} from './structure.ts';
import {SourceCache} from './source-cache.ts';
import {z} from 'zod';

export const BuildSiteOptions=z.object({listingPathPattern:z.string().min(1).max(1000).refine(pattern=>{try{new RegExp(pattern,'i');return true;}catch{return false;}},'Listing pattern is malformed').optional(),variantPlatforms:z.record(z.string(),z.string().min(1).max(100)).default({}),maxDepth:z.number().int().min(1).max(5).default(3),maxPages:z.number().int().min(1).max(256).default(128)}).strict();
export type BuildSiteOptions=z.input<typeof BuildSiteOptions>;
export interface IssueReference {system:'bugzilla'|'zentao';id:string}
export const buildIdentity=(name:string,platform:string|null)=>`bld_${canonicalHash([name,platform]).slice(0,24)}`;

export interface BuildRecord {buildId:string;listingPath:string;name:string;versionLine:string;platform:string|null;buildTime:string|null;releasedOn:string|null;formal:boolean;
  imageSize:string|null;imageSha256:string|null;segmentSha256:string;
  commandTreeAvailable:boolean;current:boolean;superseded:BuildRevision[];conflict?:{code:string;revisions:BuildRevision[]};
  files:{image?:string;mib?:string;mibChinese?:string;commands?:string;fixed?:string};fixedIds:string[];fixedIssues?:IssueReference[];commands:CommandRecord[]}
export type BuildRevision=Omit<BuildRecord,'current'|'superseded'|'conflict'>;
export function resolveBuilds(records:BuildRecord[]):BuildRecord[]{
  const groups=new Map<string,BuildRecord[]>();
  for(const record of records){const group=groups.get(record.buildId)??[];group.push(record);groups.set(record.buildId,group);}
  return [...groups.values()].map(group=>{
    const revisions=new Map<string,BuildRevision>();
    for(const record of group){const {current,superseded,conflict,...revision}=record;for(const item of [revision,...superseded,...(conflict?.revisions??[])])revisions.set(item.segmentSha256,item);}
    const time=(record:BuildRevision)=>{const value=record.buildTime?.replace(' ','T');if(!value)return null;const normalized=value.length===10?`${value}T00:00:00`:value,date=new Date(`${normalized}Z`);return Number.isFinite(date.getTime())&&date.toISOString().startsWith(normalized)?normalized:null;};
    const all=[...revisions.values()].sort((a,b)=>(time(b)??'').localeCompare(time(a)??'')||a.segmentSha256.localeCompare(b.segmentSha256)),latest=all[0];
    const conflict=all.length>1&&(all.some(record=>time(record)===null)||time(all[0])===time(all[1]));
    return {...latest,current:!conflict,superseded:conflict?[]:all.slice(1),...(conflict?{conflict:{code:'BUILD_REVISION_CONFLICT',revisions:all}}:{})};
  });
}
export function buildCoverage(builds:BuildRecord[],missing:any[]=[],readPages:string[]=[]){return {complete:missing.length===0&&!builds.some(build=>build.conflict),missing,readPages,conflicts:builds.filter(build=>build.conflict).map(build=>({buildId:build.buildId,name:build.name,platform:build.platform,...build.conflict})),superseded:builds.filter(build=>build.superseded.length).map(build=>({buildId:build.buildId,name:build.name,platform:build.platform,revisions:build.superseded}))};}
export interface CommandRecord {name:string;scope:string|null;menu:string|null;menuPath:string[];arguments:Record<string,string>[];results:Record<string,string>[]}
type BuildLocator=Pick<BuildRecord,'buildId'|'name'|'platform'|'versionLine'|'listingPath'>;
export class BuildSite {
  source:HttpSource;cache:SourceCache;namespace:string;
  constructor(source:HttpSource,cache=new SourceCache(),namespace='anonymous'){this.source=source;this.cache=cache;this.namespace=namespace;}
  async index(path:string){const evidence=await this.source.read(path),links=elements(html(evidence.bytes),'a').map(a=>({title:textOf(a),href:attribute(a,'href')})).filter(a=>a.href);
    const lines:{title:string;path:string;versionLine:string}[]=[],platforms:{platform:string;path:string}[]=[];
    for(const a of links){const entry={title:a.title,path:this.source.path(a.href!,path)},versionLine=a.title.match(/\d+\.\d+(?:\.\d+)?(?=.*builds)/i)?.[0];
      if(versionLine)lines.push({...entry,versionLine});else if(/builds/i.test(a.title))platforms.push({platform:a.title.replace(/\s*builds\s*/i,'').trim(),path:entry.path});}
    return {lines,platforms,evidence};
  }
  async commandsFrom(bytes:Buffer):Promise<CommandRecord[]> {
    const root=xmlTree(bytes),commands:CommandRecord[]=[];
    const label=(node:typeof root)=>node.attributes.name??node.children.find(child=>child.name==='name')?.text.trim()??node.text.trim();
    const visit=(node:typeof root,scope:string|null,menus:string[])=>{
      const nextScope=node.name==='scope'?label(node):scope,nextMenus=node.name==='scope'?[]:node.name==='menu'?[...menus,label(node)].filter(Boolean):menus;
      if(node.name==='item'){
        const name=label(node);
        requireCondition(!!name,'INVALID_PAYLOAD','Command item requires a name');
        commands.push({name:[...nextMenus,name].join(' ').replace(/\s+/g,' ').trim(),scope:nextScope,menu:nextMenus.at(-1)??null,menuPath:nextMenus,arguments:xmlNodes(node,'arg').map(arg=>({...arg.attributes,...Object.fromEntries(arg.children.filter(child=>child.text.trim()).map(child=>[child.name,child.text.trim()])),...(arg.text.trim()?{text:arg.text.trim()}:{})})),results:xmlNodes(node,'result').map(result=>({...result.attributes,...(result.text.trim()?{text:result.text.trim()}:{})}))});
      }for(const child of node.children)visit(child,nextScope,nextMenus);
    };visit(root,null,[]);return commands;
  }
  async listing(path:string,context:{versionLine?:string;platform?:string|null}={}):Promise<{result:BuildRecord[];evidence:RawReturn;coverage:ReturnType<typeof buildCoverage>}> {
    const page=await this.source.read(path),result=this.parseListing(page,context);return {result,evidence:page,coverage:buildCoverage(result)};
  }
  contextFor(path:string,options:BuildSiteOptions={},fallback:{versionLine?:string;platform?:string|null}={}){
    const policy=BuildSiteOptions.parse(options),match=policy.listingPathPattern?new RegExp(policy.listingPathPattern,'i').exec(path):null,variant=match?.groups?.variant?.replace(/^[_-]/,'');
    return {versionLine:match?.groups?.versionLine?.replace(/_/g,'.')??fallback.versionLine,platform:variant?(Object.entries(policy.variantPlatforms).find(([key])=>key.toLowerCase()===variant.toLowerCase())?.[1]??variant.toLowerCase()):fallback.platform};
  }
  locatorIdentity(policy:BuildSiteOptions={}){return {kind:'build-locators/1',namespace:this.namespace,origin:this.source.identity(),policy:BuildSiteOptions.parse(policy)};}
  async remember(builds:BuildRecord[],pages:string[],policy:BuildSiteOptions={}):Promise<void>{
    await this.cache.updateMetadata(this.locatorIdentity(policy),index=>({schemaVersion:'build-locators/1',locations:[...(index?.locations??[]).filter((location:BuildLocator)=>!pages.includes(location.listingPath)),...builds.map(({buildId,name,platform,versionLine,listingPath})=>({buildId,name,platform,versionLine,listingPath}))]}));
  }
  async locations(references:string[],platform:string|null|undefined,policy:BuildSiteOptions={}):Promise<BuildLocator[]>{
    const index=await this.cache.getMetadata(this.locatorIdentity(policy));if(!index)return [];
    requireCondition(index.schemaVersion==='build-locators/1'&&Array.isArray(index.locations),'SOURCE_HASH_MISMATCH','Source locator index is malformed');
    return index.locations.filter((location:BuildLocator)=>references.some(reference=>reference===location.buildId||reference===location.name)&&(platform===undefined||platform===null?platform===undefined||location.platform===null:location.platform?.toLowerCase()===platform.toLowerCase()));
  }
  parseListing(page:RawReturn,context:{versionLine?:string;platform?:string|null}={}):BuildRecord[]{
    const path=page.path;
    const fileVersion=path.split('/').at(-1)?.match(/(?:^|[_-])(\d{1,2})[_-](\d{1,2})(?:[_-](\d{1,2}))?(?:[_-]|\.html?$)/);
    const versionLine=context.versionLine??(fileVersion?fileVersion.slice(1).filter(Boolean).join('.'):'unknown');
    const root=html(page.bytes);
    const result:BuildRecord[]=[];
    const blocks:{header:string;node:HtmlNode}[]=[];let pending='';
    const visit=(node:HtmlNode)=>{
      if('tagName' in node&&node.tagName==='blockquote'){
        const start=[...pending.matchAll(/\b(?:Rel|Beta)_[A-Za-z0-9_-]+\s*\(\s*build on/gi)].at(-1)?.index;
        if(start!==undefined)blocks.push({header:pending.slice(start).replace(/\s+/g,' ').trim(),node});pending='';return;
      }
      if('nodeName' in node&&node.nodeName==='#text'&&'value' in node)pending+=` ${node.value}`;
      for(const child of children(node))visit(child);
    };visit(root);
    for(const block of blocks){
      const text=block.header,name=text.match(/\b(?:Rel|Beta)_[A-Za-z0-9_-]+\b/)?.[0];if(!name)continue;
      const links=elements(block.node,'a').map(a=>({href:attribute(a,'href'),text:textOf(a)}));
      // Page segment identity is checked before downloading XML and fixed lists.
      const segmentSha256=canonicalHash({header:text,body:textOf(block.node),links});
      const platform=context.platform??null,buildId=buildIdentity(name,platform);
      const files:BuildRecord['files']={};
      for(const {href} of links){if(!href)continue;const reference=this.source.path(href,path);
        if(/\.(array|click)(?:\?|$)/i.test(href))files.image=reference;
        else if(/CA-SNMP-MIB_cn-.*\.txt(?:\?|$)/i.test(href))files.mibChinese=reference;
        else if(/CA-SNMP-MIB-.*\.txt(?:\?|$)/i.test(href))files.mib=reference;
        else if(/command_tree-.*\.xml(?:\?|$)/i.test(href))files.commands=reference;else if(/Bugs_Fixed_with_.*\.html(?:\?|$)/i.test(href))files.fixed=reference;
      }
      const releasedOn=text.match(/Released on\s+(\d{4}-\d{2}-\d{2})/i)?.[1]??null,buildTime=text.match(/build on\s+(\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}:\d{2})?)/i)?.[1]??null;
      const body=textOf(block.node),imageSha256=body.match(/SHA(?:256)?\s*:\s*([a-f0-9]{64})\b/i)?.[1]?.toLowerCase()??null,imageSize=body.match(/\(\s*([\d.]+\s*[KMGT](?:i?B)?)\s*,\s*SHA/i)?.[1]??null;
      const record:BuildRecord={buildId,listingPath:path,name,versionLine,platform,buildTime,releasedOn,formal:name.startsWith('Rel_')&&!!releasedOn,imageSha256,imageSize,segmentSha256,files,commandTreeAvailable:!!files.commands,current:true,superseded:[],fixedIds:[],commands:[]};
      result.push(record);
    }return resolveBuilds(result);
  }
  async catalog(path:string,options:{versionLine?:string;buildSite?:BuildSiteOptions;availablePaths?:Set<string>}={}){
    const policy=BuildSiteOptions.parse(options.buildSite??{}),pattern=policy.listingPathPattern?new RegExp(policy.listingPathPattern,'i'):null,index=await this.index(path),pages=[index.evidence],builds:BuildRecord[]=[],visited=new Set<string>(),missing:any[]=[];
    const walk=async(path:string,context:{versionLine:string;platform?:string|null},depth:number):Promise<void>=>{
      if(visited.has(path)||options.availablePaths&&!options.availablePaths.has(path))return;
      visited.add(path);
      try{
      requireCondition(depth<=policy.maxDepth&&visited.size<=policy.maxPages,'RESULT_TOO_LARGE','Publication traversal exceeds the configured page limit');
      const page=await this.source.read(path);pages.push(page);const entries=this.parseListing(page,this.contextFor(path,policy,context));
      if(entries.length){builds.push(...entries);return;}
      for(const link of elements(html(page.bytes),'a')){
        const href=attribute(link,'href');if(!href)continue;const candidate=new URL(href,'https://synthetic.invalid'+path).pathname;
        const match=pattern?.exec(candidate);if(pattern&&!match||!pattern&&!/\.html?$/i.test(candidate))continue;
        const child=this.source.path(href,path),childContext=this.contextFor(child,policy,context);
        await walk(child,{versionLine:childContext.versionLine??context.versionLine,platform:childContext.platform},depth+1);
      }
      }catch(error){if(!(error instanceof ApiError))throw error;missing.push({path,versionLine:context.versionLine,platform:context.platform??null,code:error.code});}
    };
    for(const line of index.lines)if(!options.versionLine||line.versionLine===options.versionLine)await walk(line.path,{versionLine:line.versionLine},1);
    const resolved=resolveBuilds(builds);return {index,builds:resolved,pages,coverage:buildCoverage(resolved,missing,pages.map(page=>page.path))};
  }
  async sync(path:string,previous:Record<string,string>={},context:{versionLine?:string;platform?:string}={}):Promise<Incremental<BuildRecord>> {
    const listing=await this.listing(path,context),items:BuildRecord[]=[],cursor:Record<string,string>={},evidence=[listing.evidence];
    for(const record of listing.result){const {name,segmentSha256}=record,key=record.platform===null?name:record.buildId;cursor[key]=segmentSha256;if(previous[key]===segmentSha256)continue;
      items.push(record);
    }return {items,cursor,evidence};
  }
  async commandTree(build:BuildRecord):Promise<{result:CommandRecord[];evidence:RawReturn;parserVersion:string}>{
    if(build.conflict)throw new ApiError('INVALID_PAYLOAD','Build has unresolved page revisions',{reason:'build_revision_conflict',buildId:build.buildId});
    requireCondition(build.files.commands,'SOURCE_ABSENT','Build has no command tree');const evidence=await this.cache.load({namespace:this.namespace,origin:this.source.identity(),path:build.files.commands,revision:build.segmentSha256},async()=>{const raw=await this.source.read(build.files.commands!);requireCondition((await this.commandsFrom(raw.bytes)).length>0,'INVALID_PAYLOAD','Command tree has no recognized command items');return raw;});
    return {result:await this.commandsFrom(evidence.bytes),evidence,parserVersion:'menu-path/2'};
  }
  async fixed(build:BuildRecord):Promise<{result:string[];issues:IssueReference[];evidence:RawReturn}>{
    if(build.conflict)throw new ApiError('INVALID_PAYLOAD','Build has unresolved page revisions',{reason:'build_revision_conflict',buildId:build.buildId});
    requireCondition(build.files.fixed,'SOURCE_ABSENT','Build has no fixed list');const evidence=await this.cache.load({namespace:this.namespace,origin:this.source.identity(),path:build.files.fixed,revision:build.segmentSha256},()=>this.source.read(build.files.fixed!));
    const issues:IssueReference[]=[],seen=new Set<string>();
    for(const a of elements(html(evidence.bytes),'a')){const href=attribute(a,'href');if(!href)continue;let link:URL;try{link=new URL(href,'https://synthetic.invalid');}catch{continue;}const id=link.searchParams.get('id');if(!id||!/^\d+$/.test(id))continue;
      const system=/\/show_bug\.cgi$/i.test(link.pathname)?'bugzilla':/\/index\.php$/i.test(link.pathname)&&link.searchParams.get('m')==='bug'&&link.searchParams.get('f')==='view'?'zentao':null;
      if(system&&!seen.has(`${system}:${id}`)){issues.push({system,id});seen.add(`${system}:${id}`);}
    }return {result:issues.filter(issue=>issue.system==='bugzilla').map(issue=>issue.id),issues,evidence};
  }
  async releasesFor(externalId:string|IssueReference,candidates:BuildRecord[]):Promise<any>{
    const issue=typeof externalId==='string'?{system:'bugzilla' as const,id:externalId}:externalId;
    requireCondition(['bugzilla','zentao'].includes(issue.system)&&/^\d*$/.test(issue.id),'INVALID_PAYLOAD','Repair identifier is malformed');
    if(!issue.id)return {issue,status:'unknown',earliestFormal:null,all:[],evidence:[],coverage:{builds:[],read:[],missing:[],completeSite:false,earliestFormalCertain:false}};
    const settled=await Promise.allSettled(candidates.map(async build=>{const fixed=await this.fixed(build);return {build:{...build,fixedIds:fixed.result,fixedIssues:fixed.issues},evidence:fixed.evidence};}));
    const hydrated:{build:BuildRecord;evidence:RawReturn}[]=[],missing:{build:string;code:string}[]=[];
    for(const [index,result] of settled.entries())if(result.status==='fulfilled')hydrated.push(result.value);else missing.push({build:candidates[index].name,...(candidates[index].platform!==null?{buildId:candidates[index].buildId,platform:candidates[index].platform}:{}),code:result.reason instanceof ApiError?result.reason.code:'SOURCE_UNREACHABLE'});
    const matches=this.matches(hydrated.map(item=>item.build),issue),earliest=matches.earliestFormal;
    const unread=new Set(settled.flatMap((item,index)=>item.status==='rejected'?[candidates[index].buildId]:[])),earliestFormalCertain=!!earliest&&!candidates.some(build=>unread.has(build.buildId)&&build.formal&&build.releasedOn!<=earliest.releasedOn);
    const reference=(build:BuildRecord)=>({buildId:build.buildId,name:build.name,platform:build.platform});
    return {...matches,evidence:hydrated.map(item=>item.evidence),coverage:{builds:candidates.map(build=>build.name),buildRefs:candidates.map(reference),read:hydrated.map(item=>item.build.name),readRefs:hydrated.map(item=>reference(item.build)),missing,completeSite:false,earliestFormalCertain}};
  }
  matches(builds:BuildRecord[],externalId:string|IssueReference):any {
    const issue=typeof externalId==='string'?{system:'bugzilla' as const,id:externalId}:externalId;
    if(!issue.id)return {issue,status:'unknown',earliestFormal:null,all:[]};
    const all=builds.filter(b=>b.fixedIssues?.some(item=>item.system===issue.system&&item.id===issue.id)??(issue.system==='bugzilla'&&b.fixedIds.includes(issue.id))).sort((a,b)=>(a.releasedOn??'').localeCompare(b.releasedOn??'')||a.name.localeCompare(b.name)||(a.platform??'').localeCompare(b.platform??'')),formal=all.filter(b=>b.formal);
    return {issue,status:formal.length?'published':all.some(build=>build.name.startsWith('Beta_'))?'beta-only':'unknown',earliestFormal:formal[0]??null,all};
  }
  forCommand(builds:BuildRecord[],command:string):any {
    const all=builds.filter(b=>!b.conflict&&b.formal&&b.commands.some(c=>c.name===command)).sort((a,b)=>b.releasedOn!.localeCompare(a.releasedOn!)||b.name.localeCompare(a.name));
    return {latestFormal:all[0]??null,all,proves:'command-presence',unknowns:['Feature semantics require product evidence']};
  }
}

import {ApiError,canonicalHash,requireCondition} from '../../contracts/src/index.ts';
import {HttpSource,type Incremental,type RawReturn} from './readonly-sdk.ts';
import {html,elements,attribute,textOf,xmlTree,xmlNodes,children,type HtmlNode} from './structure.ts';
import {SourceCache} from './source-cache.ts';

export interface BuildRecord {name:string;versionLine:string;platform:string|null;buildTime:string|null;releasedOn:string|null;formal:boolean;
  imageSize:string|null;imageSha256:string|null;segmentSha256:string;
  files:{image?:string;mib?:string;mibChinese?:string;commands?:string;fixed?:string};fixedIds:string[];commands:CommandRecord[]}
export interface CommandRecord {name:string;scope:string|null;menu:string|null;arguments:Record<string,string>[];results:Record<string,string>[]}
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
    const visit=(node:typeof root,scope:string|null,menu:string|null)=>{
      const nextScope=node.name==='scope'?node.attributes.name??node.text.trim():scope,nextMenu=node.name==='menu'?node.attributes.name??node.text.trim():menu;
      if(node.name==='item'){
        const name=node.attributes.name??node.children.find(n=>n.name==='name')?.text;
        requireCondition(!!name,'INVALID_PAYLOAD','Command item requires a name');
        commands.push({name,scope:nextScope,menu:nextMenu,arguments:xmlNodes(node,'arg').map(arg=>({...arg.attributes,...Object.fromEntries(arg.children.filter(child=>child.text.trim()).map(child=>[child.name,child.text.trim()])),...(arg.text.trim()?{text:arg.text.trim()}:{})})),results:xmlNodes(node,'result').map(result=>({...result.attributes,...(result.text.trim()?{text:result.text.trim()}:{})}))});
      }for(const child of node.children)visit(child,nextScope,nextMenu);
    };visit(root,null,null);return commands;
  }
  async listing(path:string,context:{versionLine?:string;platform?:string}={}):Promise<{result:BuildRecord[];evidence:RawReturn}> {
    const fileVersion=path.split('/').at(-1)?.match(/(?:^|[_-])(\d{1,2})[_-](\d{1,2})(?:[_-](\d{1,2}))?(?:[_-]|\.html?$)/);
    const versionLine=context.versionLine??(fileVersion?fileVersion.slice(1).filter(Boolean).join('.'):'unknown');
    const page=await this.source.read(path),root=html(page.bytes);
    const result:BuildRecord[]=[],identities=new Map<string,string>();
    const blocks:{header:string;node:HtmlNode}[]=[];let header:string|null=null;
    const visit=(node:HtmlNode)=>{
      if('tagName' in node&&node.tagName==='font'&&/\b(?:Rel|Beta)_[A-Za-z0-9_]+\s*\(\s*build on/i.test(textOf(node)))header=textOf(node);
      if('tagName' in node&&node.tagName==='blockquote'&&header){blocks.push({header,node});header=null;return;}
      for(const child of children(node))visit(child);
    };visit(root);
    for(const block of blocks){
      const text=block.header,name=text.match(/\b(?:Rel|Beta)_[A-Za-z0-9_]+\b/)?.[0];if(!name)continue;
      const links=elements(block.node,'a').map(a=>({href:attribute(a,'href'),text:textOf(a)}));
      // Page segment identity is checked before downloading XML and fixed lists.
      const segmentSha256=canonicalHash({header:text,body:textOf(block.node),links});
      requireCondition(!identities.has(name)||identities.get(name)===segmentSha256,'INVALID_PAYLOAD','Build identity appears in conflicting page segments');if(identities.has(name))continue;identities.set(name,segmentSha256);
      const files:BuildRecord['files']={};
      for(const {href} of links){if(!href)continue;const reference=this.source.path(href,path);
        if(/\.array(?:\?|$)/i.test(href))files.image=reference;
        else if(/CA-SNMP-MIB_cn-.*\.txt(?:\?|$)/i.test(href))files.mibChinese=reference;
        else if(/CA-SNMP-MIB-.*\.txt(?:\?|$)/i.test(href))files.mib=reference;
        else if(/command_tree-.*\.xml(?:\?|$)/i.test(href))files.commands=reference;else if(/Bugs_Fixed_with_.*\.html(?:\?|$)/i.test(href))files.fixed=reference;
      }
      const releasedOn=text.match(/Released on\s+(\d{4}-\d{2}-\d{2})/i)?.[1]??null,buildTime=text.match(/build on\s+(\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}:\d{2})?)/i)?.[1]??null;
      const body=textOf(block.node),imageSha256=body.match(/SHA(?:256)?\s*:\s*([a-f0-9]{64})\b/i)?.[1]?.toLowerCase()??null,imageSize=body.match(/\(\s*([\d.]+\s*[KMGT](?:i?B)?)\s*,\s*SHA/i)?.[1]??null;
      const record:BuildRecord={name,versionLine,platform:context.platform??null,buildTime,releasedOn,formal:name.startsWith('Rel_')&&!!releasedOn,imageSha256,imageSize,segmentSha256,files,fixedIds:[],commands:[]};
      result.push(record);
    }return {result,evidence:page};
  }
  async sync(path:string,previous:Record<string,string>={},context:{versionLine?:string;platform?:string}={}):Promise<Incremental<BuildRecord>> {
    const listing=await this.listing(path,context),items:BuildRecord[]=[],cursor:Record<string,string>={},evidence=[listing.evidence];
    for(const record of listing.result){const {name,segmentSha256}=record;cursor[name]=segmentSha256;if(previous[name]===segmentSha256)continue;
      items.push(record);
    }return {items,cursor,evidence};
  }
  async commandTree(build:BuildRecord):Promise<{result:CommandRecord[];evidence:RawReturn}>{
    requireCondition(build.files.commands,'SOURCE_ABSENT','Build has no command tree');const evidence=await this.cache.load({namespace:this.namespace,origin:this.source.identity(),path:build.files.commands,revision:build.segmentSha256},async()=>{const raw=await this.source.read(build.files.commands!);requireCondition((await this.commandsFrom(raw.bytes)).length>0,'INVALID_PAYLOAD','Command tree has no recognized command items');return raw;});
    return {result:await this.commandsFrom(evidence.bytes),evidence};
  }
  async fixed(build:BuildRecord):Promise<{result:string[];evidence:RawReturn}>{
    requireCondition(build.files.fixed,'SOURCE_ABSENT','Build has no fixed list');const evidence=await this.cache.load({namespace:this.namespace,origin:this.source.identity(),path:build.files.fixed,revision:build.segmentSha256},()=>this.source.read(build.files.fixed!));
    const result=[...new Set(elements(html(evidence.bytes),'a').flatMap(a=>{const href=attribute(a,'href');if(!href)return [];const link=new URL(href,'https://synthetic.invalid'),id=link.searchParams.get('id');return /\/show_bug\.cgi$/.test(link.pathname)&&id&&/^\d+$/.test(id)?[id]:[];}))];return {result,evidence};
  }
  async releasesFor(externalId:string,candidates:BuildRecord[]):Promise<any>{
    if(!externalId)return {status:'unknown',earliestFormal:null,all:[],evidence:[],coverage:{builds:[],read:[],missing:[],completeSite:false}};
    const settled=await Promise.allSettled(candidates.map(async build=>{const fixed=await this.fixed(build);return {build:{...build,fixedIds:fixed.result},evidence:fixed.evidence};}));
    const hydrated:{build:BuildRecord;evidence:RawReturn}[]=[],missing:{build:string;code:string}[]=[];
    for(const [index,result] of settled.entries())if(result.status==='fulfilled')hydrated.push(result.value);else missing.push({build:candidates[index].name,code:result.reason instanceof ApiError?result.reason.code:'SOURCE_UNREACHABLE'});
    return {...this.matches(hydrated.map(item=>item.build),externalId),evidence:hydrated.map(item=>item.evidence),coverage:{builds:candidates.map(build=>build.name),read:hydrated.map(item=>item.build.name),missing,completeSite:false}};
  }
  matches(builds:BuildRecord[],externalId:string):any {
    if(!externalId)return {status:'unknown',earliestFormal:null,all:[]};
    const all=builds.filter(b=>b.fixedIds.includes(externalId)).sort((a,b)=>(a.releasedOn??'').localeCompare(b.releasedOn??'')||a.name.localeCompare(b.name)),formal=all.filter(b=>b.formal);
    return {status:formal.length?'published':all.length?'beta-only':'unknown',earliestFormal:formal[0]??null,all};
  }
  forCommand(builds:BuildRecord[],command:string):any {
    const all=builds.filter(b=>b.formal&&b.commands.some(c=>c.name===command)).sort((a,b)=>b.releasedOn!.localeCompare(a.releasedOn!)||b.name.localeCompare(a.name));
    return {latestFormal:all[0]??null,all,proves:'command-presence',unknowns:['Feature semantics require product evidence']};
  }
}

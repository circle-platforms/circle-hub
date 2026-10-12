import {canonicalHash,requireCondition} from '../../contracts/src/index.ts';
import {HttpSource,type Incremental,type RawReturn} from './readonly-sdk.ts';
import {html,elements,attribute,textOf,xmlTree,xmlNodes} from './structure.ts';

export interface BuildRecord {name:string;versionLine:string;platform:string|null;buildTime:string|null;releasedOn:string|null;formal:boolean;
  files:{image?:string;mib?:string;commands?:string;fixed?:string};fixedIds:string[];commands:CommandRecord[]}
export interface CommandRecord {name:string;scope:string|null;menu:string|null;arguments:Record<string,string>[];results:Record<string,string>[]}
export class BuildSite {
  source:HttpSource;constructor(source:HttpSource){this.source=source;}
  async index(path:string){const evidence=await this.source.read(path),links=elements(html(evidence.bytes),'a').map(a=>({title:textOf(a),href:attribute(a,'href')})).filter(a=>a.href);
    const lines:{title:string;path:string}[]=[],platforms:{platform:string;path:string}[]=[];
    for(const a of links){const entry={title:a.title,path:this.source.path(a.href!,path)};if(/\d+\.\d+.*builds/i.test(a.title))lines.push(entry);else if(/builds/i.test(a.title))platforms.push({platform:a.title.replace(/\s*builds\s*/i,'').trim(),path:entry.path});}
    return {lines,platforms,evidence};
  }
  async commandsFrom(bytes:Buffer):Promise<CommandRecord[]> {
    const root=xmlTree(bytes),commands:CommandRecord[]=[];
    const visit=(node:typeof root,scope:string|null,menu:string|null)=>{
      const nextScope=node.name==='scope'?node.attributes.name??node.text.trim():scope,nextMenu=node.name==='menu'?node.attributes.name??node.text.trim():menu;
      if(node.name==='item'){
        const name=node.attributes.name??node.children.find(n=>n.name==='name')?.text;
        requireCondition(!!name,'INVALID_PAYLOAD','Command item requires a name');
        commands.push({name,scope:nextScope,menu:nextMenu,arguments:xmlNodes(node,'arg').map(arg=>({...arg.attributes,...(arg.text.trim()?{text:arg.text.trim()}:{})})),results:xmlNodes(node,'result').map(result=>({...result.attributes,...(result.text.trim()?{text:result.text.trim()}:{})}))});
      }for(const child of node.children)visit(child,nextScope,nextMenu);
    };visit(root,null,null);return commands;
  }
  async sync(path:string,previous:Record<string,string>={},platform:string|null=null):Promise<Incremental<BuildRecord>> {
    const page=await this.source.read(path),root=html(page.bytes),versionLine=textOf(elements(root,'h1')[0]??root).match(/\d+\.\d+(?:\.\d+)?/)?.[0]??'unknown';
    const items:BuildRecord[]=[],cursor:Record<string,string>={},evidence=[page];
    for(const row of elements(root,'tr')){
      const text=textOf(row),name=text.match(/\b(?:Rel|Beta)_[A-Za-z0-9_]+\b/)?.[0];if(!name)continue;
      const files:BuildRecord['files']={};
      for(const a of elements(row,'a')){const href=attribute(a,'href');if(!href)continue;const reference=this.source.path(href,path);
        if(/\.array(?:\?|$)/i.test(href))files.image=reference;else if(/\.mib(?:\?|$)/i.test(href))files.mib=reference;
        else if(/command_tree-.*\.xml(?:\?|$)/i.test(href))files.commands=reference;else if(/Bugs_Fixed_with_.*\.html(?:\?|$)/i.test(href))files.fixed=reference;
      }
      const releasedOn=text.match(/Released on\s+(\d{4}-\d{2}-\d{2})/i)?.[1]??null,buildTime=text.match(/Built on\s+(\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}:\d{2})?)/i)?.[1]??null;
      const record:BuildRecord={name,versionLine,platform,buildTime,releasedOn,formal:name.startsWith('Rel_')&&!!releasedOn,files,fixedIds:[],commands:[]};
      if(files.commands){const xml=await this.source.read(files.commands);record.commands=await this.commandsFrom(xml.bytes);evidence.push(xml);}
      if(files.fixed){const fixed=await this.source.read(files.fixed);evidence.push(fixed);
        record.fixedIds=[...new Set(elements(html(fixed.bytes),'a').flatMap(a=>{const href=attribute(a,'href');if(!href)return [];const link=new URL(href,'https://synthetic.invalid');const id=link.searchParams.get('id');return /\/show_bug\.cgi$/.test(link.pathname)&&id&&/^\d+$/.test(id)?[id]:[];}))];
      }
      cursor[name]=canonicalHash(record);if(previous[name]!==cursor[name])items.push(record);
    }return {items,cursor,evidence};
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

import {HttpSource,type Incremental,type RawReturn} from './readonly-sdk.ts';
import {xmlTree,xmlNodes} from './structure.ts';
import {ApiError,requireCondition} from '../../contracts/src/index.ts';
import {SourceCache} from './source-cache.ts';
import {z} from 'zod';

const directoryTemplate=z.string().min(1).max(500).refine(value=>value.includes('{version}')&&!value.startsWith('/')&&!value.includes('\\')&&!value.includes(':')&&!value.includes('?')&&value.split('/').every(part=>part!=='.'&&part!=='..'),'Version directory template must be relative');
export const DocumentOptions=z.object({versionDirectoryTemplate:directoryTemplate.optional(),versionSeparator:z.enum(['.','_','-']).default('_'),maxDepth:z.number().int().min(0).max(10).default(3),maxFiles:z.number().int().min(1).max(500).default(100),maxDirectories:z.number().int().min(1).max(256).default(64),maxBytes:z.number().int().min(1).max(8*1024*1024).default(4*1024*1024)}).strict();
export type DocumentOptions=z.input<typeof DocumentOptions>;

export interface DocumentEntry {path:string;etag:string|null;modifiedAt:string|null;size:number;directory:boolean}
export class Documents {
  source:HttpSource;
  constructor(source:HttpSource){this.source=source;}
  async list(path:string):Promise<{result:DocumentEntry[];evidence:RawReturn}> {
    const evidence=await this.source.read(path,{method:'PROPFIND',headers:{depth:'1'}}),root=xmlTree(evidence.bytes);
    const result=xmlNodes(root,'response').flatMap(response=>{
      const href=xmlNodes(response,'href')[0]?.text;
      if(!href)return [];
      // A failed propstat is not a directory entry or proof of absence.
      const successful=xmlNodes(response,'propstat').find(p=>/\s200\s/.test(xmlNodes(p,'status')[0]?.text??''));if(!successful)return [];
      const get=(name:string)=>xmlNodes(successful,name)[0]?.text??null;
      return [{path:this.source.path(href,path),etag:get('getetag'),modifiedAt:get('getlastmodified'),size:Number(get('getcontentlength')??0),directory:xmlNodes(successful,'collection').length>0}];
    });return {result,evidence};
  }
  async get(path:string):Promise<{result:{path:string;contentBase64:string};evidence:RawReturn}>{const evidence=await this.source.read(path);return {result:{path:evidence.path,contentBase64:evidence.bytes.toString('base64')},evidence};}
  async search(args:{query:string;path?:string;version?:string},root:string,options:DocumentOptions={},cache=new SourceCache(),namespace='anonymous'){
    const policy=DocumentOptions.parse(options),base=this.source.path(root),rootPath=base.endsWith('/')?base:`${base}/`;let selected=args.path??rootPath;
    if(!args.path&&args.version&&policy.versionDirectoryTemplate){requireCondition(/^\d+(?:\.\d+){1,2}$/.test(args.version),'INVALID_PAYLOAD','Version line is malformed');selected=this.source.path(policy.versionDirectoryTemplate.replace('{version}',args.version.split('.').join(policy.versionSeparator)),rootPath);}
    selected=this.source.path(selected);if(!selected.endsWith('/'))selected+='/';
    requireCondition(selected.startsWith(rootPath),'INVALID_PAYLOAD','Search directory must stay within the registered document root');
    const raw:RawReturn[]=[],files:DocumentEntry[]=[],visited=new Set<string>(),seenFiles=new Set<string>(),skipped:{file:string;code:string}[]=[],hits:any[]=[];let bytes=0;
    const exceeded=(bound:string,limit:number,count:number)=>{throw new ApiError('RESULT_TOO_LARGE','Document search exceeds its configured bound',{outcome:'result_too_large',bound,limit,count});};
    const retain=(returnValue:RawReturn)=>{bytes+=returnValue.bytes.length;if(bytes>policy.maxBytes)exceeded('bytes',policy.maxBytes,bytes);raw.push(returnValue);};
    const walk=async(path:string,depth:number):Promise<void>=>{
      if(visited.has(path))return;if(depth>policy.maxDepth)exceeded('depth',policy.maxDepth,depth);if(visited.size>=policy.maxDirectories)exceeded('directories',policy.maxDirectories,visited.size+1);visited.add(path);
      const listed=await this.list(path);retain(listed.evidence);
      const directories:string[]=[];
      for(const entry of listed.result){if(entry.path===path)continue;requireCondition(entry.path.startsWith(selected),'INVALID_PAYLOAD','Directory entry escapes the selected search root');
        if(entry.directory){directories.push(entry.path.endsWith('/')?entry.path:`${entry.path}/`);continue;}if(seenFiles.has(entry.path))continue;seenFiles.add(entry.path);if(seenFiles.size>policy.maxFiles)exceeded('files',policy.maxFiles,seenFiles.size);
        requireCondition(Number.isSafeInteger(entry.size)&&entry.size>=0,'INVALID_PAYLOAD','Source size is malformed');
        if(!/\.(txt|md|html?)$/i.test(entry.path)){skipped.push({file:entry.path,code:'UNSUPPORTED_TEXT_FORMAT'});continue;}
        if(args.version&&!policy.versionDirectoryTemplate&&!entry.path.includes(args.version))continue;files.push(entry);
      }
      for(const directory of directories)await walk(directory,depth+1);
    };
    await walk(selected,0);
    for(const file of files){const revision=file.etag??(file.modifiedAt?`${file.modifiedAt}/${file.size}`:null),original=revision?await cache.load({namespace,origin:this.source.identity(),path:file.path,revision},async()=>{const fetched=(await this.get(file.path)).evidence;requireCondition(!file.etag||!fetched.etag||file.etag===fetched.etag,'SOURCE_UNREACHABLE','Document revision changed during search');return fetched;}):(await this.get(file.path)).evidence;retain(original);
      const text=original.bytes.toString('utf8');if(!Buffer.from(text).equals(original.bytes)){skipped.push({file:file.path,code:'UNSUPPORTED_TEXT_ENCODING'});continue;}
      for(const [index,line] of text.split(/\r?\n/).entries())if(line.toLowerCase().includes(args.query.toLowerCase())){hits.push({file:file.path,line:index+1,snippet:line,sourceSha256:original.sha256});if(hits.length>100)exceeded('hits',100,hits.length);}
    }
    return {result:{hits,coverage:{path:selected,complete:skipped.length===0,files:files.length,directories:visited.size,bytes,skipped},limits:{maxDepth:policy.maxDepth,maxFiles:policy.maxFiles,maxDirectories:policy.maxDirectories,maxBytes:policy.maxBytes}},raw};
  }
  async sync(path:string,previous:Record<string,string>={}):Promise<Incremental<{entry:DocumentEntry;evidence:RawReturn}>> {
    const listed=await this.list(path),cursor:Record<string,string>={},items:{entry:DocumentEntry;evidence:RawReturn}[]=[],evidence=[listed.evidence];
    for(const entry of listed.result){if(entry.directory)continue;requireCondition(Number.isSafeInteger(entry.size)&&entry.size>=0,'INVALID_PAYLOAD','Source size is malformed');
      const revision=entry.etag??(entry.modifiedAt?`${entry.modifiedAt}/${entry.size}`:null);
      if(revision&&previous[entry.path]===revision){cursor[entry.path]=revision;continue;}
      const raw=(await this.get(entry.path)).evidence;cursor[entry.path]=revision??raw.sha256;
      if(previous[entry.path]!==cursor[entry.path])items.push({entry,evidence:raw});evidence.push(raw);
    }return {items,cursor,evidence};
  }
}

import {HttpSource,type Incremental,type RawReturn} from './readonly-sdk.ts';
import {xmlTree,xmlNodes} from './structure.ts';
import {requireCondition} from '../../contracts/src/index.ts';

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

import {ApiError,canonicalHash,requireCondition} from '../../contracts/src/index.ts';
import {HttpSource,type Incremental,type RawReturn} from './readonly-sdk.ts';

const severity:Record<string,string>={'1':'致命','2':'严重','3':'一般','4':'轻微','5':'建议'};
const priority:Record<string,string>={'1':'立即','2':'高','3':'正常','4':'低'};
export function mirrorDate(value:unknown):string|null {
  if(value===null||value===undefined||value===''||String(value).startsWith('0000-00-00'))return null;
  const text=String(value).replace(' ','T'),explicit=/[zZ]$|[+-]\d{2}:?\d{2}$/.test(text),instant=new Date(explicit?text:`${text}+08:00`);
  return Number.isNaN(instant.getTime())?null:instant.toISOString();
}
export function mirrorBug(raw:Record<string,any>):any {
  const unmapped:{field:string;value:unknown}[]=[],vocab=(field:string,table:Record<string,string>)=>{const code=String(raw[field]??''),label=table[code]??null;if(!label)unmapped.push({field,value:raw[field]});return {code,label};};
  const date=(field:string)=>{const result=mirrorDate(raw[field]);if(result===null&&raw[field]&&!String(raw[field]).startsWith('0000-00-00'))unmapped.push({field,value:raw[field]});return result;};
  const state=String(raw.status??'');if(!['active','resolved','closed'].includes(state))unmapped.push({field:'status',value:raw.status});
  const resolution=String(raw.resolution??''),mapped=resolution==='fixed'?'fixed':null;if(resolution&&!mapped)unmapped.push({field:'resolution',value:resolution});
  const assigned=String(raw.assignedTo??''),sentinel=['active','resolved','closed'].includes(assigned);
  return {id:String(raw.id),title:String(raw.title??''),product:String(raw.product??''),severity:vocab('severity',severity),priority:vocab('pri',priority),state,
    resolution:{raw:resolution,mapped},openedDate:date('openedDate'),resolvedDate:date('resolvedDate'),closedDate:date('closedDate'),lastEditedDate:date('lastEditedDate'),
    assignedPerson:assigned&&!sentinel?assigned:null,assignedState:sentinel?assigned:null,openedBuild:String(raw.openedBuild??''),resolvedBuild:String(raw.resolvedBuild??''),
    legacyIssueId:String(raw.bugzillaID??''),actions:Array.isArray(raw.actions)?raw.actions.map((a:any)=>({...a,id:String(a.id),date:mirrorDate(a.date)})):[],unmapped};
}
export class QueryMirror {
  source:HttpSource;payloadField:string;constructor(source:HttpSource,payloadField='data'){this.source=source;this.payloadField=payloadField;}
  async request(path:string,body?:unknown):Promise<{result:any;evidence:RawReturn}>{
    const response=await this.source.json(path,{...(body===undefined?{}:{method:'POST',json:body})}),envelope=response.result;
    if(Number(envelope?.code)===401)throw new ApiError('SOURCE_LOGIN_EXPIRED','Source login has expired');
    requireCondition(Number(envelope?.code)===1000,'SOURCE_UNREACHABLE','Source did not confirm a successful query');
    requireCondition(Object.hasOwn(envelope,this.payloadField),'SOURCE_UNREACHABLE','Source payload field is missing');return {result:envelope[this.payloadField],evidence:response.evidence};
  }
  async products(){return this.request('/plmquery/product/all/');}
  async list(filters:Record<string,string|number>={}){const query=new URLSearchParams(Object.entries(filters).filter(([key])=>key!=='page').map(([key,value])=>[key,String(value)]));return this.request(`/plmquery/bug/?${query}`);}
  async detail(ids:(number|string)[]):Promise<{items:any[];evidence:RawReturn}>{
    requireCondition(ids.length>0&&ids.length<=100&&ids.every(id=>/^\d+$/.test(String(id))),'INVALID_PAYLOAD','Detail batches contain one to one hundred numeric ids');
    const response=await this.request('/plmquery/bug/detail/',{bug_ids:ids});requireCondition(Array.isArray(response.result),'SOURCE_UNREACHABLE','Source detail payload must be an array');
    return {items:response.result.map(mirrorBug),evidence:response.evidence};
  }
  async build(id:string){requireCondition(/^\d+$/.test(id),'INVALID_PAYLOAD','Use a numeric build identity');const response=await this.request(`/plmquery/build/${id}/`);return {...response,result:{...response.result,id:String(response.result.id),bugIds:String(response.result.bugs??'').split(',').map(id=>id.trim()).filter(Boolean),releaseAuthority:false}};}
  async builds(filters:Record<string,string|number>={}){const query=new URLSearchParams(Object.entries(filters).map(([key,value])=>[key,String(value)]));return this.request(`/plmquery/build/?${query}`);}
  async sync(filters:Record<string,string|number>={},previous:Record<string,string>={}):Promise<Incremental<any>> {
    const cursor={...previous},last=previous.$lastEditedDate;
    // An overlap catches clock skew and mirror updates; future source times remain intact.
    const start=last?new Date(new Date(last).getTime()-10*60_000).toISOString():undefined;
    const list=await this.list({...filters,...(start?{lastEditedDate_start:new Date(new Date(start).getTime()+8*60*60_000).toISOString().slice(0,19).replace('T',' ')}:{})});
    requireCondition(Array.isArray(list.result),'SOURCE_UNREACHABLE','Source list payload must be an array');const evidence=[list.evidence],items:any[]=[];
    for(let offset=0;offset<list.result.length;offset+=100){const detailed=await this.detail(list.result.slice(offset,offset+100).map((x:any)=>x.id));evidence.push(detailed.evidence);
      for(const item of detailed.items){const revision=item.lastEditedDate??canonicalHash(item);if(cursor[item.id]!==revision)items.push(item);cursor[item.id]=revision;if(item.lastEditedDate&&(!cursor.$lastEditedDate||item.lastEditedDate>cursor.$lastEditedDate))cursor.$lastEditedDate=item.lastEditedDate;}
    }return {items,cursor,evidence};
  }
}

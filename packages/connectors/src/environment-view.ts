import {requireCondition} from '../../contracts/src/index.ts';
import {HttpSource,type Incremental} from './readonly-sdk.ts';

export const READ_COMMANDS=['environment.inventory','environment.topology','device.status','framework.files','framework.get'] as const;
export class EnvironmentView {
  source:HttpSource;constructor(source:HttpSource){this.source=source;}
  async call(command:string,args:Record<string,unknown>):Promise<any> {
    requireCondition((READ_COMMANDS as readonly string[]).includes(command),'FORBIDDEN_ACTION','Command is outside the read allowlist');
    requireCondition(Object.keys(args).every(key=>['environmentId','deviceId','path'].includes(key))&&Object.values(args).every(value=>typeof value==='string'),'INVALID_PAYLOAD','Read commands accept identifiers only');
    if(args.path)requireCondition(!String(args.path).startsWith('/')&&!String(args.path).split('/').includes('..'),'INVALID_PAYLOAD','Use a relative framework path');
    const response=await this.source.json('/jump/view',{method:'POST',json:{command,args}});
    requireCondition(typeof response.result.revision==='string','SOURCE_UNREACHABLE','Read transport must provide a revision');
    return {result:response.result.result,revision:response.result.revision,evidence:response.evidence};
  }
  async sync(previous:Record<string,string>={}):Promise<Incremental<any>> {
    const response=await this.call('environment.inventory',{});requireCondition(Array.isArray(response.result),'SOURCE_UNREACHABLE','Environment inventory must be an array');
    const cursor:Record<string,string>={},items:any[]=[];for(const item of response.result){const id=String(item.id),revision=String(item.revision??response.revision);cursor[id]=revision;if(previous[id]!==revision)items.push(item);}
    return {items,cursor,evidence:[response.evidence]};
  }
}

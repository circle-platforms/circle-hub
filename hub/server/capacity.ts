// One presentation and exact unit conversion for console, MCP and CLI capacity messages.
import {CapacityUnitSchema,uiLabelOf,type CapacityUnit} from '../../contracts/generated/vocabulary.ts';
import type {SpaceId} from '../../contracts/src/spaces.ts';
import {KnowledgeError,type CapacityUsage} from '../knowledge/api.ts';
export const inputCapacityUnits=CapacityUnitSchema.extract(['mb','gb']);
export const unitBytes=(unit:CapacityUnit)=>unit==='gb'?1073741824n:unit==='mb'?1048576n:1024n;
const integer=(value:number)=>{if(!Number.isSafeInteger(value)||value<0)throw new TypeError('capacity must be an exact nonnegative byte count');return BigInt(value);};
export const exactBytes=(bytes:number)=>integer(bytes).toLocaleString('en-US')+' 字节';
export function formatCapacity(bytes:number):string{
 const n=integer(bytes),unit:CapacityUnit=n>=unitBytes('gb')?'gb':n>=unitBytes('mb')?'mb':'kb',factor=unitBytes(unit),tenths=(n*10n+factor/2n)/factor;
 return (tenths/10n).toLocaleString('en-US')+'.'+tenths%10n+' '+uiLabelOf('capacity_unit',unit);
}
export function parseCapacity(amount:string,rawUnit:string):number{
 const unit=inputCapacityUnits.safeParse(rawUnit);if(!unit.success||amount.length>64||!/^\d+(?:\.\d+)?$/.test(amount))throw new TypeError('容量请输入非负十进制数，并选择 MB 或 GB');
 const [whole,fraction='']=amount.split('.'),denominator=10n**BigInt(fraction.length),value=BigInt(whole+fraction)*unitBytes(unit.data);
 if(value%denominator!==0n||value/denominator>BigInt(Number.MAX_SAFE_INTEGER))throw new TypeError('容量须能精确换算为整数字节，且不能超过 9,007,199,254,740,991 字节');
 return Number(value/denominator);
}
/** Exact finite decimal; the rounded display is never used to overwrite a stored limit. */
export function capacityInput(bytes:number){
 const value=integer(bytes),unit=value>=unitBytes('gb')?'gb':'mb',factor=unitBytes(unit);let remainder=value%factor,fraction='';
 while(remainder){remainder*=10n;fraction+=String(remainder/factor);remainder%=factor;}
 return {amount:String(value/factor)+(fraction?'.'+fraction:''),unit};
}
export function capacityFailure(error:unknown):(CapacityUsage&{requested:number;space?:SpaceId})|null{
 if(!(error instanceof KnowledgeError)||error.code!=='SPACE_CAPACITY_EXCEEDED')return null;const facts=error.detail.capacity;
 if(!facts||typeof facts!=='object')return null;const data=facts as Record<string,unknown>;
 const required:Record<keyof(CapacityUsage&{requested:number}),0>={used:0,limit:0,remaining:0,over:0,requested:0,knowledge:0,memory:0};
 for(const key of Object.keys(required))if(typeof data[key]!=='number'||!Number.isSafeInteger(data[key])||Number(data[key])<0)return null;
 if(data.space!==undefined&&data.space!=='team')return null;
 return data as unknown as CapacityUsage&{requested:number;space?:SpaceId};
}
export function knowledgeMessage(error:KnowledgeError):string{
 const facts=capacityFailure(error);if(!facts)return error.message;
 const value=(bytes:number)=>`${formatCapacity(bytes)}（${exactBytes(bytes)}）`;
 return `${error.message}；已用 ${value(facts.used)} / 上限 ${value(facts.limit)} / 剩余 ${value(facts.remaining)} / 本次新增 ${value(facts.requested)}`;
}

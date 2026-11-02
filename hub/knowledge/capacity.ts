// Shared native accounting and sync admission use the same verified record ledger.
import {PROTOCOL_CODES} from '../../contracts/generated/protocol.ts';
import type {CapacityUsage,CapacityHistory} from '../records/api.ts';
export {historyUsage,chargedBytes,safeBytes,type CapacityHistory,type CapacityUsage} from '../records/api.ts';
import {KnowledgeError} from './errors.ts';
export function capacityUsage(history:CapacityHistory,limit:number):CapacityUsage{return {...history,limit,remaining:Math.max(0,limit-history.used),over:Math.max(0,history.used-limit)};}
export function requireCapacity(usage:CapacityUsage,requested:number){
 if(BigInt(usage.used)+BigInt(requested)>BigInt(usage.limit))throw new KnowledgeError(PROTOCOL_CODES.SPACE_CAPACITY_EXCEEDED.when,{code:'SPACE_CAPACITY_EXCEEDED',detail:{capacity:{...usage,requested}}});
}

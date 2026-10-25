// Readiness comes only from declared result fields, never report prose or an inferred status spelling.
import {at,mapped,type ExecutorDefinition} from './definition.ts';
export const REPORT_READ_ATTEMPTS=8;
export const REPORT_READ_WINDOW_MS=30000;
export function reportReadDelay(poll:number,attempt:number):number{return Math.min(4000,Math.max(20,poll)*2**Math.min(attempt-1,8));}
export function reportPending(value:unknown,d:ExecutorDefinition,items:readonly string[]):boolean{
 if(at(value,d.result.complete)!==true)return true;
 const rows=at(value,d.result.items);if(!Array.isArray(rows))return true;
 return items.some(id=>{const found=rows.filter(row=>at(row,d.result.item_id)===id);if(!found.length)return true;if(found.length!==1)return false;const outcome=at(found[0],d.result.item_outcome);return outcome===undefined||outcome===null;});
}
export function trustedStatus(mapping:ReturnType<typeof mapped<ExecutorDefinition['status']['map'][string]>>):boolean{
 return !!mapping&&mapping.effect_outcome!=='unknown'&&mapping.action_result!=='unknown'&&mapping.acceptance!=='not_accepted'&&mapping.effect_outcome!=='read_back_mismatch'&&mapping.effect_outcome!=='target_rejected'&&mapping.effect_outcome!=='not_dispatched'&&mapping.effect_outcome!=='proven_not_executed';
}

import {canonicalHash,registeredErrorCode,requireCondition} from '../../contracts/src/index.ts';

// These are C projections of already authenticated terminal observations. They
// neither declare D completion nor change the candidate bytes checked by Hooks.
export function terminalInterpretationFacts(operationId:string,error:any,reference:any){
 const normalized={...error,code:registeredErrorCode(error?.code)?error.code:'INTERNAL_ERROR'};
 return {interpretationStatus:'failed',error:normalized,unmapped:[{operationId,reason:'interpretation_unavailable',code:normalized.code,reference}]};
}

export function terminalPartialDelivery(status:string,candidate:any,observations:any[]){
 const failed=observations.filter(row=>row?.facts?.terminal===true&&row.facts.interpretationStatus==='failed');
 requireCondition(!failed.length||status==='partial','EVIDENCE_INSUFFICIENT','A proven terminal interpretation failure cannot be delivered as succeeded');
 const unmapped=[...(Array.isArray(candidate?.unmapped)?candidate.unmapped:[]),...failed.flatMap(row=>row.facts.unmapped??[])],unique=[...new Map(unmapped.map(item=>[canonicalHash(item),item])).values()];
 return {...(failed.length?{error:failed[0].facts.error}:{}),unmapped:unique};
}

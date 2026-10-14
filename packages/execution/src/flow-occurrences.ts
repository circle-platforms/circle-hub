import {ApiError,requireCondition} from '../../contracts/src/index.ts';

export interface FlowOccurrenceRow {step_id:string;occurrence:number|string;status:string;request_hash:string}
export interface ExpectedFlowOccurrence {stepId:string;nextOccurrence:number}
const completed=new Set(['succeeded','failed','reconciled']);

// These rows are supplied by C from the frozen task/revision partition. A gap
// or pending row never grants a later occurrence, including historical rows.
export function flowExpectedOccurrences(rows:FlowOccurrenceRow[]):ExpectedFlowOccurrence[]{
 const grouped=new Map<string,Set<number>>();
 for(const row of rows){if(row.step_id.startsWith('hub.'))continue;let values=grouped.get(row.step_id);if(!values){values=new Set();grouped.set(row.step_id,values);}if(completed.has(row.status))values.add(Number(row.occurrence));}
 return [...grouped].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([stepId,values])=>{let nextOccurrence=0;while(values.has(nextOccurrence))nextOccurrence++;return {stepId,nextOccurrence};});
}

export function flowResolveOccurrence<T extends {stepId:string;occurrence:number}>(action:T,rows:FlowOccurrenceRow[],requestHash:string):{action:T;replayed:boolean}{
 requireCondition(!action.stepId.startsWith('hub.'),'INVALID_PAYLOAD','Product cannot select a Hub step identity');
 const old=rows.find(row=>row.step_id===action.stepId&&Number(row.occurrence)===action.occurrence);
 if(old){requireCondition(old.request_hash===requestHash,'IDEMPOTENCY_MISMATCH','Existing occurrence has different content');return {action:{...action,occurrence:Number(old.occurrence)},replayed:true};}
 const expected=flowExpectedOccurrences(rows).find(row=>row.stepId===action.stepId)?.nextOccurrence??0;
 if(action.occurrence!==expected)throw new ApiError('INVALID_PAYLOAD','Action occurrence differs from the Hub expected occurrence',{stepId:action.stepId,expectedOccurrence:expected,requestedOccurrence:action.occurrence});
 return {action:{...action,occurrence:expected},replayed:false};
}

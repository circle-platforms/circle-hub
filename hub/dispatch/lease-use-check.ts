import type {HolderSnapshot} from '../leases/api.ts';

/** Internal observed fields, not reasons or remote execution verdicts. Missing rows do not establish an actor mismatch. */
export interface LeaseKeyUseCheck {
  key:string;
  row_exists:boolean|null;
  active:boolean|null;
  actor_matches:boolean|null;
  run_in_lineage:boolean|null;
  covers_window:boolean|null;
  expired:boolean|null;
  released:boolean|null;
  allowed:boolean|null;
}
export interface LeaseUseCheck {
  observed_at:string;
  rows_read:boolean;
  allowed:boolean|null;
  keys:LeaseKeyUseCheck[];
  missing_keys:string[]|null;
  active_other_account_holding:boolean|null;
  active_actor_holding:boolean|null;
  active_actor_outside_lineage:boolean|null;
  expired:boolean|null;
  released:boolean|null;
  references:string[];
}

export function checkLeaseUse(input:{keys:readonly string[];rows:readonly HolderSnapshot[]|null;actor:string;lineage:readonly string[];observedAt:Date;requiredMs:number;references?:readonly string[]}):LeaseUseCheck {
  const at=input.observedAt.getTime();
  if(!Number.isFinite(at)||!Number.isFinite(input.requiredMs)||input.requiredMs<0)throw new RangeError('lease check requires a valid observation time and window');
  const base={observed_at:input.observedAt.toISOString(),references:[...(input.references??[])]};
  if(input.rows===null)return {...base,rows_read:false,allowed:null,keys:input.keys.map(key=>({key,row_exists:null,active:null,actor_matches:null,run_in_lineage:null,covers_window:null,expired:null,released:null,allowed:null})),missing_keys:null,active_other_account_holding:null,active_actor_holding:null,active_actor_outside_lineage:null,expired:null,released:null};
  const rows=input.rows;
  const keys:LeaseKeyUseCheck[]=input.keys.map(key=>{
    const row=rows.find(row=>row.key===key);
    if(!row)return {key,row_exists:false,active:false,actor_matches:null,run_in_lineage:null,covers_window:false,expired:null,released:null,allowed:false};
    const expiry=row.expires_at===null?null:Date.parse(row.expires_at);
    if(expiry!==null&&!Number.isFinite(expiry))throw new TypeError('lease expiration is not an observed timestamp');
    const active=!row.released&&(expiry===null||expiry>at);
    const actor_matches=row.user===input.actor,run_in_lineage=input.lineage.includes(row.run),covers_window=active&&(expiry===null||expiry>at+input.requiredMs);
    return {key,row_exists:true,active,actor_matches,run_in_lineage,covers_window,expired:expiry!==null&&expiry<=at,released:row.released,allowed:actor_matches&&run_in_lineage&&covers_window};
  });
  const failed=keys.filter(row=>row.allowed!==true).map(row=>row.key);
  const missing_keys=failed.length?failed:rows.length!==input.keys.length?[...input.keys]:[];
  return {...base,rows_read:true,allowed:missing_keys.length===0,keys,missing_keys,active_other_account_holding:keys.some(row=>row.active===true&&row.actor_matches===false),active_actor_holding:keys.some(row=>row.active===true&&row.actor_matches===true),active_actor_outside_lineage:keys.some(row=>row.active===true&&row.actor_matches===true&&row.run_in_lineage===false),expired:keys.some(row=>row.expired===true),released:keys.some(row=>row.released===true)};
}

/** Preserve the original read exception and its unknown check; callers must not turn this into a missing lease. */
export class LeaseUseReadError extends Error {
  readonly lease_check:LeaseUseCheck;
  constructor(error:unknown,check:LeaseUseCheck){super(error instanceof Error?error.message:'租约读取未取得可核对的事实',{cause:error});this.lease_check=check;}
}

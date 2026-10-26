import type { LeaseOp } from '../../../../contracts/generated/vocabulary.ts';
// Ownership plans and disclosure use only the frozen, already-authorized lease context.
import type { FrozenLeases, Normalized, PlanFailure } from './conclude.ts';
import type { ManifestBed } from './manifest.ts';

export function occupancyText(bed:ManifestBed,frozen:FrozenLeases):string[]{
  const prefix=`bed/${bed.name}/`;
  const registered=frozen.registrations?.find(row=>row.prefix===prefix);
  const lines=[registered?.mine?'你登记的':registered?'有主人':'未登记'];
  for(const device of bed.devices){
    const row=frozen.entries.find(r=>r.key===prefix+device.name&&(r.until===null||Date.parse(r.until)>Date.parse(frozen.now)));
    if(!row){lines.push(`${device.name}：Hub 记录里空闲（未排除本地操作）`);continue;}
    lines.push(`${device.name}：Hub 记录里${row.holder?'被 '+row.holder.name+' 的运行 ':'被运行 '}${row.run??'（历史记录未提供运行号，需重开运行读取）'} 占用，自 ${row.since??'（历史记录未提供起始时刻，需重开运行读取）'} 起（未排除本地操作）`);
    for(const job of row.jobs??[])lines.push(`作业 ${job} 还没有终态`);
  }
  return lines;
}

export type OwnershipRequest={op:Extract<LeaseOp,'register'>;prefix:string}|{op:Extract<LeaseOp,'unregister'>;prefix:string;reason:string}|{op:Extract<LeaseOp,'force_release'>;keys:string[];reason:string};
export interface OwnershipFields extends Record<string,unknown>{action:Normalized['action'];bed:string;keys:string[];reason:string;conclusion:string;}
export function ownershipPlan(beds:ManifestBed[],params:Normalized,frozen:FrozenLeases|undefined):
 {ok:true;fields:OwnershipFields;request:OwnershipRequest}|{ok:false;failure:PlanFailure}{
  const fail=(code:string,message:string,fix:string):{ok:false;failure:PlanFailure}=>({ok:false,failure:{code,message,fix}});
  const bed=beds.find(b=>b.name===params.bed);
  if(!bed)return fail('test-bed.unknown_bed','当前清单里没有这个台架','bed 写当前清单里的台架名');
  if(!frozen||!Array.isArray(frozen.registrations))return fail('test-bed.no_ownership','缺少冻结的登记表','请管理员启用登记视图后重开这次运行');
  const prefix=`bed/${bed.name}/`;const registered=frozen.registrations.find(row=>row.prefix===prefix);
  let request:OwnershipRequest;let keys:string[]=[];let conclusion:string;
  if(params.action==='register'){
    if(frozen.registrations.some(row=>row.prefix.startsWith(prefix)||prefix.startsWith(row.prefix)))return fail('test-bed.already_owned','这个台架已经有主人','请管理员核对并纠正登记，不要重复登记');
    request={op:'register',prefix};conclusion=`登记 ${bed.name} 到你名下`;
  }else if(params.action==='unregister'){
    if(!registered?.mine)return fail('test-bed.not_owner','这个台架不是你登记的','由登记主人或管理员带理由注销');
    request={op:'unregister',prefix,reason:params.reason};conclusion=`注销你登记的 ${bed.name}（理由：${params.reason}）`;
  }else{
    if(!registered?.mine)return fail('test-bed.not_owner','这个台架不是你登记的','由登记主人强制释放，或请管理员处置');
    if(params.devices?.some(name=>!bed.devices.some(device=>device.name===name)))return fail('test-bed.bad_devices','设备不在这个台架的清单里','devices 写这个台架里的设备名');
    keys=params.devices?params.devices.map(name=>prefix+name):frozen.entries.filter(row=>row.key.startsWith(prefix)&&(row.until===null||Date.parse(row.until)>Date.parse(frozen.now))).map(row=>row.key).sort();
    if(!keys.length||keys.some(key=>!frozen.entries.some(row=>row.key===key&&(row.until===null||Date.parse(row.until)>Date.parse(frozen.now)))))return fail('test-bed.not_occupied','要释放的键没有当前占用','重新搜索台架，核对当前占用后再决定');
    request={op:'force_release',keys,reason:params.reason};conclusion=`强制释放 ${bed.name}：${keys.join('、')}（理由：${params.reason}）`;
  }
  return {ok:true,fields:{action:params.action,bed:bed.name,keys,reason:params.reason,conclusion},request};
}

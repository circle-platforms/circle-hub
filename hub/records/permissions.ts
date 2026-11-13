// Role checks operate on the current account supplied by the calling permission boundary.
import type { RunRecord } from '../../contracts/src/run.ts';
import { AccessError } from './errors.ts';
import { withoutRequestPermissions } from './request-permissions.ts';
import type { Principals, Principal } from './api.ts';

export function isAdmin(principal: Pick<Principal, 'role'>): boolean {
  return principal.role === 'admin';
}

/** This is ownership visibility, not a read-only share or a resource assignment. */
export function canSeeRun(principal: Principal, run: Pick<RunRecord, 'runner' | 'host' | 'pack_space'>): boolean {
  if (run.pack_space && run.pack_space !== 'team') return run.runner === principal.id;
  if (isAdmin(principal)) return true;
  if (run.host === 'hub') return false;
  return run.runner !== undefined && run.runner === principal.id;
}


/** The existing system actor policy, resolved afresh without manufacturing an administrator. */
export async function systemActor(principals: Pick<Principals, 'list' | 'get'>): Promise<Principal> {
  return withoutRequestPermissions(async()=>{
    const candidates=(await principals.list()).filter(user=>!user.disabled&&!user.deleted_at&&isAdmin(user))
      .sort((a,b)=>a.created_at.localeCompare(b.created_at)||a.id.localeCompare(b.id));
    for(const candidate of candidates){
      const current=await principals.get(candidate.id);
      if(current&&!current.disabled&&!current.deleted_at&&isAdmin(current))return {id:current.id,name:current.name,role:current.role};
    }
    throw new AccessError('没有启用的管理员可作为系统操作人',{code:'SOURCE_UNAVAILABLE',fix:'请启用一名管理员后重试'});
  });
}

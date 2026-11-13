// Role checks operate on the current account supplied by the calling permission boundary.
import type { RunRecord } from '../../contracts/src/run.ts';
import type { Principal } from './api.ts';

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

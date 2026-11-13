// Environment use is an assignment, never an administrator's management privilege.
import { idOf, UserId } from '../../contracts/src/common.ts';
import type { Principal, RecordsKit, Transaction } from './api.ts';

const EnvironmentId = idOf('exe');

/** Capture fresh accounts and grants even when the surrounding request has an older read snapshot. */
export async function canUseEnvironment(records: Pick<RecordsKit, 'artifacts'>, actor: Principal, executor: string, tx?: Transaction): Promise<boolean> {
  if (!UserId.safeParse(actor.id).success || !EnvironmentId.safeParse(executor).success) return false;
  const snapshot = await records.artifacts.capturePermissionSnapshot?.(actor,tx);
  const user = snapshot?.user;
  if (!snapshot || !user || user.disabled || user.deleted_at) return false;
  return [user.id, ...snapshot.teams(), '*'].some(subject => snapshot.enabled(snapshot.latest('resource_assign', subject, executor)));
}

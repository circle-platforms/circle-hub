import type { TestEnvironment } from '../../contracts/api.ts';
import type { Principal } from './api.ts';
import type { RequestPermissions } from './request-permissions.ts';
import type { TestEnvironmentEntry } from './test-environments.ts';
import { isAdmin } from './permissions.ts';
import { isBookingPrefixRegistration } from './booking-prefix-registration.ts';

/** Assigned visibility is independent of whether the environment is currently enabled for new use. */
export function visibleTestEnvironments(by: Principal, values: readonly TestEnvironment[], permission: RequestPermissions): TestEnvironmentEntry[] {
  if (!permission.user || permission.user.disabled || permission.user.deleted_at) return [];
  const entries = values.map(value => ({ ...value, isTestEnvironment: value.target !== null, isBookingPrefix: isBookingPrefixRegistration(value) }));
  if (isAdmin(permission.user)) return entries;
  const subjects = [by.id, ...permission.teams(), '*'];
  return entries.filter(value => value.isTestEnvironment && subjects.some(subject => permission.enabled(permission.latest('resource_assign', subject, value.id))));
}

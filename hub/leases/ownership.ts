// A read projection of the single environment catalog, not another registration store.
import type { Transaction } from '../records/api.ts';

/** Includes target-less legacy prefix responsibility; no field here implies an environment-use grant. */
export interface LeaseOwnership {
  readonly prefixes: readonly { prefix: string; owner: string }[];
  readonly resources: readonly { key: string; owner: string }[];
}

export interface LeaseOwnershipCatalog {
  ownership(tx?: Transaction): Promise<LeaseOwnership>;
}

/** Preserve the existing trusted registration view without exposing the mutable catalog projection. */
export function registrationsOf(ownership: LeaseOwnership, prefix: string): Array<{ prefix: string; owner: string }> {
  return ownership.prefixes.filter(row => row.prefix.startsWith(prefix)).map(row => ({ ...row }))
    .sort((a, b) => a.prefix.localeCompare(b.prefix) || a.owner.localeCompare(b.owner));
}

/** Responsibility permits guarded cleanup only; it is never a member's environment-use assignment. */
export function ownsLeaseKeys(ownership: LeaseOwnership, owner: string, keys: readonly string[]): boolean {
  return keys.length > 0 && keys.every(key => {
    const owners = new Set([
      ...ownership.prefixes.filter(row => row.prefix.endsWith('/') && key.startsWith(row.prefix)).map(row => row.owner),
      ...ownership.resources.filter(row => row.key === key).map(row => row.owner),
    ]);
    return owners.size === 1 && owners.has(owner);
  });
}

// The lease service's public surface (core step C2): one class, LeaseService, over one database.
export { LeaseService, type Holder, type HolderSnapshot, type RecentHolder, type AcquireOutcome, type ChangeOutcome, type ServiceOptions } from './service.ts';

export type { LeaseOwnership, LeaseOwnershipCatalog } from './ownership.ts';

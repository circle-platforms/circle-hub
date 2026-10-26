// The lease service's public surface (core step C2): one class, LeaseService, over one database.
export { LeaseService, type Holder, type HolderSnapshot, type AcquireOutcome, type ChangeOutcome, type RegistrationOutcome, type ServiceOptions } from './service.ts';

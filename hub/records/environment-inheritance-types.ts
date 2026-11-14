import type { ExecutorSource } from '../../contracts/src/resources.ts';
import type { AuthorizationRecord, ObjectStore, RecordStore, Transaction } from './api.ts';

/** Verified reads in the caller-owned cutover transaction; no writable store or lease-holder inference. */
export interface TestEnvironmentInheritanceContext {
  store: Pick<RecordStore, 'get' | 'find' | 'list'>;
  objects: Pick<ObjectStore, 'get'>;
  tx: Transaction;
  at: string;
  /** Verified original chains, in ascending append order; not only active grants. */
  authorizations: readonly AuthorizationRecord[];
}

export interface TestEnvironmentInheritanceInput {
  workflows: readonly {
    id: string;
    prefix: string;
    installedMethod: boolean;
    sourceRecords: readonly string[];
  }[];
  executors: readonly ExecutorSource[];
  sourceRecords: readonly string[];
}

export interface TestEnvironmentInheritanceSources {
  collect(context: TestEnvironmentInheritanceContext): Promise<TestEnvironmentInheritanceInput>;
}

import type { RecordStore, Transaction } from './api.ts';

const PERMISSION_BOUNDARY = 'test-environment.permissions';

/** Source mutations and new-use intents serialize before account, team, catalog and lease locks. */
export function lockEnvironmentPermission(store: Pick<RecordStore, 'lock'>, tx: Transaction): Promise<void> {
  return store.lock(PERMISSION_BOUNDARY, tx);
}

/** The callback must persist its admission intent here, and perform no network operation in this transaction. */
export function withEnvironmentPermissionLock<T>(store: RecordStore, fn: (tx: Transaction) => Promise<T>, outer?: Transaction): Promise<T> {
  return store.withTransaction(async tx => {
    await lockEnvironmentPermission(store, tx);
    return fn(tx);
  }, outer);
}

import { TEST_ENVIRONMENT_CONFIG_PREFIX, TEST_ENVIRONMENT_INHERITANCE_KEY } from '../../contracts/api.ts';
import type { Transaction } from './api.ts';
import { AccessError } from './errors.ts';

const permitted = new WeakSet<Transaction>();

/** Only the catalog writer may append protected catalog and one-time completion decisions. */
export function assertEnvironmentProgramWrite(body: unknown, tx?: Transaction): void {
  if (body === null || typeof body !== 'object') return;
  const value = body as { permission?: unknown; object?: unknown };
  if (value.permission !== 'resource_config' || typeof value.object !== 'string') return;
  if ((value.object === TEST_ENVIRONMENT_INHERITANCE_KEY || value.object.startsWith(TEST_ENVIRONMENT_CONFIG_PREFIX)) && (!tx || !permitted.has(tx)))
    throw new AccessError('测试环境目录和继承完成记录只能由正式目录操作写入');
}

/** Package-internal capability, never exported by records/api.ts. */
export async function environmentProgramWrite<T>(tx: Transaction, write: () => Promise<T>): Promise<T> {
  const nested = permitted.has(tx);
  permitted.add(tx);
  try { return await write(); } finally { if (!nested) permitted.delete(tx); }
}

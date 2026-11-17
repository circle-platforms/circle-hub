import type { HubConfig } from '../config/index.ts';
import type { DatabaseTarget } from '../platform/api.ts';
import { CliError } from './errors.ts';

/** Automatic reset is supported only for the exact platform-managed database, not an external serving DSN. */
export function assertResetTarget(database: HubConfig['database'], target: DatabaseTarget): void {
  if (database.host !== target.socketDir || database.port !== target.port || database.database !== target.database)
    throw new CliError('服务数据库与本机平台数据库目标不一致，不支持自动重建；未执行重置', '请由数据库所有者核对连接目标并使用受控归档和重建流程');
}

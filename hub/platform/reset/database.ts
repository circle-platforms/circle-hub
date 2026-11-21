// PostgreSQL primitives only. The server owns schema migration, data selection, authorization and recovery.
import type { PostgresControl } from '../postgres.ts';
import { PlatformError } from '../errors.ts';
import { quoteIdentifier, withSession } from '../sql.ts';

export type ResetDatabaseControl = Pick<PostgresControl, 'connector' | 'target'>;
export interface CreateResetDatabaseOptions { template?: string; }

function identifier(value: string): string {
  if (typeof value !== 'string' || value.length === 0 || !value.isWellFormed() || value.includes('\0') || Buffer.byteLength(value, 'utf8') > 63) {
    throw new PlatformError('数据库或角色标识符无效', '名字不能为空、含空字节或超过 PostgreSQL 的 63 字节上限；不截断或改写名字');
  }
  return quoteIdentifier(value);
}
function destination(value: string): string {
  const quoted = identifier(value);
  if (value === 'postgres' || value === 'template0' || value === 'template1') throw new PlatformError('不能重建 PostgreSQL 的维护库或模板库');
  return quoted;
}

/** Blocks new connections, ends existing backends and preserves the database under its archive name; never deletes it.
 * Statements may have committed before a failure. The server must recover by the saved original database identity.
 */
export async function archiveResetDatabase(control: ResetDatabaseControl, database: string, archive: string): Promise<void> {
  const source = destination(database), target = destination(archive);
  if (database === archive) throw new PlatformError('原数据库与归档数据库不能同名');
  try {
    await withSession(control.connector, 'postgres', async session => {
      await session.query(`ALTER DATABASE ${source} ALLOW_CONNECTIONS false`);
      await session.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [database]);
      await session.query(`ALTER DATABASE ${source} RENAME TO ${target}`);
    });
  } catch {
    throw new PlatformError('数据库归档未能完成', '停止连接或改名可能已经生效；由重建控制器按原数据库身份恢复，不删除归档');
  }
}

/** Creates a private empty database from template0, or a generic clone of the caller's explicit template.
 * Does not inspect business tables, create roles, run migrations or grant a runtime application access.
 */
export async function createResetDatabase(control: ResetDatabaseControl, database: string, options: CreateResetDatabaseOptions = {}): Promise<void> {
  const target = destination(database), owner = identifier(control.target.user);
  const templateName = options.template ?? 'template0', template = identifier(templateName);
  if (database === templateName) throw new PlatformError('新数据库与克隆源不能同名');
  try {
    await withSession(control.connector, 'postgres', async session => {
      await session.query(`CREATE DATABASE ${target} OWNER ${owner} TEMPLATE ${template}`);
      await session.query(`REVOKE ALL ON DATABASE ${target} FROM PUBLIC`);
    });
  } catch {
    throw new PlatformError('数据库创建未能完成', '新库可能已经建立；由重建控制器检查并恢复，未执行任何业务迁移');
  }
}

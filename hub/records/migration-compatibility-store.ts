import type { Transaction } from './api.ts';
import type { Database } from './db.ts';
import { MigrationError } from './errors.ts';
import { checkMigrationCompatibilityDeclarations, validMigrationCompatibilityDeclaration, type MigrationCompatibilityDeclaration, type MigrationCompatibilityObservation } from './migration-compatibility.ts';
import type { RecordMigrationReceipt } from './schema-compatibility.ts';

type CompatibilityDatabase = Pick<Database, 'query'>;

/** Caller owns the transaction; invoke before other observations to establish its read-only snapshot. */
export async function readMigrationCompatibility(db: CompatibilityDatabase, tx: Transaction): Promise<MigrationCompatibilityObservation> {
  if (tx === undefined) throw new TypeError('a caller-owned transaction is required');
  try {
    await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY', [], tx);
    const observed = (await db.query<{ migration_table: string | null; declaration_table: string | null; declarations_read_only: boolean | null }>(`
      WITH objects AS (
        SELECT pg_catalog.to_regclass('public.schema_migrations') AS migrations,
               pg_catalog.to_regclass('public.hub_migration_compatibility') AS declarations
      )
      SELECT migrations::text AS migration_table, declarations::text AS declaration_table,
        CASE WHEN declarations IS NULL THEN NULL ELSE
          (SELECT relowner FROM pg_catalog.pg_class WHERE oid=migrations) =
          (SELECT relowner FROM pg_catalog.pg_class WHERE oid=declarations)
          AND NOT pg_catalog.pg_has_role(current_user,(SELECT relowner FROM pg_catalog.pg_class WHERE oid=declarations),'MEMBER')
          AND NOT pg_catalog.has_schema_privilege(current_user,'public','CREATE')
          AND NOT pg_catalog.has_table_privilege(current_user,declarations,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
          AND NOT pg_catalog.has_any_column_privilege(current_user,declarations,'INSERT,UPDATE,REFERENCES')
        END AS declarations_read_only
      FROM objects`, [], tx)).rows[0];
    if (!observed) throw new Error('migration carrier observation missing');
    const applied = observed.migration_table === null ? null : (await db.query<RecordMigrationReceipt & Record<string, unknown>>(
      'SELECT version,name,sha256 FROM public.schema_migrations ORDER BY version', [], tx,
    )).rows;
    const declarations = observed.declaration_table === null ? null : (await db.query<MigrationCompatibilityDeclaration & Record<string, unknown>>(
      'SELECT migration_version,format_version,migration_name,migration_sha256,minimum_reader_level FROM public.hub_migration_compatibility ORDER BY migration_version', [], tx,
    )).rows;
    return { available: true, applied, declarations, declarationsReadOnly: observed.declarations_read_only };
  } catch {
    return { available: false, applied: null, declarations: null, declarationsReadOnly: null };
  }
}

/** Append only after the receipt exists in the owner's migration transaction. No DDL, commit or role switching here. */
export async function appendMigrationCompatibility(db: CompatibilityDatabase, tx: Transaction, declaration: MigrationCompatibilityDeclaration): Promise<void> {
  if (tx === undefined) throw new TypeError('a caller-owned migration transaction is required');
  if (!validMigrationCompatibilityDeclaration(declaration)) throw new MigrationError('兼容声明格式或最低代码级别不受支持；尚未写入，请核对迁移声明');
  const owner = (await db.query<{ owns: boolean }>(
    "SELECT pg_catalog.pg_get_userbyid(c.relowner)=current_user AS owns FROM pg_catalog.pg_class c WHERE c.oid=pg_catalog.to_regclass('public.hub_migration_compatibility')", [], tx,
  )).rows[0];
  if (owner?.owns !== true) throw new MigrationError('仅兼容声明载体的拥有者可追加声明；请由迁移拥有者执行，尚未写入');
  await db.query('LOCK TABLE public.hub_migration_compatibility IN SHARE ROW EXCLUSIVE MODE', [], tx);
  const applied = (await db.query<RecordMigrationReceipt & Record<string, unknown>>('SELECT version,name,sha256 FROM public.schema_migrations ORDER BY version FOR SHARE', [], tx)).rows;
  const declarations = (await db.query<MigrationCompatibilityDeclaration & Record<string, unknown>>(
    'SELECT migration_version,format_version,migration_name,migration_sha256,minimum_reader_level FROM public.hub_migration_compatibility ORDER BY migration_version', [], tx,
  )).rows;
  const checked = checkMigrationCompatibilityDeclarations(applied, declarations);
  if (checked.problem !== null) throw new MigrationError('现有兼容声明与迁移回执不一致；尚未写入，请核对迁移身份');
  const receipt = applied.find(row => row.version === declaration.migration_version);
  if (!receipt || receipt.name !== declaration.migration_name || receipt.sha256 !== declaration.migration_sha256) throw new MigrationError('兼容声明未与已应用的迁移回执精确绑定；尚未写入，请核对版本、名称及摘要');
  const prior = declarations.find(row => row.migration_version === declaration.migration_version);
  if (prior) {
    if (prior.format_version !== declaration.format_version || prior.migration_name !== declaration.migration_name || prior.migration_sha256 !== declaration.migration_sha256 || prior.minimum_reader_level !== declaration.minimum_reader_level) throw new MigrationError('已追加的兼容声明不能修改；请新增迁移，不降低代码级别');
    return;
  }
  if (receipt.version !== applied.at(-1)?.version) throw new MigrationError('只能为本次最新迁移追加兼容声明；不能回填旧回执，请核对迁移次序');
  if (applied.slice(1, -1).some(row => !declarations.some(entry => entry.migration_version === row.version))) throw new MigrationError('先前新迁移缺少兼容声明；尚未写入，请核对迁移次序');
  if (declaration.minimum_reader_level < (checked.effectiveFloor ?? 0)) throw new MigrationError('新声明不能降低最低代码级别；尚未写入，请保留现有权限语义');
  await db.query(
    'INSERT INTO public.hub_migration_compatibility(migration_version,format_version,migration_name,migration_sha256,minimum_reader_level) VALUES($1,$2,$3,$4,$5)',
    [declaration.migration_version, declaration.format_version, declaration.migration_name, declaration.migration_sha256, declaration.minimum_reader_level], tx,
  );
}

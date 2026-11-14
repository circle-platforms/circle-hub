// Read-only migration diagnostics: no bootstrap, migration execution or business-schema probing.
import type { RecordsConfig } from './api.ts';
import { createPool, Database } from './db.ts';
import { MIGRATIONS, migrationChecksum } from './migrations.ts';

export interface RecordMigrationReceipt { version:number; name:string; sha256:string }
export interface RecordsSchemaCompatibility {
  status:'compatible'|'incompatible'|'unavailable';
  compatible:boolean|null;
  expected:RecordMigrationReceipt[];
  applied:RecordMigrationReceipt[] | null;
  problems:string[];
}

/** The current program owns the expected schema; callers never duplicate baseline versions or hashes. */
export function currentRecordMigrations():RecordMigrationReceipt[] {
  return MIGRATIONS.map(migration=>({version:migration.version,name:migration.name,sha256:migrationChecksum(migration)}));
}

export function compareRecordMigrations(applied:RecordMigrationReceipt[]|null):RecordsSchemaCompatibility {
  const expected=currentRecordMigrations();
  const compatible=applied!==null&&applied.length===expected.length&&expected.every((migration,index)=>{
    const row=applied[index];return row.version===migration.version&&row.name===migration.name&&row.sha256===migration.sha256;
  });
  return {status:compatible?'compatible':'incompatible',compatible,expected,applied,problems:compatible?[]:[applied===null?'记录库没有可读的迁移登记；请归档并初始化，或用定义文件恢复':'记录库的迁移登记与当前程序不一致；请归档并初始化，或用定义文件恢复']};
}

/** A failed observation proves no schema incompatibility and must never enable destructive recovery. */
export function unavailableRecordsSchema():RecordsSchemaCompatibility {
  return {status:'unavailable',compatible:null,expected:currentRecordMigrations(),applied:null,
    problems:['无法读取迁移登记，尚不能确认记录库是否兼容；请检查连接与读取权限后重试，当前不能执行重建']};
}

export async function diagnoseRecordsSchema(config:Pick<RecordsConfig,'database'>):Promise<RecordsSchemaCompatibility> {
  const db=new Database(createPool(config.database,1));
  try {
    return await db.transaction(async tx=>{
      await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',[],tx);
      const exists=(await db.query<{relation:string|null}>("SELECT pg_catalog.to_regclass('public.schema_migrations')::text AS relation",[],tx)).rows[0];
      if(!exists?.relation)return compareRecordMigrations(null);
      const rows=(await db.query<{version:number;name:string;sha256:string}>('SELECT version,name,sha256 FROM public.schema_migrations ORDER BY version',[],tx)).rows;
      return compareRecordMigrations(rows.map(row=>({version:Number(row.version),name:row.name,sha256:row.sha256})));
    });
  } catch {
    return unavailableRecordsSchema();
  } finally { await db.end(); }
}

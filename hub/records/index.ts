import { requireEnvironmentAssignmentActivation, verifyEnvironmentUpgradeOpenSchema } from './environment-assignment-upgrade.ts';
import {preserveTeamAttributions} from './team-attributions.ts';
import {PgMemberDeletions} from './member-deletions.ts';
import {PgPersonalSync} from './personal-sync.ts';
// Entry point of the records package: everything in api.ts plus openRecords, which connects, migrates and wires the kit, and
// migrateRecords, which applies migrations as the owner role and grants the runtime role (README decision 16).
import { mkdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { OpenRecordsOptions, RecordsConfig, RecordsKit } from './api.ts';
import { RecordArtifacts } from './artifacts.ts';
import { RecordAuthorizations } from './authorizations.ts';
import { PgTeams } from './teams.ts';
import { PgCallLog, argumentDigest, newSpanId } from './calllog.ts';
import { Database, createPool } from './db.ts';
import { MIGRATIONS, RUNTIME_GRANTS, grantRuntime, migrate } from './migrations.ts';
import { FileObjectStore } from './objects.ts';
import { PgPointers } from './pointers.ts';
import { PgPrincipals } from './principals.ts';
import { PgRecordStore } from './store.ts';
import { FileVault } from './vault.ts';
import { RecordVariables } from './variables.ts';
import { MaskingRules } from './masking.ts';
import {PgMemoryIndex} from './memory-index.ts';
import { PgSpaceSearchIndex } from './space-index.ts';
import { inspectRecordsSchema } from './schema-compatibility.ts';
import { MigrationError } from './errors.ts';

export * from './api.ts';
export { argumentDigest, newSpanId, MIGRATIONS, RUNTIME_GRANTS };

/**
 * Applies pending migrations connected as the role that owns (or will own) the tables, then, when `runtimeRole` is given,
 * grants that role exactly RUNTIME_GRANTS. The Hub then runs as the runtime role with `openRecords(..., { migrate: false })`.
 * Returns the versions applied by this call.
 */
export async function migrateRecords(config: Pick<RecordsConfig, 'database'>, options: { runtimeRole?: string } = {}): Promise<number[]> {
  const db = new Database(createPool(config.database, 1));
  try {
    const applied = await migrate(db);
    if (options.runtimeRole !== undefined) await grantRuntime(db, options.runtimeRole);
    return applied;
  } finally {
    await db.end().catch(() => {});
  }
}

/**
 * Opens the records kit: creates the data directories (0700), connects to PostgreSQL, applies pending migrations (refusing to
 * start on an unknown or altered applied migration) and wires every store. With `migrate: false` (a runtime role that may
 * not change the schema) it verifies known receipts and declared unknown migrations at this code's capability level.
 * Preservation completion is checked separately before wiring the kit. Call close() to release the pool.
 */
export async function openRecords(config: RecordsConfig, options: OpenRecordsOptions = {}): Promise<RecordsKit> {
  if (!isAbsolute(config.dataDir) || !isAbsolute(config.logDir)) throw new TypeError('dataDir and logDir must be absolute paths');
  const now = options.now ?? (() => new Date());
  const objectsDir = join(config.dataDir, 'objects');
  for (const directory of [config.dataDir, objectsDir, config.logDir]) await mkdir(directory, { recursive: true, mode: 0o700 });
  const db = new Database(createPool(config.database, options.maxConnections ?? 10));
  try {
    if (options.migrate === false) {
      const schema = await inspectRecordsSchema(db);
      if (schema.compatible !== true) {
        // Preserve the exact previous-schema upgrade path and its independent completion gate.
        if (schema.status === 'incompatible' && schema.applied?.length === 1) await verifyEnvironmentUpgradeOpenSchema(db);
        throw new MigrationError(schema.problems.join('；'));
      }
      const privilege = (await db.query<{ runtime: boolean; temporary: boolean }>("SELECT pg_catalog.pg_get_userbyid(c.relowner)<>current_user AS runtime,pg_catalog.has_database_privilege(current_user,pg_catalog.current_database(),'TEMPORARY') AS temporary FROM pg_catalog.pg_class c WHERE c.oid=pg_catalog.to_regclass('public.records')")).rows[0];
      if (privilege?.runtime && privilege.temporary) throw new MigrationError('运行角色有创建临时对象的权限；请先收回该权限，拒绝启动');
    } else await migrate(db);
  } catch (error) {
    await db.end().catch(() => {});
    throw error;
  }
  const store = new PgRecordStore(db, { maxRecordBytes: config.limits.maxRecordBytes, now });
  try { await requireEnvironmentAssignmentActivation(db, store); } catch (error) { await db.end().catch(() => {}); throw error; }
  const objects = new FileObjectStore(objectsDir, db, { maxBytes: config.limits.maxUploadBytes, now,personalPayloads:store.personalPayloads });
  store.personalPayloads.beforePurge=(owner,by,tx)=>preserveTeamAttributions(store,objects,owner,by,tx,now);
  const authorizations = new RecordAuthorizations(db, store, now, objects);
  const vault = new FileVault(join(config.dataDir, 'vault'), options.keyProvider);
  const principals = new PgPrincipals(db, now, store);
  const teams = new PgTeams(db, store, objects, principals, authorizations, now);
  const variables = new RecordVariables({ database: db, store, objects, vault, principals, authorizations, now });
  const memberDeletions=new PgMemberDeletions(db,store,store.personalPayloads,now);
  memberDeletions.registerCacheRoot(join(config.dataDir,'packs','personal'));
  memberDeletions.registerCacheRoot(join(config.dataDir,'packs'),{shared:true});
  let closed: Promise<void> | undefined;
  return {
    teams,
    memberDeletions,
    personalSync:new PgPersonalSync(db,store,store.personalPayloads,config.limits,now),
    personalPayloads:store.personalPayloads,
    memoryIndex:new PgMemoryIndex(db,{documentBytes:config.limits.maxMemoryDocumentBytes,spaceBytes:config.limits.maxMemorySpaceBytes,spaceDocuments:config.limits.maxMemorySpaceDocuments}),
    spaceIndex: new PgSpaceSearchIndex(db,{entryBytes:config.limits.maxEntryIndexBytes,spaceBytes:config.limits.maxSpaceIndexBytes,productBytes:config.limits.maxProductIndexBytes}),
    config: { dataDir: config.dataDir, logDir: config.logDir, limits: { ...config.limits } },
    store,
    objects,
    artifacts: new RecordArtifacts(db, store, objects, authorizations, { maxBytes: config.limits.maxUploadBytes, now, onCredentialScan:options.onCredentialScan }),
    vault,
    variables,
    masking: new MaskingRules({ objects, principals, authorizations, now }),
    principals,
    authorizations,
    pointers: new PgPointers(db, store, now),
    callLog: new PgCallLog(db, store, config.logDir, now),
    poolStats: () => db.stats(),
    close: () => (closed ??= db.end()),
  };
}

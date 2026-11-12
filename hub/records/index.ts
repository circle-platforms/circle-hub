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
import { PgCallLog, argumentDigest, newSpanId } from './calllog.ts';
import { Database, createPool } from './db.ts';
import { MIGRATIONS, RUNTIME_GRANTS, grantRuntime, migrate, verifyMigrations } from './migrations.ts';
import { FileObjectStore } from './objects.ts';
import { PgPointers } from './pointers.ts';
import { PgPrincipals } from './principals.ts';
import { PgRecordStore } from './store.ts';
import { FileVault } from './vault.ts';
import { RecordVariables } from './variables.ts';
import { MaskingRules } from './masking.ts';
import {PgMemoryIndex} from './memory-index.ts';
import { PgSpaceSearchIndex } from './space-index.ts';

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
 * not change the schema) it only verifies that exactly this program's migrations are applied. Call close() to release the pool.
 */
export async function openRecords(config: RecordsConfig, options: OpenRecordsOptions = {}): Promise<RecordsKit> {
  if (!isAbsolute(config.dataDir) || !isAbsolute(config.logDir)) throw new TypeError('dataDir and logDir must be absolute paths');
  const now = options.now ?? (() => new Date());
  const objectsDir = join(config.dataDir, 'objects');
  for (const directory of [config.dataDir, objectsDir, config.logDir]) await mkdir(directory, { recursive: true, mode: 0o700 });
  const db = new Database(createPool(config.database, options.maxConnections ?? 10));
  try {
    if (options.migrate === false) await verifyMigrations(db);
    else await migrate(db);
  } catch (error) {
    await db.end().catch(() => {});
    throw error;
  }
  const store = new PgRecordStore(db, { maxRecordBytes: config.limits.maxRecordBytes, now });
  const objects = new FileObjectStore(objectsDir, db, { maxBytes: config.limits.maxUploadBytes, now,personalPayloads:store.personalPayloads });
  try{await objects.materializePersonalObjects();}
  catch(error){await db.end().catch(()=>{});throw error;}
  store.personalPayloads.beforePurge=(owner,by,tx)=>preserveTeamAttributions(store,objects,owner,by,tx,now);
  const authorizations = new RecordAuthorizations(db, store, now);
  const vault = new FileVault(join(config.dataDir, 'vault'), options.keyProvider);
  const principals = new PgPrincipals(db, now, store);
  const variables = new RecordVariables({ database: db, store, objects, vault, principals, authorizations, now });
  const memberDeletions=new PgMemberDeletions(db,store,store.personalPayloads,()=>objects.materializePersonalObjects(),now);
  memberDeletions.registerCacheRoot(join(config.dataDir,'packs','personal'));
  memberDeletions.registerCacheRoot(join(config.dataDir,'packs'),{shared:true});
  let closed: Promise<void> | undefined;
  return {
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

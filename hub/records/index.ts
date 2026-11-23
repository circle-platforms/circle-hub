import {preserveTeamAttributions} from './team-attributions.ts';
import {PgMemberDeletions} from './member-deletions.ts';
import {PgPersonalSync} from './personal-sync.ts';
// Entry point of the records package: everything in api.ts plus openRecords, which connects, migrates and wires the kit, and
// migrateRecords, which applies migrations as the owner role and grants the runtime role (README decision 16).
import { createHmac } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { OpenRecordsOptions, RecordsConfig, RecordsKit } from './api.ts';
import { VaultError } from './errors.ts';
import { RecordArtifacts } from './artifacts.ts';
import { RecordAuthorizations } from './authorizations.ts';
import { PgTeams } from './teams.ts';
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

const EXTERNAL_IDENTITY_AUDIT_KEY_CONTEXT = 'circle-hub:external-identity-audit:v1';
const EXTERNAL_IDENTITY_AUDIT_KEY_ERROR = '密钥库主密钥不可用，无法写入外部身份审计记录；请先初始化或恢复主密钥';

async function resolveExternalIdentityAuditKey(
  keyProvider: OpenRecordsOptions['keyProvider'],
): Promise<Uint8Array> {
  if (!keyProvider) throw new VaultError(EXTERNAL_IDENTITY_AUDIT_KEY_ERROR);
  let masterKey: Uint8Array;
  try {
    masterKey = await keyProvider.getKey();
  } catch (error) {
    throw new VaultError(EXTERNAL_IDENTITY_AUDIT_KEY_ERROR, { cause: error });
  }
  if (masterKey.byteLength !== 32) {
    throw new VaultError(EXTERNAL_IDENTITY_AUDIT_KEY_ERROR);
  }
  return new Uint8Array(createHmac('sha256', masterKey).update(EXTERNAL_IDENTITY_AUDIT_KEY_CONTEXT).digest());
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
  let cachedAuditKey: Promise<Uint8Array> | undefined;
  const getAuditKey = (): Promise<Uint8Array> => {
    cachedAuditKey ??= resolveExternalIdentityAuditKey(options.keyProvider).catch((error) => {
      cachedAuditKey = undefined;
      throw error;
    });
    return cachedAuditKey;
  };
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
  store.personalPayloads.beforePurge=(owner,by,tx)=>preserveTeamAttributions(store,objects,owner,by,tx,now);
  const authorizations = new RecordAuthorizations(db, store, now, objects);
  const vault = new FileVault(join(config.dataDir, 'vault'), options.keyProvider);
  const principals = new PgPrincipals(db, now, store, getAuditKey);
  const teams = new PgTeams(db, store, objects, principals, authorizations, now);
  const variables = new RecordVariables({ database: db, store, objects, vault, principals, authorizations, now });
  const memberDeletions=new PgMemberDeletions(db,store,store.personalPayloads,now,getAuditKey);
  memberDeletions.registerCacheRoot(join(config.dataDir,'packs','personal'));
  memberDeletions.registerCacheRoot(join(config.dataDir,'packs'),{shared:true});
  memberDeletions.registerBotFilesRoot(join(config.dataDir,'bot-runtime','files'));
  memberDeletions.registerBotFilesRoot(join(config.dataDir,'bot-runtime','channel-staging'));
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

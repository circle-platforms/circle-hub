// Candidate owner-run upgrade: strict previous-schema preview, then DDL, grants and activation in one connection transaction.
import { join } from 'node:path';
import type { RecordsConfig, Principal, User, Transaction, RecordStore, ObjectStore, AuthorizationRecord } from './api.ts';
import type { EnvironmentUpgradeSnapshot, EnvironmentUpgradePlan } from './environment-upgrade-types.ts';
import { PermissionRoleSchema } from '../../contracts/generated/vocabulary.ts';
import { canonicalBytes } from './canonical.ts';
import { sha256Hex } from './digest.ts';
import { Database, createPool, iso } from './db.ts';
import { PgRecordStore } from './store.ts';
import { FileObjectStore } from './objects.ts';
import { RecordAuthorizations } from './authorizations.ts';
import { isAdmin } from './permissions.ts';
import { AccessError, IntegrityError } from './errors.ts';
import { MIGRATIONS, migrationChecksum, verifyMigrations, migrateEnvironmentAssignments, lockRecordMigrations } from './migrations.ts';
import { EnvironmentUpgradeRequiredError, ENVIRONMENT_UPGRADE_NOTICE } from './environment-upgrade-errors.ts';
export { EnvironmentUpgradeRequiredError, ENVIRONMENT_UPGRADE_NOTICE } from './environment-upgrade-errors.ts';

const BOUNDARY = 'environment-assignment-cutover';
type Config = Pick<RecordsConfig, 'database' | 'dataDir' | 'limits'>;
export interface EnvironmentUpgradeReadContext {
  principal: Principal; members: readonly User[]; boundary: string; at: string; tx: Transaction;
  store: Pick<RecordStore, 'get' | 'find' | 'list'>; objects: Pick<ObjectStore, 'get'>;
}
export interface EnvironmentUpgradeSources {
  /** Must pass this same tx to every public read; unavailable facts reject instead of returning an empty catalog. */
  collect(context: EnvironmentUpgradeReadContext): Promise<{ snapshot: EnvironmentUpgradeSnapshot; sourceRecords: readonly string[] }>;
  plan(snapshot: EnvironmentUpgradeSnapshot): EnvironmentUpgradePlan;
}
interface Payload { snapshot: EnvironmentUpgradeSnapshot; plan: EnvironmentUpgradePlan; sourceRecords: string[]; responsibleUser: string }
export interface EnvironmentUpgradePreview {
  freshDatabase: boolean; alreadyCompleted: boolean; canApply: boolean; problems: string[];
  payload: Payload | null; sha256: string | null; minimumReaderLevel: number; downgradeNotice: string;
}
export interface EnvironmentUpgradeReceipt { freshDatabase: boolean; alreadyCompleted: boolean; grants: number; authorizationRecords: string[] }

async function schema(db: Database, tx: Transaction): Promise<boolean> {
  const exists = (await db.query<{ journal: string | null; records: string | null }>("SELECT to_regclass('public.schema_migrations')::text AS journal,to_regclass('public.records')::text AS records", [], tx)).rows[0];
  if (!exists.journal) {
    if (exists.records) throw new IntegrityError('有记录表但没有迁移回执，不能作为全新库初始化');
    return true;
  }
  const rows = (await db.query<{ version: number }>('SELECT version FROM public.schema_migrations ORDER BY version', [], tx)).rows;
  if (!rows.length) throw new IntegrityError('迁移回执为空，不能猜测为全新库');
  // This is an explicit, exact known-previous-schema reader, not an unknown-migration compatibility exception.
  await verifyMigrations(db, rows.length === 1 && rows[0].version === 1 ? [MIGRATIONS[0]] : MIGRATIONS, tx);
  return false;
}
async function users(db: Database, tx: Transaction, lock = false): Promise<User[]> {
  const rows = (await db.query('SELECT id,name,role,disabled,deleted_at,created_at,updated_at FROM public.users ORDER BY id' + (lock ? ' FOR SHARE' : ''), [], tx)).rows;
  return rows.map(row => ({ id: String(row.id), name: String(row.name), role: PermissionRoleSchema.parse(row.role), disabled: row.disabled === true,
    deleted_at: row.deleted_at === null ? null : iso(row.deleted_at), created_at: iso(row.created_at), updated_at: iso(row.updated_at) }));
}
function actor(members: readonly User[], requested: Principal): Principal {
  const current = members.find(row => row.id === requested.id);
  if (!current || current.disabled || current.deleted_at || !isAdmin(current)) throw new AccessError('缺少当前启用中的真实管理员责任，升级未执行');
  return { id: current.id, name: current.name, role: current.role };
}
async function canWrite(db: Database, tx: Transaction): Promise<boolean> {
  const row = (await db.query<{ allowed: boolean }>("SELECT pg_get_userbyid(relowner)=current_user AND has_schema_privilege(current_user,'public','CREATE') AS allowed FROM pg_class WHERE oid='public.records'::regclass", [], tx)).rows[0];
  return row?.allowed === true;
}
async function hasCarrier(db: Database, tx: Transaction): Promise<boolean> {
  return (await db.query<{ present: boolean }>("SELECT to_regclass('public.environment_assignment_cutover') IS NOT NULL AS present", [], tx)).rows[0].present;
}
async function completed(db: Database, store: RecordStore, tx: Transaction): Promise<EnvironmentUpgradeReceipt | null> {
  if (!await hasCarrier(db, tx)) return null;
  const expected = MIGRATIONS[1];
  const declaration = (await db.query('SELECT * FROM public.hub_migration_compatibility WHERE migration_version=2', [], tx)).rows[0];
  if (!declaration || declaration.format_version !== 1 || declaration.migration_name !== expected.name || declaration.migration_sha256 !== migrationChecksum(expected) || declaration.minimum_reader_level !== 2)
    throw new IntegrityError('环境权限升级兼容声明不完整或最低安全级别不符，不能启用新权限');
  const root = (await db.query('SELECT fresh_database FROM public.environment_assignment_cutover WHERE singleton=true', [], tx)).rows[0];
  if (!root) throw new IntegrityError('缺少可信升级切点来源，不能当成首次启动补授');
  if (root.fresh_database === true) return { freshDatabase: true, alreadyCompleted: true, grants: 0, authorizationRecords: [] };
  const receipt = (await db.query('SELECT c.*,s.snapshot FROM public.environment_assignment_completion c JOIN public.environment_assignment_snapshot s USING(snapshot_sha256) WHERE c.singleton=true AND s.singleton=true', [], tx)).rows[0];
  if (!receipt) return null;
  const payload = receipt.snapshot as Payload;
  if (sha256Hex(canonicalBytes(payload)) !== receipt.snapshot_sha256 || payload.responsibleUser !== receipt.responsible_user || payload.snapshot.boundary !== BOUNDARY || !payload.plan.canApply)
    throw new IntegrityError('环境保权快照或完成事实不能核对');
  const references = receipt.authorization_records as string[];
  if (!Array.isArray(references) || references.length !== payload.plan.grants.length) throw new IntegrityError('环境保权授权回执不完整');
  for (let index = 0; index < references.length; index++) {
    const grant = payload.plan.grants[index], row = await store.get<AuthorizationRecord['body']>(references[index], tx);
    if (!row || row.kind !== 'authorization' || row.body.permission !== 'resource_assign' || row.body.revoked || row.body.subject !== grant.user || row.body.object !== grant.executor || row.body.decided_by !== payload.responsibleUser || row.body.note !== grant.note)
      throw new IntegrityError('环境保权完成事实缺少对应的真实授权记录');
  }
  // Later revocations do not invalidate this one-time completion or trigger another automatic grant.
  return { freshDatabase: false, alreadyCompleted: true, grants: references.length, authorizationRecords: references };
}
function services(db: Database, config: Config) {
  const store = new PgRecordStore(db, { maxRecordBytes: config.limits.maxRecordBytes, now: () => new Date() });
  const objects = new FileObjectStore(join(config.dataDir, 'objects'), db, { maxBytes: config.limits.maxUploadBytes, now: () => new Date() });
  return { store, objects, authorizations: new RecordAuthorizations(db, store, () => new Date(), objects) };
}
async function capture(db: Database, config: Config, requested: Principal, sources: EnvironmentUpgradeSources, tx: Transaction, at: string, lock = false): Promise<Payload> {
  const members = await users(db, tx, lock), principal = actor(members, requested);
  const { store, objects } = services(db, config);
  const found = await sources.collect({ principal, members, boundary: BOUNDARY, at, tx, store: { get: store.get.bind(store), find: store.find.bind(store), list: store.list.bind(store) }, objects: { get: objects.get.bind(objects) } });
  if (found.snapshot.boundary !== BOUNDARY || found.snapshot.at !== at) throw new IntegrityError('快照来源未采用真实数据库切点');
  const identity = (rows: readonly Pick<User, 'id' | 'disabled' | 'deleted_at' | 'created_at'>[]) => rows.map(({ id, disabled, deleted_at, created_at }) => ({ id, disabled, deleted_at: deleted_at ?? null, created_at })).sort((a, b) => a.id.localeCompare(b.id));
  if (sha256Hex(canonicalBytes(identity(found.snapshot.members))) !== sha256Hex(canonicalBytes(identity(members)))) throw new IntegrityError('快照账户事实与当前数据库不一致');
  const sourceRecords = [...new Set(found.sourceRecords)].sort();
  for (const reference of sourceRecords) if (!await store.get(reference, tx)) throw new IntegrityError('保权来源原件缺失，升级未执行');
  for (const binding of found.snapshot.holdingBindings ?? []) if (!sourceRecords.includes(binding.record)) throw new IntegrityError('预订归属缺少同一快照内已核验的原始记录');
  const plan = sources.plan(found.snapshot);
  if (plan.boundary !== BOUNDARY || plan.alreadyCompleted || plan.grants.length && !sourceRecords.length) throw new IntegrityError('缺少可核验的保权来源或计划身份');
  return { snapshot: found.snapshot, sourceRecords, plan, responsibleUser: principal.id };
}

/** No DDL and no writable transaction: the previous baseline is read only after its exact receipt is verified. */
export async function previewEnvironmentAssignmentUpgrade(config: Config, by: Principal, sources: EnvironmentUpgradeSources): Promise<EnvironmentUpgradePreview> {
  const db = new Database(createPool(config.database, 1));
  try { return await db.transaction(async tx => {
    await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY', [], tx);
    const freshDatabase = await schema(db, tx);
    if (freshDatabase) return { freshDatabase: true, alreadyCompleted: false, canApply: true, problems: [], payload: null, sha256: null, minimumReaderLevel: 2, downgradeNotice: ENVIRONMENT_UPGRADE_NOTICE };
    actor(await users(db, tx), by);
    const { store } = services(db, config), done = await completed(db, store, tx);
    if (done) return { freshDatabase: done.freshDatabase, alreadyCompleted: true, canApply: false, problems: [], payload: null, sha256: null, minimumReaderLevel: 2, downgradeNotice: ENVIRONMENT_UPGRADE_NOTICE };
    if (await hasCarrier(db, tx)) throw new IntegrityError('迁移已存在但未完成保权，拒绝在启动时重新采样');
    const at = iso((await db.query('SELECT transaction_timestamp() AS at', [], tx)).rows[0].at);
    const payload = await capture(db, config, by, sources, tx, at);
    const problems = payload.plan.missing.map(row => row.fact);
    if (!await canWrite(db, tx)) problems.push('当前连接不是表拥有者，只能预览，不能执行升级');
    return { freshDatabase: false, alreadyCompleted: false, canApply: payload.plan.canApply && problems.length === 0, problems, payload, sha256: sha256Hex(canonicalBytes(payload)), minimumReaderLevel: 2, downgradeNotice: ENVIRONMENT_UPGRADE_NOTICE };
  }); } finally { await db.end(); }
}

export async function applyEnvironmentAssignmentUpgrade(config: Config, by: Principal, sources: EnvironmentUpgradeSources, expected: EnvironmentUpgradePreview): Promise<EnvironmentUpgradeReceipt> {
  const db = new Database(createPool(config.database, 1));
  try { return await db.transaction(async tx => {
    // Conflicting legacy writers need not use serializable transactions; owner-held table locks freeze their writes too.
    await lockRecordMigrations(db, tx);
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended('environment-assignment-cutover',0))", [], tx);
    const freshDatabase = await schema(db, tx), { store, authorizations } = services(db, config);
    if (!freshDatabase) {
      actor(await users(db, tx), by);
      const done = await completed(db, store, tx);
      if (done) return done;
      if (await hasCarrier(db, tx)) throw new IntegrityError('迁移已存在但完成事实不可核对，拒绝自动补授');
    }
    if (!expected.canApply || expected.alreadyCompleted) throw new EnvironmentUpgradeRequiredError('预检未完整通过，未应用迁移或授权');
    if (freshDatabase) {
      if (!expected.freshDatabase || expected.payload !== null) throw new IntegrityError('全新库与预检不一致');
      await migrateEnvironmentAssignments(db, tx);
      return { freshDatabase: true, alreadyCompleted: false, grants: 0, authorizationRecords: [] };
    }
    if (!expected.payload || expected.freshDatabase || expected.sha256 !== sha256Hex(canonicalBytes(expected.payload))) throw new IntegrityError('缺少完整保权预检快照');
    if (!await canWrite(db, tx)) throw new AccessError('当前连接不是表拥有者，升级未执行');
    await db.query('LOCK TABLE public.records,public.record_index,public.users,public.teams,public.team_members,public.leases IN SHARE ROW EXCLUSIVE MODE', [], tx);
    const current = await capture(db, config, by, sources, tx, expected.payload.snapshot.at, true);
    if (!current.plan.canApply || sha256Hex(canonicalBytes(current)) !== expected.sha256) throw new IntegrityError('切点来源或权限已改变，未应用迁移或授权，请重新核对');
    for (const grant of current.plan.grants) {
      const prior = await store.find<AuthorizationRecord['body']>({ kind: 'authorization', key: 'authz.key', value: `resource_assign|${grant.user}|${grant.executor}`, newestFirst: true, limit: 1 }, tx);
      if (prior.items.length) throw new IntegrityError('环境分配已有明确决定，自动保权不能覆盖，请重新核对');
    }
    // Only now can any M2 DDL happen. The outer transaction also contains every grant and the completion receipt.
    await migrateEnvironmentAssignments(db, tx);
    const references: string[] = [];
    for (const grant of current.plan.grants) {
      const decision = await authorizations.grant(await actorCurrent(db, tx, by), { permission: 'resource_assign', subject: grant.user, object: grant.executor, note: grant.note }, tx);
      if (decision.body.supersedes !== null) throw new IntegrityError('并发环境分配决定已改变，整次升级回滚');
      references.push(decision.digest);
    }
    await db.query('INSERT INTO public.environment_assignment_snapshot(singleton,snapshot_sha256,snapshot,responsible_user,captured_at) VALUES(true,$1,$2::jsonb,$3,$4)', [expected.sha256, JSON.stringify(current), current.responsibleUser, current.snapshot.at], tx);
    await db.query('INSERT INTO public.environment_assignment_completion(singleton,snapshot_sha256,authorization_records,responsible_user,completed_at) VALUES(true,$1,$2::jsonb,$3,transaction_timestamp())', [expected.sha256, JSON.stringify(references), current.responsibleUser], tx);
    return { freshDatabase: false, alreadyCompleted: false, grants: references.length, authorizationRecords: references };
  }); } finally { await db.end(); }
}
async function actorCurrent(db: Database, tx: Transaction, by: Principal) { return actor(await users(db, tx), by); }

/** The server must call this before constructing any active N2 guard or listener. No implicit repair or regrant. */
export async function requireEnvironmentAssignmentActivation(db: Database, store: RecordStore): Promise<void> {
  await db.transaction(async tx => {
    await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY', [], tx);
    if (!await completed(db, store, tx)) throw new EnvironmentUpgradeRequiredError();
  });
}

export async function verifyEnvironmentUpgradeOpenSchema(db: Database): Promise<void> {
  await db.transaction(async tx => {
    await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY', [], tx);
    const fresh = await schema(db, tx);
    if (!fresh && !await hasCarrier(db, tx)) throw new EnvironmentUpgradeRequiredError();
    await verifyMigrations(db, MIGRATIONS, tx);
  });
}

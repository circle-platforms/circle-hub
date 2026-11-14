// Current-schema, offline selection. No previous schema or business-data conversion is supported here.
import { RESET_DATA_SCOPE } from '../../../contracts/api.ts';
import { ResourceRecord, ResourceId, ExecutorSource } from '../../../contracts/src/resources.ts';
import { SCHEMA_REGISTRY } from '../../../contracts/src/index.ts';
import { SpaceTreeNode } from '../../../contracts/src/spaces.ts';
import { sha256Hex, canonicalize } from '../../records/api.ts';
import { quoteIdentifier, type SqlSession } from '../../platform/api.ts';
import { classifyCurrentRecord, currentRecordReferences, resolveCurrentRecordScopes, resourceDefinitionReferences, selectCurrentRecords, type CurrentRecord, type CurrentReference, type CurrentExternalRoot, type RecordSelection } from './selection.ts';
import { resetScopes, type ResetRequest, type ResetProblem, type ResetCount, type ResetDataScope } from './types.ts';

// Each whole-table choice comes from the current table's responsibility, never its spelling.
const TABLE_SCOPES: Readonly<Record<string, ResetDataScope>> = {
  users: 'config', tokens: 'config', oauth_clients: 'config', invitations: 'config', user_history: 'config',
  teams: 'config', team_members: 'config', leases: 'config', lease_registrations: 'config', member_deletion_intents: 'config',
  personal_spaces: 'config', personal_purges: 'config',
  call_logs: 'history', call_notes: 'history', call_reasons: 'history', trace_spans: 'history', resource_samples: 'history', process_events: 'history',
  knowledge_space_search: 'knowledge', knowledge_space_search_documents: 'knowledge', knowledge_space_search_ready: 'knowledge', knowledge_space_search_totals: 'knowledge',
  memory_heads: 'knowledge', memory_space_usage: 'knowledge', personal_cache_installs: 'packs',
};
const RECORD_LINKS: Readonly<Record<string, string>> = {
  records: 'digest', record_index: 'digest', record_keys: 'digest', object_holds: 'record',
  personal_record_bindings: 'record', run_originals: 'held_by', run_original_purges: 'held_by',
  run_pack_records: 'held_by', run_upload_declarations: 'run_record', held_objects: 'held_by', held_object_targets: 'held_by',
  original_targets: 'held_by', pointers: 'action_digest',
};
const SYNC_TABLES = ['personal_sync_aborts','personal_sync_bindings','personal_sync_clients','personal_sync_edges','personal_sync_exports',
  'personal_sync_heads','personal_sync_identities','personal_sync_memory_reservations','personal_sync_mode_operations','personal_sync_native_credits',
  'personal_sync_notes','personal_sync_objects','personal_sync_operations','personal_sync_retained','personal_sync_session_objects','personal_sync_sessions'];
// Migration identity and one-time cutover evidence are shared foundations, not selectable business data.
const SHARED_TABLES = ['objects','personal_payloads','personal_objects','schema_migrations',
  'hub_migration_compatibility','environment_assignment_cutover','environment_assignment_snapshot','environment_assignment_completion'];

export interface CurrentResetState { records: CurrentRecord[]; selection: RecordSelection; counts: ResetCount[]; blocked: ResetProblem[]; tables: string[]; clearTables: string[]; }
export async function tableNames(session: SqlSession): Promise<string[]> { return (await session.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).map(row => String(row.tablename)); }

function condition(table: string, state: CurrentResetState): string {
  if (state.clearTables.includes(table)) return 'true';
  const link = RECORD_LINKS[table];
  return link ? `${quoteIdentifier(link)}=ANY($1::text[])` : 'false';
}
function values(sql: string, state: CurrentResetState): unknown[] { return sql.includes('$1') ? [state.selection.cleared] : []; }
function rowObject(value: unknown): Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }

/** Exact JSON edges of retained M2 evidence; actual relational edges are checked by checkForeignKeySelection. */
async function migrationEvidenceRoots(session: SqlSession, tables: readonly string[], blocked: ResetProblem[]): Promise<CurrentExternalRoot[]> {
  const roots: CurrentExternalRoot[] = [];
  const references = (value: unknown, field: string): CurrentReference[] | null => Array.isArray(value) && value.every(digest => typeof digest === 'string' && /^[0-9a-f]{64}$/.test(digest))
    ? value.map((digest, index) => ({ kind: 'record', digest, field: field + '/' + index, recordAlias: false })) : null;
  if (tables.includes('environment_assignment_snapshot')) {
    const rows = await session.query('SELECT snapshot_sha256,snapshot,responsible_user FROM public.environment_assignment_snapshot ORDER BY singleton');
    rows.forEach((row, index) => {
      const payload = rowObject(row.snapshot), edges = references(payload.sourceRecords, '/snapshot/sourceRecords');
      let intact = false;
      try { intact = sha256Hex(canonicalize(payload)) === row.snapshot_sha256 && payload.responsibleUser === row.responsible_user; } catch { /* Invalid evidence blocks below. */ }
      if (!edges || !intact) blocked.push({ table: 'environment_assignment_snapshot', row: index + 1,
        reason: '保留的迁移快照 sourceRecords、摘要或 responsible_user 来源不能核对', nextAction: '核对原保权来源后重试，或显式选择全部初始化；程序不会改写保留证据' });
      else roots.push({ table: 'environment_assignment_snapshot', row: index + 1, references: edges });
    });
  }
  if (tables.includes('environment_assignment_completion')) {
    const rows = await session.query('SELECT authorization_records FROM public.environment_assignment_completion ORDER BY singleton');
    rows.forEach((row, index) => {
      const edges = references(row.authorization_records, '/authorization_records');
      if (!edges) blocked.push({ table: 'environment_assignment_completion', row: index + 1,
        reason: '保留的完成事实 authorization_records 不是已核对的记录引用数组', nextAction: '核对原完成回执后重试，或显式选择全部初始化；程序不会跳过保留依赖' });
      else roots.push({ table: 'environment_assignment_completion', row: index + 1, references: edges });
    });
  }
  return roots;
}

export async function inspectCurrentState(session: SqlSession, request: ResetRequest, readObject: (hash: string) => Promise<Uint8Array | null>): Promise<CurrentResetState> {
  const tables = await tableNames(session);
  const selectedScopes = new Set(resetScopes(request));
  if (request.keepConfig) selectedScopes.delete('config');
  const rows = await session.query(`WITH logical AS MATERIALIZED (SELECT DISTINCT ON (digest) digest,body FROM hub_read_records())
    SELECT r.digest,r.kind,r.schema,coalesce(l.body,r.body) AS body FROM records r LEFT JOIN logical l ON l.digest=r.digest ORDER BY r.seq`);
  const index = await session.query('SELECT digest,key,value FROM record_index ORDER BY record_seq');
  const indices = new Map<string, Array<{ key: string; value: string }>>();
  const aliases = new Map<string, string>();
  for (const row of index) {
    const list = indices.get(String(row.digest)) ?? []; list.push({ key: String(row.key), value: String(row.value) }); indices.set(String(row.digest), list);
    if (['knowledge.node','knowledge.entry','knowledge.root','pack.digest'].includes(String(row.key))) aliases.set(String(row.value), String(row.digest));
  }
  const records: CurrentRecord[] = rows.map(row => ({ digest: String(row.digest), kind: String(row.kind), schema: String(row.schema), body: JSON.parse(String(row.body)), indices: indices.get(String(row.digest)) ?? [] } as CurrentRecord));
  const byDigest = new Map(records.map(record => [record.digest, record]));
  const holds = await session.query('SELECT record,sha256,artifact FROM object_holds');
  for (const row of holds) {
    const record = byDigest.get(String(row.record)); if (!record) continue;
    record.references = [...record.references ?? [], { kind: row.artifact === true ? 'record' : 'object', digest: String(row.sha256), field: 'object_holds' }];
  }
  const objectScopes = new Map<string, readonly ResetDataScope[]>(), objectReferences = new Map<string, readonly CurrentReference[]>();
  for (const row of await session.query('SELECT sha256 FROM objects')) {
    objectScopes.set(String(row.sha256), []);
    objectReferences.set(String(row.sha256), []); // Immutable object bytes are retained; typed containers below add their formal edges.
  }
  const blocked: ResetProblem[] = [];
  for (const [position, record] of records.entries()) {
    if (record.kind !== 'authorization') continue;
    const body = rowObject(record.body);
    if (body.permission !== 'resource_config' || body.revoked || typeof body.bound !== 'string') continue;
    if (ResourceId.safeParse(body.object).success || typeof body.object === 'string' && /^executor\.exe_[0-9a-hjkmnp-tv-z]{26}$/.test(body.object)) {
      try {
        const bytes = await readObject(body.bound); if (!bytes || sha256Hex(bytes) !== body.bound) throw new Error();
        const value = JSON.parse(Buffer.from(bytes).toString('utf8'));
        const parsed = ResourceId.safeParse(body.object).success ? ResourceRecord.parse(value) : ExecutorSource.parse(value);
        const resource = rowObject(parsed);
        if (ResourceId.safeParse(body.object).success) { const edges = resourceDefinitionReferences(parsed); if (edges === null) throw new Error(); objectReferences.set(body.bound, edges); }
      } catch { blocked.push({ table: 'records', row: position + 1, reason: '配置定义的当前模式或对象身份不能核对', nextAction: '恢复当前定义对象后重试；程序不会猜测引用' }); }
    }
  }
  const retainedObjects = new Set(objectScopes.keys());
  const addOwner = (hash: string, scope: ResetDataScope) => objectScopes.set(hash, [...new Set([...objectScopes.get(hash) ?? [], scope])]);
  for (const record of records) {
    const scope = classifyCurrentRecord(record);
    if (scope) for (const reference of currentRecordReferences(record)) if (reference.kind === 'object') addOwner(reference.digest, scope);
  }
  const recordOwners = resolveCurrentRecordScopes(records, { recordAliases: aliases, objectScopes, objectReferences, retainedObjects });
  for (const record of records) for (const scope of recordOwners.get(record.digest) ?? []) {
    for (const reference of currentRecordReferences(record)) if (reference.kind === 'object') addOwner(reference.digest, scope);
  }
  const externalRoots = await migrationEvidenceRoots(session, tables, blocked);
  const selection = selectCurrentRecords(records, selectedScopes, { recordAliases: aliases, objectScopes, objectReferences, retainedObjects, externalRoots });
  blocked.push(...selection.blocked);
  const counts = RESET_DATA_SCOPE.map(scope => ({ scope, retained: 0, cleared: 0 }));
  const clearedSet = new Set(selection.cleared);
  records.forEach(record => {
    for (const scope of recordOwners.get(record.digest) ?? []) {
      const count = counts.find(count => count.scope === scope)!;
      if (clearedSet.has(record.digest)) count.cleared++; else count.retained++;
    }
  });
  const clearTables = tables.filter(table => TABLE_SCOPES[table] && selectedScopes.has(TABLE_SCOPES[table]!));
  const sync = tables.filter(table => SYNC_TABLES.includes(table));
  if (selectedScopes.has('knowledge') || selectedScopes.has('packs')) {
    let occupied = false;
    for (const table of sync) { const [row] = await session.query(`SELECT EXISTS(SELECT 1 FROM ${quoteIdentifier(table)}) AS occupied`); occupied ||= row?.occupied === true; }
    if (occupied) blocked.push({ table: 'personal_sync_heads', reason: '当前个人同步状态可能共享知识与个人包，尚无已核对的选择性失效方案', nextAction: '选择全部归档初始化，或先完成个人同步保留图的当前模式核对；程序不按账户整批清除' });
  }
  for (const table of tables) if (!TABLE_SCOPES[table] && !RECORD_LINKS[table] && !SYNC_TABLES.includes(table) && !SHARED_TABLES.includes(table)) blocked.push({ table, reason: '当前表没有明确的范围责任，不能部分清除', nextAction: '补充当前表的正式范围规则，或选择全部归档初始化' });
  for (const table of tables) if (TABLE_SCOPES[table]) {
    const [row] = await session.query(`SELECT count(*)::text AS n FROM ${quoteIdentifier(table)}`);
    const count = counts.find(count => count.scope === TABLE_SCOPES[table])!;
    if (clearTables.includes(table)) count.cleared += Number(row!.n); else count.retained += Number(row!.n);
  }
  const state = { records, selection, counts, blocked, tables, clearTables };
  await checkForeignKeySelection(session, state);
  return state;
}

/** Existing FK constraints are facts. A retained child pointing at a cleared parent blocks before service stop. */
export async function checkForeignKeySelection(session: SqlSession, state: CurrentResetState): Promise<void> {
  const keys = await session.query(`SELECT c.conrelid::regclass::text AS child,c.confrelid::regclass::text AS parent,
    ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY x(attnum,n) JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=x.attnum ORDER BY x.n) AS child_columns,
    ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY x(attnum,n) JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=x.attnum ORDER BY x.n) AS parent_columns
    FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE c.contype='f' AND n.nspname='public'`);
  for (const key of keys) {
    const child = String(key.child).replace(/^public\./, ''), parent = String(key.parent).replace(/^public\./, '');
    if (!state.tables.includes(child) || !state.tables.includes(parent)) { state.blocked.push({ table: child, reason: '外键跨越未声明的表边界', nextAction: '核对当前外键后重试' }); continue; }
    const parentWhere = condition(parent, state), childWhere = condition(child, state);
    if (parentWhere === 'false') continue;
    const left = key.child_columns as string[], right = key.parent_columns as string[];
    const join = left.map((column, i) => `c.${quoteIdentifier(column)}=p.${quoteIdentifier(right[i]!)}`).join(' AND ');
    const parentPredicate = parentWhere.replaceAll(/"([^"]+)"/g, 'p."$1"');
    const childPredicate = childWhere.replaceAll(/"([^"]+)"/g, 'c."$1"');
    const sql = `SELECT count(*)::text AS n FROM ${quoteIdentifier(child)} c JOIN ${quoteIdentifier(parent)} p ON ${join} WHERE (${parentPredicate}) AND NOT (${childPredicate})`;
    const [row] = await session.query(sql, sql.includes('$1') ? [state.selection.cleared] : []);
    if (Number(row!.n)) state.blocked.push({ table: child, reason: `保留行有 ${Number(row!.n)} 条实际外键 ${child}.${left.join(",")} → ${parent}.${right.join(",")} 指向所清范围`, nextAction: '显式调整范围或保留配置；程序不会连带清除保留行' });
  }
}

/** Only an owner connection to the offline clone may call this. Runtime grants and the baseline never change. */
export async function clearOfflineSelection(session: SqlSession, state: CurrentResetState): Promise<void> {
  if (state.blocked.length) throw new Error('当前选择仍有未闭合的引用，不执行清除');
  await session.query('BEGIN');
  try {
    await session.query("SET LOCAL session_replication_role='replica'");
    for (const table of state.tables) {
      const where = condition(table, state);
      if (where !== 'false') await session.query(`DELETE FROM ${quoteIdentifier(table)} WHERE ${where}`, values(where, state));
    }
    await session.query('COMMIT');
  } catch { await session.query('ROLLBACK'); throw new Error('离线重建未完成；目标约束或权限拒绝操作，原库未改'); }
}

/** Check all actual composite foreign keys after constructing the offline destination, without disabling runtime checks. */
export async function assertCurrentForeignKeys(session: SqlSession): Promise<void> {
  const keys = await session.query(`SELECT child.relname AS child,parent.relname AS parent,
    ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY x(attnum,n) JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=x.attnum ORDER BY x.n) AS child_columns,
    ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY x(attnum,n) JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=x.attnum ORDER BY x.n) AS parent_columns
    FROM pg_constraint c JOIN pg_class child ON child.oid=c.conrelid JOIN pg_class parent ON parent.oid=c.confrelid JOIN pg_namespace n ON n.oid=c.connamespace
    WHERE c.contype='f' AND n.nspname='public'`);
  for (const key of keys) {
    const child = String(key.child), parent = String(key.parent), left = key.child_columns as string[], right = key.parent_columns as string[];
    const join = left.map((column, index) => `c.${quoteIdentifier(column)}=p.${quoteIdentifier(right[index]!)}`).join(' AND ');
    const nonNull = left.map(column => `c.${quoteIdentifier(column)} IS NOT NULL`).join(' AND ');
    const [row] = await session.query(`SELECT count(*)::text AS n FROM ${quoteIdentifier(child)} c LEFT JOIN ${quoteIdentifier(parent)} p ON ${join} WHERE ${nonNull} AND p.${quoteIdentifier(right[0]!)} IS NULL`);
    if (Number(row!.n)) throw new Error('重建后的实际外键未闭合，不能启用服务');
  }
}

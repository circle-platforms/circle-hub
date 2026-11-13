import { quoteIdentifier, type SqlSession } from '../sql.ts';
import { expandSpaceObjectGraph } from './object-graph.ts';
import { canonicalOldBody, selectState, type OldRecord, type Selection, type UpgradeIssue } from './state.ts';

// Exhaustive predecessor table inventory; every table is accounted for before a row is copied.
export const COPIED_TABLES = [
  'users', 'oauth_clients', 'tokens', 'user_history', 'invitations', 'objects',
  'personal_spaces', 'personal_purges', 'member_deletion_intents',
  'personal_sync_heads', 'personal_sync_bindings', 'personal_sync_notes', 'personal_sync_native_credits',
  'personal_sync_exports', 'personal_sync_memory_reservations', 'personal_sync_identities',
  'personal_sync_clients', 'personal_sync_objects', 'personal_sync_edges', 'personal_sync_retained',
  'memory_heads', 'memory_space_usage', 'lease_registrations',
] as const;
export const FILTERED_TABLES = [
  'records', 'record_index', 'record_keys', 'personal_record_bindings', 'personal_objects', 'personal_payloads',
  'pointers', 'leases', 'object_holds', 'held_objects', 'held_object_targets', 'original_targets', 'run_originals', 'run_original_purges',
] as const;
export const ARCHIVED_TABLES = [
  'call_logs', 'call_notes', 'call_reasons', 'run_pack_records',
  'run_upload_declarations', 'trace_spans', 'resource_samples', 'process_events',
  'personal_legacy_candidates', 'personal_legacy_ready', 'personal_legacy_retire', 'personal_legacy_retired',
  'personal_sync_sessions', 'personal_sync_session_objects', 'personal_sync_aborts',
  'personal_sync_operations', 'personal_sync_mode_operations',
] as const;
export const REBUILT_TABLES = ['schema_migrations', 'knowledge_space_search', 'knowledge_space_search_documents', 'knowledge_space_search_ready', 'knowledge_space_search_totals', 'personal_cache_installs'] as const;

export interface TableCount { table: string; original: number; migrated: number; archived: number; }
export interface TransferPlan {
  selection: Selection;
  tables: TableCount[];
  issues: UpgradeIssue[];
}
export class StateTransferFailure extends Error {
  readonly issues: readonly UpgradeIssue[];
  constructor(issues: readonly UpgradeIssue[]) {
    super('状态迁移未完成，已保留逐条原因'); this.name = 'StateTransferFailure'; this.issues = issues;
  }
}

export async function predecessorTables(source: SqlSession): Promise<string[]> {
  const rows = await source.query("SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname='public' ORDER BY tablename");
  const tables = rows.map(row => String(row.tablename));
  const expected = [...COPIED_TABLES, ...FILTERED_TABLES, ...ARCHIVED_TABLES, ...REBUILT_TABLES].sort();
  if (tables.length !== expected.length || tables.some((table, i) => table !== expected[i])) throw new StateTransferFailure([{ table: 'schema', row: 0, reason: '旧表集合与已审查的上个发行不同' }]);
  return tables;
}

export async function readState(source: SqlSession, readObject: (hash: string) => Promise<Uint8Array | null>): Promise<TransferPlan> {
  const tables = await predecessorTables(source);
  const records: OldRecord[] = [];
  const issues: UpgradeIssue[] = [];
  // Archive-only envelopes are counted without fetching their bodies. Token rows contain hashes only.
  const metadata = await source.query('SELECT seq::text,id,digest,kind,schema,provenance,created_at FROM records ORDER BY seq');
  const active = await source.query(`SELECT seq::text,id,digest,kind,schema,provenance,created_at,body FROM hub_read_records()
    WHERE kind <> ALL($1::text[]) ORDER BY seq`,
    [['run','submission','validation_result','request','call_log','effect','result_summary','token_issuance','action','source_artifact']]);
  const hydrated = new Map(active.map(row => [String(row.digest), row]));
  for (const [index, row] of metadata.entries()) {
    let body: unknown = undefined;
    const logical = hydrated.get(String(row.digest));
    if (logical) {
      try { body = canonicalOldBody(String(logical.body)); }
      catch { issues.push({ table: 'records', row: index + 1, reason: '旧状态正文不是完整的规范JSON' }); }
    }
    records.push({ seq: String(row.seq), id: String(row.id), digest: String(row.digest), kind: String(row.kind), schema: String(row.schema), provenance: String(row.provenance), created_at: (row.created_at as Date).toISOString(), body });
  }
  const objectRows = await source.query('SELECT sha256 FROM objects');
  const objects = new Set(objectRows.map(row => String(row.sha256)));
  const aliasRows = await source.query("SELECT value,digest FROM record_index WHERE key=ANY($1::text[]) ORDER BY record_seq", [['knowledge.node','knowledge.entry','knowledge.root']]);
  const aliases = new Map<string, string[]>();
  for (const row of aliasRows) { const list = aliases.get(String(row.value)) ?? []; list.push(String(row.digest)); aliases.set(String(row.value), list); }
  const cleared = await source.query(`SELECT b.record FROM personal_record_bindings b JOIN personal_purges p ON (p.owner,p.epoch)=(b.owner,b.epoch)
    WHERE NOT EXISTS(SELECT 1 FROM run_originals h WHERE h.artifact=b.record) AND NOT EXISTS(SELECT 1 FROM run_pack_records k WHERE k.record=b.record)`);
  const purged = new Set(cleared.map(row => String(row.record)));
  const sourceIndex = await source.query("SELECT value,digest FROM record_index WHERE key='artifact.sha256' ORDER BY record_seq");
  const sourceAliases = new Map<string, string[]>();
  for (const row of sourceIndex) if (!purged.has(String(row.digest))) { const values = sourceAliases.get(String(row.value)) ?? []; values.push(String(row.digest)); sourceAliases.set(String(row.value), values); }
  let selection = selectState(records, objects, aliases, purged, sourceAliases);
  const attempted = new Set<string>();
  while (selection.unhydrated.size) {
    const needed = [...selection.unhydrated].filter(hash => !attempted.has(hash));
    if (!needed.length) break;
    needed.forEach(hash => attempted.add(hash));
    const logical = await source.query('SELECT digest,body FROM hub_read_records() WHERE digest=ANY($1::text[])', [needed]);
    for (const row of logical) {
      const record = records.find(record => record.digest === row.digest)!;
      try { record.body = canonicalOldBody(String(row.body)); }
      catch { issues.push({ table: 'records', row: records.indexOf(record) + 1, reason: '引用的原件或动作不能按旧规范读取' }); }
    }
    selection = selectState(records, objects, aliases, purged, sourceAliases);
  }
  for (const hash of selection.unhydrated) issues.push({ table: 'records', row: records.findIndex(record => record.digest === hash) + 1, reason: '状态引用的原件或动作正文缺失' });
  issues.push(...selection.issues);
  issues.push(...await expandSpaceObjectGraph(records, selection.selected, selection.objects, readObject));
  const counts: TableCount[] = [];
  for (const table of tables) {
    const [row] = await source.query(`SELECT count(*)::text AS n FROM ${quoteIdentifier(table)}`);
    counts.push({ table, original: Number(row!.n), migrated: 0, archived: Number(row!.n) });
  }
  return { selection, tables: counts, issues };
}

/** Conditions are fixed program text and parameterized ids; no authored SQL, identifiers or expression is accepted. */
function predicate(table: string): string {
  if (table === 'records' || table === 'record_index' || table === 'record_keys') return 'digest=ANY($1::text[])';
  if (table === 'personal_record_bindings' || table === 'object_holds') return 'record=ANY($1::text[])';
  if (['original_targets', 'run_originals', 'run_original_purges'].includes(table)) return 'artifact=ANY($1::text[]) AND held_by=ANY($1::text[])';
  if (table === 'held_object_targets' || table === 'held_objects') return 'sha256=ANY($2::text[]) AND held_by=ANY($1::text[])';
  if (table === 'pointers') return 'true';
  if (table === 'leases') return 'true';
  if (table === 'personal_objects' || table === 'personal_payloads') return 'sha256=ANY($2::text[])';
  return 'true';
}

async function columns(session: SqlSession, table: string): Promise<string[]> {
  return (await session.query("SELECT attname FROM pg_catalog.pg_attribute WHERE attrelid=to_regclass($1) AND attnum>0 AND NOT attisdropped ORDER BY attnum", ['public.' + quoteIdentifier(table)])).map(row => String(row.attname));
}

/** Import preserves IDs, sequences, hashes and capsule bytes. Only newly created destination tables are written. */
export async function transferState(source: SqlSession, destination: SqlSession, plan: TransferPlan): Promise<void> {
  if (plan.issues.length) throw new StateTransferFailure(plan.issues);
  const selected = [...plan.selection.selected];
  const bindings = await source.query('SELECT sha256 FROM personal_record_bindings WHERE record=ANY($1::text[])', [selected]);
  const syncObjects = await source.query('SELECT id AS sha256 FROM personal_sync_objects UNION SELECT payload FROM personal_sync_notes UNION SELECT name_payload FROM personal_sync_clients');
  const objectIds = [...new Set([...plan.selection.objects, ...[...bindings, ...syncObjects].map(row => String(row.sha256))])];
  const wanted = [...COPIED_TABLES, ...FILTERED_TABLES];
  const tableSet = new Set<string>(wanted);
  const edges = await destination.query(`SELECT child.relname AS child,parent.relname AS parent FROM pg_constraint c
    JOIN pg_class child ON child.oid=c.conrelid JOIN pg_class parent ON parent.oid=c.confrelid
    JOIN pg_namespace n ON n.oid=child.relnamespace WHERE c.contype='f' AND n.nspname='public'`);
  const sorted: string[] = [], visiting = new Set<string>(), done = new Set<string>();
  const visit = (table: string) => {
    if (done.has(table)) return;
    if (visiting.has(table)) throw new StateTransferFailure([{ table, row: 0, reason: '状态表的外键依赖有环，不能自行绕过约束' }]);
    visiting.add(table);
    for (const edge of edges) if (edge.child === table && edge.parent !== table && tableSet.has(String(edge.parent))) visit(String(edge.parent));
    visiting.delete(table); done.add(table); sorted.push(table);
  };
  wanted.forEach(visit);
  for (const session of [source, destination]) {
    await session.query("SET TimeZone TO 'UTC'");
    await session.query("SET DateStyle TO 'ISO, YMD'");
    await session.query("SET IntervalStyle TO 'postgres'");
    await session.query('SET extra_float_digits TO 1');
    await session.query("SET bytea_output TO 'hex'");
  }
  await destination.query('BEGIN');
  try {
    for (const table of sorted) await destination.query(`ALTER TABLE ${quoteIdentifier(table)} DISABLE TRIGGER USER`);
    for (const table of sorted) {
      const fromColumns = await columns(source, table), toColumns = await columns(destination, table);
      if (fromColumns.length !== toColumns.length || fromColumns.some((col, i) => col !== toColumns[i])) throw new StateTransferFailure([{ table, row: 0, reason: '保留表的列形状不同，未声明转换' }]);
      const names = toColumns.map(quoteIdentifier).join(',');
      const where = predicate(table);
      const both = where.includes('$1') && where.includes('$2');
      const params = both ? [selected, objectIds] : where.includes('$2') ? [objectIds] : where.includes('$1') ? [selected] : [];
      const selectionWhere = both ? where : where.replaceAll('$2', '$1');
      // The cursor bounds memory and keeps values out of SQL text and diagnostic output.
      const selectedColumns = toColumns.map(column => `${quoteIdentifier(column)}::text AS ${quoteIdentifier(column)}`).join(',');
      const fingerprint = (alias: string) => `encode(sha256(convert_to(ROW(${alias}.*)::text,'UTF8')),'hex')`;
      await source.query(`DECLARE upgrade_rows NO SCROLL CURSOR FOR SELECT ${selectedColumns},${fingerprint('t')} AS upgrade_fingerprint FROM ${quoteIdentifier(table)} t WHERE ${selectionWhere}`, params);
      let count = 0;
      try {
        for (;;) {
          const batch = await source.query('FETCH FORWARD 128 FROM upgrade_rows');
          if (!batch.length) break;
          const insert = async (rows: Record<string, unknown>[]) => {
            const values = rows.flatMap(row => toColumns.map(column => row[column]));
            const groups = rows.map((_, offset) => '(' + toColumns.map((_, index) => '$' + (offset * toColumns.length + index + 1)).join(',') + ')').join(',');
            const result = await destination.query(`INSERT INTO ${quoteIdentifier(table)} (${names}) OVERRIDING SYSTEM VALUE VALUES ${groups} RETURNING ${fingerprint(quoteIdentifier(table))} AS upgrade_fingerprint`, values);
            const expected = rows.map(row => String(row.upgrade_fingerprint)).sort();
            const actual = result.map(row => String(row.upgrade_fingerprint)).sort();
            if (expected.length !== actual.length || expected.some((hash, index) => hash !== actual[index])) throw new Error('行身份不同');
          };
          await destination.query('SAVEPOINT upgrade_batch');
          try { await insert(batch); }
          catch {
            await destination.query('ROLLBACK TO SAVEPOINT upgrade_batch');
            for (let index = 0; index < batch.length; index++) {
              try { await insert([batch[index]!]); }
              catch { throw new StateTransferFailure([{ table, row: count + index + 1, reason: '目标约束或行身份核对拒绝此行，未输出行内容或原始数据库错误' }]); }
            }
          }
          await destination.query('RELEASE SAVEPOINT upgrade_batch');
          count += batch.length;
        }
      } finally { await source.query('CLOSE upgrade_rows'); }
      const tally = plan.tables.find(row => row.table === table)!;
      tally.migrated = count; tally.archived = tally.original - count;
      const sequenceColumns = await destination.query("SELECT a.attname FROM pg_attribute a WHERE a.attrelid=to_regclass($1) AND a.attidentity<>''", ['public.' + quoteIdentifier(table)]);
      for (const row of sequenceColumns) {
        const column = String(row.attname);
        await destination.query(`SELECT setval(pg_get_serial_sequence($1,$2),coalesce(max(${quoteIdentifier(column)}),1),count(*)>0) FROM ${quoteIdentifier(table)}`, ['public.' + quoteIdentifier(table), column]);
      }
    }
    for (const table of sorted) await destination.query(`ALTER TABLE ${quoteIdentifier(table)} ENABLE TRIGGER USER`);
    await destination.query('COMMIT');
  } catch (error) { await destination.query('ROLLBACK'); throw error; }
}

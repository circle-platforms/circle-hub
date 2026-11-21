// The shape of a replay bundle (replay-bundle@1), shared by the program that writes one from a Hub database
// (submissions-export.ts, which needs nothing of the Hub but PostgreSQL's client) and the one that loads one (submissions-bundle.ts).
//
//   manifest.json            what the bundle is: cutoff position, the runs it was scoped to, row counts, what was left out and why
//   tables/<name>.jsonl      one JSON object per row (row_to_json), `records` in append order
//   objects/<ab>/<sha256>    the bytes of a stored object, named by their SHA-256
//
// Nothing here names a product, a command or a customer; what is exported is decided by the table policy below and by the
// runs the caller names.

export const BUNDLE_SCHEMA = 'replay-bundle@1';

/** The run-family kinds: only those of the runs the bundle is scoped to are exported (the others are other people's work). */
export const RUN_FAMILY_KINDS: readonly string[] = ['run', 'submission', 'validation_result', 'result_summary'];
/** Kinds nothing in a validation reads and that are large: the call log. */
export const EXCLUDED_KINDS: readonly string[] = ['call_log'];

export type TablePolicy =
  | { how: 'records' | 'index' | 'keys' | 'objects' }
  | { how: 'full'; columns?: readonly string[]; why: string };

/**
 * Which tables go into a bundle and how. A table that is not here is not exported, and the manifest says so; so a new table
 * of the Hub is never silently exported or silently missed.
 */
export const TABLE_POLICY: Readonly<Record<string, TablePolicy>> = {
  records: { how: 'records' },
  record_index: { how: 'index' },
  record_keys: { how: 'keys' },
  objects: { how: 'objects' },
  pointers: { how: 'full', why: 'the current-root pointers a reader without a locked composition consults' },
  // The password hash never leaves the Hub.
  users: { how: 'full', columns: ['id', 'name', 'role', 'disabled', 'created_at', 'updated_at', 'password_must_change', 'password_revision', 'deleted_at'], why: 'the principal a run belongs to' },
  run_upload_declarations: { how: 'full', why: 'uploads declared to the readers of a run' },
  object_holds: { how: 'full', why: 'which records hold which objects (derived by a trigger the loader does not fire)' },
  held_object_targets: { how: 'full', why: 'where held bytes belong (no bytes)' },
  original_targets: { how: 'full', why: 'where run-held originals belong (no bytes)' },
};

/** Tables with bytes or secrets that are never exported, with the reason, for the manifest. */
export const WITHHELD_TABLES: Readonly<Record<string, string>> = {
  tokens: '令牌的摘要（凭据）',
  invitations: '邀请码',
  oauth_clients: '客户端登记',
  held_objects: '被扣留的原件字节（可能含凭据）',
  run_originals: '运行持有的原件字节',
  run_pack_records: '运行持有的个人包记录正文',
  personal_payloads: '个人空间字节',
  personal_objects: '个人空间字节',
  call_logs: '调用日志（遥测）',
  call_notes: '调用说明（遥测）',
  call_reasons: '调用原因（遥测）',
  trace_spans: '追踪（遥测）',
  resource_samples: '资源采样（遥测）',
  process_events: '进程事件（遥测）',
};

export interface BundleManifest {
  schema: typeof BUNDLE_SCHEMA;
  created_at: string;
  /** Free text: where the data came from. */
  source: string;
  /** The highest append position exported. */
  cutoff_seq: number;
  /** The runs the run-family records were scoped to (the requested ones and the runs they name). */
  runs: string[];
  tables: Record<string, { rows: number; file: string }>;
  /** Rows per record kind in tables/records.jsonl. */
  kinds: Record<string, number>;
  objects: { count: number; bytes: number; missing: string[] };
  withheld: Array<{ table: string; reason: string }>;
  notes: string[];
}

export interface BundleRow { [column: string]: unknown }

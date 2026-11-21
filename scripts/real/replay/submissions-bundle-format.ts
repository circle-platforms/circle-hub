export const BUNDLE_SCHEMA = 'replay-bundle@1';

export const RUN_FAMILY_KINDS: readonly string[] = ['run', 'submission', 'validation_result', 'result_summary'];
export const EXCLUDED_KINDS: readonly string[] = ['call_log'];

export type TablePolicy =
  | { how: 'records' | 'index' | 'keys' | 'objects' }
  | { how: 'full'; columns?: readonly string[]; why: string };

export const TABLE_POLICY: Readonly<Record<string, TablePolicy>> = {
  records: { how: 'records' },
  record_index: { how: 'index' },
  record_keys: { how: 'keys' },
  objects: { how: 'objects' },
  pointers: { how: 'full', why: 'the current-root pointers a reader without a locked composition consults' },
  users: { how: 'full', columns: ['id', 'name', 'role', 'disabled', 'created_at', 'updated_at', 'password_must_change', 'password_revision', 'deleted_at'], why: 'the principal a run belongs to' },
  run_upload_declarations: { how: 'full', why: 'uploads declared to the readers of a run' },
  object_holds: { how: 'full', why: 'which records hold which objects (derived by a trigger the loader does not fire)' },
  held_object_targets: { how: 'full', why: 'where held bytes belong (no bytes)' },
  original_targets: { how: 'full', why: 'where run-held originals belong (no bytes)' },
};

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
  source: string;
  cutoff_seq: number;
  runs: string[];
  tables: Record<string, { rows: number; file: string }>;
  kinds: Record<string, number>;
  objects: { count: number; bytes: number; missing: string[] };
  withheld: Array<{ table: string; reason: string }>;
  notes: string[];
}

export interface BundleRow { [column: string]: unknown }

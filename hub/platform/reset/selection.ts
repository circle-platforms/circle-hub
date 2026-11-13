// Current-schema reset ownership. Unknown shapes block a reset instead of acquiring a default scope.
import { RECORD_KINDS, type RecordKind } from '../../../contracts/generated/protocol.ts';
import { ActionKindSchema, LeaseOpSchema, PermissionKindSchema } from '../../../contracts/generated/vocabulary.ts';
import { SCHEMA_REGISTRY } from '../../../contracts/src/index.ts';
import { FEEDING_SCHEMAS } from '../../../contracts/src/feeding.ts';
import type { ResetProblem, ResetScope } from './types.ts';

export interface CurrentReference { kind: 'record' | 'object'; digest: string; field: string }
export interface CurrentRecord {
  digest: string;
  kind: string;
  schema: string;
  body: unknown;
  /** Additional formal edges resolved by the current schema's reader, never strings found in prose. */
  references?: readonly CurrentReference[];
}
export interface SelectionOptions {
  /** A content-addressed node/entry digest to its actual records.digest. */
  recordAliases?: ReadonlyMap<string, string>;
  /** Scopes with a current, verified holder of these exact object bytes. */
  objectScopes?: ReadonlyMap<string, readonly ResetScope[]>;
  /** Explicit empty lists are required for raw objects with no formal internal references. */
  objectReferences?: ReadonlyMap<string, readonly CurrentReference[]>;
}
export interface RecordSelection { retained: string[]; cleared: string[]; blocked: ResetProblem[] }
type Body = Record<string, unknown>;
type Classifier = (record: CurrentRecord, body: Body) => ResetScope | null;
const object = (value: unknown): Body | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Body : null;
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
const sha256 = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

function fixed(scope: ResetScope, ...schemas: string[]): Classifier {
  return record => schemas.includes(record.schema) ? scope : null;
}

function classifyAuthorization(record: CurrentRecord, body: Body): ResetScope | null {
  if (record.schema !== 'authorization@1' || !PermissionKindSchema.safeParse(body.permission).success) return null;
  return body.permission === 'publish' ? 'packs' : 'config';
}

function classifyClaim(record: CurrentRecord, body: Body): ResetScope | null {
  if (['knowledge-build@1', 'knowledge-calibration@1', 'knowledge-observation@1', 'knowledge-contribution@1', 'seedling@1'].includes(record.schema)) return 'knowledge';
  if (record.schema === 'hypothesis-set@1') return typeof body.question === 'string' && Array.isArray(body.hypotheses) ? 'history' : null;
  if (record.schema === 'feeding-offset@1') return 'history';
  if (record.schema !== 'claim@1') return null;
  const feeding = object(object(object(body.statement)?.data)?.feeding);
  const schema = feeding?.schema;
  if (typeof schema !== 'string') return null;
  const shape = FEEDING_SCHEMAS[schema as keyof typeof FEEDING_SCHEMAS];
  if (!shape?.safeParse(feeding).success) return null;
  return schema === 'usage@1' ? 'history' : 'knowledge';
}

// Exact component identities emitted by the current writers; a new component needs an ownership decision.
const ACTION_COMPONENTS: Readonly<Record<string, ResetScope>> = {
  'runs.engine@1': 'history', 'dispatch@1': 'history', 'requests@1': 'history', 'criterion-change@1': 'history',
  'skill@1': 'history',
  'knowledge.produce@1': 'knowledge', 'knowledge.sync@1': 'knowledge', 'knowledge.placement@1': 'knowledge',
  'knowledge.calibration@1': 'knowledge', 'knowledge.producer@1': 'knowledge', 'knowledge.sources@1': 'knowledge',
  'knowledge.views@1': 'knowledge', 'knowledge.seedling@1': 'knowledge', 'hub.feeding@1': 'knowledge',
  'hub.feeding@2': 'knowledge', 'server.docs@1': 'knowledge', 'connectors@1': 'knowledge',
};
function classifyAction(record: CurrentRecord, body: Body): ResetScope | null {
  if (['memory-refusal@1', 'memory-unchanged@1', 'personal-sync-mode@1', 'personal-sync-commit@1',
    'personal-sync-purge-request@1', 'personal-sync-http-audit@1'].includes(record.schema)) return 'knowledge';
  if (record.schema === 'mcp-client-declaration@1') return 'history';
  if (record.schema === 'trial-report@1') return body.action === 'trial' ? 'history' : null;
  if (record.schema !== 'action@1' || !ActionKindSchema.safeParse(body.action).success || typeof body.component !== 'string') return null;
  if (body.component === 'leases@1') {
    const op = object(body.detail)?.op;
    if (!LeaseOpSchema.safeParse(op).success) return null;
    return op === 'register' || op === 'unregister' ? 'config' : 'history';
  }
  if (body.component === 'records.pointers@1' && body.action === 'move_root') {
    const pointer = object(body.detail)?.pointer;
    if (typeof pointer !== 'string') return null;
    const [home, product, line, extra] = pointer.split('/');
    return (home === 'knowledge' || home === 'seedling') && !!product && extra === undefined &&
      (home !== 'seedling' || !!line) ? 'knowledge' : null;
  }
  return ACTION_COMPONENTS[body.component] ?? null;
}

const CLASSIFIERS = {
  claim: classifyClaim,
  source_artifact: fixed('knowledge', 'source_artifact@1'),
  authorization: classifyAuthorization,
  action: classifyAction,
  effect: fixed('history', 'effect@1'), request: fixed('history', 'request@1'), call_log: fixed('history', 'call_log@1'),
  run: fixed('history', 'run@1'), submission: fixed('history', 'submission@1', 'submission-received@1'),
  validation_result: fixed('history', 'validation@1'), result_summary: fixed('history', 'result-summary@1'),
  pack_version: fixed('packs', 'pack_version@1'),
  tree_node: fixed('knowledge', 'tree_node@1', 'knowledge-entry@1'),
  tree_root: fixed('knowledge', 'tree_root@1', 'tree_root-rows@1', 'tree_root-unplaced@1', 'tree_root-sources@1'),
  root_pointer: fixed('knowledge', 'root_pointer@1'),
  knowledge_space_version: fixed('knowledge', 'knowledge-space-version@1'),
  knowledge_space_entry: fixed('knowledge', 'knowledge-space-entry@1'),
  knowledge_space_grant: fixed('knowledge', 'knowledge-space-grant@1'),
  knowledge_space_source: fixed('knowledge', 'knowledge-space-source@1'),
  knowledge_space_quota: fixed('knowledge', 'knowledge-space-quota@1'),
  knowledge_share: fixed('knowledge', 'knowledge-share@1'),
  personal_pack_version: fixed('packs', 'personal-pack-version@1'), personal_pack_grant: fixed('packs', 'personal-pack-grant@1'),
  personal_pack_retirement: fixed('packs', 'personal-pack-retirement@1'), personal_pack_transfer: fixed('packs', 'personal-pack-transfer@1'),
  memory_document: fixed('knowledge', 'memory-document@1'), memory_version: fixed('knowledge', 'memory-version@1'),
  memory_grant: fixed('knowledge', 'memory-grant@1'), memory_share: fixed('knowledge', 'memory-share@1'),
  knowledge_source_attribution: fixed('knowledge', 'knowledge-source-attribution@1'),
  knowledge_team_source_attribution: fixed('knowledge', 'knowledge-team-source-attribution@1'),
  member_deletion: fixed('config', 'member-deletion@1'), token_issuance: fixed('config', 'token-issuance@1'),
} satisfies Record<RecordKind, Classifier>;

export function classifyCurrentRecord(record: CurrentRecord): ResetScope | null {
  if (!(RECORD_KINDS as readonly string[]).includes(record.kind)) return null;
  const body = object(record.body);
  if (!body) return null;
  const shape = SCHEMA_REGISTRY[record.schema];
  if (shape && !shape.safeParse(body).success) return null;
  return CLASSIFIERS[record.kind as RecordKind](record, body);
}

/** Formal SHA fields only. RunId, user ids, text and arbitrary JSON are not traversed for hashes. */
export function currentRecordReferences(record: CurrentRecord): CurrentReference[] {
  const body = object(record.body);
  if (!body) return [];
  const out: CurrentReference[] = [...record.references ?? []];
  const add = (kind: CurrentReference['kind'], value: unknown, field: string): void => {
    if (sha256(value)) out.push({ kind, digest: value, field });
  };
  const ref = (value: unknown, field: string): void => {
    if (typeof value !== 'string') return;
    const colon = value.indexOf(':'), scheme = value.slice(0, colon);
    const identity = value.slice(colon + 1).split(/[\/#]/, 1)[0];
    if (scheme === 'rec' || scheme === 'tree') add('record', identity, field);
    if (scheme === 'src') add('object', identity, field);
  };
  const rows = (value: unknown): Body[] => Array.isArray(value) ? value.flatMap(row => object(row) ? [object(row)!] : []) : [];
  switch (record.kind) {
    case 'authorization':
      if (body.permission === 'publish' || body.permission === 'resource_config' || body.permission === 'assign') add('object', body.bound, '/bound');
      add('record', body.supersedes, '/supersedes'); break;
    case 'source_artifact': {
      add('object', body.sha256, '/sha256');
      const origin = object(body.origin), read = object(origin?.read), generated = object(origin?.generated);
      add('record', read?.action, '/origin/read/action');
      strings(generated?.inputs).forEach((value, n) => ref(value, '/origin/generated/inputs/' + n));
      add('record', generated?.read_back, '/origin/generated/read_back'); break;
    }
    case 'pack_version': case 'personal_pack_version': {
      add('object', body.digest, '/digest');
      rows(object(body.manifest)?.files).forEach((file, n) => add('object', file.sha256, '/manifest/files/' + n + '/sha256'));
      if (record.kind === 'personal_pack_version') Object.entries(object(body.files) ?? {}).forEach(([key, digest]) => add('record', digest, '/files/' + key));
      break;
    }
    case 'validation_result': add('record', body.submission, '/submission'); ref(body.system_input, '/system_input'); break;
    case 'result_summary': add('record', body.result, '/result'); if (body.system_input === false) add('record', body.submission, '/submission'); break;
    case 'request': add('record', body.source, '/source'); add('record', body.job, '/job'); strings(body.sources).forEach((value, n) => ref(value, '/sources/' + n)); break;
    case 'run':
      rows(body.sources).forEach((source, n) => { add('record', source.artifact, '/sources/' + n + '/artifact'); add('record', source.meta_artifact, '/sources/' + n + '/meta_artifact'); ref(source.reference, '/sources/' + n + '/reference'); });
      add('object', body.executors, '/executors'); add('object', body.policy, '/policy');
      add('object', body.pack_digest, '/pack_digest'); add('object', body.product_pack_digest, '/product_pack_digest');
      rows(body.skills).forEach((skill, n) => add('object', skill.digest, '/skills/' + n + '/digest'));
      add('record', body.root, '/root'); add('record', body.unversioned_root, '/unversioned_root');
      for (const [key, digest] of Object.entries(object(body.knowledge_spaces) ?? {})) if (key !== 'owner') add('record', digest, '/knowledge_spaces/' + key);
      break;
    case 'knowledge_space_version':
      add('record', body.parent, '/parent'); add('object', body.tree, '/tree');
      rows(body.entries).forEach((entry, n) => add('record', entry.record, '/entries/' + n + '/record'));
      strings(body.sources).forEach((digest, n) => add('record', digest, '/sources/' + n));
      rows(body.products).forEach((product, n) => add('record', product.root, '/products/' + n + '/root')); break;
    case 'knowledge_space_source': add('record', body.artifact, '/artifact'); add('record', body.attribution, '/attribution'); add('object', body.sha256, '/sha256'); break;
    case 'knowledge_source_attribution': add('record', body.source, '/source'); add('record', body.artifact, '/artifact'); add('object', body.sha256, '/sha256'); break;
    case 'knowledge_team_source_attribution':
      add('record', body.team_source, '/team_source'); add('record', body.declaration, '/declaration'); add('record', body.artifact, '/artifact'); add('object', body.sha256, '/sha256'); break;
    case 'memory_version': add('record', body.document, '/document'); add('record', body.parent, '/parent'); add('record', body.content_version, '/content_version'); break;
    case 'tree_node':
      if (record.schema === 'tree_node@1') { rows(body.children).forEach((child, n) => add('record', child.digest, '/children/' + n + '/digest')); strings(body.entries).forEach((digest, n) => add('record', digest, '/entries/' + n)); } break;
    case 'tree_root':
      if (record.schema === 'tree_root@1') { add('record', body.root, '/root'); const parts = object(body.parts); for (const [key, list] of Object.entries(parts ?? {})) rows(list).forEach((part, n) => add('record', part.record, '/parts/' + key + '/' + n + '/record')); }
      rows(body.sources).forEach((source, n) => { add('record', source.artifact, '/sources/' + n + '/artifact'); add('object', source.sha256, '/sources/' + n + '/sha256'); }); break;
    case 'root_pointer': add('record', body.move, '/move'); add('record', body.composition, '/composition'); add('record', body.root, '/root'); break;
    case 'action':
      strings(body.inputs).forEach((value, n) => { if (sha256(value)) add('record', value, '/inputs/' + n); else ref(value, '/inputs/' + n); });
      if (record.schema === 'mcp-client-declaration@1') add('record', body.call, '/call');
      if (record.schema === 'action@1') { const detail = object(body.detail); add('record', detail?.previous_action, '/detail/previous_action'); }
      break;
    case 'claim': strings(body.grounds).forEach((value, n) => ref(value, '/grounds/' + n)); break;
  }
  return out;
}

export function selectCurrentRecords(records: readonly CurrentRecord[], scopes: ReadonlySet<ResetScope>, options: SelectionOptions = {}): RecordSelection {
  const retained: string[] = [], cleared: string[] = [], blocked: ResetProblem[] = [];
  const owners = new Map<string, ResetScope>();
  records.forEach((record, index) => {
    const scope = classifyCurrentRecord(record);
    if (scope === null) blocked.push({ table: 'records', row: index + 1, name: record.digest,
      reason: '记录种类、模式或正文没有当前重置范围规则', nextAction: '核对当前写入格式并补充明确的范围规则后重试' });
    else { owners.set(record.digest, scope); (scopes.has(scope) ? cleared : retained).push(record.digest); }
  });
  records.forEach((record, index) => {
    const scope = owners.get(record.digest);
    if (!scope || scopes.has(scope)) return;
    const visitedObjects = new Set<string>();
    const pending = currentRecordReferences(record);
    for (let at = 0; at < pending.length; at++) {
      const reference = pending[at]!;
      const target = options.recordAliases?.get(reference.digest) ?? reference.digest;
      const targetScopes = reference.kind === 'record' ? (owners.has(target) ? [owners.get(target)!] : undefined) : options.objectScopes?.get(reference.digest);
      if (!targetScopes?.length || targetScopes.every(targetScope => scopes.has(targetScope))) blocked.push({ scope, table: 'records',
        row: index + 1, name: record.digest, reason: !targetScopes?.length ? `正式引用 ${reference.field} 缺少已核对的目标范围` : `保留记录的正式引用 ${reference.field} 指向所清范围`,
        nextAction: '补齐引用目标的范围或显式调整所选范围；程序不会扩大清除范围' });
      else if (reference.kind === 'object' && !visitedObjects.has(reference.digest)) {
        visitedObjects.add(reference.digest);
        const edges = options.objectReferences?.get(reference.digest);
        if (!edges) blocked.push({ scope, table: 'records', row: index + 1, name: record.digest,
          reason: `正式引用 ${reference.field} 的对象内部引用尚未核对`, nextAction: '由当前模式读取器核对该对象的正式引用后重试' });
        else pending.push(...edges);
      }
    }
  });
  return { retained, cleared, blocked };
}

/** These tables use actual records.digest foreign keys; their names do not decide their ownership. */
export const RECORD_HOLDER_COLUMNS = {
  run_originals: 'held_by', original_targets: 'held_by', held_objects: 'held_by', held_object_targets: 'held_by',
  object_holds: 'record', personal_record_bindings: 'record', record_keys: 'digest', record_index: 'digest',
  run_upload_declarations: 'run', run_pack_records: 'held_by', pointers: 'action_digest',
} as const;

export function partitionRunOriginals<T extends { held_by: string }>(rows: readonly T[], selection: Pick<RecordSelection, 'retained' | 'cleared'>): { retained: T[]; cleared: T[]; blocked: ResetProblem[] } {
  const keep = new Set(selection.retained), clear = new Set(selection.cleared);
  const retained: T[] = [], cleared: T[] = [], blocked: ResetProblem[] = [];
  rows.forEach((row, index) => {
    if (keep.has(row.held_by)) retained.push(row);
    else if (clear.has(row.held_by)) cleared.push(row);
    else blocked.push({ table: 'run_originals', row: index + 1, reason: 'held_by 没有已核对的记录范围', nextAction: '补齐 held_by 正式外键目标后重试' });
  });
  return { retained, cleared, blocked };
}

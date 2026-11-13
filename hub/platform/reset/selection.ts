// Current-schema reset ownership. Unknown shapes block a reset instead of acquiring a default scope.
import { RECORD_KINDS, type RecordKind } from '../../../contracts/generated/protocol.ts';
import { AcceptanceSchema, ActionKindSchema, ActionResultSchema, CallResultSchema, LeaseOpSchema, PermissionKindSchema } from '../../../contracts/generated/vocabulary.ts';
import { SCHEMA_REGISTRY } from '../../../contracts/src/index.ts';
import { FEEDING_SCHEMAS } from '../../../contracts/src/feeding.ts';
import { IsoTime, UserId, Versioned } from '../../../contracts/src/common.ts';
import { PackManifest } from '../../../contracts/src/pack.ts';
import { ProductId } from '../../../contracts/src/product.ts';
import { ReferenceUri } from '../../../contracts/src/reference.ts';
import type { ResetProblem, ResetScope } from './types.ts';

export interface CurrentReference { kind: 'record' | 'object'; digest: string; field: string }
export interface CurrentRecord {
  digest: string;
  kind: string;
  schema: string;
  body: unknown;
  /** False is an unreadable current observation, not a declaration of an incompatible schema. */
  available?: boolean;
  /** Exact record_index entries supplied by the current database reader. */
  indices?: readonly { key: string; value: string }[];
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
  /** Verified source_artifact holders, including held_by ownership resolved from SQL foreign keys. */
  sourceScopes?: ReadonlyMap<string, readonly ResetScope[]>;
}
export interface RecordSelection { retained: string[]; cleared: string[]; blocked: ResetProblem[] }
type Body = Record<string, unknown>;
type Classifier = (record: CurrentRecord, body: Body) => ResetScope | null;
const object = (value: unknown): Body | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Body : null;
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
const sha256 = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const nullableText = (value: unknown): boolean => value === null || typeof value === 'string';
const textArray = (value: unknown): value is string[] => Array.isArray(value) && value.every(entry => typeof entry === 'string');

function artifactBody(record: CurrentRecord, body: Body): boolean {
  const origin = object(body.origin), author = object(body.author), visibility = object(body.visibility);
  return record.schema === 'source_artifact@1' && sha256(body.sha256) && Number.isSafeInteger(body.size) && Number(body.size) >= 0 &&
    typeof body.media_type === 'string' && origin !== null && Object.keys(origin).length === 1 &&
    ['read', 'upload', 'generated'].some(key => Object.hasOwn(origin, key) && object(origin[key]) !== null) &&
    author !== null && (author.user === null || UserId.safeParse(author.user).success) && visibility !== null &&
    typeof visibility.admins === 'boolean' && typeof visibility.shareable === 'boolean' &&
    textArray(visibility.readers) && textArray(visibility.packs) && object(body.scan) !== null;
}

function classifyArtifact(record: CurrentRecord, body: Body, holders: readonly ResetScope[] = []): ResetScope | null {
  if (!artifactBody(record, body)) return null;
  const unique = [...new Set(holders)];
  return unique.length === 1 ? unique[0]! : null;
}

function documentRevision(record: CurrentRecord, body: Body): boolean {
  const read = object(object(body.origin)?.read), external = read?.object;
  if (typeof external !== 'string') return false;
  // Exact DOC_ID grammar from server/docs.ts; the pinned revision must cover these bytes.
  const match = /^doc:doc:([a-z][a-z0-9-]{0,63})@([0-9a-f]{64})$/.exec(external);
  return match !== null && match[2] === body.sha256 &&
    (record.indices === undefined || record.indices.some(entry => entry.key === 'artifact.object' && entry.value === external));
}

function artifactScopes(record: CurrentRecord, body: Body, options: SelectionOptions): ResetScope[] {
  return [...new Set([...(options.sourceScopes?.get(record.digest) ?? []),
    ...(documentRevision(record, body) ? (options.objectScopes?.get(String(body.sha256)) ?? []).filter(scope => scope === 'config') : []),
    ...(object(object(body.origin)?.generated)?.generator === 'server.docs@1' ? ['history' as const] : [])])];
}

function moveTargetKind(body: Body): CurrentReference['kind'] | null {
  if (body.action !== 'move_root') return null;
  const pointer = object(body.detail)?.pointer;
  if (typeof pointer !== 'string') return null;
  if (body.component === 'server.docs@1') return /^doc:[a-z][a-z0-9-]{0,63}$/.test(pointer) ? 'object' : null;
  if (!['records.pointers@1', 'knowledge.seedling@1', 'knowledge.produce@1'].includes(String(body.component))) return null;
  const [home, product, line, extra] = pointer.split('/');
  return (home === 'knowledge' || home === 'seedling') && ProductId.safeParse(product).success && extra === undefined &&
    (line === undefined || line.length > 0) && (home !== 'seedling' || !!line) ? 'record' : null;
}

function classifyCall(record: CurrentRecord, body: Body): ResetScope | null {
  return record.schema === 'call_log@1' && IsoTime.safeParse(body.at).success && typeof body.trace_id === 'string' &&
    /^[0-9a-f]{32}$/.test(body.trace_id) && typeof body.span_id === 'string' && /^[0-9a-f]{16}$/.test(body.span_id) &&
    nullableText(body.user) && nullableText(body.session) && nullableText(body.run) && typeof body.tool === 'string' &&
    sha256(body.args_digest) && Number.isSafeInteger(body.args_size) && Number(body.args_size) >= 0 && nullableText(body.args_preview) &&
    CallResultSchema.safeParse(body.call_result).success && (body.acceptance === null || AcceptanceSchema.safeParse(body.acceptance).success) &&
    nullableText(body.error_code) && Number.isSafeInteger(body.duration_ms) && Number(body.duration_ms) >= 0 ? 'history' : null;
}

function classifyPack(record: CurrentRecord, body: Body): ResetScope | null {
  if (record.schema !== 'pack_version@1') return null;
  const manifest = PackManifest.safeParse(body.manifest);
  return manifest.success && body.pack === manifest.data.id && body.version === manifest.data.version && body.kind === manifest.data.kind &&
    sha256(body.digest) && UserId.safeParse(body.publisher).success && object(body.report) !== null ? 'packs' : null;
}

function fixed(scope: ResetScope, ...schemas: string[]): Classifier {
  return record => schemas.includes(record.schema) ? scope : null;
}

function classifyAuthorization(record: CurrentRecord, body: Body): ResetScope | null {
  if (record.schema !== 'authorization@1' || !PermissionKindSchema.safeParse(body.permission).success ||
    typeof body.subject !== 'string' || typeof body.object !== 'string' || typeof body.revoked !== 'boolean' ||
    !(body.bound === null || sha256(body.bound)) || !UserId.safeParse(body.decided_by).success || !IsoTime.safeParse(body.decided_at).success ||
    !(body.expires_at === null || IsoTime.safeParse(body.expires_at).success) || !nullableText(body.note) ||
    !(body.supersedes === null || sha256(body.supersedes))) return null;
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
  const shape = Object.hasOwn(FEEDING_SCHEMAS, schema) ? FEEDING_SCHEMAS[schema as keyof typeof FEEDING_SCHEMAS] : undefined;
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
  'hub.feeding@2': 'knowledge', 'connectors@1': 'knowledge',
};
function classifyAction(record: CurrentRecord, body: Body): ResetScope | null {
  if (['memory-refusal@1', 'memory-unchanged@1', 'personal-sync-mode@1', 'personal-sync-commit@1',
    'personal-sync-purge-request@1', 'personal-sync-http-audit@1'].includes(record.schema)) return 'knowledge';
  if (record.schema === 'mcp-client-declaration@1') return body.kind === 'read' && sha256(body.call) && object(body.client) !== null ? 'history' : null;
  if (record.schema === 'trial-report@1') return body.action === 'trial' ? 'history' : null;
  if (record.schema === 'read-manifest@1') return body.action === 'read' && body.component === 'connectors@1' ?
    body.run === null ? 'knowledge' : 'history' : null;
  if (record.schema !== 'action@1' || !ActionKindSchema.safeParse(body.action).success || !Versioned.safeParse(body.component).success ||
    typeof body.component !== 'string' || !textArray(body.inputs) || object(body.detail) === null || !nullableText(body.run) ||
    !nullableText(body.item) || !IsoTime.safeParse(body.started_at).success || !IsoTime.safeParse(body.ended_at).success ||
    !ActionResultSchema.safeParse(body.result).success || !nullableText(body.error_code) || !textArray(body.codes) ||
    !(body.acceptance === null || AcceptanceSchema.safeParse(body.acceptance).success)) return null;
  if (body.component === 'leases@1') {
    const op = object(body.detail)?.op;
    if (!LeaseOpSchema.safeParse(op).success) return null;
    return op === 'register' || op === 'unregister' ? 'config' : 'history';
  }
  if (body.action === 'move_root') { const target = moveTargetKind(body); return target === 'object' ? 'config' : target === 'record' ? 'knowledge' : null; }
  if (body.component === 'server.docs@1') return body.action === 'read' && /^doc:doc:[a-z][a-z0-9-]{0,63}$/.test(String(object(body.detail)?.external)) ? 'history' : null;
  return Object.hasOwn(ACTION_COMPONENTS, body.component) ? ACTION_COMPONENTS[body.component]! : null;
}

const CLASSIFIERS = {
  claim: classifyClaim,
  source_artifact: classifyArtifact,
  authorization: classifyAuthorization,
  action: classifyAction,
  effect: fixed('history', 'effect@1'), request: fixed('history', 'request@1'), call_log: classifyCall,
  run: fixed('history', 'run@1'), submission: fixed('history', 'submission@1', 'submission-received@1'),
  validation_result: fixed('history', 'validation@1'), result_summary: fixed('history', 'result-summary@1'),
  pack_version: classifyPack,
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

export function classifyCurrentRecord(record: CurrentRecord, options: SelectionOptions = {}): ResetScope | null {
  if (record.available === false) return null;
  if (!(RECORD_KINDS as readonly string[]).includes(record.kind)) return null;
  const body = object(record.body);
  if (!body) return null;
  const shape = Object.hasOwn(SCHEMA_REGISTRY, record.schema) ? SCHEMA_REGISTRY[record.schema] : undefined;
  if (shape && !shape.safeParse(body).success) return null;
  return record.kind === 'source_artifact' ? classifyArtifact(record, body, artifactScopes(record, body, options)) :
    CLASSIFIERS[record.kind as RecordKind](record, body);
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
    if (typeof value !== 'string' || !ReferenceUri.safeParse(value).success) return;
    const colon = value.indexOf(':'), scheme = value.slice(0, colon);
    const identity = value.slice(colon + 1).split(/[\/#]/, 1)[0];
    if (scheme === 'rec' || scheme === 'tree') add('record', identity, field);
    if (scheme === 'src') add('object', identity, field);
    if (scheme === 'tree') add('record', value.slice(value.lastIndexOf('@') + 1), field);
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
      // runs/packs/personal.ts stores source_artifact.digest here, separately from manifest file byte hashes.
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
      strings(body.inputs).forEach((value, n) => {
        if (sha256(value)) { const kind = moveTargetKind(body); if (kind) add(kind, value, '/inputs/' + n); }
        else ref(value, '/inputs/' + n);
      });
      if (record.schema === 'mcp-client-declaration@1') add('record', body.call, '/call');
      if (record.schema === 'read-manifest@1') {
        rows(body.artifacts).forEach((artifact, n) => add('record', artifact.record, '/artifacts/' + n + '/record'));
        rows(body.requests).forEach((request, n) => add('record', request.artifact, '/requests/' + n + '/artifact'));
        rows(body.reads).forEach((read, n) => add('record', read.manifest, '/reads/' + n + '/manifest'));
      }
      if (record.schema === 'action@1') {
        const detail = object(body.detail); add('record', detail?.previous_action, '/detail/previous_action');
        const target = moveTargetKind(body);
        if (target) { add(target, detail?.expected, '/detail/expected'); add(target, detail?.next, '/detail/next'); }
        if (body.component === 'server.docs@1' && body.action === 'read') add('object', detail?.sha256, '/detail/sha256');
      }
      break;
    case 'claim': strings(body.grounds).forEach((value, n) => ref(value, '/grounds/' + n)); break;
  }
  return out;
}

/** Sources inherit verified holder scopes; exact named-document provenance owns its configuration copies. */
export function resolveCurrentRecordScopes(records: readonly CurrentRecord[], options: SelectionOptions = {}): ReadonlyMap<string, readonly ResetScope[]> {
  const byDigest = new Map(records.map(record => [record.digest, record]));
  const owners = new Map<string, ResetScope[]>(), pending: string[] = [];
  for (const record of records) {
    if (record.kind === 'source_artifact' && record.available !== false && object(record.body) && artifactBody(record, object(record.body)!)) {
      const body = object(record.body)!;
      const scopes = artifactScopes(record, body, options);
      if (scopes.length) { owners.set(record.digest, scopes); pending.push(record.digest); }
    } else {
      const scope = classifyCurrentRecord(record);
      if (scope) { owners.set(record.digest, [scope]); pending.push(record.digest); }
    }
  }
  const sources = new Map<string, string[]>();
  for (const record of records) {
    const targets = currentRecordReferences(record).filter(reference => reference.kind === 'record').map(reference =>
      options.recordAliases?.get(reference.digest) ?? reference.digest).filter(digest => {
      const target = byDigest.get(digest), body = target && object(target.body);
      return target?.kind === 'source_artifact' && target.available !== false && body !== null && body !== undefined && artifactBody(target, body);
    });
    sources.set(record.digest, [...new Set(targets)]);
  }
  for (let index = 0; index < pending.length; index++) {
    const holder = pending[index]!;
    for (const target of sources.get(holder) ?? []) {
      const before = owners.get(target) ?? [], next = [...new Set([...before, ...owners.get(holder)!])];
      if (next.length > before.length) { owners.set(target, next); pending.push(target); }
    }
  }
  return owners;
}

export function selectCurrentRecords(records: readonly CurrentRecord[], scopes: ReadonlySet<ResetScope>, options: SelectionOptions = {}): RecordSelection {
  const retained: string[] = [], cleared: string[] = [], blocked: ResetProblem[] = [];
  const owners = resolveCurrentRecordScopes(records, options);
  records.forEach((record, index) => {
    const owned = owners.get(record.digest);
    if (!owned?.length) blocked.push({ table: 'records', row: index + 1, name: record.digest,
      reason: record.available === false ? '当前记录正文不可读取，尚不能核对范围与引用' : record.kind === 'source_artifact' ?
        '来源原件没有已核对的正式持有范围' : '记录种类、模式或正文没有当前重置范围规则',
      nextAction: record.available === false ? '恢复该记录的可读取状态后重新预检；不可读取不表示模式不兼容' : '核对当前写入格式并补充明确的范围规则后重试' });
    else (owned.every(scope => scopes.has(scope)) ? cleared : retained).push(record.digest);
  });
  records.forEach((record, index) => {
    const scope = owners.get(record.digest)?.find(scope => !scopes.has(scope));
    if (!scope) return;
    const visitedObjects = new Set<string>();
    const pending = currentRecordReferences(record);
    const body = object(record.body);
    if (record.kind === 'action' && body && !moveTargetKind(body)) strings(body.inputs).forEach((value, n) => {
      if (sha256(value) && !record.references?.some(reference => reference.field === '/inputs/' + n && reference.digest === value)) blocked.push({
        scope, table: 'records', row: index + 1, name: record.digest, reason: `正式输入 /inputs/${n} 的裸摘要目标类型尚未核对`,
        nextAction: '按当前 writer 声明记录、树内容别名或对象引用后重试；不把裸摘要默认当记录' });
    });
    for (let at = 0; at < pending.length; at++) {
      const reference = pending[at]!;
      const target = options.recordAliases?.get(reference.digest) ?? reference.digest;
      const targetScopes = reference.kind === 'record' ? owners.get(target) : options.objectScopes?.get(reference.digest);
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
  run_upload_declarations: 'run_record', run_pack_records: 'held_by', pointers: 'action_digest',
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

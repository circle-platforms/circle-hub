// One-release state selection. Historical readers belong here, never in serve or the runtime records package.
import { SCHEMA_REGISTRY } from '../../../contracts/src/index.ts';
import { PackManifest } from '../../../contracts/src/pack.ts';
import { Ground } from '../../../contracts/src/reference.ts';
import { RunId, Sha256 } from '../../../contracts/src/common.ts';
import { isPermissionKind } from '../../../contracts/generated/vocabulary.ts';
import { canonicalize, recordDigest, digestOf } from '../../records/api.ts';

export interface OldRecord {
  seq: string;
  id: string;
  digest: string;
  kind: string;
  schema: string;
  provenance: string;
  created_at: string;
  body: unknown;
}
export interface UpgradeIssue { table: string; row: number; reason: string; }
export interface Selection {
  selected: Set<string>;
  archived: Map<string, number>;
  issues: UpgradeIssue[];
  secretDecisions: OldRecord[];
  objects: Set<string>;
  decisions: Array<{ row: number; disposition: 'migrated' | 'archived'; reason: string }>;
}

// These are exact predecessor kind/schema pairs, verified against their package writers. No text classification.
const STATE_SCHEMAS: Readonly<Record<string, readonly string[]>> = {
  authorization: ['authorization@1'],
  pack_version: ['pack_version@1'],
  tree_node: ['tree_node@1', 'knowledge-entry@1'],
  tree_root: ['tree_root@1', 'tree_root-rows@1', 'tree_root-unplaced@1', 'tree_root-sources@1'],
  root_pointer: ['root_pointer@1'],
  knowledge_space_version: ['knowledge-space-version@1'],
  knowledge_space_entry: ['knowledge-space-entry@1'],
  knowledge_space_grant: ['knowledge-space-grant@1'],
  knowledge_space_source: ['knowledge-space-source@1'],
  knowledge_space_quota: ['knowledge-space-quota@1'],
  knowledge_share: ['knowledge-share@1'],
  knowledge_source_attribution: ['knowledge-source-attribution@1'],
  knowledge_team_source_attribution: ['knowledge-team-source-attribution@1'],
  personal_pack_version: ['personal-pack-version@1'],
  personal_pack_grant: ['personal-pack-grant@1'],
  personal_pack_retirement: ['personal-pack-retirement@1'],
  personal_pack_transfer: ['personal-pack-transfer@1'],
  memory_document: ['memory-document@1'], memory_version: ['memory-version@1'],
  memory_grant: ['memory-grant@1'], memory_share: ['memory-share@1'],
  member_deletion: ['member-deletion@1'],
  claim: ['claim@1', 'knowledge-build@1', 'knowledge-calibration@1', 'knowledge-observation@1', 'knowledge-contribution@1', 'seedling@1'],
};
const ARCHIVE_SCHEMAS: Readonly<Record<string, readonly string[]>> = {
  run: ['run@1'], submission: ['submission@1', 'submission-received@1'],
  validation_result: ['validation@1'], request: ['request@1'], call_log: ['call_log@1'],
  effect: ['effect@1'], result_summary: ['result-summary@1'], token_issuance: ['token-issuance@1'],
};

export function fields(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('记录不是对象');
  return value as Record<string, unknown>;
}

/** Each path is a typed dependency field, not a search over authored text. '*' means one declared array/map level. */
const DEPENDENCIES: Readonly<Record<string, readonly string[]>> = {
  'authorization@1': ['supersedes', 'bound'],
  'pack_version@1': ['manifest/files/*/sha256'],
  'tree_node@1': ['children/*/digest', 'entries/*'],
  'knowledge-entry@1': [],
  'tree_root@1': ['root', 'sources/*/artifact', 'sources/*/sha256', 'composition/*/entry', 'unplaced/*/entry', 'parts/composition/*/record', 'parts/unplaced/*/record', 'parts/sources/*/record', 'inherited_builds/*/record', 'variables/*/decision'],
  'tree_root-rows@1': ['rows/*/entry', 'rows/*/sources/*/artifact', 'rows/*/sources/*/sha256'],
  'tree_root-unplaced@1': ['rows/*/entry'],
  'tree_root-sources@1': ['rows/*/artifact', 'rows/*/sha256'],
  'root_pointer@1': ['expected', 'root', 'composition', 'move', 'cause'],
  'knowledge-space-version@1': ['parent', 'tree', 'sources/*', 'products/*/root', 'entries/*/record'],
  'knowledge-space-entry@1': ['replaces', 'grounds/*/reference', 'shared_from/root', 'source_attributions/*'],
  'knowledge-space-source@1': ['sha256', 'artifact', 'attribution'],
  'knowledge-space-grant@1': [], 'knowledge-space-quota@1': [],
  'knowledge-source-attribution@1': ['source', 'artifact', 'sha256'],
  'knowledge-team-source-attribution@1': ['team_source', 'declaration', 'artifact', 'sha256'],
  'knowledge-share@1': ['source/root', 'single_item/object', 'single_item/sources/*', 'team_root', 'reference'],
  'personal-pack-version@1': ['files/*', 'manifest/files/*/sha256'],
  'personal-pack-grant@1': [], 'personal-pack-retirement@1': [],
  'personal-pack-transfer@1': ['source', 'target'],
  'memory-document@1': [],
  'memory-version@1': ['document', 'parent', 'content_version'],
  'memory-grant@1': [],
  'memory-share@1': ['document', 'version', 'team_document', 'team_version', 'replaces'],
  'member-deletion@1': ['purge_manifest'],
  'claim@1': ['grounds/*', 'validity/bound/*', 'resolutions/*/references/*'],
  'knowledge-build@1': ['plan'],
  'knowledge-calibration@1': [],
  'knowledge-observation@1': [],
  'knowledge-contribution@1': [],
  'seedling@1': [],
  'source_artifact@1': ['origin/read/action', 'origin/generated/inputs/*', 'origin/generated/read_back', 'sha256'],
  'action@1': ['inputs/*', 'detail/previous_action', 'detail/expected', 'detail/next'],
};

function valuesAt(value: unknown, path: string[]): unknown[] {
  if (path.length === 0) return value === null || value === undefined ? [] : [value];
  if (value === null || typeof value !== 'object') return [];
  const [head, ...tail] = path;
  if (head === '*') return Object.values(value).flatMap(child => valuesAt(child, tail));
  return valuesAt((value as Record<string, unknown>)[head!], tail);
}

function targetOf(value: unknown): string | null {
  if (Sha256.safeParse(value).success) return value as string;
  if (typeof value !== 'string' || !Ground.safeParse(value).success) return null;
  // Ground has already validated the complete URI grammar. A tree's optional entry is also selected separately.
  return value.slice(value.indexOf(':') + 1, value.indexOf(':') + 65);
}


export function selectState(records: readonly OldRecord[], objects: ReadonlySet<string>, aliases: ReadonlyMap<string, readonly string[]> = new Map()): Selection {
  const objectClosure = new Set<string>();
  const selected = new Set<string>(), issues: UpgradeIssue[] = [], secretDecisions: OldRecord[] = [];
  const byDigest = new Map(records.map(row => [row.digest, row]));
  const positions = new Map(records.map((row, index) => [row.digest, index + 1]));
  const permitted = new Set<string>();
  const fail = (row: OldRecord, reason: string) => issues.push({ table: 'records', row: positions.get(row.digest)!, reason });
  for (const row of records) {
    if (STATE_SCHEMAS[row.kind]?.includes(row.schema)) {
      try {
        const body = fields(row.body);
        if (row.schema === 'claim@1') {
          if (body.item !== undefined || body.requirement !== undefined) continue;
          const data = fields(fields(body.statement).data);
          const feeding = fields(data.feeding);
          if (typeof feeding.schema !== 'string' || !SCHEMA_REGISTRY[feeding.schema]?.safeParse(feeding).success) throw new Error();
        }
        if (recordDigest({ ...row, body }) !== row.digest) throw new Error();
        if (row.schema === 'authorization@1') {
          if (!isPermissionKind(body.permission) || typeof body.subject !== 'string' || typeof body.object !== 'string' || typeof body.revoked !== 'boolean') throw new Error();
          if (body.permission === 'resource_config' && body.object.startsWith('secret:')) { secretDecisions.push(row); continue; }
          if (body.permission === 'share' && RunId.safeParse(body.object).success) continue;
        } else if (row.schema === 'pack_version@1') {
          const manifest = PackManifest.parse(body.manifest);
          if (body.pack !== manifest.id || body.version !== manifest.version || body.digest !== digestOf(body.manifest)) throw new Error();
        } else {
          const shape = SCHEMA_REGISTRY[row.schema];
          if (!shape || !shape.safeParse(body).success) throw new Error();
        }
        permitted.add(row.digest); selected.add(row.digest);
      } catch { fail(row, '状态记录的模式或完整性不符，不能转入'); }
    } else if (row.kind === 'source_artifact' && row.schema === 'source_artifact@1' || row.kind === 'action' && row.schema === 'action@1') {
      permitted.add(row.digest);
    } else if (!(row.kind === 'claim' && row.schema === 'feeding-offset@1') && !ARCHIVE_SCHEMAS[row.kind]?.includes(row.schema)) {
      fail(row, '没有声明这个种类和模式的迁移规则，不能判作历史丢弃');
    }
  }
  const visited = new Set<string>();
  const queue = [...selected];
  const add = (hash: string, from: OldRecord) => {
    const direct = byDigest.has(hash) ? [hash] : aliases.get(hash);
    if (direct) for (const digest of direct) {
      if (!permitted.has(digest)) { fail(from, '状态引用了仅归档的运行历史，引用闭包不完整'); continue; }
      if (!selected.has(digest)) { selected.add(digest); queue.push(digest); }
    }
    else if (objects.has(hash)) objectClosure.add(hash);
    else fail(from, '状态引用的记录或对象缺失，不能转入');
  };
  for (let at = 0; at < queue.length; at++) {
    const row = byDigest.get(queue[at]!)!;
    if (visited.has(row.digest)) continue;
    visited.add(row.digest);
    if (row.schema === 'action@1') {
      const body = fields(row.body);
      if (body.action !== 'move_root') { fail(row, '引用的动作没有已声明的状态迁移规则'); continue; }
    }
    if (recordDigest(row) !== row.digest) { fail(row, '引用记录的完整性不符'); continue; }
    for (const path of DEPENDENCIES[row.schema] ?? []) {
      for (const value of valuesAt(row.body, path.split('/'))) {
        const target = targetOf(value);
        if (target !== null) add(target, row);
        if (typeof value === 'string' && Ground.safeParse(value).success && value.startsWith('tree:') && value.includes('@')) add(value.slice(value.lastIndexOf('@') + 1), row);
      }
    }
  }
  const archived = new Map<string, number>();
  for (const row of records) if (!selected.has(row.digest)) archived.set(row.kind, (archived.get(row.kind) ?? 0) + 1);
  return { selected, archived, issues, secretDecisions, objects: objectClosure, decisions: records.map((row, index) => ({ row: index + 1, disposition: selected.has(row.digest) ? 'migrated' : 'archived', reason: selected.has(row.digest) ? '保留状态及其明确引用闭包' : secretDecisions.includes(row) ? '旧密钥登记转为独立非值元数据，原决定保留归档' : '不属于保留状态，原件在旧数据库归档中保留' })) };
}

export function canonicalOldBody(text: string): unknown {
  const body: unknown = JSON.parse(text);
  if (canonicalize(body) !== text) throw new Error('旧正文不是规范JSON，升级不带入回退读法');
  return body;
}

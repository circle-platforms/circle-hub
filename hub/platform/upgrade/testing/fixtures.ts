// Synthetic previous-release state, confined to upgrade acceptance helpers.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RecordEnvelope } from '../../../../contracts/src/records.ts';
import { PackManifest } from '../../../../contracts/src/pack.ts';
import { ProductDeclaration } from '../../../../contracts/src/product.ts';
import { ResourceRecord, ExecutorSource, SystemProfile } from '../../../../contracts/src/resources.ts';
import { KnowledgeEntryBody, TreeNodeBody, TreeRootBody, RootPointerBody } from '../../../../contracts/src/knowledge.ts';
import { SpaceEntryBody, SpaceSourceBody, SpaceVersionBody } from '../../../../contracts/src/spaces.ts';
import { MemoryDocumentBody, MemoryVersionBody } from '../../../../contracts/src/memory.ts';
import { SAMPLE_SOURCE, type PermissionKind } from '../../../../contracts/generated/vocabulary.ts';
import { canonicalize, digestOf, sha256Hex, recordDigest } from '../../../records/api.ts';
import type { AuthorizationBody, IndexEntry, SourceArtifactBody } from '../../../records/api.ts';
import type { PackVersionBody } from '../../../runs/api.ts';
import type { SqlSession } from '../../sql.ts';

const AT = '2026-11-12T00:00:00.000Z';
const EPOCH = '00000000-0000-4000-8000-000000000001';
const ACCOUNT_EPOCH = '00000000-0000-4000-8000-000000000002';
const id = (prefix: string, n: number): string => prefix + '_' + n.toString(16).padStart(26, '0');

export interface FixtureScope { owner: string; epoch: string }
export interface FixtureObject {
  sha256: string;
  mediaType: string;
  bytes: Uint8Array;
  scope?: FixtureScope;
}
export interface FixtureRecord<B = unknown> extends Omit<RecordEnvelope, 'body'> {
  body: B;
  index: IndexEntry[];
  scope?: FixtureScope;
  uniqueKey?: string;
}
export interface FixtureRow { table: string; values: Record<string, unknown> }
export interface Old33FixtureOptions {
  /** Hashes only; callers keep scratch authentication material outside this fixture. */
  tokenSha256?: string;
  passwordHash?: string;
  resourceOrigin?: string;
}
export interface Old33Fixture {
  at: string;
  admin: string;
  member: string;
  oauthClient: string;
  tokenId: string;
  tokenSha256: string;
  rows: FixtureRow[];
  objects: FixtureObject[];
  records: FixtureRecord[];
  retained: string[];
  archived: string[];
  handles: {
    packs: { id: string; version: string; digest: string; record: string }[];
    resource: { id: string; object: string; decision: string };
    executor: { id: string; object: string; decision: string };
    variable: { name: string; object: string; decision: string };
    secrets: { name: string; version: number; entry: string; object: string; decision: string; digestRule: string }[];
    product: { id: string; root: string; composition: string; pointer: string; source: string };
    spaces: { space: string; entry: string; version: string; source: string; memory: string; memoryVersion: string }[];
    reservation: { key: string; lease: string; run: string };
  };
}

/** Builds data without opening files, a database, a network connection or a vault. */
export function buildOld33Fixture(options: Old33FixtureOptions = {}): Old33Fixture {
  const admin = id('usr', 1), member = id('usr', 2), disabled = id('usr', 3);
  const oauthClient = id('cli', 1), tokenId = id('tok', 1);
  const tokenSha256 = options.tokenSha256 ?? sha256Hex('synthetic-upgrade-token-hash-input');
  const passwordHash = options.passwordHash ?? `scrypt$131072$8$1$${'a'.repeat(32)}$${'b'.repeat(64)}`;
  const rows: FixtureRow[] = [], objects: FixtureObject[] = [], records: FixtureRecord[] = [];
  const retained: string[] = [], archived: string[] = [];
  const row = (table: string, values: Record<string, unknown>): void => { rows.push({ table, values }); };
  const object = (value: unknown, mediaType = 'application/json', scope?: FixtureScope): FixtureObject => {
    const bytes = Buffer.from(typeof value === 'string' ? value : canonicalize(value));
    const item = { sha256: sha256Hex(bytes), mediaType, bytes, ...(scope ? { scope } : {}) };
    if (!objects.some(existing => existing.sha256 === item.sha256 && existing.scope?.owner === scope?.owner)) objects.push(item);
    return item;
  };
  const record = <B>(kind: RecordEnvelope['kind'], schema: string, body: B, index: IndexEntry[] = [],
    scope?: FixtureScope, archive = false, uniqueKey?: string): FixtureRecord<B> => {
    const meta = { kind, schema, provenance: 'declared' as const, created_at: AT, body };
    const item = { id: id('rcd', records.length + 1), ...meta, digest: recordDigest(meta), index,
      ...(scope ? { scope } : {}), ...(uniqueKey ? { uniqueKey } : {}) };
    records.push(item);
    (archive ? archived : retained).push(item.digest);
    return item;
  };
  const authorize = (permission: PermissionKind, subject: string, target: string, bound: string | null,
    supersedes: string | null = null, revoked = false): FixtureRecord<AuthorizationBody> => {
    const body: AuthorizationBody = { permission, subject, object: target, bound, revoked, decided_by: admin,
      decided_at: AT, expires_at: null, note: '合成升级登记', supersedes };
    const index = [
      { key: 'authz.key', value: `${permission}|${subject}|${target}` },
      { key: 'authz.subject', value: `${permission}|${subject}` },
      { key: 'authz.object', value: `${permission}|${target}` },
      { key: 'authz.permission', value: permission },
      { key: 'authz.subject-any', value: subject }, { key: 'authz.object-any', value: target },
      { key: 'authz.decider', value: admin },
      ...(permission === 'publish' && !revoked ? [{ key: 'authz.published', value: target },
        { key: 'authz.published-pack', value: target.slice(0, target.lastIndexOf('@')) }] : []),
    ];
    return record('authorization', 'authorization@1', body, index);
  };
  for (const [account, name, role, isDisabled] of [[admin, '合成管理员', 'admin', false],
    [member, '合成成员', 'user', false], [disabled, '合成停用账户', 'user', true]] as const) {
    row('users', { id: account, name, role, disabled: isDisabled, created_at: AT, updated_at: AT,
      password_hash: passwordHash, password_must_change: account === member, password_revision: 2, deleted_at: null });
    row('user_history', { user_id: account, name, role, disabled: isDisabled, changed_by: admin,
      changed_at: AT, password_changed: true, deleted_at: null });
  }
  row('oauth_clients', { id: oauthClient, name: '合成 MCP 客户端',
    redirect_uris: ['http://127.0.0.1:49152/callback'], created_at: AT });
  row('tokens', { id: tokenId, user_id: admin, sha256: tokenSha256, label: '合成旧客户端',
    created_at: AT, created_by: admin, last_used_at: AT, revoked_at: null, revoked_by: null,
    client_id: oauthClient, console_session: false, expires_at: null });
  row('tokens', { id: id('tok', 2), user_id: member, sha256: sha256Hex('synthetic-revoked-token-hash-input'),
    label: '合成已撤回令牌', created_at: AT, created_by: admin, last_used_at: null,
    revoked_at: AT, revoked_by: admin, client_id: null, console_session: false, expires_at: null });
  row('personal_spaces', { owner: member, epoch: EPOCH, account_epoch: ACCOUNT_EPOCH, mode: 'hub' });

  const profile = SystemProfile.parse({ schema: 'system@1', title: '合成升级系统', roles: [{ name: 'api' }],
    auth: { kind: 'static_header', roles: ['api'], header: { name: 'Authorization', scheme: 'bearer' }, credential: 'access' },
    routes: [{ id: 'document', role: 'api', method: 'GET', path: '/document', response: 'json', max_bytes: 4096, read: true }],
    reads: [{ name: 'document', external: 'synthetic:document', request: { route: 'document' }, object_route: 'document' }] });
  const packs: Old33Fixture['handles']['packs'] = [];
  const product = 'synthetic-upgrade-product';
  const publish = (packId: string, kind: PackManifest['kind'], content: Record<string, unknown>): void => {
    const files = Object.entries(content).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([path, value]) => {
      const stored = object(value, path.endsWith('.md') ? 'text/markdown' : 'application/json');
      return { path, sha256: stored.sha256, size: stored.bytes.byteLength };
    });
    const manifest = PackManifest.parse({ schema: 'pack@1', id: packId, version: '1.0.0', kind,
      title: '合成升级包', description: '合成升级验收', files });
    const manifestObject = object(manifest), digest = manifestObject.sha256;
    const body: PackVersionBody = { pack: packId, version: manifest.version, kind, digest, title: manifest.title,
      description: manifest.description, manifest, publisher: admin,
      report: { samples: { total: 0, passed: 0, failed: 0,
        sources: Object.fromEntries(SAMPLE_SOURCE.map(source => [source, 0])) as PackVersionBody['report']['samples']['sources'] },
      checks: [], failures: [], unsampled: [], warnings: [] } };
    const saved = record('pack_version', 'pack_version@1', body, [{ key: 'pack.id', value: packId },
      { key: 'pack.version', value: packId + '@1.0.0' }, { key: 'pack.digest', value: digest }, { key: 'pack.kind', value: kind }]);
    authorize('publish', admin, packId + '@1.0.0', digest);
    authorize('assign', '*', packId, null);
    authorize('assign', member, packId, null);
    packs.push({ id: packId, version: manifest.version, digest, record: saved.digest });
  };
  publish('synthetic-upgrade-skill', 'skill', { 'SKILL.md': '# 合成升级技能\n', 'skill.json': { schema: 'skill@1', parsers: [] } });
  publish('synthetic-upgrade-system', 'system', { 'system.json': profile });
  publish(product, 'product', { 'product.json': ProductDeclaration.parse({ schema: 'product@1', id: product,
    title: '合成升级产品', names: ['Synthetic upgrade product'], catalogs: [],
    producers: [{ id: 'synthetic', title: '合成知识', function: { module: 'functions/produce.ts' },
      inputs: { manual: { source: 'manual' } } }] }),
  'functions/produce.ts': 'export default function produce() { return { entries: [] }; }\n' });
  const systemPack = packs[1]!;
  const productPack = packs[2]!;
  const resourceId = id('res', 1), executorId = id('exe', 1), origin = options.resourceOrigin ?? 'https://192.0.2.10';
  const resourceDefinition = ResourceRecord.parse({ schema: 'resource@1', id: resourceId,
    system_pack: systemPack.id + '@1.0.0', system_pack_digest: systemPack.digest, name: '合成升级资源',
    environment: 'test', origins: { api: origin }, allow_plaintext: origin.startsWith('http:') ? [new URL(origin).origin] : [],
    credentials: { access: '${secret:SYNTHETIC_ACCESS}' }, credential_digests: { access: 'plain' },
    settings: { label: '合成资源' }, created_by: admin, created_at: AT });
  const resourceObject = object(resourceDefinition);
  const resourceDecision = authorize('resource_config', '*', resourceId, resourceObject.sha256);
  const executorDefinition = ExecutorSource.parse(executorSource(executorId));
  const executorObject = object(executorDefinition);
  const executorDecision = authorize('resource_config', '*', 'executor.' + executorId, executorObject.sha256);
  const variableName = 'SYNTHETIC_LABEL';
  const variableObject = object({ schema: 'variable@1', name: variableName, value: '合成部署变量' });
  const variableDecision = authorize('resource_config', '*', 'var:' + variableName, variableObject.sha256);
  const secrets: Old33Fixture['handles']['secrets'] = [];
  let previous: string | null = null;
  for (const version of [1, 2]) {
    const entry = 'secret.synthetic_access.' + version.toString(16).padStart(24, '0');
    const metadata = object({ schema: 'secret@1', name: 'SYNTHETIC_ACCESS', entry, digest_rule: 'plain', length: 24,
      consumers: [{ definition: resourceId, item: 'access', sends_to: digestOf({ origins: resourceDefinition.origins,
        allow_plaintext: resourceDefinition.allow_plaintext }) }] });
    const decision = authorize('resource_config', '*', 'secret:SYNTHETIC_ACCESS', metadata.sha256, previous);
    previous = decision.digest;
    secrets.push({ name: 'SYNTHETIC_ACCESS', version, entry, object: metadata.sha256, decision: decision.digest, digestRule: 'plain' });
  }

  const capture = (stored: FixtureObject, scope?: FixtureScope): FixtureRecord<SourceArtifactBody> => {
    const body: SourceArtifactBody = { sha256: stored.sha256, size: stored.bytes.byteLength, media_type: stored.mediaType,
      name: scope ? '合成个人原件' : '合成公共原件', origin: { upload: { session: 'synthetic-upgrade', message: 'source' } },
      author: { user: scope?.owner ?? admin, declared: '合成作者' }, captured_at: AT, provenance_type: 'declared',
      read_tier: 'model_readable', requested_read_tier: 'model_readable',
      visibility: { admins: !scope, readers: [scope?.owner ?? admin], packs: [], shareable: !scope },
      scan: { scanner: 'credential-scan@4', inspected: false, clean: false, findings: [], truncated: false },
      ...(scope ? { personal_scope: scope } : {}) };
    return record('source_artifact', 'source_artifact@1', body, [{ key: 'artifact.sha256', value: stored.sha256 },
      { key: 'artifact.author', value: scope?.owner ?? admin }], scope);
  };
  const sourceObject = object('合成产品知识原件\n', 'text/plain');
  const source = capture(sourceObject);
  const entryContent = { kind: 'definition', statement: '合成产品知识', data: {}, applicability: null };
  record('tree_node', 'knowledge-entry@1', KnowledgeEntryBody.parse({ product, ...entryContent }),
    [{ key: 'knowledge.entry', value: digestOf(entryContent) }, { key: 'knowledge.entry.product', value: product }]);
  const nodeContent = { name: '', children: [], entries: [digestOf(entryContent)] };
  const root = digestOf(nodeContent);
  record('tree_node', 'tree_node@1', TreeNodeBody.parse({ ...nodeContent, height: 0, level: 'leaf' }),
    [{ key: 'knowledge.node', value: root }]);
  const composition = record('tree_root', 'tree_root@1', TreeRootBody.parse({ product,
    version: { line: '1.0', build: 'synthetic-1', family: 'synthetic', platform: null },
    build: { name: 'synthetic-1', family: 'synthetic', line: '1.0', base: 'synthetic-1', platform: null,
      built_at: null, released_at: null, sources: { manual: 'synthetic:document:one' } }, root,
    producer: { pack: productPack.id, version: '1.0.0', digest: productPack.digest, id: productPack.id + '@1.0.0',
      producers: [{ id: 'synthetic', function: { module: 'functions/produce.ts' } }] },
    sources: [{ producer: 'synthetic', slot: 'manual', external: 'synthetic:document:one', revision: null,
      sha256: sourceObject.sha256, size: sourceObject.bytes.byteLength, media_type: 'text/plain', parser: 'text@1',
      artifact: source.digest, read_tier: 'model_readable', basis: 'declared', decided_by: productPack.id + '@1.0.0' }],
    composition: [{ path: '/', entry: digestOf(entryContent), kind: 'definition', producers: ['synthetic'],
      fragments: ['src:' + sourceObject.sha256], basis: 'declared', decided_by: productPack.id + '@1.0.0' }],
    unplaced: [], refused: [], refused_count: 0, catalogs: [],
    counts: { nodes: 1, entries: 1, placed_by_model: 0, unplaced: 0 }, warnings: [], warnings_count: 0, produced_at: AT }),
  [{ key: 'knowledge.root', value: root }, { key: 'knowledge.root.product', value: product }]);
  const pointer = 'knowledge/' + product + '/1.0';
  const move = record('action', 'action@1', { action: 'move_root', run: null, item: null, inputs: [composition.digest],
    component: 'knowledge@1', lease: null, started_at: AT, ended_at: AT, result: 'completed', error_code: null,
    acceptance: null, codes: [], detail: { pointer, target: root } });
  record('root_pointer', 'root_pointer@1', RootPointerBody.parse({ product, line: '1.0', pointer, expected: null, root,
    build: 'synthetic-1', composition: composition.digest, move: move.digest, version: 1, cause: null }),
  [{ key: 'knowledge.pointer', value: pointer }, { key: 'knowledge.pointer.move', value: move.digest }]);
  row('pointers', { name: pointer, target: root, version: 1, moved_at: AT, action_digest: move.digest });

  const spaces: Old33Fixture['handles']['spaces'] = [];
  for (const space of ['team', member]) {
    const scope = space === 'team' ? undefined : { owner: member, epoch: EPOCH };
    const personalFields = scope ? { personal_epoch: EPOCH } : {};
    const original = space === 'team' ? source : capture(object('合成个人知识原件\n', 'text/plain', scope), scope);
    const content = { kind: 'observation', statement: space === 'team' ? '合成公共知识' : '合成个人知识', data: {}, applicability: null };
    const entryDigest = digestOf(content);
    const spaceEntry = record('knowledge_space_entry', 'knowledge-space-entry@1', SpaceEntryBody.parse({ ...personalFields,
      space, entry: entryDigest, content, grounds: [{ reference: 'src:' + original.body.sha256, quotation: '合成' }],
      status: 'unverified', by: scope?.owner ?? admin, at: AT, session: null, replaces: null }),
    [{ key: 'knowledge.space.entry', value: entryDigest }, { key: 'knowledge.space.entry_owner', value: space }], scope);
    const association = record('knowledge_space_source', 'knowledge-space-source@1', SpaceSourceBody.parse({ ...personalFields,
      space, path: '/', sha256: original.body.sha256, artifact: original.digest, size: original.body.size, by: scope?.owner ?? admin, at: AT }),
    [{ key: 'knowledge.space.source', value: space }, { key: 'knowledge.space.source_hash', value: original.body.sha256 }], scope);
    const tree = object({ name: '', children: [], entries: [entryDigest] }, 'application/json', scope);
    const version = record('knowledge_space_version', 'knowledge-space-version@1', SpaceVersionBody.parse({ ...personalFields,
      space, parent: null, tree: tree.sha256, directories: ['/'], entries: [{ path: '/', entry: entryDigest,
        record: spaceEntry.digest, status: 'unverified' }], sources: [association.digest], products: [],
      by: scope?.owner ?? admin, at: AT, reason: '合成升级知识', used_bytes: 1024 }),
    [{ key: 'knowledge.space.version', value: space }], scope);
    const intent = digestOf(['synthetic-memory', space]);
    const memory = record('memory_document', 'memory-document@1', MemoryDocumentBody.parse({ ...personalFields,
      space, by: scope?.owner ?? admin, at: AT, intent }), [{ key: 'memory.document.space', value: space }], scope);
    const markdown = space === 'team' ? '合成公共记忆' : '合成个人记忆';
    const memoryVersion = record('memory_version', 'memory-version@1', MemoryVersionBody.parse({ ...personalFields,
      document: memory.digest, space, parent: null, title: '合成记忆', path: '/', state: 'enabled',
      bytes: Buffer.byteLength(markdown), markdown, content_version: null, by: scope?.owner ?? admin, at: AT,
      intent, payload: digestOf({ markdown }) }), [{ key: 'memory.version.document', value: memory.digest },
      { key: 'memory.version.space', value: space }], scope, false, intent);
    row('memory_heads', { document: memory.digest, space, version: memoryVersion.digest, path: '/', state: 'enabled',
      bytes: Buffer.byteLength(markdown), context_bytes: Buffer.byteLength(markdown) });
    row('memory_space_usage', { space, active_bytes: Buffer.byteLength(markdown), history_bytes: Buffer.byteLength(markdown), active_documents: 1 });
    spaces.push({ space, entry: spaceEntry.digest, version: version.digest, source: association.digest,
      memory: memory.digest, memoryVersion: memoryVersion.digest });
  }
  const run = id('run', 1), lease = id('lse', 1), key = 'synthetic/device/reserved';
  row('lease_registrations', { prefix: 'synthetic/device/', owner: 'synthetic-upgrade', registered_at: AT });
  row('leases', { key, lease_id: lease, run_id: run, user_id: member, token: 7, acquired_at: AT, expires_at: null, released_at: null });
  row('leases', { key: 'synthetic/device/timed', lease_id: id('lse', 2), run_id: id('run', 90), user_id: member,
    token: 9, acquired_at: AT, expires_at: '2099-01-01T00:00:00.000Z', released_at: null });
  row('leases', { key: 'synthetic/device/released', lease_id: id('lse', 3), run_id: id('run', 91), user_id: member,
    token: 11, acquired_at: AT, expires_at: null, released_at: AT });
  row('leases', { key: 'synthetic/device/expired', lease_id: id('lse', 4), run_id: id('run', 92), user_id: member,
    token: 13, acquired_at: AT, expires_at: AT, released_at: null });
  for (const kind of ['run', 'submission', 'validation_result', 'request'] as const) {
    record(kind, 'synthetic-upgrade-history@1', { run, by: member, started_at: AT, pack: packs[0]!.id, sources: [] },
      kind === 'run' ? [{ key: 'runs.id', value: run }, { key: 'runs.started', value: AT + ' ' + run }] : [], undefined, true);
  }
  const call = record('call_log', 'synthetic-upgrade-history@1', { at: AT, user: member, run, tool: 'list_task_packs' }, [], undefined, true);
  row('call_logs', { digest: call.digest, at: AT, trace_id: '1'.repeat(32), span_id: '2'.repeat(16), user_id: member,
    session_id: 'synthetic-upgrade', tool: 'list_task_packs', run_id: run, args_digest: digestOf({}), args_size: 2,
    args_preview: null, call_result: 'completed', acceptance: null, error_code: null, duration_ms: 1 });
  row('call_notes', { digest: call.digest, note: '合成历史说明', at: AT });
  row('call_reasons', { digest: call.digest, ordinal: 0, note: '合成完整原因', at: AT });
  row('trace_spans', { trace_id: '1'.repeat(32), span_id: '2'.repeat(16), parent_span_id: null, is_root: true,
    name: 'synthetic-upgrade', type: 'tool', started_at: AT, ended_at: AT, level: 'info', status_message: null,
    origin: 'hub', user_id: member, session_id: 'synthetic-upgrade', run_id: run, client_name: 'synthetic',
    client_version: '1.0.0', release: 'synthetic', environment: 'test', usage: {}, client_platform: null });

  return { at: AT, admin, member, oauthClient, tokenId, tokenSha256, rows, objects, records, retained, archived,
    handles: { packs, resource: { id: resourceId, object: resourceObject.sha256, decision: resourceDecision.digest },
      executor: { id: executorId, object: executorObject.sha256, decision: executorDecision.digest },
      variable: { name: variableName, object: variableObject.sha256, decision: variableDecision.digest }, secrets,
      product: { id: product, root, composition: composition.digest, pointer, source: source.digest }, spaces,
      reservation: { key, lease, run } } };
}

function executorSource(executorId: string): unknown {
  return { schema: 'executor@1', id: executorId, environment: 'test', target: 'synthetic-upgrade-bed', enabled: true,
    credential: '${secret:SYNTHETIC_ACCESS}', endpoint: 'http://127.0.0.1:49153/mcp', ca: '', resources: ['synthetic/device/reserved'],
    max_run_ms: 10000, allowed_tools: ['acquire', 'heartbeat', 'release', 'precheck', 'submit', 'status', 'result'],
    payload_argument: '/payload', calls: {
      acquire: { tool: 'acquire', arguments: {} }, heartbeat: { tool: 'heartbeat', arguments: {} },
      release: { tool: 'release', arguments: {} }, precheck: { tool: 'precheck', arguments: {} },
      submit: { tool: 'submit', arguments: { request: { $value: 'request_id' }, sequence: { $value: 'dispatch_sequence' },
        scope: { $value: 'sequence_scope' }, payload: { $value: 'payload_base64' } } },
      status: { tool: 'status', arguments: {} }, result: { tool: 'result', arguments: {} } },
    lease: { id: '/id', token: '/token', ttl_ms: '/ttl', acceptance: '/ok', map: { true: 'accepted', false: 'not_accepted' } },
    receipt: { request_id: '/request', acceptance: '/ok', map: { true: 'accepted', false: 'not_accepted' }, id: '/id', sha256: '/sha256', items: '/items' },
    status: { pointer: '/state', map: { done: { action_result: 'completed', effect_outcome: 'effective' } } },
    result: { id: '/id', sha256: '/sha256', submitted_at: '/at', items: '/items', item_id: '/id', item_outcome: '/outcome',
      complete: '/complete', map: { pass: 'pass', fail: 'fail' } }, conditions: [],
    proof: { package: 'synthetic-upgrade-workflow', manifest_sha256: '/manifest', requirement: 'synthetic', slot: 'synthetic',
      plan_run: '/run', sha256: '/sha256', items: '/items', target: '/target', build: '/build', generator: '/generator' } };
}

/** Inserts into a caller-owned fresh old33 schema. Objects and vault files stay under the caller's control. */
export async function seedOld33Fixture(session: Pick<SqlSession, 'query'>, fixture: Old33Fixture): Promise<void> {
  const insert = async (table: string, values: Record<string, unknown>): Promise<void> => {
    const columns = Object.keys(values);
    await session.query(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map((_, n) => '$' + (n + 1)).join(',')})`, Object.values(values));
  };
  await session.query('BEGIN');
  try {
    const before = new Set(['users', 'user_history', 'oauth_clients', 'tokens', 'personal_spaces']);
    // Account history can refer to the administrator, so insert all accounts before their audit rows.
    for (const table of ['users', 'user_history', 'oauth_clients', 'tokens', 'personal_spaces'])
      for (const row of fixture.rows.filter(row => row.table === table)) await insert(row.table, row.values);
    for (const item of fixture.objects) {
      await session.query('INSERT INTO objects(sha256,size,media_type,created_at) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
        [item.sha256, item.bytes.byteLength, item.mediaType, fixture.at]);
      if (item.scope) {
        await insert('personal_payloads', { ...item.scope, sha256: item.sha256, data: Buffer.from(item.bytes) });
        await insert('personal_objects', { ...item.scope, sha256: item.sha256 });
      }
    }
    for (const item of fixture.records) {
      const body = canonicalize(item.body), size = Buffer.byteLength(body);
      let storedBody = body;
      if (item.scope) {
        const sha256 = sha256Hex(body);
        const proof = sha256Hex([item.digest, sha256, item.scope.owner, item.scope.epoch, size,
          item.created_at, item.kind, item.provenance, item.schema].join(':'));
        storedBody = canonicalize({ personal_payload: sha256, ...item.scope, record: item.digest, proof });
        await session.query('INSERT INTO personal_payloads(owner,epoch,sha256,data) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
          [item.scope.owner, item.scope.epoch, sha256, Buffer.from(body)]);
        await insert('personal_record_bindings', { record: item.digest, ...item.scope, sha256, bytes: size, marker: storedBody, proof });
      }
      const result = await session.query(`INSERT INTO records(id,digest,kind,schema,provenance,created_at,body,size)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING seq`,
      [item.id, item.digest, item.kind, item.schema, item.provenance, item.created_at, storedBody, size]);
      for (const entry of item.index) await insert('record_index', { ...entry, digest: item.digest, record_seq: result[0]!.seq });
      if (item.uniqueKey) await insert('record_keys', { kind: item.kind, key: item.uniqueKey, digest: item.digest });
    }
    for (const row of fixture.rows.filter(row => !before.has(row.table))) await insert(row.table, row.values);
    await session.query('COMMIT');
  } catch (error) {
    await session.query('ROLLBACK');
    throw error;
  }
}

/** Writes shared object bytes only; personal objects remain in scoped database payloads. */
export async function writeOld33Objects(root: string, fixture: Old33Fixture): Promise<void> {
  for (const item of fixture.objects.filter(item => !item.scope)) {
    const directory = join(root, item.sha256.slice(0, 2));
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, item.sha256), item.bytes, { flag: 'wx', mode: 0o600 });
  }
}

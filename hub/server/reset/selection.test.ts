import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyCurrentRecord, currentRecordReferences, partitionRunOriginals, RECORD_HOLDER_COLUMNS, resolveCurrentRecordScopes, resourceDefinitionReferences, selectCurrentRecords, type CurrentRecord } from './selection.ts';

const hash = (n: number): string => n.toString(16).padStart(64, '0');
const at = '2026-11-13T00:00:00.000Z';
const user = 'usr_' + '0'.repeat(25) + '1';
const record = (n: number, kind: string, schema: string, body: unknown): CurrentRecord => ({ digest: hash(n), kind, schema, body });
const call = (n: number): CurrentRecord => record(n, 'call_log', 'call_log@1', {
  at, trace_id: '1'.repeat(32), span_id: '2'.repeat(16), user, session: null, tool: 'list_task_packs', run: null,
  args_digest: hash(99), args_size: 2, args_preview: null, call_result: 'ok', acceptance: null, error_code: null, duration_ms: 1,
});
const action = (component: string, action = 'read', detail = {}) => ({ action, component, detail,
  run: null, item: null, inputs: [], lease: null, started_at: at, ended_at: at, result: 'completed',
  error_code: null, acceptance: null, codes: [] });
const authorization = (n: number, permission: string, bound: string | null = null): CurrentRecord => record(n, 'authorization', 'authorization@1', {
  permission, subject: user, object: permission === 'publish' ? 'synthetic-pack@1.0.0' : 'synthetic-pack', bound,
  revoked: false, decided_by: user, decided_at: at, expires_at: null, note: '合成决定', supersedes: null,
});
const artifact = (n: number, bytes: string, origin: unknown = { upload: { session: 'synthetic', message: 'source' } }): CurrentRecord =>
  record(n, 'source_artifact', 'source_artifact@1', { sha256: bytes, size: 1, media_type: 'text/plain', name: '合成原件', origin,
    author: { user }, captured_at: at, provenance_type: 'declared', read_tier: 'model_readable',
    visibility: { readers: [user], admins: true, packs: [], shareable: false },
    scan: { scanner: 'credential-scan@4', inspected: false, clean: false, findings: [], truncated: false } });

test('current kind and exact schema classify the four scopes without matching prose', () => {
  assert.equal(classifyCurrentRecord(call(1)), 'history');
  assert.equal(classifyCurrentRecord(authorization(2, 'publish', hash(20))), 'packs');
  assert.equal(classifyCurrentRecord(authorization(3, 'assign')), 'config');
  assert.equal(classifyCurrentRecord(record(4, 'memory_document', 'memory-document@1', { space: 'team', by: user, at, intent: hash(30) })), 'knowledge');
  assert.equal(classifyCurrentRecord(record(5, 'call_log', 'call_log@2', (call(1).body))), null);
  assert.equal(classifyCurrentRecord(record(6, 'run_like_words', 'call_log@1', call(1).body)), null);
  assert.equal(classifyCurrentRecord(record(7, 'memory_document', 'memory-document@1', { run: 'run_' + '0'.repeat(26), text: 'knowledge history config packs' })), null);
});

test('current actions use component identities and the declared lease operation', () => {
  assert.equal(classifyCurrentRecord(record(1, 'action', 'action@1', action('knowledge.sync@1'))), 'knowledge');
  assert.equal(classifyCurrentRecord(record(2, 'action', 'action@1', action('runs.engine@1', 'validate'))), 'history');
  assert.equal(classifyCurrentRecord(record(3, 'action', 'action@1', action('leases@1', 'lease', { op: 'register' }))), 'config');
  assert.equal(classifyCurrentRecord(record(4, 'action', 'action@1', action('leases@1', 'lease', { op: 'acquire' }))), 'history');
  assert.equal(classifyCurrentRecord(record(5, 'action', 'action@1', action('contains-knowledge.sync@1'))), null);
  assert.equal(classifyCurrentRecord(record(6, 'action', 'action@1', action('leases@1', 'lease', { op: 'future_op' }))), null);
  assert.equal(classifyCurrentRecord(record(7, 'action', 'action@1', action('records.pointers@1', 'move_root', { pointer: 'knowledge/synthetic/1.0' }))), 'knowledge');
  assert.equal(classifyCurrentRecord(record(8, 'action', 'action@1', action('records.pointers@1', 'move_root', { pointer: 'other/synthetic' }))), null);
});

test('unknown records block selection instead of falling into history', () => {
  const unknown = record(1, 'claim', 'claim@1', { statement: { text: 'run history' } });
  const selected = selectCurrentRecords([unknown, call(2)], new Set(['history']));
  assert.deepEqual(selected.cleared, [hash(2)]);
  assert.deepEqual(selected.retained, []);
  assert.equal(selected.blocked.length, 1);
  assert.equal(selected.blocked[0]!.row, 1);
  assert.equal(selected.blocked[0]!.name, hash(1));
});

test('a retained current record formally referencing cleared history blocks without expanding scope', () => {
  const history = call(1);
  const kept = artifact(2, hash(40), { read: { object: 'synthetic:document:one', action: history.digest } });
  const selected = selectCurrentRecords([history, kept], new Set(['history']), {
    sourceScopes: new Map([[kept.digest, ['knowledge']]]),
    objectScopes: new Map([[hash(40), ['knowledge']]]), objectReferences: new Map([[hash(40), []]]),
  });
  assert.deepEqual(selected.cleared, [history.digest]);
  assert.deepEqual(selected.retained, [kept.digest]);
  assert.equal(selected.blocked.length, 1);
  assert.match(selected.blocked[0]!.reason, /\/origin\/read\/action/);
});

test('missing objects and unknown internal object references remain blocked', () => {
  const kept = authorization(1, 'resource_config', hash(20));
  assert.equal(selectCurrentRecords([kept], new Set()).blocked.length, 1);
  assert.equal(selectCurrentRecords([kept], new Set(), { objectScopes: new Map([[hash(20), ['config']]]) }).blocked.length, 1);
  const selected = selectCurrentRecords([kept], new Set(), {
    objectScopes: new Map([[hash(20), ['config']]]), objectReferences: new Map([[hash(20), []]]),
  });
  assert.deepEqual(selected.blocked, []);
});

test('a kept configuration object pointing to a cleared pack is blocked through declared object edges', () => {
  const config = authorization(1, 'resource_config', hash(20));
  const selected = selectCurrentRecords([config], new Set(['packs']), {
    objectScopes: new Map([[hash(20), ['config']], [hash(21), ['packs']]]),
    objectReferences: new Map([[hash(20), [{ kind: 'object', digest: hash(21), field: '/system_pack_digest' }]]]),
  });
  assert.equal(selected.blocked.length, 1);
  assert.match(selected.blocked[0]!.reason, /\/system_pack_digest/);
  assert.deepEqual(selected.retained, [config.digest]);
  assert.deepEqual(selected.cleared, []);
});

test('shared object holders and content aliases preserve explicit current references', () => {
  const history = call(1), config = authorization(2, 'resource_config', hash(20));
  const selected = selectCurrentRecords([history, config], new Set(['knowledge']), {
    objectScopes: new Map([[hash(20), ['knowledge', 'config']]]), objectReferences: new Map([[hash(20), [{ kind: 'record', digest: hash(30), field: '/receipt' }]]]),
    recordAliases: new Map([[hash(30), history.digest]]),
  });
  assert.deepEqual(selected.blocked, []);
  assert.deepEqual(selected.cleared, []);
});

test('run ids in opaque fields and reference-shaped prose are not record foreign keys', () => {
  const value = record(1, 'action', 'action@1', { ...action('leases@1', 'lease', { op: 'acquire', holder: { run: 'run_' + '0'.repeat(26) } }),
    run: 'run_' + '1'.repeat(26), text: 'rec:' + hash(99) });
  assert.deepEqual(currentRecordReferences(value), []);
  assert.deepEqual(selectCurrentRecords([value], new Set(['config'])).blocked, []);
});

test('run_originals partitions by held_by including public knowledge holders', () => {
  const rows = [{ held_by: hash(1), artifact: hash(50) }, { held_by: hash(2), artifact: hash(51) }, { held_by: hash(3), artifact: hash(52) }];
  const selected = partitionRunOriginals(rows, { retained: [hash(2)], cleared: [hash(1)] });
  assert.deepEqual(selected.cleared, [rows[0]]);
  assert.deepEqual(selected.retained, [rows[1]]);
  assert.equal(selected.blocked.length, 1);
  assert.equal(selected.blocked[0]!.row, 3);
  assert.equal(RECORD_HOLDER_COLUMNS.run_upload_declarations, 'run_record');
});

test('named document moves use object targets and configuration while reads are history', () => {
  const move = record(1, 'action', 'action@1', { ...action('server.docs@1', 'move_root', { pointer: 'doc:synthetic', expected: hash(30), next: hash(31), previous_action: hash(32) }), inputs: [hash(30), hash(31)] });
  const read = record(2, 'action', 'action@1', action('server.docs@1', 'read', { external: 'doc:doc:synthetic', sha256: hash(31) }));
  assert.equal(classifyCurrentRecord(move), 'config');
  assert.equal(classifyCurrentRecord(read), 'history');
  assert.equal(currentRecordReferences(move).find(edge => edge.field === '/inputs/0')!.kind, 'object');
  assert.equal(currentRecordReferences(move).find(edge => edge.field === '/detail/previous_action')!.kind, 'record');
  const arbitrary = record(3, 'action', 'action@1', { ...action('runs.engine@1'), inputs: [hash(90)] });
  assert.deepEqual(currentRecordReferences(arbitrary), []);
  assert.match(selectCurrentRecords([arbitrary], new Set()).blocked[0]!.reason, /裸摘要目标类型/);
});

test('ordinary sources inherit exact formal holders and shared holders prevent an overbroad clear', () => {
  const source = artifact(1, hash(40));
  const history = { ...call(2), references: [{ kind: 'record' as const, digest: source.digest, field: '/source' }] };
  const knowledge = record(3, 'memory_document', 'memory-document@1', { space: 'team', by: user, at, intent: hash(50) });
  knowledge.references = [{ kind: 'record', digest: source.digest, field: '/source' }];
  assert.equal(classifyCurrentRecord(source), null);
  const runtimeOwners = resolveCurrentRecordScopes([source, history]);
  assert.deepEqual(runtimeOwners.get(source.digest), ['history']);
  assert.deepEqual(selectCurrentRecords([source, history], new Set(['history'])).blocked, []);
  const selected = selectCurrentRecords([source, history, knowledge], new Set(['history']), {
    objectScopes: new Map([[hash(40), ['history', 'knowledge']]]), objectReferences: new Map([[hash(40), []]]),
  });
  assert.ok(selected.retained.includes(source.digest));
  assert.deepEqual(selected.cleared, [history.digest]);
  assert.deepEqual(selected.blocked, []);
});

test('document source provenance requires its current configuration holder and read copies stay history', () => {
  const source = artifact(1, hash(40), { read: { object: 'doc:doc:synthetic@' + hash(40) } });
  source.indices = [{ key: 'artifact.object', value: 'doc:doc:synthetic@' + hash(40) }];
  const copy = artifact(2, hash(41), { generated: { generator: 'server.docs@1', inputs: ['src:' + hash(40)] } });
  assert.deepEqual(resolveCurrentRecordScopes([source]).get(source.digest), undefined);
  const owners = resolveCurrentRecordScopes([source, copy], { objectScopes: new Map([[hash(40), ['config']]]) });
  assert.deepEqual(owners.get(source.digest), ['config']);
  assert.deepEqual(owners.get(copy.digest), ['history']);
});

test('private pack captured files are record edges and manifest files are object edges', () => {
  const value = record(1, 'personal_pack_version', 'personal-pack-version@1', { digest: hash(20),
    manifest: { files: [{ path: 'SKILL.md', sha256: hash(21) }] }, files: { 'SKILL.md': hash(22) } });
  assert.equal(currentRecordReferences(value).find(edge => edge.field === '/files/SKILL.md')!.kind, 'record');
  assert.equal(currentRecordReferences(value).find(edge => edge.field === '/manifest/files/0/sha256')!.kind, 'object');
});

test('an unavailable current observation is not labelled as schema incompatibility', () => {
  const unavailable = { ...call(1), available: false };
  const selected = selectCurrentRecords([unavailable], new Set(['history']));
  assert.equal(selected.blocked.length, 1);
  assert.match(selected.blocked[0]!.reason, /不可读取/);
  assert.doesNotMatch(selected.blocked[0]!.reason, /模式/);
  assert.deepEqual(selected.cleared, []);
});

test('memory content is knowledge while directory grants, memory grants and quota are configuration', () => {
  const grant = { space: user, path: '/', audience: 'member', member: user, action: 'grant', by: user, at };
  assert.equal(classifyCurrentRecord(record(1, 'knowledge_space_grant', 'knowledge-space-grant@1', grant)), 'config');
  assert.equal(classifyCurrentRecord(record(2, 'knowledge_space_quota', 'knowledge-space-quota@1', { space: 'team', bytes: 1000, by: user, at })), 'config');
  assert.equal(classifyCurrentRecord(record(3, 'memory_grant', 'memory-grant@1', { ...grant, intent: hash(20) })), 'config');
  assert.equal(classifyCurrentRecord(record(4, 'memory_document', 'memory-document@1', { space: 'team', by: user, at, intent: hash(21) })), 'knowledge');
});

test('current feeding claims validate their exact nested schema instead of matching a run field', () => {
  const claim = (feeding: unknown) => ({ statement: { text: '合成声明', data: { feeding, run: 'run_' + '0'.repeat(26) } },
    grounds: [], warrant: { producer: 'function', id: 'synthetic@1', independence: 'judge_not_author' },
    qualifier: { nature: 'fact', provenance: 'projected', basis_rank: 'rule_over_observation', marks: [] },
    validity: { status: 'valid', bound: [], premises: [] } });
  assert.equal(classifyCurrentRecord(record(1, 'claim', 'claim@1', claim({ schema: 'usage@1', object: hash(20), run: 'run_' + '0'.repeat(26), line: null, at }))), 'history');
  assert.equal(classifyCurrentRecord(record(2, 'claim', 'claim@1', claim({ schema: 'fed-note@1', object: hash(20), product: null,
    root: null, path: null, source: { system: 'upload', bytes: hash(20) }, by: user, run: 'run_' + '0'.repeat(26) }))), 'knowledge');
  assert.equal(classifyCurrentRecord(record(3, 'claim', 'claim@1', claim({ schema: 'feeding-offset@1', run: 'run_' + '0'.repeat(26), root: null, offset: 0 }))), null);
  assert.equal(classifyCurrentRecord(record(4, 'claim', 'feeding-offset@1', { schema: 'feeding-offset@1', run: 'run_' + '0'.repeat(26), root: null, offset: 0 })), 'history');
});

test('knowledge references include parts, producer records and non-placeholder build records', () => {
  const value = record(1, 'tree_root', 'tree_root@1', { root: hash(20), producer: { digest: hash(21) },
    known_builds: [{ name: 'synthetic-placeholder', record: hash(0) }, { name: 'synthetic-build', record: hash(22) }],
    variables: [{ decision: hash(23) }], composition: [{ entry: hash(24), fragments: ['src:' + hash(25) + '/text@1/l/1'] }],
    unplaced: [], sources: [], parts: { composition: [{ record: hash(26) }], unplaced: [], sources: [] } });
  const references = currentRecordReferences(value);
  assert.equal(references.find(edge => edge.field === '/root')!.recordAlias, true);
  assert.equal(references.find(edge => edge.field === '/producer/digest')!.recordAlias, true);
  assert.equal(references.some(edge => edge.field === '/known_builds/0/record'), false);
  assert.equal(references.find(edge => edge.field === '/known_builds/1/record')!.digest, hash(22));
  assert.equal(references.find(edge => edge.field === '/parts/composition/0/record')!.digest, hash(26));
  assert.equal(references.find(edge => edge.field === '/composition/0/fragments/0')!.kind, 'object');
  const pointer = record(2, 'root_pointer', 'root_pointer@1', { root: hash(20), expected: hash(0), composition: hash(30), move: hash(31), cause: 'run_' + '0'.repeat(26) });
  assert.equal(currentRecordReferences(pointer).find(edge => edge.field === '/composition')!.recordAlias, false);
  assert.ok(currentRecordReferences(pointer).some(edge => edge.field === '/expected' && edge.digest === hash(0)), 'zero is special only in known_builds[].record');
});

test('explicitly retained physical objects still expose their typed pack record dependencies', () => {
  const config = authorization(1, 'resource_config', hash(20));
  const pack = record(2, 'pack_version', 'pack_version@1', { pack: 'synthetic-pack', version: '1.0.0', kind: 'skill', digest: hash(21),
    publisher: user, report: {}, manifest: { schema: 'pack@1', id: 'synthetic-pack', version: '1.0.0', kind: 'skill',
      title: '合成包', description: '合成范围测试', files: [{ path: 'SKILL.md', sha256: hash(22), size: 1 }, { path: 'skill.json', sha256: hash(23), size: 1 }] } });
  const selected = selectCurrentRecords([config, pack], new Set(['packs']), {
    retainedObjects: new Set([hash(20), hash(21)]),
    objectReferences: new Map([[hash(20), [{ kind: 'record', digest: hash(21), field: '/system_pack_digest', recordAlias: true }]], [hash(21), []]]),
    recordAliases: new Map([[hash(21), pack.digest]]),
  });
  assert.equal(selected.blocked.length, 1);
  assert.match(selected.blocked[0]!.reason, /\/system_pack_digest/);
});

test('content identities require an alias even if the same string is a current record digest', () => {
  const config = authorization(1, 'assign'), history = call(2);
  config.references = [{ kind: 'record', digest: history.digest, field: '/declared-content', recordAlias: true }];
  assert.equal(selectCurrentRecords([config, history], new Set()).blocked.length, 1);
  assert.deepEqual(selectCurrentRecords([config, history], new Set(), { recordAliases: new Map([[history.digest, history.digest]]) }).blocked, []);
});

test('resource definitions yield a pack registry alias instead of only a manifest object edge', () => {
  const resource = { schema: 'resource@1', id: 'res_' + '0'.repeat(26), system_pack: 'synthetic-system@1.0.0',
    system_pack_digest: hash(20), name: '合成系统资源', environment: 'test', origins: { api: 'https://192.0.2.10' },
    allow_plaintext: [], credentials: {}, credential_digests: {}, settings: {}, created_by: user, created_at: at };
  assert.deepEqual(resourceDefinitionReferences(resource), [{ kind: 'record', digest: hash(20), field: '/system_pack_digest', recordAlias: true }]);
  assert.equal(resourceDefinitionReferences({ ...resource, schema: 'resource@2' }), null);
});

test('personal-bot notification intents and receipts classify into history and audit records into config', () => {
  const intent = record(1, 'action', 'member-notification-intent@1', {
    schema: 'member-notification-intent@1',
    kind: 'dispatch',
    event: '11111111-1111-4111-8111-111111111111',
    receipt: '22222222-2222-4222-8222-222222222222',
    member: user,
    issuer: hash(20),
    channel: hash(21),
    subject: hash(22),
    sha256: hash(10),
    size: 12,
    text_sha256: hash(12),
    text_size: 12,
    file_sha256: null,
    file_size: null,
    name_sha256: null,
    write: {
      interaction: 'submit_then_read',
      effect_class: 'notification',
      retry_safety: 'unsafe',
      signing: 'service_on_behalf',
      reversible: false,
      target_key: hash(22),
      audience: user,
      evidence: { call: 'receipt', pointer: '/acknowledgment/code' },
      refusal: { stage: '/state', reached_device: '/reached_target' },
      writes_hub_records: true,
    },
  });
  const receipt = record(2, 'effect', 'member-notification-receipt@1', {
    schema: 'member-notification-receipt@1',
    member: user,
    intent: intent.digest,
    receipt: '22222222-2222-4222-8222-222222222222',
    outcome: 'issued',
    acknowledgment: { request: hash(11), code: 0 },
    reached_target: true,
    missing: null,
    next: null,
  });
  const inbound = record(3, 'action', 'member-bot-inbound@1', {
    schema: 'member-bot-inbound@1',
    kind: 'dispatch',
    request: '33333333-3333-4333-8333-333333333333',
    member: user,
    issuer: hash(20),
    subject: hash(22),
    channel: hash(21),
    platform_id_sha256: hash(23),
    text_sha256: hash(12),
    text_size: 12,
    files: [],
    at,
  });
  const identityAudit = record(4, 'action', 'member-external-identity@1', {
    schema: 'member-external-identity@1',
    action: 'bind',
    by: user,
    member: user,
    issuer: hash(20),
    subject: hash(22),
    at,
  });
  const secretAudit = record(5, 'action', 'bot-secret-change@1', {
    schema: 'bot-secret-change@1',
    action: 'set',
    slot: 'personal-bot.model',
    by: user,
    at,
  });
  assert.equal(classifyCurrentRecord(intent), 'history');
  assert.equal(classifyCurrentRecord(receipt), 'history');
  assert.equal(classifyCurrentRecord(inbound), 'history');
  assert.equal(classifyCurrentRecord(identityAudit), 'config');
  assert.equal(classifyCurrentRecord(secretAudit), 'config');
  const selected = selectCurrentRecords([intent, receipt, inbound, identityAudit, secretAudit], new Set(['history']));
  assert.deepEqual(selected.blocked, []);
  assert.deepEqual(selected.cleared, [intent.digest, receipt.digest, inbound.digest]);
});

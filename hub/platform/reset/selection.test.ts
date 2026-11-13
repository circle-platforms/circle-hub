import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyCurrentRecord, currentRecordReferences, partitionRunOriginals, RECORD_HOLDER_COLUMNS, resolveCurrentRecordScopes, selectCurrentRecords, type CurrentRecord } from './selection.ts';

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

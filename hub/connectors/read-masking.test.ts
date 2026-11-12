// The masking dictionary on a read of a business system (B02 R[11], decision 159, issue 194 step two). Synthetic injected
// responses and synthetic values; no external host is contacted.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startPostgres, type TemporaryPostgres } from '../testing/postgres.ts';
import { openConnectorKit } from './testing/kit.ts';
import { writePack } from './testing/packs.ts';
import { setSyntheticCredential } from './testing/credentials.ts';
import { MASKING_REFRESH_MS, MaskingRules, sha256Hex } from '../records/api.ts';
import { maskAnswer } from './http.ts';
import { compileMasking, MASKING_DICTIONARY_SCHEMA } from '../../contracts/src/masking.ts';

let postgres: TemporaryPostgres;
before(async () => { postgres = await startPostgres(); });
after(() => postgres?.stop());

const SECRET = 'synthetic-pass-20261112';
const BODY = JSON.stringify({ title: '合成工单', note: `设备 192.0.2.10 的登录口令 password=${SECRET}，请勿外传` });
const RULE = { name: 'device-password', label: '密码', pattern: 'password=(?<secret>[^\\s，,"]+)', ignore_case: false };

async function world(t: { after: (fn: () => Promise<void>) => void }, answer: () => Response) {
  let calls = 0;
  const kit = await openConnectorKit(postgres, { fetch: async () => { calls++; return answer(); } });
  t.after(() => kit.close());
  const handle = await writePack(kit.packRoot, { id: 'synthetic-masking', system: { schema: 'system@1', title: '合成来源', roles: [{ name: 'source' }], auth: { kind: 'none' },
    routes: [{ id: 'one', role: 'source', method: 'GET', path: '/one', response: 'json', max_bytes: 4096, read: true }, { id: 'file', role: 'source', method: 'GET', path: '/file', response: 'bytes', max_bytes: 4096, read: true }],
    reads: [{ name: 'one', external: 'fixture:item', request: { route: 'one' } }, { name: 'file', external: 'fixture:file', request: { route: 'file' } }] } });
  kit.packs.set(handle);
  const resource = await kit.connectors.admin.addResource(kit.admin, { system_pack: handle.id, name: '合成来源', environment: 'test', origins: { source: 'http://192.0.2.1' } });
  const read = (name = 'one') => kit.connectors.executeRead(resource.id, name, { id: 'sample' }, { principal: kit.user, purpose: 'synthetic masking' });
  const bytesOf = async (sha256: string) => Buffer.from((await kit.records.artifacts.source(kit.user, sha256))!.bytes!).toString('utf8');
  return { kit, read, bytesOf, calls: () => calls };
}
const json = () => new Response(BODY, { status: 200, headers: { 'content-type': 'application/json' } });

test('an answer is stored as it was sent while no rule matches it, and replaced from the first read after a rule is set', async (t) => {
  const w = await world(t, json);
  const masking = w.kit.records.masking!;
  const plain = await w.read();
  assert.ok(plain.ok, JSON.stringify(plain)); if (!plain.ok) return;
  const original = plain.artifacts.find((a) => a.name === 'one/one' || a.artifact.body.sha256 === sha256Hex(Buffer.from(BODY)))!;
  assert.equal(original.artifact.body.sha256, sha256Hex(Buffer.from(BODY)));
  assert.equal(original.artifact.body.masking, undefined, 'no dictionary, no mark: the record is what it always was');
  assert.equal(await w.bytesOf(original.artifact.body.sha256), BODY);

  const set = await masking.set(w.kit.admin, RULE, '合成设备口令不进知识');
  assert.equal(set.created, true); assert.deepEqual(set.rules, [RULE]);
  const masked = await w.read();
  assert.ok(masked.ok, JSON.stringify(masked)); if (!masked.ok) return;
  const replaced = masked.artifacts.find((a) => a.artifact.body.masking !== undefined)!;
  assert.ok(replaced, 'the answer of the business system carries the mark');
  const text = await w.bytesOf(replaced.artifact.body.sha256);
  // Only the replaced text is kept: the value is in no stored byte, and the words around it stay for the reader.
  assert.ok(!text.includes(SECRET)); assert.ok(text.includes('password=[密码已遮盖 *****]，请勿外传'));
  assert.equal(JSON.parse(text).title, '合成工单', 'a replaced JSON answer is still JSON');
  assert.equal(replaced.artifact.body.sha256, sha256Hex(Buffer.from(text)), 'the digest is of the replaced bytes');
  assert.equal(replaced.artifact.body.size, Buffer.byteLength(text));
  assert.deepEqual(replaced.artifact.body.masking, { dictionary: set.decision!.body.bound, rules: [{ rule: 'device-password', count: 1 }] });
  assert.equal(replaced.artifact.body.read_tier, 'model_readable', 'a masked answer is read like any other');
  // Nothing made from this read holds the value either: the projection, the manifest and the call log were built from the replaced answer.
  for (const artifact of masked.artifacts) assert.ok(!(await w.bytesOf(artifact.artifact.body.sha256)).includes(SECRET), artifact.name ?? '');
  for (const kind of ['action', 'source_artifact', 'call_log'] as const) for (const record of (await w.kit.records.store.list({ kind, limit: 200 })).items) {
    // The first, unmasked read keeps its own record: it was made before the rule existed and is not rewritten.
    if (kind === 'source_artifact') continue;
    assert.ok(!JSON.stringify(record.body).includes(SECRET), kind);
  }
  assert.ok(!JSON.stringify(w.kit.log).includes(SECRET));
});

test('removing the rule stops the replacement for later reads; what was stored under it stays as it is', async (t) => {
  const w = await world(t, json);
  const masking = w.kit.records.masking!;
  await masking.set(w.kit.admin, RULE, '合成设备口令不进知识');
  const first = await w.read(); assert.ok(first.ok); if (!first.ok) return;
  const kept = first.artifacts.find((a) => a.artifact.body.masking !== undefined)!;
  assert.ok(kept);
  const state = await masking.remove(w.kit.admin, 'device-password', '合成规则写错了');
  assert.deepEqual(state.rules, []);
  const second = await w.read(); assert.ok(second.ok); if (!second.ok) return;
  assert.ok(second.artifacts.every((a) => a.artifact.body.masking === undefined));
  assert.ok(second.artifacts.some((a) => a.artifact.body.sha256 === sha256Hex(Buffer.from(BODY))), 'the answer as it was sent, a record of its own');
  assert.ok(!(await w.bytesOf(kept.artifact.body.sha256)).includes(SECRET), 'the earlier record is not rewritten');
  await assert.rejects(masking.remove(w.kit.admin, 'device-password', '合成重复删除'), /没有名为 device-password 的规则/);
});

test('only an administrator reads or changes the dictionary, a bad rule changes nothing, and a reason is required', async (t) => {
  const w = await world(t, json);
  const masking = w.kit.records.masking!;
  await assert.rejects(masking.set(w.kit.user, RULE, '合成理由'), /只有管理员/);
  await assert.rejects(masking.list(w.kit.user), /只有管理员/);
  await assert.rejects(masking.set(w.kit.admin, { ...RULE, pattern: '(a+)+$' }, '合成理由'), /过慢/);
  await assert.rejects(masking.set(w.kit.admin, { ...RULE, label: '密"码' }, '合成理由'), /标签不能含/);
  await assert.rejects(masking.set(w.kit.admin, RULE, '   '), /理由必填/);
  assert.deepEqual((await masking.list(w.kit.admin)).rules, []);
  await masking.set(w.kit.admin, RULE, '合成设备口令不进知识');
  // The same name replaces the rule where it stands; another name is added after it.
  const changed = await masking.set(w.kit.admin, { ...RULE, label: '设备口令' }, '合成改标签');
  assert.equal(changed.created, false);
  await masking.set(w.kit.admin, { name: 'api-key', label: '密钥', pattern: 'sk-[a-z0-9]{12}', ignore_case: true }, '合成加密钥规则');
  assert.deepEqual((await masking.list(w.kit.admin)).rules.map((rule) => [rule.name, rule.label]), [['device-password', '设备口令'], ['api-key', '密钥']]);
});

test('bytes that are not text are stored as they were sent, whatever the rules say', async (t) => {
  const bytes = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0xfe]), Buffer.from(`password=${SECRET}`)]);
  const w = await world(t, () => new Response(bytes, { status: 200, headers: { 'content-type': 'application/zip' } }));
  await w.kit.records.masking!.set(w.kit.admin, RULE, '合成设备口令不进知识');
  const result = await w.read('file'); assert.ok(result.ok, JSON.stringify(result)); if (!result.ok) return;
  assert.ok(result.artifacts.every((a) => a.artifact.body.masking === undefined));
  assert.ok(result.artifacts.some((a) => a.artifact.body.sha256 === sha256Hex(bytes)));
});

test('one answer: text by its media type, in the charset it names, and UTF-8 once replaced', () => {
  const masking = compileMasking({ schema: MASKING_DICTIONARY_SCHEMA, rules: [RULE] });
  const dictionary = 'a'.repeat(64);
  assert.equal(maskAnswer(masking, null, Buffer.from(BODY), 'application/json'), null, 'no dictionary in force');
  assert.equal(maskAnswer(compileMasking(null), dictionary, Buffer.from(BODY), 'application/json'), null, 'no rule');
  assert.equal(maskAnswer(masking, dictionary, Buffer.from('合成：没有口令'), 'text/plain'), null, 'nothing matched: the same bytes');
  assert.equal(maskAnswer(masking, dictionary, Buffer.from(BODY), 'application/octet-stream'), null, 'not a text type');
  assert.equal(maskAnswer(masking, dictionary, Buffer.from([0xff, 0xfe, 0xfd]), 'text/plain'), null, 'does not decode: not text');
  // A GBK page: decoded in its charset, replaced, and written back as UTF-8 with the type saying so.
  const gbk = Buffer.from([0xbf, 0xda, 0xc1, 0xee, 0x20, ...Buffer.from(`password=${SECRET}`)]);
  const masked = maskAnswer(masking, dictionary, gbk, 'text/html; charset=GBK')!;
  assert.equal(Buffer.from(masked.bytes).toString('utf8'), '口令 password=[密码已遮盖 *****]');
  assert.equal(masked.mediaType, 'text/html; charset=utf-8');
  assert.deepEqual(masked.masking, { dictionary, rules: [{ rule: 'device-password', count: 1 }] });
  assert.equal(maskAnswer(masking, dictionary, Buffer.from(`password=${SECRET}`), 'text/plain; charset=UTF-8')!.mediaType, 'text/plain; charset=UTF-8');
});

test('a serving process picks up a rule another process set within the refresh time, without reading the dictionary on every answer', async (t) => {
  const w = await world(t, json);
  let clock = Date.parse('2026-11-12T00:00:00.000Z');
  // Another process over the same records, as the serving Hub is to the command line.
  const serving = new MaskingRules({ objects: w.kit.records.objects, principals: w.kit.records.principals, authorizations: w.kit.records.authorizations, now: () => new Date(clock) });
  assert.deepEqual(await serving.compiled(), { masking: (await serving.compiled()).masking, dictionary: null });
  assert.equal((await serving.compiled()).masking.rules.length, 0);
  const set = await w.kit.records.masking!.set(w.kit.admin, RULE, '合成设备口令不进知识');
  clock += MASKING_REFRESH_MS - 1;
  assert.equal((await serving.compiled()).dictionary, null, 'within the refresh time the compiled dictionary is reused');
  clock += 2;
  const refreshed = await serving.compiled();
  assert.equal(refreshed.dictionary, set.decision!.body.bound);
  assert.deepEqual(refreshed.masking.rules, [RULE]);
  // Unchanged after another refresh: the same compiled dictionary, by the digest of the decision in force.
  clock += MASKING_REFRESH_MS + 1;
  assert.equal((await serving.compiled()).masking, refreshed.masking);
  await w.kit.records.masking!.remove(w.kit.admin, 'device-password', '合成规则不再需要');
  clock += MASKING_REFRESH_MS + 1;
  assert.equal((await serving.compiled()).masking.rules.length, 0);
});

test('an answer that echoes a credential the Hub sent is not touched by the dictionary: it is kept whole for an administrator only', async (t) => {
  const token = 'Synthetic-Sent-Token-4242';
  const body = JSON.stringify({ note: `debug: received X-Api-Key ${token}` });
  const kit = await openConnectorKit(postgres, { fetch: async () => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }) });
  t.after(() => kit.close());
  const handle = await writePack(kit.packRoot, { id: 'synthetic-masking-echo', system: { schema: 'system@1', title: '合成来源', roles: [{ name: 'source' }],
    auth: { kind: 'static_header', header: { name: 'X-Api-Key', scheme: 'bearer' }, roles: ['source'], credential: 'token' },
    routes: [{ id: 'one', role: 'source', method: 'GET', path: '/one', response: 'json', max_bytes: 4096, read: true }],
    reads: [{ name: 'one', external: 'fixture:echo', request: { route: 'one' } }] } });
  kit.packs.set(handle);
  const resource = await kit.connectors.admin.addResource(kit.admin, { system_pack: handle.id, name: '合成来源', environment: 'test', origins: { source: 'http://192.0.2.1' }, credentials: { token: 'SYNTHETIC_TOKEN' }, allow_plaintext: ['http://192.0.2.1'] });
  await setSyntheticCredential(kit.records, kit.connectors, kit.admin, resource.id, 'token', token);
  // A rule that would replace only the tail of the token, leaving its head in a readable record.
  await kit.records.masking!.set(kit.admin, { name: 'tail', label: '密钥', pattern: 'Token-[0-9]{4}', ignore_case: false }, '合成规则只命中密钥的一部分');
  const result = await kit.connectors.executeRead(resource.id, 'one', { id: 'sample' }, { principal: kit.user, purpose: 'synthetic masking echo' });
  assert.ok(kit.log.some((event) => event.event === 'secret_echoed'), 'the echo is still found and the administrator is told');
  const stored = (await kit.records.store.list({ kind: 'source_artifact', limit: 50 })).items as Array<{ body: { sha256: string; read_tier: string; masking?: unknown; origin: object } }>;
  const original = stored.find((record) => 'read' in record.body.origin && record.body.sha256 === sha256Hex(Buffer.from(body)));
  assert.ok(original, 'the answer is kept as it was sent');
  assert.equal(original.body.read_tier, 'retain_only'); assert.equal(original.body.masking, undefined);
  assert.ok(stored.every((record) => record.body.masking === undefined), 'no replaced copy of it exists');
  assert.ok(!JSON.stringify(result).includes(token.slice(0, 14)), 'and nothing of the value reaches the reader');
});

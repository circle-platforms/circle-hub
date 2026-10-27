import { addSyntheticResource, setSyntheticCredential, setSyntheticCredentials } from '../../../hub/connectors/testing/credentials.ts';
// Production connector planner, sandbox and storage over temporary loopback services, with synthetic responses only.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startAgileStub, startStub, type AgileStub, type StubServer } from '../../../hub/connectors/testing/api.ts';
import type { ReadManifest } from '../../../contracts/src/resources.ts';
import { startPostgres, type TemporaryPostgres } from '../../../hub/testing/postgres.ts';
import { AGILE_ACCOUNT, agileOptions } from '../../../tests/fixtures/agile/index.ts';
import { plmReply } from '../../../tests/fixtures/plm/index.ts';
import { artifactBytes, openSystemKit, type SystemKit } from '../testing/kit.ts';

let postgres: TemporaryPostgres, kit: SystemKit, agile: AgileStub, plm: StubServer;
let writes = 0, productFailure = false;
let resourceId: string;
const products = [
  { id: 410, name: 'Synthetic / Alternate' }, { id: '411', name: 'Empty' },
  { id: 412, name: 'Both / Shared' }, { id: 413, name: 'Shared / Both' },
];
const builds = [{ id: 810, name: 'Synthetic_10_7_A', synthetic_links: [910001, ' 00910002 ' ] }];
const reply = (json: unknown) => ({ status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(json) });
before(async () => {
  postgres = await startPostgres(); kit = await openSystemKit(postgres, ['plm']);
  agile = await startAgileStub(agileOptions());
  plm = await startStub((r) => {
    if (agile.tokens.has(r.headers.authorization ?? '')) {
      if (r.method === 'GET' && r.path === '/plmquery/product/all/') return reply(productFailure ? { code: 4321, msg: 'synthetic-failure', data: null } : { code: 1000, data: products });
      if (r.method === 'GET' && r.path === '/plmquery/build/') {
        if (r.query.product === '410') return reply(builds);
        if (r.query.product === '412') return reply({ code: 1000, data: [{ id: 812, name: 'Synthetic_12_Enveloped', synthetic_links: [910001] }], msg: 'success' });
        return reply([]);
      }
      if (r.method === 'POST' && r.path === '/plmquery/story/detail/') return reply({ code: 1000, data: [{ id: 21, status: { raw: 'synthetic' }, stage: ['synthetic'] }, { id: 22, status: null, stage: null }, { id: 23 }] });
      if (r.method === 'POST' && r.path === '/plmquery/bug/detail/') return reply({ code: 1000, data: [{ id: 910001, title: '合成缺陷', repair_notes: '<p>合成修复说明</p>' }] });
    }
    return plmReply(r, (token) => agile.tokens.has(token), () => writes++);
  });
  const { id } = await addSyntheticResource(kit.records, kit.packs, kit.connectors, kit.admin, {
    system_pack: 'plm', name: '合成字段核对服务', environment: 'test',
    origins: { 'plm-oauth': agile.origin, 'plm-api': plm.origin }, allow_plaintext: [agile.origin, plm.origin],
    settings: { bug_fix_field: 'repair_notes', build_story_field: 'synthetic_links' },
  });
  resourceId = id;
  await setSyntheticCredential(kit.records, kit.connectors, kit.admin, id, 'username', AGILE_ACCOUNT.username);
  await setSyntheticCredential(kit.records, kit.connectors, kit.admin, id, 'password', AGILE_ACCOUNT.password);
});
after(async () => { await plm?.close(); await agile?.close(); await kit?.close(); await postgres?.stop(); });
async function read(key: string, type = 'builds') {
  const answer = await kit.connectors.reader.read(`plm:${type}:${key}`, { principal: kit.user, run: null, purpose: '合成字段核对' });
  assert.ok(answer.ok, answer.ok ? '' : answer.reason);
  const artifact = answer.artifacts.find((a) => a.name === 'content')!;
  return JSON.parse(new TextDecoder().decode(await artifactBytes(kit, artifact.artifact.body.sha256)));
}
test('configured fix_field travels through the real sandbox into bug content only', async () => {
  const bug = await read('910001', 'bug');
  assert.equal(bug.fix_field, 'repair_notes'); assert.equal(bug.fields.repair_notes, '合成修复说明');
});
test('name planning makes two reads and preserves both build names and configured requirement scope', async () => {
  const at = plm.requests.length;
  const out = await read('Synthetic+Alternate');
  assert.deepEqual(out, { product: { id: '410', name: products[0].name }, product_resolution: 'resolved', builds: [
    { id: '810', name: 'Synthetic_10_7_A', fields: { id: 810, name: 'Synthetic_10_7_A' }, stories: ['910001', '910002'], scope_note: '需求范围取自构建记录' },
  ] });
  assert.deepEqual(plm.requests.slice(at).map((r) => [r.path, r.query.product ?? null]), [['/plmquery/product/all/', null], ['/plmquery/build/', '410']]);
});
test('URI-encoded Unicode names survive the connector boundary and normalize before matching', async () => {
  const out = await read(encodeURIComponent('ＳＹＮＴＨＥＴＩＣ') + '+' + encodeURIComponent(' Alternate '));
  assert.equal(out.product_resolution, 'resolved'); assert.equal(out.product.id, '410');
});
test('unmatched and ambiguous names stop after the product list', async () => {
  for (const [key, resolution] of [['Absent', 'unresolved'], ['Both+Shared', 'ambiguous']]) {
    const at = plm.requests.length;
    const data = await read(key);
    assert.equal(data.product, null); assert.equal(data.product_resolution, resolution); assert.equal(data.builds, null);
    assert.equal(data.candidates.length, resolution === 'ambiguous' ? 2 : 0); assert.match(data.note, /plm:builds:/);
    assert.deepEqual(plm.requests.slice(at).map((r) => r.path), ['/plmquery/product/all/']);
  }
});
test('numeric keys still use one build request; a uniquely resolved product can have no builds', async () => {
  const at = plm.requests.length;
  const out = await read('410'); assert.equal(out.product_resolution, 'resolved'); assert.equal(out.product.name, null);
  assert.deepEqual(plm.requests.slice(at).map((r) => r.path), ['/plmquery/build/']);
  assert.deepEqual(await read('Empty'), { product: { id: '411', name: 'Empty' }, product_resolution: 'resolved', builds: [] });
  assert.equal(writes, 0);
});

const context = () => ({ principal: kit.user, run: null, purpose: '合成读取清单核对' });
test('failed product envelopes stop after one request and retain the precise transport failure', async () => {
  const at = plm.requests.length; productFailure = true;
  try {
    const out = await kit.connectors.executeRead(resourceId, 'builds', { id: 'Synthetic+Alternate' }, context());
    assert.equal(out.ok, false);
    if (out.ok) throw new Error('unexpected success');
    assert.equal(out.code, 'SOURCE_ENVELOPE_ERROR'); assert.ok(out.manifest);
    const stored = await kit.records.store.get<ReadManifest>(out.manifest!);
    assert.equal(stored!.body.result, 'error'); assert.equal(stored!.body.coverage.complete, false);
    assert.deepEqual(plm.requests.slice(at).map(r => r.path), ['/plmquery/product/all/']);
  } finally { productFailure = false; }
});
test('an invalid alias key produces PLAN_INVALID with the package reason and no request', async () => {
  const at = plm.requests.length;
  const out = await kit.connectors.executeRead(resourceId, 'builds', { id: 'Synthetic+' }, context());
  assert.equal(out.ok, false); if (out.ok) throw new Error('unexpected success');
  assert.equal(out.code, 'PLAN_INVALID'); assert.match(out.reason, /plm.invalid_key/); assert.match(out.reason, /第 2.*为空/);
  assert.equal(plm.requests.length, at);
});
test('an external id beyond 900 UTF-8 bytes gives a counted limit reason without echoing the key', async () => {
  const at = plm.requests.length; const id = 'plm:builds:' + 'Z'.repeat(890);
  assert.equal(Buffer.byteLength(id), 901);
  const out = await kit.connectors.reader.read(id, context());
  assert.equal(out.ok, false); if (out.ok) throw new Error('unexpected success');
  assert.match(out.reason, /901/); assert.match(out.reason, /900.*字节/); assert.ok(!out.reason.includes('Z'.repeat(30)));
  assert.equal(plm.requests.length, at);
});
test('unresolved manifests identify the product original and explicitly incomplete build coverage', async () => {
  const out = await kit.connectors.executeRead(resourceId, 'builds', { id: 'Absent' }, context());
  assert.ok(out.ok, out.ok ? '' : out.reason);
  const record = await kit.records.store.get<ReadManifest>(out.manifest);
  assert.equal(record!.body.original, 'products');
  assert.deepEqual(record!.body.coverage, { complete: false, examined: 1, total: 1, note: record!.body.coverage.note });
  assert.match(record!.body.coverage.note!, /尚未读取构建列表/); assert.match(record!.body.coverage.note!, /plm:builds:/);
  const original = out.artifacts.find(a => a.name === 'original')!;
  const bytes = await artifactBytes(kit, original.artifact.body.sha256);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(bytes)), { code: 1000, data: products });
});

test('a non-scalar story field keeps all stories readable through the connector and retains the raw original', async () => {
  const out = await kit.connectors.executeRead(resourceId, 'stories', { id: '21+22+23' }, context());
  assert.ok(out.ok, out.ok ? '' : out.reason);
  const content = out.artifacts.find(artifact => artifact.name === 'content')!;
  const model = JSON.parse(new TextDecoder().decode(await artifactBytes(kit, content.artifact.body.sha256)));
  assert.equal(model.stories.length, 3); assert.deepEqual(model.unread, []);
  assert.deepEqual(model.stories[0].fields_nonscalar, ['status', 'stage']);
  assert.deepEqual(model.stories[1].fields_nonscalar, []);
  const original = out.artifacts.find(artifact => artifact.name === 'original')!;
  const raw = JSON.parse(new TextDecoder().decode(await artifactBytes(kit, original.artifact.body.sha256)));
  assert.deepEqual(raw.data[0].status, { raw: 'synthetic' });
  assert.deepEqual(raw.data[0].stage, ['synthetic']);
});

test('oversized enabled external identities route to counted failures through executeRead', async () => {
  const key = 'Z'.repeat(890); const external = 'plm:builds:' + key;
  assert.equal(await kit.connectors.reader.accepts(external), true);
  assert.equal(await kit.connectors.reader.accepts('absent:builds:' + key), false);
  const before = plm.requests.length;
  const answer = await kit.connectors.executeRead(resourceId, 'builds', { id: key }, context());
  assert.equal(answer.ok, false); if (answer.ok) throw new Error('unexpected success');
  assert.equal(answer.code, 'PLAN_INVALID');
  assert.match(answer.reason, /901 字节/); assert.match(answer.reason, /900 字节上限/);
  assert.ok(!answer.reason.includes(key)); assert.equal(plm.requests.length, before);
});

test('an oversized non-PLM key gets generic connector advice only', async () => {
  const answer = await kit.connectors.reader.read('svn:file:' + 'docs/'.repeat(179), context());
  assert.equal(answer.ok, false); if (answer.ok) throw new Error('unexpected success');
  assert.match(answer.reason, /904 字节.*900 字节上限/);
  assert.match(answer.reason, /缩短读取键/);
  assert.doesNotMatch(answer.reason, /产品编号|名字集合|plm:builds/);
});

test('connector reads enveloped build list, projects content and preserves full envelope in original artifact', async () => {
  const answer = await kit.connectors.reader.read('plm:builds:412', { principal: kit.user, run: null, purpose: '合成信封核对' });
  assert.ok(answer.ok, answer.ok ? '' : answer.reason);
  const contentArtifact = answer.artifacts.find(a => a.name === 'content')!;
  const contentData = JSON.parse(new TextDecoder().decode(await artifactBytes(kit, contentArtifact.artifact.body.sha256)));
  assert.deepEqual(contentData.builds, [
    { id: '812', name: 'Synthetic_12_Enveloped', fields: { id: 812, name: 'Synthetic_12_Enveloped' }, stories: ['910001'], scope_note: '需求范围取自构建记录' },
  ]);
  const originalArtifact = answer.artifacts.find(a => a.name === 'original')!;
  const originalData = JSON.parse(new TextDecoder().decode(await artifactBytes(kit, originalArtifact.artifact.body.sha256)));
  assert.deepEqual(originalData, {
    code: 1000,
    data: [{ id: 812, name: 'Synthetic_12_Enveloped', synthetic_links: [910001] }],
    msg: 'success',
  });
});

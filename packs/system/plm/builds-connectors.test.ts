// Production connector planner, sandbox and storage over temporary loopback services, with synthetic responses only.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startAgileStub, startStub, type AgileStub, type StubServer } from '../../../hub/connectors/testing/api.ts';
import { startPostgres, type TemporaryPostgres } from '../../../hub/testing/postgres.ts';
import { AGILE_ACCOUNT, agileOptions } from '../../../tests/fixtures/agile/index.ts';
import { plmReply } from '../../../tests/fixtures/plm/index.ts';
import { artifactBytes, openSystemKit, type SystemKit } from '../testing/kit.ts';

let postgres: TemporaryPostgres, kit: SystemKit, agile: AgileStub, plm: StubServer;
let writes = 0;
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
      if (r.method === 'GET' && r.path === '/plmquery/product/all/') return reply({ code: 1000, data: products });
      if (r.method === 'GET' && r.path === '/plmquery/build/') return reply(r.query.product === '410' ? builds : []);
      if (r.method === 'POST' && r.path === '/plmquery/bug/detail/') return reply({ code: 1000, data: [{ id: 910001, title: '合成缺陷', repair_notes: '<p>合成修复说明</p>' }] });
    }
    return plmReply(r, (token) => agile.tokens.has(token), () => writes++);
  });
  const { id } = await kit.connectors.admin.addResource(kit.admin, {
    system_pack: 'plm', name: '合成字段核对服务', environment: 'test',
    origins: { 'plm-oauth': agile.origin, 'plm-api': plm.origin }, allow_plaintext: [agile.origin, plm.origin],
    settings: { bug_fix_field: 'repair_notes', build_story_field: 'synthetic_links' },
  });
  await kit.connectors.admin.setCredential(kit.admin, id, 'username', AGILE_ACCOUNT.username);
  await kit.connectors.admin.setCredential(kit.admin, id, 'password', AGILE_ACCOUNT.password);
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
    assert.deepEqual(await read(key), { product: null, product_resolution: resolution, builds: [] });
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

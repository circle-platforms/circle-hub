import {kityminderParser} from "../testing/parsers.ts";
import { addSyntheticResource, setSyntheticCredential, setSyntheticCredentials, syntheticStoredCredential } from './testing/credentials.ts';
// Reads end to end: the synthetic system packs' functions run in the real sandbox against loopback stubs; every response is
// stored by SHA-256 before anything interprets it; the derived content and meta of a mind map; the folder trees read once and
// cached; POST reads on listed routes while planners that try a write, a foreign origin or dot segments get nothing out;
// the build-site and WebDAV structures; failures returned, never thrown; resources without the right pack refused.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { RECORD_KINDS } from '../../contracts/generated/protocol.ts';
import { SandboxError, callPackFunction } from '../rules/api.ts';
import {htmlParser} from "../testing/parsers.ts";
import type { ExternalRead, ExternalReadContext } from '../ports.ts';
import type { Page, SourceArtifact, StoredRecord } from '../records/api.ts';
import { sha256Hex } from '../records/api.ts';
import { ReadManifest, type ReadResponse, type ResourceRecord } from '../../contracts/src/resources.ts';
import { startPostgres, type TemporaryPostgres } from '../testing/postgres.ts';
import { agileFixture, mindMap, startAgileStub, type AgileOptions, type AgileStub } from './testing/agile.ts';
import { BUILDS, buildSiteFiles, commandTree, startBuildSiteStub } from './testing/buildsite.ts';
import { openConnectorKit, type ConnectorKit } from './testing/kit.ts';
import { DOCSTORE_FUNCTIONS, agileSystem, docStoreSystem, keyedStoreSystem, writePack } from './testing/packs.ts';
import { PLM_BUGS, startPlmStub, type PlmStub } from './testing/plm.ts';
import { json, startStub, text, type StubServer } from './testing/stub.ts';
import { DOCUMENTS, startWebDavStub } from './testing/webdav.ts';
import type { PackFunctionRunner } from './read.ts';
import { openHarness } from '../runs/engine/testing/harness.ts';
import { createTestServer } from '../server/testing.ts';

let postgres: TemporaryPostgres;
before(async () => {
  postgres = await startPostgres();
});
after(() => postgres?.stop());

const DOC = 'q7w2e9r4t1y8';
const PASSWORD = 'Synthetic#Pass42';

interface World {
  k: ConnectorKit;
  fixture: AgileOptions;
  agile: AgileStub;
  plm: PlmStub;
  site: StubServer;
  dav: StubServer;
  resources: Record<'agile' | 'plm' | 'buildsite' | 'docstore', ResourceRecord>;
  ctx: ExternalReadContext;
}

async function world(t: { after: (fn: () => Promise<void>) => void }, extra: Parameters<typeof openConnectorKit>[1] = {}, options: { docs?: Record<string, string> } = {}): Promise<World> {
  const k = await openConnectorKit(postgres, extra);
  const fixture = agileFixture(DOC, { password: PASSWORD });
  const agile = await startAgileStub(fixture);
  const plm = await startPlmStub({ accepts: (token) => agile.tokens.has(token) });
  const site = await startBuildSiteStub();
  const dav = await startWebDavStub(options.docs ?? DOCUMENTS);
  t.after(async () => {
    for (const server of [agile, plm, site, dav]) await server.close();
    await k.close();
  });
  const add = (input: Parameters<ConnectorKit['connectors']['admin']['addResource']>[1]) => addSyntheticResource(k.records, k.packs, k.connectors, k.admin, input);
  const resources = {
    agile: await add({ system_pack: 'agile-test', name: '合成敏捷平台', environment: 'test', origins: { 'agile-oauth': agile.origin, 'agile-api': agile.origin }, allow_plaintext: [agile.origin], settings: { roots: ['7714'] } }),
    plm: await add({ system_pack: 'plm-test', name: '合成 PLM', environment: 'shared', origins: { 'plm-oauth': agile.origin, 'plm-api': plm.origin }, allow_plaintext: [agile.origin, plm.origin] }),
    buildsite: await add({ system_pack: 'buildsite-test', name: '合成构建站', environment: 'shared', origins: { 'build-site': site.origin }, limits: { concurrency: 1 } }),
    docstore: await add({ system_pack: 'docstore-test', name: '合成手册库', environment: 'shared', origins: { 'manual-store': dav.origin } }),
  };
  for (const id of [resources.agile.id, resources.plm.id]) {
    await setSyntheticCredential(k.records, k.connectors, k.admin, id, 'username', 'reader');
    await setSyntheticCredential(k.records, k.connectors, k.admin, id, 'password', PASSWORD);
  }
  return { k, fixture, agile, plm, site, dav, resources, ctx: { principal: k.user, run: null, purpose: 'expected source' } };
}

function success(read: ExternalRead): Extract<ExternalRead, { ok: true }> {
  assert.equal(read.ok, true, read.ok ? '' : read.reason);
  return read as Extract<ExternalRead, { ok: true }>;
}

function failure(read: ExternalRead, pattern: RegExp): string {
  assert.equal(read.ok, false, 'expected a failure');
  const reason = (read as { reason: string }).reason;
  assert.match(reason, pattern);
  return reason;
}

async function bytesOf(w: World, artifact: SourceArtifact): Promise<Buffer> {
  const source = await w.k.records.artifacts.source(w.k.user, artifact.body.sha256, { consumer: 'function' });
  assert.ok(source?.bytes, 'the reader may read what was read for them');
  return Buffer.from(source.bytes);
}

test('a mind map read gives the original, content (the inner KityMinder document) and meta (title and folders)', async (t) => {
  const w = await world(t);
  const read = success(await w.k.connectors.reader.read(`agile:mindmap:${DOC}`, w.ctx));
  assert.equal(read.id, `agile:mindmap:${DOC}`);
  assert.equal(read.revision, null);
  assert.deepEqual(read.artifacts.map((a) => a.name), ['original', 'content', 'meta']);
  const [original, content, meta] = read.artifacts.map((a) => a.artifact);
  const answer = JSON.parse((await bytesOf(w, original)).toString('utf8')) as { code: number; data: string };
  assert.equal(answer.code, 1000);
  assert.equal(typeof answer.data, 'string', 'the original is the double-encoded answer as received');
  const inner = await bytesOf(w, content);
  assert.equal(inner.toString('utf8'), answer.data, 'content is the decoded inner document, byte for byte');
  assert.equal(content.body.media_type, 'application/json');
  const model = kityminderParser.parse(new Uint8Array(inner)).model;
  assert.equal(model.nodes[0].text, '需求 4242 组件参数');
  assert.deepEqual(JSON.parse((await bytesOf(w, meta)).toString('utf8')), {
    title: '需求 4242 组件参数',
    folders: ['演示产品', '030：演示测试项目', '101：2.1.0', '201: 2.1.0-R1-2026/1', '组件'],
    found: true,
  });
  // Provenance (B02 F[1], A01) and visibility (B02 R[3]): observed read, projected derivations; reader and admins only.
  assert.deepEqual(original.body.origin, { read: { object: `agile:mindmap:${DOC}`, resource: w.resources.agile.id, action: null } });
  assert.equal(original.body.provenance_type, 'observed');
  assert.equal(content.body.provenance_type, 'projected');
  const generated = (content.body.origin as { generated: { generator: string; inputs: string[] } }).generated;
  assert.equal(generated.generator, 'agile-test.mindmap@1');
  assert.ok(generated.inputs.includes(`src:${original.body.sha256}`));
  for (const artifact of [original, content, meta]) assert.deepEqual(artifact.body.visibility, { readers: [w.k.user.id], admins: true, packs: [], shareable: false });
  const bob = await w.k.records.principals.createUser(w.k.admin, 'bob', 'user');
  assert.equal(await w.k.records.artifacts.source(bob, original.body.sha256), null, 'another user does not see it');
  assert.ok(await w.k.records.artifacts.source(w.k.admin, original.body.sha256), 'admins do');
  // The manifest is the B05 read action.
  const manifest = await w.k.records.store.get<ReadManifest>(read.manifest);
  assert.ok(manifest !== null);
  assert.equal(manifest.kind, 'action');
  assert.equal(manifest.schema, 'read-manifest@1');
  assert.equal(ReadManifest.safeParse(manifest.body).success, true, JSON.stringify(ReadManifest.safeParse(manifest.body).error?.issues));
  assert.equal(manifest.body.action, 'read');
  assert.equal(manifest.body.result, 'completed');
  assert.equal(manifest.body.principal, w.k.user.id);
  for(const artifact of [original,content,meta]){const actions=await w.k.records.store.find({key:'connectors.artifact',value:artifact.digest,kind:'action',limit:100});assert.ok(actions.items.some(action=>action.digest===read.manifest),'exact captures point to the read that returned them');}
  assert.equal(manifest.body.original, 'case');
  assert.deepEqual(manifest.body.requests.map((r) => [r.key, r.route, r.method, r.ok, r.artifact === original.digest]), [['case', 'case-data', 'POST', true, true]]);
  assert.deepEqual(manifest.body.reads.map((r) => [r.external, r.ok]), [['agile:tree:7714', true]]);
  assert.deepEqual(manifest.body.artifacts.map((a) => a.name), ['original', 'content', 'meta']);
  assert.equal(manifest.body.coverage.complete, true);
  const decision = await w.k.records.authorizations.resourceConfig(w.resources.agile.id);
  assert.ok(manifest.body.inputs.includes(`rec:${decision!.digest}`), 'the read names the configuration it used');
  const tree = manifest.body.reads[0].manifest!;
  assert.ok(manifest.body.inputs.includes(`rec:${tree}`));
  const treeManifest = await w.k.records.store.get<ReadManifest>(tree);
  // 23 roots, 10 per page, the root on page 2: pages 2 and 3 are read in round 2, and nothing beyond the total (page 4 would
  // repeat page 1).
  assert.deepEqual(treeManifest!.body.requests.map((r) => [r.round, r.key]), [
    [1, 'subtree'],
    [1, 'page-1'],
    [2, 'page-2'],
    [2, 'page-3'],
  ]);
});

test('the folder trees are read once and cached; a document they miss refreshes them once', async (t) => {
  const w = await world(t);
  const subtrees = () => w.agile.count('/agile/get_child_node_task/');
  success(await w.k.connectors.reader.read(`agile:mindmap:${DOC}`, w.ctx));
  assert.equal(subtrees(), 1);
  const again = success(await w.k.connectors.reader.read(`agile:mindmap:${DOC}`, w.ctx));
  assert.equal(subtrees(), 1, 'served from the cache');
  const manifest = await w.k.records.store.get<ReadManifest>(again.manifest);
  assert.equal(manifest!.body.reads[0].cached, true);
  // A document added to the tree after it was cached.
  const fresh = 'a1s2d3f4g5h6';
  w.fixture.documents[fresh] = mindMap(fresh, '新文档');
  const module = w.fixture.trees['7714'][0].children[0].children[0].children[0];
  module.children.push({ label: '新文档', id: fresh, cases: [], children: [] });
  const added = success(await w.k.connectors.reader.read(`agile:mindmap:${fresh}`, w.ctx));
  assert.equal(subtrees(), 2, 'refreshed once');
  const meta = JSON.parse((await bytesOf(w, added.artifacts[2].artifact)).toString('utf8'));
  assert.equal(meta.found, true);
  assert.equal(meta.title, '新文档');
  // A document in no configured tree: one refresh, then the read still succeeds with what is known.
  const orphan = 'z0x9c8v7b6n5';
  w.fixture.documents[orphan] = mindMap(orphan, '孤立文档');
  const lonely = success(await w.k.connectors.reader.read(`agile:mindmap:${orphan}`, w.ctx));
  assert.equal(subtrees(), 3);
  assert.deepEqual(JSON.parse((await bytesOf(w, lonely.artifacts[2].artifact)).toString('utf8')), { title: null, folders: [], found: false });
  // An unknown document: the original answer is an envelope error, so the read fails; nothing is guessed.
  failure(await w.k.connectors.reader.read('agile:mindmap:nosuchdoc000', w.ctx), /SOURCE_ENVELOPE_ERROR/);
});

test('every response is stored by SHA-256 before the projection sees it; a projection failure keeps the original', async (t) => {
  const checks: string[] = [];
  let kit: ConnectorKit | undefined;
  const wrapped: PackFunctionRunner = async (target, input, kind) => {
    if (kind === 'project') {
      for (const response of Object.values((input as { responses: Record<string, { sha256: string | null }> }).responses)) {
        const records = response.sha256 === null ? [] : await kit!.records.artifacts.records(response.sha256);
        checks.push(records.some((r) => 'read' in r.body.origin) ? 'stored' : 'missing');
        assert.ok(await kit!.records.objects.has(response.sha256!), 'the bytes are in the object store');
      }
    }
    return (await callPackFunction(target, input, {}, { requireOsIsolation: false })).output;
  };
  const w = await world(t, { callFunction: wrapped });
  kit = w.k;
  success(await w.k.connectors.reader.read(`agile:mindmap:${DOC}`, w.ctx));
  assert.ok(checks.length >= 3 && checks.every((c) => c === 'stored'), checks.join(','));
  // The declared read of a file whose projection throws.
  const path = 'spec/widget-list.md';
  const reason = failure(await w.k.connectors.reader.read(`manual:broken:${path}`, w.ctx), /PROJECTION_FAILED/);
  assert.doesNotMatch(reason, /127\.0\.0\.1/);
  const sha = sha256Hex(Buffer.from(DOCUMENTS[`/${path}`], 'utf8'));
  const kept = await w.k.records.artifacts.records(sha);
  assert.equal(kept.length, 1, 'the original stays stored');
  assert.deepEqual(kept[0].body.origin, { read: { object: `manual:broken:${path}`, resource: w.resources.docstore.id, action: null } });
  const found = await w.k.records.store.find<ReadManifest>({ key: 'connectors.external', value: `manual:broken:${path}`, kind: 'action' });
  assert.equal(found.items.length, 1);
  assert.equal(found.items[0].body.result, 'error');
  assert.equal(found.items[0].body.error_code, 'PROJECTION_FAILED');
  assert.equal(found.items[0].body.requests[0].artifact, kept[0].digest);
});

test('PLM-like reads: POST reads on listed routes, a plain array, ids of both kinds; the write route is never reached', async (t) => {
  const w = await world(t);
  const bug = success(await w.k.connectors.reader.read('plm:bug:4242', w.ctx));
  assert.deepEqual(JSON.parse((await bytesOf(w, bug.artifacts[1].artifact)).toString('utf8')), PLM_BUGS['4242']);
  assert.deepEqual(JSON.parse((await bytesOf(w, bug.artifacts[2].artifact)).toString('utf8')), { title: PLM_BUGS['4242'].title });
  success(await w.k.connectors.reader.read('plm:bug:4343', w.ctx));
  success(await w.k.connectors.reader.read('plm:story:777', w.ctx));
  const builds = success(await w.k.connectors.reader.read('plm:builds:28', w.ctx));
  assert.deepEqual(builds.artifacts.map((a) => a.name), ['original'], 'a declared read without projection: the original only');
  assert.equal(JSON.parse((await bytesOf(w, builds.artifacts[0].artifact)).toString('utf8')).length, 3);
  failure(await w.k.connectors.reader.read('plm:bug:999999', w.ctx), /PROJECTION_FAILED.*没有编号/);
  const posts = w.plm.requests.filter((r) => r.method === 'POST').map((r) => r.path);
  assert.ok(posts.includes('/plmquery/bug/detail/') && posts.includes('/plmquery/story/detail/'));
  const before = w.plm.requests.length;
  const loginsBefore = w.agile.logins;
  failure(await w.k.connectors.reader.read('plm:evil-route:1', w.ctx), /ROUTE_REFUSED/);
  failure(await w.k.connectors.reader.read('plm:evil-path:1', w.ctx), /ROUTE_REFUSED/);
  failure(await w.k.connectors.reader.read('plm:evil-body:1', w.ctx), /ROUTE_REFUSED/);
  failure(await w.k.connectors.reader.read('plm:evil-href:1', w.ctx), /ORIGIN_REFUSED/);
  failure(await w.k.connectors.reader.read('plm:evil-dots:1', w.ctx), /ROUTE_REFUSED/);
  assert.equal(w.plm.requests.length, before, 'nothing of these reached the system');
  assert.equal(w.agile.logins, loginsBefore, 'a refused request causes no login');
  assert.equal(w.plm.writes, 0);
});

test('planner failures: never done after five rounds, an output that is not a plan, a planner that throws', async (t) => {
  const w = await world(t);
  const products = () => w.plm.requests.filter((r) => r.path === '/plmquery/product/all/').length;
  failure(await w.k.connectors.reader.read('plm:loop:x', w.ctx), /PLAN_INVALID.*5 轮/);
  assert.equal(products(), 5, 'one request per round, five rounds');
  failure(await w.k.connectors.reader.read('plm:broken:x', w.ctx), /PLAN_INVALID.*read-plan-output@1/);
  failure(await w.k.connectors.reader.read('plm:throws:x', w.ctx), /FUNCTION_FAILED.*FUNCTION_THREW/);
});

test('build-site-like reads: ISO-8859-1 kept as received, unquoted links followed against the page, dead links tolerated', async (t) => {
  const w = await world(t);
  const files = buildSiteFiles();
  const listing = success(await w.k.connectors.reader.read('buildsite:listing:rel_demo_2_1.html', w.ctx));
  const original = listing.artifacts[0].artifact;
  assert.equal(original.body.media_type, 'text/html; charset=ISO-8859-1');
  const bytes = await bytesOf(w, original);
  assert.ok(bytes.equals(Buffer.from(files['/rel_demo_2_1.html'].body)), 'bytes as received');
  const links = htmlParser.parse(new Uint8Array(bytes), { mediaType: original.body.media_type }).model.links.map((l) => l.href);
  assert.ok(links.includes(`builds/${BUILDS[0]}/command_tree-${BUILDS[0]}.xml`));
  const tree = success(await w.k.connectors.reader.read(`buildsite:command-tree:${BUILDS[0]}`, w.ctx));
  assert.equal((await bytesOf(w, tree.artifacts[0].artifact)).toString('utf8'), commandTree(BUILDS[0]));
  const hub = success(await w.k.connectors.reader.read('buildsite:hub:demo_2_1.html', w.ctx));
  const content = JSON.parse((await bytesOf(w, hub.artifacts[1].artifact)).toString('utf8')) as { listings: { ok: boolean; status: number }[] };
  assert.deepEqual(content.listings.map((l) => [l.ok, l.status]), [
    [true, 200],
    [true, 200],
    [false, 404],
  ]);
  const manifest = await w.k.records.store.get<ReadManifest>(hub.manifest);
  assert.deepEqual(manifest!.body.coverage, { complete: false, examined: 3, total: 4 }, 'a dead link leaves the coverage incomplete');
  assert.deepEqual(hub.coverage,manifest!.body.coverage,'external readers retain the exact read coverage');
  assert.ok(w.site.requests.every((r) => r.headers.authorization === undefined), 'an anonymous system never gets a credential');
  assert.equal(w.site.maxInFlight, 1, 'the resource limits requests in flight');
});

test('WebDAV-like reads: PROPFIND with Depth 1 and D: names, matched files as named artifacts, NUL bytes kept', async (t) => {
  const w = await world(t);
  const search = success(await w.k.connectors.reader.read('manual:spec-search:widget', w.ctx));
  const propfind = w.dav.requests.find((r) => r.method === 'PROPFIND');
  assert.equal(propfind?.path, '/spec/');
  assert.equal(propfind?.headers.depth, '1');
  assert.deepEqual(search.artifacts.map((a) => a.name), ['original', 'content', 'file-1', 'file-2']);
  const matched = await Promise.all(search.artifacts.slice(2).map(async (a) => (await bytesOf(w, a.artifact)).toString('utf8')));
  assert.deepEqual(matched.sort(), [DOCUMENTS['/spec/widget-list.md'], DOCUMENTS['/spec/widget-range.md']].sort());
  assert.ok('read' in search.artifacts[2].artifact.body.origin, 'a matched file is the stored response itself');
  const manual = success(await w.k.connectors.reader.read('manual:file:manuals/line-2.1/cli.md', w.ctx));
  const bytes = await bytesOf(w, manual.artifacts[0].artifact);
  assert.ok(bytes.equals(Buffer.from(DOCUMENTS['/manuals/line-2.1/cli.md'], 'utf8')));
  assert.ok(bytes.includes(0), 'NUL bytes are kept in the stored original');
  const before = w.dav.requests.length;
  failure(await w.k.connectors.reader.read('manual:climb:x', w.ctx), /PLAN_INVALID/);
  assert.equal(w.dav.requests.length, before, 'climbing out is refused before any request');
});

test('a reader without the right pack is refused; ambiguity, disabled resources and bad ids give failures, never exceptions', async (t) => {
  const w = await world(t);
  assert.equal(w.resources.agile.system_pack, 'agile-test@1.0.0', 'the definition binds the exact version that was current');
  assert.equal(w.resources.agile.system_pack_digest, w.k.handles.agile.digest);
  assert.equal(await w.k.connectors.reader.accepts(`agile:mindmap:${DOC}`), true);
  assert.equal(await w.k.connectors.reader.accepts('agile:nothing:1'), false);
  assert.equal(await w.k.connectors.reader.accepts('not an id'), false);
  // A newer version that does not declare the type takes effect only when an admin binds it (B04 R[1]).
  const profile = agileSystem() as { reads: { external: string }[] };
  profile.reads = profile.reads.filter((r) => r.external !== 'agile:mindmap');
  w.k.packs.set(await writePack(w.k.packRoot, { id: 'agile-test', version: '1.1.0', system: profile, functions: ['agile-tree-plan.ts', 'agile-tree-project.ts'] }));
  w.k.connectors.refresh();
  assert.equal(await w.k.connectors.reader.accepts(`agile:mindmap:${DOC}`), true, 'still the bound 1.0.0');
  const rebound = await w.k.connectors.admin.updateResource(w.k.admin, w.resources.agile.id, { system_pack: 'agile-test' });
  assert.equal(rebound.system_pack, 'agile-test@1.1.0');
  assert.equal(await w.k.connectors.reader.accepts(`agile:mindmap:${DOC}`), false);
  assert.equal(await w.k.connectors.reader.accepts('agile:tree:7714'), true);
  // Published content that differs from the bound digest is not used.
  w.k.packs.set({ ...(await w.k.packs.pack('agile-test@1.1.0'))!, digest: 'f'.repeat(64) });
  w.k.connectors.refresh();
  assert.equal(await w.k.connectors.reader.accepts('agile:tree:7714'), false);
  // Withdrawn pack.
  w.k.packs.remove('agile-test');
  w.k.connectors.refresh();
  assert.equal(await w.k.connectors.reader.accepts('agile:tree:7714'), false);
  failure(await w.k.connectors.reader.read('agile:tree:7714', w.ctx), /没有启用的资源声明外部类型 agile:tree/);
  // A pack of another kind or an invalid profile cannot be bound.
  w.k.packs.set(await writePack(w.k.packRoot, { id: 'agile-test', version: '1.2.0', kind: 'workflow', system: agileSystem() }));
  await assert.rejects(w.k.connectors.admin.updateResource(w.k.admin, w.resources.agile.id, { system_pack: 'agile-test@1.2.0' }), (e: unknown) => (e as { code?: string }).code === 'PACK_UNAVAILABLE');
  w.k.packs.set(await writePack(w.k.packRoot, { id: 'agile-test', version: '1.3.0', system: { ...agileSystem(), routes: [] } }));
  await assert.rejects(w.k.connectors.admin.updateResource(w.k.admin, w.resources.agile.id, { system_pack: 'agile-test@1.3.0' }), (e: unknown) => (e as { code?: string }).code === 'PROFILE_INVALID');
  assert.equal(await w.k.connectors.reader.accepts('agile:tree:7714'), false);
  // One resource per environment; two environments still require explicit routing.
  const second = await addSyntheticResource(w.k.records, w.k.packs, w.k.connectors, w.k.admin, { system_pack: 'docstore-test', name: '第二个手册库', environment: 'production', origins: { 'manual-store': w.dav.origin } });
  assert.equal(await w.k.connectors.reader.accepts('manual:file:spec/a.md'), true);
  failure(await w.k.connectors.reader.read('manual:file:spec/widget-list.md', w.ctx), /2 个启用的资源/);
  await w.k.connectors.admin.disable(w.k.admin, second.id);
  success(await w.k.connectors.reader.read('manual:file:spec/widget-list.md', w.ctx));
  // Bad ids and readers.
  failure(await w.k.connectors.reader.read('agile mindmap', w.ctx), /不是外部对象标识/);
  failure(await w.k.connectors.reader.read(42 as unknown as string, w.ctx), /不是外部对象标识/);
  failure(await w.k.connectors.reader.read('manual:file:spec/widget-list.md', { principal: { id: 'usr_01jacd5z8q3w7v9h2k4m6n8p0t', name: 'ghost', role: 'admin' }, purpose: 'x' }), /READER_INVALID/);
  failure(await w.k.connectors.reader.read('rec:file:x', w.ctx), /不是外部对象标识/);
});

test('executeRead by resource and read name; the reasons never name a host', async (t) => {
  const w = await world(t);
  const outcome = await w.k.connectors.executeRead(w.resources.plm.id, 'products', { id: 'all' }, w.ctx);
  assert.equal(outcome.ok, true, outcome.ok ? '' : outcome.reason);
  if (outcome.ok) assert.equal(outcome.external, 'plm:products:all');
  const missing = await w.k.connectors.executeRead(w.resources.plm.id, 'nothing', { id: 'x' }, w.ctx);
  assert.equal(missing.ok, false);
  assert.equal(!missing.ok && missing.code, 'READ_UNDECLARED');
  const unknown = await w.k.connectors.executeRead('res_01jacd5z8q3w7v9h2k4m6n8p0t', 'products', { id: 'x' }, w.ctx);
  assert.equal(!unknown.ok && unknown.code, 'RESOURCE_UNAVAILABLE');
  const absent = await w.k.connectors.executeRead(w.resources.docstore.id, 'file', { id: 'spec/none.md' }, w.ctx);
  assert.ok(absent.ok && absent.absent?.code==='SOURCE_ABSENT');
  // No host or port in any manifest or log event.
  const reads: Page<StoredRecord> = await w.k.records.store.list({ kind: 'action', limit: 500 });
  for (const server of [w.agile, w.plm, w.site, w.dav]) {
    const host = server.origin.replace('http://', '');
    assert.ok(!JSON.stringify(reads.items).includes(host), 'a manifest names a host');
    assert.ok(!JSON.stringify(w.k.log).includes(host), 'a log event names a host');
  }
});

test('revisions, derived artifacts and read limits are checked; each failure is a reason, not an exception', async (t) => {
  const w = await world(t);
  const path = 'spec/widget-list.md';
  const plain = success(await w.k.connectors.reader.read(`manual:rev:${path}`, w.ctx));
  assert.equal(plain.revision, 'r1', 'the revision the projection states');
  success(await w.k.connectors.reader.read(`manual:rev:${path}@r1`, w.ctx));
  failure(await w.k.connectors.reader.read(`manual:rev:${path}@r2`, w.ctx), /要求修订 r2/);
  failure(await w.k.connectors.reader.read(`manual:badrev:${path}`, w.ctx), /PROJECTION_FAILED/);
  failure(await w.k.connectors.reader.read(`manual:badmedia:${path}`, w.ctx), /PROJECTION_FAILED.*content/);
  const before = w.dav.requests.length;
  failure(await w.k.connectors.reader.read('manual:many:x', w.ctx), /READ_LIMIT.*50/);
  assert.equal(w.dav.requests.length, before, 'a plan over the request limit sends nothing');
  failure(await w.k.connectors.reader.read(`manual:small:${path}`, w.ctx), /READ_LIMIT.*10 字节/);
  const sha = sha256Hex(Buffer.from(DOCUMENTS[`/${path}`], 'utf8'));
  const stored = (await w.k.records.artifacts.records(sha)).filter((r) => 'read' in r.body.origin && r.body.origin.read.object.startsWith('manual:small:'));
  assert.equal(stored.length, 0, 'an answer over the read limit is not stored, never truncated');
});

test('a static header credential: sent as declared to the roles that carry it, refused over undeclared plaintext, missing is a reason', async (t) => {
  const w = await world(t);
  w.k.packs.set(await writePack(w.k.packRoot, { id: 'keyed-store', system: keyedStoreSystem(), functions: DOCSTORE_FUNCTIONS }));
  await w.k.connectors.admin.disable(w.k.admin, w.resources.docstore.id);
  const keyed = await addSyntheticResource(w.k.records, w.k.packs, w.k.connectors, w.k.admin, { system_pack: 'keyed-store', name: '带密钥的手册库', environment: 'test', origins: { 'manual-store': w.dav.origin }, allow_plaintext: [w.dav.origin] });
  failure(await w.k.connectors.reader.read('manual:file:spec/widget-list.md', w.ctx), /CREDENTIAL_MISSING/);
  await setSyntheticCredential(w.k.records, w.k.connectors, w.k.admin, keyed.id, 'token', ["k3y-Sy","ntheti","c-0042"].join(''));
  const before = w.dav.requests.length;
  success(await w.k.connectors.reader.read('manual:file:spec/widget-list.md', w.ctx));
  assert.equal(w.dav.requests[before].headers['x-api-key'], 'Bearer k3y-Synthetic-0042');
  assert.equal(await syntheticStoredCredential(w.k.records,keyed,'token'), 'k3y-Synthetic-0042', 'a plain credential is kept as given');
  await w.k.connectors.admin.updateResource(w.k.admin, keyed.id, { allow_plaintext: [] });
  failure(await w.k.connectors.reader.read('manual:file:spec/widget-list.md', w.ctx), /CREDENTIAL_MISSING/);
  assert.equal(w.dav.requests.length, before + 1, 'refused before any request');
  assert.ok(!JSON.stringify(w.k.log).includes('k3y-Synthetic-0042'));
});

/** Every read manifest stored so far parses as read-manifest@1. */
async function manifestsParse(w: World): Promise<void> {
  let cursor: string | null = null;
  do {
    const page: Page<StoredRecord> = await w.k.records.store.list({ kind: 'action', limit: 500, cursor });
    for (const record of page.items) {
      if (record.schema !== 'read-manifest@1') continue;
      const parsed = ReadManifest.safeParse(record.body);
      assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues?.slice(0, 3)));
    }
    cursor = page.next;
  } while (cursor !== null);
}

/** Records of every kind as JSON, for secret scans. */
async function allRecordsText(w: World): Promise<string> {
  const out: string[] = [];
  for (const kind of RECORD_KINDS) {
    let cursor: string | null = null;
    do {
      const page: Page<StoredRecord> = await w.k.records.store.list({ kind, limit: 500, cursor });
      out.push(...page.items.map((record) => JSON.stringify(record)));
      cursor = page.next;
    } while (cursor !== null);
  }
  return out.join('\n');
}

test('a route whose good answer is bare still sees an expired envelope: one login, one repeat, and the array is the original', async (t) => {
  const w = await world(t);
  success(await w.k.connectors.reader.read('plm:bug:4242', w.ctx));
  const logins = w.agile.logins;
  w.agile.expireTokens();
  const builds = success(await w.k.connectors.reader.read('plm:builds:28', w.ctx));
  assert.equal(w.agile.logins, logins + 1, 'one login');
  const original = JSON.parse((await bytesOf(w, builds.artifacts[0].artifact)).toString('utf8'));
  assert.ok(Array.isArray(original) && original.length === 3, 'the original is the build list, not the error envelope');
  const manifest = await w.k.records.store.get<ReadManifest>(builds.manifest);
  assert.deepEqual(
    manifest!.body.requests.map((r) => [r.error, r.after_login]),
    [
      ['SOURCE_LOGIN_EXPIRED', false],
      [null, true],
    ],
  );
  assert.deepEqual(manifest!.body.coverage, { complete: true, examined: 1, total: 1 });
});

test('an answer stored retain_only reaches no function: no text, json or model in its view, nothing derived from it', async (t) => {
  const secret = ["Zq8-Hu","nter2-","Secret","-77"].join('');
  const docs = {
    ...DOCUMENTS,
    '/spec/gadget-login.md': `# 登录\n\n| 参数 | 值 |\n| --- | --- |\n| password | ${secret} |\n`,
    '/spec/gadget-plain.md': '# 小部件\n\n普通说明。\n',
  };
  const inputs: { kind: string; input: unknown }[] = [];
  const wrapped: PackFunctionRunner = async (target, input, kind) => {
    inputs.push({ kind, input });
    return (await callPackFunction(target, input, {}, { requireOsIsolation: false })).output;
  };
  const w = await world(t, { callFunction: wrapped }, { docs });
  const search = success(await w.k.connectors.reader.read('manual:spec-search:gadget', w.ctx));
  const projection = inputs.filter((call) => call.kind === 'project').at(-1)!.input as { responses: Record<string, ReadResponse> };
  const flagged = Object.values(projection.responses).find((response) => response.path === '/spec/gadget-login.md')!;
  assert.equal(flagged.ok, false);
  assert.equal(flagged.error?.code, 'SOURCE_CREDENTIAL');
  assert.ok(!('text' in flagged) && !('json' in flagged) && !('model' in flagged), 'the view carries no content');
  assert.ok(!JSON.stringify(inputs).includes(secret), 'no planner or projection input carries the flagged text');
  assert.deepEqual(search.artifacts.map((a) => a.name), ['original', 'content', 'file-2'], 'the readable file is still delivered');
  const holders = (await w.k.allObjects()).filter((bytes) => bytes.includes(secret));
  assert.equal(holders.length, 1, 'only the stored answer holds it');
  const records = await w.k.records.artifacts.records(sha256Hex(holders[0]));
  assert.ok(records.length > 0 && records.every((record) => record.body.read_tier === 'retain_only'));
  const manifest = await w.k.records.store.get<ReadManifest>(search.manifest);
  assert.equal(manifest!.body.coverage.complete, false, 'an answer the functions could not use lowers the coverage');
});

test('an original stored retain_only fails the read with its digest; the projection never runs, nothing derived exists', async (t) => {
  const secret = ["Zq8-Hu","nter2-","Secret","-77"].join('');
  const docs = { ...DOCUMENTS, '/manuals/secret.md': `# 手册\n\n| 参数 | 值 |\n| --- | --- |\n| password | ${secret} |\n| port | 8080 |\n` };
  let projections = 0;
  const wrapped: PackFunctionRunner = async (target, input, kind) => {
    if (kind === 'project') projections += 1;
    return (await callPackFunction(target, input, {}, { requireOsIsolation: false })).output;
  };
  const w = await world(t, { callFunction: wrapped }, { docs });
  const reason = failure(await w.k.connectors.reader.read('manual:rows:manuals/secret.md', w.ctx), /SOURCE_CREDENTIAL/);
  const sha = sha256Hex(Buffer.from(docs['/manuals/secret.md'], 'utf8'));
  assert.ok(reason.includes(sha), 'the reason names the stored answer');
  assert.equal(projections, 0);
  assert.equal((await w.k.allObjects()).filter((bytes) => bytes.includes(secret)).length, 1);
  assert.equal((await w.k.records.artifacts.text(w.k.user, sha))?.readable, false);
  // Readable rows are projected as before.
  const rows = success(await w.k.connectors.reader.read('manual:rows:manuals/line-2.1/cli.md', w.ctx));
  assert.equal(projections, 1);
  assert.deepEqual(rows.artifacts.map((a) => a.name), ['original', 'content']);
  await manifestsParse(w);
});

test('an answer echoing the credential the Hub sent is kept retain_only; neither functions, records nor logs carry it', async (t) => {
  const w = await world(t);
  // A PLM-like source whose detail routes echo the request's Authorization header: a 500 debug page and a 200 answer.
  const debug = await startStub((request) => {
    if (request.path === '/plmquery/bug/detail/') return text(`<html><body><h1>500</h1><pre>HTTP_AUTHORIZATION ${request.headers.authorization}</pre></body></html>`, 'text/html', 500);
    if (request.path === '/plmquery/story/detail/') return json({ code: 1000, msg: '', data: [{ id: '777', title: '回显', note: `seen ${request.headers.authorization}` }] });
    return json({ code: 1000, msg: '', data: [] });
  });
  t.after(() => debug.close());
  await w.k.connectors.admin.updateResource(w.k.admin, w.resources.plm.id, {
    origins: { 'plm-oauth': w.agile.origin, 'plm-api': debug.origin },
    allow_plaintext: [w.agile.origin, debug.origin],
  });
  await setSyntheticCredentials(w.k.records,w.k.connectors,w.k.admin,w.resources.plm.id,{username:'reader',password:PASSWORD});
  failure(await w.k.connectors.reader.read('plm:bug:4242', w.ctx), /SOURCE_HTTP_STATUS/);
  failure(await w.k.connectors.reader.read('plm:story:777', w.ctx), /SOURCE_CREDENTIAL/);
  const token = debug.requests[0].headers.authorization;
  assert.ok(token.length >= 16);
  const holders = (await w.k.allObjects()).filter((bytes) => bytes.includes(token));
  assert.equal(holders.length, 2, 'the two answers as received, and nothing derived');
  for (const bytes of holders) {
    const sha = sha256Hex(bytes);
    assert.ok((await w.k.records.artifacts.records(sha)).every((record) => record.body.read_tier === 'retain_only'));
    assert.equal(await w.k.records.artifacts.text(w.k.user,sha),null,'echoed originals have no reader visibility');
    const entries=(await w.k.records.store.list<any>({kind:'action',limit:500})).items.filter(r=>r.schema==='read-manifest@1').flatMap(r=>r.body.requests);
    assert.ok(entries.filter((r:any)=>r.artifact===null&&r.sha256===null).length>=1);
    assert.ok(!entries.some((r:any)=>r.sha256===sha));
  }
  const manifests=await w.k.records.store.list<ReadManifest>({kind:'action',limit:100});
  for(const read of manifests.items.filter(record=>record.schema==='read-manifest@1'))for(const request of read.body.requests){
    if(request.artifact!==null){const artifact=await w.k.records.store.get<SourceArtifact['body']>(request.artifact);assert.ok(!artifact || !holders.some(bytes=>sha256Hex(bytes)===artifact.body.sha256),'echo original record identities are private');}
    assert.ok(!holders.some(bytes=>sha256Hex(bytes)===request.sha256),'echo original digests are private');
  }
  assert.ok(w.k.log.some((event) => event.event === 'secret_echoed'));
  assert.ok(!(await allRecordsText(w)).includes(token), 'no record carries the token');
  assert.ok(!JSON.stringify(w.k.log).includes(token), 'no log event carries the token');
});

test('a plan that would send a credential value the Hub holds is refused before any request', async (t) => {
  const w = await world(t);
  w.k.packs.set(await writePack(w.k.packRoot, { id: 'keyed-store', system: keyedStoreSystem(), functions: DOCSTORE_FUNCTIONS }));
  await w.k.connectors.admin.disable(w.k.admin, w.resources.docstore.id);
  const keyed = await addSyntheticResource(w.k.records, w.k.packs, w.k.connectors, w.k.admin, { system_pack: 'keyed-store', name: '带密钥的手册库', environment: 'test', origins: { 'manual-store': w.dav.origin }, allow_plaintext: [w.dav.origin] });
  await setSyntheticCredential(w.k.records, w.k.connectors, w.k.admin, keyed.id, 'token', ["k3y-Sy","ntheti","c-0042"].join(''));
  const before = w.dav.requests.length;
  const outcome = await w.k.connectors.executeRead(keyed.id, 'echo-path', { id: 'x', args: { path: 'spec/k3y-Synthetic-0042.md' } }, w.ctx);
  assert.equal(outcome.ok, false);
  assert.equal(!outcome.ok && outcome.code, 'PLAN_INVALID');
  assert.equal(w.dav.requests.length, before, 'nothing was sent');
  assert.ok(!(await allRecordsText(w)).includes('k3y-Synthetic-0042'), 'the refused request is recorded masked');
  await manifestsParse(w);
});

test('a static credential the source answers 401 is not sent again until an admin acts', async (t) => {
  const w = await world(t);
  w.k.packs.set(await writePack(w.k.packRoot, { id: 'keyed-store', system: keyedStoreSystem(), functions: DOCSTORE_FUNCTIONS }));
  await w.k.connectors.admin.disable(w.k.admin, w.resources.docstore.id);
  const guarded = await startStub((request) => (request.headers['x-api-key'] === 'Bearer k3y-Right-0042' ? text('# 正文\n', 'text/markdown; charset=utf-8') : text('unauthorized', 'text/plain', 401)));
  t.after(() => guarded.close());
  const keyed = await addSyntheticResource(w.k.records, w.k.packs, w.k.connectors, w.k.admin, { system_pack: 'keyed-store', name: '带密钥的手册库', environment: 'test', origins: { 'manual-store': guarded.origin }, allow_plaintext: [guarded.origin] });
  await setSyntheticCredential(w.k.records, w.k.connectors, w.k.admin, keyed.id, 'token', ["k3y-Wr","ong-00","42"].join(''));
  for (let i = 0; i < 5; i++) failure(await w.k.connectors.reader.read('manual:file:spec/a.md', w.ctx), /CREDENTIAL_REFUSED/);
  assert.equal(guarded.requests.length, 1, 'one failed authentication, not five');
  const status = await w.k.connectors.admin.loginStatus(w.k.admin, keyed.id);
  assert.equal(status?.stopped, true);
  w.k.clock.advance(7 * 24 * 3600_000);
  failure(await w.k.connectors.reader.read('manual:file:spec/a.md', w.ctx), /CREDENTIAL_REFUSED/);
  assert.equal(guarded.requests.length, 1);
  await w.k.connectors.admin.resetLogin(w.k.admin, keyed.id);
  failure(await w.k.connectors.reader.read('manual:file:spec/a.md', w.ctx), /CREDENTIAL_REFUSED/);
  assert.equal(guarded.requests.length, 2, 'a reset allows one attempt');
  await setSyntheticCredential(w.k.records, w.k.connectors, w.k.admin, keyed.id, 'token', 'k3y-Right-0042');
  success(await w.k.connectors.reader.read('manual:file:spec/a.md', w.ctx));
  assert.equal(guarded.requests.length, 3);
});

test('a link with ;-segments cannot climb out of its template: refused before any request', async (t) => {
  const w = await world(t);
  const before = w.dav.requests.length;
  failure(await w.k.connectors.reader.read('manual:climb-semicolon:x', w.ctx), /ROUTE_REFUSED/);
  assert.deepEqual(
    w.dav.requests.slice(before).map((r) => [r.method, r.path]),
    [['PROPFIND', '/spec/']],
    'only the listing was sent',
  );
});

test('top-level reads do not fill the nested-read cache; the cache is bounded by bytes', async (t) => {
  const w = await world(t);
  const subtrees = () => w.agile.count('/agile/get_child_node_task/');
  success(await w.k.connectors.reader.read('agile:tree:7714', w.ctx));
  assert.equal(subtrees(), 1);
  const first = success(await w.k.connectors.reader.read(`agile:mindmap:${DOC}`, w.ctx));
  assert.equal(subtrees(), 2, 'the top-level read left no cache entry');
  assert.equal((await w.k.records.store.get<ReadManifest>(first.manifest))!.body.reads[0].cached, false);
  const second = success(await w.k.connectors.reader.read(`agile:mindmap:${DOC}`, w.ctx));
  assert.equal(subtrees(), 2, 'the nested read is cached');
  assert.equal((await w.k.records.store.get<ReadManifest>(second.manifest))!.body.reads[0].cached, true);
  const tiny = await world(t, { nestedCacheBytes: 100 });
  success(await tiny.k.connectors.reader.read(`agile:mindmap:${DOC}`, tiny.ctx));
  success(await tiny.k.connectors.reader.read(`agile:mindmap:${DOC}`, tiny.ctx));
  assert.equal(tiny.agile.count('/agile/get_child_node_task/'), 2, 'an entry over the byte bound is not kept');
});

test('a resource moved to another system is not served from the trees cached for the old one', async (t) => {
  const w = await world(t);
  success(await w.k.connectors.reader.read(`agile:mindmap:${DOC}`, w.ctx));
  const fixture = agileFixture(DOC, { password: PASSWORD });
  fixture.trees['7714'][0].label = '030：生产系统的项目';
  const other = await startAgileStub(fixture);
  t.after(() => other.close());
  await w.k.connectors.admin.updateResource(w.k.admin, w.resources.agile.id, {
    environment: 'production',
    origins: { 'agile-oauth': other.origin, 'agile-api': other.origin },
    allow_plaintext: [other.origin],
  });
  assert.equal((await w.k.connectors.reader.read(`agile:mindmap:${DOC}`,w.ctx)).ok,false,'new destination requires renewed enrollment');
  assert.equal(other.requests.length,0);
  await setSyntheticCredentials(w.k.records,w.k.connectors,w.k.admin,w.resources.agile.id,{username:'reader',password:PASSWORD});
  const moved = success(await w.k.connectors.reader.read(`agile:mindmap:${DOC}`, w.ctx));
  assert.equal(other.count('/agile/get_child_node_task/'), 1, 'the tree is read from the new system');
  const meta = JSON.parse((await bytesOf(w, moved.artifacts[2].artifact)).toString('utf8')) as { folders: string[] };
  assert.equal(meta.folders[1], '030：生产系统的项目');
  const manifest = await w.k.records.store.get<ReadManifest>(moved.manifest);
  const nested = await w.k.records.store.get<ReadManifest>(manifest!.body.reads[0].manifest!);
  assert.equal(nested!.body.environment, 'production');
});

test('a refused request with an oversized path is recorded within the manifest bounds; a manifest that does not parse is never stored', async (t) => {
  const w = await world(t);
  failure(await w.k.connectors.reader.read('manual:long-path:x', w.ctx), /ROUTE_REFUSED/);
  const found = await w.k.records.store.find<ReadManifest>({ key: 'connectors.external', value: 'manual:long-path:x', kind: 'action' });
  assert.equal(found.items.length, 1);
  const entry = found.items[0].body.requests[0];
  assert.ok(entry.path.length <= 4096 && /sha256:[0-9a-f]{64}$/.test(entry.path), entry.path.slice(-80));
  await manifestsParse(w);
  // A pack handle whose version is not a version (a broken port): the manifest cannot be valid, so the read fails and
  // nothing is stored. A fresh connectors instance (a restarted Hub) builds its runtime from that handle.
  const original = w.k.packs.pack.bind(w.k.packs);
  w.k.packs.pack = async (ref: string) => {
    const handle = await original(ref);
    return handle !== null && handle.id === 'docstore-test' ? { ...handle, version: 'one' } : handle;
  };
  const outcome = await w.k.make().executeRead(w.resources.docstore.id, 'file', { id: 'spec/widget-list.md' }, w.ctx);
  assert.equal(outcome.ok, false);
  assert.equal(!outcome.ok && outcome.code, 'STORE_FAILED');
  const stored = await w.k.records.store.find<ReadManifest>({ key: 'connectors.external', value: 'manual:file:spec/widget-list.md', kind: 'action' });
  assert.equal(stored.items.length, 0, 'no mislabelled read-manifest@1 record');
  await manifestsParse(w);
});
test('a projection inherits accepted findings only from its actual original', async t => {
  const secret = ["FtpSyn","thetic","7834"].join('');
  const docs = {...DOCUMENTS,'/manuals/accepted.md':`# 手册\npassword = ${secret}\n\n| password | port |\n| --- | --- |\n| ${secret} | 8080 |\n`};
  let projected = secret;
  const wrapped: PackFunctionRunner = async (target,input,kind) => {
    if (kind === 'project') return {artifacts:[{name:'content',media_type:'application/json',json:{password:projected}}]};
    return (await callPackFunction(target,input,{}, {requireOsIsolation:false})).output;
  };
  const w = await world(t,{callFunction:wrapped}, {docs});
  const id = 'manual:rows:manuals/accepted.md';
  failure(await w.k.connectors.reader.read(id,w.ctx),/SOURCE_CREDENTIAL/);
  const sha = sha256Hex(Buffer.from(docs['/manuals/accepted.md']));
  await w.k.records.artifacts.acceptFindings(w.k.admin,sha,'合成手册中的虚构示例');
  const result = success(await w.k.connectors.reader.read(id,w.ctx));
  const outputs = result.artifacts.filter(a => a.name !== 'original');
  assert.ok(outputs.length > 0);
  assert.ok(outputs.some(a => a.artifact.body.scan.derived !== undefined));
  for (const {artifact} of outputs) {
    assert.equal(artifact.body.read_tier,'model_readable');
    assert.ok(await w.k.records.artifacts.source(w.k.user,artifact.body.sha256));
  }
  projected = 'FtpUnrelated8902';
  const other = {bytes:Buffer.from(`password = ${projected}`),mediaType:'text/plain',origin:{read:{object:'synthetic:manual:other'}},author:{user:null},provenanceType:'observed' as const,visibility:{readers:[],admins:true,packs:[],shareable:false}};
  const unrelated = await w.k.records.artifacts.ingest(other);
  await w.k.records.artifacts.acceptFindings(w.k.admin,unrelated.body.sha256,'无关合成来源的示例');
  await w.k.records.artifacts.ingest(other);
  const ungrounded = success(await w.k.connectors.reader.read(id,w.ctx));
  assert.equal(ungrounded.artifacts.find(a => a.name === 'content')?.artifact.body.read_tier,'retain_only');
  await w.k.records.artifacts.revokeFindings(w.k.admin,sha);
  for (const {artifact} of outputs.filter(a => a.artifact.body.scan.findings.length > 0)) assert.equal((await w.k.records.artifacts.source(w.k.user,artifact.body.sha256))?.bytes,null);
});

for (const mode of ['sandbox exception', 'empty plan'] as const) {
  test(`${mode}: the missing setting reaches only the administrator note, never the receipt or tool text`, async (t) => {
    const diagnostic = `缺少设置 settings.repository_path；合成秘密 ${PASSWORD}`;
    const wrapped: PackFunctionRunner = async (_target, _input, kind) => {
      if (kind === 'plan') {
        if (mode === 'sandbox exception') throw new SandboxError('FUNCTION_THREW', { phase: 'call', message: diagnostic });
        return { requests: [], done: true };
      }
      return { error: { code: 'synthetic.configuration', message: diagnostic } };
    };
    const w = await world(t, { callFunction: wrapped });
    const h = await openHarness(postgres);
    t.after(() => h.close());
    h.external.read = async () => w.k.connectors.reader.read(`agile:mindmap:${DOC}`, w.ctx);
    const server = await createTestServer({ postgres, withoutRunsDetail: true });
    t.after(() => server.close());
    server.deps.runs.startRun = (_principal, input, context) => h.service.startRun(h.alice, input, context);
    const user = await server.createUser('合成读者');
    const client = await server.client(user.token,{sessionId:'synthetic-diagnostic-observer'});
    const answer = await client.call('start_run', { pack: 'toy-review', product: 'Meadow', inputs: { map: { external: 'toy:mindmap:docq7' } } });
    const adminLog = await server.records.callLog.query(server.admin.principal, { tool: 'start_run', limit: 1 });
    assert.doesNotMatch(JSON.stringify(answer.structuredContent), /settings\.repository_path/);
    assert.doesNotMatch(JSON.stringify(answer.content), /settings\.repository_path/);
    const userLog = await server.records.callLog.query(user.principal, { tool: 'start_run', limit: 1 });
    assert.equal(userLog.items[0].admin_note, undefined);
    assert.equal(userLog.items[0].admin_reasons, undefined);
    assert.match((adminLog.items[0].admin_reasons ?? []).join('\n'), /settings\.repository_path/);
    assert.doesNotMatch((adminLog.items[0].admin_reasons ?? []).join('\n'), new RegExp(PASSWORD.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    const manifests = await w.k.records.store.list({ kind: 'action', limit: 10 });
    assert.ok(manifests.items.length > 0);
    assert.doesNotMatch(JSON.stringify(manifests), /settings\.repository_path/);
    assert.equal(w.agile.requests.length, 0);
  });
}

test('an empty plan cannot turn a successful diagnostic projection into readable artifacts', async (t) => {
  const wrapped: PackFunctionRunner = async (_target, _input, kind) => kind === 'plan'
    ? { requests: [], done: true }
    : { artifacts: [{ name: 'content', media_type: 'text/plain', text: 'synthetic projected success without a source' }] };
  const w = await world(t, { callFunction: wrapped });
  const outcome = await w.k.connectors.executeRead(w.resources.agile.id, 'mindmap', { id: DOC }, w.ctx);
  assert.equal(outcome.ok, false);
  assert.equal((await w.k.records.store.list({ kind: 'source_artifact', limit: 10 })).items.length, 0);
  assert.equal(w.agile.requests.length, 0);
});

test('a nested pack receives no sandbox diagnostic that it could copy into tool content', async (t) => {
  const marker = 'settings.repository_path';
  let nestedView: unknown;
  const wrapped: PackFunctionRunner = async (_target, input, kind) => {
    const value = input as { round?: number; external: { system: string }; reads?: Record<string, unknown> };
    if (value.external.system === 'agile') throw new SandboxError('FUNCTION_THREW', { message: `缺少 ${marker}` });
    if (kind === 'plan') return { requests: [{ key: 'original', route: 'list', params: { path: 'spec' } }], reads: [{ external: `agile:mindmap:${DOC}` }], done: true };
    nestedView = value.reads;
    return { artifacts: [{ name: 'content', media_type: 'application/json', json: value.reads }] };
  };
  const w = await world(t, { callFunction: wrapped });
  const read = success(await w.k.connectors.reader.read('manual:spec-search:diagnostic', w.ctx));
  assert.ok(nestedView);
  assert.ok(!JSON.stringify(nestedView).includes(marker));
  const content = read.artifacts.find((artifact) => artifact.name === 'content')!;
  assert.ok(!(await bytesOf(w, content.artifact)).toString().includes(marker));
  assert.ok(JSON.stringify(w.k.log).includes(marker), 'only the administrator log keeps the nested diagnostic');
});

test('the reader port retains the 404 manifest and returns a determined absence',async t=>{
 const w=await world(t);
 const result=await w.k.connectors.reader.read('manual:file:spec/synthetic-absent.md',w.ctx);
 assert.equal(result.ok,true);if(!result.ok)return;
 assert.equal(result.absent?.code,'SOURCE_ABSENT');assert.equal(result.absent?.object,result.id);
 assert.match(result.manifest??'',/^[0-9a-f]{64}$/);
 const record=await w.k.records.store.get(result.manifest!);assert.equal(record?.schema,'read-manifest@1');
 const manifest=ReadManifest.parse(record!.body);assert.equal(manifest.external,result.id);assert.equal(manifest.result,'completed');assert.equal(manifest.error_code,null);assert.equal(manifest.requests.at(-1)?.status,404);
});

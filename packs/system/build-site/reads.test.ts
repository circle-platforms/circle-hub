import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import { ExternalObjectId } from '../../../contracts/src/reference.ts';
import { SystemProfile } from '../../../contracts/src/resources.ts';
import { startBuildSiteStub, type StubServer } from '../../../hub/connectors/testing/api.ts';
import { htmlParser } from '../../../hub/testing/parsers.ts';
import { xmlParser } from '../../../hub/testing/parsers.ts';
import type { ExternalRead } from '../../../hub/ports.ts';
import { startPostgres, type TemporaryPostgres } from '../../../hub/testing/postgres.ts';
import { BASE_PATH, buildSiteFiles, siteFiles } from '../../../tests/fixtures/build-site/index.ts';
import { artifactBytes, openSystemKit, type SystemKit } from '../testing/kit.ts';
import { fileKey, filePlan, linkOf, listingPlan, pageFile, routeOfLink } from './functions/reads.ts';

const profile = SystemProfile.parse(JSON.parse(readFileSync(new URL('./system.json', import.meta.url), 'utf8')));

describe('the profile', () => {
  test('is read-only by construction: GET routes only, every one marked read, no body', () => {
    for (const route of profile.routes) {
      assert.equal(route.method, 'GET', route.id);
      assert.equal(route.read, true);
      assert.equal(route.body, undefined);
    }
    assert.equal(profile.auth.kind, 'none');
    assert.deepEqual(profile.reads.map((r) => r.external), ['buildsite:listing', 'buildsite:file']);
  });
});

describe('the read functions', () => {
  test('a listing key names a page below the base; index is the configured index page', () => {
    assert.equal(pageFile('index', {}), 'index.html');
    assert.equal(pageFile('index', { index_page: 'builds.htm' }), 'builds.htm');
    assert.equal(pageFile('index', { index_page: '../etc/passwd' }), 'index.html', 'a configured page with a slash is not used');
    assert.equal(pageFile('rel_orbit_7_1', {}), 'rel_orbit_7_1.html');
    assert.equal(pageFile('famx_10_7.htm', {}), 'famx_10_7.htm');
    for (const bad of ['', '../x', 'a/b', 'a b', '.hidden', 'x'.repeat(300)]) assert.equal(pageFile(bad, {}), null, bad);
    assert.deepEqual(listingPlan({ round: 1, external: { key: 'rel_orbit_7_1' }, settings: {} }), { requests: [{ key: 'page', route: 'page', params: { page: 'rel_orbit_7_1.html' } }], done: true });
    assert.deepEqual(listingPlan({ round: 1, external: { key: 'a/b' } }), { requests: [], done: true });
    assert.deepEqual(listingPlan(null), { requests: [], done: true });
  });

  test('a file key is the link without scheme and host, escaped; the plan resolves it by its extension', () => {
    assert.equal(fileKey('http://192.0.2.10/builds/command_tree-Rel_X_1_2_3.xml'), '/builds/command_tree-Rel_X_1_2_3.xml');
    assert.equal(fileKey('//192.0.2.10/builds/a.xml'), '/builds/a.xml');
    assert.equal(fileKey('/builds/a b@c%41.html'), '/builds/a%20b%40c%2541.html');
    assert.equal(fileKey('trees/x.xml'), 'trees/x.xml');
    assert.equal(fileKey('mailto:builds@example.invalid'), null);
    for (const href of ['http://192.0.2.10/builds/a b.xml', '/builds/文件.xml', '/builds/a%20b.xml', '/x\u0000y.xml']) {
      const key = fileKey(href);
      assert.ok(key !== null && ExternalObjectId.safeParse(`buildsite:file:${key}`).success, href);
      assert.equal(linkOf(key as string), href.replace(/^http:\/\/192\.0\.2\.10/, ''), 'the plan gets the link back');
    }
    assert.equal(routeOfLink('/a/b.XML?x=1'), 'tree-file');
    assert.equal(routeOfLink('Bugs_Fixed_with_X.htm'), 'page-file');
    assert.equal(routeOfLink('image.array'), null);
    assert.deepEqual(filePlan({ external: { key: '/builds/a.xml' } }), { requests: [{ key: 'file', route: 'tree-file', href: '/builds/a.xml' }], done: true });
    for (const bad of ['', 'http:%2F%2Fevil/x.xml', '%2F%2Fevil%2Fx.xml', '/a%5Cb.xml', '%E0%A4%A', '/image.array']) assert.deepEqual(filePlan({ external: { key: bad } }), { requests: [], done: true }, bad);
  });

  test('never throw on hostile input', () => {
    for (const input of [undefined, null, 1, 'x', [], {}, { external: 5 }, { external: { key: 7 } }, { settings: [] }]) {
      assert.doesNotThrow(() => listingPlan(input));
      assert.doesNotThrow(() => filePlan(input));
    }
  });
});

describe('reads through the connectors', () => {
  let postgres: TemporaryPostgres;
  let kit: SystemKit;
  let site: StubServer;
  let resource: string;

  before(async () => {
    postgres = await startPostgres();
    kit = await openSystemKit(postgres, ['build-site']);
    site = await startBuildSiteStub(buildSiteFiles());
    resource = (await kit.connectors.admin.addResource(kit.admin, { system_pack: 'build-site', name: '合成构建站', environment: 'test', origins: { 'build-site': `${site.origin}${BASE_PATH}` }, settings: { index_page: 'index.html' } })).id;
  });
  after(async () => {
    await site?.close();
    await kit?.close();
    await postgres?.stop();
  });

  const read = (id: string): Promise<ExternalRead> => kit.connectors.reader.read(id, { principal: kit.admin, run: null, purpose: 'sync' });
  const ok = (r: ExternalRead) => {
    assert.equal(r.ok, true, r.ok ? '' : r.reason);
    return r as Extract<ExternalRead, { ok: true }>;
  };

  test('the fixture files are what write.ts writes', () => {
    const files = buildSiteFiles();
    for (const [path, bytes] of Object.entries(siteFiles())) assert.deepEqual(files[path]?.body, bytes, `${path}: run node tests/fixtures/build-site/write.ts`);
    assert.equal(Object.keys(files).length, Object.keys(siteFiles()).length);
  });

  test('the index page, a hub page and a listing page; the ISO-8859-1 page text is decoded by its charset', async () => {
    const index = ok(await read('buildsite:listing:index'));
    assert.deepEqual(index.artifacts.map((a) => a.name), ['original']);
    const bytes = await artifactBytes(kit, index.artifacts[0].artifact.body.sha256);
    assert.ok(Buffer.from(bytes).equals(Buffer.from(buildSiteFiles()['/builds/index.html'].body)), 'the original is stored as received');
    const model = htmlParser.parse(bytes, { mediaType: index.artifacts[0].artifact.body.media_type }).model;
    assert.ok(model.links.some((link) => link.href === 'http://192.0.2.10/builds/orbit_7_2.html'));
    assert.ok(model.blocks.some((block) => block.text.includes('©')), 'Latin-1 decoded');
    ok(await read('buildsite:listing:orbit_7_2'));
    const listing = ok(await read('buildsite:listing:rel_orbit_7_1'));
    assert.match(listing.artifacts[0].artifact.body.media_type, /iso-8859-1/i);
    assert.equal(site.requests.filter((r) => r.method !== 'GET').length, 0);
  });

  test('a dead link is a determinate absence, never an exception', async () => {
    const dead = await read('buildsite:listing:rel_orbit_6_9');
    assert.ok(dead.ok && dead.absent?.code==='SOURCE_ABSENT');
    assert.equal(site.requests.at(-1)?.path, '/builds/rel_orbit_6_9.html');
    assert.equal((await read('buildsite:listing:a..b/c')).ok, false, 'a key that names no page plans nothing');
  });

  test('a command tree by its link (origin-relative or absolute), stored byte for byte and parsed with its declared encoding', async () => {
    for (const href of ['/builds/command_tree-Rel_ORBIT_7_1_0_30.xml', 'http://192.0.2.10/builds/command_tree-Rel_ORBIT_7_1_0_30.xml']) {
      const tree = ok(await read(`buildsite:file:${fileKey(href)}`));
      const artifact = tree.artifacts[0].artifact.body;
      const bytes = await artifactBytes(kit, artifact.sha256);
      assert.ok(Buffer.from(bytes).equals(Buffer.from(buildSiteFiles()['/builds/command_tree-Rel_ORBIT_7_1_0_30.xml'].body)));
      const parsed = xmlParser.parse(bytes, { mediaType: artifact.media_type });
      assert.equal(parsed.model.declaration?.encoding, 'ISO-8859-1');
      assert.ok(JSON.stringify(parsed.model).includes('étiquette'), 'a Latin-1 character survives');
    }
    const bugs = ok(await read(`buildsite:file:${fileKey('http://192.0.2.10/builds/Bugs_Fixed_with_Rel_ORBIT_7_1_0_30.html')}`));
    assert.match(bugs.artifacts[0].artifact.body.media_type, /text\/html/);
  });

  test('a link outside the base path or of a type no route reads is refused before anything is sent', async () => {
    const before = site.requests.length;
    for (const key of ['/elsewhere/command_tree.xml', '/builds/image.array', '%2F%2F192.0.2.77%2Fx.xml']) assert.equal((await read(`buildsite:file:${key}`)).ok, false, key);
    assert.equal(site.requests.length, before, 'no request left the Hub');
  });

  test('the resource is listed with its pack and no credential', async () => {
    const [listing] = await kit.connectors.admin.listResources(kit.admin);
    assert.equal(listing.id, resource);
    assert.match(listing.system_pack, /^build-site@1\.0\.0$/);
  });
});

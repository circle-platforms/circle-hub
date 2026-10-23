import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { SystemProfile, type HttpMethod, type ReadManifest } from '../../../contracts/src/resources.ts';
import { compileRoutes, matchRoute } from '../../../hub/connectors/api.ts';
import { startStub, text, type StubServer } from '../../../hub/connectors/testing/api.ts';
import { xmlParser } from '../../../hub/refs/api.ts';
import { manifestDigest } from '../../../hub/runs/api.ts';
import { startPostgres, type TemporaryPostgres } from '../../../hub/testing/postgres.ts';
import { readManifest, stagePack } from '../../workflow/case-review/packaging.ts';
import { artifactBytes, openSystemKit, type SystemKit } from '../testing/kit.ts';
import { PACK_DIR, directoryPlan, directoryProject, filePlan } from './api.ts';

const profile = SystemProfile.parse(JSON.parse(readFileSync(new URL('./system.json', import.meta.url), 'utf8')));
const prefix = '/repository';
const dir = 'manuals';
const file = '章节.adoc';
const payload = '= Synthetic\r\n\u0000正文\r\n';
const row = (href: string, revision = '17', directory = true, size = '12') => `<D:response xmlns:D="DAV:"><D:href>${href}</D:href><D:propstat><D:prop><D:resourcetype>${directory ? '<D:collection/>' : ''}</D:resourcetype><D:version-name>${revision}</D:version-name>${directory ? '' : `<D:getcontentlength>${size}</D:getcontentlength>`}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
const multi = (...rows: string[]) => `<D:multistatus xmlns:D="DAV:">${rows.join('')}</D:multistatus>`;
const base = `${prefix}/!svn/rvr/17/${dir}/`;
const listing = (rev = '16') => multi(row(base), row(`${base}${encodeURIComponent(file)}`, rev, false, String(Buffer.byteLength(payload))), row(`${base}appendix/`, '15'));
const response = (xml: string) => ({ ok: true, model: xmlParser.parse(new TextEncoder().encode(xml)).model });
const input = (xml: string) => ({ external: { key: dir }, responses: { revision: response(multi(row(`${prefix}/${dir}/`))), list: response(xml) } });

test('profile admits only read routes and vault static authentication', () => {
  assert.equal(profile.auth.kind, 'static_header');
  assert.deepEqual(profile.routes.map((r) => [r.method, r.read]), [['PROPFIND', true], ['PROPFIND', true], ['GET', true]]);
  const routes = compileRoutes(profile.routes);
  assert.equal(matchRoute(routes, { method: 'GET', path: '/!svn/rvr/17/manuals/chapter.adoc', query: {}, body: undefined }).declaration.id, 'file');
  for (const method of ['PUT', 'MKCOL', 'MERGE', 'CHECKOUT', 'POST', 'DELETE']) {
    assert.throws(() => matchRoute(routes, { method: method as HttpMethod, path: '/!svn/rvr/17/manuals/chapter.adoc', query: {}, body: undefined }));
  }
  for (const path of ['/admin', '/!svn/rvr/latest/manuals/chapter.adoc', '/!svn/rvr/-1/manuals/chapter.adoc', '/!svn/rvr/17/manuals/%2e%2e/file', '/!svn/rvr/17/manuals/x%3by', '/!svn/rvr/17/manuals/x%2fy']) {
    assert.throws(() => matchRoute(routes, { method: 'GET', path, query: {}, body: undefined }), path);
  }
});

test('planners reject invalid revisions and paths before I/O', () => {
  for (const key of ['HEAD/a', '-1/a', '1.2/a', '17/../a', '17/a%2F..%2Fb', '17/a;b', '17/a%00b', '17/%ZZ']) assert.deepEqual(filePlan({ external: { key } }), { requests: [], done: true });
  assert.deepEqual(directoryPlan({ external: { key: '../manuals' } }), { requests: [], done: true });
});

test('XML namespaces, response attributes, percent encoding and directory slashes are parsed', () => {
  const result = directoryProject(input(listing())) as { revision: string; artifacts: { json: { members: { name: string; directory: boolean; size: number | null; revision: string }[] } }[] };
  assert.equal(result.revision, '17');
  assert.deepEqual(result.artifacts[0].json.members.map(({ name, directory, size, revision }) => ({ name, directory, size, revision })), [
    { name: 'appendix', directory: true, size: null, revision: '15' },
    { name: file, directory: false, size: Buffer.byteLength(payload), revision: '16' },
  ]);
  const unprefixed = listing().replaceAll('D:', '').replaceAll('xmlns:D=', 'xmlns=');
  assert.deepEqual(directoryProject(input(unprefixed)), directoryProject(input(listing())));
});

test('unrelated XML namespaces cannot supply DAV properties or revision identity', () => {
  const wrongNamespace = (xml: string) => xml.replaceAll('DAV:', 'urn:synthetic:unrelated');
  assert.ok('error' in (directoryProject({
    ...input(wrongNamespace(listing())),
    responses: { revision: response(wrongNamespace(multi(row(`${prefix}/${dir}/`)))), list: response(wrongNamespace(listing())) },
  }) as object));
  for (const property of ['version-name', 'resourcetype', 'collection', 'getcontentlength']) {
    const rebound = listing().replaceAll(`<D:${property}`, `<D:${property} xmlns:D="urn:synthetic:unrelated"`);
    assert.ok('error' in (directoryProject(input(rebound)) as object), property);
  }
});

test('namespace bindings are inherited and scoped, including default namespace resets', () => {
  const inherited = listing().replaceAll(' xmlns:D="DAV:"', '').replace('<D:multistatus>', '<D:multistatus xmlns:D="DAV:">');
  assert.deepEqual(directoryProject(input(inherited)), directoryProject(input(listing())));
  const alias = inherited.replaceAll('D:', 'Z:').replace('xmlns:D=', 'xmlns:Z=');
  assert.deepEqual(directoryProject(input(alias)), directoryProject(input(listing())));
  const unprefixed = inherited.replaceAll('D:', '').replace('xmlns:D=', 'xmlns=');
  assert.deepEqual(directoryProject(input(unprefixed)), directoryProject(input(listing())));
  const reset = unprefixed.replaceAll('<version-name>', '<version-name xmlns="">');
  assert.ok('error' in (directoryProject(input(reset)) as object));
  const restored = listing().replace('<D:prop>', '<D:prop xmlns:Z="urn:synthetic:unrelated">')
    .replace('<D:resourcetype>', '<Z:resourcetype xmlns:Z="DAV:">').replace('</D:resourcetype>', '</Z:resourcetype>');
  assert.deepEqual(directoryProject(input(restored)), directoryProject(input(listing())));
});

test('newer member revisions, failed properties and unsafe or ambiguous members fail closed', () => {
  for (const xml of [listing('18'), listing('HEAD'), listing().replace('200 OK', '404 Not Found'), multi(row(base), row('http://192.0.2.1/away', '1', false)), multi(row(base), row(`${base}../away`, '1', false)), multi(row(base), row(`${base}a%2Fb`, '1', false)), multi(row(base), row(`${base}a`, '1', false, 'not-size')), multi(row(base), row(`${base}a`, '1', false), row(`${base}%61`, '1', false)), multi(row(base), row(`${base}folder`, '1', true)), multi()]) {
    assert.ok('error' in (directoryProject(input(xml)) as object), xml);
  }
});

describe('SVN reads over loopback with temporary PostgreSQL and the real sandbox', () => {
  let postgres: TemporaryPostgres;
  let kit: SystemKit;
  let server: StubServer;
  let root: string;
  let resource: string;
  let badRevision = false;
  let echo = false;
  const authorization = `Basic ${randomBytes(24).toString('base64')}`;
  before(async () => {
    postgres = await startPostgres();
    kit = await openSystemKit(postgres, []);
    root = await mkdtemp(join(tmpdir(), 'circle-hub-svn-'));
    const directory = await stagePack(PACK_DIR, join(root, 'svn'));
    const manifest = await readManifest(directory);
    kit.packs.set({ id: manifest.id, version: manifest.version, kind: manifest.kind, digest: manifestDigest(manifest), directory });
    server = await startStub((r) => {
      if (r.headers.authorization !== authorization) return text('Unauthorized', 'text/plain', 401);
      if (r.method === 'PROPFIND' && r.path === `${prefix}/${dir}/` && r.headers.depth === '0') return text(multi(row(r.path)), 'application/xml', 207);
      if (r.method === 'PROPFIND' && r.path === base && r.headers.depth === '1') return text(listing(badRevision ? '18' : '16'), 'application/xml', 207);
      if (r.method === 'GET' && decodeURIComponent(r.path) === `${base}${file}`) return text(echo ? authorization : payload, 'text/plain');
      return text('Absent', 'text/plain', 404);
    });
    resource = (await kit.connectors.admin.addResource(kit.admin, { system_pack: 'svn', name: '合成仓库', environment: 'test', origins: { svn: `${server.origin}${prefix}` }, allow_plaintext: [server.origin] })).id;
  });
  after(async () => { await server?.close(); await kit?.close(); await postgres?.stop(); if (root) await rm(root, { recursive: true, force: true }); });
  const read = (id: string) => kit.connectors.reader.read(id, { principal: kit.admin, run: null, purpose: 'sync' });
  const fileId = `svn:file:17/${encodeURIComponent(`${dir}/${file}`)}`;

  test('missing vault credential sends nothing', async () => {
    assert.equal((await read(`svn:directory:${dir}`)).ok, false);
    assert.equal(server.requests.length, 0);
  });
  test('directory pins revision and file reads preserve identical original bytes and request receipts', async () => {
    await kit.connectors.admin.setCredential(kit.admin, resource, 'authorization', authorization);
    const directory = await read(`svn:directory:${dir}`);
    assert.ok(directory.ok, JSON.stringify(directory));
    assert.equal(directory.revision, '17');
    const content = directory.artifacts.find((a) => a.name === 'content')!;
    const members = JSON.parse(new TextDecoder().decode(await artifactBytes(kit, content.artifact.body.sha256))).members;
    assert.equal(members.find((m: { name: string }) => m.name === file).external, fileId);
    const first = await read(fileId);
    const second = await read(fileId);
    assert.ok(first.ok && second.ok, JSON.stringify([first, second]));
    const original = first.artifacts.find((a) => a.name === 'original')!;
    assert.equal(original.artifact.body.sha256, second.artifacts.find((a) => a.name === 'original')!.artifact.body.sha256);
    assert.deepEqual(Buffer.from(await artifactBytes(kit, original.artifact.body.sha256)), Buffer.from(payload));
    const receipt = (await kit.records.store.get<ReadManifest>(first.manifest))!.body;
    assert.equal(receipt.revision, '17');
    assert.equal(receipt.requests[0].path, '/!svn/rvr/17/manuals/%E7%AB%A0%E8%8A%82.adoc');
    const exposed = JSON.stringify([kit.log, receipt, first, directory]);
    assert.ok(!exposed.includes(authorization));
    for (const artifact of [...first.artifacts, ...directory.artifacts]) assert.ok(!new TextDecoder().decode(await artifactBytes(kit, artifact.artifact.body.sha256)).includes(authorization));
    assert.deepEqual(server.requests.slice(0, 2).map((r) => [r.method, r.headers.depth]), [['PROPFIND', '0'], ['PROPFIND', '1']]);
    assert.ok(server.requests.every((r) => r.headers.authorization === authorization));
  });
  test('a member newer than the batch fails the read', async () => {
    badRevision = true;
    assert.equal((await read(`svn:directory:${dir}`)).ok, false);
    badRevision = false;
  });
  test('a source echoing the sent credential is held back and errors and logs redact it', async () => {
    echo = true;
    const result = await read(fileId);
    assert.equal(result.ok, false);
    assert.ok(!JSON.stringify([result, kit.log]).includes(authorization));
    echo = false;
  });
  test('401 stops the static credential without a login flow or retry', async () => {
    const refusedValue = `Basic ${randomBytes(24).toString('base64')}`;
    await kit.connectors.admin.setCredential(kit.admin, resource, 'authorization', refusedValue);
    const count = server.requests.length;
    const first = await read(fileId);
    const second = await read(fileId);
    assert.equal(first.ok, false);
    assert.equal(second.ok, false);
    assert.equal(server.requests.length, count + 1);
    assert.equal(server.requests.at(-1)!.method, 'GET');
    assert.equal((await kit.connectors.admin.loginStatus(kit.admin, resource))?.stopped, true);
    assert.ok(!JSON.stringify([first, second, kit.log]).includes(refusedValue));
  });
});

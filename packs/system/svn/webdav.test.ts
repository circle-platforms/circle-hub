import { addSyntheticResource, setSyntheticCredential, setSyntheticCredentials } from '../../../hub/connectors/testing/credentials.ts';
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
import { PACK_DIR, directoryPlan, directoryProject, filePlan, fileProject } from './api.ts';

const profile = SystemProfile.parse(JSON.parse(readFileSync(new URL('./system.json', import.meta.url), 'utf8')));
const prefix = '/repository';
const dir = 'manuals';
const settings = { repository_path: prefix };
const file = '章节.adoc';
const payload = '= Synthetic\r\n\u0000正文\r\n';
const row = (href: string, revision = '17', directory = true, size = '12') => `<D:response xmlns:D="DAV:"><D:href>${href}</D:href><D:propstat><D:prop><D:resourcetype>${directory ? '<D:collection/>' : ''}</D:resourcetype><D:version-name>${revision}</D:version-name>${directory ? '' : `<D:getcontentlength>${size}</D:getcontentlength>`}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
const multi = (...rows: string[]) => `<D:multistatus xmlns:D="DAV:">${rows.join('')}</D:multistatus>`;
const base = `${prefix}/!svn/rvr/17/${dir}/`;
const listing = (rev = '16') => multi(row(base), row(`${base}${encodeURIComponent(file)}`, rev, false, String(Buffer.byteLength(payload))), row(`${base}appendix/`, '15'));
const response = (xml: string) => ({ ok: true, model: xmlParser.parse(new TextEncoder().encode(xml)).model });
const input = (xml: string) => ({ settings, external: { key: dir }, responses: { revision: response(multi(row(`${prefix}/${dir}/`))), list: response(xml) } });

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
  for (const key of ['HEAD/a', '-1/a', '1.2/a', '17/../a', '17/a%2F..%2Fb', '17/a;b', '17/a%00b', '17/%ZZ']) assert.deepEqual(filePlan({ settings, external: { key } }), { requests: [], done: true });
  assert.deepEqual(directoryPlan({ settings, external: { key: '../manuals' } }), { requests: [], done: true });
});

test('repository_path is required and validated before directory or file requests', () => {
  for (const config of [undefined, {}, { repository_path: '' }, { repository_path: 7 }, { repository_path: 'repository' }, { repository_path: '//repository' }, { repository_path: '/repository/../other' }, { repository_path: '/repo%2Fsitory' }, { repository_path: '/repository?x' }, { repository_path: '/%ZZ' }]) {
    const value = { ...input(listing()), settings: config };
    assert.deepEqual(directoryPlan(value), { requests: [], done: true });
    assert.deepEqual(filePlan({ ...value, external: { key: '17/manuals/chapter.adoc' } }), { requests: [], done: true });
    for (const project of [directoryProject, fileProject]) {
      const result = project(value) as { error: { message: string } };
      assert.match(result.error.message, /settings\.repository_path/);
    }
  }
});

test('complete directory paths reject another repository with the same directory suffix', () => {
  const correct = input(listing());
  const wrongRevision = { ...correct, responses: { ...correct.responses, revision: response(multi(row(`/other/${dir}/`))) } };
  assert.deepEqual(directoryPlan({ ...wrongRevision, round: 2 }), { requests: [], done: true });
  assert.ok('error' in (directoryProject(wrongRevision) as object));
  for (const other of ['/other', `${prefix}/nested`, '/different/repository']) {
    const wrongList = input(listing().replaceAll(prefix, other));
    assert.ok('error' in (directoryProject(wrongList) as object), other);
  }
  assert.ok(!('error' in (directoryProject(correct) as object)));
  assert.deepEqual(directoryPlan({ ...correct, round: 2 }), { requests: [{ key: 'list', route: 'list', params: { rev: '17', dir } }], original: 'list', done: true });
});

test('repository and directory path segments compare after one percent decoding', () => {
  const encoded = { ...input(listing().replaceAll(prefix, '/re%70ository')), settings: { repository_path: '/%72epository/' } };
  assert.deepEqual(directoryProject(encoded), directoryProject(input(listing())));
  const root = { ...input(listing().replaceAll(prefix, '')), settings: { repository_path: '/' }, responses: {
    revision: response(multi(row(`/${dir}/`))), list: response(listing().replaceAll(prefix, '')),
  } };
  assert.ok(!('error' in (directoryProject(root) as object)));
  const nestedDir = '手册/章节';
  const encodedDir = nestedDir.split('/').map(encodeURIComponent).join('/');
  const nested = { settings, external: { key: encodeURIComponent(nestedDir) }, responses: {
    revision: response(multi(row(`${prefix}/${encodedDir}/`))),
    list: response(multi(row(`${prefix}/!svn/rvr/17/${encodedDir}/`))),
  } };
  assert.ok(!('error' in (directoryProject(nested) as object)));
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
  let wrongListPrefix = false;
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
      if (r.method === 'PROPFIND' && r.path === base && r.headers.depth === '1') return text(listing(badRevision ? '18' : '16').replaceAll(prefix, wrongListPrefix ? '/other' : prefix), 'application/xml', 207);
      if (r.method === 'GET' && decodeURIComponent(r.path) === `${base}${file}`) return text(echo ? authorization : payload, 'text/plain');
      return text('Absent', 'text/plain', 404);
    });
    resource = (await addSyntheticResource(kit.records, kit.packs, kit.connectors, kit.admin, { system_pack: 'svn', name: '合成仓库', environment: 'test', origins: { svn: `${server.origin}${prefix}` }, allow_plaintext: [server.origin], settings })).id;
  });
  after(async () => { await server?.close(); await kit?.close(); await postgres?.stop(); if (root) await rm(root, { recursive: true, force: true }); });
  const read = (id: string) => kit.connectors.reader.read(id, { principal: kit.admin, run: null, purpose: 'sync' });
  const fileId = `svn:file:17/${encodeURIComponent(`${dir}/${file}`)}`;

  test('missing vault credential sends nothing', async () => {
    assert.equal((await read(`svn:directory:${dir}`)).ok, false);
    assert.equal(server.requests.length, 0);
  });
  test('directory pins revision and file reads preserve identical original bytes and request receipts', async () => {
    await setSyntheticCredential(kit.records, kit.connectors, kit.admin, resource, 'authorization', authorization);
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
  test('the pinned directory entry point lists the requested version with one network request',async()=>{
    const before=server.requests.length;
    const result=await read(`svn:directory-at:17/${encodeURIComponent(dir)}`);
    assert.ok(result.ok,JSON.stringify(result));assert.equal(result.revision,'17');
    assert.deepEqual(server.requests.slice(before).map(r=>[r.method,r.path,r.headers.depth]),[['PROPFIND',base,'1']]);
  });
  test('missing repository_path refuses all reads without network requests', async () => {
    await kit.connectors.admin.updateResource(kit.admin, resource, { unset_settings: ['repository_path'] });
    const count = server.requests.length;
    try {
      for (const [name, key] of [['directory', dir], ['file', `17/${encodeURIComponent(`${dir}/${file}`)}`]]) {
        const result = await kit.connectors.executeRead(resource, name, { id: key }, { principal: kit.admin, run: null, purpose: 'sync' });
        assert.equal(result.ok, false);
        if (!result.ok) assert.match(result.reason, /settings\.repository_path/, 'the internal administrator reason names the missing setting');
        const receipt = (await kit.records.store.get<ReadManifest>(result.manifest!))!.body;
        assert.equal(receipt.result, 'error');
        assert.equal(receipt.requests.length, 0);
        assert.doesNotMatch(receipt.reason ?? '', /settings\.repository_path/, 'the persistent receipt keeps its neutral reason');
      }
      assert.equal(server.requests.length, count);
    } finally {
      await kit.connectors.admin.updateResource(kit.admin, resource, { settings });
    }
  });
  test('wrong repository prefixes fail instead of producing a directory', async () => {
    await kit.connectors.admin.updateResource(kit.admin, resource, { settings: { repository_path: '/other' } });
    const count = server.requests.length;
    try {
      assert.equal((await read(`svn:directory:${dir}`)).ok, false);
      assert.equal(server.requests.length, count + 1, 'the mismatched latest response must stop before the pinned listing');
    } finally {
      await kit.connectors.admin.updateResource(kit.admin, resource, { settings });
    }
    const listed = server.requests.length;
    wrongListPrefix = true;
    try {
      assert.equal((await read(`svn:directory:${dir}`)).ok, false);
      assert.equal(server.requests.length, listed + 2, 'a matching latest response does not authorize a different repository in the pinned listing');
    } finally { wrongListPrefix = false; }
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
    await setSyntheticCredential(kit.records, kit.connectors, kit.admin, resource, 'authorization', refusedValue);
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

test('a child directory read uses only the explicitly pinned version root and never asks for current revision',async()=>{
 const api=await import('./api.ts');
 assert.equal(typeof api.directoryAtPlan,'function');
 const pinned={settings,external:{key:'17/'+encodeURIComponent(dir)},responses:{list:response(listing()),revision:response(multi(row(`${prefix}/${dir}/`,'18')))}};
 assert.deepEqual(api.directoryAtPlan(pinned),{requests:[{key:'list',route:'list',params:{rev:'17',dir}}],original:'list',done:true});
 const out=api.directoryAtProject(pinned) as any;
 assert.equal(out.revision,'17');assert.equal(out.artifacts[0].json.revision,'17');
 assert.ok(out.artifacts[0].json.members.filter((m:any)=>!m.directory).every((m:any)=>m.external.startsWith('svn:file:17/')));
});
test('pinned directory reads refuse excessive depth and member counts without truncation',async()=>{
 const api=await import('./api.ts');assert.equal(typeof api.directoryAtPlan,'function');
 const deep={settings,external:{key:'17/'+encodeURIComponent(Array(34).fill('synthetic').join('/'))}};
 assert.deepEqual(api.directoryAtPlan(deep),{requests:[],done:true});
 assert.equal((api.directoryAtProject(deep) as any).error.code,'svn.directory_budget');
 const many=multi(row(base),...Array.from({length:513},(_,i)=>row(base+'synthetic-'+i+'.adoc','16',false)));
 const out=api.directoryAtProject({settings,external:{key:'17/'+encodeURIComponent(dir)},responses:{list:response(many)}}) as any;
 assert.equal(out.error.code,'svn.directory_budget');assert.equal(out.artifacts,undefined);
});

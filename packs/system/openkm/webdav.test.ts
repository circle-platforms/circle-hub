import { addSyntheticResource, setSyntheticCredential, setSyntheticCredentials } from '../../../hub/connectors/testing/credentials.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import { SystemProfile } from '../../../contracts/src/resources.ts';
import type { ExternalRead } from '../../../hub/ports.ts';
import { startPostgres, type TemporaryPostgres } from '../../../hub/testing/postgres.ts';
import { SPEC_SEARCH_FILES, SPEC_SEARCH_TERMS, manualStoreFiles } from '../../../tests/fixtures/manual-store/index.ts';
import { artifactBytes, openSystemKit, type SystemKit } from '../testing/kit.ts';
import { startGuardedStore, type GuardedStore } from '../testing/webdav.ts';

const profile = SystemProfile.parse(JSON.parse(readFileSync(new URL('./system.json', import.meta.url), 'utf8')));
const SYNTHETIC_AUTHORIZATION = `Basic ${Buffer.from('docs-reader:Synthetic-Docs-42').toString('base64')}`;
const PREFIX = '/OpenKM/webdav/okm:root/DEMO';

describe('the profile', () => {
  test('shares the reads of the manual store: the functions are one module, byte for byte', () => {
    const own = readFileSync(new URL('./functions/webdav.ts', import.meta.url), 'utf8');
    const store = readFileSync(new URL('../manual-store/functions/webdav.ts', import.meta.url), 'utf8');
    assert.equal(own, store, 'copy packs/system/manual-store/functions/webdav.ts here after changing it');
    const other = SystemProfile.parse(JSON.parse(readFileSync(new URL('../manual-store/system.json', import.meta.url), 'utf8')));
    assert.deepEqual(
      profile.reads.map((r) => [r.name, r.external.replace('openkm:', ''), r.plan, r.project]),
      other.reads.map((r) => [r.name, r.external.replace('manual:', ''), r.plan, r.project]),
    );
  });

  test('is read-only and carries the vault credential as a static header on its one role', () => {
    for (const route of profile.routes) {
      assert.ok(route.method === 'GET' || route.method === 'PROPFIND');
      assert.equal(route.read, true);
      assert.ok(route.params !== undefined && Object.values(route.params).every((shape) => 'pattern' in shape && typeof shape.pattern === 'string'), 'each {path*} of a credential role holds a segment pattern');
    }
    assert.equal(profile.auth.kind, 'static_header');
    assert.ok(profile.auth.kind === 'static_header' && profile.auth.header.name === 'Authorization' && profile.auth.header.scheme === 'raw');
  });
});

describe('reads through the connectors with Basic authentication', () => {
  let postgres: TemporaryPostgres;
  let kit: SystemKit;
  let store: GuardedStore;
  let resource: string;

  before(async () => {
    postgres = await startPostgres();
    kit = await openSystemKit(postgres, ['openkm']);
    store = await startGuardedStore(manualStoreFiles(), SYNTHETIC_AUTHORIZATION, PREFIX);
    resource = (await addSyntheticResource(kit.records, kit.packs, kit.connectors, kit.admin, { system_pack: 'openkm', name: '合成文档库', environment: 'test', origins: { openkm: `${store.origin}${PREFIX}` }, allow_plaintext: [store.origin] })).id;
  });
  after(async () => {
    await store?.close();
    await kit?.close();
    await postgres?.stop();
  });

  const read = (id: string): Promise<ExternalRead> => kit.connectors.reader.read(id, { principal: kit.admin, run: null, purpose: 'sync' });

  test('without a credential nothing is sent', async () => {
    const before = store.requests.length;
    assert.equal((await read('openkm:cli:7.1')).ok, false);
    assert.equal(store.requests.length, before);
  });

  test('with the credential every request carries it; the search and the manuals read as in the manual store', async () => {
    await setSyntheticCredential(kit.records, kit.connectors, kit.admin, resource, 'authorization', SYNTHETIC_AUTHORIZATION);
    const manual = await read('openkm:cli:7.1');
    assert.equal(manual.ok, true, manual.ok ? '' : manual.reason);
    const before = store.requests.length;
    const search = await read(`openkm:spec-search:${SPEC_SEARCH_TERMS.join('+')}`);
    assert.ok(search.ok);
    const content = search.artifacts.find((a) => a.name === 'content')!;
    const text = new TextDecoder().decode(await artifactBytes(kit, content.artifact.body.sha256));
    // The search lists the folder and reads no file: keyword retrieval selects no source (owner ruling U19/U20).
    for (const name of SPEC_SEARCH_FILES) assert.ok(text.includes(`spec/${name}`), name);
    assert.match(text, /关键词检索已退役/);
    assert.deepEqual(store.requests.slice(before).map((r) => r.method), ['PROPFIND']);
    assert.ok(store.requests.length > 0 && store.requests.every((r) => r.headers.authorization === SYNTHETIC_AUTHORIZATION));
    assert.equal(store.refused, 0);
  });

  test('a refused credential stops: it is not sent again until an admin acts', async () => {
    await setSyntheticCredential(kit.records, kit.connectors, kit.admin, resource, 'authorization', 'Basic d3Jvbmc6Y3JlZGVudGlhbA==');
    assert.equal((await read(`openkm:file:spec/${encodeURIComponent('日志导出配置.md')}`)).ok, false);
    const refused = store.refused;
    assert.ok(refused >= 1);
    assert.equal((await read('openkm:cli:7.1')).ok, false);
    assert.equal(store.refused, refused, 'the wrong value is not sent again');
    assert.equal((await kit.connectors.admin.loginStatus(kit.admin, resource))?.stopped, true);
  });
});

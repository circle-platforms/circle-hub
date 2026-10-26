import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import { ReadPlanOutput, ReadProjectionOutput, SystemProfile } from '../../../contracts/src/resources.ts';
import { startStub, startWebDavStub, text, type StubServer } from '../../../hub/connectors/testing/api.ts';
import { markdownParser, xmlParser } from '../../../hub/refs/api.ts';
import type { ExternalRead } from '../../../hub/ports.ts';
import { startPostgres, type TemporaryPostgres } from '../../../hub/testing/postgres.ts';
import { QA_SEARCH_FILE, SPEC_SEARCH_FILES, SPEC_SEARCH_TERMS, SPEC_SEARCH_TEXT, manualStoreFiles, storeFiles } from '../../../tests/fixtures/manual-store/index.ts';
import { artifactBytes, openSystemKit, type SystemKit } from '../testing/kit.ts';
import { entriesOf, filePlan, folderLine, lineKey, manualCandidates, manualPlan, manualProject, membersOf, searchPlan, searchProject, setting, termsOf } from './functions/webdav.ts';

const profile = SystemProfile.parse(JSON.parse(readFileSync(new URL('./system.json', import.meta.url), 'utf8')));

/** A PROPFIND Depth 1 answer for a collection with these member links (D: prefixes, the collection listed first). */
function multistatus(collection: string, members: string[]): unknown {
  const xml = `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">${[collection, ...members].map((href) => `<D:response><D:href>${href}</D:href></D:response>`).join('')}</D:multistatus>`;
  return xmlParser.parse(new TextEncoder().encode(xml)).model;
}

describe('the profile', () => {
  test('is read-only by construction: PROPFIND Depth 1 and GET only, every route marked read', () => {
    for (const route of profile.routes) {
      assert.ok(route.method === 'GET' || route.method === 'PROPFIND', route.id);
      assert.equal(route.read, true);
      assert.equal(route.body, undefined);
    }
    assert.deepEqual(profile.routes.find((r) => r.method === 'PROPFIND')?.headers, { Depth: '1' });
    assert.ok(profile.routes.find((r) => r.method === 'PROPFIND')?.path.endsWith('/'), 'a collection URL keeps its trailing slash');
  });

  test('declares the spec search and the test-strategy search with the same functions', () => {
    const reads = new Map(profile.reads.map((r) => [r.name, r]));
    assert.deepEqual(reads.get('qa-search')?.plan, reads.get('spec-search')?.plan);
    assert.deepEqual(reads.get('qa-search')?.project, reads.get('spec-search')?.project);
    assert.equal(reads.get('qa-search')?.external, 'manual:qa-search');
  });
});

describe('the read functions', () => {
  test('settings are relative paths of plain segments, else the defaults', () => {
    assert.equal(setting({}, 'cli_folder'), 'cli');
    assert.equal(setting({}, 'qa_folder'), 'qa');
    assert.equal(setting({ cli_folder: '/docs/cli/' }, 'cli_folder'), 'docs/cli');
    assert.equal(setting({ cli_file: 'cli_cn/手册.md' }, 'cli_file'), 'cli_cn/手册.md');
    for (const bad of ['../x', 'a//b', 'a b', 'a;b', 7]) assert.equal(setting({ spec_folder: bad }, 'spec_folder'), 'spec', String(bad));
  });

  test('version lines of folder names: the numbers they end in, leading zeros and trailing .0 beyond the second part dropped', () => {
    assert.equal(folderLine('rel_x_10_7_1'), '10.7.1');
    assert.equal(folderLine('rel_y_10_7_0'), '10.7');
    assert.equal(folderLine('rel_x_010_07'), '10.7');
    assert.equal(folderLine('Manual-7.2'), '7.2');
    assert.equal(folderLine('rel_x'), null);
    assert.equal(folderLine('rel_x_10_7_1_patch'), null);
    assert.equal(lineKey('10.7.0'), '10.7');
    assert.equal(lineKey('7'), null);
  });

  test('a listing gives its members, the collection itself left out, names decoded', () => {
    const model = multistatus('/spec/', ['/spec/a%20b.md', '/spec/sub/', 'http://192.0.2.5/spec/c.md', '/spec/a%20b.md']);
    assert.deepEqual(entriesOf(model).map((e) => [e.name, e.collection]), [['a b.md', false], ['sub', true], ['c.md', false]]);
    assert.deepEqual(entriesOf({}), []);
    assert.deepEqual(entriesOf(multistatus('/spec/a.md', [])).map((e) => [e.href, e.name, e.collection]), [['/spec/a.md', 'a.md', false]], 'a lone file is a member, not the collection');
  });

  test('only direct members on the collection\'s own origin with a name that fits one path segment are read; the others are skipped with the reason', () => {
    const model = multistatus('/dav/spec/', [
      '/dav/spec/a.md',
      'http://192.0.2.77/dav/spec/foreign.md',
      '/dav/other/b.md',
      '/dav/spec/deep/c.md',
      '/dav/spec/x%3By.md',
      '/dav/spec/%2E%2E',
      'relative.md',
    ]);
    const { members, skipped } = membersOf(model);
    assert.deepEqual(members.map((m) => m.name), ['a.md', 'relative.md']);
    assert.deepEqual(skipped.map((s) => [s.name, s.why]), [
      ['foreign.md', 'origin'],
      ['b.md', 'outside'],
      ['c.md', 'outside'],
      ['x;y.md', 'name'],
      ['..', 'name'],
    ]);
    // Absolute links on the collection's own origin are members like paths.
    const absolute = multistatus('http://192.0.2.5/dav/spec/', ['http://192.0.2.5/dav/spec/a.md', 'HTTP://192.0.2.5/dav/spec/b.md', 'http://192.0.2.6/dav/spec/c.md']);
    assert.deepEqual(membersOf(absolute).members.map((m) => m.name), ['a.md', 'b.md']);
    assert.deepEqual(membersOf(absolute).skipped.map((s) => s.why), ['origin']);
  });

  test('the manual of a line: the matching subfolders in name order, both name families of one line, read by their paths below the folder', () => {
    const model = multistatus('/cli/', ['/cli/rel_comet_7_2/', '/cli/rel_orbit_7_2_0/', '/cli/rel_orbit_7_1_0/', '/cli/notes.md', '/cli/rel_orbit_7_2_1/', 'http://192.0.2.77/cli/rel_x_7_2/']);
    assert.deepEqual(manualCandidates(model, '7.2').map((e) => e.name), ['rel_comet_7_2', 'rel_orbit_7_2_0']);
    assert.deepEqual(manualCandidates(model, '7.1.0').map((e) => e.name), ['rel_orbit_7_1_0']);
    assert.deepEqual(manualCandidates(model, 'x'), []);
    assert.deepEqual(manualPlan({ round: 1, external: { type: 'cli', key: '7.2' }, settings: {} }).requests, [{ key: 'list', route: 'list', params: { dir: 'cli' } }]);
    const second = manualPlan({ round: 2, external: { type: 'app', key: '7.2' }, settings: { app_folder: 'cli', app_file: 'app_cn/app.md' }, responses: { list: { ok: true, model } } });
    assert.deepEqual(second.requests, [
      { key: 'file-1', route: 'file', params: { path: 'cli/rel_comet_7_2/app_cn/app.md' } },
      { key: 'file-2', route: 'file', params: { path: 'cli/rel_orbit_7_2_0/app_cn/app.md' } },
    ]);
    assert.ok(ReadPlanOutput.safeParse(second).success);
    const third = manualPlan({ round: 3, external: { type: 'cli', key: '7.2' }, responses: { list: { ok: true, model }, 'file-1': { ok: false }, 'file-2': { ok: true } } });
    assert.deepEqual(third, { requests: [], done: true, original: 'file-2' });
    // A manual the Hub holds back (credential scan hit) is the original when no other candidate answers, so the read fails with its digest.
    const held = manualPlan({ round: 3, external: { type: 'cli', key: '7.2' }, responses: { list: { ok: true, model }, 'file-1': { ok: false, error: { code: 'SOURCE_CREDENTIAL' } }, 'file-2': { ok: false, error: { code: 'SOURCE_UNREACHABLE' } } } });
    assert.deepEqual(held, { requests: [], done: true, original: 'file-1' });
    assert.deepEqual(manualPlan({ round: 3, external: { type: 'cli', key: '7.2' }, responses: { list: { ok: true, model }, 'file-1': { ok: false }, 'file-2': { ok: false } } }), { requests: [], done: true }, 'nothing readable and nothing held back is still not found');
    assert.deepEqual(manualPlan({ round: 1, external: { type: 'spec', key: '7.2' } }), { requests: [], done: true });
    const projected = manualProject({ external: { type: 'cli', key: '7.2' }, settings: {}, responses: { list: { ok: true, model }, 'file-2': { ok: true, text: '# CLI' } }, original: 'file-2' }) as { artifacts: Array<{ name: string; json?: { folder: string } }>; warnings?: string[] };
    assert.ok(ReadProjectionOutput.safeParse(projected).success);
    assert.equal(projected.artifacts.find((a) => a.name === 'meta')?.json?.folder, 'rel_orbit_7_2_0');
    assert.ok((projected.warnings ?? []).some((w) => w.includes('rel_x_7_2')), 'a candidate on another origin is named as skipped');
  });

  test('the spec search parses the terms of its key and selects nothing with them', () => {
    assert.deepEqual(termsOf('信标组+权重继承+TTL+%E9%85%8D%E7%BD%AE+ttl+'), SPEC_SEARCH_TERMS);
    const names = Object.keys(storeFiles()).filter((p) => p.startsWith('/spec/'));
    const model = multistatus('/spec/', names.map((p) => encodeURI(p)));
    // Round two plans no read at all: a keyword search chooses no source (owner ruling U19/U20, 2026-10-24).
    const plan = searchPlan({ round: 2, external: { type: 'spec-search', key: SPEC_SEARCH_TERMS.join('+') }, responses: { list: { ok: true, model } } });
    assert.ok(ReadPlanOutput.safeParse(plan).success);
    assert.deepEqual(plan.requests, []);
    assert.equal(plan.done, true);
    assert.equal(plan.original, 'list');
    const projected = searchProject({ external: { type: 'spec-search', key: SPEC_SEARCH_TERMS.join('+') }, settings: {}, responses: { list: { ok: true, model } }, original: 'list' }) as { note?: string; complete?: boolean; artifacts: Array<{ name: string; text?: string; json?: { files: Array<{ name: string; path: string }>; terms: string[]; terms_used: boolean; selection: string } }> };
    assert.ok(ReadProjectionOutput.safeParse(projected).success);
    const meta = projected.artifacts.find((a) => a.name === 'meta')!.json!;
    assert.deepEqual(meta.terms, SPEC_SEARCH_TERMS);
    assert.equal(meta.terms_used, false);
    assert.equal(meta.selection, 'retired');
    // Every readable member is listed, in name order: the two files of the feature and the ones no term touches alike.
    const listed = membersOf(model).members.filter((entry) => !entry.collection).map((entry) => entry.name).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    assert.deepEqual(meta.files.map((f) => f.name), listed);
    assert.ok(listed.length > SPEC_SEARCH_FILES.length, 'the listing is not narrowed to the terms');
    for (const name of SPEC_SEARCH_FILES) assert.ok(listed.includes(name), name);
    assert.ok(meta.files.every((f) => f.path.startsWith('spec/')));
    const content = projected.artifacts.find((a) => a.name === 'content')!.text!;
    assert.match(content, /关键词检索已退役/);
    assert.match(content, /缺的事实/);
    assert.match(content, /下一步/);
    assert.equal(projected.complete, undefined);
  });

  test('a search names the listed members it may not read and is incomplete only when a folder was not listed', () => {
    const model = multistatus('/spec/', ['/spec/%E4%BF%A1%E6%A0%87%E7%BB%84.md', 'http://192.0.2.77/spec/%E4%BF%A1%E6%A0%87%E7%BB%84%E5%A4%96%E9%83%A8.md', '/spec/other.md']);
    assert.deepEqual(searchPlan({ round: 2, external: { type: 'spec-search', key: '信标组' }, responses: { list: { ok: true, model } } }).requests, []);
    const projected = searchProject({ external: { type: 'spec-search', key: '信标组' }, settings: {}, responses: { list: { ok: true, model } }, original: 'list' }) as { complete?: boolean; note?: string; warnings?: string[]; artifacts: Array<{ name: string; text?: string; json?: { files: Array<{ name: string }>; skipped: Array<{ name: string; why: string }> } }> };
    assert.ok(ReadProjectionOutput.safeParse(projected).success);
    assert.equal(projected.complete, undefined, 'a listing that arrived needs no read any more');
    assert.ok((projected.warnings ?? []).some((w) => w.includes('信标组外部.md')));
    const meta = projected.artifacts.find((a) => a.name === 'meta')!.json!;
    assert.deepEqual(meta.files.map((f) => f.name), ['other.md', '信标组.md']);
    assert.deepEqual(meta.skipped.map((entry) => entry.name), ['信标组外部.md']);
    assert.match(projected.artifacts.find((a) => a.name === 'content')!.text ?? '', /列表里没有读的项（1 个）：信标组外部\.md/);
    // A folder whose listing did not arrive is the missing fact: not complete, and named.
    const unread = searchProject({ external: { type: 'spec-search', key: '信标组' }, settings: {}, responses: {}, original: 'list' }) as { complete?: boolean; artifacts: Array<{ name: string; text?: string }> };
    assert.equal(unread.complete, false);
    assert.match(unread.artifacts.find((a) => a.name === 'content')!.text ?? '', /没有读到的目录：spec/);
  });

  test('the test-strategy search lists qa/ (settings.qa_folder) with the same functions', () => {
    assert.deepEqual(searchPlan({ round: 1, external: { type: 'qa-search', key: '信标组' }, settings: {} }).requests, [{ key: 'list', route: 'list', params: { dir: 'qa' } }]);
    assert.deepEqual(searchPlan({ round: 1, external: { type: 'qa-search', key: '信标组' }, settings: { qa_folder: 'docs/qa' } }).requests[0].params, { dir: 'docs/qa' });
    const model = multistatus('/qa/', ['/qa/%E4%BF%A1%E6%A0%87%E7%BB%84%E6%B5%8B%E8%AF%95%E7%AD%96%E7%95%A5.md']);
    const projected = searchProject({ external: { type: 'qa-search', key: '信标组' }, settings: {}, responses: { list: { ok: true, model } }, original: 'list' }) as { artifacts: Array<{ name: string; text?: string; json?: { title: string; folder: string } }> };
    assert.match(projected.artifacts[0].text ?? '', /^# 测试策略检索/);
    assert.deepEqual([projected.artifacts[1].json?.folder, /测试策略/.test(projected.artifacts[1].json?.title ?? '')], ['qa', true]);
  });

  test('a file by its path; dot segments and empty segments plan nothing', () => {
    assert.deepEqual(filePlan({ external: { key: 'spec/a%20b.md' } }).requests, [{ key: 'file', route: 'file', params: { path: 'spec/a b.md' } }]);
    for (const bad of ['', 'spec/../x', 'spec//x', '%2E%2E/x']) assert.deepEqual(filePlan({ external: { key: bad } }), { requests: [], done: true }, bad);
  });
});

describe('reads through the connectors', () => {
  let postgres: TemporaryPostgres;
  let kit: SystemKit;
  let dav: StubServer;
  let odd: StubServer;
  let main: string;
  let mixed: string;

  before(async () => {
    postgres = await startPostgres();
    kit = await openSystemKit(postgres, ['manual-store']);
    dav = await startWebDavStub(manualStoreFiles());
    main = (await kit.connectors.admin.addResource(kit.admin, { system_pack: 'manual-store', name: '合成手册库', environment: 'test', origins: { 'manual-store': dav.origin } })).id;
    // A store whose spec listing also links a file on another host, a file outside the folder and a name with a ';'.
    const files: Record<string, string> = { '/spec/信标组权重.md': '# 信标组权重\n\n组内信标继承权重。\n' };
    odd = await startStub((request) => {
      const path = decodeURIComponent(request.path);
      if (request.method === 'PROPFIND' && path === '/spec/') {
        const hrefs = ['/spec/', '/spec/%E4%BF%A1%E6%A0%87%E7%BB%84%E6%9D%83%E9%87%8D.md', 'http://192.0.2.77/spec/%E4%BF%A1%E6%A0%87%E7%BB%84%E5%A4%96%E9%83%A8.md', '/elsewhere/%E4%BF%A1%E6%A0%87%E7%BB%84.md', '/spec/%E4%BF%A1%E6%A0%87%E7%BB%84%3Bx.md'];
        return text(`<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">${hrefs.map((h) => `<D:response><D:href>${h}</D:href></D:response>`).join('')}</D:multistatus>`, 'application/xml; charset=utf-8', 207);
      }
      if (request.method === 'GET' && files[path] !== undefined) return text(files[path], 'text/markdown; charset=utf-8');
      return text('not found', 'text/plain', 404);
    });
    // One enabled resource per external type: the second store is enabled only for its own test.
    await kit.connectors.admin.disable(kit.admin, main);
    mixed = (await kit.connectors.admin.addResource(kit.admin, { system_pack: 'manual-store', name: '链接混杂的手册库', environment: 'test', origins: { 'manual-store': odd.origin } })).id;
    await kit.connectors.admin.disable(kit.admin, mixed);
    await kit.connectors.admin.enable(kit.admin, main);
  });
  after(async () => {
    await odd?.close();
    await dav?.close();
    await kit?.close();
    await postgres?.stop();
  });

  const read = (id: string): Promise<ExternalRead> => kit.connectors.reader.read(id, { principal: kit.admin, run: null, purpose: 'sync' });
  const ok = (r: ExternalRead) => {
    assert.equal(r.ok, true, r.ok ? '' : r.reason);
    return r as Extract<ExternalRead, { ok: true }>;
  };
  const named = (r: Extract<ExternalRead, { ok: true }>, name: string) => {
    const found = r.artifacts.find((a) => a.name === name);
    assert.ok(found, `artifact ${name}`);
    return found.artifact.body;
  };

  test('the fixture files are what write.ts writes', () => {
    assert.deepEqual(manualStoreFiles(), storeFiles(), 'run node tests/fixtures/manual-store/write.ts');
  });

  test('the CLI manual of a line: the original keeps its NUL bytes, the content has none', async () => {
    const manual = ok(await read('manual:cli:7.1'));
    const original = await artifactBytes(kit, named(manual, 'original').sha256);
    assert.ok(original.includes(0), 'the original holds NUL bytes');
    const content = await artifactBytes(kit, named(manual, 'content').sha256);
    assert.ok(!content.includes(0));
    const model = markdownParser.parse(content).model;
    assert.ok(model.blocks.some((b) => b.text.includes('**orbit beacon add**')));
    const meta = JSON.parse(new TextDecoder().decode(await artifactBytes(kit, named(manual, 'meta').sha256)));
    assert.deepEqual([meta.line, meta.folder, meta.nul_removed], ['7.1', 'rel_orbit_7_1_0', 3]);
    assert.ok(dav.requests.some((r) => r.method === 'PROPFIND' && r.path === '/cli/' && r.headers.depth === '1'));
  });

  test('the manual of a line under the other name family, and a line without a manual', async () => {
    const meta = JSON.parse(new TextDecoder().decode(await artifactBytes(kit, named(ok(await read('manual:cli:7.2')), 'meta').sha256)));
    assert.equal(meta.folder, 'rel_comet_7_2');
    ok(await read('manual:app:7.1'));
    const missing = await read('manual:cli:9.9');
    assert.ok(missing.ok && missing.absent?.code==='SOURCE_ABSENT');
    const noApp=await read('manual:app:7.2');assert.ok(noApp.ok && noApp.absent?.code==='SOURCE_ABSENT','no application manual for 7.2');
  });

  test('the spec search lists the members of the folder and reads no file', async () => {
    const before = dav.requests.length;
    const search = ok(await read(`manual:spec-search:${SPEC_SEARCH_TERMS.join('+')}`));
    const content = new TextDecoder().decode(await artifactBytes(kit, named(search, 'content').sha256));
    assert.match(content, /关键词检索已退役/);
    assert.match(content, /file:<路径>/);
    assert.ok(!content.includes(SPEC_SEARCH_TEXT), 'a keyword search retrieves no file text any more');
    const meta = JSON.parse(new TextDecoder().decode(await artifactBytes(kit, named(search, 'meta').sha256)));
    assert.equal(meta.terms_used, false);
    assert.deepEqual(meta.terms, SPEC_SEARCH_TERMS);
    for (const name of SPEC_SEARCH_FILES) assert.ok(meta.files.some((f: { name: string }) => f.name === name), name);
    assert.deepEqual(dav.requests.slice(before).map((r) => `${r.method} ${decodeURIComponent(r.path)}`), ['PROPFIND /spec/'], 'the folder is listed once and no file is read');
  });

  test('the test-strategy search lists qa/ and reads no file', async () => {
    const before = dav.requests.length;
    const search = ok(await read(`manual:qa-search:${encodeURIComponent('信标组')}`));
    const content = new TextDecoder().decode(await artifactBytes(kit, named(search, 'content').sha256));
    assert.ok(content.includes(QA_SEARCH_FILE), content.slice(0, 400));
    assert.match(content, /没有打分、没有选择、没有读取/);
    assert.deepEqual(dav.requests.slice(before).map((r) => `${r.method} ${decodeURIComponent(r.path)}`), ['PROPFIND /qa/']);
  });

  test('the terms of a search key do not change what is listed', async () => {
    const contentOf = async (key: string): Promise<string> => {
      const search = ok(await read(`manual:spec-search:${key}`));
      return new TextDecoder().decode(await artifactBytes(kit, named(search, 'content').sha256));
    };
    const matched = await contentOf(SPEC_SEARCH_TERMS.join('+'));
    const unmatched = await contentOf('%E6%B2%A1%E6%9C%89%E8%BF%99%E4%B8%AA%E8%AF%8D');
    // Reproduces the retired rule: a term no file name held gave an empty listing. Only the disclosed terms differ now.
    const withoutTerms = (text: string): string[] => text.split('\n').filter((line) => !line.startsWith('检索词：'));
    assert.deepEqual(withoutTerms(unmatched), withoutTerms(matched));
    assert.match(unmatched, /检索词：没有这个词（只作披露/);
    assert.ok(unmatched.includes(SPEC_SEARCH_FILES[0]!), 'a term that matches nothing still lists every member');
  });

  test('links to another host or outside the folder in a listing are skipped, not followed, and the read still succeeds', async () => {
    await kit.connectors.admin.disable(kit.admin, main);
    await kit.connectors.admin.enable(kit.admin, mixed);
    const before = odd.requests.length;
    let search: ExternalRead;
    try {
      search = await read(`manual:spec-search:${encodeURIComponent('信标组')}`);
    } finally {
      await kit.connectors.admin.disable(kit.admin, mixed);
      await kit.connectors.admin.enable(kit.admin, main);
    }
    assert.equal(search.ok, true, search.ok ? '' : search.reason);
    const sent = odd.requests.slice(before);
    assert.deepEqual(sent.map((r) => `${r.method} ${decodeURIComponent(r.path)}`), ['PROPFIND /spec/'], 'a search lists the folder and follows nothing');
    const content = new TextDecoder().decode(await artifactBytes(kit, (search as Extract<ExternalRead, { ok: true }>).artifacts.find((a) => a.name === 'content')!.artifact.body.sha256));
    assert.ok(content.includes('spec/信标组权重.md'));
    assert.match(content, /列表里没有读的项/);
  });

  test('a file by its path, and only reads reach the store', async () => {
    const file = ok(await read(`manual:file:${encodeURI('product/ORBIT_V7.1.0产品说明.md')}`));
    assert.match(new TextDecoder().decode(await artifactBytes(kit, named(file, 'original').sha256)), /产品说明/);
    assert.equal((await read('manual:file:spec/../../etc/passwd')).ok, false);
    assert.ok(dav.requests.every((r) => r.method === 'GET' || r.method === 'PROPFIND'));
  });
});

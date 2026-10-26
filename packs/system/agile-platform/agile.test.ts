import { addSyntheticResource, setSyntheticCredential, setSyntheticCredentials } from '../../../hub/connectors/testing/credentials.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import { MAX_NESTED_READS, ReadPlanOutput, ReadProjectionOutput, SystemProfile } from '../../../contracts/src/resources.ts';
import { startAgileStub, type AgileStub } from '../../../hub/connectors/testing/api.ts';
import { kityminderParser } from '../../../hub/refs/api.ts';
import type { ExternalRead } from '../../../hub/ports.ts';
import { startPostgres, type TemporaryPostgres } from '../../../hub/testing/postgres.ts';
import { AGILE_ACCOUNT, DOCUMENTS, REVIEW_ANCESTORS, REVIEW_TITLE, ROOTS, agileOptions, agileTrees } from '../../../tests/fixtures/agile/index.ts';
import { artifactBytes, openSystemKit, type SystemKit } from '../testing/kit.ts';
import {
  CASE_MEMBER,
  MAX_ROOTS,
  bodyId,
  caseContent,
  casePlan,
  caseProject,
  documentsOf,
  listedDocuments,
  mindmapPlan,
  mindmapProject,
  rootsOf,
  rootsPlan,
  searchKeyOf,
  searchPlan,
  searchProject,
  termsOf,
  treePlan,
} from './functions/agile.ts';

const profile = SystemProfile.parse(JSON.parse(readFileSync(new URL('./system.json', import.meta.url), 'utf8')));

describe('the profile', () => {
  test('reads only: POST reads on literal paths, the login kept out of the routes, sha512 then base64 for the password', () => {
    for (const route of profile.routes) {
      assert.equal(route.read, true);
      assert.equal(route.method, 'POST');
      assert.match(route.path, /^\/agile\/get_[a-z_]+\/$/);
      assert.equal(route.role, 'agile-api');
    }
    assert.ok(profile.auth.kind === 'login_token');
    if (profile.auth.kind !== 'login_token') return;
    assert.deepEqual(profile.auth.login.envelope.ok, [1000]);
    assert.equal(profile.auth.credentials.find((c) => c.name === 'password')?.digest, 'sha512_base64');
    assert.equal(profile.auth.header.scheme, 'raw', 'the token goes in the header without a prefix');
  });
});

describe('the read functions', () => {
  test('ids go as numbers when they are, roots come from the settings', () => {
    assert.equal(bodyId('41275'), 41275);
    assert.equal(bodyId('ab12'), 'ab12');
    assert.deepEqual(rootsOf({ roots: ['7715', 7714, '7715', 'bad id', 1.5] }), ['7715', '7714']);
    assert.deepEqual(rootsOf({}), []);
  });

  test('the documents of a tree with the folders above them from the root title down', () => {
    const docs = documentsOf({ root: { id: ROOTS.second, title: 'COMET' }, children: agileTrees()[ROOTS.second] });
    const review = docs.find((d) => d.id === DOCUMENTS.review);
    assert.deepEqual([review?.title, review?.ancestors], [REVIEW_TITLE, REVIEW_ANCESTORS]);
    assert.ok(docs.every((d) => d.root.id === ROOTS.second));
    const listedOnly = documentsOf({ root: { id: 'r', title: null }, children: [{ label: 'm', id: 'f', cases: ['d9'], children: [{ label: 'x', id: 'd8', cases: [], children: [] }] }] });
    assert.deepEqual(listedOnly.map((d) => [d.id, d.title, d.ancestors]), [['d8', 'x', ['m']], ['d9', null, ['m']]], 'a document with a node of its own first, then those a folder lists without a node');
  });

  test('the folder lists are cumulative: a document belongs to the deepest folder that lists it, never to the root that lists them all', () => {
    // The shape of the platform's real trees: the root node of the answer lists every document below it, each folder lists the
    // documents below that folder, leaves without cases are documents, and a leaf that lists cases is a folder whose documents
    // have no node of their own.
    const children = [
      {
        label: 'FAMY',
        id: 1,
        cases: [11, 12, 13, 14],
        children: [
          { label: '030：项目', id: 2, cases: [11, 12], children: [{ label: '060：10.7.6', id: 3, cases: [11, 12], children: [{ label: 'bug to case a', id: 11, cases: [], children: [] }, { label: 'bug to case b', id: 12, cases: [], children: [] }] }] },
          { label: '101：客户', id: 4, cases: [14], children: [] },
          { label: '含孤文档的目录', id: 5, cases: [13], children: [] },
        ],
      },
    ];
    for (const title of [null, 'FAMY']) {
      const docs = documentsOf({ root: { id: '1', title }, children });
      const where = Object.fromEntries(docs.map((d) => [d.id, d.ancestors.join(' / ')]));
      assert.deepEqual(where, {
        '11': 'FAMY / 030：项目 / 060：10.7.6',
        '12': 'FAMY / 030：项目 / 060：10.7.6',
        '14': 'FAMY / 101：客户',
        '13': 'FAMY / 含孤文档的目录',
      }, `root title ${String(title)}: the root node is the first folder once, not twice`);
      assert.equal(docs.length, 4);
      assert.equal(docs.find((d) => d.id === '11')?.title, 'bug to case a');
      assert.equal(docs.find((d) => d.id === '13')?.title, null, 'a listed document has no title of its own');
    }
    // A response without the root node takes the root title as the first folder.
    const bare = documentsOf({ root: { id: '1', title: 'FAMY' }, children: children[0].children });
    assert.deepEqual(bare.find((d) => d.id === '11')?.ancestors, ['FAMY', '030：项目', '060：10.7.6']);
  });

  test('the roots listing of the real platform: data is an array and the total is a sibling of it', () => {
    const page1 = { ok: true, json: { code: 1000, msg: 'ok', data: [{ id: 9001, label: 'a' }, { id: 9002, label: 'b' }], total: 23 } };
    assert.deepEqual(treePlan({ round: 2, external: { key: '7715' }, responses: { 'page-1': page1 } }).requests.map((r) => r.body), [{ page: 2 }, { page: 3 }], 'the pages come from the top-level total');
    const plan = rootsPlan({ round: 2, settings: { roots: ['7715', '9001'] }, responses: { 'page-1': page1, 'subtree-1': { ok: true, json: { code: 1000, data: [] } }, 'subtree-2': { ok: true, json: { code: 1000, data: [] } } } });
    assert.deepEqual(plan.requests.map((r) => r.body), [{ page: 2 }, { page: 3 }], 'a configured root without a title asks for the next pages');
  });

  test('the tree plan reads only the root pages the total announces', () => {
    assert.equal(treePlan({ round: 1, external: { key: '7715' } }).original, 'subtree');
    const page1 = { ok: true, json: { code: 1000, data: { total: 23, list: [{ id: 7000, label: 'x' }] } } };
    assert.deepEqual(treePlan({ round: 2, external: { key: '7715' }, responses: { 'page-1': page1 } }).requests.map((r) => r.body), [{ page: 2 }, { page: 3 }]);
    assert.deepEqual(treePlan({ round: 2, external: { key: '7000' }, responses: { 'page-1': page1 } }).requests, []);
    assert.deepEqual(treePlan({ round: 1, external: { key: 'a b' } }), { requests: [], done: true });
  });

  test('the mind-map plan reads the document and the configured trees, then refreshes cached trees once when the document is in none', () => {
    const first = mindmapPlan({ round: 1, external: { key: DOCUMENTS.review }, settings: { roots: [ROOTS.second] } });
    assert.deepEqual(first.reads, [{ external: 'agile:tree:roots' }]);
    const tree = { ok: true, cached: true, content: { root: { id: ROOTS.second, title: 'COMET' }, children: agileTrees()[ROOTS.second] } };
    assert.deepEqual(mindmapPlan({ round: 2, external: { key: DOCUMENTS.review }, settings: { roots: [ROOTS.second] }, reads: { [`agile:tree:${ROOTS.second}`]: tree } }), { requests: [], done: true });
    assert.deepEqual(mindmapPlan({ round: 2, external: { key: 'nowhere' }, settings: { roots: [ROOTS.second] }, reads: { [`agile:tree:${ROOTS.second}`]: tree } }).reads, [{ external: `agile:tree:${ROOTS.second}`, refresh: true }]);
  });

  test('one aggregate tree read covers all configured roots within the nested-read limit', () => {
    const roots = Array.from({ length: 25 }, (_, k) => String(7000 + k));
    assert.equal(2 <= MAX_NESTED_READS, true, 'one aggregate and its refresh fit the limit');
    const first = mindmapPlan({ round: 1, external: { key: DOCUMENTS.review }, settings: { roots } });
    assert.ok(ReadPlanOutput.safeParse(first).success, 'the plan of round 1 is a valid read plan');
    assert.deepEqual(first.reads,[{external:'agile:tree:roots'}]);
    const cached = {'agile:tree:roots':{ok:true,cached:true,content:{roots:roots.map(id=>({id,title:id})),documents:[],complete:true}}};
    const second = mindmapPlan({ round: 2, external: { key: DOCUMENTS.review }, settings: { roots }, reads: cached });
    assert.ok(ReadPlanOutput.safeParse(second).success);
    assert.equal((first.reads?.length ?? 0) + (second.reads?.length ?? 0) <= MAX_NESTED_READS, true);
    assert.deepEqual(second.reads,[{external:'agile:tree:roots',refresh:true}]);
    const search = searchPlan({ round: 1, external: { key: '健康检查' }, settings: { roots } });
    assert.ok(ReadPlanOutput.safeParse(search).success);
    assert.deepEqual(search.reads,[{external:'agile:tree:roots'}]);
  });

  test('a document the trees could not place is unknown, not a document without folders, when a root was not read', () => {
    const tree = { ok: true, cached: false, content: { root: { id: ROOTS.second, title: 'COMET' }, children: agileTrees()[ROOTS.second] } };
    const answer = { case: { ok: true, json: { code: 1000, data: '{"root":{"data":{"text":"x"}}}' }, sha256: 'a'.repeat(64) } };
    const failed = mindmapProject({ external: { key: 'nowhere' }, settings: { roots: [ROOTS.first, ROOTS.second] }, responses: answer, reads: { [`agile:tree:${ROOTS.first}`]: { ok: false }, [`agile:tree:${ROOTS.second}`]: tree }, original: 'case' }) as { complete?: boolean; note?: string };
    assert.ok(ReadProjectionOutput.safeParse(failed).success);
    assert.equal(failed.complete, false);
    assert.match(failed.note ?? '', new RegExp(ROOTS.first));
    const many = Array.from({ length: 12 }, (_, k) => String(7000 + k));
    const dropped = mindmapProject({ external: { key: 'nowhere' }, settings: { roots: many }, responses: answer, reads: {}, original: 'case' }) as { complete?: boolean; note?: string };
    assert.equal(dropped.complete, false);
    assert.match(dropped.note ?? '', /7010/);
    const allRead = mindmapProject({ external: { key: 'nowhere' }, settings: { roots: [ROOTS.second] }, responses: answer, reads: { [`agile:tree:${ROOTS.second}`]: tree }, original: 'case' }) as { complete?: boolean };
    assert.equal(allRead.complete, undefined, 'every configured root was read: the document is in none of them');
    const found = mindmapProject({ external: { key: DOCUMENTS.review }, settings: { roots: [ROOTS.first, ROOTS.second] }, responses: answer, reads: { [`agile:tree:${ROOTS.first}`]: { ok: false }, [`agile:tree:${ROOTS.second}`]: tree }, original: 'case' }) as { complete?: boolean };
    assert.equal(found.complete, undefined, 'a placed document has its folders whatever another root did');
  });

  test('a search over roots that were not read is incomplete and says which roots it did not search', () => {
    const tree = { ok: true, cached: false, content: { root: { id: ROOTS.second, title: 'COMET' }, children: agileTrees()[ROOTS.second] } };
    const out = searchProject({ external: { key: '健康检查' }, settings: { roots: [ROOTS.first, ROOTS.second] }, responses: {}, reads: { [`agile:tree:${ROOTS.first}`]: { ok: false }, [`agile:tree:${ROOTS.second}`]: tree }, original: 'listing' }) as { complete?: boolean; note?: string; artifacts: Array<{ name: string; json: { unread?: string[]; documents: unknown[] } }> };
    assert.ok(ReadProjectionOutput.safeParse(out).success);
    assert.equal(out.complete, false);
    assert.deepEqual(out.artifacts[0].json.unread, [ROOTS.first]);
    assert.match(out.note ?? '', new RegExp(ROOTS.first));
    assert.ok(out.artifacts[0].json.documents.length > 0);
    const none = searchProject({ external: { key: '健康检查' }, settings: { roots: [ROOTS.first] }, responses: {}, reads: { [`agile:tree:${ROOTS.first}`]: { ok: false } }, original: 'listing' }) as { complete?: boolean };
    assert.equal(none.complete, false, 'no similar list found in roots that were not read is unknown, not none');
  });

  test('a search leaves out the documents its key excludes (the reviewed document itself)', () => {
    assert.deepEqual(searchKeyOf(`健康检查+HTTP+!${DOCUMENTS.review}+!bad%20id`), { terms: ['健康检查', 'HTTP'], exclude: [DOCUMENTS.review] });
    assert.deepEqual(termsOf(`%21x+!${DOCUMENTS.review}`), ['!x'], 'an encoded ! is a term, a raw one names a document');
    const tree = { ok: true, content: { root: { id: ROOTS.second, title: 'COMET' }, children: agileTrees()[ROOTS.second] } };
    const reads = { [`agile:tree:${ROOTS.second}`]: tree };
    // The exclusion is an exact document id, not a title match: the listing holds every other document of the root.
    assert.ok(listedDocuments(reads, [ROOTS.second]).some((d) => d.id === DOCUMENTS.review));
    assert.ok(!listedDocuments(reads, [ROOTS.second], [DOCUMENTS.review]).some((d) => d.id === DOCUMENTS.review));
    assert.ok(listedDocuments(reads, [ROOTS.second], [DOCUMENTS.review]).length > 0);
  });

  test('search terms are parsed for disclosure only and list every document whatever they are', () => {
    assert.deepEqual(termsOf('健康检查+HTTP+%E6%8E%A2%E6%B4%BB'), ['健康检查', 'HTTP', '探活']);
    assert.deepEqual(searchKeyOf('健康检查').terms, ['健康检查']);
    // Reproduces the retired rule: a title was kept when a term stood in it at a letter boundary (支持HTTP探活 and not
    // HTTPS 探测). A listing does not depend on the terms at all, so no title is matched any more.
    const tree = { ok: true, content: { root: { id: ROOTS.second, title: 'COMET' }, children: agileTrees()[ROOTS.second] } };
    const reads = { [`agile:tree:${ROOTS.second}`]: tree };
    const every = listedDocuments(reads, [ROOTS.second]);
    assert.ok(every.length > 1, 'the configured root holds more than one document');
    assert.deepEqual(every.map((d) => d.id), documentsOf({ root: { id: ROOTS.second, title: 'COMET' }, children: agileTrees()[ROOTS.second] }).map((d) => d.id));
  });

  test('case document functions: plan requests case data alone, project wraps document with agile id', () => {
    const plan = casePlan({ external: { key: '950001' } });
    assert.ok(ReadPlanOutput.safeParse(plan).success);
    assert.deepEqual(plan, { requests: [{ key: 'case', route: 'case-data', body: { id: 950001 } }], done: true, original: 'case' });
    assert.deepEqual(casePlan({ external: { key: 'bad/id' } }), { requests: [], done: true });

    // Object data
    const objData = { root: { data: { text: 'title' }, children: [] } };
    const wrappedObj = caseContent('950001', objData);
    assert.equal(wrappedObj.ok, true);
    if (wrappedObj.ok) {
      assert.equal(wrappedObj.artifact.name, 'content');
      assert.deepEqual((wrappedObj.artifact.json as Record<string, unknown>)[CASE_MEMBER], { id: '950001' });
    }

    // String data
    const strData = JSON.stringify({ root: { data: { text: 'title' }, children: [] } });
    const wrappedStr = caseContent('950001', strData);
    assert.equal(wrappedStr.ok, true);
    if (wrappedStr.ok) {
      assert.ok(typeof wrappedStr.artifact.text === 'string');
      const parsed = JSON.parse(wrappedStr.artifact.text!);
      assert.deepEqual(parsed[CASE_MEMBER], { id: '950001' });
      assert.equal(parsed.root.data.text, 'title');
    }

    // Refusals
    assert.equal(caseContent('950001', { not_root: true }).ok, false);
    assert.equal(caseContent('950001', 'not json').ok, false);
    assert.equal(caseContent('950001', { [CASE_MEMBER]: { id: 'other' }, root: {} }).ok, false);

    // Project
    const projected = caseProject({
      external: { key: '950001' },
      responses: { case: { ok: true, json: { code: 1000, data: objData }, sha256: 'f'.repeat(64) } },
      original: 'case',
    });
    assert.ok(ReadProjectionOutput.safeParse(projected).success);
    const proj = projected as { revision?: string; artifacts: Array<{ name: string; json?: unknown }> };
    assert.equal(proj.revision, 'f'.repeat(64));
    assert.deepEqual(proj.artifacts.find((a) => a.name === 'meta')?.json, { id: '950001' });
  });
});

describe('reads through the connectors', () => {
  let postgres: TemporaryPostgres;
  let kit: SystemKit;
  let agile: AgileStub;
  let resource: string;

  before(async () => {
    postgres = await startPostgres();
    kit = await openSystemKit(postgres, ['agile-platform']);
    agile = await startAgileStub(agileOptions());
    resource = (
      await addSyntheticResource(kit.records, kit.packs, kit.connectors, kit.admin, {
        system_pack: 'agile-platform',
        name: '合成敏捷平台',
        environment: 'test',
        origins: { 'agile-oauth': agile.origin, 'agile-api': agile.origin },
        allow_plaintext: [agile.origin],
        settings: { roots: [ROOTS.first, ROOTS.second] },
      })
    ).id;
    await setSyntheticCredential(kit.records, kit.connectors, kit.admin, resource, 'username', AGILE_ACCOUNT.username);
    await setSyntheticCredential(kit.records, kit.connectors, kit.admin, resource, 'password', AGILE_ACCOUNT.password);
  });
  after(async () => {
    await agile?.close();
    await kit?.close();
    await postgres?.stop();
  });

  const read = (id: string): Promise<ExternalRead> => kit.connectors.reader.read(id, { principal: kit.user, run: null, purpose: '运行输入' });
  const ok = (r: ExternalRead) => {
    assert.equal(r.ok, true, r.ok ? '' : r.reason);
    return r as Extract<ExternalRead, { ok: true }>;
  };
  const json = async (r: Extract<ExternalRead, { ok: true }>, name: string): Promise<unknown> => {
    const artifact = r.artifacts.find((a) => a.name === name);
    assert.ok(artifact, name);
    return JSON.parse(new TextDecoder().decode(await artifactBytes(kit, artifact.artifact.body.sha256)));
  };

  test('a mind map: the original answer, the decoded KityMinder content and the meta with the folders from the root down', async () => {
    const map = ok(await read(`agile:mindmap:${DOCUMENTS.review}`));
    assert.deepEqual(map.artifacts.map((a) => a.name), ['original', 'content', 'meta']);
    assert.match(map.revision ?? '', /^[0-9a-f]{64}$/);
    const content = map.artifacts.find((a) => a.name === 'content')!.artifact.body;
    assert.equal(content.media_type, 'application/json');
    const parsed = kityminderParser.parse(await artifactBytes(kit, content.sha256));
    assert.equal(parsed.model.doubleEncoded, false, 'the content is the inner document, decoded once');
    assert.equal(parsed.model.nodes[0].text, REVIEW_TITLE);
    assert.deepEqual(await json(map, 'meta'), { id: DOCUMENTS.review, title: REVIEW_TITLE, ancestors: REVIEW_ANCESTORS, root: { id: ROOTS.second, title: 'COMET' } });
    assert.equal(agile.logins, 1);
    const login = agile.requests.find((r) => r.path === '/oauth/login/');
    assert.notEqual((login?.json as { password?: string }).password, AGILE_ACCOUNT.password, 'the password goes as its digest');
  });

  test('the root trees are read once and served from the cache for the next document', async () => {
    const before = agile.count('/agile/get_child_node_task/');
    ok(await read(`agile:mindmap:${DOCUMENTS.tiny}`));
    assert.equal(agile.count('/agile/get_child_node_task/'), before, 'the cached trees serve the second read');
  });

  test('a document in no configured tree refreshes the cached trees once and keeps an unknown title', async () => {
    const before = agile.count('/agile/get_child_node_task/');
    const map = ok(await read(`agile:mindmap:${DOCUMENTS.unlisted}`));
    assert.deepEqual(await json(map, 'meta'), { id: DOCUMENTS.unlisted, title: null, ancestors: [], root: null });
    assert.equal(agile.count('/agile/get_child_node_task/'), before + 2, 'each configured root read again once');
  });

  test('a tree with its root title from the paged listing', async () => {
    const tree = ok(await read(`agile:tree:${ROOTS.second}`));
    const meta = (await json(tree, 'meta')) as { title: string };
    assert.equal(meta.title, 'COMET');
    assert.ok(agile.requests.some((r) => r.path === '/agile/get_root_node/' && (r.json as { page: number }).page === 2));
    assert.ok(!agile.requests.some((r) => r.path === '/agile/get_root_node/' && (r.json as { page: number }).page > 3), 'no page past the total');
  });

  test('a search lists the documents of the configured roots, discloses the terms and reads no document', async () => {
    const search = ok(await read(`agile:search:${encodeURIComponent('健康检查')}+HTTP+${encodeURIComponent('探活')}`));
    const content = (await json(search, 'content')) as { documents: { id: string; title: string | null }[]; terms: string[]; terms_used: boolean; outlines?: unknown; total: number };
    assert.deepEqual(content.terms, ['健康检查', 'HTTP', '探活']);
    assert.equal(content.terms_used, false);
    assert.equal(content.outlines, undefined, 'a search reads no document, so it holds no outline');
    assert.equal(content.documents.length, content.total);
    assert.ok(content.documents.some((d) => d.id === DOCUMENTS.review), 'the listing holds every document, not only the ones a term touched');
    assert.match((await json(search, 'meta') as { title: string; selection: string }).title, /文档清单/);
    assert.equal((await json(search, 'meta') as { selection: string }).selection, 'retired');
    // A term no title holds lists exactly the same documents: the terms decide nothing.
    const none = ok(await read('agile:search:%E6%B2%A1%E6%9C%89'));
    assert.deepEqual(((await json(none, 'content')) as { documents: { id: string }[] }).documents.map((d) => d.id), content.documents.map((d) => d.id));
    const excluded = ok(await read(`agile:search:${encodeURIComponent('健康检查')}+HTTP+${encodeURIComponent('探活')}+!${DOCUMENTS.review}`));
    const others = (await json(excluded, 'content')) as { documents: { id: string }[]; excluded: string[] };
    assert.ok(!others.documents.some((d) => d.id === DOCUMENTS.review), 'the reviewed document is not its own similar test list');
    assert.deepEqual(others.excluded, [DOCUMENTS.review]);
  });

  test('a search requests no case data: the trees it lists from are all it reads', async () => {
    const before = agile.requests.length;
    ok(await read(`agile:search:${encodeURIComponent('健康检查')}`));
    const sent = agile.requests.slice(before);
    assert.ok(sent.length > 0);
    assert.ok(!sent.some((r) => r.path === '/agile/get_case_data/'), 'no document is read by a search');
  });

  test('a case document (agile:case:<id>): requests case data directly without reading trees, wraps content with agile id', async () => {
    const treesBefore = agile.count('/agile/get_child_node_task/');
    const c = ok(await read(`agile:case:${DOCUMENTS.review}`));
    assert.equal(agile.count('/agile/get_child_node_task/'), treesBefore, 'no tree walk for an agile:case read');
    assert.deepEqual(c.artifacts.map((a) => a.name), ['original', 'content', 'meta']);
    assert.match(c.revision ?? '', /^[0-9a-f]{64}$/);
    const content = (await json(c, 'content')) as { agile?: { id: string }; root: { data: { text: string } } };
    assert.deepEqual(content.agile, { id: DOCUMENTS.review });
    assert.equal(content.root.data.text, REVIEW_TITLE);
    assert.deepEqual(await json(c, 'meta'), { id: DOCUMENTS.review });
  });

  test('a wrong password is tried once and never again until an admin acts', async () => {
    agile.setPassword('Another#Secret43');
    agile.expireTokens();
    const logins = agile.logins;
    assert.equal((await read(`agile:mindmap:${DOCUMENTS.review}`)).ok, false);
    assert.equal(agile.logins, logins + 1, 'one login after the expired answer');
    assert.equal((await read(`agile:mindmap:${DOCUMENTS.tiny}`)).ok, false);
    assert.equal(agile.logins, logins + 1, 'no second login');
    assert.equal((await kit.connectors.admin.loginStatus(kit.admin, resource))?.stopped, true);
    assert.ok(agile.requests.every((r) => r.method === 'POST'));
  });
});

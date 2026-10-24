import { labelOf } from '../../../../contracts/generated/vocabulary.ts';
import {productVariableNameAvailable} from '../../../../hub/server/variables.ts';
import { addSyntheticResource, setSyntheticCredential, setSyntheticCredentials } from '../../../../hub/connectors/testing/credentials.ts';
// The case index end to end through the real Hub packages: the pack registry publishes the agile-platform, build-site and
// apv packs (publish checks included), the connectors read a synthetic agile platform (the case-index corpus with the
// product's two roots) and a synthetic build site (two released builds whose command trees differ, an NSAE alias), the
// knowledge service syncs the product (the plan lists each build's case documents, the cases producer files them in
// batches) and the Hub's own views answer: facets by line and module and the index by document over every case, placed
// or left unplaced, and the impact of the version difference on the cases filed under commands (regression scope), each
// against the corpus truth computed while the corpus was built.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { FacetView, ImpactView, IndexView } from '../../../../contracts/src/views.ts';
import { createConnectors, osIsolationAvailable, type Connectors } from '../../../../hub/connectors/api.ts';
import { startAgileStub, startBuildSiteStub, type AgileStub, type StaticFile, type StubServer } from '../../../../hub/connectors/testing/api.ts';
import { createKnowledge, createKnowledgeReader, type Knowledge, type SyncReport } from '../../../../hub/knowledge/api.ts';
import type { ExternalReaderPort, PacksPort, ProductHandle } from '../../../../hub/ports.ts';
import type { Principal } from '../../../../hub/records/api.ts';
import { createDefaultRegistry } from '../../../../hub/refs/api.ts';
import { createPackRegistry, createPacksPort, temporaryDirectory } from '../../../../hub/runs/api.ts';
import { startPostgres, type TemporaryPostgres } from '../../../../hub/testing/postgres.ts';
import { openTestRecords, type TestRecordsKit } from '../../../../hub/testing/records.ts';
import { CASE_INDEX_ACCOUNT, CATALOG_A, CATALOG_B, CHANGED_COMMANDS, caseCorpus, caseIndexAgileOptions, commandPath, commandTreeXml, listedFor } from '../../../../tests/fixtures/case-index/index.ts';
import { caseStatement } from './cases.ts';
import { PACK_DIRECTORIES, stagePack } from '../../../workflow/case-review/packaging.ts';

const corpus = caseCorpus({ names: ['APV', 'NSAE'] });
const EARLY = 'Rel_APV_10_6_1_12';
const LATE = 'Rel_APV_10_6_4_20';
const ALIAS = 'Rel_NSAE_10_6_1_5';
const latin1 = (value: string): Uint8Array => new Uint8Array(Buffer.from(value, 'latin1'));
const HTML = 'text/html; charset=ISO-8859-1';

/** The build site: two released APV builds with their own command trees and an NSAE alias of the later one. */
function site(): Record<string, StaticFile> {
  const page = (title: string, body: string): string => `<!DOCTYPE HTML PUBLIC "-//IETF//DTD HTML//EN">\n<HTML><HEAD><TITLE>${title}</TITLE></HEAD>\n<BODY>\n${body}\n</BODY>\n</HTML>\n`;
  const files = (build: string): string => `<BLOCKQUOTE> <A href=/builds/DemoOS-${build}.array>http://192.0.2.10/builds/DemoOS-${build}.array</A><BR><A href=/builds/command_tree-${build}.xml>http://192.0.2.10/builds/command_tree-${build}.xml</A><BR></BLOCKQUOTE>`;
  const entry = (build: string, built: string, released: string): string => `<font color=red>${build} (build on  ${built} ): Released on ${released} </font> </br> ${files(build)}`;
  return {
    '/builds/index.html': { body: latin1(page('Synthetic builds', '<A HREF=rel_apv_10_6_1.html>rel_apv_10_6_1</A><BR><A HREF=rel_apv_10_6_4.html>rel_apv_10_6_4</A><BR><A HREF=rel_nsae_10_6_1.html>rel_nsae_10_6_1</A><BR>')), type: HTML },
    '/builds/rel_apv_10_6_1.html': { body: latin1(page('APV 10.6.1', entry(EARLY, '2026-03-02 10:00:00', '2026-03-05'))), type: HTML },
    '/builds/rel_apv_10_6_4.html': { body: latin1(page('APV 10.6.4', entry(LATE, '2026-09-01 10:00:00', '2026-09-03'))), type: HTML },
    '/builds/rel_nsae_10_6_1.html': { body: latin1(page('NSAE 10.6.1', `<font color=red>${ALIAS} (build on  2026-09-01 11:00:00 ): based on ${LATE} Released on 2026-09-04 </font> </br> <BLOCKQUOTE> <A href=/builds/DemoOS-${ALIAS}.array>http://192.0.2.10/builds/DemoOS-${ALIAS}.array</A><BR></BLOCKQUOTE>`)), type: HTML },
    [`/builds/command_tree-${EARLY}.xml`]: { body: latin1(commandTreeXml(CATALOG_A)), type: 'application/xml' },
    [`/builds/command_tree-${LATE}.xml`]: { body: latin1(commandTreeXml(CATALOG_B)), type: 'application/xml' },
  };
}

/** Every case of the documents a build lists. `placed` means the code filed it under a command of that catalog. */
function listedCases(line: string, catalog: 'a' | 'b') {
  const listed = new Set(listedFor(corpus, line));
  return corpus.truth.filter((d) => listed.has(d.id)).flatMap((d) => d.cases.map((k) => ({ doc: d, k, placed: k.commands[catalog].length > 0 })));
}

/** Cases the code files under a command. Impact counts these; facet and index also count the unplaced rest. */
function indexedCases(line: string, catalog: 'a' | 'b') {
  return listedCases(line, catalog).filter((item) => item.placed);
}

let postgres: TemporaryPostgres;
let kit: TestRecordsKit;
let admin: Principal;
let packs: PacksPort;
let connectors: Connectors;
let knowledge: Knowledge;
let views: ExternalReaderPort;
let apv: ProductHandle;
let agile: AgileStub;
let buildSite: StubServer;
let first: SyncReport;
let removeTemp: () => Promise<void>;

before(async () => {
  postgres = await startPostgres();
  let clock = Date.parse('2026-10-22T08:00:00.000Z');
  const now = (): Date => new Date((clock += 7));
  kit = await openTestRecords({ postgres, now });
  const temp = await temporaryDirectory('circle-hub-case-index-');
  removeTemp = () => temp.remove();
  const isolation = await osIsolationAvailable();
  const principal = (user: { id: string; name: string; role: Principal['role'] }): Principal => ({ id: user.id, name: user.name, role: user.role });
  admin = principal((await kit.principals.bootstrapAdmin('管理员')).user);
  const owner = principal(await kit.principals.createUser(admin, '包作者'));
  await kit.authorizations.grantPublishRight(admin, owner.id);
  const registry = createPackRegistry({ variableNameAvailable:(name,tx)=>productVariableNameAvailable(kit,name,tx),records: kit, extractDir: join(temp.path, 'extracted'), now, sandbox: { requireOsIsolation: isolation } });
  for (const id of ['agile-platform', 'build-site', 'apv']) {
    const outcome = await registry.publish(owner, await stagePack(PACK_DIRECTORIES[id], join(temp.path, 'staged', id)));
    assert.equal(outcome.ok, true, `publishing ${id}: ${JSON.stringify(outcome).slice(0, 1500)}`);
  }
  await registry.activate(admin, 'apv');
  packs = createPacksPort(registry);
  agile = await startAgileStub(caseIndexAgileOptions(corpus));
  buildSite = await startBuildSiteStub(site());
  connectors = createConnectors({ records: kit, packs, log: () => undefined, sandbox: { requireOsIsolation: isolation }, resourceCacheMs: 0, now });
  const resource = await addSyntheticResource(kit, packs, connectors, admin, {
    system_pack: 'agile-platform',
    name: '合成敏捷平台',
    environment: 'test',
    origins: { 'agile-oauth': agile.origin, 'agile-api': agile.origin },
    allow_plaintext: [agile.origin],
    settings: { roots: corpus.roots },
  });
  await setSyntheticCredential(kit, connectors, admin, resource.id, 'username', CASE_INDEX_ACCOUNT.username);
  await setSyntheticCredential(kit, connectors, admin, resource.id, 'password', CASE_INDEX_ACCOUNT.password);
  await addSyntheticResource(kit, packs, connectors, admin, { system_pack: 'build-site', name: '合成构建站', environment: 'test', origins: { 'build-site': `${buildSite.origin}/builds` }, settings: { index_page: 'index.html' } });
  knowledge = createKnowledge({ records: kit, parsers: createDefaultRegistry(), packs, external: connectors.reader, jev: null, sandbox: { requireOsIsolation: isolation }, clock: now, admin });
  views = createKnowledgeReader(knowledge);
  apv = (await packs.productById('apv')) as ProductHandle;
  for(const variable of apv.product.variables??[])await kit.variables.setVariable(admin,variable.name,variable.default,'合成用例测试显式部署设置');
  first = await knowledge.syncProduct(apv, { by: admin });
});

after(async () => {
  await agile?.close();
  await buildSite?.close();
  await kit?.close();
  await removeTemp?.();
  await postgres?.stop();
});

async function view<T>(id: string): Promise<T> {
  const read = await views.read(id, { principal: admin, run: null, purpose: '测试' });
  if (!read.ok) assert.fail(`${id}: ${read.reason}`);
  const original = read.artifacts.find((a) => a.name === 'original')!;
  const source = await kit.artifacts.source(admin, original.artifact.body.sha256, { consumer: 'function' });
  return JSON.parse(new TextDecoder().decode(source!.bytes!)) as T;
}

describe('the sync with the case index', () => {
  test('produces both builds with their cases, skips the alias, and the plan note counts the documents', () => {
    assert.equal(first.error, null);
    assert.deepEqual(first.builds.map((b) => [b.name, b.outcome]), [
      [EARLY, 'produced'],
      [ALIAS, 'skipped'],
      [LATE, 'produced'],
    ]);
    assert.ok(first.builds.every((b) => (b.skipped ?? 0) === 0), JSON.stringify(first.builds));
    assert.match(first.plan.note ?? '', /产品的根 2 个（APV、NSAE）/);
    assert.match(first.plan.note ?? '', /上级目录里没有版本线 5 份/);
    assert.ok(agile.requests.some((r) => r.path === '/agile/get_case_data/'));
  });

  test('facets of the later build: every case by line and module, placed and unplaced, as the corpus has them', async () => {
    const facets = await view<FacetView>(`knowledge:facets:apv:${LATE}?kind=case&by=line,module`);
    const cases = listedCases('10.6.4', 'b');
    const expected = new Map<string, number>();
    for (const { doc } of cases) {
      const key = JSON.stringify({ line: doc.line, module: doc.module });
      expected.set(key, (expected.get(key) ?? 0) + 1);
    }
    assert.deepEqual(new Map(facets.rows.map((r) => [JSON.stringify({ line: r.values.line, module: r.values.module }), r.count])), expected);
    assert.equal(facets.total, cases.length);
    const unplaced = cases.filter((item) => !item.placed).length;
    assert.ok(unplaced > 0);
    assert.ok(facets.notes.includes(`${labelOf('knowledge_count', 'tree_unplaced_entries')} ${unplaced} 个，标在根下，计入合计`));
    assert.equal(facets.skipped, 0);
  });

  test('the index of the later build by document: every case of every document, placed and unplaced, with its data', async () => {
    const index = await view<IndexView>(`knowledge:index:apv:${LATE}?kind=case&key=document`);
    const cases = listedCases('10.6.4', 'b');
    const byDocument = new Map<string, typeof cases>();
    for (const item of cases) byDocument.set(item.doc.id, [...(byDocument.get(item.doc.id) ?? []), item]);
    assert.deepEqual(Object.keys(index.keys).sort(), [...byDocument.keys()].sort());
    for (const [document, items] of byDocument) {
      const entries = index.keys[document].map((digest) => index.entries[digest]);
      assert.equal(entries.length, items.length, document);
      const byNode = new Map(entries.map((e) => [e.data.node as string, e]));
      for (const { doc, k, placed } of items) {
        const entry = byNode.get(k.node);
        assert.ok(entry, `${document}:${k.node}`);
        assert.equal(entry.statement, caseStatement(entry.data));
        assert.ok(entry.statement.startsWith(`${document}:${k.node} | ${k.title}`));
        assert.deepEqual(entry.data.commands, k.commands.b.map(commandPath).sort());
        assert.deepEqual([entry.data.line, entry.data.train, entry.data.module, entry.data.defects, entry.data.stories, entry.data.vague_expected], [doc.line, doc.train, doc.module, k.defects, k.stories, k.vague_expected]);
        assert.match(entry.reference, placed ? /^tree:[0-9a-f]{64}\/commands\// : /^tree:[0-9a-f]{64}\/@[0-9a-f]{64}$/);
      }
    }
    const unplaced = cases.filter((item) => !item.placed).length;
    assert.ok(index.notes.includes(`${labelOf('knowledge_count', 'tree_unplaced_entries')} ${unplaced} 个，标在根下`));
  });

  test('the impact of the version difference: the changed commands and exactly the cases filed on them in each build', async () => {
    const impact = await view<ImpactView>(`knowledge:impact:apv:${EARLY}..${LATE}?changed=definition&attached=case`);
    assert.deepEqual(impact.changes.map((c) => [c.path, c.change]).sort(), [
      [commandPath('relay encrypt mode'), 'removed'],
      [commandPath('widget health interval'), 'modified'],
      [commandPath('widget pool rename'), 'added'],
    ]);
    assert.deepEqual(impact.changes.map((c) => c.path).sort(), CHANGED_COMMANDS.map(commandPath).sort());
    for (const path of CHANGED_COMMANDS.map(commandPath)) {
      const placement = impact.placements.find((p) => p.path === path);
      const from = indexedCases('10.6.1', 'a').filter(({ k }) => k.commands.a.map(commandPath).includes(path)).length;
      const to = indexedCases('10.6.4', 'b').filter(({ k }) => k.commands.b.map(commandPath).includes(path)).length;
      assert.deepEqual([placement?.from.length ?? 0, placement?.to.length ?? 0], [from, to], path);
    }
    assert.ok((impact.placements.find((p) => p.path === commandPath('widget health interval'))?.to.length ?? 0) > 0);
    assert.equal(impact.truncated, false);
  });

  test('the index returns each case, placed or unplaced, under every defect id it lists', async () => {
    const index = await view<IndexView>(`knowledge:index:apv:${LATE}?kind=case&key=defects`);
    const cases = listedCases('10.6.4', 'b');
    const expected = new Map<string, number>();
    for (const { k } of cases) for (const id of k.defects) expected.set(id, (expected.get(id) ?? 0) + 1);
    assert.ok(expected.size > 0);
    assert.ok(expected.has('61001'));
    for (const [id, count] of expected) {
      assert.equal(index.keys[id]?.length, count, id);
      for (const digest of index.keys[id]) assert.ok((index.entries[digest].data.defects as string[]).includes(id));
    }
  });

  test('the NSAE name reads the root of the APV build it is based on', async () => {
    const byAlias = await view<FacetView>(`knowledge:facets:apv:${ALIAS}?kind=case&by=module`);
    const byBase = await view<FacetView>(`knowledge:facets:apv:${LATE}?kind=case&by=module`);
    assert.deepEqual(byAlias.rows, byBase.rows);
    assert.equal(byAlias.build.root, byBase.build.root);
  });

  test('a second sync changes nothing: the lists are the same, every build is skipped', async () => {
    const again = await knowledge.syncProduct(apv, { by: admin });
    assert.deepEqual(again.builds.map((b) => b.outcome), ['skipped', 'skipped', 'skipped']);
    assert.match(again.builds[0].reason, /已有根/);
  });

  test('while the agile platform cannot be read, builds that would list cases are withheld and no current root moves', async () => {
    const before = await knowledge.currentRoot('apv', '10.6.1');
    agile.setPassword('Another#Secret43');
    agile.expireTokens();
    const outage = await knowledge.syncProduct(apv, { by: admin });
    assert.deepEqual(
      outage.builds.map((build) => [build.name, build.outcome, build.root]),
      [[ALIAS, 'skipped', null]],
    );
    assert.match(outage.builds[0]?.reason ?? '', /别名/);
    assert.equal(outage.error, null);
    assert.match(outage.plan.note ?? '', /这次不列构建/);
    assert.match(outage.plan.note ?? '', /找到的 \d+ 个构建没有列出/);
    assert.equal((await knowledge.currentRoot('apv', '10.6.1'))?.root, before?.root);
    assert.ok(before !== null);
  });
});

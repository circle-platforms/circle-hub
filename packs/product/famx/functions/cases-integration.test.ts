import { labelOf } from '../../../../contracts/generated/vocabulary.ts';
import {productVariableNameAvailable} from '../../../../hub/server/variables.ts';
import { addSyntheticResource, setSyntheticCredential, setSyntheticCredentials } from '../../../../hub/connectors/testing/credentials.ts';
// The case index end to end through the real Hub packages: the pack registry publishes the agile-platform, build-site and
// famx packs (publish checks included), the connectors read a synthetic agile platform (the case-index corpus with the
// product's two roots) and a synthetic build site (two released builds whose command trees differ, an FAMY alias), the
// knowledge service syncs the product (the plan lists each build's case documents, the cases producer files them in
// batches) and the Hub's own views answer: facets by line and module and the index by document over every case, placed
// or left unplaced, and the impact of the version difference on the cases filed under commands (regression scope), each
// against the corpus truth computed while the corpus was built.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { FacetView, IndexView } from '../../../../contracts/src/views.ts';
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

const corpus = caseCorpus({ names: ['FAMX', 'FAMY'] });
const EARLY = 'Rel_FAMX_10_6_1_12';
const LATE = 'Rel_FAMX_10_6_4_20';
const ALIAS = 'Rel_FAMY_10_6_1_5';
const latin1 = (value: string): Uint8Array => new Uint8Array(Buffer.from(value, 'latin1'));
const HTML = 'text/html; charset=ISO-8859-1';

/** The build site: two released FAMX builds with their own command trees and an FAMY alias of the later one. */
function site(): Record<string, StaticFile> {
  const page = (title: string, body: string): string => `<!DOCTYPE HTML PUBLIC "-//IETF//DTD HTML//EN">\n<HTML><HEAD><TITLE>${title}</TITLE></HEAD>\n<BODY>\n${body}\n</BODY>\n</HTML>\n`;
  const files = (build: string): string => `<BLOCKQUOTE> <A href=/builds/DemoOS-${build}.array>http://192.0.2.10/builds/DemoOS-${build}.array</A><BR><A href=/builds/command_tree-${build}.xml>http://192.0.2.10/builds/command_tree-${build}.xml</A><BR></BLOCKQUOTE>`;
  const entry = (build: string, built: string, released: string): string => `<font color=red>${build} (build on  ${built} ): Released on ${released} </font> </br> ${files(build)}`;
  return {
    '/builds/index.html': { body: latin1(page('Synthetic builds', '<A HREF=rel_famx_10_6_1.html>rel_famx_10_6_1</A><BR><A HREF=rel_famx_10_6_4.html>rel_famx_10_6_4</A><BR><A HREF=rel_famy_10_6_1.html>rel_famy_10_6_1</A><BR>')), type: HTML },
    '/builds/rel_famx_10_6_1.html': { body: latin1(page('FAMX 10.6.1', entry(EARLY, '2026-03-02 10:00:00', '2026-03-05'))), type: HTML },
    '/builds/rel_famx_10_6_4.html': { body: latin1(page('FAMX 10.6.4', entry(LATE, '2026-09-01 10:00:00', '2026-09-03'))), type: HTML },
    '/builds/rel_famy_10_6_1.html': { body: latin1(page('FAMY 10.6.1', `<font color=red>${ALIAS} (build on  2026-09-01 11:00:00 ): based on ${LATE} Released on 2026-09-04 </font> </br> <BLOCKQUOTE> <A href=/builds/DemoOS-${ALIAS}.array>http://192.0.2.10/builds/DemoOS-${ALIAS}.array</A><BR></BLOCKQUOTE>`)), type: HTML },
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
let famx: ProductHandle;
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
  for (const id of ['agile-platform', 'build-site', 'famx']) {
    const outcome = await registry.publish(owner, await stagePack(PACK_DIRECTORIES[id], join(temp.path, 'staged', id)));
    assert.equal(outcome.ok, true, `publishing ${id}: ${JSON.stringify(outcome).slice(0, 1500)}`);
  }
  await registry.activate(admin, 'famx');
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
  famx = (await packs.productById('famx')) as ProductHandle;
  for(const variable of famx.product.variables??[])await kit.variables.setVariable(admin,variable.name,variable.default,'合成用例测试显式部署设置');
  first = await knowledge.syncProduct(famx, { by: admin });
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
  test('lists both builds with their device-spelling aliases and batch-produces no case index', () => {
    assert.equal(first.error, null);
    // 决定 65 (owner, 2026-10-25): the pack declares each build's device spelling — its own name with `_` replaced by
    // `.` and nothing else folded — as a verified alias of that build, so a version probe can compare either spelling.
    // The plan therefore carries one extra alias row per build and the Hub records it from the plan's base.
    assert.deepEqual(first.builds.map((b) => [b.name, b.outcome]), [
      ['Rel.FAMX.10.6.1.12', 'skipped'],
      [EARLY, 'produced'],
      [ALIAS, 'skipped'],
      ['Rel.FAMX.10.6.4.20', 'skipped'],
      [LATE, 'produced'],
    ]);
    for (const [device, base] of [['Rel.FAMX.10.6.1.12', EARLY], ['Rel.FAMX.10.6.4.20', LATE]] as const) {
      const row = first.builds.find((b) => b.name === device);
      assert.equal(row?.root, null, `${device} is an alias row: it uses the base build's tree`);
      assert.match(row?.reason ?? '', new RegExp(`别名，使用 ${base} 的树`), device);
    }
    assert.match(first.builds.find((b) => b.name === ALIAS)?.reason ?? '', /别名/);
    assert.ok(first.builds.filter((b) => b.outcome === 'produced').every((b) => (b.skipped ?? 0) === 0), JSON.stringify(first.builds));
    // The owner's 10-24 revision (famx README, docs/hub-r4-tasks/kb-seedling.md) turned `case_index` and `spec_index`
    // off in product.json: cases, defects and specifications are no longer batch-produced into per-build or product-wide
    // roots; Circle feeds them per use and `cases.ts` stays for that projection (covered by cases.test.ts). So the plan
    // note counts pages, list pages and builds — and no case documents.
    assert.match(first.plan.note ?? '', /读了 4 个页面；3 个列表页；列出 5 个构建（5 个已发布，0 个只有名字）/);
    assert.ok(!/产品的根/.test(first.plan.note ?? ''), first.plan.note ?? '');
    assert.equal(agile.requests.some((r) => r.path === '/agile/get_case_data/'), false, 'no case data is read for a batch index');
  });

  test('batch production is off: no case facets and no case index are produced', async () => {
    // Same revision as above. The views answer with nothing rather than with a guessed corpus, and the projection the
    // functions still offer is asserted per use in cases.test.ts.
    const facets = await view<FacetView>(`knowledge:facets:famx:${LATE}?kind=case&by=module`);
    assert.deepEqual(facets.rows, []);
    const index = await view<IndexView>(`knowledge:index:famx:${LATE}?kind=case&key=defects`);
    assert.deepEqual(Object.keys(index.keys), []);
    const byDocument = await view<IndexView>(`knowledge:index:famx:${LATE}?kind=case&key=document`);
    assert.deepEqual(Object.keys(byDocument.keys), []);
    assert.equal(caseStatement({ id: '1', name: 'n', steps: [] }).length > 0, true, 'the projection function stays available for per-use feeding');
  });





  test('the FAMY name reads the root of the FAMX build it is based on', async () => {
    const byAlias = await view<FacetView>(`knowledge:facets:famx:${ALIAS}?kind=case&by=module`);
    const byBase = await view<FacetView>(`knowledge:facets:famx:${LATE}?kind=case&by=module`);
    assert.deepEqual(byAlias.rows, byBase.rows);
    assert.equal(byAlias.build.root, byBase.build.root);
  });

  test('a second sync changes nothing: the lists are the same, every build is skipped', async () => {
    const again = await knowledge.syncProduct(famx, { by: admin });
    // 决定 65: five planned rows — two builds, their two device-spelling aliases and the FAMY alias.
    assert.deepEqual(again.builds.map((b) => [b.name, b.outcome]), [
      ['Rel.FAMX.10.6.1.12', 'skipped'],
      [EARLY, 'skipped'],
      [ALIAS, 'skipped'],
      ['Rel.FAMX.10.6.4.20', 'skipped'],
      [LATE, 'skipped'],
    ]);
    assert.match(again.builds.find((b) => b.name === EARLY)?.reason ?? '', /已有根/);
  });

  test('while the agile platform cannot be read, the planned rows are still reported and no current root moves', async () => {
    const before = await knowledge.currentRoot('famx', '10.6.1');
    agile.setPassword('Another#Secret43');
    agile.expireTokens();
    const outage = await knowledge.syncProduct(famx, { by: admin });
    // 决定 65: the two device-spelling aliases are planned rows too, so an outage reports them beside the FAMY alias;
    // none of the three carries a root, and no current root moves.
    assert.deepEqual(
      outage.builds.map((build) => [build.name, build.outcome, build.root]),
      [
        ['Rel.FAMX.10.6.1.12', 'skipped', null],
        [EARLY, 'skipped', outage.builds.find((build) => build.name === EARLY)?.root ?? null],
        [ALIAS, 'skipped', null],
        ['Rel.FAMX.10.6.4.20', 'skipped', null],
        [LATE, 'skipped', outage.builds.find((build) => build.name === LATE)?.root ?? null],
      ],
    );
    assert.match(outage.builds.find((build) => build.name === ALIAS)?.reason ?? '', /别名/);
    assert.equal(outage.error, null);
    // The build site is a different connector and the case index is off (owner's 10-24 revision), so an unreadable agile
    // platform withholds no listing any more: the note is the ordinary one and every planned row is still reported.
    assert.match(outage.plan.note ?? '', /列出 5 个构建/);
    assert.equal((await knowledge.currentRoot('famx', '10.6.1'))?.root, before?.root);
    assert.ok(before !== null);
  });
});

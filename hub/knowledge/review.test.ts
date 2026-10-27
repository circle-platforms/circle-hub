import {createTestParserRegistry as createDefaultRegistry} from '../testing/parsers.ts';
// Regression tests for the findings of the milestone 2 review of this package, one scenario per finding: a list producer
// broken for every document, failures that are not memoized, too many documents skipped or isolated, a document that times
// out alone, skipped documents shown as absent, a list producer that reads the build, a recheck with more than 50 skipped
// documents, `__proto__` as a data value, a view over a source whose credential findings were accepted, list ids copied into
// every record, a plan answer over 16 MiB and one bad build in it, the per-batch byte cap, the earlier root cited for an
// entry the later root has, a NaN limit, an escaped `..` in a build name, the facet row order, and views cut over budget.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { FacetView, ImpactView, IndexView } from '../../contracts/src/views.ts';
import { KnowledgeBuildBody, TreeRootBody } from '../../contracts/src/knowledge.ts';
import type { BuildInfo, KnownBuild } from '../../contracts/src/product.ts';
import type { ExternalRead, ExternalReadContext } from '../ports.ts';
import type { ActionBody, DerivedCoverageInput, IngestInput, Principal, SourceArtifact } from '../records/api.ts';

import type { TemporaryPostgres } from '../testing/postgres.ts';
import { createKnowledge, createKnowledgeReader } from './api.ts';
import { parseViewId } from './views.ts';
import { Builds } from './builds.ts';
import { INDEX, ProduceDetail } from './store.ts';
import {
  BASE_CATALOG,
  CASES_SOURCE,
  DEFAULT_CATALOGS,
  DEFAULT_PRODUCERS,
  STATIC_PLAN_SOURCE,
  casesProducer,
  catalogXml,
  extraProducer,
  linkPage,
  makeWorld,
  mindMap,
  sandboxIsolation,
  startPostgres,
  type SyntheticCase,
  type World,
} from './test-support.ts';

let postgres: TemporaryPostgres;
before(async () => {
  postgres = await startPostgres();
});
after(() => postgres?.stop());

const A = 'Rel_ACME_1_2_15';
const B = 'Rel_ACME_1_2_16';
const C = 'Rel_ACME_1_3_20';
const XML = 'application/xml';
const JSON_TYPE = 'application/json';

function build(name: string, cases: string[] | undefined, extra: Partial<KnownBuild> = {}): KnownBuild {
  return {
    name,
    family: 'ACME',
    line: '1.2',
    base: name,
    platform: null,
    built_at: '2026-01-02T10:00:00.000Z',
    released_at: '2026-01-05T00:00:00.000Z',
    sources: { tree: `site:tree:${name}`, ...(cases === undefined ? {} : { cases }) },
    root: null,
    ...extra,
  };
}

const listed = (b: KnownBuild): BuildInfo => {
  const { root: _root, ...info } = b;
  return info;
};

type Options = NonNullable<Parameters<typeof makeWorld>[1]>;

async function world(t: { after: (fn: () => Promise<void>) => void }, producers: unknown[], options: Options = {}): Promise<World> {
  const w = await makeWorld(postgres, { ...options, pack: { ...(options.pack ?? {}), declaration: { producers, ...(options.pack?.declaration ?? {}) } } });
  t.after(() => w.close());
  w.external.set(`site:tree:${A}`, { bytes: catalogXml(BASE_CATALOG), mediaType: XML });
  w.external.set(`site:tree:${B}`, { bytes: catalogXml({ ...BASE_CATALOG, net: [...BASE_CATALOG.net, { name: 'arp', params: [] }] }), mediaType: XML });
  w.external.set(`site:tree:${C}`, { bytes: catalogXml(BASE_CATALOG), mediaType: XML });
  w.external.set('site:page:index', { bytes: linkPage('index', []), mediaType: 'text/html' });
  return w;
}

/** Documents d<from>..d<to>, each with a reboot case (expected result) and a ping case (none). */
function documents(w: World, from: number, to: number, module = (i: number): string => (i % 2 === 0 ? 'M2' : 'M1')): string[] {
  const ids: string[] = [];
  for (let i = from; i <= to; i++) {
    const id = `store:mindmap:d${i}`;
    const cases: SyntheticCase[] = [
      { id: `d${i}-c1`, text: `[cmd: system reboot] 重启用例 ${i}`, expected: ['重启成功'] },
      { id: `d${i}-c2`, text: `[cmd: net ping] 连通用例 ${i}`, expected: [] },
    ];
    w.external.set(id, { bytes: mindMap({ id: `d${i}`, module: module(i) }, cases), mediaType: JSON_TYPE });
    ids.push(id);
  }
  return ids;
}

const hostile = (w: World, id: string, name: string): void => w.external.set(id, { bytes: mindMap({ id: name, text: 'THROW' }, [{ id: `${name}-c1`, text: '[cmd: system show] x' }]), mediaType: JSON_TYPE });

async function composition(w: World, digest: string | null): Promise<TreeRootBody> {
  assert.ok(digest !== null);
  return TreeRootBody.parse((await w.kit.store.get(digest))?.body);
}

async function detail(w: World, action: string | null): Promise<ProduceDetail> {
  assert.ok(action !== null);
  return ProduceDetail.parse((await w.kit.store.get<ActionBody>(action))?.body.detail);
}

function reader(w: World) {
  const views = createKnowledgeReader(w.knowledge);
  const context = (principal: Principal): ExternalReadContext => ({ principal, run: null, purpose: '复核测试' });
  return {
    read: (id: string, principal: Principal = w.user): Promise<ExternalRead> => views.read(id, context(principal)),
    async json(id: string, principal: Principal = w.user): Promise<{ value: unknown; bytes: number }> {
      const read = await views.read(id, context(principal));
      assert.equal(read.ok, true, read.ok ? '' : read.reason);
      if (!read.ok) throw new Error('not ok');
      const source = await w.kit.artifacts.source(principal, read.artifacts[0].artifact.body.sha256, { consumer: 'function' });
      assert.ok(source !== null && source.bytes !== null);
      return { value: JSON.parse(new TextDecoder().decode(source.bytes)), bytes: source.bytes.byteLength };
    },
  };
}

describe('documents the producer fails on (findings: callBatch blame, the empty probe, timeouts)', () => {
  test('a list producer that fails on every non-empty batch fails the production; the sync reports it and moves no root', async (t) => {
    const broken = "export default function (input: any): unknown {\n  if ((input.lists?.cases ?? []).length > 0) throw new Error('broken for every document');\n  return { entries: [], warnings: [] };\n}\n";
    const w = await world(t, [DEFAULT_PRODUCERS[0], casesProducer({ batch: 10 })], { pack: { functions: { 'cases.ts': broken, 'plan.ts': STATIC_PLAN_SOURCE } } });
    const ids = documents(w, 1, 20);
    const result = await w.knowledge.produceTree({ product: w.product, build: build(A, ids) });
    assert.equal(result.ok, false, `produced with ${result.skippedCount} of 20 documents skipped`);
    assert.match(result.reason ?? '', /生产器本身的问题/);
    const report = await w.knowledge.syncProduct(w.product, { by: w.admin, options: { builds: [listed(build(A, ids))] } });
    assert.equal(report.builds.find((b) => b.name === A)?.outcome, 'failed');
    assert.equal(report.counts.failed, 1, 'the CLI exits with 1');
    assert.equal(report.pointers.find((p) => p.line === '1.2')?.moved, false);
    assert.equal(await w.knowledge.currentRoot('acme', '1.2'), null);

    // Output outside producer-output@1 for any document is the same producer failure.
    const invalid = "export default function (input: any): unknown {\n  const docs = input.lists?.cases ?? [];\n  return docs.length === 0 ? { entries: [], warnings: [] } : { entries: [{ kind: 'case', path: '/x', statement: 's', data: {}, fragments: [], applicability: null }], warnings: [] };\n}\n";
    const v = await world(t, [DEFAULT_PRODUCERS[0], casesProducer({ batch: 5 })], { pack: { functions: { 'cases.ts': invalid } } });
    const produced = await v.knowledge.produceTree({ product: v.product, build: build(A, documents(v, 1, 5)) });
    assert.equal(produced.ok, false);
    assert.match(produced.reason ?? '', /生产器本身的问题/);
  });

  test('the failures of a document are memoized: a second production does not bisect the batch again', async (t) => {
    const w = await world(t, [DEFAULT_PRODUCERS[0], casesProducer({ batch: 4 })]);
    const ids = documents(w, 1, 4);
    hostile(w, ids[1], 'd2');
    await new Builds(w.knowledge.__context).record('acme',{id:w.product.id,version:w.product.version,digest:w.product.digest},build(A,ids),null,null);
    const first = await w.knowledge.produceTree({ product: w.product, build: build(A, ids) });
    assert.equal(first.ok, true, first.reason ?? '');
    assert.deepEqual(first.skipped.map((s) => s.external), [ids[1]]);
    assert.ok(first.calls.made > 2, `the first production bisects (${first.calls.made} calls)`);
    const second = await w.knowledge.produceTree({ product: w.product, build: build(A, ids) });
    assert.equal(second.ok, true, second.reason ?? '');
    assert.deepEqual(second.skipped.map((s) => s.external), [ids[1]]);
    assert.equal(second.calls.made, 1, 'only the command producer runs: every call of the list comes from a stored outcome');
    assert.equal(second.root, first.root);
  });

  test('more than half of a list skipped fails the production; half is still produced', async (t) => {
    const w = await world(t, [DEFAULT_PRODUCERS[0], casesProducer({ batch: 2 })]);
    const ids = documents(w, 1, 4);
    for (const id of ids.slice(1)) w.external.set(id, { fail: 'HTTP 503' });
    const most = await w.knowledge.produceTree({ product: w.product, build: build(A, ids) });
    assert.equal(most.ok, false, `produced with ${most.skippedCount} of 4 skipped`);
    assert.match(most.reason ?? '', /4 份源文件有 3 份没有用上（读不到 3 份），超过 50%/);
    documents(w, 3, 3);
    const half = await w.knowledge.produceTree({ product: w.product, build: build(A, ids), maxAgeSeconds: 0 });
    assert.equal(half.ok, true, half.reason ?? '');
    assert.equal(half.skippedCount, 2);
  });

  test('the calls made to isolate failing documents are bounded; over the budget the production fails', async (t) => {
    const tight = await world(t, [DEFAULT_PRODUCERS[0], casesProducer({ batch: 8 })], { knowledge: { limits: { isolationCallsPerBatch: 1 } } });
    const ids = documents(tight, 1, 8);
    hostile(tight, ids[1], 'd2');
    hostile(tight, ids[5], 'd6');
    const result = await tight.knowledge.produceTree({ product: tight.product, build: build(A, ids) });
    assert.equal(result.ok, false, `produced with ${result.calls.made} calls`);
    assert.match(result.reason ?? '', /已经调用了 5 次（上限 5 次）/);
    const roomy = await world(t, [DEFAULT_PRODUCERS[0], casesProducer({ batch: 8 })]);
    const same = documents(roomy, 1, 8);
    hostile(roomy, same[1], 'd2');
    hostile(roomy, same[5], 'd6');
    const produced = await roomy.knowledge.produceTree({ product: roomy.product, build: build(A, same) });
    assert.equal(produced.ok, true, produced.reason ?? '');
    assert.deepEqual(produced.skipped.map((s) => s.external), [same[1], same[5]]);
  });

  test('a document that makes the producer run past the time limit is isolated and skipped', { timeout: 120_000 }, async (t) => {
    const slow = CASES_SOURCE.replace("if (root.text === 'THROW') throw new Error('hostile document');", "if (root.text === 'THROW') throw new Error('hostile document');\n    if (root.text === 'SLOW') { const end = Date.now() + 60000; while (Date.now() < end) {} }");
    const w = await world(t, [DEFAULT_PRODUCERS[0], casesProducer({ batch: 2 })], {
      pack: { functions: { 'cases.ts': slow } },
      knowledge: { sandbox: { producer: { timeoutMs: 2500 }, requireOsIsolation: await sandboxIsolation() } },
    });
    const ids = documents(w, 1, 2);
    w.external.set(ids[0], { bytes: mindMap({ id: 'd1', text: 'SLOW' }, [{ id: 'd1-c1', text: '[cmd: system show] slow' }]), mediaType: JSON_TYPE });
    const result = await w.knowledge.produceTree({ product: w.product, build: build(A, ids) });
    assert.equal(result.ok, true, result.reason ?? '');
    assert.deepEqual(result.skipped.map((s) => s.external), [ids[0]]);
    assert.match(result.skipped[0].reason, /超过了时间上限/);
    assert.equal(result.entries, 4 + 2);
    assert.equal((await detail(w, result.action)).lists[0].skipped[0].retry, true);
    assert.equal((await detail(w, result.action)).lists[0].skipped[0].reason_code, 'timeout');
  });
});

describe('skipped documents are unknown, not absent (finding: catalogs and views ignore skipped_count)', () => {
  const WORDS = `export default function (input: any): unknown {
  const entries: any[] = [];
  for (const doc of input.lists?.cases ?? []) {
    const root = doc.model.nodes[0];
    entries.push({ kind: 'case', path: '/commands/system/reboot', statement: 'doc ' + root.data.id, data: { words: ['doc', String(root.data.id)], signatures: [], doc: String(root.data.id) }, fragments: [{ slot: 'cases', source: doc.sha256, parser: 'kityminder@1', selector: root.selector }], applicability: null });
  }
  return { entries, warnings: [] };
}
`;
  const producers = [DEFAULT_PRODUCERS[0], { id: 'cases', title: '文档', function: { module: 'functions/words.ts' }, inputs: { cases: { source: 'cases', many: true } } }];
  const catalogs = [
    ...DEFAULT_CATALOGS,
    { id: 'cases@1', entry_kind: 'case', producer: 'cases', complete: true, case_sensitive: false },
    { id: 'anycase@1', entry_kind: 'case', complete: true, case_sensitive: false },
  ];

  test('a skipped document withdraws completeness of the catalogs it could add to, and every view says so', async (t) => {
    const w = await world(t, producers, { pack: { functions: { 'words.ts': WORDS }, declaration: { catalogs } } });
    const ids = documents(w, 1, 4);
    const a = await w.knowledge.produceTree({ product: w.product, build: build(A, ids) });
    assert.equal(a.ok, true, a.reason ?? '');
    const full = await composition(w, a.composition);
    assert.deepEqual(full.catalogs.map((c) => [c.id, c.complete]), [
      ['catalog@1', true],
      ['cases@1', true],
      ['anycase@1', true],
    ]);
    // Read again (max_age 0): the stored read from A would be used otherwise.
    w.external.set(ids[2], { fail: 'HTTP 503' });
    const b = await w.knowledge.produceTree({ product: w.product, build: build(B, ids), maxAgeSeconds: 0 });
    assert.equal(b.ok, true, b.reason ?? '');
    assert.equal(b.skippedCount, 1);
    const partial = await composition(w, b.composition);
    const byId = Object.fromEntries(partial.catalogs.map((c) => [c.id, c]));
    assert.equal(byId['catalog@1'].complete, true, 'the command catalog does not depend on the case documents');
    for (const id of ['cases@1', 'anycase@1']) {
      assert.equal(byId[id].complete, false, id);
      assert.match(byId[id].incomplete_reason ?? '', /1 份列出的来源没有用上（生产器 cases）/);
    }
    assert.equal((await w.knowledge.catalog(b.root as string, 'cases@1'))?.complete, false);

    const views = reader(w);
    const note = /构建 Rel_ACME_1_2_16 的根有 1 份列出的来源没有用上（生产器 cases），这些来源会给出的条目不在这个根里，是未知，不是没有/;
    const impact = ImpactView.parse((await views.json(`knowledge:impact:acme:${A}..${B}`)).value);
    assert.ok(impact.notes.some((n) => note.test(n)), impact.notes.join('\n'));
    assert.ok(!impact.notes.some((n) => /Rel_ACME_1_2_15 的根有/.test(n)), 'the earlier root used every document');
    assert.deepEqual(impact.skipped, { from: 0, to: 1 }, 'the count a pack can rely on, apart from the note');
    const index = IndexView.parse((await views.json(`knowledge:index:acme:${B}?kind=case&key=doc`)).value);
    assert.ok(index.notes.some((n) => note.test(n)), index.notes.join('\n'));
    assert.equal(index.skipped, 1);
    const facets = FacetView.parse((await views.json(`knowledge:facets:acme:${B}?kind=case&by=doc`)).value);
    assert.ok(facets.notes.some((n) => note.test(n)), facets.notes.join('\n'));
    assert.equal(facets.skipped, 1);
    const clean = IndexView.parse((await views.json(`knowledge:index:acme:${A}?kind=case&key=doc`)).value);
    assert.deepEqual(clean.notes, ['这条产品线还没有不分版本的根；下一步：同步这条产品线']);
    assert.equal(clean.skipped, 0);
  });
});

describe('the memo key covers what the function receives (finding: build and batch outside the key)', () => {
  const READING = `export default function (input: any): unknown {
  const entries: any[] = [];
  for (const doc of input.lists?.cases ?? []) for (const node of doc.model.nodes) {
    if (!Array.isArray(node.data.resource)) continue;
    entries.push({ kind: 'case', path: '/commands/system/reboot', statement: node.text + '（' + input.build!.line + '）', data: { line: input.build!.line, build: input.build!.name, batch: input.batch.index }, fragments: [{ slot: 'cases', source: doc.sha256, parser: 'kityminder@1', selector: node.selector }], applicability: { builds: [input.build!.name] } });
  }
  return { entries, warnings: [] };
}
`;

  test('a list producer that reads the build gets its own build, and a root does not depend on what was produced before', async (t) => {
    const producers = [DEFAULT_PRODUCERS[0], { id: 'cases', title: '用例', function: { module: 'functions/reading.ts' }, inputs: { cases: { source: 'cases', many: true } } }];
    const w = await world(t, producers, { pack: { functions: { 'reading.ts': READING } } });
    const ids = documents(w, 1, 2);
    const inventory=new Builds(w.knowledge.__context);
    await inventory.record('acme',{id:w.product.id,version:w.product.version,digest:w.product.digest},build(A,ids),null,null);
    await inventory.record('acme',{id:w.product.id,version:w.product.version,digest:w.product.digest},build(C,ids,{line:'1.3'}),null,null);
    const first = await w.knowledge.produceTree({ product: w.product, build: build(A, ids) });
    assert.equal(first.ok, true, first.reason ?? '');
    const other = await w.knowledge.produceTree({ product: w.product, build: build(C, ids, { line: '1.3' }) });
    assert.equal(other.ok, true, other.reason ?? '');
    assert.equal(other.calls.reused, 0, 'another build is another input');
    const page = await w.knowledge.getNodes({ root: other.root as string, paths: ['/commands/system/reboot'], depth: 0 }, w.admin);
    const cases = page?.nodes[0].entries.filter((e) => e.kind === 'case') ?? [];
    assert.equal(cases.length, 4);
    for (const entry of cases) {
      assert.deepEqual([entry.data?.line, entry.data?.build], ['1.3', C]);
      assert.match(entry.applicability, /构建 Rel_ACME_1_3_20/);
    }
    // Produced alone, in a database without stored outputs, the build has the same root.
    const fresh = await world(t, producers, { pack: { functions: { 'reading.ts': READING } } });
    const freshInventory=new Builds(fresh.knowledge.__context);
    await freshInventory.record('acme',{id:fresh.product.id,version:fresh.product.version,digest:fresh.product.digest},build(A,[]),null,null);
    await freshInventory.record('acme',{id:fresh.product.id,version:fresh.product.version,digest:fresh.product.digest},build(C,[],{line:'1.3'}),null,null);
    const alone = await fresh.knowledge.produceTree({ product: fresh.product, build: build(C, documents(fresh, 1, 2), { line: '1.3' }) });
    assert.equal(alone.root, other.root);
    // A producer gets no root: producing the same build again over a previous root gives the same calls and root.
    const again = await w.knowledge.produceTree({ product: w.product, build: build(C, ids, { line: '1.3', root: other.root }) });
    assert.equal(again.root, other.root);
    assert.deepEqual(again.calls, { made: 1, reused: 1 });
  });
});

describe('recheck (finding: more than 50 documents skipped for good make every recheck produce again)', () => {
  test('oversized documents are tried alone and an unchanged successful root can be reused', { timeout: 120_000 }, async (t) => {
    const tree = Buffer.byteLength(catalogXml(BASE_CATALOG), 'utf8');
    const w = await world(t, [DEFAULT_PRODUCERS[0], casesProducer()], { pack: { functions: { 'plan.ts': STATIC_PLAN_SOURCE } }, knowledge: { limits: { maxBuildBytes: tree + 4000 } } });
    const ids = documents(w, 1, 110);
    const big = mindMap({ id: 'big' }, [{ id: 'big-c1', text: `[cmd: system show] ${'长'.repeat(3000)}`, expected: ['ok'] }]);
    for (let i = 0; i < 110; i += 2) if (i / 2 < 52) w.external.set(ids[i], { bytes: big.replaceAll('"big', `"b${i}`), mediaType: JSON_TYPE });
    const plan = { builds: [listed(build(A, ids))] };
    const first = await w.knowledge.syncProduct(w.product, { by: w.admin, options: plan });
    const row = first.builds.find((b) => b.name === A);
    assert.equal(row?.outcome, 'produced', row?.reason);
    assert.equal(row?.skipped,0,'large documents are tried alone rather than omitted');
    const recheck = await w.knowledge.syncProduct(w.product, { by: w.admin, options: plan, recheck: true });
    const again = recheck.builds.find((b) => b.name === A);
    assert.equal(again?.outcome, 'skipped', again?.reason);
    assert.match(again?.reason ?? '', /重读后来源摘要没有变/);
    assert.equal(row?.skipped, 0, 'the batching budget does not exclude individual documents');
  });
});

describe('index keys from data values (finding: __proto__)', () => {
  test('a prototype-reserved index key refuses the whole page and can be narrowed explicitly', async (t) => {
    const w = await world(t, [DEFAULT_PRODUCERS[0], casesProducer()]);
    const modules = ['__proto__', 'M1', 'constructor', 'toString'];
    const ids = documents(w, 1, 4, (i) => modules[i - 1]);
    const result = await w.knowledge.produceTree({ product: w.product, build: build(A, ids) });
    assert.equal(result.ok, true, result.reason ?? '');
    const views = reader(w);
    const rejected=await views.read(`knowledge:index:acme:${A}?kind=case&key=module`);
    assert.equal(rejected.ok,false);if(!rejected.ok)assert.match(rejected.reason,/__proto__.*only/);
    const index=IndexView.parse((await views.json(`knowledge:index:acme:${A}?kind=case&key=module&only=M1,constructor,toString`)).value);
    assert.deepEqual(Object.keys(index.keys).sort(),['M1','constructor','toString']);assert.equal(index.truncated,false);
    const only=await views.read(`knowledge:index:acme:${A}?kind=case&key=module&only=__proto__`);
    assert.equal(only.ok,false);
    const facets = FacetView.parse((await views.json(`knowledge:facets:acme:${A}?kind=case&by=module`)).value);
    assert.equal(facets.rows.find((r) => r.values.module === '__proto__')?.count, 2, 'a value, not a key, in a facet row');
  });
});

describe('credential findings an administrator accepted (finding: every view over the entry is refused)', () => {
  test('views retain covered entries and recheck the acceptance even with a warm cache', async (t) => {
    const w = await world(t, [DEFAULT_PRODUCERS[0], casesProducer()]);
    const ids = documents(w, 1, 3);
    w.external.set(ids[1], { bytes: mindMap({ id: 'd2', module: 'M2' }, [{ id: 'd2-c1', text: '[cmd: system reboot] 登录 password = Xy7#kq9Lm2', expected: ['ok'] }]), mediaType: JSON_TYPE });
    const first = await w.knowledge.produceTree({ product: w.product, build: build(A, ids) });
    assert.equal(first.skippedCount, 1);
    const sha = /源文件 ([0-9a-f]{64})/.exec(first.skipped[0].reason)?.[1];
    assert.ok(sha);
    await w.kit.artifacts.acceptFindings(w.admin, sha, '合成用例里的示例写法，不是真实凭据');
    const a = await w.knowledge.produceTree({ product: w.product, build: build(A, ids) });
    assert.equal(a.skippedCount, 0, a.reason ?? '');
    const page = await w.knowledge.getNodes({ root: a.root as string, paths: ['/commands/system/reboot'], depth: 0 }, w.user);
    const accepted = page?.nodes[0].entries.find((e) => /password/.test(e.statement));
    assert.ok(accepted, 'get_nodes shows the accepted entry');
    const views = reader(w);
    const index = IndexView.parse((await views.json(`knowledge:index:acme:${A}?kind=case&key=module`)).value);
    assert.equal(index.truncated,false);
    assert.ok(Object.values(index.keys).flat().includes(accepted.entry),'the covered entry is preserved');
    assert.equal(Object.keys(index.entries).length,5);
    assert.ok(index.notes.some(n => /1 个条目.*来源的受理覆盖/.test(n)),index.notes.join('\n'));
    w.external.set(`site:tree:${B}`, { bytes: catalogXml({ ...BASE_CATALOG, system: [{ ...BASE_CATALOG.system[0], params: [{ name: 'delay', type: 'int', min: 0, max: 900 }] }, BASE_CATALOG.system[1]] }), mediaType: XML });
    const b = await w.knowledge.produceTree({ product: w.product, build: build(B, ids) });
    assert.equal(b.ok, true, b.reason ?? '');
    const impact = ImpactView.parse((await views.json(`knowledge:impact:acme:${A}..${B}`)).value);
    assert.deepEqual(impact.changes.map((c) => c.path), ['/commands/system/reboot']);
    assert.ok(impact.placements[0].to.includes(accepted.entry));
    assert.deepEqual([impact.placements[0].from.length, impact.placements[0].to.length],[3,3]);
    assert.deepEqual(impact.totals,{changed_paths:1,attached_from:3,attached_to:3});
    assert.equal(impact.truncated,false);
    assert.ok(impact.notes.some(n => /来源的受理覆盖/.test(n)));
    await w.kit.artifacts.revokeFindings(w.admin,sha,'撤回合成来源受理');
    const withdrawn = IndexView.parse((await views.json(`knowledge:index:acme:${A}?kind=case&key=module`)).value);
    assert.equal(withdrawn.truncated,true);
    assert.ok(!Object.values(withdrawn.keys).flat().includes(accepted.entry));
    assert.equal(Object.keys(withdrawn.entries).length,4);
    assert.ok(withdrawn.notes.some(n => n.includes(accepted.reference) && /凭据扫描命中/.test(n)));
    const impactAfter = ImpactView.parse((await views.json(`knowledge:impact:acme:${A}..${B}`)).value);
    assert.ok(!impactAfter.placements[0].to.includes(accepted.entry));
  });
});

test('a view retains covered text while omitting novel text even if another unrelated source accepted it', async t => {
  const known = 'FtpSynthetic7779', novel = 'FtpSynthetic9993';
  const cases = CASES_SOURCE.replace('statement: node.text +',`statement: (data.id === 'd1-c1' ? 'invented password = ${novel}' : node.text) +`);
  const w = await world(t,[DEFAULT_PRODUCERS[0],casesProducer()],{pack:{functions:{'cases.ts':cases}}});
  const ids = documents(w,1,3);
  w.external.set(ids[1],{bytes:mindMap({id:'d2',module:'M2'},[{id:'d2-c1',text:`[cmd: system reboot] password = ${known}`,expected:['ok']}]),mediaType:JSON_TYPE});
  const initial = await w.knowledge.produceTree({product:w.product,build:build(A,ids)});
  const sha = /源文件 ([0-9a-f]{64})/.exec(initial.skipped[0].reason)?.[1]; assert.ok(sha);
  await w.kit.artifacts.acceptFindings(w.admin,sha,'合成示例，允许处理');
  const unrelatedInput = {bytes:Buffer.from(`unrelated password = ${novel}`),mediaType:'text/plain',origin:{read:{object:'store:manual:unrelated'}},author:{user:null},provenanceType:'observed' as const,visibility:{readers:[],admins:true,packs:[],shareable:false}};
  const unrelated = await w.kit.artifacts.ingest(unrelatedInput);
  await w.kit.artifacts.acceptFindings(w.admin,unrelated.body.sha256,'合成示例，独立来源');
  await w.kit.artifacts.ingest(unrelatedInput);
  const produced = await w.knowledge.produceTree({product:w.product,build:build(A,ids)}); assert.equal(produced.ok,true);
  const result = IndexView.parse((await reader(w).json(`knowledge:index:acme:${A}?kind=case&key=module`)).value);
  assert.ok(Object.values(result.entries).some(entry => entry.statement.includes(known)));
  assert.ok(Object.values(result.entries).every(entry => !entry.statement.includes(novel)));
  assert.ok(result.notes.some(note => /1 个条目.*来源的受理覆盖/.test(note)));
  assert.equal(result.truncated,true);
});

describe('list roles in records (finding: list ids copied into every build record, action and composition)', () => {
  test('lists are kept once by reference; a changed list writes no build record; reads carry no list roles', async (t) => {
    const w = await world(t, [DEFAULT_PRODUCERS[0], casesProducer()], { pack: { functions: { 'plan.ts': STATIC_PLAN_SOURCE } } });
    const ids = documents(w, 1, 300);
    const first = await w.knowledge.syncProduct(w.product, { by: w.admin, options: { builds: [listed(build(A, ids))] } });
    assert.equal(first.builds[0].outcome, 'produced', first.builds[0].reason);
    const claims = async () => (await w.kit.store.find<unknown>({ key: INDEX.build, value: 'acme/rel_acme_1_2_15', kind: 'claim', limit: 50 })).items;
    const [claim] = await claims();
    const body = KnowledgeBuildBody.parse(claim.body);
    assert.deepEqual(body.lists, ['cases']);
    assert.deepEqual(Object.keys(body.build!.sources), ['tree']);
    assert.ok(!JSON.stringify(claim.body).includes('store:mindmap:'), 'no listed id in the build record');
    const production = await w.knowledge.store.latestProduction('acme', A);
    const reference = production?.detail.build!.sources.cases as { list: string; count: number };
    assert.equal(reference.count, 300);
    assert.ok(!JSON.stringify(production?.record.body).includes('store:mindmap:d1"'), 'no listed id in the generate action');
    const stored = await w.kit.objects.get(reference.list);
    assert.deepEqual(JSON.parse(new TextDecoder().decode(stored ?? new Uint8Array())), ids, 'the list is one object, by its digest');
    const root = await composition(w, production?.detail.composition ?? null);
    assert.deepEqual(root.build!.sources.cases, reference);
    // One more document: the build is produced again, and no build record is written for the list.
    const more = [...ids, ...documents(w, 301, 301)];
    const second = await w.knowledge.syncProduct(w.product, { by: w.admin, options: { builds: [listed(build(A, more))] } });
    assert.equal(second.builds[0].outcome, 'produced', second.builds[0].reason);
    assert.match(second.builds[0].reason, /来源列表变了/);
    assert.equal((await claims()).length, 1);
    // What the port reads return: no list role, however long the list.
    const [known] = await w.knowledge.builds('acme');
    assert.deepEqual(Object.keys(known.sources), ['tree']);
    assert.deepEqual(Object.keys((await w.knowledge.resolveBuild('acme', A))?.sources ?? {}), ['tree']);
    assert.deepEqual(Object.keys((await w.knowledge.rootOfBuild('acme', A))?.build!.sources ?? {}), ['tree']);
  });
});

describe('the plan answer (findings: the 16 MiB output cap, one bad build stops the sync)', () => {
  test('a plan answer over 16 MiB is read', { timeout: 120_000 }, async (t) => {
    const big = `export default function plan(input: any): unknown {
  const builds: any[] = [];
  for (let b = 0; b < 300; b++) {
    const ids: string[] = [];
    for (let i = 0; i < 300; i++) ids.push('store:mindmap:' + 'x'.repeat(200) + '-' + b + '-' + i);
    builds.push({ name: 'Rel_ACME_1_2_' + (1000 + b), family: 'ACME', line: '1.2', base: 'Rel_ACME_1_2_' + (1000 + b), platform: null, built_at: null, released_at: null, sources: { tree: 'site:tree:x', cases: ids } });
  }
  return { fetch: [], builds, done: true };
}
`;
    const w = await world(t, [DEFAULT_PRODUCERS[0], casesProducer()], { pack: { functions: { 'plan.ts': big } } });
    const report = await w.knowledge.syncProduct(w.product, { by: w.admin });
    assert.equal(report.error, null);
    assert.equal(report.plan.builds, 300);
    assert.equal(report.counts.skipped, 300, 'unreleased builds are listed and skipped');
  });

  test('a build of the plan that is not build-info@1 fails alone; the others are produced', async (t) => {
    const w = await world(t, [DEFAULT_PRODUCERS[0], casesProducer()], { pack: { functions: { 'plan.ts': STATIC_PLAN_SOURCE } } });
    const ids = documents(w, 1, 2);
    const bad = { ...listed(build(B, [])), sources: { tree: `site:tree:${B}`, cases: ['store:mindmap:d1', 'store:mindmap:has space'] } };
    const report = await w.knowledge.syncProduct(w.product, { by: w.admin, options: { builds: [listed(build(A, ids)), bad] } });
    assert.equal(report.error, null);
    assert.equal(report.builds.find((b) => b.name === A)?.outcome, 'produced');
    const failed = report.builds.find((b) => b.name === B);
    assert.equal(failed?.outcome, 'failed');
    assert.match(failed?.reason ?? '', /第 2 个构建不符合 build-info@1：sources\/cases\/1/);
    assert.deepEqual(report.counts, { produced: 1, registered: 0, skipped: 0, failed: 1 });
  });
});

describe('the byte cap of a batch (finding: documents past the cap skipped, every document loaded first)', () => {
  test('a batch over the cap is handed in consecutive calls within it; no document is fetched before its call is due', async (t) => {
    const tree = Buffer.byteLength(catalogXml(BASE_CATALOG), 'utf8');
    const events: string[] = [];
    const w = await world(t, [DEFAULT_PRODUCERS[0], casesProducer({ batch: 4, params: { trace: true } })]);
    const kit = w.kit;
    const ids = documents(w, 1, 4);
    // Two documents fit one call, three do not.
    const shaOf = new Map<string, string>();
    const sizes: number[] = [];
    for (const id of ids) {
      const object = w.external.objects.get(id) as { bytes: string };
      sizes.push(Buffer.byteLength(object.bytes, 'utf8'));
      shaOf.set(createHash('sha256').update(object.bytes).digest('hex'), id.slice('store:mindmap:'.length));
    }
    const cap = Math.max(tree, 2 * Math.max(...sizes) + 10);
    assert.ok(3 * Math.min(...sizes) > cap);
    const artifacts = new Proxy(kit.artifacts, {
      get(target, property) {
        if (property === 'source') {
          return async (...args: Parameters<typeof target.source>) => {
            const found = await target.source(...args);
            const external = shaOf.get(args[1]);
            if (external !== undefined) events.push(`fetch ${external}`);
            return found;
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const objects = new Proxy(kit.objects, {
      get(target, property) {
        if (property === 'put') {
          return async (...args: Parameters<typeof target.put>) => {
            const stored = await target.put(...args);
            const text = new TextDecoder().decode(args[0]);
            if (text.startsWith('{"entries"')) events.push(`output ${(JSON.parse(text).warnings as string[]).join(' ')}`);
            return stored;
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const knowledge = createKnowledge({
      records: { store: kit.store, artifacts, pointers: kit.pointers, principals: kit.principals, objects },
      parsers: createDefaultRegistry(),
      packs: w.packs,
      external: w.external,
      sandbox: { requireOsIsolation: await sandboxIsolation() },
      admin: w.admin,
      limits: { maxBuildBytes: cap, batchConcurrency: 1 },
    });
    const result = await knowledge.produceTree({ product: w.product, build: build(A, ids) });
    assert.equal(result.ok, true, result.reason ?? '');
    assert.equal(result.skippedCount, 0, 'no document is skipped for the cap');
    assert.deepEqual(result.warnings.filter((x) => x.startsWith('cases：batch')), ['cases：batch 0/1: d1,d2', 'cases：batch 0/1: d3,d4']);
    const order = events.filter((e) => e.startsWith('fetch') || e.startsWith('output'));
    const firstOutput = order.findIndex((e) => e.startsWith('output'));
    assert.ok(firstOutput > 0, order.join(' | '));
    assert.deepEqual(order.slice(0, firstOutput).sort(), ['fetch d1', 'fetch d2'], `only the first call's documents are fetched before it: ${order.join(' | ')}`);
    assert.ok(order.indexOf('fetch d3') > firstOutput && order.indexOf('fetch d4') > firstOutput, order.join(' | '));
  });
});

describe('the impact view cites the later root (finding: the earlier root cited for an entry the later root has)', () => {
  test('an attached entry that moved to an unchanged path is cited at its path in the later root', async (t) => {
    const MOVED = `export default function (input: any): unknown {
  const entries: any[] = [];
  for (const doc of input.lists?.cases ?? []) {
    const root = doc.model.nodes[0];
    for (const node of doc.model.nodes) {
      if (!Array.isArray(node.data.resource)) continue;
      entries.push({ kind: 'case', path: root.data.module, statement: node.text, data: { case: String(node.data.id) }, fragments: [{ slot: 'cases', source: doc.sha256, parser: 'kityminder@1', selector: node.selector }], applicability: null });
    }
  }
  return { entries, warnings: [] };
}
`;
    const producers = [DEFAULT_PRODUCERS[0], { id: 'cases', title: '用例', function: { module: 'functions/moved.ts' }, inputs: { cases: { source: 'cases', many: true } } }];
    const w = await world(t, producers, { pack: { functions: { 'moved.ts': MOVED } } });
    w.external.set(`site:tree:${B}`, { bytes: catalogXml({ ...BASE_CATALOG, system: [{ ...BASE_CATALOG.system[0], params: [{ name: 'delay', type: 'int', min: 0, max: 900 }] }, BASE_CATALOG.system[1]] }), mediaType: XML });
    const kase = [{ id: 'k1', text: '移动的用例', expected: ['ok'] }];
    w.external.set('store:mindmap:a', { bytes: mindMap({ id: 'a', module: '/commands/system/reboot' }, kase), mediaType: JSON_TYPE });
    w.external.set('store:mindmap:b', { bytes: mindMap({ id: 'a', module: '/commands/system/show' }, kase), mediaType: JSON_TYPE });
    const a = await w.knowledge.produceTree({ product: w.product, build: build(A, ['store:mindmap:a']) });
    const b = await w.knowledge.produceTree({ product: w.product, build: build(B, ['store:mindmap:b']) });
    assert.equal(a.ok && b.ok, true, `${a.reason} ${b.reason}`);
    const view = ImpactView.parse((await reader(w).json(`knowledge:impact:acme:${A}..${B}`)).value);
    assert.deepEqual(view.changes.map((c) => c.path), ['/commands/system/reboot']);
    const [placement] = view.placements;
    assert.equal(placement.from.length, 1);
    assert.deepEqual(placement.to, []);
    const digest = placement.from[0];
    assert.equal(view.entries[digest].reference, `tree:${b.root}/commands/system/show@${digest}`);
  });
});

describe('small inputs (findings: a NaN limit, an escaped .. in a build name, the facet row order)', () => {
  test('diffEntries with a limit that is not a non-negative integer uses the default', async (t) => {
    const w = await world(t, [DEFAULT_PRODUCERS[0]]);
    const a = await w.knowledge.produceTree({ product: w.product, build: build(A, undefined) });
    const b = await w.knowledge.produceTree({ product: w.product, build: build(B, undefined) });
    for (const limit of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0.5]) {
      const diff = await w.knowledge.diffEntries(a.root as string, b.root as string, { kinds: ['definition'], limit });
      assert.deepEqual([diff?.changes.length, diff?.total, diff?.truncated], [1, 1, false], String(limit));
    }
    const zero = await w.knowledge.diffEntries(a.root as string, b.root as string, { kinds: ['definition'], limit: 0 });
    assert.deepEqual([zero?.changes.length, zero?.total, zero?.truncated], [0, 1, true]);
  });

  test('the builds of an impact view are split at the first literal .. before decoding', () => {
    const parsed = parseViewId('knowledge:impact:acme:Rel_1%2E%2E2..Rel_3');
    assert.ok(parsed.ok && parsed.value.type === 'impact');
    if (!parsed.ok || parsed.value.type !== 'impact') return;
    assert.deepEqual([parsed.value.from, parsed.value.to], ['Rel_1..2', 'Rel_3']);
    const plain = parseViewId('knowledge:impact:acme:Rel_1..Rel_3');
    assert.ok(plain.ok && plain.value.type === 'impact' && plain.value.from === 'Rel_1' && plain.value.to === 'Rel_3');
    for (const id of ['knowledge:impact:acme:Rel_1', 'knowledge:impact:acme:..Rel_3', 'knowledge:impact:acme:Rel_1..', 'knowledge:impact:acme:Rel_%E0..Rel_3']) assert.equal(parseViewId(id).ok, false, id);
  });

  test('facet rows are sorted by the canonical JSON text of their values in code-unit order', async (t) => {
    const values: unknown[] = [null, true, 1, 9, 10, '1', 'a', false];
    const entries = values.map((v, i) => ({ kind: 'case', path: `/commands/system/show`, statement: `值 ${i}`, data: { v }, fragments: [{ parser: 'xml@1', selector: 'x/catalog' }], applicability: null }));
    const w = await world(t, [DEFAULT_PRODUCERS[0], extraProducer('values', { entries })]);
    const produced = await w.knowledge.produceTree({ product: w.product, build: build(A, undefined) });
    assert.equal(produced.ok, true, produced.reason ?? '');
    const view = FacetView.parse((await reader(w).json(`knowledge:facets:acme:${A}?kind=case&by=v`)).value);
    assert.deepEqual(view.rows.map((r) => r.values.v), ['1', 'a', 1, 10, 9, false, null, true]);
  });
});

describe('views cut over the byte budget (findings: index estimate below the real size, facets without a byte budget)', () => {
  test('an index cut by the budget is at most maxViewBytes and is served', { timeout: 120_000 }, async (t) => {
    const w = await world(t, [DEFAULT_PRODUCERS[0], casesProducer()], { knowledge: { limits: { maxViewBytes: 64 * 1024 + 600 * 1024 } } });
    const ids: string[] = [];
    for (let d = 0; d < 20; d++) {
      const id = `store:mindmap:q${d}`;
      const cases = Array.from({ length: 60 }, (_, c) => ({ id: `q${d}-${c}`, text: `[cmd: system reboot] 引号${'"'.repeat(120)}用例 ${d}-${c}`, expected: ['成功'] }));
      w.external.set(id, { bytes: mindMap({ id: `q${d}`, module: '模块' }, cases), mediaType: JSON_TYPE });
      ids.push(id);
    }
    const produced = await w.knowledge.produceTree({ product: w.product, build: build(A, ids) });
    assert.equal(produced.ok, true, produced.reason ?? '');
    const { value, bytes } = await reader(w).json(`knowledge:index:acme:${A}?kind=case&key=case`);
    const view = IndexView.parse(value);
    assert.equal(view.truncated, true);
    assert.equal(view.total_keys, 1200);
    assert.ok(Object.keys(view.keys).length > 100 && Object.keys(view.keys).length < 1200, String(Object.keys(view.keys).length));
    assert.ok(bytes <= 64 * 1024 + 600 * 1024, `${bytes} bytes`);
  });

  test('facets over long values are cut by bytes, and distinct combinations beyond the limit are flagged', async (t) => {
    const entries = Array.from({ length: 120 }, (_, i) => ({ kind: 'case', path: '/commands/system/show', statement: `长标题 ${i}`, data: { title: `${String(i).padStart(3, '0')} ${'标'.repeat(1200)}` }, fragments: [{ parser: 'xml@1', selector: 'x/catalog' }], applicability: null }));
    const w = await world(t, [DEFAULT_PRODUCERS[0], extraProducer('titles', { entries })], { knowledge: { limits: { maxViewBytes: 64 * 1024 + 200 * 1024, facetCombinations: 100 } } });
    const produced = await w.knowledge.produceTree({ product: w.product, build: build(A, undefined) });
    assert.equal(produced.ok, true, produced.reason ?? '');
    const rejected=await reader(w).read(`knowledge:facets:acme:${A}?kind=case&by=title`);
    assert.equal(rejected.ok,false);
    if(!rejected.ok)assert.match(rejected.reason,/组合超过可计算上限.*减少 by/);
  });

  test('an index whose listed entries were not held during the scan reads them again and gives the same entries', async (t) => {
    const at = (path: string, value: string, size: number) => ({ kind: 'case', path, statement: `${value} ${'x'.repeat(size)}`, data: { k: value }, fragments: [{ parser: 'xml@1', selector: 'x/catalog' }], applicability: null });
    // Scanned first, z is held and fills the budget; a, kept first by key order, has to be read again.
    const entries = [at('/commands/net/ping', 'z', 1000), at('/commands/system/show', 'a', 100)];
    const small = await world(t, [DEFAULT_PRODUCERS[0], extraProducer('keys', { entries })], { knowledge: { limits: { maxViewBytes: 64 * 1024 + 1500 } } });
    const large = await world(t, [DEFAULT_PRODUCERS[0], extraProducer('keys', { entries })]);
    const views: IndexView[] = [];
    for (const w of [small, large]) {
      const produced = await w.knowledge.produceTree({ product: w.product, build: build(A, undefined) });
      assert.equal(produced.ok, true, produced.reason ?? '');
      views.push(IndexView.parse((await reader(w).json(`knowledge:index:acme:${A}?kind=case&key=k`)).value));
    }
    const [cut, all] = views;
    assert.deepEqual(Object.keys(cut.keys), ['a'], 'the budget holds the first key only');
    assert.deepEqual(Object.keys(all.keys), ['a', 'z']);
    const digest = cut.keys.a[0];
    assert.deepEqual(cut.entries[digest], all.entries[digest]);
  });
});
test('a complete accepted scan covers credential-bearing index keys and all entries beyond the old display cap', async t => {
  const w=await world(t,[DEFAULT_PRODUCERS[0],casesProducer({batch:5})]);
  const ids:string[]=[];
  for(let d=0;d<5;d++) {
    const id=`store:mindmap:budget-${d}`;
    const module=`${['sk','-SyntheticBudgetToken'].join('')}${d}WithLettersA7349`;
    const text=mindMap({id:`budget-${d}`,module},Array.from({length:40},(_,i)=>({id:`case-${d}-${i}`,text:`[cmd: system reboot] password = FtpBudget${d}7349`,expected:['ok']})));
    w.external.set(id,{bytes:text,mediaType:JSON_TYPE});ids.push(id);
    const source=await w.kit.artifacts.ingest({bytes:Buffer.from(text),mediaType:JSON_TYPE,origin:{read:{object:id}},author:{user:null},provenanceType:'observed',visibility:{readers:[],admins:true,packs:[],shareable:false}});
    await w.kit.artifacts.acceptFindings(w.admin,source.body.sha256,'合成数据的虚构写法');
  }
  const produced=await w.knowledge.produceTree({product:w.product,build:build(A,ids)});assert.ok(produced.root);
  const nodes=await w.knowledge.getNodes({root:produced.root,paths:['/commands/system/reboot'],depth:0},w.user);assert.ok(nodes);
  const entries=nodes.nodes[0].entries.filter(e=>e.kind==='case').sort((a,b)=>a.entry<b.entry?-1:1);
  assert.equal(entries.length,200);
  const expected:string[]=[],keys=new Set<string>();let hits=0;
  for(const entry of entries) {
    const key=String(entry.data?.module),cost=2+(keys.has(key)?0:1);
    hits+=cost;keys.add(key);expected.push(entry.entry);
  }
  const result=await reader(w).read(`knowledge:index:acme:${A}?kind=case&key=module`);assert.ok(result.ok);
  const artifact=result.artifacts[0].artifact;
  assert.equal(artifact.body.scan.truncated,false);assert.equal(artifact.body.scan.findings.length,hits);
  const bytes=await w.kit.artifacts.source(w.user,artifact.body.sha256);assert.ok(bytes?.bytes);
  const value=IndexView.parse(JSON.parse(Buffer.from(bytes.bytes).toString()));
  assert.deepEqual(Object.keys(value.entries).sort(),expected);
  assert.equal(expected.length,200);assert.equal(hits,405);assert.equal(value.truncated,false);
  assert.ok(!value.notes.some(n=>n.includes('命中上限没有留下')));
});

// Inject two single-hit undercounts only into the public per-part estimate. The real private ingest
// scanner and coverage assessment still run, so this exercises an actual truncated
// stored answer and the single safe retry, rather than fabricating an ingest receipt.
test('the private whole-answer scan verifies covered content beyond the old cap despite a public estimate undercount', async t => {
  const w=await world(t,[DEFAULT_PRODUCERS[0],casesProducer({batch:2})]);
  const ids:string[]=[];
  for (let d=0;d<2;d++) {
    const id=`store:mindmap:fallback-${d}`;
    const text=mindMap({id:`fallback-${d}`,module:'safe-module'},Array.from({length:26},(_,i)=>({id:`case-${d}-${i}`,text:`[cmd: system reboot] password = FtpFallback${d}7349\npassword = FtpFallback${d}8357`,expected:['ok']})));
    w.external.set(id,{bytes:text,mediaType:JSON_TYPE}); ids.push(id);
    const source=await w.kit.artifacts.ingest({bytes:Buffer.from(text),mediaType:JSON_TYPE,origin:{read:{object:id}},author:{user:null},provenanceType:'observed',visibility:{readers:[],admins:true,packs:[],shareable:false}});
    assert.equal(source.body.scan.truncated,false);
    await w.kit.artifacts.acceptFindings(w.admin,source.body.sha256,'合成数据的虚构写法');
  }
  const produced=await w.knowledge.produceTree({product:w.product,build:build(A,ids)});
  assert.equal(produced.ok,true,produced.reason ?? '');
  const prepare=w.kit.artifacts.prepareDerived.bind(w.kit.artifacts);
  let undercounted=0;
  t.mock.method(w.kit.artifacts,'prepareDerived',async (input:DerivedCoverageInput)=>{
    const handle=await prepare(input),assess=handle.assess.bind(handle);
    handle.assess=bytes=>{
      const result=assess(bytes);
      const part=JSON.parse(Buffer.from(bytes).toString());
      if (undercounted < 2 && part.entry && result.scan.findings.length === 2) {
        undercounted++;
        return {...result,scan:{...result.scan,findings:result.scan.findings.slice(1)}};
      }
      return result;
    };
    return handle;
  });
  const ingest=w.kit.artifacts.ingest.bind(w.kit.artifacts),answers:SourceArtifact[]=[];
  t.mock.method(w.kit.artifacts,'ingest',async (input:IngestInput)=>{
    const artifact=await ingest(input);
    if (input.name==='index-view.json') answers.push(artifact);
    return artifact;
  });
  const result=await reader(w).read(`knowledge:index:acme:${A}?kind=case&key=module`);
  assert.ok(result.ok,result.ok ? '' : result.reason);
  assert.equal(undercounted,2);
  assert.equal(answers.length,1,'a complete scan below the maintenance bound needs no omission fallback');
  assert.equal(answers[0].body.scan.truncated,false);
  assert.equal(answers[0].body.scan.findings.length,104,'the private scanner counts every hit despite the estimate undercount');
  assert.equal(answers[0].body.read_tier,'model_readable');
  const source=await w.kit.artifacts.source(w.user,answers[0].body.sha256);assert.ok(source?.bytes);
  const view=IndexView.parse(JSON.parse(Buffer.from(source.bytes).toString()));
  assert.equal(Object.keys(view.entries).length,52);assert.equal(view.truncated,false);
  assert.ok(!view.notes.some(note=>note.includes('截断')||note.includes('回退')));
});

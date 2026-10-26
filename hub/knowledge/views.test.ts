import {createTestParserRegistry as createDefaultRegistry} from '../testing/parsers.ts';
import { labelOf } from '../../contracts/generated/vocabulary.ts';
// The knowledge views as external objects (impact-view@1, facet-view@1, index-view@1) and KnowledgePort.diffEntries,
// checked against answers computed by hand on two small trees: every change kind, attached entries on both sides, a change
// of cases only (not a change of definitions), truncation, alias builds and product names, permission refusal, malformed
// ids, roots without the kind, the revision, determinism (byte-identical answers) and what the run engine reads.
import assert from 'node:assert/strict';
import pg from 'pg';
import { after, before, describe, test } from 'node:test';
import { FacetView, ImpactView, IndexView } from '../../contracts/src/views.ts';
import type { KnownBuild } from '../../contracts/src/product.ts';
import type { ExternalRead, ExternalReadContext } from '../ports.ts';
import type { Principal } from '../records/api.ts';
import { parserKey, recognize } from '../refs/api.ts';
import type { TemporaryPostgres } from '../testing/postgres.ts';
import { createKnowledgeReader, routeKnowledgeViews } from './api.ts';
import { parseViewId } from './views.ts';
import { BASE_CATALOG, DEFAULT_PRODUCERS, casesProducer, catalogXml, extraProducer, makeWorld, mindMap, startPostgres, type World } from './test-support.ts';

let postgres: TemporaryPostgres;
before(async () => {
  postgres = await startPostgres();
});
after(() => postgres?.stop());

const A = 'Rel_ACME_1_2_15';
const B = 'Rel_ACME_1_2_16';
const JSON_TYPE = 'application/json';

function build(name: string, cases: string[]): KnownBuild {
  return { name, family: 'ACME', line: '1.2', base: name, platform: null, built_at: '2026-01-02T10:00:00.000Z', released_at: '2026-01-05T00:00:00.000Z', sources: { tree: `site:tree:${name}`, cases }, root: null };
}

interface Fixture {
  w: World;
  roots: { a: string; b: string };
  /** Entry digest by statement's first line, per root. */
  digests: { a: Map<string, string>; b: Map<string, string> };
  read(id: string, principal?: Principal): Promise<ExternalRead>;
  json(read: ExternalRead, principal?: Principal): Promise<{ bytes: Uint8Array; value: unknown }>;
}

/**
 * Root A: the base catalog (system reboot/show, net ping/trace); documents d1 (reboot #100, ping #100 #200, trace) and d2
 * (show, disk list). Root B: reboot's range changed, trace removed, arp and disk list added; documents d1 and d2b (show's
 * case reworded, disk list unchanged, a new reboot case).
 */
async function fixture(t: { after: (fn: () => Promise<void>) => void }, options: Parameters<typeof makeWorld>[1] = {}): Promise<Fixture> {
  const w = await makeWorld(postgres, { ...options, pack: { declaration: { producers: [DEFAULT_PRODUCERS[0], casesProducer({ batch: 5 })] } } });
  t.after(() => w.close());
  w.external.set(`site:tree:${A}`, { bytes: catalogXml(BASE_CATALOG), mediaType: 'application/xml' });
  w.external.set(`site:tree:${B}`, {
    bytes: catalogXml({
      system: [{ ...BASE_CATALOG.system[0], params: [{ name: 'delay', type: 'int', min: 0, max: 900 }] }, BASE_CATALOG.system[1]],
      net: [BASE_CATALOG.net[0], { name: 'arp', params: [], help: 'show the neighbours' }],
      disk: [{ name: 'list', params: [], help: 'list the disks' }],
    }),
    mediaType: 'application/xml',
  });
  w.external.set('store:mindmap:d1', {
    bytes: mindMap({ id: 'd1', module: 'M1', line: '1.2' }, [
      { id: 'c1', text: '[cmd: system reboot] 重启 #100', expected: ['成功'] },
      { id: 'c2', text: '[cmd: net ping] 连通 #100 #200', expected: [] },
      { id: 'c3', text: '[cmd: net trace] 路由', expected: ['可达'] },
    ]),
    mediaType: JSON_TYPE,
  });
  w.external.set('store:mindmap:d2', {
    bytes: mindMap({ id: 'd2', module: 'M2', line: '1.2' }, [
      { id: 'c4', text: '[cmd: system show] 查看', expected: ['显示'] },
      { id: 'c5', text: '[cmd: disk list] 列出', expected: [] },
    ]),
    mediaType: JSON_TYPE,
  });
  w.external.set('store:mindmap:d2b', {
    bytes: mindMap({ id: 'd2', module: 'M2', line: '1.2' }, [
      { id: 'c4', text: '[cmd: system show] 查看状态', expected: ['显示'] },
      { id: 'c5', text: '[cmd: disk list] 列出', expected: [] },
      { id: 'c6', text: '[cmd: system reboot] 重启后再检查', expected: ['成功'] },
    ]),
    mediaType: JSON_TYPE,
  });
  const a = await w.knowledge.produceTree({ product: w.product, build: build(A, ['store:mindmap:d1', 'store:mindmap:d2']) });
  const b = await w.knowledge.produceTree({ product: w.product, build: build(B, ['store:mindmap:d1', 'store:mindmap:d2b']) });
  assert.equal(a.ok && b.ok, true, `${a.reason} ${b.reason}`);
  const digestsOf = async (root: string): Promise<Map<string, string>> => {
    const page = await w.knowledge.getNodes({ root, paths: ['/'], depth: 6 }, w.admin);
    const out = new Map<string, string>();
    for (const node of page?.nodes ?? []) for (const entry of node.entries) out.set(entry.statement.split('\n')[0], entry.entry);
    return out;
  };
  const reader = createKnowledgeReader(w.knowledge);
  const context = (principal: Principal): ExternalReadContext => ({ principal, run: null, purpose: '视图测试' });
  return {
    w,
    roots: { a: a.root as string, b: b.root as string },
    digests: { a: await digestsOf(a.root as string), b: await digestsOf(b.root as string) },
    read: (id, principal = w.user) => reader.read(id, context(principal)),
    async json(read, principal = w.user) {
      assert.equal(read.ok, true, read.ok ? '' : read.reason);
      if (!read.ok) throw new Error('not ok');
      const original = read.artifacts.find((x) => x.name === 'original');
      assert.ok(original);
      const source = await w.kit.artifacts.source(principal, original.artifact.body.sha256, { consumer: 'function' });
      assert.ok(source !== null && source.bytes !== null);
      return { bytes: source.bytes, value: JSON.parse(new TextDecoder().decode(source.bytes)) };
    },
  };
}

const sorted = (...values: string[]): string[] => [...values].sort();

async function readJson(w: World, id: string): Promise<unknown> {
  const reader = createKnowledgeReader(w.knowledge);
  const read = await reader.read(id, { principal: w.user, run: null, purpose: '视图测试' });
  assert.equal(read.ok, true, read.ok ? '' : read.reason);
  if (!read.ok) throw new Error('not ok');
  const source = await w.kit.artifacts.source(w.user, read.artifacts[0].artifact.body.sha256, { consumer: 'function' });
  assert.ok(source?.bytes);
  return JSON.parse(new TextDecoder().decode(source.bytes));
}

describe('the impact view (impact-view@1)', () => {
  test('changes of the changed kinds, the attached entries on both sides, references of the later root first', async (t) => {
    const f = await fixture(t);
    const { a, b } = f.digests;
    const id = `knowledge:impact:acme:${A}..${B}`;
    const read = await f.read(id);
    const { value } = await f.json(read);
    const view = ImpactView.parse(value);
    assert.equal(read.ok && read.revision, `${f.roots.a}..${f.roots.b}`);
    assert.deepEqual(view.from, { build: A, root: f.roots.a });
    assert.deepEqual(view.to, { build: B, root: f.roots.b });
    assert.deepEqual(view.changed_kinds, ['behaviour', 'definition']);
    assert.deepEqual(view.attached_kinds, ['case']);
    const def = (m: Map<string, string>, words: string) => m.get(words) as string;
    assert.deepEqual(view.changes, [
      { path: '/commands/disk/list', change: 'added', before: [], after: [def(b, 'disk list')] },
      { path: '/commands/net/arp', change: 'added', before: [], after: [def(b, 'net arp')] },
      { path: '/commands/net/trace', change: 'removed', before: [def(a, 'net trace <host:string>')], after: [] },
      { path: '/commands/system/reboot', change: 'modified', before: [def(a, 'system reboot <delay:int>')], after: [def(b, 'system reboot <delay:int>')] },
    ]);
    assert.notEqual(def(a, 'system reboot <delay:int>'), def(b, 'system reboot <delay:int>'), 'the range is part of the definition');
    const c1 = b.get('[cmd: system reboot] 重启 #100') as string;
    const c3 = b.get('[cmd: net trace] 路由') as string;
    const c5 = b.get('[cmd: disk list] 列出') as string;
    const c6 = b.get('[cmd: system reboot] 重启后再检查') as string;
    assert.equal(a.get('[cmd: disk list] 列出'), c5, 'the unchanged case is the same entry in both roots');
    assert.deepEqual(view.placements, [
      { path: '/commands/disk/list', from: [c5], to: [c5] },
      { path: '/commands/net/trace', from: [c3], to: [c3] },
      { path: '/commands/system/reboot', from: [c1], to: sorted(c1, c6) },
    ]);
    assert.deepEqual(view.totals, { changed_paths: 4, attached_from: 3, attached_to: 4 });
    assert.equal(view.truncated, false);
    assert.deepEqual(view.notes, ['这条产品线还没有不分版本的根；下一步：同步这条产品线']);
    // Every entry named once; references of the later root, or of the earlier one for an entry only there.
    assert.deepEqual(Object.keys(view.entries), sorted(def(b, 'disk list'), def(b, 'net arp'), def(a, 'net trace <host:string>'), def(a, 'system reboot <delay:int>'), def(b, 'system reboot <delay:int>'), c1, c3, c5, c6));
    assert.equal(view.entries[c5].reference, `tree:${f.roots.b}/commands/disk/list@${c5}`);
    assert.equal(view.entries[def(a, 'net trace <host:string>')].reference, `tree:${f.roots.a}/commands/net/trace@${def(a, 'net trace <host:string>')}`);
    assert.equal(view.entries[def(a, 'system reboot <delay:int>')].reference.startsWith(`tree:${f.roots.a}/`), true);
    assert.equal(view.entries[c6].kind, 'case');
    assert.match(view.entries[c6].statement, /重启后再检查\n期望：成功/);
    assert.deepEqual(view.entries[c1].data.defects, ['100']);

    // The run engine reads it like any external object: the original parses with the core JSON parser.
    const { bytes } = await f.json(read);
    const parsed = recognize(createDefaultRegistry(), bytes, JSON_TYPE);
    assert.equal(parsed === null ? null : parserKey(parsed.parser), 'json@1');
    const meta = read.ok ? read.artifacts.find((x) => x.name === 'meta') : undefined;
    assert.ok(meta);

    // The reverse direction swaps added and removed.
    const reverse = ImpactView.parse((await f.json(await f.read(`knowledge:impact:acme:${B}..${A}`))).value);
    assert.deepEqual(reverse.changes.map((c) => [c.path, c.change]), [
      ['/commands/disk/list', 'removed'],
      ['/commands/net/arp', 'removed'],
      ['/commands/net/trace', 'added'],
      ['/commands/system/reboot', 'modified'],
    ]);
  });

  test('a change of cases is a change only when cases are the changed kind; attached kinds can be definitions', async (t) => {
    const f = await fixture(t);
    const { a, b } = f.digests;
    const view = ImpactView.parse((await f.json(await f.read(`knowledge:impact:acme:${A}..${B}?changed=case&attached=definition`))).value);
    assert.deepEqual(view.changes.map((c) => [c.path, c.change]), [
      ['/commands/system/reboot', 'modified'],
      ['/commands/system/show', 'modified'],
    ]);
    assert.deepEqual(view.changes[1], { path: '/commands/system/show', change: 'modified', before: [a.get('[cmd: system show] 查看')], after: [b.get('[cmd: system show] 查看状态')] });
    assert.deepEqual(view.placements.map((p) => [p.path, p.from.length, p.to.length]), [
      ['/commands/system/reboot', 1, 1],
      ['/commands/system/show', 1, 1],
    ]);
    // Equal roots: a valid answer without changes, with the note.
    const same = ImpactView.parse((await f.json(await f.read(`knowledge:impact:acme:${A}..${A}`))).value);
    assert.deepEqual(same.changes, []);
    assert.ok(same.notes.some((note) => /同一个根/.test(note)));
    // A kind no root holds: still a valid answer, with the notes.
    const none = ImpactView.parse((await f.json(await f.read(`knowledge:impact:acme:${A}..${B}?changed=behaviour&attached=defect`))).value);
    assert.deepEqual(none.changes, []);
    assert.ok(none.notes.some((note) => /没有缺陷种类的条目/.test(note)), none.notes.join('\n'));
    assert.ok(none.notes.some((note) => /没有行为种类的条目，算不出变化/.test(note)), none.notes.join('\n'));
  });

  test('a small byte budget cuts the lists in path order; the totals still count everything', async (t) => {
    // The lists get maxViewBytes less 64 KiB, counted exactly: the four changed paths take 1295, 610, 1368 and 2670 bytes.
    const f = await fixture(t, { knowledge: { limits: { maxViewBytes: 64 * 1024 + 3500 } } });
    const view = ImpactView.parse((await f.json(await f.read(`knowledge:impact:acme:${A}..${B}`))).value);
    assert.equal(view.truncated, true);
    assert.ok(view.changes.length >= 1 && view.changes.length < 4, String(view.changes.length));
    assert.deepEqual(view.changes.map((c) => c.path), ['/commands/disk/list', '/commands/net/arp', '/commands/net/trace'].slice(0, view.changes.length));
    assert.ok(view.placements.every((p) => view.changes.some((c) => c.path === p.path)));
    for (const digest of [...view.changes.flatMap((c) => [...c.before, ...c.after]), ...view.placements.flatMap((p) => [...p.from, ...p.to])]) assert.ok(digest in view.entries);
    assert.deepEqual(view.totals, { changed_paths: 4, attached_from: 3, attached_to: 4 });
    assert.ok(view.notes.some((note) => /截在第 \d+ 个变化路径/.test(note)));
  });
});

describe('KnowledgePort.diffEntries', () => {
  test('paths whose entries of the kinds differ, sorted by path, with digests and the change kind; limit and unknown roots', async (t) => {
    const f = await fixture(t);
    const diff = await f.w.knowledge.diffEntries(f.roots.a, f.roots.b, { kinds: ['definition'] });
    assert.ok(diff !== null);
    assert.deepEqual(diff.kinds, ['definition']);
    assert.deepEqual(diff.changes.map((c) => [c.path, c.change, c.before.length, c.after.length]), [
      ['/commands/disk/list', 'added', 0, 1],
      ['/commands/net/arp', 'added', 0, 1],
      ['/commands/net/trace', 'removed', 1, 0],
      ['/commands/system/reboot', 'modified', 1, 1],
    ]);
    assert.equal(diff.total, 4);
    assert.equal(diff.truncated, false);
    const cases = await f.w.knowledge.diffEntries(f.roots.a, f.roots.b, { kinds: ['case'] });
    assert.deepEqual(cases?.changes.map((c) => [c.path, c.before.length, c.after.length]), [
      ['/commands/system/reboot', 1, 2],
      ['/commands/system/show', 1, 1],
    ]);
    const cut = await f.w.knowledge.diffEntries(f.roots.a, f.roots.b, { kinds: ['definition', 'case'], limit: 2 });
    assert.deepEqual(cut?.changes.map((c) => c.path), ['/commands/disk/list', '/commands/net/arp']);
    assert.equal(cut?.total, 5);
    assert.equal(cut?.truncated, true);
    assert.deepEqual((await f.w.knowledge.diffEntries(f.roots.a, f.roots.a, { kinds: ['definition'] }))?.changes, []);
    assert.equal(await f.w.knowledge.diffEntries(f.roots.a, 'e'.repeat(64), { kinds: ['definition'] }), null);
    assert.deepEqual((await f.w.knowledge.diffEntries(f.roots.a, f.roots.b, { kinds: [] }))?.changes, []);
    // diffRoots is unchanged: it names every differing path, whatever its kinds.
    const paths = await f.w.knowledge.diffRoots(f.roots.a, f.roots.b);
    assert.deepEqual(paths?.added, ['/commands/net/arp']);
    assert.deepEqual(paths?.removed, []);
    assert.deepEqual(paths?.modified, ['/commands/disk/list', '/commands/net/trace', '/commands/system/reboot', '/commands/system/show']);
  });
});

describe('the facet and index views (facet-view@1, index-view@1)', () => {
  test('facets count entries by field values; a list field counts per element; rows sorted by the values', async (t) => {
    const f = await fixture(t);
    const view = FacetView.parse((await f.json(await f.read(`knowledge:facets:acme:${B}?kind=case&by=module,has_expected`))).value);
    assert.deepEqual(view.build, { build: B, root: f.roots.b });
    assert.deepEqual(view.rows, [
      { values: { module: 'M1', has_expected: false }, count: 1 },
      { values: { module: 'M1', has_expected: true }, count: 2 },
      { values: { module: 'M2', has_expected: false }, count: 1 },
      { values: { module: 'M2', has_expected: true }, count: 2 },
    ]);
    assert.equal(view.total, 6);
    assert.deepEqual(view.totals.empty, {module:0,has_expected:0});
    assert.equal(view.truncated, false);
    assert.equal(view.notes.some((note) => note.startsWith('未归位')), false);
    // Rows are in code-unit order of the canonical JSON text of their values: "100" and "200" before null.
    const defects = FacetView.parse((await f.json(await f.read(`knowledge:facets:acme:${B}?kind=case&by=defects`))).value);
    assert.deepEqual(defects.rows, [
      { values: { defects: '100' }, count: 2 },
      { values: { defects: '200' }, count: 1 },
      { values: { defects: null }, count: 4 },
    ]);
    assert.deepEqual(defects.totals.empty, {defects:4});
    const priority = FacetView.parse((await f.json(await f.read(`knowledge:facets:acme:${A}?kind=case&by=priority,missing`))).value);
    assert.deepEqual(priority.rows, [{ values: { priority: 1, missing: null }, count: 5 }]);
    assert.deepEqual(priority.totals.empty, {priority:0,missing:5});
    const definitions = FacetView.parse((await f.json(await f.read(`knowledge:facets:acme:${B}?kind=definition&by=words`))).value);
    assert.equal(definitions.total, 5);
    assert.deepEqual(definitions.rows.find((r) => r.values.words === 'system')?.count, 2);
    // A root without entries of the kind is a valid answer with a note.
    const none = FacetView.parse((await f.json(await f.read(`knowledge:facets:acme:${B}?kind=defect&by=module`))).value);
    assert.deepEqual([none.total, none.rows], [0, []]);
    assert.deepEqual(none.totals.empty, {module:0});
    assert.match(none.notes[0], /没有缺陷种类的条目/);
  });

  test('empty totals survive byte pagination independently for each field', async (t) => {
    const data: Record<string, unknown>[] = [
      {commands:['listed'], module:'M'}, {}, {commands:null}, {commands:[]},
      {commands:[null,null,'listed'],module:false}, {commands:0,module:''},
      {commands:['many','values'],module:['A','B'],absent:null},
    ];
    const entries = data.map((data,i) => ({kind:'case',path:'/commands/system/show',statement:`合成计数 ${i}`,data,fragments:[{parser:'xml@1',selector:'x/catalog/group[1]'}],applicability:null}));
    const w = await makeWorld(postgres, {pack:{declaration:{producers:[DEFAULT_PRODUCERS[0],extraProducer('empty_counts',{entries})]}},knowledge:{limits:{maxViewBytes:64*1024+100,facetCombinations:100}}});
    t.after(()=>w.close());
    w.external.set(`site:tree:${A}`,{bytes:catalogXml(BASE_CATALOG),mediaType:'application/xml'});
    const produced=await w.knowledge.produceTree({product:w.product,build:{...build(A,[]),sources:{tree:`site:tree:${A}`}}});
    assert.ok(produced.ok,produced.reason ?? '');
    const reader=createKnowledgeReader(w.knowledge);
    const read=async()=>{
      const result=await reader.read(`knowledge:facets:acme:${A}?kind=case&by=commands,module,absent`,{principal:w.user,run:null,purpose:'synthetic totals'});
      assert.ok(result.ok,result.ok?'':result.reason);
      const source=await w.kit.artifacts.source(w.user,result.artifacts[0].artifact.body.sha256,{consumer:'model'});
      assert.ok(source?.bytes);return source.bytes;
    };
    const first=await read();const view=FacetView.parse(JSON.parse(new TextDecoder().decode(first)));
    assert.equal(view.truncated,true);
    assert.ok(view.rows.length < 2);
    assert.deepEqual(view.totals.empty,{commands:4,module:3,absent:7});
    assert.equal(view.total,7);
    assert.deepEqual(await read(),first);
  });

  test('the null row can be cut by the byte budget without losing its empty total', async (t) => {
    const f=await fixture(t,{knowledge:{limits:{maxViewBytes:64*1024+60}}});
    const view=FacetView.parse((await f.json(await f.read(`knowledge:facets:acme:${B}?kind=case&by=defects`))).value);
    assert.equal(view.truncated,true);
    assert.deepEqual(view.rows,[{values:{defects:'100'},count:2}]);
    assert.deepEqual(view.totals.empty,{defects:4});
  });

  test('a list field cross product beyond the combination cap is refused with a narrowing action', async (t) => {
    const f = await fixture(t);
    const tags = Array.from({ length: 70 }, (_, i) => `t${i}`);
    const text = `[cmd: system show] 很多标签 ${Array.from({ length: 70 }, (_, i) => `#${i}`).join(' ')}`;
    f.w.external.set('store:mindmap:d9', { bytes: mindMap({ id: 'd9', module: 'M9' }, [{ id: 'c9', text, resource: tags, expected: ['x'] }]), mediaType: JSON_TYPE });
    f.w.external.set('site:tree:Rel_ACME_1_2_17', { bytes: catalogXml(BASE_CATALOG), mediaType: 'application/xml' });
    const produced = await f.w.knowledge.produceTree({ product: f.w.product, build: build('Rel_ACME_1_2_17', ['store:mindmap:d9']) });
    assert.equal(produced.ok, true, produced.reason ?? '');
    const rejected=await f.read('knowledge:facets:acme:Rel_ACME_1_2_17?kind=case&by=tags,defects,missing');
    assert.equal(rejected.ok,false);
    if(!rejected.ok)assert.match(rejected.reason,/组合超过上限.*减少 by/);
    const narrowed=FacetView.parse((await f.json(await f.read('knowledge:facets:acme:Rel_ACME_1_2_17?kind=case&by=missing'))).value);
    assert.equal(narrowed.total,1);assert.deepEqual(narrowed.totals.empty,{missing:1});
  });

  test('the index maps each value to the entries that carry it; only= keeps the listed values and names those without entries', async (t) => {
    const f = await fixture(t);
    const { b } = f.digests;
    const c1 = b.get('[cmd: system reboot] 重启 #100') as string;
    const c2 = b.get('[cmd: net ping] 连通 #100 #200') as string;
    const view = IndexView.parse((await f.json(await f.read(`knowledge:index:acme:${B}?kind=case&key=defects`))).value);
    assert.deepEqual(view.keys, { '100': sorted(c1, c2), '200': [c2] });
    assert.equal(Object.hasOwn(view, 'only'), false);
    assert.deepEqual(view.cut_keys, []);
    assert.deepEqual(Object.keys(view.entries), sorted(c1, c2));
    assert.equal(view.entries[c2].reference, `tree:${f.roots.b}/commands/net/ping@${c2}`);
    assert.deepEqual([view.total_keys, view.total_entries, view.truncated], [2, 2, false]);
    assert.equal(view.notes.some((note) => note.startsWith('未归位')), false);
    const only = IndexView.parse((await f.json(await f.read(`knowledge:index:acme:${B}?kind=case&key=defects&only=999,200,999`))).value);
    assert.deepEqual(only.keys, { '200': [c2] });
    assert.deepEqual(only.only, ['200', '999']);
    assert.deepEqual(only.cut_keys, []);
    const repeated = await f.json(await f.read(`knowledge:index:acme:${B}?kind=case&key=defects&only=999,200,999`));
    const reordered = await f.json(await f.read(`knowledge:index:acme:${B}?kind=case&key=defects&only=200,999`));
    assert.deepEqual(repeated.bytes, reordered.bytes);
    assert.deepEqual([only.total_keys, only.total_entries], [1, 1]);
    assert.ok(only.notes.some((note) => note === '这些取值没有条目：999'));
    const byModule = IndexView.parse((await f.json(await f.read(`knowledge:index:acme:${B}?kind=case&key=module`))).value);
    assert.deepEqual(Object.fromEntries(Object.entries(byModule.keys).map(([k, v]) => [k, v.length])), { M1: 3, M2: 3 });
    const none = IndexView.parse((await f.json(await f.read(`knowledge:index:acme:${B}?kind=defect&key=defects`))).value);
    assert.deepEqual(none.keys, {});
    assert.match(none.notes[0], /没有缺陷种类的条目/);
  });

  test('an entry filed at two paths is counted once and cited at its first path', async (t) => {
    const twice = (path: string) => ({ kind: 'case', path, statement: '两处都有的用例', data: { defects: ['7'] }, fragments: [{ parser: 'xml@1', selector: 'x/catalog/group[1]' }], applicability: null });
    const w = await makeWorld(postgres, { pack: { declaration: { producers: [DEFAULT_PRODUCERS[0], extraProducer('other', { entries: [twice('/commands/system/show'), twice('/commands/net/ping')] })] } } });
    t.after(() => w.close());
    w.external.set(`site:tree:${A}`, { bytes: catalogXml(BASE_CATALOG), mediaType: 'application/xml' });
    const produced = await w.knowledge.produceTree({ product: w.product, build: { ...build(A, []), sources: { tree: `site:tree:${A}` } } });
    assert.equal(produced.ok, true, produced.reason ?? '');
    const reader = createKnowledgeReader(w.knowledge);
    const json = async (id: string): Promise<unknown> => {
      const read = await reader.read(id, { principal: w.user, run: null, purpose: 'x' });
      assert.ok(read.ok, read.ok ? '' : read.reason);
      const source = await w.kit.artifacts.source(w.user, read.artifacts[0].artifact.body.sha256, { consumer: 'function' });
      return JSON.parse(new TextDecoder().decode(source?.bytes ?? new Uint8Array()));
    };
    const facets = FacetView.parse(await json(`knowledge:facets:acme:${A}?kind=case&by=defects`));
    assert.deepEqual([facets.total, facets.rows], [1, [{ values: { defects: '7' }, count: 1 }]]);
    const index = IndexView.parse(await json(`knowledge:index:acme:${A}?kind=case&key=defects`));
    const [digest] = index.keys['7'];
    assert.equal(index.entries[digest].reference, `tree:${produced.root}/commands/net/ping@${digest}`, '/commands/net/ping sorts before /commands/system/show');
  });

  test('facets and index count placed and unplaced entries once and cite an unplaced entry at the root; impact leaves it out', async (t) => {
    const fragment = [{ parser: 'xml@1', selector: 'x/catalog/group[1]' }];
    const shared = { kind: 'case', statement: '两处都有的用例', data: { status: 'fixed', defects: ['7'] }, fragments: fragment, applicability: null };
    const entries = [
      { ...shared, path: '/commands/system/show' },
      { ...shared, path: null },
      { kind: 'case', path: null, statement: '没有命令的用例', data: { status: 'known', defects: ['7', '8'] }, fragments: fragment, applicability: null },
      { kind: 'case', path: null, statement: '没有缺陷编号的用例', data: { defects: [] }, fragments: fragment, applicability: null },
      { kind: 'defect', path: null, statement: '已修复 61001', data: { status: 'fixed', bug: '61001' }, fragments: fragment, applicability: null },
      { kind: 'defect', path: null, statement: '已知 70412', data: { status: 'known', bug: '70412' }, fragments: fragment, applicability: null },
    ];
    const w = await makeWorld(postgres, { pack: { declaration: { producers: [DEFAULT_PRODUCERS[0], extraProducer('other', { entries })] } } });
    t.after(() => w.close());
    w.external.set(`site:tree:${A}`, { bytes: catalogXml(BASE_CATALOG), mediaType: 'application/xml' });
    w.external.set(`site:tree:${B}`, { bytes: catalogXml({ ...BASE_CATALOG, net: [...BASE_CATALOG.net, { name: 'arp', params: [] }] }), mediaType: 'application/xml' });
    const produced = await w.knowledge.produceTree({ product: w.product, build: { ...build(A, []), sources: { tree: `site:tree:${A}` } } });
    const later = await w.knowledge.produceTree({ product: w.product, build: { ...build(B, []), sources: { tree: `site:tree:${B}` } } });
    assert.equal(produced.ok && later.ok, true, `${produced.reason} ${later.reason}`);
    const root = produced.root as string;

    const byStatus = FacetView.parse(await readJson(w, `knowledge:facets:acme:${A}?kind=case&by=status`));
    assert.deepEqual(byStatus.rows, [
      { values: { status: 'fixed' }, count: 1 },
      { values: { status: 'known' }, count: 1 },
      { values: { status: null }, count: 1 },
    ]);
    assert.equal(byStatus.total, 3);
    assert.ok(byStatus.notes.includes(labelOf('knowledge_count', 'tree_unplaced_entries') + ' 2 个，标在根下，计入合计'));

    const byDefects = FacetView.parse(await readJson(w, `knowledge:facets:acme:${A}?kind=case&by=defects`));
    assert.deepEqual(byDefects.rows, [
      { values: { defects: '7' }, count: 2 },
      { values: { defects: '8' }, count: 1 },
      { values: { defects: null }, count: 1 },
    ]);
    assert.equal(byDefects.total, 3);

    const byList = IndexView.parse(await readJson(w, `knowledge:index:acme:${A}?kind=case&key=defects`));
    const hung = Object.values(byList.entries).find((entry) => entry.statement === '两处都有的用例');
    const loose = Object.values(byList.entries).find((entry) => entry.statement === '没有命令的用例');
    assert.ok(hung && loose);
    assert.equal(hung.reference, `tree:${root}/commands/system/show@${hung.entry}`);
    assert.equal(loose.reference, `tree:${root}/@${loose.entry}`);
    assert.deepEqual(byList.keys['7'], sorted(hung.entry, loose.entry));
    assert.deepEqual(byList.keys['8'], [loose.entry]);
    assert.deepEqual([byList.total_keys, byList.total_entries], [2, 2]);
    assert.ok(byList.notes.includes(labelOf('knowledge_count', 'tree_unplaced_entries') + ' 2 个，标在根下'));

    const byCaseStatus = IndexView.parse(await readJson(w, `knowledge:index:acme:${A}?kind=case&key=status`));
    assert.deepEqual(Object.keys(byCaseStatus.keys), ['fixed', 'known']);
    assert.deepEqual(byCaseStatus.keys.fixed, [hung.entry]);
    assert.deepEqual(byCaseStatus.keys.known, [loose.entry]);
    assert.equal(byCaseStatus.entries[loose.entry].reference, `tree:${root}/@${loose.entry}`);

    const defectStatus = IndexView.parse(await readJson(w, `knowledge:index:acme:${A}?kind=defect&key=status`));
    const fixed = Object.values(defectStatus.entries).find((entry) => entry.statement === '已修复 61001');
    const known = Object.values(defectStatus.entries).find((entry) => entry.statement === '已知 70412');
    assert.ok(fixed && known);
    assert.deepEqual(defectStatus.keys, { fixed: [fixed.entry], known: [known.entry] });
    assert.equal(fixed.reference, `tree:${root}/@${fixed.entry}`);
    assert.equal(known.reference, `tree:${root}/@${known.entry}`);
    assert.equal(fixed.data.bug, '61001');
    assert.equal(known.data.status, 'known');
    assert.deepEqual([defectStatus.total_keys, defectStatus.total_entries], [2, 2]);
    assert.ok(defectStatus.notes.includes(labelOf('knowledge_count', 'tree_unplaced_entries') + ' 2 个，标在根下'));

    const byBug = IndexView.parse(await readJson(w, `knowledge:index:acme:${A}?kind=defect&key=bug&only=61001,999`));
    assert.deepEqual(byBug.keys, { '61001': [fixed.entry] });
    assert.equal(byBug.entries['61001'] === undefined, true);
    assert.equal(byBug.entries[fixed.entry].reference, `tree:${root}/@${fixed.entry}`);
    assert.ok(byBug.notes.some((note) => note === '这些取值没有条目：999'));
    assert.ok(byBug.notes.includes(labelOf('knowledge_count', 'tree_unplaced_entries') + ' 2 个，标在根下'));

    const impact = ImpactView.parse(await readJson(w, `knowledge:impact:acme:${A}..${B}`));
    assert.ok(impact.changes.length > 0);
    const statements = new Set(Object.values(impact.entries).map((entry) => entry.statement));
    for (const text of ['没有命令的用例', '没有缺陷编号的用例', '已修复 61001', '已知 70412']) assert.equal(statements.has(text), false, text);
    assert.equal(impact.notes.some((note) => note.startsWith(labelOf('knowledge_count', 'tree_unplaced_entries'))), false);
  });

  test('facets and index over 60000 unplaced entries finish within a few seconds', { timeout: 300_000 }, async (t) => {
    const source = `
export default function many(input: any): unknown {
  const n = (input.params && input.params.n) || 0;
  const entries = new Array(n);
  const fragments = [{ parser: 'xml@1', selector: 'x/catalog/group[1]' }];
  for (let i = 0; i < n; i++) {
    const even = i % 2 === 0;
    entries[i] = { kind: 'defect', path: null, statement: '未归位 ' + i, data: { status: even ? 'fixed' : 'known', bug: even ? '61001' : '70412' }, fragments, applicability: null };
  }
  return { entries, warnings: [] };
}
`;
    const w = await makeWorld(postgres, {
      pack: {
        functions: { 'many.ts': source },
        declaration: {
          producers: [DEFAULT_PRODUCERS[0], { id: 'many', title: '大量未归位条目', function: { module: 'functions/many.ts' }, inputs: { tree: { source: 'tree' } }, params: { n: 60_000 } }],
        },
      },
    });
    t.after(() => w.close());
    w.external.set(`site:tree:${A}`, { bytes: catalogXml(BASE_CATALOG), mediaType: 'application/xml' });
    const produced = await w.knowledge.produceTree({ product: w.product, build: { ...build(A, []), sources: { tree: `site:tree:${A}` } } });
    assert.equal(produced.ok, true, produced.reason ?? '');
    assert.equal(produced.unplaced, 60_000);
    const root = produced.root as string;
    let queries=0;
    const rawQuery=pg.Client.prototype.query;
    t.mock.method(pg.Client.prototype,'query',function(this:pg.Client,...args:unknown[]){queries++;return Reflect.apply(rawQuery,this,args);});
    const facetStarted = performance.now();
    const facets = FacetView.parse(await readJson(w, `knowledge:facets:acme:${A}?kind=defect&by=status`));
    const facetMs = performance.now() - facetStarted;
    assert.deepEqual(facets.rows, [
      { values: { status: 'fixed' }, count: 30_000 },
      { values: { status: 'known' }, count: 30_000 },
    ]);
    assert.equal(facets.total, 60_000);
    assert.ok(facets.notes.includes(labelOf('knowledge_count', 'tree_unplaced_entries') + ' 60000 个，标在根下，计入合计'));
    assert.ok(facetMs < 8_000, `facets took ${facetMs.toFixed(0)} ms`);
    const indexStarted = performance.now();
    const index = IndexView.parse(await readJson(w, `knowledge:index:acme:${A}?kind=defect&key=status`));
    const indexMs = performance.now() - indexStarted;
    assert.deepEqual([index.total_keys, index.total_entries], [2, 60_000]);
    assert.deepEqual(Object.keys(index.keys), ['fixed']);
    assert.equal(index.keys.fixed.length,2_000);
    assert.ok(index.next,'the remaining entries must be readable');
    assert.deepEqual(index.cut_keys,[],'pagination replaces permanent per-key cuts');
    assert.equal(index.truncated, true);
    const cited = index.entries[index.keys.fixed[0]];
    assert.equal(cited.reference, `tree:${root}/@${cited.entry}`);
    assert.ok(index.notes.includes(labelOf('knowledge_count', 'tree_unplaced_entries') + ' 60000 个，标在根下'));
    assert.ok(queries<1500,`two 60000-entry views used ${queries} queries; entries must be batched`);
    assert.ok(indexMs < 8_000, `index took ${indexMs.toFixed(0)} ms`);
  });

  test('an index over the byte budget supplies a continuation within a key', async (t) => {
    // The keys M1 and M2 take 1812 and 1805 bytes with their entries, counted exactly.
    const f = await fixture(t, { knowledge: { limits: { maxViewBytes: 64 * 1024 + 2500 } } });
    const view = IndexView.parse((await f.json(await f.read(`knowledge:index:acme:${B}?kind=case&key=module`))).value);
    assert.equal(view.truncated, true);
    assert.equal(view.total_keys, 2);
    assert.deepEqual(view.cut_keys, [], 'whole-key byte-budget omissions are not per-key cuts');
    assert.ok(Object.keys(view.entries).length < view.total_entries);
    assert.ok(view.next);
    assert.ok(view.notes.some((note) => /续读/.test(note)));
  });
});

describe('the attached_fields parameter of the impact view', () => {
  test('attached entries carry only the named fields with an empty statement; changed entries are untouched', async (t) => {
    const f = await fixture(t);
    const { b } = f.digests;
    const plain = ImpactView.parse((await f.json(await f.read(`knowledge:impact:acme:${A}..${B}`))).value);
    const slim = ImpactView.parse((await f.json(await f.read(`knowledge:impact:acme:${A}..${B}?attached_fields=document,case,priority`))).value);
    assert.deepEqual(slim.attached_fields, ['case', 'document', 'priority'], 'the view records the fields it carries');
    // The changes, placements and totals are the same; only the attached entries are slimmed.
    assert.deepEqual([slim.changes, slim.placements, slim.totals], [plain.changes, plain.placements, plain.totals]);
    const c6 = b.get('[cmd: system reboot] 重启后再检查') as string;
    const slimCase = slim.entries[c6];
    assert.equal(slimCase.kind, 'case');
    assert.equal(slimCase.statement, '');
    assert.deepEqual(Object.keys(slimCase.data).sort(), ['case', 'document', 'priority']);
    assert.deepEqual([slimCase.data.document, slimCase.data.case, slimCase.data.priority], [plain.entries[c6].data.document, plain.entries[c6].data.case, plain.entries[c6].data.priority]);
    assert.equal(slimCase.reference, plain.entries[c6].reference);
    // The changed definition entry keeps its full statement and data.
    const reboot = b.get('system reboot <delay:int>') as string;
    assert.equal(slim.entries[reboot].statement, plain.entries[reboot].statement);
    assert.deepEqual(slim.entries[reboot].data, plain.entries[reboot].data);
    assert.ok(slim.notes.some((note) => /attached_fields/.test(note) && /用例/.test(note)), slim.notes.join('\n'));
    assert.ok(plain.notes.every((note) => !/attached_fields/.test(note)), 'the plain view does not mention attached_fields');
  });

  test('the byte accounting uses the slimmed size: a budget between the two cuts the plain view and not the slim one', async (t) => {
    const measured = await fixture(t);
    const plainBytes = (await measured.json(await measured.read(`knowledge:impact:acme:${A}..${B}`))).bytes.byteLength;
    const slimBytes = (await measured.json(await measured.read(`knowledge:impact:acme:${A}..${B}?attached_fields=document,case,priority`))).bytes.byteLength;
    assert.ok(slimBytes < plainBytes, `${slimBytes} < ${plainBytes}`);
    // The lists get maxViewBytes less 64 KiB. Measured on this fixture: the plain view is 6,437 bytes, the slim one 6,055;
    // at the budget 64 KiB + 5,500 the plain view keeps 3 of the 4 changed paths (truncated), the slim one all 4.
    const f = await fixture(t, { knowledge: { limits: { maxViewBytes: 64 * 1024 + 5500 } } });
    const plain = ImpactView.parse((await f.json(await f.read(`knowledge:impact:acme:${A}..${B}`))).value);
    const slim = ImpactView.parse((await f.json(await f.read(`knowledge:impact:acme:${A}..${B}?attached_fields=document,case,priority`))).value);
    assert.equal(plain.truncated, true, 'the plain view is cut at this budget');
    assert.equal(slim.truncated, false, 'the slim view fits');
    assert.ok(slim.changes.length > plain.changes.length, `slim keeps ${slim.changes.length} paths, plain ${plain.changes.length}`);
    assert.deepEqual(slim.totals, plain.totals);
    assert.deepEqual(
      plain.changes.map((c) => c.path),
      slim.changes.slice(0, plain.changes.length).map((c) => c.path),
      'the kept paths are the same prefix in path order',
    );
  });

  test('parseViewId accepts attached_fields on the impact view only, deduped and sorted; rejects bad names', () => {
    const parsed = parseViewId(`knowledge:impact:acme:${A}..${B}?attached_fields=title,document,document`);
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.ok && parsed.value.type === 'impact' ? parsed.value.attached_fields : null, ['document', 'title']);
    const withoutIt = parseViewId(`knowledge:impact:acme:${A}..${B}`);
    assert.ok(withoutIt.ok && withoutIt.value.type === 'impact' && withoutIt.value.attached_fields === null);
    assert.equal(parseViewId(`knowledge:impact:acme:${A}..${B}?attached_fields=Document`).ok, false);
    assert.equal(parseViewId(`knowledge:impact:acme:${A}..${B}?attached_fields=`).ok, false);
    assert.equal(parseViewId(`knowledge:facets:acme:${A}?kind=case&by=line&attached_fields=document`).ok, false);
    assert.equal(parseViewId(`knowledge:index:acme:${A}?kind=case&key=defects&attached_fields=document`).ok, false);
  });
});

describe('ids, readers and stored answers', () => {
  test('builds resolve through aliases and any case; products by any name; the stored spelling is shown', async (t) => {
    const f = await fixture(t);
    await f.w.knowledge.store.putBuild({
      product: 'acme',
      build: { name: 'Rel_ZETA_1_2_7', family: 'ZETA', line: '1.2', base: A, platform: null, built_at: null, released_at: '2026-01-07T00:00:00.000Z', sources: {} },
      pack: { id: 'acme', version: '1.0.0', digest: f.w.product.digest },
      plan: null,
      sync: null,
    });
    const view = FacetView.parse((await f.json(await f.read('knowledge:facets:ZETA:rel_zeta_1_2_7?kind=case&by=module'))).value);
    assert.equal(view.product, 'acme');
    assert.deepEqual(view.build, { build: 'Rel_ZETA_1_2_7', root: f.roots.a });
    const direct = FacetView.parse((await f.json(await f.read(`knowledge:facets:acme:${A}?kind=case&by=module`))).value);
    assert.deepEqual(view.rows, direct.rows);
  });

  test('two reads give byte-identical answers; another reader gets the same bytes in a record of their own', async (t) => {
    const f = await fixture(t);
    const id = `knowledge:index:acme:${B}?kind=case&key=defects`;
    const first = await f.read(id);
    const second = await f.read(id);
    assert.ok(first.ok && second.ok);
    const [x, y] = [first.artifacts[0].artifact, second.artifacts[0].artifact];
    assert.equal(x.body.sha256, y.body.sha256);
    assert.equal(x.digest, y.digest, 'the same ingest for the same reader is one record');
    assert.equal(x.body.media_type, JSON_TYPE);
    assert.equal(x.body.read_tier, 'model_readable');
    const admin = await f.read(id, f.w.admin);
    assert.ok(admin.ok);
    assert.equal(admin.artifacts[0].artifact.body.sha256, x.body.sha256);
    assert.notEqual(admin.artifacts[0].artifact.digest, x.digest);
    assert.equal(await f.w.kit.artifacts.source(f.w.outsider, x.body.sha256, { consumer: 'function' }), null, 'nobody else reads the stored answer');
    // A pinned revision must be the current one.
    assert.equal((await f.read(`${id}@${f.roots.b}`)).ok, true);
    const stale = await f.read(`${id}@${f.roots.a}`);
    assert.equal(stale.ok, false);
    assert.match(!stale.ok ? stale.reason : '', /要求修订/);
    // The manifest is the record of the view's computation.
    const manifest = await f.w.kit.store.get<{ component: string; inputs: string[] }>(first.manifest);
    assert.equal(manifest?.body.component, 'knowledge.views@1');
    assert.equal(manifest?.body.inputs[0],`tree:${f.roots.b}/`);
    assert.equal(manifest?.body.inputs.length,2);
    const compositionRef = manifest!.body.inputs[1];
    assert.match(compositionRef,/^rec:[a-f0-9]{64}$/);
    const composition = await f.w.kit.store.get<{root:string}>(compositionRef.slice(4));
    assert.equal(composition?.schema,'tree_root@1');
    assert.equal(composition?.body.root,f.roots.b);
  });

  test('a reader without the product, unknown products and builds and malformed ids give ok:false with the real reason', async (t) => {
    const f = await fixture(t);
    const reader = createKnowledgeReader(f.w.knowledge);
    const refusal = async (id: string, principal: Principal = f.w.user): Promise<string> => {
      const read = await f.read(id, principal);
      assert.equal(read.ok, false, id);
      return read.ok ? '' : read.reason;
    };
    const good = `knowledge:facets:acme:${B}?kind=case&by=module`;
    assert.match(await refusal(good, f.w.outsider), /不能读产品 acme 的知识/);
    const gone = await f.w.kit.principals.createUser(f.w.admin, 'gone');
    f.w.packs.readers.set(gone.id, new Set(['acme']));
    await f.w.kit.principals.setDisabled(f.w.admin, gone.id, true);
    assert.match(await refusal(good, gone), /不能读产品/);
    assert.match(await refusal(`knowledge:facets:nothing:${B}?kind=case&by=module`), /没有产品 nothing/);
    assert.match(await refusal('knowledge:facets:acme:Rel_NONE_9_9_9?kind=case&by=module'), /没有构建 Rel_NONE_9_9_9/);
    const malformed: Array<[string, RegExp]> = [
      ['knowledge:facets:acme', /不是知识视图的标识/],
      [`knowledge:graph:acme:${B}`, /没有叫 graph 的知识视图/],
      [`knowledge:facets:acme:${B}`, /要有参数 kind/],
      [`knowledge:facets:acme:${B}?kind=case`, /要有参数 by/],
      [`knowledge:facets:acme:${B}?kind=command&by=module`, /不是知识条目种类/],
      [`knowledge:facets:acme:${B}?kind=case&by=a,b,c,d,e,f,g`, /1 到 6 个/],
      [`knowledge:facets:acme:${B}?kind=case&by=Module`, /数据字段名/],
      [`knowledge:facets:acme:${B}?kind=case&by=module,module`, /重复/],
      [`knowledge:facets:acme:${B}?kind=case&by=module&kind=case`, /写了两次/],
      [`knowledge:facets:acme:${B}?kind=case&by=module&limit=3`, /不认识参数 limit/],
      [`knowledge:facets:acme:${B}?kind=case,definition&by=module`, /只能有一个取值/],
      [`knowledge:facets:acme:${B}?kind=case&by=module,`, /取值写法不对/],
      [`knowledge:impact:acme:${B}`, /<起始构建>\.\.<目标构建>/],
      [`knowledge:impact:acme:${A}..${B}?changed=`, /至少要有一个/],
      [`knowledge:index:acme:${B}?kind=case`, /要有参数 key/],
      [`knowledge:index:acme:${B}?kind=case&key=defects&only=`, /1 到 1000 个取值/],
      [`knowledge:index:acme:%E0%A4%A?kind=case&key=defects`, /百分号转义有误/],
    ];
    for (const [id, reason] of malformed) assert.match(await refusal(id), reason, id);
    // Only knowledge ids of a known view are accepted; the router sends the rest to the other reader.
    assert.equal(await reader.accepts(good), true);
    assert.equal(await reader.accepts('knowledge:graph:acme:x'), false);
    assert.equal(await reader.accepts('site:tree:x'), false);
    const routed = routeKnowledgeViews(reader, f.w.external);
    assert.equal(await routed.accepts('site:tree:Rel_ACME_1_2_15'), true);
    assert.equal(await routed.accepts(good), true);
    const viaRoute = await routed.read(good, { principal: f.w.user, run: null, purpose: 'x' });
    assert.equal(viaRoute.ok, true);
    const tree = await routed.read('site:tree:Rel_ACME_1_2_15', { principal: f.w.admin, run: null, purpose: 'x' });
    assert.equal(tree.ok, true);
  });
});

// Memoized producer calls (one batch per call): the output is stored as an object under the memo key and used again when
// the key recurs, reuse is reported and never changes a digest; a changed document re-runs only its batch, a changed other
// slot or another build re-runs every batch (the key covers everything the function receives, the build included). Large
// compositions in parts: the main record stays small, every reader gives the same answers as for one record, and parts are
// shared between roots by content.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { TreeRootBody } from '../../contracts/src/knowledge.ts';
import type { KnownBuild } from '../../contracts/src/product.ts';
import type { PermissionRole } from '../../contracts/generated/vocabulary.ts';
import type { ActionBody } from '../records/api.ts';
import { createDefaultRegistry, resolveReference } from '../refs/api.ts';
import type { TemporaryPostgres } from '../testing/postgres.ts';
import { Builds } from './builds.ts';
import { memoKey } from './lists.ts';
import { INDEX, MemoDetail, SCHEMAS } from './store.ts';
import { BASE_CATALOG, DEFAULT_PRODUCERS, casesProducer, catalogXml, makeWorld, mindMap, startPostgres, type World } from './test-support.ts';

let postgres: TemporaryPostgres;
before(async () => {
  postgres = await startPostgres();
});
after(() => postgres?.stop());

const XML = 'application/xml';

function build(name: string, cases: string[]): KnownBuild {
  return {
    name,
    family: 'ACME',
    line: '1.2',
    base: name,
    platform: null,
    built_at: '2026-01-02T10:00:00.000Z',
    released_at: '2026-01-05T00:00:00.000Z',
    sources: { tree: `site:tree:${name}`, cases },
    root: null,
  };
}

async function world(t: { after: (fn: () => Promise<void>) => void }, producers: unknown[], options: Parameters<typeof makeWorld>[1] = {}): Promise<World> {
  const w = await makeWorld(postgres, { ...options, pack: { ...(options?.pack??{}), declaration: { ...(options?.pack?.declaration??{}), producers } } });
  t.after(() => w.close());
  w.external.set('site:tree:Rel_ACME_1_2_15', { bytes: catalogXml(BASE_CATALOG), mediaType: XML });
  w.external.set('site:tree:Rel_ACME_1_2_16', { bytes: catalogXml(BASE_CATALOG), mediaType: XML });
  w.external.set('site:tree:Rel_ACME_1_2_17', { bytes: catalogXml({ ...BASE_CATALOG, net: [...BASE_CATALOG.net, { name: 'arp', params: [] }] }), mediaType: XML });
  // A cache comparison freezes the same declared build inventory on both calls, as sync does.
  const builds=new Builds(w.knowledge.__context);
  for(const name of ['Rel_ACME_1_2_15','Rel_ACME_1_2_16','Rel_ACME_1_2_17'])await builds.record('acme',{id:w.product.id,version:w.product.version,digest:w.product.digest},build(name,[]),null,null);
  return w;
}

function documents(w: World, count: number, cases = 2): string[] {
  return Array.from({ length: count }, (_, k) => {
    const i = k + 1;
    const id = `store:mindmap:d${i}`;
    const list = Array.from({ length: cases }, (_, c) => ({
      id: `d${i}-c${c}`,
      text: `[cmd: ${c % 2 === 0 ? 'system reboot' : 'net ping'}] 用例 ${i}-${c} #${100 + (i % 3)}`,
      expected: c % 3 === 0 ? [] : [`期望 ${i}-${c}`],
    }));
    w.external.set(id, { bytes: mindMap({ id: `d${i}`, module: `M${i % 3}` }, list), mediaType: 'application/json' });
    return id;
  });
}

async function body(w: World, digest: string | null): Promise<TreeRootBody> {
  assert.ok(digest !== null);
  const record = await w.kit.store.get(digest);
  assert.ok(record !== null);
  return TreeRootBody.parse(record.body);
}

async function countSchema(w: World, schema: string): Promise<number> {
  let n = 0;
  let cursor: string | null = null;
  do {
    const page: { items: Array<{ schema: string }>; next: string | null } = await w.kit.store.list({ kind: 'tree_root', limit: 500, cursor });
    n += page.items.filter((r) => r.schema === schema).length;
    cursor = page.next;
  } while (cursor !== null);
  return n;
}

describe('memoized producer calls', () => {
  test('the output is stored under the memo key and used again; reuse is reported and never changes a digest', async (t) => {
    const w = await world(t, [DEFAULT_PRODUCERS[0], casesProducer({ batch: 2 })]);
    const ids = documents(w, 6);
    const first = await w.knowledge.produceTree({ product: w.product, build: build('Rel_ACME_1_2_15', ids) });
    assert.equal(first.ok, true, first.reason ?? '');
    assert.deepEqual(first.calls, { made: 4, reused: 0 });

    // The memo record names the stored output object; the key follows the documented recipe.
    const page = await w.kit.store.list<ActionBody>({ kind: 'action', limit: 500 });
    const memos = page.items.filter((r) => r.body.component === 'knowledge.producer@1').map((r) => MemoDetail.parse(r.body.detail));
    assert.equal(memos.length, 3);
    for (const memo of memos) {
      assert.equal(memo.producer, 'cases');
      assert.equal(memo.elements, 2);
      const stored = await w.kit.objects.get(memo.output.sha256);
      assert.ok(stored !== null && stored.byteLength === memo.output.size);
      assert.equal((await w.kit.store.find({ key: INDEX.memo, value: memo.key, kind: 'action', limit: 1 })).items.length, 1);
    }

    // The same build again: every batch comes from its stored output. Another build of the same documents is another input
    // (a list producer may read the build), so its batches run again; with equal trees and documents the root is the same.
    const again = await w.knowledge.produceTree({ product: w.product, build: build('Rel_ACME_1_2_15', ids) });
    assert.deepEqual(again.calls, { made: 1, reused: 3 });
    assert.equal(again.root, first.root);
    const other = await w.knowledge.produceTree({ product: w.product, build: build('Rel_ACME_1_2_16', ids) });
    assert.deepEqual(other.calls, { made: 4, reused: 0 });
    assert.equal(other.root, first.root, 'equal trees and equal documents: the same root, memoized or not');
    // A world without stored outputs computes the same root (the digest never depends on reuse).
    const fresh = await world(t, [DEFAULT_PRODUCERS[0], casesProducer({ batch: 2 })]);
    const freshIds = documents(fresh, 6);
    const recomputed = await fresh.knowledge.produceTree({ product: fresh.product, build: build('Rel_ACME_1_2_15', freshIds) });
    assert.deepEqual(recomputed.calls, { made: 4, reused: 0 });
    assert.equal(recomputed.root, first.root);
  });

  test('a changed document re-runs only its batch; a changed other slot re-runs every batch', async (t) => {
    const w = await world(t, [DEFAULT_PRODUCERS[0], casesProducer({ batch: 2, withTree: true })]);
    const ids = documents(w, 6);
    const first = await w.knowledge.produceTree({ product: w.product, build: build('Rel_ACME_1_2_15', ids) });
    assert.deepEqual(first.calls, { made: 4, reused: 0 });
    // One document of the second batch changes (read again: max_age 0).
    w.external.set(ids[3], { bytes: mindMap({ id: 'd4', module: 'M1' }, [{ id: 'd4-c0', text: '[cmd: system reboot] 改过的用例', expected: ['新的期望'] }]), mediaType: 'application/json' });
    const changed = await w.knowledge.produceTree({ product: w.product, build: build('Rel_ACME_1_2_15', ids), maxAgeSeconds: 0 });
    assert.equal(changed.ok, true, changed.reason ?? '');
    assert.deepEqual(changed.calls, { made: 2, reused: 2 }, 'the command producer and the one batch with the changed document');
    assert.notEqual(changed.root, first.root);
    // Equal tree bytes under another build, and other tree bytes: every batch runs again.
    const sameTree = await w.knowledge.produceTree({ product: w.product, build: build('Rel_ACME_1_2_16', ids) });
    assert.deepEqual(sameTree.calls, { made: 4, reused: 0 });
    const otherTree = await w.knowledge.produceTree({ product: w.product, build: build('Rel_ACME_1_2_17', ids) });
    assert.deepEqual(otherTree.calls, { made: 4, reused: 0 });
    // The build of a sync carries its previous root; a producer receives none, so the batches of the same build are reused.
    const overRoot = await w.knowledge.produceTree({ product: w.product, build: { ...build('Rel_ACME_1_2_17', ids), root: otherTree.root } });
    assert.deepEqual(overRoot.calls, { made: 1, reused: 3 });
  });

  test('the memo key covers the pack, the producer, its function and params, the build, the batch, the elements in order and the other slots', () => {
    const source = (sha: string, parser = 'kityminder@1') => ({ sha256: sha, mediaType: 'application/json', parser }) as Parameters<typeof memoKey>[0]['elements'][number];
    const producer = { id: 'cases', title: 't', function: { module: 'functions/cases.ts' }, inputs: {}, params: { a: 1 } };
    const known = build('Rel_ACME_1_2_15', ['store:mindmap:d1', 'store:mindmap:d2']);
    const base = {
      pack: 'p'.repeat(64),
      producer,
      build: known,
      list: 'cases',
      batch: { index: 0, of: 2 },
      elements: [source('1'.repeat(64)), source('2'.repeat(64))],
      slots: new Map([['tree', source('3'.repeat(64), 'xml@1')]]),
    };
    const key = memoKey(base);
    assert.equal(memoKey({ ...base }), key, 'deterministic');
    const variants = [
      { ...base, pack: 'q'.repeat(64) },
      { ...base, producer: { ...producer, id: 'other' } },
      { ...base, producer: { ...producer, function: { module: 'functions/other.ts' } } },
      { ...base, producer: { ...producer, params: { a: 2 } } },
      { ...base, build: { ...known, name: 'Rel_ACME_1_3_20', base: 'Rel_ACME_1_3_20' } },
      { ...base, build: { ...known, line: '1.3' } },
      { ...base, build: { ...known, released_at: null } },
      { ...base, build: { ...known, sources: { ...known.sources, cases: ['store:mindmap:d1'] } } },
      { ...base, list: 'docs' },
      { ...base, batch: { index: 1, of: 2 } },
      { ...base, batch: { index: 0, of: 3 } },
      { ...base, elements: [...base.elements].reverse() },
      { ...base, elements: [source('1'.repeat(64), 'json@1'), base.elements[1]] },
      { ...base, slots: new Map([['tree', source('4'.repeat(64), 'xml@1')]]) },
      { ...base, slots: new Map([['tree', null]]) },
    ];
    for (const variant of variants) assert.notEqual(memoKey(variant as typeof base), key, JSON.stringify(variant).slice(0, 120));
  });
});

describe('a large composition in parts', () => {
  test('rows, unplaced rows and list sources go to parts; every reader answers as for one record', async (t) => {
    const inline = await world(t, [DEFAULT_PRODUCERS[0], casesProducer({ batch: 4 })]);
    const parted = await world(t, [DEFAULT_PRODUCERS[0], casesProducer({ batch: 4 })], { knowledge: { limits: { inlineRows: 2 } } });
    const results = [];
    for (const w of [inline, parted]) {
      const ids = documents(w, 6, 3);
      // One case without a command: it has no path and stays unplaced (no typed-judgment model here).
      w.external.set(ids[5], { bytes: mindMap({ id: 'd6', module: 'M0' }, [{ id: 'd6-c0', text: '没有命令的用例', expected: ['x'] }]), mediaType: 'application/json' });
      const result = await w.knowledge.produceTree({ product: w.product, build: build('Rel_ACME_1_2_15', ids) });
      assert.equal(result.ok, true, result.reason ?? '');
      results.push(result);
    }
    const [one, split] = results;
    assert.equal(split.root, one.root, 'the root does not depend on how the composition is stored');
    assert.equal(one.parts, 0);
    assert.equal(split.parts, 4, 'a rows part per kind, one for unplaced rows, one for list sources');
    const a = await body(inline, one.composition);
    const b = await body(parted, split.composition);
    assert.equal(a.parts, undefined);
    assert.deepEqual(b.composition, []);
    assert.deepEqual(b.unplaced, []);
    assert.deepEqual(b.sources.map((s) => s.slot), ['tree'], 'single sources stay in the record');
    assert.deepEqual(b.parts?.composition.map((p) => [p.kind, p.rows]), [
      ['case', a.composition.filter((r) => r.kind === 'case').length],
      ['definition', 4],
    ]);
    assert.equal(b.parts?.unplaced[0].rows, 1);
    assert.equal(b.parts?.sources[0].rows, 6);
    assert.deepEqual(b.kinds, a.kinds);
    assert.deepEqual(b.counts, a.counts);

    const root = one.root as string;
    const reader = (w: World, role: PermissionRole = 'user') => ({ user: w.user.id, role });
    // The one layout-dependent field is applicability_context.composition: a contribution is admitted against the
    // record that actually holds the entry, and the inline and parted records are different compositions of the same
    // tree. Everything else in the answers must be layout-independent.
    const strip = (page: NonNullable<Awaited<ReturnType<World['knowledge']['getNodes']>>>) => ({...page,nodes:page.nodes.map(node=>({...node,entries:node.entries.map(entry=>({...entry,...(entry.applicability_context?{applicability_context:{...entry.applicability_context,composition:'<record>'}}:{})}))}))});
    for (const path of ['/commands/system/reboot', '/commands/net/ping', '/']) {
      const x = await inline.knowledge.getNodes({ root, paths: [path], depth: 1 }, inline.user);
      const y = await parted.knowledge.getNodes({ root, paths: [path], depth: 1 }, parted.user);
      assert.ok(x !== null && y !== null, path);
      assert.deepEqual(strip(y), strip(x), path);
      for(const [page,composition] of [[x,one.composition],[y,split.composition]] as const)
        for(const node of page.nodes)for(const entry of node.entries){assert.ok(entry.applicability_context,'fresh entries retain their admission context');assert.equal(entry.applicability_context.composition,composition,'admission cites the actual layout record');}
    }
    const node = (await parted.knowledge.getNodes({ root, paths: ['/commands/system/reboot'], depth: 0 }, parted.user))?.nodes[0];
    const kase = node?.entries.find((e) => e.kind === 'case');
    assert.ok(kase);
    for (const w of [inline, parted]) {
      const resolved = await resolveReference(kase.reference, { reader: reader(w), parsers: createDefaultRegistry(), trees: w.knowledge.treeReader() });
      assert.equal(resolved.resolved, true);
      if (!resolved.resolved) continue;
      assert.equal(resolved.grounds.length, 1);
      assert.match(resolved.grounds[0], /^src:[0-9a-f]{64}\/kityminder@1\/n\/d\d-c\d$/);
      const provenance = await w.knowledge.provenanceOf(kase.reference, w.admin);
      assert.equal(provenance?.[0].sources.length, 1);
      assert.match(provenance?.[0].sources[0].external ?? '', /^store:mindmap:d\d$/);
      const catalog = await w.knowledge.catalog(root, 'catalog@1');
      assert.equal(catalog?.size, 4);
    }
    // Unplaced rows read back from their part.
    const views = await Promise.all([inline, parted].map(async (w) => (await w.knowledge.store.composition(w === inline ? (one.composition as string) : (split.composition as string)))?.unplaced.length));
    assert.deepEqual(views, [1, 0]);
  });

  test('parts are content-addressed: a second production of equal content writes no part again', async (t) => {
    const w = await world(t, [DEFAULT_PRODUCERS[0], casesProducer({ batch: 4 })], { knowledge: { limits: { inlineRows: 2 } } });
    const ids = documents(w, 6, 3);
    const first = await w.knowledge.produceTree({ product: w.product, build: build('Rel_ACME_1_2_15', ids) });
    const rows = await countSchema(w, SCHEMAS.rowsPart);
    const sources = await countSchema(w, SCHEMAS.sourcesPart);
    assert.equal(rows, 2, 'the cases and the definitions');
    assert.equal(sources, 1);
    const second = await w.knowledge.produceTree({ product: w.product, build: build('Rel_ACME_1_2_15', ids) });
    assert.equal(second.root, first.root);
    assert.notEqual(second.composition, first.composition, 'a new composition record');
    assert.equal(await countSchema(w, SCHEMAS.rowsPart), 2, 'its parts are the stored ones');
    assert.equal(await countSchema(w, SCHEMAS.sourcesPart), 1);
    const [x, y] = [await body(w, first.composition), await body(w, second.composition)];
    assert.deepEqual(y.parts, x.parts);
  });
});

test('a current build remains in the producer inventory and a changed inventory invalidates memoized output',async t=>{
 const functionSource=`export default input=>({entries:(input.lists.cases??[]).flatMap(doc=>doc.model.nodes.filter(node=>Array.isArray(node.data.resource)).map(node=>({kind:'case',path:'/commands/system/reboot',statement:node.text,data:{known_builds:input.known_builds},fragments:[{slot:'cases',source:doc.sha256,parser:'kityminder@1',selector:node.selector}],applicability:null}))),warnings:[]});`;
 const w=await world(t,[DEFAULT_PRODUCERS[0],casesProducer({batch:2})],{pack:{functions:{'cases.ts':functionSource}}});
 const ids=documents(w,1),current=build('Rel_ACME_1_2_15',ids);
 // The frozen known-build inventory is the production's declared plan list (K01 R[1]: same sources give the same
 // bytes, so a build record this production writes never changes its own inputs); the self build is part of it.
 const plan=[current.name];
 const first=await w.knowledge.produceTree({product:w.product,build:current,planBuilds:plan});assert.equal(first.ok,true,first.reason??'');
 const read=await w.knowledge.getNodes({root:first.root!,paths:['/commands/system/reboot'],depth:0},w.admin);
 const entry=read?.nodes.flatMap(node=>node.entries).find(entry=>entry.kind==='case');assert.ok(entry);
 assert.ok((entry.data?.known_builds as string[]).includes(current.name),'the produced build is part of the frozen inventory');
 const again=await w.knowledge.produceTree({product:w.product,build:current,planBuilds:plan});assert.equal(again.calls.reused,1);
 await new Builds(w.knowledge.__context).record('acme',{id:w.product.id,version:w.product.version,digest:w.product.digest},build('Rel_ACME_10_8_1_901',[]),null,null);
 // A build registered outside the plan changes no declared input: the memoized output stays valid (K01). Only a
 // changed plan (a new listed build) is a changed input and invalidates the memo.
 const unchanged=await w.knowledge.produceTree({product:w.product,build:current,planBuilds:plan});assert.equal(unchanged.ok,true,unchanged.reason??'');assert.equal(unchanged.calls.reused,1);assert.equal(unchanged.root,again.root);
 const nextPlan=[current.name,'Rel_ACME_10_8_1_901'];
 const changed=await w.knowledge.produceTree({product:w.product,build:current,planBuilds:nextPlan});assert.equal(changed.ok,true,changed.reason??'');assert.equal(changed.calls.reused,0);assert.notEqual(changed.root,again.root);
});

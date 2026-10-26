import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { BASE_CATALOG, DEFAULT_PRODUCERS, casesProducer, catalogXml, makeWorld, mindMap, startPostgres } from './test-support.ts';
import { createKnowledgeReader } from './api.ts';
let postgres: Awaited<ReturnType<typeof startPostgres>>;
before(async () => { postgres = await startPostgres(); });
after(async () => { await postgres?.stop(); });
const build = (n: number, docs: string[]) => ({ name: `Rel_ACME_10_6_1_${n}`, family: 'ACME', line: '10.6.1', base: `Rel_ACME_10_6_1_${n}`, platform: null, built_at: null, released_at: null, root: null, sources: { tree: 'site:tree:synthetic', cases: docs } });
async function json(w: any, id: string) { const read = await createKnowledgeReader(w.knowledge).read(id, { principal: w.user, run: null, purpose: 'synthetic scope' }); assert.equal(read.ok, true, JSON.stringify(read)); const source = await w.kit.artifacts.source(w.user, read.artifacts[0].artifact.body.sha256, { consumer: 'function' }); return JSON.parse(Buffer.from(source.bytes).toString()); }
async function rows(w: any, collection: any) { const out: any[] = []; for (const part of collection.parts) {
    const source = await w.kit.artifacts.source(w.user, part.sha256, { consumer: 'function' });
    assert.ok(source?.bytes);
    out.push(...JSON.parse(Buffer.from(source.bytes).toString()));
} assert.equal(out.length, collection.total); return out; }
test('scope distinguishes omitted sources from sources covered by an explicitly declared additional root', async (t) => {
    let additional: readonly {
        root: string;
        composition: string;
    }[] = [];
    const w = await makeWorld(postgres, { pack: { declaration: { producers: [...DEFAULT_PRODUCERS, casesProducer({ optional: true })] } }, knowledge: { additionalScopeRoots: async () => additional } as any });
    t.after(() => w.close());
    w.external.set('site:tree:synthetic', { bytes: catalogXml(BASE_CATALOG), mediaType: 'application/xml' });
    const docs = ['store:mindmap:missing', 'store:mindmap:elsewhere'];
    const a = await w.knowledge.produceTree({ product: w.product, build: build(71, docs) });
    assert.equal(a.ok, true, a.reason ?? '');
    w.external.set(docs[1], { bytes: mindMap({ id: 'elsewhere' }, [{ id: 'case', text: 'synthetic no catalog command' }]), mediaType: 'application/json' });
    const b = await w.knowledge.produceTree({ product: w.product, build: build(72, [docs[1]]) });
    assert.equal(b.ok, true, b.reason ?? '');
    additional = [{ root: b.root!, composition: b.composition! }];
    const view = await json(w, 'knowledge:index:acme:Rel_ACME_10_6_1_71?kind=case&key=document');
    assert.ok(view.scope);
    assert.equal(view.scope.complete, true);
    assert.equal(view.scope.listed_documents.total, 1);
    assert.deepEqual((await rows(w, view.scope.omitted_documents)).map(row => row.external), [docs[0]]);
    assert.deepEqual((await rows(w, view.scope.elsewhere_documents)).map(row => row.external), [docs[1]]);
    assert.equal(view.scope.unplaced_entries, 0, 'the main build has no cases; the extra root is only an omission check');
    const impact = await json(w, 'knowledge:impact:acme:Rel_ACME_10_6_1_71..Rel_ACME_10_6_1_72?changed=definition');
    assert.deepEqual(impact.scope.unplaced_cases, { from: 0, to: 1 });
});
test('missing extra-root configuration never turns pending source membership into a determined omission', async (t) => {
    const w = await makeWorld(postgres, { pack: { declaration: { producers: [...DEFAULT_PRODUCERS, casesProducer({ optional: true })] } } });
    t.after(() => w.close());
    w.external.set('site:tree:synthetic', { bytes: catalogXml(BASE_CATALOG), mediaType: 'application/xml' });
    const result = await w.knowledge.produceTree({ product: w.product, build: build(71, ['store:mindmap:missing']) });
    assert.equal(result.ok, true, result.reason ?? '');
    const view = await json(w, 'knowledge:index:acme:Rel_ACME_10_6_1_71?kind=case&key=document');
    assert.ok(view.scope);
    assert.equal(view.scope.omitted_documents, null);
    assert.equal(view.scope.pending_documents.total, 1);
    assert.equal(view.scope.complete, false);
    assert.ok(view.scope.request.reference);
    assert.equal(view.scope.request.audience_user, w.admin.id);
});
test('a named build keeps its own unplaced membership when another build has the same placed root', async (t) => {
    const w = await makeWorld(postgres, { pack: { declaration: { producers: [...DEFAULT_PRODUCERS, casesProducer()] } } });
    t.after(() => w.close());
    w.external.set('site:tree:synthetic', { bytes: catalogXml(BASE_CATALOG), mediaType: 'application/xml' });
    const result = [];
    for (const n of [71, 72]) {
        const id = `store:mindmap:doc-${n}`;
        w.external.set(id, { bytes: mindMap({ id: `doc-${n}` }, [{ id: 'case', text: `synthetic unplaced case ${n}` }]), mediaType: 'application/json' });
        result.push(await w.knowledge.produceTree({ product: w.product, build: build(n, [id]) }));
    }
    assert.equal(result[0].root, result[1].root);
    const view = await json(w, 'knowledge:index:acme:Rel_ACME_10_6_1_71?kind=case&key=document');
    assert.deepEqual(Object.keys(view.keys), ['doc-71']);
    assert.equal(view.scope.unplaced_entries, 1);
});

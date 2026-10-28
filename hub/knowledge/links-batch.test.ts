import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LINK_MATCH, NODE_LEVEL } from '../../contracts/generated/vocabulary.ts';
import { LinkDeclaration } from '../../contracts/src/product.ts';
import type { TreeNodeBody } from '../../contracts/src/knowledge.ts';
import type { CompositionView } from './composition.ts';
import type { KnowledgeContext } from './context.ts';
import type { Builds } from './builds.ts';
import { LinkReading } from './links.ts';
import { KnowledgeStore } from './store.ts';
import { nodeDigest } from './digest.ts';
import { IntegrityError, type RecordStore, type StoredRecord } from '../records/api.ts';
import type { KnownBuild } from '../../contracts/src/product.ts';
import { catalogXml, extraProducer, makeWorld, startPostgres } from './test-support.ts';

const digest = (n: number): string => n.toString(16).padStart(64, '0');

test('relations over a large synthetic tree use bounded batches and preserve exact links', async () => {
  const count = 10_000;
  const root = digest(90_000), commands = digest(90_001), notes = digest(90_002), noteEntry = digest(90_003);
  const nodes = new Map<string, TreeNodeBody>();
  const children = Array.from({ length: count }, (_, i) => ({ name: `cmd${String(i).padStart(5, '0')}`, digest: digest(i + 1) }));
  nodes.set(root, { name: '', level: NODE_LEVEL[0], height: 2, entries: [], children: [{ name: 'commands', digest: commands }, { name: 'notes', digest: notes }] });
  nodes.set(commands, { name: 'commands', level: NODE_LEVEL[1], height: 1, entries: [], children });
  nodes.set(notes, { name: 'notes', level: NODE_LEVEL[2], height: 0, entries: [noteEntry], children: [] });
  for (let i = 0; i < count; i++) nodes.set(children[i]!.digest, { name: children[i]!.name, level: NODE_LEVEL[2], height: 0, entries: [digest(20_000 + i)], children: [] });

  let singleReads = 0, batchReads = 0;
  const store = {
    async node(id: string) { singleReads++; return nodes.get(id) ?? null; },
    async nodes(ids: readonly string[]) { batchReads++; return new Map(ids.flatMap(id => nodes.has(id) ? [[id, nodes.get(id)!] as const] : [])); },
    async entry() { throw new Error('all synthetic entries are present in the composition'); },
    async entries() { throw new Error('all synthetic entries are present in the composition'); },
  };
  const rule = LinkDeclaration.parse({ id: 'mentions', field: 'mentions', namespace: '/commands', match: LINK_MATCH[0], entry_kind: 'definition' });
  const missingRule = LinkDeclaration.parse({ id: 'missing-rule', field: 'unavailable', namespace: '/absent', match: LINK_MATCH[0], entry_kind: 'definition' });
  const composition = {
    record: digest(99_999), body: { root, links: [rule, missingRule] },
    async *contentRows() {
      for (let i = 0; i < count; i++) yield { path: `/commands/${children[i]!.name}`, entry: digest(20_000 + i), producers: ['synthetic'], content: { kind: 'definition', statement: 'Synthetic command', data: i === 0 ? { unavailable: ['first'] } : {}, applicability: null } };
      yield { path: '/notes', entry: noteEntry, producers: ['synthetic'], content: { kind: 'behaviour', statement: 'Synthetic note', data: { mentions: ['cmd09999'], unavailable: ['second'] }, applicability: null } };
    },
    async *unplacedRows() {},
  } as unknown as CompositionView;
  const reader = new LinkReading({ store } as unknown as KnowledgeContext, {} as Builds);
  const result = await reader.facts(composition);
  assert.equal(result.links.length, 1);
  assert.equal(result.links[0]!.target, '/commands/cmd09999');
  assert.equal(result.drift.length, 0);
  assert.deepEqual(result.unchecked.map(item => item.path), ['/commands/cmd00000', '/notes']);
  assert.ok(singleReads <= 2, `individual node reads ${singleReads}`);
  assert.ok(batchReads > 0 && batchReads <= Math.ceil(count / 128) + 4, `batch reads ${batchReads}`);
});

test('batched node reads keep missing records absent and reject a mismatched node digest', async () => {
  const records = new Map<string, StoredRecord<unknown>>();
  for (let i = 0; i < 129; i++) {
    const body: TreeNodeBody = { name: `node${i}`, level: NODE_LEVEL[2], height: 0, entries: [], children: [] };
    records.set(nodeDigest(body), { id: 'synthetic', kind: 'tree_node', schema: 'tree_node@1', digest: digest(i + 1), provenance: 'projected', created_at: '2026-10-29T00:00:00Z', body });
  }
  const ids = [...records.keys()];
  const absent = digest(900_000), corrupt = digest(900_001);
  records.set(corrupt, { ...records.get(ids[0]!)!, digest: digest(900_002) });
  let batches = 0;
  const backing = {
    async findFirstMany(query: { values: readonly string[] }) {
      batches++;
      return new Map(query.values.flatMap(id => records.has(id) ? [[id, records.get(id)!] as const] : []));
    },
  } as unknown as RecordStore;
  const store = new KnowledgeStore(backing);
  const found = await store.nodes([...ids, ids[0]!, absent]);
  assert.equal(found.size, 129);
  assert.equal(found.has(absent), false);
  assert.equal(batches, 2);
  await assert.rejects(store.nodes([corrupt]), IntegrityError);
});

test('a shared node digest is visited at each distinct path', async () => {
  const root=digest(1),a=digest(2),b=digest(3),shared=digest(4),note=digest(5),entry=digest(6),noteEntry=digest(7);
  const nodes=new Map<string,TreeNodeBody>([
    [root,{name:'',level:NODE_LEVEL[0],height:2,entries:[],children:[{name:'a',digest:a},{name:'b',digest:b},{name:'notes',digest:note}]}],
    [a,{name:'a',level:NODE_LEVEL[1],height:1,entries:[],children:[{name:'shared',digest:shared}]}],
    [b,{name:'b',level:NODE_LEVEL[1],height:1,entries:[],children:[{name:'shared',digest:shared}]}],
    [shared,{name:'shared',level:NODE_LEVEL[2],height:0,entries:[entry],children:[]}],
    [note,{name:'notes',level:NODE_LEVEL[2],height:0,entries:[noteEntry],children:[]}],
  ]);
  const rules=['a','b'].map(name=>LinkDeclaration.parse({id:name,field:'mentions',namespace:`/${name}`,match:LINK_MATCH[0],entry_kind:'definition'}));
  const composition={record:digest(8),body:{root,links:rules},async *contentRows(){
    yield {path:'/a/shared',entry,producers:['synthetic'],content:{kind:'definition',statement:'Shared',data:{},applicability:null}};
    yield {path:'/b/shared',entry,producers:['synthetic'],content:{kind:'definition',statement:'Shared',data:{},applicability:null}};
    yield {path:'/notes',entry:noteEntry,producers:['synthetic'],content:{kind:'behaviour',statement:'Note',data:{mentions:['shared']},applicability:null}};
  },async *unplacedRows(){}} as unknown as CompositionView;
  const store={async nodes(ids:readonly string[]){return new Map(ids.flatMap(id=>nodes.has(id)?[[id,nodes.get(id)!] as const]:[]));},async entries(){throw new Error('all entries are present');}};
  const result=await new LinkReading({store} as unknown as KnowledgeContext,{} as Builds).facts(composition);
  assert.deepEqual(result.links.map(link=>link.target).sort(),['/a/shared','/b/shared']);
});

test('a stored synthetic tree reads reverse links in batches with the real database', async t => {
  const pg = await startPostgres();
  let closeWorld = async (): Promise<void> => {};
  t.after(async () => { await closeWorld(); await pg.stop(); });
  const fragment = [{ parser: 'xml@1', selector: 'x/catalog' }];
  const entries = Array.from({ length: 1_000 }, (_, i) => ({ path: `/terms/cmd${String(i).padStart(4, '0')}`, kind: 'definition', statement: 'Synthetic command', data: {} as Record<string, unknown>, fragments: fragment, applicability: null }));
  entries.push({ path: '/notes/source', kind: 'behaviour', statement: 'Synthetic note', data: { mentions: ['cmd0999'] }, fragments: fragment, applicability: null });
  const rule = LinkDeclaration.parse({ id: 'mentions', field: 'mentions', namespace: '/terms', match: LINK_MATCH[0], entry_kind: 'definition' });
  const w = await makeWorld(pg, { pack: { id: 'measure', names: ['MEASURE'], declaration: { catalogs: [], links: [rule], producers: [extraProducer('entities', { entries })] } } });
  closeWorld = () => w.close();
  w.external.set('site:tree:synthetic', { bytes: catalogXml({ sample: [{ name: 'node' }] }), mediaType: 'application/xml' });
  const build: KnownBuild = { name: 'Rel_MEASURE_10_8_1_1', family: 'MEASURE', line: '10.8.1', base: 'Rel_MEASURE_10_8_1_1', platform: null, built_at: null, released_at: null, sources: { tree: 'site:tree:synthetic' }, root: null };
  const produced = await w.knowledge.produceTree({ product: w.product, build });
  assert.ok(produced.ok, produced.reason ?? '');
  let singleReads = 0, batchReads = 0;
  const one = w.knowledge.store.node.bind(w.knowledge.store), many = w.knowledge.store.nodes.bind(w.knowledge.store);
  t.mock.method(w.knowledge.store, 'node', async (...args: Parameters<typeof one>) => { singleReads++; return one(...args); });
  t.mock.method(w.knowledge.store, 'nodes', async (...args: Parameters<typeof many>) => { batchReads++; return many(...args); });
  const page = await w.knowledge.getNodes({ root: produced.root!, composition: produced.composition!, paths: ['/terms/cmd0999'], depth: 0 }, w.admin);
  assert.ok(page);
  assert.equal(page.nodes[0]?.backlinks?.total, 1);
  assert.ok(singleReads < 10, `individual reads ${singleReads}`);
  assert.ok(batchReads > 0 && batchReads < 20, `batch reads ${batchReads}`);
});

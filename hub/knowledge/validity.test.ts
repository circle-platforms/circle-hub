// The machine-checkable validity of a claim at read time (B01 R[2], K03 R[5], K05 R[4]). Reading a tree entry
// computes: rule_withdrawn (the deciding pack version is unpublished), cited_fragment_changed (the CITED root X and
// the READER's root Y differ and Y's entry at the same path differs or is absent — the same root never flags, roots
// are content-addressed), contradicted (a contradiction relation this reader may see: their own candidate relations
// and the Hub's deterministic ones; someone else's private candidate relation never flags another reader, an admin
// included). Every condition that holds is listed with its source; the status is the first in the fixed order
// rule_withdrawn > cited_fragment_changed > contradicted. One findMany fetches every entry's relations per read
// (the query count never grows with the entry count); pack lookups are cached per read.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { KnownBuild } from '../../contracts/src/product.ts';
import { BASE_CATALOG, catalogXml, makeWorld, startPostgres, type World } from './test-support.ts';

let postgres: Awaited<ReturnType<typeof startPostgres>>;

before(async function beforeHook() {
  postgres = await startPostgres();
});
after(async function afterHook() {
  await postgres?.stop();
});

const build = (name: string): KnownBuild => ({
  name,
  family: 'ACME',
  line: '1.2',
  base: name,
  platform: null,
  built_at: '2026-01-02T10:00:00.000Z',
  released_at: '2026-01-05T00:00:00.000Z',
  sources: { tree: `site:tree:${name}` },
  root: null,
});

const PATH = '/commands/system/reboot';

/** A produced world with the first case entry of the reboot command. */
const produced = async (t: { after: (fn: () => Promise<void>) => void }): Promise<World & { root: string; entry: string; composition: string }> => {
  const w = await makeWorld(postgres);
  t.after(() => w.close());
  w.external.set('site:tree:Rel_ACME_1_2_15', { bytes: catalogXml(BASE_CATALOG), mediaType: 'application/xml' });
  const result = await w.knowledge.produceTree({ product: w.product, build: build('Rel_ACME_1_2_15') });
  assert.equal(result.ok, true, result.reason ?? '');
  const root = result.root as string;
  const production = await w.knowledge.store.latestProduction(w.product.product.id, 'Rel_ACME_1_2_15');
  await w.knowledge.moveRoot(w.product.product.id, '1.2', null, root, production!.record.digest, {by:w.admin});
  const node = (await w.knowledge.getNodes({ root, paths: [PATH], depth: 0 }, w.admin))?.nodes[0];
  const entry = node?.entries[0]?.entry as string | undefined;
  assert.ok(typeof entry === 'string', JSON.stringify(node).slice(0, 300));
  const read = await w.knowledge.treeReader().read(root, PATH, entry, { user: w.user.id, role: 'user' as const });
  const composition = (read!.validity as { compositions: Array<{ composition: string }> }).compositions[0]!.composition;
  return Object.assign(w, { root, entry, composition });
};

/** A second root whose reboot help text differs (a different entry digest at the same path). */
const editedRoot = async (w: World): Promise<string> => {
  const edited = {
    ...BASE_CATALOG,
    system: BASE_CATALOG.system.map((c: { name: string }) => (c.name === 'reboot' ? { ...c, help: '重新启动设备（措辞已改）' } : c)),
  };
  w.external.set('site:tree:Rel_ACME_1_2_16', { bytes: catalogXml(edited), mediaType: 'application/xml' });
  const second = await w.knowledge.produceTree({ product: w.product, build: build('Rel_ACME_1_2_16') });
  assert.equal(second.ok, true, second.reason ?? '');
  return second.root as string;
};

describe('cited_fragment_changed compares the cited root X with the reader\'s root Y (K03 R[5])', () => {
  test('the same root never flags (locked X, reading X stays valid)', async (t) => {
    const w = await produced(t);
    const locked = await w.knowledge.treeReader({ composition: w.composition });
    const read = await locked.read(w.root, PATH, w.entry, { user: w.user.id, role: 'user' as const });
    const validity = read!.validity as { status: string };
    assert.equal(validity.status, 'valid');
  });

  test('Y carries a different entry at the same path: changed, and both roots are written out', async (t) => {
    const w = await produced(t);
    const yRoot = await editedRoot(w);
    // The reader's lock names Y's composition; the reference cites X.
    const yRead = await w.knowledge.treeReader().read(yRoot, PATH, null, { user: w.user.id, role: 'user' as const });
    const yComposition = (yRead!.validity as { compositions: Array<{ composition: string }> }).compositions[0]!.composition;
    const locked = await w.knowledge.treeReader({ composition: yComposition });
    const read = await locked.read(w.root, PATH, w.entry, { user: w.user.id, role: 'user' as const });
    const validity = read!.validity as { status: string; cited_root?: string; reader_root?: string; conditions: Array<{ condition: string; source: string }> };
    assert.equal(validity.status, 'cited_fragment_changed', JSON.stringify(validity));
    assert.equal(validity.cited_root, w.root);
    assert.equal(validity.reader_root, yRoot);
    assert.ok(validity.conditions.some((c) => c.condition === 'cited_fragment_changed' && c.source.includes(w.root) && c.source.includes(yRoot)));
  });

  test('Y lacks the path: changed the same way', async (t) => {
    const w = await produced(t);
    // A shrunk tree in the SAME world (the reader may read it): no reboot command at all.
    const shrunk = { ...BASE_CATALOG, system: BASE_CATALOG.system.filter((c: { name: string }) => c.name !== 'reboot') };
    w.external.set('site:tree:Rel_ACME_1_2_17', { bytes: catalogXml(shrunk), mediaType: 'application/xml' });
    const produced2 = await w.knowledge.produceTree({ product: w.product, build: build('Rel_ACME_1_2_17') });
    assert.equal(produced2.ok, true, produced2.reason ?? '');
    const yRoot = produced2.root as string;
    // Y's composition from a path it does carry.
    const yRead = await w.knowledge.treeReader().read(yRoot, '/commands/system', null, { user: w.user.id, role: 'user' as const });
    const yComposition = (yRead!.validity as { compositions: Array<{ composition: string }> }).compositions[0]!.composition;
    const locked = await w.knowledge.treeReader({ composition: yComposition });
    const read = await locked.read(w.root, PATH, w.entry, { user: w.user.id, role: 'user' as const });
    const validity = read!.validity as { status: string };
    assert.equal(validity.status, 'cited_fragment_changed');
  });

  test('outside a run, the current pointer moved to Y: reading X flags changed with both roots and the holds-on-X note (K01 R[6])', async (t) => {
    const w = await produced(t);
    const yRoot = await editedRoot(w);
    // Outside a run there is no lock: the reader's root is the line's current-root pointer, which now names Y.
    const cause = (await w.knowledge.store.productionsOfRoot(yRoot))[0]!.record.digest;
    const moved = await w.knowledge.moveRoot(w.product.product.id, '1.2', w.root, yRoot, cause);
    assert.equal(moved.moved, true, JSON.stringify(moved).slice(0, 200));
    const read = await w.knowledge.treeReader().read(w.root, PATH, w.entry, { user: w.user.id, role: 'user' as const });
    const validity = read!.validity as { status: string; cited_root?: string; reader_root?: string; conditions: Array<{ condition: string; source: string }> };
    assert.equal(validity.status, 'cited_fragment_changed', JSON.stringify(validity));
    assert.equal(validity.cited_root, w.root);
    assert.equal(validity.reader_root, yRoot);
    const condition = validity.conditions.find((c) => c.condition === 'cited_fragment_changed')!;
    assert.match(condition.source, /仍成立/);
    assert.ok(condition.source.includes(w.root) && condition.source.includes(yRoot));
  });

  test('outside a run, the current pointer still names X: valid', async (t) => {
    const w = await produced(t);
    const read = await w.knowledge.treeReader().read(w.root, PATH, w.entry, { user: w.user.id, role: 'user' as const });
    const validity = read!.validity as { status: string };
    assert.equal(validity.status, 'valid');
  });
});

describe('contradictions respect the reader\'s visibility (K05 R[4])', () => {
  const putRelation = async (w: World & { root: string }, first: string, at: string, by: string, provenance: 'candidate' | 'observed'): Promise<void> => {
    await w.knowledge.store.records.put({
      kind: 'claim',
      schema: 'knowledge-candidate@1',
      provenance,
      body: { relation: 'contradicts', at, by, other: `tree:${w.root}${PATH}@${first}`, claim: `tree:${w.root}${PATH}@${first}` },
      index: [{ key: 'knowledge.claim.contradiction', value: first }],
    });
  };

  test('the relation\'s own reader sees contradicted; another reader and an admin see valid', async (t) => {
    const w = await produced(t);
    // A second READER of the product (not the outsider, who may not read at all).
    const second = await w.kit.principals.createUser(w.admin, '第二读者');
    w.packs.readers.set(second.id, new Set([w.product.product.id]));
    await putRelation(w, w.entry, '2026-10-23T14:00:00.000Z', w.user.id, 'candidate');
    const own = await w.knowledge.treeReader().read(w.root, PATH, w.entry, { user: w.user.id, role: 'user' as const });
    assert.equal((own!.validity as { status: string }).status, 'contradicted');
    const other = await w.knowledge.treeReader().read(w.root, PATH, w.entry, { user: second.id, role: 'user' as const });
    assert.equal((other!.validity as { status: string }).status, 'valid', 'another reader does not see a private relation');
    const admin = await w.knowledge.treeReader().read(w.root, PATH, w.entry, { user: w.admin.id, role: 'admin' as const });
    assert.equal((admin!.validity as { status: string }).status, 'valid', 'an admin does not see another user\'s private relation');
  });

  test('a Hub deterministic relation (observed) is visible to every reader', async (t) => {
    const w = await produced(t);
    await putRelation(w, w.entry, '2026-10-23T14:00:00.000Z', w.admin.id, 'observed');
    for (const who of [{ user: w.user.id, role: 'user' as const }, { user: w.admin.id, role: 'admin' as const }]) {
      const read = await w.knowledge.treeReader().read(w.root, PATH, w.entry, who);
      assert.equal((read!.validity as { status: string }).status, 'contradicted');
    }
  });
});

describe('the read stays efficient and the conditions are all listed', () => {
  test('many entries on one node: the relation query count does not grow with the entry count', async (t) => {
    const w = await produced(t);
    // Count findMany calls by wrapping the store's records port.
    let queries = 0;
    const records = w.knowledge.store.records as unknown as { findMany: (query: { key: string }) => Promise<unknown[]> };
    const realFindMany = records.findMany.bind(records);
    (w.knowledge.store as unknown as { records: { findMany: (query: { key: string }) => Promise<unknown[]> } }).records.findMany = async (query) => {
      if (query.key === 'knowledge.claim.contradiction') { queries += 1; console.log('QUERY', queries, new Error('where').stack?.split('\n')[2]?.trim()); }
      return realFindMany(query);
    };
    // Two entries at one path (a synthetic second composition row, the multi-producer shape): one node-level read
    // over both digests must fire ONE findMany — the query count never grows with the entry count.
    const read0 = await w.knowledge.treeReader().read(w.root, PATH, w.entry, { user: w.user.id, role: 'user' as const });
    const composition = (read0!.validity as { compositions: Array<{ composition: string }> }).compositions[0]!.composition;
    queries = 0; // read0's own query does not count; the read under test follows.
    const first = await w.knowledge.store.composition(composition);
    const row = first!.composition.find((r) => r.entry === w.entry)!;
    const secondRow = { ...row, entry: 'b'.repeat(64) };
    const multi = { ...first!, composition: [...first!.composition, secondRow].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.entry < b.entry ? -1 : 1)) };
    const record = await w.knowledge.store.putRoot(multi, undefined as never);
    await w.knowledge.store.records.put({
      kind: 'action',
      schema: 'action@1',
      provenance: 'observed',
      body: { action: 'generate', run: null, item: null, inputs: [], component: 'knowledge.produce', lease: null, started_at: '2026-10-23T14:10:00.000Z', ended_at: '2026-10-23T14:10:01.000Z', result: 'completed', error_code: null, acceptance: null, codes: [], detail: { sync: null, product: multi.product, pack: { id: multi.producer.pack, version: multi.producer.version, digest: multi.producer.digest }, build: multi.build, root: multi.root, composition: record.digest, sources: [], missing: [], lists: [], calls: { made: 0, reused: 0 }, placement: null, reason: null } },
      index: [
        { key: 'knowledge.produce.root', value: multi.root },
        { key: 'knowledge.produce', value: `${multi.product}/${multi.build!.name.toLowerCase()}` },
      ],
    });
    const read = await w.knowledge.treeReader().read(w.root, PATH, null, { user: w.user.id, role: 'user' as const });
    assert.ok(read !== null, 'the node reads');
    assert.equal(queries, 1, `one relation query for the node's entries`);
  });

  test('several conditions at once are all listed; the status follows the fixed order', async (t) => {
    const w = await produced(t);
    // rule_withdrawn + contradicted together: status is rule_withdrawn, both conditions listed with sources.
    const read0 = await w.knowledge.treeReader().read(w.root, PATH, w.entry, { user: w.user.id, role: 'user' as const });
    const composition = (read0!.validity as { compositions: Array<{ composition: string }> }).compositions[0]!.composition;
    const rows = await w.knowledge.store.composition(composition);
    const decidedBy = rows!.composition.find((row) => row.entry === w.entry)!.decided_by;
    const [id, version] = decidedBy.split('@');
    w.packs.withdraw(id!, version!);
    await w.knowledge.store.records.put({
      kind: 'claim',
      schema: 'knowledge-candidate@1',
      provenance: 'observed',
      body: { relation: 'contradicts', at: '2026-10-23T14:00:00.000Z', by: w.admin.id, other: `tree:${w.root}${PATH}@${w.entry}`, claim: `tree:${w.root}${PATH}@${w.entry}` },
      index: [{ key: 'knowledge.claim.contradiction', value: w.entry }],
    });
    const read = await w.knowledge.treeReader().read(w.root, PATH, w.entry, { user: w.user.id, role: 'user' as const });
    const validity = read!.validity as { status: string; conditions: Array<{ condition: string; source: string }>; contradictions: unknown[] };
    assert.equal(validity.status, 'rule_withdrawn', 'the fixed order: rule_withdrawn wins');
    assert.ok(validity.conditions.some((c) => c.condition === 'rule_withdrawn' && c.source === decidedBy), JSON.stringify(validity.conditions));
    assert.ok(validity.conditions.some((c) => c.condition === 'contradicted'), JSON.stringify(validity.conditions));
    assert.ok(validity.contradictions.length >= 1, 'the contradiction rides along with its source');
  });
});

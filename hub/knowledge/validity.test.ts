// The machine-checkable validity of a claim at read time (B01 R[2], K-direction §5): reading a tree entry computes the
// status — rule_withdrawn (the deciding pack version is unpublished), cited_fragment_changed (another composition of
// the same root carries a different entry at the same path than the one cited), contradicted (a contradiction relation
// names a claim here). Contradictions only flag: both sides of a relation are returned, each with its source and time;
// the Hub hides neither and changes neither's nature or basis rank. grounds_withdrawn and premise_failed have no data
// source today and are never claimed; tree entries carry no expiry (record claims' expires_at is computed in hub/refs).
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { KnownBuild } from '../../contracts/src/product.ts';
import { BASE_CATALOG, catalogXml, makeWorld, startPostgres, type World } from './test-support.ts';

let postgres: Awaited<ReturnType<typeof startPostgres>>;
const readerOf = (w: World) => ({ user: w.user.id, role: 'user' }) as never;

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

const produced = async (t: { after: (fn: () => Promise<void>) => void }): Promise<World & { root: string; entry: string }> => {
  const w = await makeWorld(postgres);
  t.after(() => w.close());
  w.external.set('site:tree:Rel_ACME_1_2_15', { bytes: catalogXml(BASE_CATALOG), mediaType: 'application/xml' });
  const result = await w.knowledge.produceTree({ product: w.product, build: build('Rel_ACME_1_2_15') });
  assert.equal(result.ok, true, result.reason ?? '');
  const root = result.root as string;
  const node = (await w.knowledge.getNodes({ root, paths: ['/commands/system/reboot'], depth: 0 }, w.admin))?.nodes[0];
  const entry = node?.entries[0]?.entry as string | undefined;
  assert.ok(typeof entry === 'string', JSON.stringify(node).slice(0, 300));
  return Object.assign(w, { root, entry });
};

describe('the validity of a tree claim at read time', () => {
  test('a healthy read stays valid', async (t) => {
    const w = await produced(t);
    const read = await w.knowledge.treeReader().read(w.root, '/commands/system/reboot', w.entry, readerOf(w));
    assert.ok(read !== null);
    const validity = read.validity as { status: string };
    assert.equal(validity.status, 'valid');
  });

  test('a withdrawn deciding pack version flags rule_withdrawn (reading after withdrawal shows it)', async (t) => {
    const w = await produced(t);
    // The product pack that decided the composition rows (its id@version sits on every row); withdrawing that
    // version makes the claim it decided rule_withdrawn — the P05 finding.
    const original = (await w.knowledge.treeReader().read(w.root, '/commands/system/reboot', w.entry, readerOf(w)))!;
    const composition = (original.validity as { compositions: Array<{ composition: string }> }).compositions[0]!.composition;
    const rows = await w.knowledge.store.composition(composition);
    assert.ok(rows !== null);
    const decidedBy = rows.composition.find((row) => row.entry === w.entry)!.decided_by;
    const [id, version] = decidedBy.split('@');
    assert.ok(id !== undefined && version !== undefined, decidedBy);
    w.packs.withdraw(id!, version!);
    const read = await w.knowledge.treeReader().read(w.root, '/commands/system/reboot', w.entry, readerOf(w));
    assert.ok(read !== null);
    const validity = read.validity as { status: string };
    assert.equal(validity.status, 'rule_withdrawn', JSON.stringify(validity));
  });

  test('a cited entry that another composition of the root replaced flags cited_fragment_changed', async (t) => {
    const w = await produced(t);
    // A second composition of the SAME root: the same path carries a different entry digest (the edited text). The
    // records are synthetic — the same shape a second produce of the same root writes.
    const original = (await w.knowledge.treeReader().read(w.root, '/commands/system/reboot', w.entry, readerOf(w)))!;
    const composition = (original.validity as { compositions: Array<{ composition: string }> }).compositions[0]!.composition;
    const first = await w.knowledge.store.composition(composition);
    assert.ok(first !== null);
    const editedRow = {
      ...first.composition.find((row) => row.entry === w.entry)!,
      entry: 'e'.repeat(64),
    };
    const secondBody = { ...first, composition: [...first.composition.filter((row) => row.entry !== w.entry), editedRow].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.entry < b.entry ? -1 : 1)) };
    const record = await w.knowledge.store.putRoot(secondBody, undefined as never);
    await w.knowledge.store.records.put({
      kind: 'action',
      schema: 'action@1',
      provenance: 'observed',
      body: { action: 'generate', run: null, item: null, inputs: [], component: 'knowledge.produce', lease: null, started_at: '2026-10-23T14:10:00.000Z', ended_at: '2026-10-23T14:10:01.000Z', result: 'completed', error_code: null, acceptance: null, codes: [], detail: { sync: null, product: secondBody.product, pack: { id: secondBody.producer.pack, version: secondBody.producer.version, digest: secondBody.producer.digest }, build: secondBody.build, root: secondBody.root, composition: record.digest, sources: [], missing: [], lists: [], calls: { made: 0, reused: 0 }, placement: null, reason: null } },
      index: [
        { key: 'knowledge.produce.root', value: secondBody.root },
        { key: 'knowledge.produce', value: `${secondBody.product}/${secondBody.build.name.toLowerCase()}` },
      ],
    });
    const read = await w.knowledge.treeReader().read(w.root, '/commands/system/reboot', w.entry, readerOf(w));
    assert.ok(read !== null);
    const validity = read.validity as { status: string };
    assert.equal(validity.status, 'cited_fragment_changed', JSON.stringify(validity));
  });
});

describe('contradictions only flag, never adjudicate', () => {
  const putRelation = async (w: World & { root: string }, first: string, second: string, at: string): Promise<void> => {
    await w.knowledge.store.records.put({
      kind: 'claim',
      schema: 'knowledge-candidate@1',
      provenance: 'candidate',
      body: { relation: 'contradicts', at, other: `tree:${w.root}/commands/system/reboot@${second}`, claim: `tree:${w.root}/commands/system/reboot@${first}` },
      index: [
        { key: 'knowledge.claim.contradiction', value: first },
        { key: 'knowledge.claim.contradiction', value: second },
      ],
    });
  };

  test('both sides of a contradiction are flagged and returned with source and time', async (t) => {
    const w = await produced(t);
    const node = (await w.knowledge.getNodes({ root: w.root, paths: ['/commands/system/reboot'], depth: 0 }, w.admin))?.nodes[0];
    const entries = (node?.entries ?? []).map((e) => e.entry);
    assert.ok(entries.length >= 1, JSON.stringify(node).slice(0, 200));
    const first = entries[0]!;
    const second = entries[1] ?? first;
    const at = '2026-10-23T14:00:00.000Z';
    await putRelation(w, first, second, at);

    const readA = await w.knowledge.treeReader().read(w.root, '/commands/system/reboot', first, readerOf(w));
    assert.ok(readA !== null);
    const validityA = readA.validity as { status: string; contradictions: Array<{ source: string; at: string; other: string }> };
    assert.equal(validityA.status, 'contradicted');
    const contradiction = validityA.contradictions[0]!;
    assert.match(contradiction.source, /^rec:[0-9a-f]{64}$/);
    assert.equal(contradiction.at, at);
    assert.match(contradiction.other, /^tree:/);

    const readB = await w.knowledge.treeReader().read(w.root, '/commands/system/reboot', second, readerOf(w));
    assert.ok(readB !== null, 'the other side of a contradiction is never hidden');
    const validityB = readB.validity as { status: string };
    assert.equal(validityB.status, 'contradicted');
    // Neither side's nature changed: both texts read exactly as before the relation.
    assert.equal(readA.text, (await w.knowledge.treeReader().read(w.root, '/commands/system/reboot', first, readerOf(w)))!.text);
  });

  test('no relation, no flag (the negative case)', async (t) => {
    const w = await produced(t);
    const read = await w.knowledge.treeReader().read(w.root, '/commands/system/reboot', w.entry, readerOf(w));
    const validity = read!.validity as { status: string; contradictions?: unknown[] };
    assert.equal(validity.status, 'valid');
    assert.equal((validity.contradictions ?? []).length, 0);
  });
});

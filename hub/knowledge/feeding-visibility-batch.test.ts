// Batched feeding visibility (perf-n-plus-one). A frozen cut, a node page, a run's usages and the views over them must answer
// exactly what the per-record checks answer: the reference is the same feeding layer over a store without the batched index
// scan, which takes the record-by-record path. The single-key lookups must not grow with the feeding history.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import pg from 'pg';
import { runRecord } from '../../contracts/src/fixtures.ts';
import { RunRecord } from '../../contracts/src/run.ts';
import { newId, type Principal, type RecordStore } from '../records/api.ts';
import { putRun } from '../runs/engine/store.ts';
import { createKnowledge, createKnowledgeReader, FeedingLayer } from './api.ts';
import type { FeedingCut } from './feeding-types.ts';
import { TreeReading } from './read.ts';
import { startPostgres } from './test-support.ts';
import { world } from './testing/feeding-bounds-fixture.ts';

type World = Awaited<ReturnType<typeof world>>;
const TREE = '<commands><menu name="system"><item name="show"><arguments/></item></menu></commands>';
const BUILD = 'Rel_FAMX-zx-u_10_8_1_1';

/** A fed mind map in the agile structure the product's feeding projection reads; `title` replaces the first case title. */
function documentBytes(d: number, title?: string): Buffer {
  return Buffer.from(JSON.stringify({ agile: { id: `SYN-DOC-${d}` }, root: { data: { id: 'root', text: 'Synthetic zx-u 10.8' }, children: Array.from({ length: 40 }, (_, i) => ({
    data: { id: `case-${i}`, autoid: `SYN-${d}-${i}`, text: i === 0 && title !== undefined ? title : `Synthetic case ${d}-${i}`, priority: 2, resource: [i % 7 === 0 ? 'negative' : 'functional'] },
    children: [{ data: { id: `step-${i}`, text: 'system show' }, children: [{ data: { id: `expect-${i}`, text: `Synthetic expected ${d}-${i}` } }] }],
  })) } }));
}

/** Ingests one fed document and its directory metadata as reads of the same external object, readable by `readers`. */
async function document(w: World, d: number, readers: readonly string[], title?: string) {
  const visibility = { readers: [...readers], admins: true, packs: [], shareable: false };
  const external = `agile:mindmap:SYN-DOC-${d}`;
  const original = await w.kit.artifacts.ingest({ bytes: documentBytes(d, title), mediaType: 'application/json', origin: { read: { object: external } }, author: { user: null }, provenanceType: 'observed', visibility, readTier: 'model_readable' });
  const meta = await w.kit.artifacts.ingest({ bytes: Buffer.from(JSON.stringify({ id: `SYN-DOC-${d}`, title: `Synthetic doc ${d}`, ancestors: ['rel_famx_10_8'], root: { id: 'synthetic-root', title: 'FAMX' } })), mediaType: 'application/json', origin: { read: { object: external } }, author: { user: null }, provenanceType: 'observed', visibility, readTier: 'model_readable' });
  return { original, meta };
}

/** One run of `runner` that reads every given document once: an object, a binding and a usage record per case. */
async function readAll(w: World, runner: Principal, documents: ReadonlyArray<Awaited<ReturnType<typeof document>>>): Promise<string> {
  const run = newId('run');
  await putRun(w.kit.store, RunRecord.parse({ ...runRecord, run, runner: runner.id, product: 'famx' }), new Date().toISOString());
  for (const { original, meta } of documents) {
    const receipt = await w.knowledge.feeding!.observeSource(runner, original.body.sha256, { ...w.scope, sourceRecord: original.digest, metaSource: meta.body.sha256, run });
    assert.equal(receipt.objects.length, 40, JSON.stringify(receipt.pending));
  }
  return run;
}

/** The same feeding layer over a store without the batched index scan: every record is read and checked on its own. */
function recordByRecord(w: World): FeedingLayer {
  const context = w.knowledge.__context;
  const plain = new Proxy(context.records.store, { get(target, key) { if (key === 'findIndexed') return undefined; const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value; } }) as RecordStore;
  const records = { ...context.records, store: plain };
  const legacy = { ...context, records };
  return new FeedingLayer(legacy, new TreeReading(legacy));
}

const contents = (cut: FeedingCut | null) => {
  if (cut === null) return null;
  const { offset: _offset, ...rest } = cut;
  return rest;
};

/** The node relevance of entriesAtNodes for the root page. */
const atRoot = (root: string) => (body: Record<string, any>) => body.root === root && (body.path === '/' || body.path === null || Array.isArray(body.commands) && body.commands.some((command: any) => command?.path === '/'));

/** SQL executions by statement while `body` runs. */
async function counted<T>(body: () => Promise<T>): Promise<{ value: T; total: number; single: number }> {
  const original = pg.Client.prototype.query;
  let total = 0, single = 0;
  pg.Client.prototype.query = function (this: pg.Client, ...args: unknown[]) {
    const text = typeof args[0] === 'string' ? args[0] : String((args[0] as { text?: string })?.text ?? '');
    total++;
    // One record by digest, or one index value: the statements an N+1 loop issues.
    if (/WHERE digest = \$1/.test(text) || /i\.key = \$1 AND i\.value = \$2/.test(text)) single++;
    return Reflect.apply(original, this, args);
  } as typeof original;
  try { return { value: await body(), total, single }; } finally { pg.Client.prototype.query = original; }
}

test('a frozen cut, a node page and run usages answer what the record-by-record checks answer, for every reader and after every revocation', { timeout: 300_000 }, async t => {
  const postgres = await startPostgres();
  let close = async (): Promise<void> => {};
  t.after(async () => { await close(); await postgres.stop(); });
  const w = await world(postgres, false, undefined, TREE);
  const layer = w.knowledge.feeding!;
  close = async () => { await layer.drain(); await w.close(); };
  const other = w.outsider;
  w.packs.readers.set(other.id, new Set(['famx']));
  // Two documents both readers may read, one only the first reader may read.
  const shared = [await document(w, 0, [w.user.id, other.id]), await document(w, 2, [w.user.id, other.id])];
  const own = await document(w, 1, [w.user.id]);
  const first = await readAll(w, w.user, [...shared, own]);
  await readAll(w, w.user, [...shared, own]);
  const theirs = await readAll(w, other, shared);
  // A credential hit lifted by an acceptance in force: readable now, withheld once the acceptance is revoked.
  const secret = await document(w, 3, [w.user.id], `Synthetic case ftp://synthetic:${randomBytes(8).toString('hex')}@192.0.2.10/file`);
  assert.equal(secret.original.body.read_tier, 'retain_only');
  await w.kit.artifacts.acceptFindings(w.admin, secret.original.body.sha256);
  await readAll(w, w.user, [secret]);
  const frozen = await layer.freeze(w.user, newId('run'), w.root.root);
  const legacy = recordByRecord(w);

  const same = async (reader: Principal, what: string) => {
    const batched = await layer.cut('famx', frozen.offset, reader), expected = await legacy.cut('famx', frozen.offset, reader);
    assert.deepEqual(contents(batched), contents(expected), `${what}: frozen cut`);
    assert.deepEqual(contents(batched), contents(await layer.cut('famx', null, reader)), `${what}: frozen and live cut`);
    assert.deepEqual(await layer.entriesAtNodes(reader, 'famx', w.root.root, ['/'], frozen.offset), (await legacy.entries(reader, 'famx', frozen.offset)).filter(row => atRoot(w.root.root)(row.body)), `${what}: node page`);
    for (const run of [first, theirs]) assert.deepEqual(await layer.usages(reader, run), await legacy.usages(reader, run), `${what}: usages of ${run}`);
    return batched;
  };
  const objectsOf = (cut: FeedingCut | null) => new Set([...cut?.objects.values() ?? []].map(object => object.source && typeof object.source === 'object' ? (object.source as { document?: string }).document : null));

  const mine = await same(w.user, 'first reader');
  assert.deepEqual([...objectsOf(mine)].sort(), ['SYN-DOC-0', 'SYN-DOC-1', 'SYN-DOC-2', 'SYN-DOC-3']);
  assert.equal(mine!.usages.length, 2 * 3 * 40 + 40, 'the first reader sees the usages of its own three runs, not the other reader\'s');
  const theirsCut = await same(other, 'second reader');
  assert.deepEqual([...objectsOf(theirsCut)].sort(), ['SYN-DOC-0', 'SYN-DOC-2'], 'a capture the reader may not read is never disclosed');
  assert.equal(theirsCut!.usages.length, 80, 'only the second reader\'s own run is visible to it');
  assert.equal((await layer.usages(other, first)).length, 0, 'another reader\'s run discloses no usage');

  await w.kit.artifacts.revokeFindings(w.admin, secret.original.body.sha256);
  const withheld = await same(w.user, 'after the acceptance is revoked');
  assert.deepEqual([...objectsOf(withheld)].sort(), ['SYN-DOC-0', 'SYN-DOC-1', 'SYN-DOC-2'], 'a credential-withheld original is not disclosed');

  w.packs.readers.delete(other.id);
  assert.equal(await same(other, 'after the product is revoked'), null);
  assert.deepEqual(await layer.entriesAtNodes(other, 'famx', w.root.root, ['/'], frozen.offset), []);
  await w.kit.principals.setDisabled(w.admin, w.user.id, true);
  assert.equal(await same(w.user, 'after the account is disabled'), null);
});

test('facet and index views read through the batched cut are byte-identical to the views over the record-by-record cut', { timeout: 300_000 }, async t => {
  const postgres = await startPostgres();
  let close = async (): Promise<void> => {};
  t.after(async () => { await close(); await postgres.stop(); });
  const w = await world(postgres, false, undefined, TREE);
  close = async () => { await w.knowledge.feeding!.drain(); await w.close(); };
  const documents = [await document(w, 0, [w.user.id]), await document(w, 1, [w.user.id]), await document(w, 2, [w.user.id])];
  for (let r = 0; r < 3; r++) await readAll(w, w.user, documents);
  const frozen = await w.knowledge.feeding!.freeze(w.user, newId('run'), null);
  const reference = createKnowledge({ records: w.kit, parsers: w.knowledge.__context.parsers, packs: w.packs, external: w.external, sandbox: { requireOsIsolation: w.knowledge.__context.sandbox.requireOsIsolation }, admin: w.admin, feeding: recordByRecord(w) });
  for (const id of [
    `knowledge:facets:famx:${BUILD}?kind=case&by=line,module,has_expected,negative,test_type_status`,
    `knowledge:facets:famx:${BUILD}?kind=case&by=line,module,tags,resource_empty,tag_valid`,
    `knowledge:facets:famx:${BUILD}?kind=case&by=commands`,
    `knowledge:index:famx:${BUILD}?kind=case&key=case_location`,
  ]) {
    const context = { principal: w.user, run: null, feeding_offset: frozen, purpose: 'Synthetic batched view test' };
    const read = await createKnowledgeReader(w.knowledge).read(id, context), expected = await createKnowledgeReader(reference).read(id, context);
    assert.ok(read.ok && expected.ok, `${id}: ${read.ok ? '' : read.reason} ${expected.ok ? '' : expected.reason}`);
    const bytes = (answer: typeof read) => answer.ok ? answer.artifacts.find(artifact => artifact.name === 'original')!.artifact.body.sha256 : null;
    assert.equal(bytes(read), bytes(expected), id);
    assert.equal(read.revision, expected.revision, `${id}: revision`);
    const view = JSON.parse(Buffer.from((await w.kit.artifacts.trustedBytes(bytes(read)!))!).toString('utf8'));
    assert.ok((view.total ?? view.total_entries) >= 120, `${id}: the fed cases are counted`);
  }
});

test('the single-key lookups of a frozen cut, a node page, run usages and a view read do not grow with the feeding history', { timeout: 300_000 }, async t => {
  const postgres = await startPostgres();
  let close = async (): Promise<void> => {};
  t.after(async () => { await close(); await postgres.stop(); });
  const w = await world(postgres, false, undefined, TREE);
  const layer = w.knowledge.feeding!;
  close = async () => { await layer.drain(); await w.close(); };
  const documents = [await document(w, 0, [w.user.id]), await document(w, 1, [w.user.id])];
  const runs = [await readAll(w, w.user, documents)];
  const measure = async () => {
    const frozen = await layer.freeze(w.user, newId('run'), w.root.root);
    const cut = await counted(() => layer.cut('famx', frozen.offset, w.user));
    const page = await counted(() => layer.entriesAtNodes(w.user, 'famx', w.root.root, ['/'], frozen.offset));
    const usages = await counted(() => layer.usages(w.user, runs[0]));
    const view = await counted(() => createKnowledgeReader(w.knowledge).read(`knowledge:facets:famx:${BUILD}?kind=case&by=line,module,has_expected,negative,test_type_status`, { principal: w.user, run: null, feeding_offset: frozen, purpose: 'Synthetic lookup bound' }));
    assert.ok(view.value.ok, view.value.ok ? '' : view.value.reason);
    return { records: cut.value!.usages.length, cut, page, usages, view };
  };
  const small = await measure();
  for (let r = 0; r < 3; r++) runs.push(await readAll(w, w.user, documents));
  const large = await measure();
  assert.equal(large.records, 4 * small.records, 'the history holds four times the records');
  for (const name of ['cut', 'page', 'usages', 'view'] as const) {
    assert.equal(large[name].single, small[name].single, `${name}: single-key lookups ${small[name].single} -> ${large[name].single}`);
    assert.ok(large[name].total <= small[name].total + 2, `${name}: SQL executions ${small[name].total} -> ${large[name].total}`);
  }
  assert.ok(large.cut.total <= 16, `a frozen cut over ${large.records} usages took ${large.cut.total} SQL executions`);
  assert.ok(large.page.total <= 12, `a node page took ${large.page.total} SQL executions`);
});

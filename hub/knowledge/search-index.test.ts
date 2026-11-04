// The knowledge search index is built by background rounds and only read by searches. Real PostgreSQL and a real product
// composition, synthetic entries; the scheduling cases run on a fake source and a mocked clock.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { Database, createPool } from '../records/db.ts';
import { PgSpaceSearchIndex } from '../records/space-index.ts';
import type { SpaceSearchIndex } from '../records/api.ts';
import { installTraceSink, startTrace, type SpanRow } from '../telemetry/api.ts';
import type { TemporaryPostgres } from '../testing/postgres.ts';
import { INDEX_BATCH_ROWS, INDEX_RETRY_MAX_MS, INDEX_TICK_MS, SearchIndexer, buildScope, yieldLoop, type IndexScope } from './search-index.ts';
import { createKnowledge } from './service.ts';
import { BASE_CATALOG, catalogXml, makeUnversionedWorld, startPostgres, type World } from './test-support.ts';
import { createTestParserRegistry } from '../testing/parsers.ts';

let postgres: TemporaryPostgres;
before(async () => { postgres = await startPostgres(); });
after(() => postgres?.stop());

const TABLES = ['knowledge_space_search', 'knowledge_space_search_documents', 'knowledge_space_search_ready', 'knowledge_space_search_totals'];
const WANTED = 'network-17';

async function productWorld(t: { after(fn: () => unknown): void }, entries: number, limits = {}): Promise<World & { db: Database }> {
  const w = await makeUnversionedWorld(postgres, true, { entries, records: { limits } });
  const db = new Database(createPool(w.kit.database, 2));
  t.after(async () => { await db.end(); await w.close(); });
  return { ...w, db };
}

/** The same records in a new process, or with other limits. */
const knowledgeOn = (w: World, records: World['kit'] | (World['kit'] & { spaceIndex: SpaceSearchIndex }) = w.kit) =>
  createKnowledge({ records, parsers: createTestParserRegistry(), packs: w.packs, external: w.external, jev: null, sandbox: { requireOsIsolation: false }, admin: w.admin });

const counts = async (db: Database): Promise<number[]> => {
  const out: number[] = [];
  for (const table of TABLES) out.push((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n);
  return out;
};

/** The root step of what `work` traced. */
async function traced(work: () => Promise<unknown>, name: string): Promise<SpanRow> {
  const rows: SpanRow[] = [];
  const uninstall = installTraceSink({ push: (row) => rows.push(row) });
  try { await work(); } finally { uninstall(); }
  const root = rows.find((row) => row.is_root && row.name === name);
  assert.ok(root, `${name} among ${rows.map((row) => row.name).join(', ')}`);
  return root;
}

test('a search on a version with no index writes nothing and names what it left out; after the background round it finds the entry', async (t) => {
  const w = await productWorld(t, 40), spaces = w.knowledge.spaces!, index = w.kit.spaceIndex!;
  await spaces.ensure(w.user, 'team');
  const before = await counts(w.db);
  const writes: string[] = [];
  for (const method of ['add', 'complete', 'refuse', 'ready'] as const) {
    const original = (index[method] as (...args: unknown[]) => Promise<unknown>).bind(index);
    (index as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => { writes.push(method); return original(...args); };
    t.after(() => { (index as unknown as Record<string, unknown>)[method] = original; });
  }

  const found = await spaces.search(w.user, WANTED, 'all');
  assert.deepEqual(found.matches, [], 'the unbuilt scope is not searched');
  assert.equal(found.warnings?.length, 1);
  const warning = found.warnings![0];
  assert.equal(warning.code, 'SOURCE_UNAVAILABLE');
  assert.match(warning.path ?? '', /^\/产品\/.*\/10\.6$/);
  assert.ok(warning.message.includes(warning.path!), 'the text alone says which part');
  assert.match(warning.message, /正在后台建立/);
  assert.match(warning.message, /未检索该范围/);
  assert.match(warning.fix ?? '', /从第一页重新搜索/);
  assert.deepEqual(writes, [], 'nothing of the index runs in a search');
  assert.deepEqual(await counts(w.db), before, 'not a row of the index changed');

  const outcome = await spaces.indexRound();
  assert.deepEqual(outcome, { built: 1, refused: 0, failed: 0 });
  const again = await spaces.search(w.user, WANTED, 'all');
  assert.ok(again.matches.some((hit) => hit.statement === '合成用例'));
  assert.equal(again.warnings, undefined);
});

test('a read that registers a new team version leaves its index to the background round, and a member with nothing indexed gets no warning', async (t) => {
  const w = await productWorld(t, 3), spaces = w.knowledge.spaces!;
  await spaces.ensure(w.admin, 'team');
  await spaces.indexRound();
  const source = await w.kit.artifacts.ingest({ bytes: Buffer.from('合成团队原文'), mediaType: 'text/plain', origin: { read: { object: 'synthetic:document:team-index' } }, author: { user: null }, provenanceType: 'observed', visibility: { readers: [], admins: true, packs: [], shareable: false }, readTier: 'model_readable' });
  await spaces.write(w.admin, { kind: 'observation', statement: '合成团队条目', path: '/notes', grounds: [{ reference: 'src:' + source.body.sha256, quotation: '合成团队原文' }] }, null, 'team');
  assert.equal((await spaces.search(w.user, '合成团队条目', 'team')).matches.length, 1, 'a write indexes in its own transaction');

  const unchanged = await counts(w.db);
  assert.equal((await spaces.search(w.outsider, '合成团队条目', 'personal')).warnings, undefined, 'a new, empty personal space has nothing to leave out');
  assert.deepEqual(await counts(w.db), unchanged);

  // A new root of the product: the next read registers a team version that has no references yet.
  const previous = (await spaces.current('team'))!;
  w.external.set('site:tree:synthetic-next', { bytes: catalogXml({ ...BASE_CATALOG, net: [...BASE_CATALOG.net, { name: 'arp', params: [] }] }), mediaType: 'application/xml' });
  const next = await w.knowledge.produceTree({ product: w.product, build: { name: 'Synthetic_10_7', family: 'ACME', line: '10.6', base: 'Synthetic_10_7', platform: null, built_at: null, released_at: '2026-10-25T00:00:00.000Z', sources: { tree: 'site:tree:synthetic-next' }, root: null } });
  assert.equal(next.ok, true, next.reason ?? '');
  await w.knowledge.moveRoot(w.product.product.id, '10.6', previous.body.products[0].root, next.root!, next.action, { by: w.admin });
  const hidden = await spaces.search(w.user, '合成团队条目', 'team');
  assert.notEqual((await spaces.current('team'))!.root, previous.root, 'the read registered the new mount');
  assert.deepEqual(await counts(w.db), unchanged, 'and wrote nothing of the index');
  assert.deepEqual(hidden.matches, []);
  assert.deepEqual(hidden.warnings?.map((warning) => warning.path), ['/', previous.body.products[0].path]);
  assert.match(hidden.warnings?.[0].message ?? '', /^团队知识索引：正在后台建立；未检索该范围$/);
  assert.deepEqual(await spaces.indexRound(), { built: 2, refused: 0, failed: 0 });
  const shown = await spaces.search(w.user, '合成团队条目', 'team');
  assert.equal(shown.matches.length, 1);
  assert.equal(shown.warnings, undefined);
});

test("a search's statements and rows do not grow with the indexed documents, built or not", async (t) => {
  const measure = async (entries: number): Promise<{ unbuilt: number[]; ready: number[]; hits: number }> => {
    const w = await productWorld(t, entries), spaces = w.knowledge.spaces!;
    await spaces.ensure(w.user, 'team');
    const search = (): Promise<unknown> => startTrace({ name: 'get_nodes', origin: 'mcp' }, () => spaces.search(w.user, 'network', 'all', null, 5));
    const usage = async (): Promise<number[]> => {
      const { usage } = await traced(search, 'get_nodes');
      return [usage['db.queries']!, usage['db.rows']!];
    };
    const unbuilt = await usage();
    await spaces.indexRound();
    const ready = await usage();
    return { unbuilt, ready, hits: (await spaces.search(w.user, 'network', 'all', null, 5)).matches.length };
  };
  const small = await measure(30), large = await measure(1500);
  assert.equal(small.hits, 5);
  assert.equal(large.hits, 5);
  assert.deepEqual(large.unbuilt, small.unbuilt, 'a search on an unbuilt version');
  assert.deepEqual(large.ready, small.ready, 'a search on a built version');
});

test("a build's statements grow with its batches, not with its rows", async (t) => {
  const measure = async (entries: number): Promise<{ statements: number; rows: number }> => {
    const w = await productWorld(t, entries), spaces = w.knowledge.spaces!;
    await spaces.ensure(w.user, 'team');
    const root = await traced(() => spaces.indexRound(), 'index-knowledge');
    assert.equal(root.origin, 'background');
    return { statements: root.usage['db.queries']!, rows: (await counts(w.db))[0] };
  };
  // A batch costs a fixed handful (which rows are done, the records, the documents, one transaction of five); a round adds
  // what it takes to find its scopes. One statement per row would pass every one of these bounds by an order of magnitude.
  const perBatch = 12, fixed = 40;
  for (const entries of [30, INDEX_BATCH_ROWS * 6]) {
    const { statements, rows } = await measure(entries);
    assert.ok(rows >= entries);
    const batches = Math.ceil(rows / INDEX_BATCH_ROWS);
    assert.ok(statements <= fixed + perBatch * batches, `${statements} statements for ${rows} rows in ${batches} batches`);
  }
});

test('a version over the limit is tried once, not at every search or round, also after a restart, and raising the limit lets it finish', async (t) => {
  const limit = 3000;
  const w = await productWorld(t, 200, { maxProductIndexBytes: limit }), spaces = w.knowledge.spaces!, index = w.kit.spaceIndex!;
  await spaces.ensure(w.user, 'team');
  let adds = 0;
  const add = index.add.bind(index);
  index.add = async (...args) => { adds += 1; return add(...args); };
  t.after(() => { index.add = add; });

  assert.deepEqual(await spaces.indexRound(), { built: 0, refused: 1, failed: 0 });
  const tried = adds;
  assert.ok(tried > 0);
  for (let i = 0; i < 3; i++) {
    const found = await spaces.search(w.user, WANTED, 'all');
    assert.equal(found.warnings?.length, 1);
    assert.equal(found.warnings![0].code, 'SPACE_INDEX_LIMIT');
    assert.match(found.warnings![0].message, /超过 3000 字节上限；未检索该范围/);
    assert.match(found.warnings![0].fix ?? '', /CIRCLE_HUB_MAX_PRODUCT_INDEX_BYTES/);
    assert.match(found.warnings![0].path ?? '', /^\/产品\//);
  }
  assert.deepEqual(await spaces.indexRound(), { built: 0, refused: 0, failed: 0 }, 'a later round leaves it alone');
  assert.equal(adds, tried, 'neither searches nor a later round tried again');

  const restarted = knowledgeOn(w).spaces!;
  assert.deepEqual(await restarted.indexRound(), { built: 0, refused: 0, failed: 0 }, 'the refusal outlives the process');
  assert.equal(adds, tried);

  const raised = knowledgeOn(w, { ...w.kit, spaceIndex: new PgSpaceSearchIndex(w.db, { productBytes: 4 * 1024 * 1024 }) }).spaces!;
  const before = await counts(w.db);
  const pending = await raised.search(w.user, WANTED, 'all');
  assert.equal(pending.warnings?.[0].code, 'SOURCE_UNAVAILABLE', 'with the limit raised it is simply not built yet');
  assert.deepEqual(await raised.indexRound(), { built: 1, refused: 0, failed: 0 });
  assert.ok((await counts(w.db))[0] > before[0], 'the build went on from the rows it had');
  const found = await raised.search(w.user, WANTED, 'all');
  assert.ok(found.matches.length > 0);
  assert.equal(found.warnings, undefined);
  const { rows: [total] } = await w.db.query<{ counted: string; summed: string }>(`SELECT t.token_bytes::text AS counted,(SELECT sum(d.token_bytes) FROM knowledge_space_search s JOIN knowledge_space_search_documents d ON d.record=s.record WHERE s.version=t.version)::text AS summed FROM knowledge_space_search_totals t WHERE t.quota_space LIKE 'product:%'`);
  assert.equal(total.counted, total.summed, 'the part that was refused was not charged');
});

test('an entry over the entry limit refuses the version the same way, until that limit rises', async (t) => {
  const w = await productWorld(t, 3), spaces = w.knowledge.spaces!;
  await spaces.ensure(w.user, 'team');
  const strict = knowledgeOn(w, { ...w.kit, spaceIndex: new PgSpaceSearchIndex(w.db, { entryBytes: 100 }) }).spaces!;
  assert.deepEqual(await strict.indexRound(), { built: 0, refused: 1, failed: 0 });
  const warning = (await strict.search(w.user, WANTED, 'all')).warnings?.[0];
  assert.equal(warning?.code, 'SPACE_INDEX_LIMIT');
  assert.match(warning?.message ?? '', /单条知识索引超过 100 字节上限；未检索该范围/);
  assert.match(warning?.fix ?? '', /由管理员调高 CIRCLE_HUB_MAX_ENTRY_INDEX_BYTES 并重启 Hub/);
  assert.doesNotMatch(warning?.fix ?? '', /缩短|拆分/, 'nobody reading a product can do that');
  assert.deepEqual(await strict.indexRound(), { built: 0, refused: 0, failed: 0 });
  assert.deepEqual(await spaces.indexRound(), { built: 1, refused: 0, failed: 0 }, 'a higher limit ends the refusal without a write');
});

test('a build that stopped goes on from the rows it has: nothing is read or charged twice', async (t) => {
  const w = await productWorld(t, INDEX_BATCH_ROWS * 3), spaces = w.knowledge.spaces!, index = w.kit.spaceIndex!;
  await spaces.ensure(w.user, 'team');
  const add = index.add.bind(index);
  let adds = 0;
  index.add = async (...args) => { if (++adds === 3) throw new Error('合成的中断'); return add(...args); };
  assert.deepEqual(await spaces.indexRound(), { built: 0, refused: 0, failed: 1 });
  index.add = add;
  const done = (await counts(w.db))[0];
  assert.ok(done > 0, 'the batches before the interruption stayed');
  assert.match((await spaces.search(w.user, WANTED, 'all')).warnings?.[0].message ?? '', /正在后台建立/);

  const document = index.document.bind(index);
  let documents = 0, written = 0;
  index.document = (text) => { documents += 1; return document(text); };
  index.add = async (...args) => { written += args[1].length; return add(...args); };
  t.after(() => { index.document = document; index.add = add; });
  assert.deepEqual(await spaces.indexRound(), { built: 1, refused: 0, failed: 0 });
  const [references, tokenized] = await counts(w.db);
  assert.equal(documents, references - done, 'only the rows it did not have are tokenized');
  assert.equal(written, references - done, 'and written');
  assert.equal(tokenized, references);
  const { rows: [total] } = await w.db.query<{ counted: string; summed: string }>(`SELECT t.token_bytes::text AS counted,(SELECT sum(d.token_bytes) FROM knowledge_space_search s JOIN knowledge_space_search_documents d ON d.record=s.record WHERE s.version=t.version)::text AS summed FROM knowledge_space_search_totals t WHERE t.quota_space LIKE 'product:%'`);
  assert.equal(total.counted, total.summed);
  assert.ok((await spaces.search(w.user, WANTED, 'all')).matches.length > 0);
});

test('a ready version whose references were lost is found by a round, repaired, and not relied on meanwhile', async (t) => {
  const w = await productWorld(t, 5), spaces = w.knowledge.spaces!, index = w.kit.spaceIndex!;
  const entry = await spaces.write(w.user, { kind: 'observation', statement: '合成修复条目', path: '/notes' });
  await spaces.ensure(w.user, 'team');
  await spaces.indexRound();
  await w.db.query('DELETE FROM knowledge_space_search WHERE version=$1', [entry.root]);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; }), waiting = new Promise<void>((resolve) => { entered = resolve; });
  const present = index.present.bind(index);
  index.present = async (...args) => { if (args[0] === entry.root) { entered(); await gate; } return present(...args); };
  t.after(() => { index.present = present; });
  const restarted = knowledgeOn(w).spaces!;
  const round = restarted.indexRound();
  await waiting;
  const during = await restarted.search(w.user, '合成修复条目', 'personal');
  assert.deepEqual(during.matches, []);
  assert.match(during.warnings?.[0].message ?? '', /正在后台建立/);
  release();
  assert.equal((await round).built, 1);
  assert.equal((await restarted.search(w.user, '合成修复条目', 'personal')).matches[0]?.entry, entry.entry);
});

test('a repair that fails hands nothing back: every search warns, as for a scope being built, until a repair succeeds', async (t) => {
  const w = await productWorld(t, 5), spaces = w.knowledge.spaces!, index = w.kit.spaceIndex!;
  const entry = await spaces.write(w.user, { kind: 'observation', statement: '合成修复条目', path: '/notes' });
  await spaces.ensure(w.user, 'team');
  await spaces.indexRound();
  await w.db.query('DELETE FROM knowledge_space_search WHERE version=$1', [entry.root]);
  const present = index.present.bind(index);
  index.present = async (...args) => { if (args[0] === entry.root) throw new Error('合成的修复失败'); return present(...args); };
  t.after(() => { index.present = present; });
  const restarted = knowledgeOn(w).spaces!;
  const search = () => restarted.search(w.user, '合成修复条目', 'personal');
  for (let round = 0; round < 2; round++) {
    assert.deepEqual(await restarted.indexRound(), { built: 0, refused: 0, failed: 1 });
    for (let i = 0; i < 2; i++) {
      const failed = await search();
      assert.deepEqual(failed.matches, []);
      assert.equal(failed.warnings?.[0].code, 'SOURCE_UNAVAILABLE');
      assert.match(failed.warnings?.[0].message ?? '', /正在后台建立；未检索该范围/);
    }
  }
  index.present = present;
  assert.deepEqual(await restarted.indexRound(), { built: 1, refused: 0, failed: 0 });
  const repaired = await search();
  assert.equal(repaired.matches[0]?.entry, entry.entry);
  assert.equal(repaired.warnings, undefined);
});

test('a repair whose count still differs is not one: the proof stands until a later count comes out right', async (t) => {
  const w = await productWorld(t, 5), spaces = w.knowledge.spaces!, index = w.kit.spaceIndex!;
  const entry = await spaces.write(w.user, { kind: 'observation', statement: '合成修复条目', path: '/notes' });
  await spaces.ensure(w.user, 'team');
  await spaces.indexRound();
  await w.db.query('DELETE FROM knowledge_space_search WHERE version=$1', [entry.root]);
  const ready = index.ready.bind(index);
  let counts = 0;
  index.ready = async (...args) => { if (args[0] === entry.root && ++counts === 2) return false; return ready(...args); };
  t.after(() => { index.ready = ready; });
  const restarted = knowledgeOn(w).spaces!;
  assert.deepEqual(await restarted.indexRound(), { built: 0, refused: 0, failed: 1 });
  assert.equal(counts, 2, 'the count that found the damage and the one after the repair');
  assert.match((await restarted.search(w.user, '合成修复条目', 'personal')).warnings?.[0].message ?? '', /正在后台建立/);
  assert.deepEqual(await restarted.indexRound(), { built: 0, refused: 0, failed: 0 }, 'the rows are all there, and nothing is written again');
  const found = await restarted.search(w.user, '合成修复条目', 'personal');
  assert.equal(found.matches[0]?.entry, entry.entry);
  assert.equal(found.warnings, undefined);
});

test('a repair that passes a limit names the limit and is tried once, also after a restart, until the limit rises', async (t) => {
  const w = await productWorld(t, 3), spaces = w.knowledge.spaces!;
  await spaces.ensure(w.user, 'team');
  await spaces.indexRound();
  await w.db.query("DELETE FROM knowledge_space_search WHERE quota_space LIKE 'product:%'");
  const strictIndex = new PgSpaceSearchIndex(w.db, { entryBytes: 100 }), add = strictIndex.add.bind(strictIndex);
  let adds = 0;
  strictIndex.add = async (...args) => { adds += 1; return add(...args); };
  const strictKnowledge = () => knowledgeOn(w, { ...w.kit, spaceIndex: strictIndex }).spaces!;
  const strict = strictKnowledge();
  assert.deepEqual(await strict.indexRound(), { built: 0, refused: 1, failed: 0 });
  const tried = adds;
  assert.ok(tried > 0);
  for (let i = 0; i < 2; i++) {
    const found = await strict.search(w.user, WANTED.slice(0, 9), 'all');
    assert.deepEqual(found.matches, []);
    assert.equal(found.warnings?.length, 1);
    assert.equal(found.warnings![0].code, 'SPACE_INDEX_LIMIT');
    assert.match(found.warnings![0].message, /单条知识索引超过 100 字节上限；未检索该范围/);
  }
  assert.deepEqual(await strict.indexRound(), { built: 0, refused: 0, failed: 0 }, 'a later round leaves it alone');
  const restarted = strictKnowledge();
  assert.deepEqual(await restarted.indexRound(), { built: 0, refused: 0, failed: 0 }, 'and a new process proves the damage without passing the limit again');
  assert.equal((await restarted.search(w.user, WANTED.slice(0, 9), 'all')).warnings?.[0].code, 'SPACE_INDEX_LIMIT');
  assert.equal(adds, tried);

  const raised = knowledgeOn(w).spaces!;
  assert.deepEqual(await raised.indexRound(), { built: 1, refused: 0, failed: 0 });
  const found = await raised.search(w.user, WANTED.slice(0, 9), 'all');
  assert.ok(found.matches.length > 0);
  assert.equal(found.warnings, undefined);
});

test('a refusal left from another limit does not touch a ready scope that counts right', async (t) => {
  const w = await productWorld(t, 3), spaces = w.knowledge.spaces!;
  await spaces.ensure(w.user, 'team');
  const strict = knowledgeOn(w, { ...w.kit, spaceIndex: new PgSpaceSearchIndex(w.db, { entryBytes: 100 }) }).spaces!;
  assert.deepEqual(await strict.indexRound(), { built: 0, refused: 1, failed: 0 });
  assert.deepEqual(await spaces.indexRound(), { built: 1, refused: 0, failed: 0 });
  const lowered = knowledgeOn(w, { ...w.kit, spaceIndex: new PgSpaceSearchIndex(w.db, { entryBytes: 100 }) }).spaces!;
  assert.deepEqual(await lowered.indexRound(), { built: 0, refused: 0, failed: 0 }, 'the version is whole');
  const found = await lowered.search(w.user, WANTED.slice(0, 9), 'all');
  assert.ok(found.matches.length > 0, 'and a limit lowered since takes nothing from it');
  assert.equal(found.warnings, undefined);
});

test('a mount that cannot be read fails alone: the rest of the round is built and it is tried again', async (t) => {
  const w = await productWorld(t, 3), spaces = w.knowledge.spaces!, store = w.kit.store;
  await spaces.write(w.user, { kind: 'observation', statement: '合成独立范围', path: '/notes' });
  const mount = (await spaces.ensure(w.user, 'team')).body.products[0];
  const entry = await spaces.write(w.user, { kind: 'observation', statement: '合成另一范围', path: '/notes' });
  await w.db.query('DELETE FROM knowledge_space_search WHERE version=$1', [entry.root]);
  await w.db.query('DELETE FROM knowledge_space_search_ready WHERE version=$1', [entry.root]);
  const find = store.find.bind(store);
  store.find = (async (...args: Parameters<typeof find>) => {
    if (args[0].value === mount.root) throw new Error('合成的读取失败');
    return find(...args);
  }) as typeof store.find;
  t.after(() => { store.find = find; });
  const fresh = knowledgeOn(w).spaces!;
  const outcome = await fresh.indexRound();
  assert.equal(outcome.built, 1, 'the member space behind the mount in the round');
  assert.ok(outcome.failed > 0);
  assert.equal((await fresh.search(w.user, '合成另一范围', 'personal')).matches.length, 1);
  store.find = find;
  assert.deepEqual(await fresh.indexRound(), { built: 1, refused: 0, failed: 0 });
});

test('content read before a purge is not written after it', async (t) => {
  const w = await productWorld(t, 1), spaces = w.knowledge.spaces!, store = w.kit.store;
  const entry = await spaces.write(w.user, { kind: 'observation', statement: '合成清除前读到的内容', path: '/notes' });
  const version = (await spaces.current(w.user.id))!;
  await spaces.ensure(w.admin, 'team');
  await w.db.query('DELETE FROM knowledge_space_search WHERE version=$1', [entry.root]);
  await w.db.query('DELETE FROM knowledge_space_search_documents');
  await w.db.query('DELETE FROM knowledge_space_search_ready WHERE version=$1', [entry.root]);
  const epoch = (await w.kit.personalPayloads!.inspect(version.root))!.epoch;
  // The purge lands between the read of the body and the transaction of its batch.
  const withTransaction = store.withTransaction.bind(store);
  let purged = false;
  store.withTransaction = (async (...args: Parameters<typeof withTransaction>) => {
    if (!purged) { purged = true; await w.kit.personalPayloads!.purge(w.user, epoch); }
    return withTransaction(...args);
  }) as typeof store.withTransaction;
  t.after(() => { store.withTransaction = withTransaction; });
  const index = w.kit.spaceIndex!, document = index.document.bind(index), texts: string[] = [];
  index.document = (text) => { texts.push(text); return document(text); };
  t.after(() => { index.document = document; });
  const round = await spaces.indexRound();
  assert.equal(round.failed, 0);
  assert.ok(purged);
  assert.ok(texts.some((text) => text.includes('合成清除前读到的内容')), 'the body was read and tokenized before the purge');
  const { rows } = await w.db.query<{ n: number }>('SELECT count(*)::int AS n FROM knowledge_space_search_documents WHERE record=ANY($1::text[])', [version.body.entries.map((row) => row.record)]);
  assert.equal(rows[0].n, 0, 'nothing of it reached the index');
  assert.equal((await w.db.query<{ n: number }>('SELECT count(*)::int AS n FROM knowledge_space_search WHERE version=$1', [entry.root])).rows[0].n, 0);
});

test('the server starts the loop: a round at start, and one when a search finds something not ready', async (t) => {
  const w = await productWorld(t, 3), spaces = w.knowledge.spaces!;
  await spaces.ensure(w.user, 'team');
  spaces.startIndexing();
  t.after(() => spaces.stopIndexing());
  const search = () => spaces.search(w.user, WANTED.slice(0, 9), 'all');
  for (let i = 0; i < 2000 && (await search()).warnings; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal((await search()).warnings, undefined, 'the first round built what was there');

  const entry = await spaces.write(w.user, { kind: 'observation', statement: '合成循环条目', path: '/notes' });
  await w.db.query('DELETE FROM knowledge_space_search WHERE version=$1', [entry.root]);
  await w.db.query('DELETE FROM knowledge_space_search_ready WHERE version=$1', [entry.root]);
  const missing = await spaces.search(w.user, '合成循环条目', 'personal');
  assert.match(missing.warnings?.[0].message ?? '', /正在后台建立/);
  for (let i = 0; i < 2000 && (await spaces.search(w.user, '合成循环条目', 'personal')).warnings; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal((await spaces.search(w.user, '合成循环条目', 'personal')).matches.length, 1, 'the search asked for it and the loop built it');
  await spaces.stopIndexing();
});

/** A scope of `batches` batches over an index that answers at once: only `buildScope` itself can give the event loop a turn. */
function fakeScope(batches: number): { index: SpaceSearchIndex; scope: IndexScope; written: () => number } {
  let written = 0;
  const index = {
    present: async () => new Set<string>(),
    document: () => ({ tokens: ['合成'], bytes: 74 }),
    complete: async () => {},
  } as unknown as SpaceSearchIndex;
  const scope: IndexScope = {
    version: 'v', path: '/', quotaSpace: 'q',
    async *batches() { for (let i = 0; i < batches; i++) yield [{ space: 'q', path: '/', entry: String(i) }]; },
    read: async (rows) => rows.map((row) => ({ space: row.space, path: row.path, entry: row.entry, record: row.entry, text: '合成' })),
    write: async (rows) => { written += rows.length; return true; },
  };
  return { index, scope, written: () => written };
}

test('a build gives the event loop a turn after every batch and stops at the next batch when asked', async () => {
  const { index, scope, written } = fakeScope(8);
  let turns = 0, spinning = true;
  const spin = (): void => { turns += 1; if (spinning) setImmediate(spin); };
  setImmediate(spin);
  assert.equal(await buildScope(index, scope, new AbortController().signal), true);
  spinning = false;
  assert.equal(written(), 8);
  assert.ok(turns >= 8, `${turns} turns of the loop in 8 batches`);

  const controller = new AbortController();
  const stopped = fakeScope(8), write = stopped.scope.write;
  stopped.scope.write = async (rows) => { if (stopped.written() === 2) controller.abort(); return write(rows); };
  await assert.rejects(buildScope(stopped.index, stopped.scope, controller.signal), { name: 'AbortError' });
  assert.equal(stopped.written(), 3);
});

const flush = async (): Promise<void> => { for (let i = 0; i < 40; i++) await yieldLoop(); };

test('an idle tick costs a look at the pointers; a moved root starts a round, a request wakes the loop', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let looks = 0, rounds = 0, marker = 'a';
  const indexer = new SearchIndexer({ marker: async () => { looks += 1; return marker; }, scopes: async () => { rounds += 1; return []; } }, () => ({ states: async () => [] }) as unknown as SpaceSearchIndex);
  indexer.start();
  t.after(() => indexer.stop());
  await flush();
  assert.deepEqual([looks, rounds], [1, 1], 'a round at start');
  t.mock.timers.tick(INDEX_TICK_MS);
  await flush();
  assert.deepEqual([looks, rounds], [2, 1], 'an idle tick only looks');
  marker = 'b';
  t.mock.timers.tick(INDEX_TICK_MS);
  await flush();
  assert.deepEqual([looks, rounds], [3, 2], 'a moved root starts a round');
  indexer.request();
  await flush();
  assert.deepEqual([looks, rounds], [4, 3], 'a request wakes the loop at once');
});

test('rounds that fail keep a growing distance, whatever searches ask, and a success ends it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let rounds = 0, failing = true;
  const messages: string[] = [], visited: Array<readonly string[] | null> = [];
  const indexer = new SearchIndexer({ marker: async () => 'a', scopes: async (spaces) => { rounds += 1; visited.push(spaces); if (failing) throw new Error('合成的失败'); return []; } }, () => ({ states: async () => [] }) as unknown as SpaceSearchIndex);
  indexer.start((detail) => messages.push(detail));
  t.after(() => indexer.stop());
  await flush();
  assert.equal(rounds, 1);
  assert.match(messages[0], /合成的失败/);
  for (let i = 0; i < 5; i++) indexer.request();
  await flush();
  assert.equal(rounds, 1, 'a request does not break the distance');
  t.mock.timers.tick(INDEX_TICK_MS);
  await flush();
  assert.equal(rounds, 2);
  t.mock.timers.tick(INDEX_TICK_MS);
  await flush();
  assert.equal(rounds, 2, 'the second distance is twice the first');
  assert.deepEqual(visited, [null, null], 'what failed may be a space no later round would visit: the next round goes over everything');
  t.mock.timers.tick(INDEX_TICK_MS);
  await flush();
  assert.equal(rounds, 3);
  failing = false;
  t.mock.timers.tick(INDEX_RETRY_MAX_MS);
  await flush();
  const settled = rounds;
  t.mock.timers.tick(INDEX_TICK_MS);
  await flush();
  assert.equal(rounds, settled, 'after a success an idle tick starts nothing');
});

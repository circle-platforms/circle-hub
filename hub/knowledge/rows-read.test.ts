import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { canonicalBytes, IntegrityError } from '../records/api.ts';
import { openTestRecords } from '../testing/records.ts';
import { startPostgres, type TemporaryPostgres } from '../testing/postgres.ts';
import { withReadCache } from './read-cache.ts';
import { KnowledgeStore, SCHEMAS } from './store.ts';
import type { CompositionContentRow } from '../../contracts/src/knowledge.ts';
let postgres: TemporaryPostgres;
before(async () => { postgres = await startPostgres(); }); after(() => postgres?.stop());
const row = (): CompositionContentRow => ({ path: '/synthetic', entry: 'a'.repeat(64), kind: 'case', producers: ['synthetic'], fragments: [`src:${'b'.repeat(64)}/json@1/root`], basis: 'release_record', decided_by: 'synthetic@1.0.0', statement: '合成行', data: { document: 'synthetic-document', commands: ['synthetic command'] }, applicability: null });

test('streamed verified rows equal the original part parser, including normalization and validation after a cached fact', async t => {
  const kit = await openTestRecords({ postgres }); t.after(() => kit.close());
  const store = new KnowledgeStore(kit.store);
  const raw = [row(), { ...row(), applicability: { builds: ['Rel_SYN_10_6_15'] } }, { ...row(), data: JSON.parse('{"__proto__":"synthetic","document":"synthetic-document"}') }];
  const part = await kit.store.put({ kind: 'tree_root', schema: SCHEMAS.rowsPart, provenance: 'projected', body: { rows: raw } });
  const expected = (await store.part(SCHEMAS.rowsPart, part.digest, { cache: false }))!.rows;
  const validated = store.rowsRead();
  for (let i = 0; i < 2; i++) {
    const actual: CompositionContentRow[] = []; await store.forEachRowsParts([part.digest], r => actual.push(r), validated);
    assert.deepEqual(canonicalBytes(actual), canonicalBytes(expected));
  }
  await assert.rejects(store.forEachRowsParts([part.digest], () => { }, {} as never), TypeError);
  const client = new pg.Client({ ...kit.database, ssl: false }); await client.connect();
  try { await client.query("SET session_replication_role='replica'"); await client.query('UPDATE records SET body=$1 WHERE digest=$2', ['{"rows":[]}', part.digest]); } finally { await client.end(); }
  await assert.rejects(store.forEachRowsParts([part.digest], () => assert.fail('corrupt bytes reached the consumer'), validated), IntegrityError);
});

test('bounded text batches verify every envelope and streamed rows retain strict schema refusals', async t => {
  const kit = await openTestRecords({ postgres }); t.after(() => kit.close()); const store = new KnowledgeStore(kit.store);
  const good = await kit.store.put({ kind: 'tree_root', schema: SCHEMAS.rowsPart, provenance: 'projected', body: { rows: [row()] } });
  const bad = await kit.store.put({ kind: 'tree_root', schema: SCHEMAS.rowsPart, provenance: 'projected', body: { rows: [{ ...row(), kind: 'not-a-kind' }] } });
  const original = pg.Client.prototype.query; let queries = 0;
  t.mock.method(pg.Client.prototype, 'query', function (this: pg.Client, ...args: unknown[]) { queries++; return Reflect.apply(original, this, args); });
  assert.equal((await kit.store.getTexts([good.digest, bad.digest, 'invalid', good.digest])).size, 2); assert.equal(queries, 1);
  await assert.rejects(store.forEachRowsParts([bad.digest], () => assert.fail('invalid row reached the consumer')), IntegrityError);
});

test('bulk scans do not retain every full entry and ordinary entry caching stays byte bounded',async t=>{
  const {entryDigest}=await import('./digest.ts');
  const kit=await openTestRecords({postgres});t.after(()=>kit.close());
  const writer=new KnowledgeStore(kit.store),digests:string[]=[];
  for(let i=0;i<8;i++){
    const content={kind:'case',statement:'合成 '+i,data:{document:'synthetic-'+i,extra:'x'.repeat(1000)},applicability:null};
    const digest=entryDigest(content);digests.push(digest);
    await kit.store.withTransaction(tx=>writer.putEntry('synthetic',digest,content,tx));
  }
  const reader=new KnowledgeStore(kit.store,{entryBytes:4096});
  await withReadCache(async()=>{
    const scan=await reader.entries(digests,undefined,{cache:false});assert.equal(scan.size,8);
    assert.deepEqual(reader.cachedEntries,{entries:0,bytes:0});
    for(const digest of digests)assert.deepEqual(await reader.entry(digest),scan.get(digest));
    assert.ok(reader.cachedEntries.bytes>0&&reader.cachedEntries.bytes<=4096);
    assert.ok(reader.cachedEntries.entries>0&&reader.cachedEntries.entries<digests.length);
  });
  assert.deepEqual(reader.cachedEntries,{entries:0,bytes:0});
});

import {createRecordStore} from './api.ts';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startPostgres, type TemporaryPostgres } from '../testing/postgres.ts';
import { openTestRecords } from '../testing/records.ts';
import { Database, createPool } from './db.ts';
import { MIGRATIONS, migrate } from './migrations.ts';
import { PgSpaceSearchIndex,knowledgeTokens } from './space-index.ts';
let postgres: TemporaryPostgres;
before(async () => { postgres = await startPostgres(); });
after(() => postgres?.stop());
test('migrations 9 and 10 add a deduplicated full-text projection to a version-8 database', async (t) => {
  const database = await postgres.createDatabase(undefined, { empty: true });
  t.after(() => postgres.dropDatabase(database.database));
  const db = new Database(createPool(database, 1));
  t.after(() => db.end());
  await migrate(db, MIGRATIONS.slice(0, 8));
  const before = (await db.query('SELECT * FROM schema_migrations ORDER BY version')).rows;
  assert.deepEqual(await migrate(db), [9,10]);
  assert.deepEqual((await db.query('SELECT * FROM schema_migrations WHERE version < 9 ORDER BY version')).rows, before);
  const indexes = (await db.query<{
    indexdef: string;
  }>("SELECT indexdef FROM pg_indexes WHERE tablename='knowledge_space_search_documents'")).rows;
  assert.ok(indexes.some(index => index.indexdef.includes('USING gin (tokens)')));
  assert.deepEqual(await migrate(db), []);
});
test('Chinese bigrams and normalized words search only authorized directory scopes before pagination', async (t) => {
  const kit = await openTestRecords({ postgres });
  t.after(() => kit.close());
  const index = kit.spaceIndex!;
  const version = await kit.store.put({ kind: 'knowledge_space_version', schema: 'knowledge-space-version@1', provenance: 'projected', body: { synthetic: 'index-version' } });
  const entry = await kit.store.put({ kind: 'knowledge_space_entry', schema: 'knowledge-space-entry@1', provenance: 'declared', body: { synthetic: 'entry' } });
  const row = { space: 'synthetic-owner', entry: entry.digest, record: entry.digest, text: '合成目录中的统一规则 ABCD' };
  await index.add(version.digest, [{ ...row, path: '/private' }, { ...row, path: '/shared' }, { ...row, path: '/shared/child' }, { ...row, path: '/shared-secret' }]);
  await index.complete(version.digest, '/');
  assert.equal(await index.ready(version.digest, '/'), true);
  const scope = [{ version: version.digest, paths: ['/shared'] }];
  assert.deepEqual((await index.search('统一规则', scope, 0, 1)).map(r => r.path), ['/shared']);
  assert.deepEqual((await index.search('统一规则', scope, 1, 1)).map(r => r.path), ['/shared/child']);
  assert.deepEqual((await index.search('ａｂｃｄ', scope, 0, 10)).map(r => r.path), ['/shared', '/shared/child']);
  assert.deepEqual(await index.search('规则', [], 0, 10), []);
  assert.deepEqual(knowledgeTokens('中文分词'), ['中文', '分词', '文分']);
  const db = new Database(createPool(kit.database, 1));
  t.after(() => db.end());
  await db.query('DELETE FROM knowledge_space_search WHERE version=$1', [version.digest]);
  assert.equal(await index.ready(version.digest, '/'), false, 'a missing projection is detected rather than marked complete');
  await index.add(version.digest, [{ ...row, path: '/private' }, { ...row, path: '/shared' }, { ...row, path: '/shared/child' }, { ...row, path: '/shared-secret' }]);
  assert.equal(await index.ready(version.digest, '/'), true);
});

test('version references reuse one token document and index limits roll back a refused addition',async t=>{
  const kit=await openTestRecords({postgres});t.after(()=>kit.close());
  const db=new Database(createPool(kit.database,1));t.after(()=>db.end());
  const index=new PgSpaceSearchIndex(db,{entryBytes:160,spaceBytes:200});
  const version=await kit.store.put({kind:'knowledge_space_version',schema:'knowledge-space-version@1',provenance:'projected',body:{synthetic:'limited-index'}});
  const first=await kit.store.put({kind:'knowledge_space_entry',schema:'knowledge-space-entry@1',provenance:'declared',body:{synthetic:'first'}});
  const second=await kit.store.put({kind:'knowledge_space_entry',schema:'knowledge-space-entry@1',provenance:'declared',body:{synthetic:'second'}});
  const row={space:'synthetic-limited-space',entry:first.digest,record:first.digest,path:'/',text:'合成全文索引'};
  await index.add(version.digest,[row]);await index.add(version.digest,[{...row,path:'/other',text:undefined}]);
  assert.equal(Number((await db.query('SELECT count(*) AS n FROM knowledge_space_search_documents')).rows[0].n),1);
  assert.equal(Number((await db.query('SELECT count(*) AS n FROM knowledge_space_search')).rows[0].n),2);
  await assert.rejects(index.add(version.digest,[{...row,entry:second.digest,record:second.digest,text:'另一份知识索引'}]),(error:any)=>error.code==='SPACE_INDEX_LIMIT');
  assert.equal(Number((await db.query('SELECT count(*) AS n FROM knowledge_space_search_documents')).rows[0].n),1);
  await assert.rejects(index.add(version.digest,[{...row,entry:second.digest,record:second.digest,text:'abcdefghijklmnopqrstuvxyz'.repeat(2)}]),(error:any)=>error.code==='SPACE_INDEX_LIMIT');
  assert.deepEqual(await index.missing([first.digest,second.digest]),new Set([second.digest]));
});

test('migration 10 consolidates existing version-9 token copies without changing records or search results',async t=>{
  const database=await postgres.createDatabase(undefined,{empty:true});t.after(()=>postgres.dropDatabase(database.database));
  const db=new Database(createPool(database,1));t.after(()=>db.end());await migrate(db,MIGRATIONS.slice(0,9));
  const store=createRecordStore(db,{maxRecordBytes:1024*1024,now:()=>new Date('2026-11-02T00:00:00Z')});
  const old=await store.put({kind:'knowledge_space_entry',schema:'knowledge-space-entry@1',provenance:'declared',body:{synthetic:'version-9-index'}});
  const digest=old.digest;
  await db.query("INSERT INTO knowledge_space_search(version,space,path,entry,record,tokens) VALUES($1,'synthetic','/one',$1,$1,$2),($1,'synthetic','/two',$1,$1,$2)",[digest,knowledgeTokens('合成旧索引')]);
  const previous=(await db.query('SELECT digest,body FROM records')).rows;
  assert.deepEqual(await migrate(db),[10]);assert.deepEqual((await db.query('SELECT digest,body FROM records')).rows,previous);
  assert.equal(Number((await db.query('SELECT count(*) AS n FROM knowledge_space_search_documents')).rows[0].n),1);
  assert.equal((await new PgSpaceSearchIndex(db).search('旧索引',[{version:digest,paths:['/']}],0,10)).length,2);
});

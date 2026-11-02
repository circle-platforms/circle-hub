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
test('pending migrations add a deduplicated full-text projection to a version-8 database', async (t) => {
  const database = await postgres.createDatabase(undefined, { empty: true });
  t.after(() => postgres.dropDatabase(database.database));
  const db = new Database(createPool(database, 1));
  t.after(() => db.end());
  await migrate(db, MIGRATIONS.slice(0, 8));
  const before = (await db.query('SELECT * FROM schema_migrations ORDER BY version')).rows;
  assert.deepEqual(await migrate(db), MIGRATIONS.slice(8).map(m=>m.version));
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
  const total=(await db.query<{bytes:number}>('SELECT token_bytes::int AS bytes FROM knowledge_space_search_totals WHERE version=$1',[version.digest])).rows[0].bytes;
  const document=(await db.query<{bytes:number}>('SELECT token_bytes::int AS bytes FROM knowledge_space_search_documents WHERE record=$1',[entry.digest])).rows[0].bytes;
  assert.equal(total,4*document,'repairing missing references does not double-charge the retained counter');
});

test('version references reuse one token document and index limits roll back a refused addition',async t=>{
  const kit=await openTestRecords({postgres});t.after(()=>kit.close());
  const db=new Database(createPool(kit.database,1));t.after(()=>db.end());
  const index=new PgSpaceSearchIndex(db,{entryBytes:160,spaceBytes:300});
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
  assert.deepEqual(await migrate(db,MIGRATIONS.slice(0,10)),[10]);assert.deepEqual((await db.query('SELECT digest,body FROM records')).rows,previous);
  assert.equal(Number((await db.query('SELECT count(*) AS n FROM knowledge_space_search_documents')).rows[0].n),1);
  assert.equal((await new PgSpaceSearchIndex(db).search('旧索引',[{version:digest,paths:['/']}],0,10)).length,2);
});

test('current-version counters are idempotent and history and product scopes never consume the next version quota',async t=>{
  const kit=await openTestRecords({postgres});t.after(()=>kit.close());
  const db=new Database(createPool(kit.database,1));t.after(()=>db.end());
  const index=new PgSpaceSearchIndex(db,{entryBytes:180,spaceBytes:180});
  const entry=await kit.store.put({kind:'knowledge_space_entry',schema:'knowledge-space-entry@1',provenance:'declared',body:{synthetic:'counter-entry'}});
  let row={space:'team',path:'/notes',entry:entry.digest,record:entry.digest,text:'合成稳定索引'};
  let current='';
  for(let i=0;i<30;i++){
    if(i){const changed=await kit.store.put({kind:'knowledge_space_entry',schema:'knowledge-space-entry@1',provenance:'declared',body:{synthetic:'changed-entry',i}});row={...row,entry:changed.digest,record:changed.digest};}
    const version=await kit.store.put({kind:'knowledge_space_version',schema:'knowledge-space-version@1',provenance:'projected',body:{synthetic:'counter-version',i}});
    current=version.digest;await index.add(current,[row]);await index.add(current,[row]);
  }
  const document=(await db.query('SELECT token_bytes::int AS n FROM knowledge_space_search_documents WHERE record=$1',[row.record])).rows[0].n;
  assert.equal((await db.query('SELECT count(*)::int AS n FROM knowledge_space_search_totals WHERE token_bytes=$1',[document])).rows[0].n,30,'old versions keep their own counters without charging new writes');
  const productVersion=await kit.store.put({kind:'tree_node',schema:'tree-node@1',provenance:'projected',body:{synthetic:'product-version'}});
  const productEntry=await kit.store.put({kind:'tree_node',schema:'tree-node@1',provenance:'declared',body:{synthetic:'product-entry'}});
  await index.add(productVersion.digest,[{...row,entry:productEntry.digest,record:productEntry.digest,path:'/产品/synthetic/1.0/commands'}],undefined,'product:/产品/synthetic/1.0');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM knowledge_space_search_documents')).rows[0].n,31,'retained history and product documents exceed the active quota without blocking the active team version');
  assert.equal((await db.query("SELECT token_bytes::int AS n FROM knowledge_space_search_totals WHERE quota_space='product:/产品/synthetic/1.0'")).rows[0].n,document);
  assert.equal((await index.search('稳定',[{version:current,paths:['/']}],0,10)).length,1);
  await assert.rejects(index.add(current,[{...row,path:'/extra'}]),(error:any)=>error.code==='SPACE_INDEX_LIMIT'&&error.detail.space_limit_bytes===180&&/撤回或替换/.test(error.fix));
  assert.equal((await db.query('SELECT token_bytes::int AS n FROM knowledge_space_search_totals WHERE quota_space=$1 AND version=$2',['team',current])).rows[0].n,document,'a failed addition rolls back its cumulative charge');
  assert.equal((await index.search('稳定',[{version:current,paths:['/']}],0,10)).length,1);
  await assert.rejects(index.add(current,[{...row,path:'/large',text:'abcd'.repeat(2)+'efghijklmnopqrstuvwxyz'.repeat(2),record:productVersion.digest,entry:productVersion.digest}]),(error:any)=>error.code==='SPACE_INDEX_LIMIT'&&error.detail.entry_limit_bytes===180&&/缩短或拆分/.test(error.fix));
  const raised=new PgSpaceSearchIndex(db,{entryBytes:180,spaceBytes:400});
  await raised.add(current,[row,{...row,path:'/extra'}]);await raised.complete(current,'/');
  assert.equal(await raised.ready(current,'/'),true,'a higher configured limit permits the refused work to finish');
  assert.equal((await raised.search('稳定',[{version:current,paths:['/']}],0,10)).length,2);
});

test('migration 11 backfills separate current-version and product counters without changing append-only records',async t=>{
  const database=await postgres.createDatabase(undefined,{empty:true});t.after(()=>postgres.dropDatabase(database.database));
  const db=new Database(createPool(database,1));t.after(()=>db.end());await migrate(db,MIGRATIONS.slice(0,10));
  const store=createRecordStore(db,{maxRecordBytes:1024*1024,now:()=>new Date('2026-11-02T00:00:00Z')});
  const personal=await store.put({kind:'knowledge_space_version',schema:'knowledge-space-version@1',provenance:'projected',body:{synthetic:'upgrade-space'}});
  const product=await store.put({kind:'tree_node',schema:'tree-node@1',provenance:'projected',body:{synthetic:'upgrade-product'}});
  const entry=await store.put({kind:'knowledge_space_entry',schema:'knowledge-space-entry@1',provenance:'declared',body:{synthetic:'upgrade-entry'}});
  await db.query('INSERT INTO knowledge_space_search_documents(record,tokens,token_bytes) VALUES($1,$2,100)',[entry.digest,knowledgeTokens('合成升级索引')]);
  for(const [version,space,path] of [[personal.digest,'synthetic-owner','/notes'],[product.digest,'team','/产品/synthetic/1.0/commands'],[product.digest,'team','/产品/synthetic/1.0/manuals']])
    await db.query('INSERT INTO knowledge_space_search(version,space,path,entry,record) VALUES($1,$2,$3,$4,$4)',[version,space,path,entry.digest]);
  const records=(await db.query('SELECT digest,body FROM records ORDER BY digest')).rows;
  assert.deepEqual(await migrate(db),MIGRATIONS.slice(10).map(m=>m.version));
  assert.deepEqual((await db.query('SELECT digest,body FROM records ORDER BY digest')).rows,records);
  assert.deepEqual((await db.query('SELECT quota_space,token_bytes::int AS n FROM knowledge_space_search_totals ORDER BY quota_space')).rows,[{quota_space:'product:/产品/synthetic/1.0',n:200},{quota_space:'synthetic-owner',n:100}]);
  assert.equal((await new PgSpaceSearchIndex(db).search('升级',[{version:product.digest,paths:['/产品/synthetic/1.0']}],0,10)).length,2);
});

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startPostgres, type TemporaryPostgres } from '../testing/postgres.ts';
import { openTestRecords } from '../testing/records.ts';
import { Database, createPool } from './db.ts';
import { migrate } from './migrations.ts';
import { PgSpaceSearchIndex,knowledgeTokens,pathKey } from './space-index.ts';
import { installTraceSink,startTrace,type SpanRow } from './api.ts';
let postgres: TemporaryPostgres;
before(async () => { postgres = await startPostgres(); });
after(() => postgres?.stop());
test('the baseline installs the deduplicated full-text projection and repeated migration changes nothing', async (t) => {
  const database = await postgres.createDatabase(undefined, { empty: true });
  t.after(() => postgres.dropDatabase(database.database));
  const db = new Database(createPool(database, 1));
  t.after(() => db.end());
  assert.deepEqual(await migrate(db), [1]);
  const before = (await db.query('SELECT * FROM schema_migrations ORDER BY version')).rows;
  assert.deepEqual(await migrate(db), []);
  assert.deepEqual((await db.query('SELECT * FROM schema_migrations ORDER BY version')).rows, before);
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

test('one addition takes the same statements for five rows and for two hundred, and a batch of large documents is split by bytes',async t=>{
  const kit=await openTestRecords({postgres});t.after(()=>kit.close());
  const db=new Database(createPool(kit.database,1));t.after(()=>db.end());
  const index=new PgSpaceSearchIndex(db,{entryBytes:1024*1024,spaceBytes:256*1024*1024});
  const version=await kit.store.put({kind:'knowledge_space_version',schema:'knowledge-space-version@1',provenance:'projected',body:{synthetic:'multi-row'}});
  const entries=async(n:number,tag:string,text:(i:number)=>string)=>Promise.all(Array.from({length:n},async(_,i)=>{const entry=await kit.store.put({kind:'knowledge_space_entry',schema:'knowledge-space-entry@1',provenance:'declared',body:{synthetic:tag,i}});return {space:'synthetic-multi-row',path:'/'+tag,entry:entry.digest,record:entry.digest,text:text(i)};}));
  const statements=async(rows:Awaited<ReturnType<typeof entries>>)=>{
    const spans:SpanRow[]=[];const uninstall=installTraceSink({push:row=>spans.push(row)});
    try{await startTrace({name:'index-knowledge',origin:'background'},()=>index.add(version.digest,rows));}finally{uninstall();}
    return spans.find(span=>span.is_root)!.usage['db.queries'];
  };
  const few=await statements(await entries(5,'few',i=>'合成少量'+i)),many=await statements(await entries(200,'many',i=>'合成批量'+i));
  assert.equal(many,few,'BEGIN, the lock, the missing documents, one insert, the largest document, one insert of references, COMMIT');
  assert.equal((await db.query<{n:number}>('SELECT count(*)::int AS n FROM knowledge_space_search_documents')).rows[0].n,205);
  const wide=(i:number)=>Array.from({length:40000},(_,k)=>String.fromCodePoint(0x4e00+(i*7+k)%0x5000)).join('');
  assert.equal(await statements(await entries(8,'wide',wide)),few!+1,'about 200 KB of tokens each, 1.6 MB in all: a statement holds at most 1 MiB');
});

test('states answer in order from stored rows, and a refusal holds until its limit rises',async t=>{
  const kit=await openTestRecords({postgres});t.after(()=>kit.close());
  const db=new Database(createPool(kit.database,1));t.after(()=>db.end());
  const put=(kind:'knowledge_space_version'|'knowledge_space_entry',synthetic:string)=>kit.store.put({kind,schema:kind==='knowledge_space_version'?'knowledge-space-version@1':'knowledge-space-entry@1',provenance:'projected',body:{synthetic}});
  const ready=await put('knowledge_space_version','states-ready'),pending=await put('knowledge_space_version','states-pending'),over=await put('knowledge_space_version','states-over'),entry=await put('knowledge_space_entry','states-entry');
  const index=new PgSpaceSearchIndex(db,{spaceBytes:100,productBytes:300});
  const row={space:'team',path:'/notes',entry:entry.digest,record:entry.digest,text:'合成状态'};
  await index.add(ready.digest,[row]);await index.complete(ready.digest,'/');
  const scopes=[{version:ready.digest,path:'/',quotaSpace:'team'},{version:pending.digest,path:'/',quotaSpace:'team'},{version:over.digest,path:'/产品/synthetic/1.0',quotaSpace:'product:/产品/synthetic/1.0'}];
  const strict=new PgSpaceSearchIndex(db,{productBytes:90});
  const passed=await strict.add(over.digest,[{...row,path:'/产品/synthetic/1.0/x'}],undefined,scopes[2].quotaSpace).then(()=>null,error=>error);
  assert.equal(passed?.code,'SPACE_INDEX_LIMIT');assert.match(passed.fix,/CIRCLE_HUB_MAX_PRODUCT_INDEX_BYTES/);
  await strict.refuse(over.digest,scopes[2].quotaSpace,passed);
  assert.deepEqual((await strict.states(scopes)).map(state=>[state.ready,state.refused?.code??null]),[[true,null],[false,null],[false,'SPACE_INDEX_LIMIT']]);
  assert.deepEqual((await index.states(scopes)).map(state=>state.refused?.code??null),[null,null,null],'a higher limit needs no write');
  const lowered=new PgSpaceSearchIndex(db,{spaceBytes:50}),repair=await lowered.add(ready.digest,[{...row,path:'/more'}]).then(()=>null,error=>error);
  await lowered.refuse(ready.digest,'team',repair);
  assert.deepEqual((await lowered.states(scopes.slice(0,1))).map(state=>[state.ready,state.refused?.code??null]),[[true,'SPACE_INDEX_LIMIT']],'a ready version says both: what to do about them is the reader\'s');
  assert.deepEqual(await index.states([]),[]);
  assert.deepEqual(await index.present(ready.digest,[{path:'/notes',entry:entry.digest},{path:'/other',entry:entry.digest}]),new Set([pathKey({path:'/notes',entry:entry.digest})]));
});

test('an entry over the limit is its writer\'s to shorten, and in a product the administrator\'s limit to raise',async t=>{
  const kit=await openTestRecords({postgres});t.after(()=>kit.close());
  const db=new Database(createPool(kit.database,1));t.after(()=>db.end());
  const put=(kind:'knowledge_space_version'|'knowledge_space_entry',synthetic:string)=>kit.store.put({kind,schema:kind==='knowledge_space_version'?'knowledge-space-version@1':'knowledge-space-entry@1',provenance:'projected',body:{synthetic}});
  const member=await put('knowledge_space_version','entry-member'),product=await put('knowledge_space_version','entry-product'),entry=await put('knowledge_space_entry','entry-large');
  const index=new PgSpaceSearchIndex(db,{entryBytes:100}),text=Array.from({length:40},(_,k)=>String.fromCodePoint(0x4e00+k)).join('');
  const passed=await index.add(member.digest,[{space:'member',path:'/large',entry:entry.digest,record:entry.digest,text}]).then(()=>null,error=>error);
  assert.equal(passed?.code,'SPACE_INDEX_LIMIT');
  const scopes=[{version:member.digest,path:'/',quotaSpace:'member'},{version:product.digest,path:'/产品/synthetic/1.0',quotaSpace:'product:/产品/synthetic/1.0'}];
  for(const scope of scopes)await index.refuse(scope.version,scope.quotaSpace,passed);
  const [own,mounted]=await index.states(scopes);
  assert.match(own.refused?.fix??'',/缩短或拆分当前条目/);
  assert.match(mounted.refused?.fix??'',/由管理员调高 CIRCLE_HUB_MAX_ENTRY_INDEX_BYTES 并重启 Hub/);
  assert.doesNotMatch(mounted.refused?.fix??'',/缩短|拆分/);
  assert.equal(mounted.refused?.code,'SPACE_INDEX_LIMIT');assert.equal(mounted.refused?.message,own.refused?.message);
  assert.deepEqual(mounted.refused?.detail,own.refused?.detail);
});

test('product mounts have their own limit, above what a member can write to a space',async t=>{
  const kit=await openTestRecords({postgres});t.after(()=>kit.close());
  const db=new Database(createPool(kit.database,1));t.after(()=>db.end());
  const index=new PgSpaceSearchIndex(db,{entryBytes:1024,spaceBytes:100,productBytes:1024});
  const space=await kit.store.put({kind:'knowledge_space_version',schema:'knowledge-space-version@1',provenance:'projected',body:{synthetic:'limit-space'}});
  const product=await kit.store.put({kind:'tree_node',schema:'tree-node@1',provenance:'projected',body:{synthetic:'limit-product'}});
  const entry=await kit.store.put({kind:'knowledge_space_entry',schema:'knowledge-space-entry@1',provenance:'declared',body:{synthetic:'limit-entry'}});
  const row={space:'team',path:'/产品/synthetic/1.0/x',entry:entry.digest,record:entry.digest,text:'合成产品与空间的额度'};
  await index.add(product.digest,[row],undefined,'product:/产品/synthetic/1.0');
  await assert.rejects(index.add(space.digest,[row]),(error:any)=>error.code==='SPACE_INDEX_LIMIT'&&/撤回或替换/.test(error.fix));
});

test('current index writes deduplicate document tokens without changing records or search results',async t=>{
  const kit=await openTestRecords({postgres});t.after(()=>kit.close());
  const db=new Database(createPool(kit.database,1));t.after(()=>db.end());
  const entry=await kit.store.put({kind:'knowledge_space_entry',schema:'knowledge-space-entry@1',provenance:'declared',body:{synthetic:'baseline-index'}});
  const version=await kit.store.put({kind:'knowledge_space_version',schema:'knowledge-space-version@1',provenance:'projected',body:{synthetic:'baseline-index-version'}});
  const previous=(await db.query('SELECT digest,body FROM records ORDER BY digest')).rows;
  const index=new PgSpaceSearchIndex(db),rows=['/one','/two'].map(path=>({space:'synthetic',path,entry:entry.digest,record:entry.digest,text:'合成去重索引'}));
  await index.add(version.digest,rows);await index.add(version.digest,rows);
  assert.deepEqual((await db.query('SELECT digest,body FROM records ORDER BY digest')).rows,previous);
  assert.equal(Number((await db.query('SELECT count(*) AS n FROM knowledge_space_search_documents')).rows[0].n),1);
  assert.equal((await index.search('去重索引',[{version:version.digest,paths:['/']}],0,10)).length,2);
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

test('current index writes separate version and product counters without changing append-only records',async t=>{
  const kit=await openTestRecords({postgres});t.after(()=>kit.close());
  const db=new Database(createPool(kit.database,1));t.after(()=>db.end());
  const personal=await kit.store.put({kind:'knowledge_space_version',schema:'knowledge-space-version@1',provenance:'projected',body:{synthetic:'baseline-space'}});
  const product=await kit.store.put({kind:'tree_node',schema:'tree-node@1',provenance:'projected',body:{synthetic:'baseline-product'}});
  const entry=await kit.store.put({kind:'knowledge_space_entry',schema:'knowledge-space-entry@1',provenance:'declared',body:{synthetic:'baseline-entry'}});
  const records=(await db.query('SELECT digest,body FROM records ORDER BY digest')).rows;
  const index=new PgSpaceSearchIndex(db),row={entry:entry.digest,record:entry.digest,text:'合成分离索引'};
  const personalRows=[{...row,space:'synthetic-owner',path:'/notes'}];
  const productRows=['commands','manuals'].map(path=>({...row,space:'team',path:'/产品/synthetic/1.0/'+path}));
  for(let i=0;i<2;i++){
    await index.add(personal.digest,personalRows);
    await index.add(product.digest,productRows,undefined,'product:/产品/synthetic/1.0');
  }
  assert.deepEqual((await db.query('SELECT digest,body FROM records ORDER BY digest')).rows,records);
  const bytes=(await db.query('SELECT token_bytes::int AS n FROM knowledge_space_search_documents WHERE record=$1',[entry.digest])).rows[0].n;
  assert.ok(bytes>0);
  assert.deepEqual((await db.query('SELECT quota_space,token_bytes::int AS n FROM knowledge_space_search_totals ORDER BY quota_space')).rows,[{quota_space:'product:/产品/synthetic/1.0',n:bytes*2},{quota_space:'synthetic-owner',n:bytes}]);
  assert.equal((await index.search('分离索引',[{version:product.digest,paths:['/产品/synthetic/1.0']}],0,10)).length,2);
});

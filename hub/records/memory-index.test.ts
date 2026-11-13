// The current memory projection counts retained context, preserves history and rebuilds without rewriting records.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {MemoryDocumentBody,MemoryVersionBody} from '../../contracts/src/memory.ts';
import {startPostgres} from '../testing/postgres.ts';
import {Database,createPool} from './db.ts';
import {migrate} from './migrations.ts';
import {PgRecordStore} from './store.ts';
import {PgMemoryIndex} from './memory-index.ts';
import {newId,canonicalize} from './api.ts';

test('the baseline memory projection counts titles and paths and rebuilds without rewriting records',async t=>{
 const postgres=await startPostgres(),config=await postgres.createDatabase(undefined,{empty:true}),db=new Database(createPool(config,2));
 t.after(async()=>{await db.end();await postgres.dropDatabase(config.database);await postgres.stop();});
 assert.deepEqual(await migrate(db),[1]);
 const index=new PgMemoryIndex(db);
 const store=new PgRecordStore(db,{maxRecordBytes:65536,now:()=>new Date('2026-11-02T00:00:00.000Z')}),by=newId('usr'),at='2026-11-02T00:00:00.000Z',heads=[],title='合成\0标题\\u0000',markdown='甲\0',bodyBytes=Buffer.byteLength(markdown);let history=0;
 for(const state of ['enabled','disabled'] as const){
  const identity=MemoryDocumentBody.parse({space:'team',by,at,intent:(state==='enabled'?'a':'b').repeat(64)});
  const document=await store.put({kind:'memory_document',schema:'memory-document@1',provenance:'declared',body:identity});
  const body=MemoryVersionBody.parse({space:'team',document:document.digest,title,path:'/旧目录',state,bytes:bodyBytes,markdown,parent:null,content_version:null,by,at,intent:identity.intent,payload:'c'.repeat(64)});
  const version=await store.put({kind:'memory_version',schema:'memory-version@1',provenance:'declared',body});
  history+=Buffer.byteLength(canonicalize(identity))+Buffer.byteLength(canonicalize(body));
  const head={document:document.digest,space:'team',version:version.digest,path:body.path,state,bytes:body.bytes,contextBytes:Buffer.byteLength(title+body.path+markdown)};
  await db.transaction(tx=>index.apply(head,Buffer.byteLength(canonicalize(identity))+Buffer.byteLength(canonicalize(body)),tx));heads.push(head);
 }
 assert.deepEqual(await migrate(db),[]);
 const bytes=Buffer.byteLength(title+'/旧目录'+markdown);
 assert.deepEqual(await index.usage('team'),{active:bytes,activeDocuments:1,history});
 assert.equal((await index.heads('team')).length,2);
 const before=(await db.query('SELECT digest,body FROM records ORDER BY digest')).rows;
 await db.transaction(tx=>index.rebuild('team',heads,history,tx));
 await db.transaction(tx=>index.rebuild('team',heads,history,tx));
 assert.deepEqual((await db.query('SELECT digest,body FROM records ORDER BY digest')).rows,before);
 assert.deepEqual(await index.usage('team'),{active:bytes,activeDocuments:1,history});
 assert.ok((await index.heads('team')).every(head=>head.contextBytes===bytes));
 for(const head of heads){const version=await store.get<MemoryVersionBody>(head.version);assert.equal(version?.body.title,title);assert.equal(version?.body.markdown,markdown);}
});

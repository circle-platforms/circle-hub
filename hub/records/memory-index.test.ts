// Upgrades preserve append-only rows and rebuild the expanded context/count projection once.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {MemoryDocumentBody,MemoryVersionBody} from '../../contracts/src/memory.ts';
import {startPostgres} from '../testing/postgres.ts';
import {Database,createPool} from './db.ts';
import {MIGRATIONS,migrate} from './migrations.ts';
import {PgRecordStore} from './store.ts';
import {PgMemoryIndex} from './memory-index.ts';
import {newId,canonicalize} from './api.ts';

test('migration 13 counts retained titles and paths, preserves history and keeps old records readable',async t=>{
 const postgres=await startPostgres(),config=await postgres.createDatabase(undefined,{empty:true}),db=new Database(createPool(config,2));
 t.after(async()=>{await db.end();await postgres.dropDatabase(config.database);await postgres.stop();});
 await migrate(db,MIGRATIONS.filter(migration=>migration.version<13));
 const store=new PgRecordStore(db,{maxRecordBytes:65536,now:()=>new Date('2026-11-02T00:00:00.000Z')}),by=newId('usr'),at='2026-11-02T00:00:00.000Z',heads=[],title='合成\0标题\\u0000',markdown='甲\0',bodyBytes=Buffer.byteLength(markdown);let history=0;
 for(const state of ['enabled','disabled'] as const){
  const identity=MemoryDocumentBody.parse({space:'team',by,at,intent:(state==='enabled'?'a':'b').repeat(64)});
  const document=await store.put({kind:'memory_document',schema:'memory-document@1',provenance:'declared',body:identity});
  const body=MemoryVersionBody.parse({space:'team',document:document.digest,title,path:'/旧目录',state,bytes:bodyBytes,markdown,parent:null,content_version:null,by,at,intent:identity.intent,payload:'c'.repeat(64)});
  const version=await store.put({kind:'memory_version',schema:'memory-version@1',provenance:'declared',body});
  history+=Buffer.byteLength(canonicalize(identity))+Buffer.byteLength(canonicalize(body));
  await db.query('INSERT INTO memory_heads(document,space,version,path,state,bytes) VALUES($1,$2,$3,$4,$5,$6)',[document.digest,'team',version.digest,body.path,state,body.bytes]);heads.push({document:document.digest,version:version.digest});
 }
 await db.query('INSERT INTO memory_space_usage(space,active_bytes,history_bytes) VALUES($1,$2,$3)',['team',bodyBytes,history]);
 assert.deepEqual(await migrate(db),MIGRATIONS.filter(migration=>migration.version>=13).map(migration=>migration.version));
 assert.deepEqual(await migrate(db),[]);
 const index=new PgMemoryIndex(db),bytes=Buffer.byteLength(title+'/旧目录'+markdown);
 assert.deepEqual(await index.usage('team'),{active:bytes,activeDocuments:1,history});
 assert.ok((await index.heads('team')).every(head=>head.contextBytes===bytes));
 for(const head of heads){const version=await store.get<MemoryVersionBody>(head.version);assert.equal(version?.body.title,title);assert.equal(version?.body.markdown,markdown);}
});

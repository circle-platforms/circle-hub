// Synthetic historical DAG: startup work scales with unique scoped nodes, not the sum of every historical traversal.
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {test} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Database,createPool} from './db.ts';
import {migrate,MIGRATIONS} from './migrations.ts';
import {canonicalize} from './canonical.ts';
import {recordDigest,sha256Hex} from './digest.ts';
import {newId} from './ids.ts';
import {PgPrincipals} from './principals.ts';
import {PgRecordStore} from './store.ts';
import {FileObjectStore} from './objects.ts';
import {DEFAULT_LIMITS} from '../config/index.ts';
import {startPostgres} from '../testing/postgres.ts';
import {INITIAL_PERSONAL_EPOCH} from './personal-payloads.ts';

test('1200 historical versions and 8000 unrelated holders copy each scoped DAG node once with indexed retirement lookups',{timeout:60_000},async t=>{
 const postgres=await startPostgres();t.after(()=>postgres.stop());const database=await postgres.createDatabase(undefined,{empty:true}),db=new Database(createPool(database));t.after(()=>db.end());
 const dataDir=await mkdtemp(join(tmpdir(),'synthetic-retirement-bounds-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));
 await migrate(db,MIGRATIONS.slice(0,13));const at='2026-11-03T00:00:00.000Z',clock=()=>new Date(at);
 const principals=new PgPrincipals(db,clock),{user}=await principals.bootstrapAdmin('synthetic-owner'),other=await principals.createUser(user,'synthetic-other');
 const files=new FileObjectStore(join(dataDir,'objects'),db,{maxBytes:DEFAULT_LIMITS.maxUploadBytes,now:clock});
 const put=async(body:unknown)=>(await files.put(Buffer.from(canonicalize(body)),'application/json')).sha256;
 const shared=await put({name:'shared',children:[],entries:[]});
 const a=await put({name:'a',children:[{name:'shared',digest:shared}],entries:[]}),b=await put({name:'b',children:[{name:'shared',digest:shared}],entries:[]});
 const root=await put({name:'',children:[{name:'a',digest:a},{name:'b',digest:b}],entries:[]}),nodes=new Set([root,a,b,shared]);
 async function old(kind:string,schema:string,body:unknown){const text=canonicalize(body),digest=recordDigest({kind,schema,provenance:'declared',created_at:at,body});
  await db.query('INSERT INTO records(id,digest,kind,schema,provenance,created_at,body,size) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[newId('rcd'),digest,kind,schema,'declared',at,text,Buffer.byteLength(text)]);return digest;
 }
 let parent:string|null=null;
 for(let n=0;n<1200;n++)parent=await old('knowledge_space_version','knowledge-space-version@1',{space:user.id,parent,tree:root,sources:[],products:[],directories:['/','/a','/a/shared','/b','/b/shared'],entries:[],by:user.id,at,reason:'synthetic-history',used_bytes:n});
 await old('knowledge_space_version','knowledge-space-version@1',{space:other.id,parent:null,tree:root,sources:[],products:[],directories:['/','/a','/a/shared','/b','/b/shared'],entries:[],by:other.id,at,reason:'synthetic-other',used_bytes:1});
 for(let n=0;n<8000;n++)await old('authorization','authorization@1',{bound:sha256Hex('synthetic-unrelated-'+n)});
 const migrationStart=performance.now();await migrate(db);const migrationMs=performance.now()-migrationStart;
 const store=new PgRecordStore(db,{maxRecordBytes:DEFAULT_LIMITS.maxRecordBytes,now:clock}),objects=new FileObjectStore(join(dataDir,'objects'),db,{maxBytes:DEFAULT_LIMITS.maxUploadBytes,now:clock,personalPayloads:store.personalPayloads});
 const counts=new Map<string,number>(),get=objects.get.bind(objects);objects.get=async hash=>{if(nodes.has(hash))counts.set(hash,(counts.get(hash)??0)+1);return get(hash);};
 const startupStart=performance.now();await objects.materializePersonalObjects();const startupMs=performance.now()-startupStart,reads=[...counts.values()].reduce((sum,n)=>sum+n,0);
 t.diagnostic(JSON.stringify({histories:1200,unrelated:8000,uniqueNodes:nodes.size,owners:2,reads,migrationMs,startupMs}));
 assert.ok(reads<=nodes.size*2,'each account needs one real copy; repeated historical roots must not multiply reads');
 assert.equal((await db.query('SELECT count(*)::int AS n FROM personal_objects WHERE sha256=ANY($1::text[])',[[...nodes]])).rows[0].n,8,'separate owners still receive separate payloads');
 assert.equal((await db.query('SELECT 1 FROM object_holds h JOIN personal_record_bindings b ON b.record=h.record WHERE NOT h.artifact')).rowCount,0,'converted private rows do not bloat the independent-holder index');
 await db.query('ANALYZE object_holds');
 const plan=(await db.query('EXPLAIN (ANALYZE,FORMAT JSON) SELECT 1 FROM object_holds WHERE NOT artifact AND sha256=$1 LIMIT 1',[root])).rows[0]['QUERY PLAN'];
 assert.match(JSON.stringify(plan),/object_holds_target/);
 await store.personalPayloads.purge(user,INITIAL_PERSONAL_EPOCH);assert.ok(await store.personalPayloads.get({owner:other.id,epoch:INITIAL_PERSONAL_EPOCH},root));
});

// Independently owned storage fields survive personal retirement; synthetic fixtures adapted from the review probes.
import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {mkdtemp,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Database,createPool} from './db.ts';
import {migrate,MIGRATIONS} from './migrations.ts';
import {canonicalize} from './canonical.ts';
import {recordDigest} from './digest.ts';
import {newId} from './ids.ts';
import {PgPrincipals} from './principals.ts';
import {FileObjectStore} from './objects.ts';
import {openRecords} from './index.ts';
import {DEFAULT_LIMITS} from '../config/index.ts';
import {startPostgres} from '../testing/postgres.ts';
import {INITIAL_PERSONAL_EPOCH} from './personal-payloads.ts';
let postgres:Awaited<ReturnType<typeof startPostgres>>;
before(async()=>{postgres=await startPostgres();});after(()=>postgres?.stop());
for(const holder of ['authorization','pack-file','personal-pack','memo','list','feeding-cache','feeding-object','executor-snapshot','composition','run-source'] as const)test(`retirement preserves the exact independent ${holder} storage reference`,async t=>{
 const database=await postgres.createDatabase(undefined,{empty:true}),db=new Database(createPool(database));t.after(()=>db.end());
 const dataDir=await mkdtemp(join(tmpdir(),'synthetic-held-upgrade-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));
 await migrate(db,MIGRATIONS.slice(0,13));const at='2026-11-03T00:00:00.000Z',clock=()=>new Date(at);
 const principals=new PgPrincipals(db,clock),{user:admin}=await principals.bootstrapAdmin('synthetic-admin'),owner=await principals.createUser(admin,'synthetic-owner');
 async function old(kind:string,schema:string,body:unknown){const text=canonicalize(body),digest=recordDigest({kind,schema,provenance:'declared',created_at:at,body});
  await db.query('INSERT INTO records(id,digest,kind,schema,provenance,created_at,body,size) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[newId('rcd'),digest,kind,schema,'declared',at,text,Buffer.byteLength(text)]);return digest;
 }
 const objects=new FileObjectStore(join(dataDir,'objects'),db,{maxBytes:DEFAULT_LIMITS.maxUploadBytes,now:clock});
 const bytes=Buffer.from(canonicalize({id:'synthetic-definition',steps:['synthetic']})),hash=(await objects.put(bytes,'application/json')).sha256;
 const artifact=await old('source_artifact','source_artifact@1',{sha256:hash,size:bytes.length,media_type:'application/json',name:'synthetic.json',origin:{upload:{session:null,message:null}},author:{user:owner.id,declared:null},provenance_type:'declared',captured_at:at,read_tier:'model_readable',visibility:{readers:[owner.id],admins:false,packs:[],shareable:false},scan:{scanner:'credential-scan@3',inspected:true,clean:true,findings:[],truncated:false}});
 await old('knowledge_space_source','knowledge-space-source@1',{space:owner.id,path:'/',sha256:hash,artifact,size:bytes.length,by:owner.id,at});
 switch(holder){
  case 'run-source':await old('run','run@1',{run:'run_'+'0'.repeat(26),sources:[{reference:'src:'+hash,artifact}]});break;
  case 'authorization':await old('authorization','authorization@1',{bound:hash,by:admin.id,at});break;
  case 'pack-file':await old('pack_version','pack-version@1',{manifest:{files:[{path:'synthetic.json',sha256:hash}]}});break;
  case 'personal-pack':await old('personal_pack_version','personal-pack-version@1',{space:owner.id,files:{'synthetic.json':artifact},manifest:{files:[{path:'synthetic.json',sha256:hash}]}});break;
  case 'memo':await old('action','action@1',{component:'knowledge.producer@1',detail:{output:{sha256:hash}}});break;
  case 'list':await old('action','action@1',{component:'knowledge.produce@1',detail:{lists:[{externals:hash}]}});break;
  case 'feeding-cache':await old('action','action@1',{component:'hub.feeding@2',detail:{sha256:hash}});break;
  case 'feeding-object':{const claim=await old('claim','claim@1',{statement:{data:{feeding:{object:hash}}}});await db.query("INSERT INTO record_index(digest,record_seq,key,value) SELECT digest,seq,'knowledge.feeding.object',$2 FROM records WHERE digest=$1",[claim,hash]);break;}
  case 'executor-snapshot':{const map=(await objects.put(Buffer.from(canonicalize({synthetic:hash})),'application/json')).sha256;await old('run','run@1',{executors:map});break;}
  case 'composition':await old('tree_root','tree_root@1',{sources:[{sha256:hash,artifact}]});break;
 }
 await migrate(db);
 const kit=await openRecords({database,dataDir,logDir:join(dataDir,'logs'),limits:{...DEFAULT_LIMITS}},{migrate:false});t.after(()=>kit.close());
 await access(objects.path(hash));
 if(holder==='personal-pack'||holder==='composition'||holder==='run-source')assert.equal(await kit.personalPayloads!.inspect(artifact),null,'a non-space record owns this artifact too');
 await kit.personalPayloads!.purge(owner,INITIAL_PERSONAL_EPOCH);
 await access(objects.path(hash));assert.deepEqual(Buffer.from((await kit.objects.get(hash))!),bytes);
 if(holder==='personal-pack'||holder==='composition'||holder==='run-source')assert.ok(await kit.store.get(artifact));
});

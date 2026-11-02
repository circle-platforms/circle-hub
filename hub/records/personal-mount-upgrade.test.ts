// Synthetic first-start upgrade: directory object children and mounted product record roots have distinct homes.
import assert from 'node:assert/strict';
import {test} from 'node:test';
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

for(const mounted of [false,true])test(`legacy retirement completes across restarts with a team product mount: ${mounted}`,async t=>{
 const postgres=await startPostgres();t.after(()=>postgres.stop());const database=await postgres.createDatabase(undefined,{empty:true});
 const db=new Database(createPool(database));t.after(()=>db.end());
 const dataDir=await mkdtemp(join(tmpdir(),'synthetic-mount-upgrade-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));
 await migrate(db,MIGRATIONS.slice(0,13));const at='2026-11-03T00:00:00.000Z';
 const {user}=await new PgPrincipals(db,()=>new Date(at)).bootstrapAdmin('synthetic-owner');
 async function old(kind:string,schema:string,body:unknown){
  const meta={kind,schema,provenance:'projected',created_at:at},digest=recordDigest({...meta,body}),text=canonicalize(body);
  await db.query('INSERT INTO records(id,digest,kind,schema,provenance,created_at,body,size) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[newId('rcd'),digest,kind,schema,'projected',at,text,Buffer.byteLength(text)]);return digest;
 }
 const objects=new FileObjectStore(join(dataDir,'objects'),db,{maxBytes:DEFAULT_LIMITS.maxUploadBytes,now:()=>new Date(at)});
 const put=async(body:unknown)=>(await objects.put(Buffer.from(canonicalize(body)),'application/json')).sha256;
 const leaf=await put({name:'synthetic-private-folder',children:[],entries:[]});
 const root=await put({name:'',children:[{name:'synthetic-private-folder',digest:leaf}],entries:[]});
 const personal=await old('knowledge_space_version','knowledge-space-version@1',{space:user.id,parent:null,tree:root,sources:[],products:[],directories:['/','/synthetic-private-folder'],entries:[],by:user.id,at,reason:'synthetic',used_bytes:1});
 const mountRoot=await old('tree_node','tree-node@1',{name:'synthetic-product-root'});
 const products=mounted?[{product:'synthetic-product',line:'v1',path:'/产品/synthetic-product/v1',root:mountRoot}]:[];
 const line=await put({name:'synthetic-product',children:mounted?[{name:'v1',digest:mountRoot}]:[],entries:[]});
 const productDir=await put({name:'产品',children:[{name:'synthetic-product',digest:line}],entries:[]});
 const teamTree=await put({name:'',children:[{name:'产品',digest:productDir}],entries:[]});
 const team=await old('knowledge_space_version','knowledge-space-version@1',{space:'team',parent:null,tree:teamTree,sources:[],products,directories:['/','/产品','/产品/synthetic-product',...(mounted?['/产品/synthetic-product/v1']:[])],entries:[],by:null,at,reason:'synthetic-team',used_bytes:0});
 await migrate(db);assert.equal(await objects.stat(mountRoot),null);
 const config={database,dataDir,logDir:join(dataDir,'logs'),limits:{...DEFAULT_LIMITS}};
 for(let n=0;n<2;n++){
  const kit=await openRecords(config,{migrate:false});try{
   assert.ok(await kit.store.get(mountRoot));assert.ok(await kit.store.get(team));assert.ok(await kit.store.get(personal));
   assert.ok(await kit.objects.get(teamTree));assert.ok(await kit.objects.get(root));
  }finally{await kit.close();}
 }
 await access(objects.path(teamTree));await assert.rejects(access(objects.path(root)));
 assert.equal((await db.query('SELECT count(*)::int AS n FROM personal_legacy_retire q WHERE NOT EXISTS(SELECT 1 FROM personal_legacy_retired d WHERE d.sha256=q.sha256)')).rows[0].n,0);
});

import {PgPersonalPayloads} from './personal-payloads.ts';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {Database,createPool} from './db.ts';
import {migrate,MIGRATIONS,grantRuntime} from './migrations.ts';
import {canonicalize} from './canonical.ts';
import {recordDigest,sha256Hex} from './digest.ts';
import {newId} from './ids.ts';
import {PgPrincipals} from './principals.ts';
import {FileObjectStore} from './objects.ts';
import {openRecords} from './index.ts';
import {DEFAULT_LIMITS} from '../config/index.ts';
import {startPostgres} from '../testing/postgres.ts';
import {INITIAL_PERSONAL_EPOCH} from './personal-payloads.ts';

for(const independent of [false,true])test(`version 13 personal bodies and originals retain row identities through scoped conversion; independent copy ${independent}`,async t=>{
 const postgres=await startPostgres();t.after(()=>postgres.stop());
 const database=await postgres.createDatabase(undefined,{empty:true});
 const db=new Database(createPool(database));t.after(()=>db.end());
 const dir=await mkdtemp(join(tmpdir(),'synthetic-personal-upgrade-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 await migrate(db,MIGRATIONS.slice(0,13));
 const {user}=await new PgPrincipals(db,()=>new Date('2026-11-02T00:00:00.000Z')).bootstrapAdmin('synthetic-owner');
 const at='2026-11-02T00:00:00.000Z',rows:Array<{digest:string;body:unknown;kind:string}>=[];
 async function old(kind:string,schema:string,body:unknown){
  const meta={kind,schema,provenance:'declared',created_at:at},digest=recordDigest({...meta,body}),text=canonicalize(body);
  await db.query('INSERT INTO records(id,digest,kind,schema,provenance,created_at,body,size) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[newId('rcd'),digest,kind,schema,'declared',at,text,Buffer.byteLength(text)]);
  rows.push({digest,body,kind});return digest;
 }
 const objects=new FileObjectStore(join(dir,'objects'),db,{maxBytes:DEFAULT_LIMITS.maxUploadBytes,now:()=>new Date(at)});
 const original=await objects.put(Buffer.from('synthetic-private-original\r\né'),'text/plain');
 const capture={sha256:original.sha256,size:original.size,media_type:'text/plain',name:'synthetic-private-name',origin:{upload:{session:'synthetic'}},author:{user:user.id},provenance_type:'declared',captured_at:at,read_tier:'model_readable',visibility:{readers:[user.id],admins:false,packs:[],shareable:false},scan:{scanner:'credential-scan@3',inspected:true,clean:true,findings:[],truncated:false}};
 const artifact=await old('source_artifact','source_artifact@1',capture);
 const source=await old('knowledge_space_source','knowledge-space-source@1',{space:user.id,path:'/synthetic-private-folder',sha256:original.sha256,artifact,size:original.size,by:user.id,at});
 const node=await objects.put(Buffer.from(canonicalize({name:'synthetic-private-folder',children:[],entries:[]})),'application/json');
 await old('knowledge_space_version','knowledge-space-version@1',{space:user.id,parent:null,tree:node.sha256,sources:[source],products:[],directories:['/','/synthetic-private-folder'],entries:[],by:user.id,at,reason:'synthetic-private-reason',used_bytes:original.size});
 await old('knowledge_space_entry','knowledge-space-entry@1',{space:user.id,entry:sha256Hex('entry'),content:{kind:'definition',statement:'synthetic-private-statement',data:{},applicability:null},grounds:[{reference:'src:'+original.sha256,quotation:'synthetic-private-original'}],status:'verified',by:user.id,at,session:null,replaces:null});
 await old('knowledge_space_grant','knowledge-space-grant@1',{space:user.id,path:'/synthetic-private-folder',audience:'administrators',member:null,action:'grant',by:user.id,at});
 const document=await old('memory_document','memory-document@1',{space:user.id,by:user.id,at,intent:sha256Hex('document')});
 await old('memory_version','memory-version@1',{space:user.id,document,parent:null,title:'synthetic-private-memory',path:'/synthetic-private-folder',state:'enabled',bytes:8,markdown:'private\0',content_version:null,by:user.id,at,intent:sha256Hex('version'),payload:sha256Hex('body')});
 await old('memory_grant','memory-grant@1',{space:user.id,path:'/synthetic-private-folder',audience:'administrators',member:null,action:'grant',by:user.id,at,intent:sha256Hex('grant')});
 const team=await old('memory_version','memory-version@1',{...rows.at(-2)!.body as object,space:'team'});
 let teamOriginal:string|undefined,teamTree:string|undefined;
 if(independent){
  teamOriginal=await old('source_artifact','source_artifact@1',{...capture,name:'independent-team-original',visibility:{...capture.visibility,admins:true}});
  const root=await objects.put(Buffer.from(canonicalize({name:'',children:[{name:'synthetic-private-folder',digest:node.sha256}],entries:[]})),'application/json');
  teamTree=await old('knowledge_space_version','knowledge-space-version@1',{space:'team',parent:null,tree:root.sha256,sources:[],products:[],directories:['/','/synthetic-private-folder'],entries:[],by:user.id,at,reason:'independent',used_bytes:0});
 }
 if(!independent){
  const probeRole='synthetic_probe_'+randomBytes(4).toString('hex');await db.query(`CREATE ROLE ${probeRole} NOLOGIN`);
  const rollback=new Error('synthetic rollback of exemption probe');
  await assert.rejects(db.transaction(async tx=>{
    await db.query(MIGRATIONS[13].sql.split('SELECT hub_personal_migrate_inline();')[0],[],tx);
    const payloads=new PgPersonalPayloads(db,async()=>{}),row=rows.find(r=>r.kind==='memory_version')!;
    const marker=await payloads.bind(await payloads.scope(user.id,tx),row.digest,{created_at:at,kind:row.kind,provenance:'declared',schema:'memory-version@1'},canonicalize(row.body),tx);
    await db.query(`GRANT SELECT,UPDATE(body) ON records TO ${probeRole}`,[],tx);
    await db.query(`GRANT SELECT ON schema_migrations,personal_record_bindings,personal_payloads TO ${probeRole}`,[],tx);
    await db.query(`SET LOCAL ROLE ${probeRole}`,[],tx);
    await db.query("CREATE TEMP TABLE pg_class(oid oid,relowner oid)",[],tx);
    await db.query("INSERT INTO pg_class VALUES('public.records'::regclass,(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user))",[],tx);
    await db.query("CREATE TEMP TABLE schema_migrations(version integer)",[],tx);
    await db.query("SELECT set_config('circle_hub.personal_layout_conversion','14',true)",[],tx);
    await db.query('SAVEPOINT runtime_exemption',[],tx);
    await assert.rejects(db.query('UPDATE records SET body=$1 WHERE digest=$2',[marker,row.digest],tx),(e:unknown)=>(e as {code:string}).code==='HU001');
    await db.query('ROLLBACK TO SAVEPOINT runtime_exemption',[],tx);await db.query('RESET ROLE',[],tx);
    const teamRow=rows.find(r=>r.digest===team)!;
    const teamMarker=await payloads.bind(await payloads.scope(user.id,tx),team,{created_at:at,kind:teamRow.kind,provenance:'declared',schema:'memory-version@1'},canonicalize(teamRow.body),tx);
    await db.query('SAVEPOINT owner_scope',[],tx);
    await assert.rejects(db.query('UPDATE records SET body=$1 WHERE digest=$2',[teamMarker,team],tx),(e:unknown)=>(e as {code:string}).code==='HU001');
    await db.query('ROLLBACK TO SAVEPOINT owner_scope',[],tx);
    assert.equal((await db.query('UPDATE records SET body=$1 WHERE digest=$2',[marker,row.digest],tx)).rowCount,1);
    assert.equal((await db.query('SELECT digest FROM records WHERE digest=$1',[row.digest],tx)).rows[0].digest,row.digest);
    throw rollback;
  }),e=>e===rollback);
 }
 const previous=(await db.query('SELECT version,name,sha256 FROM schema_migrations ORDER BY version')).rows;
 assert.deepEqual(await migrate(db),MIGRATIONS.slice(13).map(m=>m.version));
 assert.deepEqual((await db.query('SELECT version,name,sha256 FROM schema_migrations WHERE version<14 ORDER BY version')).rows,previous);
 await assert.rejects(db.query('SELECT hub_purge_personal($1,$2)',[user.id,INITIAL_PERSONAL_EPOCH]),/materialization incomplete/);
 if(independent){
  // Durable crash point: all private bytes copied, cleanup journal not yet drained.
  const payloads=new PgPersonalPayloads(db,async()=>{});
  await db.transaction(async tx=>{
    for(const hash of [original.sha256,node.sha256]){
      await payloads.object(user.id,(await objects.get(hash))!,tx);
      await db.query('INSERT INTO personal_legacy_retire(sha256) VALUES($1) ON CONFLICT DO NOTHING',[hash],tx);
    }
    await db.query('INSERT INTO personal_legacy_ready(record) SELECT record FROM personal_record_bindings ON CONFLICT DO NOTHING',[],tx);
  });
  await access(objects.path(original.sha256));
 }
 const kit=await openRecords({database,dataDir:dir,logDir:join(dir,'logs'),limits:{...DEFAULT_LIMITS}},{migrate:false});t.after(()=>kit.close());
 for(const row of rows){assert.deepEqual((await kit.store.get(row.digest))?.body,row.body);if(row.digest!==team&&row.digest!==teamOriginal&&row.digest!==teamTree)assert.equal((await kit.personalPayloads!.inspect(row.digest))?.cleared,false);}
 assert.ok(await kit.objects.get(original.sha256));
 if(!independent)await assert.rejects(access(objects.path(original.sha256)));
 const raw=(await db.query('SELECT body FROM records WHERE digest=$1',[document])).rows[0].body;
 assert.ok(!String(raw).includes('synthetic-private'));
 await kit.personalPayloads!.purge(user,INITIAL_PERSONAL_EPOCH);
 for(const row of rows)if(row.digest!==team&&row.digest!==teamOriginal&&row.digest!==teamTree){assert.equal(await kit.store.get(row.digest),null);assert.equal((await kit.personalPayloads!.inspect(row.digest))?.cleared,true);}
 assert.ok(await kit.store.get(team));
 if(independent){assert.ok(await kit.store.get(teamOriginal!));assert.ok(await kit.objects.get(original.sha256));}else assert.equal(await kit.objects.get(original.sha256),null);
 if(independent){assert.ok(await kit.objects.get(node.sha256));await access(objects.path(node.sha256));}else assert.equal(await kit.objects.get(node.sha256),null);
 await assert.rejects(db.query('SELECT hub_personal_migrate_inline()'),/once/);
 await assert.rejects(db.query("UPDATE records SET body='{}' WHERE digest=$1",[document]),/append-only/);
 const runtime='synthetic_runtime_'+randomBytes(4).toString('hex');
 const password=randomBytes(16).toString('hex');
 await db.query(`CREATE ROLE ${runtime} LOGIN PASSWORD '${password}'`);await grantRuntime(db,runtime);
 const restricted=new Database(createPool({...database,user:runtime,password}));t.after(()=>restricted.end());
 await restricted.query("SELECT set_config('circle_hub.personal_layout_conversion','14',false)");
 await assert.rejects(restricted.query('SELECT hub_personal_migrate_inline()'),(e:unknown)=>(e as {code:string}).code==='42501');
 await assert.rejects(restricted.query("UPDATE records SET body='{}' WHERE digest=$1",[document]),(e:unknown)=>(e as {code:string}).code==='42501');
 await assert.rejects(restricted.query("UPDATE personal_record_bindings SET marker='{}' WHERE record=$1",[document]),(e:unknown)=>(e as {code:string}).code==='42501');
});

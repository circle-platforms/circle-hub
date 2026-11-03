// Synthetic version-19 inline installs and ordinary captures are transformed once without changing logical identities.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {Database,createPool} from './db.ts';
import {migrate,MIGRATIONS,grantRuntime} from './migrations.ts';
import {canonicalize} from './canonical.ts';
import {recordDigest} from './digest.ts';
import {newId} from './ids.ts';
import {PgPrincipals} from './principals.ts';
import {FileObjectStore} from './objects.ts';
import {openRecords} from './index.ts';
import {DEFAULT_LIMITS} from '../config/index.ts';
import {startPostgres} from '../testing/postgres.ts';
import {runRecord} from '../../contracts/src/fixtures.ts';
test('upgrade separates ordinary private captures and installed files, preserves legitimate run holders and cannot reopen its conversion',async t=>{
 const pg=await startPostgres();t.after(()=>pg.stop());const database=await pg.createDatabase(undefined,{empty:true}),db=new Database(createPool(database));t.after(()=>db.end());await migrate(db,MIGRATIONS.slice(0,19));
 const dataDir=await mkdtemp(join(tmpdir(),'synthetic-account-upgrade-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));const at='2026-11-03T00:00:00.000Z',principals=new PgPrincipals(db,()=>new Date(at)),{user:admin}=await principals.bootstrapAdmin('synthetic-upgrade-admin'),owner=await principals.createUser(admin,'synthetic-upgrade-owner');
 const objects=new FileObjectStore(join(dataDir,'objects'),db,{maxBytes:DEFAULT_LIMITS.maxUploadBytes,now:()=>new Date(at)}),rows:Array<{digest:string;body:unknown;row:any}>=[];
 async function old(kind:string,schema:string,body:unknown,index:Array<{key:string;value:string}>=[]){const meta={kind,schema,provenance:'declared',created_at:at},digest=recordDigest({...meta,body}),text=canonicalize(body),row=(await db.query('INSERT INTO records(id,digest,kind,schema,provenance,created_at,body,size) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',[newId('rcd'),digest,kind,schema,'declared',at,text,Buffer.byteLength(text)])).rows[0];for(const i of index)await db.query('INSERT INTO record_index(key,value,digest,record_seq) VALUES($1,$2,$3,$4)',[i.key,i.value,digest,row.seq]);rows.push({digest,body,row});return digest;}
 const file=await objects.put(Buffer.from('# Synthetic private skill\nOnly synthetic inputs.\n'),'text/plain'),skill=await objects.put(Buffer.from(canonicalize({schema:'skill@1',parsers:[]})),'application/json'),manifest={schema:'pack@1',id:'synthetic-upgraded-skill',version:'1.0.0',kind:'skill',title:'合成旧技能',description:'合成旧私人正文',files:[{path:'SKILL.md',sha256:file.sha256,size:file.size},{path:'skill.json',sha256:skill.sha256,size:skill.size}]},manifestObject=await objects.put(Buffer.from(canonicalize(manifest)),'application/json');
 const capture={sha256:file.sha256,size:file.size,media_type:'text/plain',name:'SKILL.md',origin:{upload:{session:'synthetic-upgrade'}},author:{user:owner.id},provenance_type:'declared',captured_at:at,read_tier:'model_readable',visibility:{readers:[owner.id],admins:false,packs:[],shareable:false},scan:{scanner:'credential-scan@3',inspected:true,clean:true,findings:[],truncated:false}};
 const artifact=await old('source_artifact','source_artifact@1',capture,[{key:'artifact.author',value:owner.id}]);
 const version=await old('personal_pack_version','personal-pack-version@1',{space:owner.id,pack:manifest.id,version:'1.0.0',kind:'skill',digest:manifestObject.sha256,title:manifest.title,description:manifest.description,manifest,publisher:owner.id,at,report:{samples:{sources:[]}},files:{'SKILL.md':artifact}},[{key:'personal.pack.owner',value:owner.id},{key:'personal.pack.id',value:owner.id+'/'+manifest.id},{key:'personal.pack.digest',value:owner.id+'/'+manifestObject.sha256}]);
 const run=await old('run','run@1',{...runRecord,runner:owner.id,skills:[{pack:manifest.id,space:owner.id,version:'1.0.0',digest:manifestObject.sha256}]});
 await principals.setDisabled(admin,owner.id,true);assert.deepEqual(await migrate(db),MIGRATIONS.slice(19).map(m=>m.version));
 const kit=await openRecords({database,dataDir,logDir:join(dataDir,'logs'),limits:{...DEFAULT_LIMITS}},{migrate:false});t.after(()=>kit.close());
 for(const r of rows){const stored=(await db.query('SELECT * FROM records WHERE digest=$1',[r.digest])).rows[0];assert.deepEqual({...stored,body:r.row.body},r.row);assert.deepEqual((await kit.store.get(r.digest))?.body,r.body);}
 for(const hash of [file.sha256,skill.sha256,manifestObject.sha256]){await assert.rejects(access(objects.path(hash)));assert.ok(await kit.objects.get(hash));}
 assert.equal((await db.query('SELECT held_by FROM run_pack_records WHERE record=$1',[version])).rows[0].held_by,run);assert.equal((await db.query('SELECT count(*)::int n FROM personal_legacy_candidates c WHERE NOT EXISTS(SELECT 1 FROM personal_legacy_ready r WHERE r.record=c.record)')).rows[0].n,0);
 const role='synthetic_account_'+randomBytes(4).toString('hex'),password=randomBytes(18).toString('hex');await db.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);await db.query('REVOKE TEMPORARY ON DATABASE "'+database.database+'" FROM PUBLIC');await grantRuntime(db,role);const rt=new Database(createPool({...database,user:role,password}));t.after(()=>rt.end());
 await rt.query("SELECT set_config('circle_hub.account_layout_conversion','20',false)");await assert.rejects(rt.query('SELECT hub_convert_account_payloads()'),(e:any)=>e.code==='42501');await assert.rejects(db.query('SELECT hub_convert_account_payloads()'),/once/);await assert.rejects(rt.query('DELETE FROM run_pack_records'),(e:any)=>e.code==='42501');
});

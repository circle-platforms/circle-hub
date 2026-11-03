// Exact private versions use removable payloads; existing independent team/run holders retain their original bytes only.
import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {access} from 'node:fs/promises';
import {join} from 'node:path';
import {startPostgres} from '../../testing/postgres.ts';
import {openPackTestbed} from './testing/setup.ts';
import {workflowPack,type PackDescription} from './testing/builder.ts';
import {runRecord} from '../../../contracts/src/fixtures.ts';
import {Database,createPool} from '../../records/db.ts';
let pg:Awaited<ReturnType<typeof startPostgres>>;before(async()=>{pg=await startPostgres();});after(()=>pg?.stop());
const skill=(id:string):PackDescription=>({id,version:'1.0.0',kind:'skill',title:'合成删除技能',description:'合成独立归属',files:{'SKILL.md':'# 合成成员私人步骤\n\n只核对合成输入。','skill.json':{schema:'skill@1',parsers:[]}}});
async function remove(bed:Awaited<ReturnType<typeof openPackTestbed>>){const api=bed.kit.memberDeletions!,preview=await api.preview(bed.admin,bed.carol.id),intent=await api.prepare(bed.admin,{...preview,operation_id:randomUUID()});return api.finish(bed.admin,bed.carol.id,intent.operation_id);}
test('local-only mode keeps installed private skills; member deletion removes unheld manifests, files, indices and caches',async t=>{
 const bed=await openPackTestbed({postgres:pg});t.after(()=>bed.close());const personal=bed.registry.personal!,pack=skill('synthetic-delete-private'),result=await personal.publish(bed.carol,(await bed.write(pack)).dir);assert.ok(result.ok);if(!result.ok)return;
 const opened=await personal.open(bed.carol.id,result.version.digest);assert.ok(opened);const state=await bed.kit.personalSync!.state(bed.carol);await bed.kit.personalPayloads!.purge(bed.carol,state.epoch);assert.ok(await personal.resolve(bed.carol,bed.carol.id,pack.id));
 const receipt=await remove(bed);assert.equal(receipt.counts.private_versions,1);assert.equal(await personal.resolve(bed.alice,bed.carol.id,pack.id),null);assert.equal(await personal.open(bed.carol.id,result.version.digest),null);await assert.rejects(access(opened.handle.directory));
 const db=new Database(createPool(bed.kit.database));t.after(()=>db.end());assert.equal((await db.query('SELECT count(*)::int n FROM personal_payloads WHERE owner=$1',[bed.carol.id])).rows[0].n,0);
 assert.equal((await db.query("SELECT count(*)::int n FROM record_index i JOIN personal_record_bindings b ON b.record=i.digest WHERE b.owner=$1 AND i.key IN ('personal.pack.id','personal.pack.grant','personal.pack.retired')",[bed.carol.id])).rows[0].n,0);
 for(const hash of [result.version.digest,...result.version.manifest.files.map(file=>file.sha256)]){assert.equal(await bed.kit.objects.get(hash),null);await assert.rejects(access(join(bed.kit.dataDir,'objects',hash.slice(0,2),hash.slice(2))));}
});
test('frozen exact workflow and skill closures survive deletion for the existing run but cannot be resolved for new work',async t=>{
 const bed=await openPackTestbed({postgres:pg});t.after(()=>bed.close());const personal=bed.registry.personal!,dependency=skill('synthetic-frozen-dependency');const sk=await personal.publish(bed.carol,(await bed.write(dependency)).dir);assert.ok(sk.ok);if(!sk.ok)return;
 const workflow=workflowPack({id:'synthetic-frozen-workflow'});workflow.dependencies=[{pack:dependency.id,space:bed.carol.id,version:'1.0.0'}];const flow=await personal.publish(bed.carol,(await bed.write(workflow)).dir);assert.ok(flow.ok,JSON.stringify(flow));if(!flow.ok)return;
 const input=await bed.kit.artifacts.ingest({bytes:Buffer.from('合成冻结上传正文'),mediaType:'text/plain',origin:{upload:{session:null}},author:{user:bed.carol.id},provenanceType:'declared',visibility:{readers:[bed.carol.id],admins:false,packs:[],shareable:false}});
 const body={...runRecord,runner:bed.carol.id,pack:flow.version.id+'@1.0.0',pack_space:bed.carol.id,pack_digest:flow.version.digest,skills:[{pack:sk.version.id,space:bed.carol.id,version:'1.0.0',digest:sk.version.digest}],sources:[{reference:'src:'+input.body.sha256,role:'subject',slot:'mindmap',artifact:input.digest,upload_declaration:{by:bed.carol.id}}]};
 const run=await bed.kit.store.put({kind:'run',schema:'run@1',provenance:'declared',body,index:[{key:'runs.id',value:body.run}]});await personal.open(bed.carol.id,flow.version.digest);await personal.open(bed.carol.id,sk.version.digest);
 await remove(bed);assert.deepEqual((await bed.kit.store.get(run.digest))?.body,body);assert.ok(await personal.open(bed.carol.id,flow.version.digest));assert.ok(await personal.open(bed.carol.id,sk.version.digest));assert.ok(await bed.kit.objects.get(input.body.sha256));
 assert.equal(await personal.resolve(bed.admin,bed.carol.id,flow.version.id),null);assert.equal(await personal.resolve(bed.alice,bed.carol.id,sk.version.id),null);assert.equal(await bed.kit.artifacts.source(bed.admin,input.body.sha256),null,'independent custody does not give an administrator new private read access');
 const db=new Database(createPool(bed.kit.database));t.after(()=>db.end());assert.equal((await db.query('SELECT count(*)::int n FROM run_pack_records')).rows[0].n,2);assert.equal((await db.query('SELECT count(*)::int n FROM personal_payloads WHERE owner=$1',[bed.carol.id])).rows[0].n,0);
});
test('explicit team publication and a second owner keep equal-byte versions without inheriting the deleted namespace',async t=>{
 const bed=await openPackTestbed({postgres:pg});t.after(()=>bed.close());const personal=bed.registry.personal!,pack=skill('synthetic-separate-team-copy'),written=await bed.write(pack),one=await personal.publish(bed.carol,written.dir),two=await personal.publish(bed.alice,written.dir);assert.ok(one.ok&&two.ok);if(!one.ok||!two.ok)return;
 await bed.kit.authorizations.grantPublishRight(bed.admin,bed.carol.id);const team=await personal.promote(bed.carol,pack.id);assert.ok(team.ok,JSON.stringify(team));await remove(bed);
 assert.ok(await bed.registry.resolve(pack.id));assert.ok(await personal.resolve(bed.alice,bed.alice.id,pack.id));assert.equal(await personal.resolve(bed.admin,bed.carol.id,pack.id),null);
 const opened=await personal.open(bed.alice.id,two.version.digest);assert.ok(opened);await access(join(opened.handle.directory,'SKILL.md'));
});

test('deletion waits for active pre-publication staging and retires journalled crash remnants without a publication record',async t=>{
 const bed=await openPackTestbed({postgres:pg});t.after(()=>bed.close());const {barrier,reaches,waitForUserUpdateLock}=await import('../../testing/member-freeze.ts'),{mkdir,writeFile}=await import('node:fs/promises'),{sha256Hex}=await import('../../records/api.ts'),entered=barrier(),release=barrier(),hash=sha256Hex('synthetic uncommitted staged private pack'),root=join(bed.extractDir,'personal'),directory=join(root,'.tmp-'+hash+'-synthetic');
 const staging=bed.kit.personalPayloads!.stage(bed.carol.id,hash,async()=>{await mkdir(directory,{recursive:true,mode:0o700});await writeFile(join(directory,'SKILL.md'),'synthetic pre-publication private text',{mode:0o400});entered.release();await release.promise;});
 await reaches(entered,staging);const api=bed.kit.memberDeletions!,preview=await api.preview(bed.admin,bed.carol.id),preparing=api.prepare(bed.admin,{...preview,operation_id:randomUUID()});
 try{await waitForUserUpdateLock(bed.kit,'SELECT updated_at FROM users WHERE id=$1 FOR UPDATE');assert.equal((await bed.kit.principals.get(bed.carol.id))?.disabled,false);}finally{release.release();}
 await staging;const intent=await preparing;await api.finish(bed.admin,bed.carol.id,intent.operation_id);await assert.rejects(access(directory));await assert.rejects(bed.kit.personalPayloads!.stage(bed.carol.id,hash,async()=>assert.fail('deleted staging cannot run')));
 assert.equal((await bed.kit.store.list({kind:'personal_pack_version'})).items.length,0);
});

test('a newly frozen private dependency invalidates a deletion preview even without a new private payload',async t=>{
 const bed=await openPackTestbed({postgres:pg});t.after(()=>bed.close());const pack=skill('synthetic-retention-race'),published=await bed.registry.personal!.publish(bed.carol,(await bed.write(pack)).dir);assert.ok(published.ok);if(!published.ok)return;
 const api=bed.kit.memberDeletions!,preview=await api.preview(bed.admin,bed.carol.id);await bed.kit.store.put({kind:'run',schema:'run@1',provenance:'declared',body:{...runRecord,runner:bed.alice.id,sources:[],skills:[{pack:pack.id,version:'1.0.0',space:bed.carol.id,digest:published.version.digest}]}});
 const fresh=await api.preview(bed.admin,bed.carol.id);assert.deepEqual(fresh.counts,preview.counts);assert.notEqual(fresh.state,preview.state);await assert.rejects(api.prepare(bed.admin,{...preview,operation_id:randomUUID()}),/重新检查/);assert.equal((await bed.kit.principals.get(bed.carol.id))?.disabled,false);
});

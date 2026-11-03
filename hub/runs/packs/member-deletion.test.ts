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
test('local-only mode keeps installed private skills; member deletion hands them to the deleting administrator and removes the member namespace',async t=>{
 const bed=await openPackTestbed({postgres:pg});t.after(()=>bed.close());const personal=bed.registry.personal!,pack=skill('synthetic-delete-private'),result=await personal.publish(bed.carol,(await bed.write(pack)).dir);assert.ok(result.ok);if(!result.ok)return;
 const opened=await personal.open(bed.carol.id,result.version.digest);assert.ok(opened);const state=await bed.kit.personalSync!.state(bed.carol);await bed.kit.personalPayloads!.purge(bed.carol,state.epoch);assert.ok(await personal.resolve(bed.carol,bed.carol.id,pack.id));
 // Owner ruling 4 (issue 141): the preview names the receiving administrator and the versions that move.
 const preview=await bed.kit.memberDeletions!.preview(bed.admin,bed.carol.id);assert.deepEqual(preview.handover,{to:bed.admin.id,items:[{pack:pack.id,version:'1.0.0',kind:'skill',title:pack.title,digest:result.version.digest,status:'transfer'}]});
 const receipt=await remove(bed);assert.equal(receipt.counts.private_versions,1);assert.equal(await personal.resolve(bed.alice,bed.carol.id,pack.id),null);assert.equal(await personal.open(bed.carol.id,result.version.digest),null);
 const moved=await personal.resolve(bed.admin,bed.admin.id,pack.id);assert.ok(moved,'the administrator now owns the exact version');assert.equal(moved.digest,result.version.digest);assert.equal(moved.publisher,bed.admin.id);assert.deepEqual(moved.report,result.version.report);
 const reopened=await personal.open(bed.admin.id,result.version.digest);assert.ok(reopened);await access(join(reopened.handle.directory,'SKILL.md'));
 assert.equal(await personal.resolve(bed.alice,bed.admin.id,pack.id),null,'grants do not move with the version');
 const transfers=await bed.kit.store.findMany<{from?:string;space:string;source:string;target:string}>({kind:'personal_pack_transfer',key:'personal.pack.handover.from',values:[bed.carol.id]});assert.equal(transfers.length,1);assert.equal(transfers[0].body.from,bed.carol.id);assert.equal(transfers[0].body.space,bed.admin.id);assert.equal(transfers[0].body.target,moved.record);
 const db=new Database(createPool(bed.kit.database));t.after(()=>db.end());assert.equal((await db.query('SELECT count(*)::int n FROM personal_payloads WHERE owner=$1',[bed.carol.id])).rows[0].n,0);
 assert.equal((await db.query("SELECT count(*)::int n FROM record_index i JOIN personal_record_bindings b ON b.record=i.digest WHERE b.owner=$1 AND i.key IN ('personal.pack.id','personal.pack.grant','personal.pack.retired')",[bed.carol.id])).rows[0].n,0);
 for(const hash of [result.version.digest,...result.version.manifest.files.map(file=>file.sha256)])assert.ok(await bed.kit.objects.get(hash),'the administrator holds its own copy of each file');
});
test('a version the administrator already uses differently is not transferred and is listed as a conflict',async t=>{
 const bed=await openPackTestbed({postgres:pg});t.after(()=>bed.close());const personal=bed.registry.personal!,pack=skill('synthetic-handover-conflict');
 const theirs=await personal.publish(bed.carol,(await bed.write(pack)).dir),mine=await personal.publish(bed.admin,(await bed.write({...pack,files:{...pack.files,'SKILL.md':'# 管理员自己的合成技能\n\n内容不同。'}})).dir);assert.ok(theirs.ok&&mine.ok);if(!theirs.ok||!mine.ok)return;
 const other=await personal.publish(bed.carol,(await bed.write(skill('synthetic-handover-free'))).dir);assert.ok(other.ok);
 const preview=await bed.kit.memberDeletions!.preview(bed.admin,bed.carol.id);assert.deepEqual(preview.handover?.items.map(item=>[item.pack,item.status]),[['synthetic-handover-conflict','conflict'],['synthetic-handover-free','transfer']]);
 await remove(bed);assert.equal((await personal.resolve(bed.admin,bed.admin.id,pack.id))?.digest,mine.version.digest,'the administrator keeps their own version');assert.ok(await personal.resolve(bed.admin,bed.admin.id,'synthetic-handover-free'));
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

test('a deleted identity cannot receive a new private skill grant but its historical grant can be revoked',async t=>{
 const bed=await openPackTestbed({postgres:pg});t.after(()=>bed.close());const personal=bed.registry.personal!,pack=skill('synthetic-deleted-grantee'),result=await personal.publish(bed.alice,(await bed.write(pack)).dir);assert.ok(result.ok,JSON.stringify(result));await personal.grant(bed.alice,pack.id,{audience:'member',member:bed.carol.id});await remove(bed);
 await assert.rejects(personal.grant(bed.alice,pack.id,{audience:'member',member:bed.carol.id}),{name:'AccessError'});await personal.grant(bed.alice,pack.id,{audience:'member',member:bed.carol.id,revoke:true});assert.equal((await personal.grants(bed.alice,pack.id)).some(grant=>grant.member===bed.carol.id),false);
});

test('deletion scope counts private versions separately from their exact file captures and keeps equal-byte originals visible',async t=>{
 const bed=await openPackTestbed({postgres:pg});t.after(()=>bed.close());const personal=bed.registry.personal!,first=skill('synthetic-preview-categories'),one=await personal.publish(bed.carol,(await bed.write(first)).dir);assert.ok(one.ok,JSON.stringify(one));const two=await personal.publish(bed.carol,(await bed.write({...first,version:'1.0.1'})).dir);assert.ok(two.ok,JSON.stringify(two));
 const before=await bed.kit.memberDeletions!.preview(bed.admin,bed.carol.id);assert.deepEqual(before.scope_counts,{knowledge:0,memory:0,originals:0,attributions:0,archived_originals:0,private_versions:2});
 await bed.kit.artifacts.ingest({bytes:Buffer.from(first.files['SKILL.md'] as string),name:'synthetic-independent-original.txt',mediaType:'text/plain',origin:{upload:{session:'synthetic-equal-byte-original'}},author:{user:bed.carol.id},provenanceType:'declared',visibility:{readers:[bed.carol.id],admins:false,packs:[],shareable:false}});const after=await bed.kit.memberDeletions!.preview(bed.admin,bed.carol.id);assert.equal(after.scope_counts.originals,1);assert.equal(after.scope_counts.private_versions,2);assert.ok(after.counts.records>after.scope_counts.private_versions+after.scope_counts.originals);assert.notEqual(after.state,before.state);
});

// Real password-console HTTP responses, synthetic accounts and temporary database/storage only.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createTestHub} from '../testing-real.ts';
import {openConsole} from '../../../tests/acceptance/support/console.ts';
import {deleteMember} from '../member-deletion.ts';
import {wordingProblems} from './testing-wording.ts';
const options={repositoryPacks:false,stubs:false,mindmapSkill:false,workbookSkill:false,xmlSkill:false,htmlSkill:false};
test('deletion preview is administrator-only and read-only; tombstone pages expose recovery/completion but no mutation controls',async()=>{
 const hub=await createTestHub(options);try{
  const member=await hub.createUser('合成删除界面成员'),owner=await openConsole(hub,member.token),manager=await openConsole(hub,hub.admin.token),url='/console/team/'+member.user.id,api='/console/api/members/'+member.user.id+'/deletion';
  await hub.hub.knowledge.spaces!.importFile(member.principal,Buffer.from('合成界面不显示的正文'),'text/plain','合成不公开文件','/合成不公开路径');const mark=await hub.records.store.watermark!();
  const page=await manager.get(url+'?deletion=preview');assert.equal(page.status,200,page.body);assert.match(page.body,/确认永久删除成员/);assert.match(page.body,/--expected-state=/);assert.deepEqual(wordingProblems(page.body),[]);assert.doesNotMatch(page.body,/合成不公开文件|合成不公开路径|合成界面不显示的正文/);assert.equal(await hub.records.store.watermark!(),mark);
  assert.equal((await owner.get(api)).status,404);assert.equal((await owner.get(url+'?deletion=preview')).status,200);assert.doesNotMatch((await owner.get(url+'?deletion=preview')).body,/--expected-state=|永久删除成员/);
  const check=await manager.get(api);assert.equal(check.status,200,check.body);const prepared=JSON.parse(check.body);assert.equal(await hub.records.store.watermark!(),mark);
  assert.equal((await manager.post('/console/api/members/'+member.user.id+'/deletion',{})).status,405);assert.equal((await manager.post('/console/api/commands',{operation:'user-delete',object:member.user.id})).status,403);
  const call=await hub.records.callLog.append({traceId:'4bf92f3577b34da6a3ce929d0e0e4736',sessionId:null,runId:null,userId:member.user.id,tool:'get_nodes',arguments:{},callResult:'ok',durationMs:1});const auditBefore=await hub.records.store.get(call.digest);
  const intent=await hub.records.memberDeletions!.prepare(hub.admin.principal,{...prepared.preview,operation_id:prepared.operation_id});const pending=await manager.get(url);assert.equal(pending.status,200);assert.match(pending.body,/等待清除中/);assert.match(pending.body,/已删除的成员/);assert.deepEqual(wordingProblems(pending.body),[]);
  const finished=await deleteMember(hub.records,hub.admin.principal,member.user.id,intent.operation_id);assert.ok(finished.record);const done=await manager.get(url);assert.equal(done.status,200);assert.match(done.body,/私人内容已清除/);assert.doesNotMatch(done.body,/重置密码|启用…|调整发布权…|签发 Circle 访问令牌/);assert.deepEqual(wordingProblems(done.body),[]);
  const rows=await manager.get('/console/api/members');assert.equal(rows.status,200);const removed=JSON.parse(rows.body).members.find((user:any)=>user.id===member.user.id);assert.equal(removed.name,'已删除的成员');assert.equal(removed.status,'deleted');assert.equal(removed.status_label,'已删除的成员');assert.ok(removed.deleted_at);
  const records=await manager.get('/console/records?user='+member.user.id);assert.equal(records.status,200);assert.match(records.body,/已删除的成员/);assert.ok(!records.body.includes(member.user.name));assert.deepEqual(await hub.records.store.get(call.digest),auditBefore);
  const fresh=await hub.createUser(member.user.name),search=await manager.get('/console/api/search?q='+encodeURIComponent(member.user.name));assert.equal(search.status,200,search.body);assert.deepEqual(JSON.parse(search.body).members.map((user:any)=>user.id),[fresh.user.id]);assert.equal((await hub.records.principals.findByName(member.user.name))?.id,fresh.user.id);
  const team=await manager.get('/console/team');assert.match(team.body,/已删除的成员/);assert.ok(!team.body.includes('>'+member.user.name+'</a></td><td>成员</td><td>已停用'));
  await assert.rejects(hub.hub.knowledge.spaces!.setCapacity(hub.admin.principal,member.user.id,1),{code:'SOURCE_UNAVAILABLE'});
 }finally{await hub.close();}
});

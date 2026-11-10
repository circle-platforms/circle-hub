// Real password-console HTTP responses, synthetic accounts and temporary database/storage only.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createTestHub} from '../testing-real.ts';
import {openConsole} from '../../../tests/acceptance/support/console.ts';
import {deleteMember} from '../member-deletion.ts';
import {wordingProblems} from './testing-wording.ts';
const options={repositoryPacks:false,stubs:false,mindmapSkill:false,workbookSkill:false,xmlSkill:false,htmlSkill:false};
const withoutTechnical=(body:string)=>body.replace(/<details\b[^>]*>[\s\S]*?<\/details>/g,'');
test('deletion preview is administrator-only and read-only; tombstone pages expose recovery/completion but no mutation controls',async()=>{
 const hub=await createTestHub(options);try{
  const member=await hub.createUser('合成删除界面成员'),owner=await openConsole(hub,member.token),manager=await openConsole(hub,hub.admin.token),url='/console/team/'+member.user.id,api='/console/api/members/'+member.user.id+'/deletion';
  const spaces=hub.hub.knowledge.spaces!,original=await spaces.importFile(member.principal,Buffer.from('合成界面不显示的正文'),'text/plain','合成不公开文件','/合成不公开路径'),registration=(await hub.records.store.findMany<any>({kind:'knowledge_space_source',key:'knowledge.space.source_hash',values:[original.body.sha256]})).find(row=>row.body.artifact===original.digest)!;await spaces.attributeSource(member.principal,registration.digest,original.digest);
  await spaces.write(member.principal,{kind:'observation',statement:'合成第一份知识'});await spaces.write(member.principal,{kind:'observation',statement:'合成第二份知识'});
  const memory=await hub.hub.knowledge.memory.write(member.principal,{title:'合成不公开记忆',markdown:'合成旧偏好',expected_version:null,client_key:'synthetic-deletion-display-one'});await hub.hub.knowledge.memory.write(member.principal,{document:memory.document,markdown:'合成新偏好',expected_version:memory.version,client_key:'synthetic-deletion-display-two'});const mark=await hub.records.store.watermark!();
  const page=await manager.get(url+'?deletion=preview');assert.equal(page.status,200,page.body);assert.match(page.body,/预览永久删除的影响/);assert.doesNotMatch(page.body,/确认永久删除成员/);assert.match(page.body,/此页只预览影响，不会删除任何内容；执行下方命令才会删除，且不可撤销。/);assert.match(page.body,/--expected-state=/);assert.deepEqual(wordingProblems(page.body),[]);assert.doesNotMatch(page.body,/合成不公开文件|合成不公开路径|合成界面不显示的正文/);assert.equal(await hub.records.store.watermark!(),mark);
  assert.equal((await owner.get(api)).status,404);assert.equal((await owner.get(url+'?deletion=preview')).status,200);assert.doesNotMatch((await owner.get(url+'?deletion=preview')).body,/--expected-state=|永久删除成员|预览永久删除的影响/);
  const check=await manager.get(api);assert.equal(check.status,200,check.body);const prepared=JSON.parse(check.body);assert.deepEqual(prepared.preview.scope_counts,{knowledge:2,memory:2,originals:1,attributions:1,archived_originals:1,private_versions:0});
  const visible=withoutTechnical(page.body);for(const [label,n]of [['知识',2],['记忆',2],['原文',1],['来源署名',1],['归档的原文',1]])assert.ok(visible.includes('<dt>'+label+'</dt><dd>'+n+'</dd>'),String(label));
  // Issue 236: the consequences come in labelled groups, in the order of who or what they touch, and none is dropped.
  assert.match(visible,/data-deletion-effects/);
  assert.deepEqual([...visible.matchAll(/<section class="ch-section"><h3>([^<]+)<\/h3><ul class="ch-feed">/g)].map(m=>m[1]),['将清除','将转移','将保留','引用和分享的影响','账户和登录','不可撤销']);
  for(const phrase of ['现有私人分享失效','分享不随之转移','团队已取得的独立内容保留','运行引用过的私人知识原文一并清除','旧密码、令牌、会话和同步请求均不能恢复该账户','该成员客户端设备上的本地副本不受影响','此操作不可撤销'])assert.ok(visible.includes(phrase),phrase);
  assert.doesNotMatch(visible,/本机副本/);
  // Owner ruling 4 (issue 141): the dialog names the receiving administrator for private workflows and skills.
  assert.deepEqual(prepared.preview.handover,{to:hub.admin.principal.id,items:[]});assert.match(visible,/data-deletion-handover/);assert.match(visible,new RegExp('接收人：'+hub.admin.principal.name+'（执行删除的管理员）'));assert.match(visible,/该成员没有私人工作流或技能。/);
  assert.doesNotMatch(visible,/<dt>(记录|载荷|原件|归档登记|私人版本)<\/dt>/);assert.match(page.body,/在 Hub 所在主机上执行下列命令完成删除；内容变化后须重新检查。/);assert.doesNotMatch(page.body,/确认后，在管理员/);assert.match(page.body,/<summary>查看清除清单摘要<\/summary>[\s\S]*<dt>载荷<\/dt>/);assert.equal(await hub.records.store.watermark!(),mark);
  assert.equal((await manager.post('/console/api/members/'+member.user.id+'/deletion',{})).status,405);assert.equal((await manager.post('/console/api/commands',{operation:'user-delete',object:member.user.id})).status,403);
  const call=await hub.records.callLog.append({traceId:'4bf92f3577b34da6a3ce929d0e0e4736',sessionId:null,runId:null,userId:member.user.id,tool:'get_nodes',arguments:{},callResult:'ok',durationMs:1});const auditBefore=await hub.records.store.get(call.digest);
  const intent=await hub.records.memberDeletions!.prepare(hub.admin.principal,{...prepared.preview,operation_id:prepared.operation_id});const pending=await manager.get(url);assert.equal(pending.status,200);assert.match(pending.body,/等待清除中/);
  assert.ok(pending.body.includes('<div class="ch-actions"><span class="ch-tag">成员</span><span class="ch-badge ch-badge--pending">'));assert.ok(pending.body.includes('已删除</span></div><h2 class="ch-panel-title">已删除的成员</h2>'));assert.doesNotMatch(withoutTechnical(pending.body),/<dt>(记录|载荷|原件|私人版本)<\/dt>/);assert.deepEqual(wordingProblems(pending.body),[]);
  const finished=await deleteMember(hub.records,hub.admin.principal,member.user.id,intent.operation_id);assert.ok(finished.record);const done=await manager.get(url);assert.equal(done.status,200);assert.match(done.body,/私人内容已清除/);assert.doesNotMatch(done.body,/重置密码|启用…|调整发布权…|签发 Circle 访问令牌/);assert.doesNotMatch(withoutTechnical(done.body),/<dt>(记录|载荷|原件|私人版本)<\/dt>/);assert.deepEqual(wordingProblems(done.body),[]);
  const rows=await manager.get('/console/api/members');assert.equal(rows.status,200);const removed=JSON.parse(rows.body).members.find((user:any)=>user.id===member.user.id);assert.equal(removed.name,'已删除的成员');assert.equal(removed.status,'deleted');assert.equal(removed.status_label,'已删除');assert.ok(removed.deleted_at);
  const records=await manager.get('/console/records?user='+member.user.id);assert.equal(records.status,200);assert.match(records.body,/已删除的成员/);assert.ok(!records.body.includes(member.user.name));assert.deepEqual(await hub.records.store.get(call.digest),auditBefore);
  const fresh=await hub.createUser(member.user.name),search=await manager.get('/console/api/search?q='+encodeURIComponent(member.user.name));assert.equal(search.status,200,search.body);assert.deepEqual(JSON.parse(search.body).members.map((user:any)=>user.id),[fresh.user.id]);assert.equal((await hub.records.principals.findByName(member.user.name))?.id,fresh.user.id);
  const team=await manager.get('/console/team');assert.match(team.body,/已删除的成员/);assert.match(team.body,/>已删除<\/span>/);assert.ok(!team.body.includes('>'+member.user.name+'</a></td><td>成员</td><td>已停用'));
  await assert.rejects(hub.hub.knowledge.spaces!.setCapacity(hub.admin.principal,member.user.id,1),{code:'SOURCE_UNAVAILABLE'});
 }finally{await hub.close();}
});

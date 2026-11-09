import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createTestHub} from './testing-real.ts';
import {openConsole} from '../../tests/acceptance/support/console.ts';

const options={repositoryPacks:false,stubs:false,mindmapSkill:false,workbookSkill:false,xmlSkill:false,htmlSkill:false};
const csrf=(body:string)=>/name="csrf" value="([^"]+)"/.exec(body)![1];

test('knowledge creation and revision use the main editing foreground without reading detail sources',async t=>{
 const hub=await createTestHub(options);t.after(()=>hub.close());const owner=await hub.createUser('合成编辑作者'),other=await hub.createUser('合成其他作者'),session=await openConsole(hub,owner.token),reader=await openConsole(hub,other.token);
 const spaces=hub.hub.knowledge.spaces!;await spaces.ensure(owner.principal,owner.user.id);
 const created=await session.get('/console/knowledge/space?edit=1&path=/');assert.equal(created.status,200);assert.match(created.body,/data-editor-foreground/);
 // Issue 234: the optional JSON fields say what to put in them and what an empty field means, not the protocol value null.
 assert.match(created.body,/留空表示没有；填写须是 JSON 对象，例如 \{&quot;字段&quot;:&quot;值&quot;\}/);assert.match(created.body,/须是 JSON 对象；留空表示未声明/);assert.doesNotMatch(created.body,/placeholder="null"/);assert.match(created.body,/placeholder="留空表示未声明"/);assert.doesNotMatch(created.body,/<aside class="ch-inspector"|data-knowledge-selection/);
 const saved=await session.post('/console/knowledge/do/entry',{csrf:csrf(created.body),space:owner.user.id,path:'/',kind:'observation',statement:'合成待修改条目',data:'{"kept":true}',applicability:'{"synthetic":true}',reason:'合成创建'});assert.equal(saved.status,303,saved.body);const current=await spaces.ensure(owner.principal,owner.user.id),target='/console/knowledge/space?'+new URLSearchParams({space:owner.user.id,root:current.root,path:'/',entry:current.body.entries[0].entry}),before=await hub.records.store.watermark!();
 const original=hub.hub.knowledge.spaces!.entryAttributions.bind(spaces);hub.hub.knowledge.spaces!.entryAttributions=async()=>{throw Error('edit foreground must not read detail source attribution');};
 const editing=await session.get(target+'&edit=1');assert.equal(editing.status,200,editing.body);assert.match(editing.body,/data-editor-foreground/);assert.match(editing.body,/data-entry-editor/);assert.doesNotMatch(editing.body,/<aside class="ch-inspector"|data-knowledge-selection|来源署名|data-entry-versions/);assert.equal((editing.body.match(/action="\/console\/knowledge\/do\/entry"/g)??[]).length,1);
 assert.ok(editing.body.indexOf('name="statement"')<editing.body.indexOf('name="data"'));assert.match(editing.body,/<details[^>]*data-editor-advanced[^>]*open/);assert.match(editing.body,/&quot;kept&quot;: true/);assert.match(editing.body,/name="expected_version" value="[a-f0-9]{64}"/);assert.match(editing.body,/取消并返回/);assert.equal(await hub.records.store.watermark!(),before);
 const hidden=await reader.get(target+'&edit=1');assert.equal(hidden.status,404);assert.ok(!hidden.body.includes('合成待修改条目'));hub.hub.knowledge.spaces!.entryAttributions=original;
 const expected=/name="expected_version" value="([^"]+)"/.exec(editing.body)![1],replaces=/name="replaces" value="([^"]+)"/.exec(editing.body)![1];
 const changed=await session.post('/console/knowledge/do/entry',{csrf:csrf(editing.body),space:owner.user.id,path:'/',kind:'observation',statement:'合成已修改条目',data:'{"kept":true}',applicability:'{"synthetic":true}',reason:'合成修改',expected_version:expected,replaces});assert.equal(changed.status,303,changed.body);
 const oldEdit=await session.get(target+'&edit=1');assert.doesNotMatch(oldEdit.body,/data-entry-editor/);
});

test('memory editing prioritizes the editable body and preserves CAS, intent identity and private access',async t=>{
 const hub=await createTestHub(options);t.after(()=>hub.close());const owner=await hub.createUser('合成记忆编辑作者'),session=await openConsole(hub,owner.token),admin=await openConsole(hub,hub.admin.token);
 const memory=hub.hub.knowledge.memory!,saved=await memory.write(owner.principal,{expected_version:null,title:'合成记忆标题',path:'/preferences',markdown:'合成正文首屏',client_key:'editor-fixture'});
 const target='/console/knowledge?view=memory&scope=personal&document='+saved.document;
 const edit=await session.get(target+'&edit=1');assert.equal(edit.status,200,edit.body);assert.match(edit.body,/data-editor-foreground/);
 assert.match(edit.body,/正文可使用 Markdown 标记，按原文保存，页面不渲染也不转换格式/);assert.doesNotMatch(edit.body,/不执行 Markdown/);assert.doesNotMatch(edit.body,/<aside class="ch-inspector"|<pre|id="memory-versions"/);assert.equal((edit.body.match(/action="\/console\/knowledge\/do\/memory-write"/g)??[]).length,1);assert.match(edit.body,/name="markdown"[^>]*>合成正文首屏/);assert.match(edit.body,new RegExp('name="expected_version" value="'+saved.version+'"'));assert.match(edit.body,/name="client_key" value="evt_/);assert.match(edit.body,/取消并返回/);assert.equal((await admin.get(target+'&edit=1')).status,404);
 const fresh=await session.get('/console/knowledge?view=memory&scope=personal&edit=1');assert.match(fresh.body,/data-editor-foreground/);assert.doesNotMatch(fresh.body,/使用额度|<aside class="ch-inspector"/);
 const update=await session.post('/console/knowledge/do/memory-write',{csrf:csrf(edit.body),space:'personal',document:saved.document,expected_version:saved.version,client_key:'editor-update',title:'合成记忆标题',path:'/preferences',markdown:'合成修改正文',enabled:'true'});assert.equal(update.status,303,update.body);
 const historical=await session.get(target+'&version='+saved.version+'&edit=1');assert.doesNotMatch(historical.body,/data-memory-editor/);
 const stale=await session.post('/console/knowledge/do/memory-write',{csrf:csrf(edit.body),space:'personal',document:saved.document,expected_version:saved.version,client_key:'editor-stale',markdown:'不可覆盖'});assert.equal(stale.status,400);assert.equal((await memory.read(owner.principal,saved.document)).markdown,'合成修改正文');
});

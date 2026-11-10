import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createTestServer} from './testing.ts';
import {createTestHub} from './testing-real.ts';
import {openConsole} from '../../tests/acceptance/support/console.ts';
import {packPurpose,publishingKind} from './console/pack-display.ts';
import {PACK_KIND} from '../../contracts/generated/vocabulary.ts';
import type {PageContext} from './console/pages.ts';
import {INTERACTION_SCRIPT} from './console/interaction.ts';

test('connection directory uses unique native section anchors rather than false tab selection for both roles',async t=>{
 const hub=await createTestServer();t.after(()=>hub.close());const user=await hub.createUser('合成目录读者');
 for(const member of [hub.admin,user]){
  const console=await openConsole(hub,member.token),response=await console.get('/console/connections');assert.equal(response.status,200,response.body);
  const nav=response.body.match(/<nav class="ch-page-toc"[^>]*>[\s\S]*?<\/nav>/)?.[0];assert.ok(nav);assert.match(nav,/连接页分区/);assert.match(nav,/本页内容/);assert.doesNotMatch(nav,/ch-seg|role="tab|aria-current="page"/);
  for(const id of ['system-sources','circles','systems','envs','more']){assert.ok(nav.includes('href="#'+id+'"'));assert.equal((response.body.match(new RegExp(' id="'+id+'"','g'))??[]).length,1,id);}
  assert.match(response.body,/业务系统接入，再在连接页配置具体系统/);assert.match(response.body,/id="live-system-sources"/);assert.match(response.body,/data-theme-switch/);
  if(member===user){assert.match(response.body,/业务系统的配置仅管理员可见/);assert.match(response.body,/运行环境仅管理员可见/);assert.doesNotMatch(response.body,/href="\/console\/operations\/system"/);}
 }
 assert.doesNotThrow(()=>new Function(INTERACTION_SCRIPT));
});

test('personal publication explains the two supported purposes without exposing team system actions',async t=>{
 const hub=await createTestHub({repositoryPacks:false,stubs:false,mindmapSkill:false,workbookSkill:false,xmlSkill:false,htmlSkill:false});t.after(()=>hub.close());const owner=await hub.createUser('合成私人发布成员'),console=await openConsole(hub,owner.token),before=await hub.records.store.watermark!(),response=await console.get('/console/packs/-/publish');assert.equal(response.status,200,response.body);assert.ok(response.body.includes(packPurpose('workflow')));assert.ok(response.body.includes(packPurpose('skill')));assert.match(response.body,/上传内容的类型由 pack.json 声明/);assert.doesNotMatch(response.body,/action="\/console\/admin\/do|href="\/console\/operations\/system/);assert.equal(await hub.records.store.watermark!(),before);
});

test('workflow and publication pages explain purpose without changing declared manifest kind or access boundary',async t=>{
 const hub=await createTestServer();t.after(()=>hub.close());const console=await openConsole(hub,hub.admin.token);const list=await console.get('/console/packs');assert.equal(list.status,200);assert.match(list.body,/要完成一项有验收要求的任务/);const skills=await console.get('/console/skills');assert.equal(skills.status,200);assert.match(skills.body,/要让客户端遵循一套通用做法/);assert.match(skills.body,/技能不设验收要求/);
 for(const kind of PACK_KIND){const response=await console.get('/console/operations/pack?kind='+kind);assert.equal(response.status,200,response.body);assert.ok(response.body.includes(packPurpose(kind)),kind);assert.ok(response.body.includes('action="/console/admin/do/pack-stage'+(kind==='workflow'?'':'?kind='+kind)+'"'));assert.match(response.body,/类型仍由 pack.json 声明并按原规则校验/);for(const target of ['workflow','skill','system'])assert.ok(response.body.includes('href="/console/operations/pack?kind='+target+'"'));assert.equal(publishingKind({url:new URL('http://example.invalid/?kind='+kind)} as PageContext),kind);}
});

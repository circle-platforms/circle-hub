import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createTestServer} from './testing.ts';
import {createTestHub} from './testing-real.ts';
import {openConsole} from '../../tests/acceptance/support/console.ts';
import {packPurpose,publishingKind} from './console/pack-display.ts';
import {PACK_KIND} from '../../contracts/generated/vocabulary.ts';
import type {PageContext} from './console/pages.ts';
import {INTERACTION_SCRIPT} from './console/interaction.ts';

test('the connections page is one list a tab, each tab an address of its own, and members see their clients only',async t=>{
 const hub=await createTestServer();t.after(()=>hub.close());const user=await hub.createUser('合成目录读者');
 const admin=await openConsole(hub,hub.admin.token);
 const tabsOf=(body:string)=>[...(/<nav class="ch-seg" aria-label="连接内容" data-connection-tabs>([\s\S]*?)<\/nav>/.exec(body)?.[1]??'').matchAll(/<a href="([^"]+)"( aria-current="page")?>([^<]+)/g)].map(match=>[match[1],!!match[2],match[3].trim()]);
 const first=await admin.get('/console/connections');assert.equal(first.status,200,first.body);
 assert.deepEqual(tabsOf(first.body),[['/console/connections',true,'业务系统'],['/console/connections?tab=packs',false,'业务系统接入'],['/console/connections?tab=clients',false,'客户端'],['/console/connections?tab=environments',false,'运行环境']]);
 // Decision 151: no directory of anchors down one long page, no diagram that repeats two of its lists, nothing planned.
 assert.doesNotMatch(first.body,/ch-page-toc|本页内容|已登记的连接关系|多终端协同|消息通知|ch-stats/);
 const lists={systems:'live-systems',packs:'live-system-sources',clients:'live-circles',environments:'live-environments'};
 for(const [tab,id] of Object.entries(lists)){
  const reply=await admin.get('/console/connections'+(tab==='systems'?'':'?tab='+tab));assert.equal(reply.status,200,tab);
  for(const [other,otherId] of Object.entries(lists))assert.equal(reply.body.includes(' id="'+otherId+'"'),other===tab,tab+' shows '+other);
  assert.deepEqual(tabsOf(reply.body).filter(row=>row[1]).map(row=>row[0]),['/console/connections'+(tab==='systems'?'':'?tab='+tab)],tab);
  assert.match(reply.body,/data-theme-switch/);
 }
 assert.match((await admin.get('/console/connections?tab=packs')).body,/业务系统接入，再在连接页配置具体系统/);
 const member=await openConsole(hub,user.token);
 for(const path of ['/console/connections','/console/connections?tab=systems','/console/connections?tab=environments']){
  const mine=await member.get(path);assert.equal(mine.status,200,path);assert.deepEqual(tabsOf(mine.body),[],path);
  assert.match(mine.body,/ id="live-circles"/);assert.doesNotMatch(mine.body,/ id="live-(?:systems|environments|system-sources)"/);
  assert.match(mine.body,/业务系统和运行环境的配置仅管理员可见/);assert.doesNotMatch(mine.body,/href="\/console\/operations\/system"/);
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

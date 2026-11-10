// The existing quota control serves the team without exposing aggregate usage to members.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createTestHub} from './testing-real.ts';
import {openConsole} from '../../tests/acceptance/support/console.ts';
import {wordingProblems} from './console/testing-wording.ts';
const options={repositoryPacks:false,stubs:false,mindmapSkill:false,workbookSkill:false,xmlSkill:false,htmlSkill:false};
const csrf=(body:string)=>/name="csrf" value="([^"]+)"/.exec(body)?.[1]??'';
test('the team quota is visible and adjustable only to password-authenticated administrators',async t=>{
 const hub=await createTestHub(options);t.after(()=>hub.close());const member=await hub.createUser('合成团队容量成员'),manager=await openConsole(hub,hub.admin.token),reader=await openConsole(hub,member.token),spaces=hub.hub.knowledge.spaces!;
 const mark=await hub.records.store.watermark!(),page=await manager.get('/console/team');assert.equal(page.status,200);assert.equal(await hub.records.store.watermark!(),mark);assert.match(page.body,/团队空间容量/);assert.match(page.body,/10\.0 GB/);assert.match(page.body,/id="adjust-team-capacity"/);assert.match(page.body,/<a href="#adjust-team-capacity">调整容量…<\/a>/,'the page itself opens the dialog');assert.doesNotMatch(page.body,/capacity=team|<aside class="ch-inspector"/);assert.match(page.body,/name="space" value="team"/);assert.deepEqual(wordingProblems(page.body),[]);const selected=await manager.get('/console/team?capacity=team');assert.equal(selected.status,200,'the old address of the capacity pane still answers');assert.doesNotMatch(selected.body,/class="ch-app[^"]*is-detail|<aside class="ch-inspector"/,'with the page, not with an empty pane');assert.match(selected.body,/团队空间容量/);assert.match(selected.body,/<a href="#adjust-team-capacity">调整容量…<\/a>/);
 assert.match(page.body,/容量统计范围/);assert.match(page.body,/用于容量限额计算的内容大小/);assert.doesNotMatch(page.body,/计费范围|逻辑计费量/);
  const memberForm=await manager.get('/console/operations/member');assert.match(memberForm.body,/私人内容仍按分享权限控制/);assert.doesNotMatch(memberForm.body,/四种管理操作并查看全部记录/);
  const own=await reader.get('/console/team');assert.doesNotMatch(own.body,/团队空间容量|adjust-team-capacity|10\.0 GB/);assert.equal((await reader.post('/console/knowledge/do/quota',{csrf:csrf(own.body),space:'team',amount:'1',unit:'gb'})).status,404);
 const post=(amount:string,unit='mb',token=csrf(page.body))=>manager.post('/console/knowledge/do/quota',{csrf:token,space:'team',amount,unit});
 assert.equal((await post('1','gb','invalid')).status,403);assert.equal((await post('0.1')).status,400);const changed=await post('0.5');assert.equal(changed.status,303);assert.equal(changed.headers.location,'/console/team');assert.equal((await spaces.usage(hub.admin.principal,'team')).limit,524288);
 await spaces.setCapacity(hub.admin.principal,'team',99793);const exact=await manager.get('/console/team');assert.match(exact.body,/99,793 字节/);assert.match(exact.body,/97\.5 KB/);assert.deepEqual(wordingProblems(exact.body),[]);
 const detail=await manager.get('/console/team/'+member.user.id);assert.match(detail.body,/id="adjust-member-capacity"/);assert.doesNotMatch(detail.body,/id="adjust-team-capacity"/);
});

test('team and member management stay available without the knowledge port or its spaces feature',async t=>{
 const hub=await createTestHub(options);t.after(()=>hub.close());const member=await hub.createUser('合成无知识端口成员'),{createApp}=await import('./app.ts');
 for(const missingPort of [true,false]){
  // Management-only hosts may omit knowledge entirely; others have not enabled personal spaces.
  const deps={...hub.deps};if(missingPort)Reflect.deleteProperty(deps,'knowledge');else deps.knowledge={...deps.knowledge,spaces:undefined};
  const app=createApp(deps,{log:()=>{}}),listener=await app.listen(),port=Number(new URL(listener.url).port);
  try{
   const anonymous=await openConsole({port}),refused=await anonymous.get('/console/operations/member');assert.equal(refused.status,303);assert.match(String(refused.headers.location),/^\/console\/login\?/);
   const manager=await openConsole({port},hub.admin.token),reader=await openConsole({port},member.token);
   for(const path of ['/console/team','/console/admin','/console/team?capacity=team','/console/team/'+member.user.id]){
    const page=await manager.get(path);assert.equal(page.status,200,path);assert.equal(page.headers.location,undefined,path);assert.doesNotMatch(page.body,/团队空间容量|私人空间容量|adjust-(?:team|member)-capacity|团队容量…/);
   }
   const operation=await manager.get('/console/operations/member');assert.equal(operation.status,200);assert.match(operation.body,/action="\/console\/admin\/do\/member-add"/);
   assert.equal((await reader.get('/console/team/'+member.user.id)).status,200);
   assert.equal((await reader.get('/console/admin')).status,404);
  }finally{await app.close();}
 }
});

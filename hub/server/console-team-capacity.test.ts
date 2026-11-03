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
 const mark=await hub.records.store.watermark!(),page=await manager.get('/console/team');assert.equal(page.status,200);assert.equal(await hub.records.store.watermark!(),mark);assert.match(page.body,/团队空间容量/);assert.match(page.body,/10\.0 GB/);assert.match(page.body,/id="adjust-team-capacity"/);assert.match(page.body,/name="space" value="team"/);assert.deepEqual(wordingProblems(page.body),[]);assert.match(page.body,/href="\/console\/team\?capacity=team"/);const selected=await manager.get('/console/team?capacity=team');assert.match(selected.body,/class="ch-app[^"]*is-detail/);assert.match(selected.body,/团队空间容量/);
 const own=await reader.get('/console/team');assert.doesNotMatch(own.body,/团队空间容量|adjust-team-capacity|10\.0 GB/);assert.equal((await reader.post('/console/knowledge/do/quota',{csrf:csrf(own.body),space:'team',amount:'1',unit:'gb'})).status,404);
 const post=(amount:string,unit='mb',token=csrf(page.body))=>manager.post('/console/knowledge/do/quota',{csrf:token,space:'team',amount,unit});
 assert.equal((await post('1','gb','invalid')).status,403);assert.equal((await post('0.1')).status,400);const changed=await post('0.5');assert.equal(changed.status,303);assert.equal(changed.headers.location,'/console/team');assert.equal((await spaces.usage(hub.admin.principal,'team')).limit,524288);
 await spaces.setCapacity(hub.admin.principal,'team',99793);const exact=await manager.get('/console/team');assert.match(exact.body,/99,793 字节/);assert.match(exact.body,/97\.5 KB/);assert.deepEqual(wordingProblems(exact.body),[]);
 const detail=await manager.get('/console/team/'+member.user.id);assert.match(detail.body,/id="adjust-member-capacity"/);assert.doesNotMatch(detail.body,/id="adjust-team-capacity"/);
});

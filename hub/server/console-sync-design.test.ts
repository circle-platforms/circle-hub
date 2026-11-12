// Real console rendering preserves mode safety, privacy and server-confirmed feedback after the visual integration.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {test} from 'node:test';
import {createTestHub} from './testing-real.ts';
import {openConsole} from '../../tests/acceptance/support/console.ts';
import {wordingProblems} from './console/testing-wording.ts';
import {PersonalSyncState} from '../../contracts/src/sync.ts';
const hidden=(body:string,name:string)=>new RegExp('name="'+name+'" value="([^"]+)"').exec(body)?.[1]??'';
const options={repositoryPacks:false,stubs:false,mindmapSkill:false,workbookSkill:false,xmlSkill:false,htmlSkill:false};

test('sync Inspector and Dialogs preserve precheck, actual mode, one-time purge feedback and member metadata privacy',async t=>{
 const hub=await createTestHub(options);t.after(()=>hub.close());
 const owner=await hub.createUser('合成同步作者'),other=await hub.createUser('合成同步读者'),browser=await openConsole(hub,owner.token),admin=await openConsole(hub,hub.admin.token),reader=await openConsole(hub,other.token);
 await hub.hub.knowledge.memory.write(owner.principal,{title:'合成不公开标题',markdown:'合成不公开正文',expected_version:null,client_key:'visual-private'});
 for(const path of ['/console/knowledge?scope=personal&sync=settings','/console/knowledge?view=memory&scope=personal&sync=settings']){
  const page=await browser.get(path);assert.equal(page.status,200);assert.match(page.body,/class="ch-app[^\"]*is-detail/);assert.match(page.body,/<aside class="ch-inspector"/);assert.match(page.body,/data-sync-settings data-inspector-content/);assert.match(page.body,/上次同步/);assert.doesNotMatch(page.body,/class="(?:btn|card|actions)(?: |")/);assert.deepEqual(wordingProblems(page.body),[]);
 }
 const api=hub.records.personalSync!,state=await api.state(owner.principal);
 const preview=await browser.get('/console/knowledge?scope=personal&sync=local#sync-mode');assert.equal(preview.status,200);assert.match(preview.body,/id="sync-mode" role="dialog"/);assert.match(preview.body,/name="confirm_purge" value="true" required/);assert.deepEqual(wordingProblems(preview.body),[]);assert.equal((await api.state(owner.principal)).mode,state.mode,'opening a confirmation never writes the mode');
 const fields=Object.fromEntries(['csrf','epoch','expected_state','operation_id','check'].map(key=>[key,hidden(preview.body,key)]));
 const refused=await browser.post('/console/knowledge/do/sync-mode',{...fields,mode:'local'});assert.equal(refused.status,400);assert.equal((await api.state(owner.principal)).mode,'hub');
 const changed=await browser.post('/console/knowledge/do/sync-mode',{...fields,mode:'local',confirm_purge:'true'});assert.equal(changed.status,303);assert.equal(changed.headers.location,'/console/knowledge?scope=personal&sync=settings');
 const result=await browser.get(String(changed.headers.location));assert.match(result.body,/data-toast-success[^>]*>同步方式：仅保存在客户端设备/);assert.match(result.body,/id="sync-resume" role="dialog"/);assert.doesNotMatch(result.body,/合成不公开标题|合成不公开正文/);assert.deepEqual(wordingProblems(result.body),[]);
 const refreshed=await browser.get(String(changed.headers.location));assert.doesNotMatch(refreshed.body,/<div[^>]+data-toast-success/);assert.match(refreshed.body,/仅保存在客户端设备/);
 const detail=await admin.get('/console/team/'+owner.user.id);assert.match(detail.body,/<aside class="ch-inspector"/);assert.match(detail.body,/同步方式/);assert.match(detail.body,/仅保存在客户端设备/);assert.match(detail.body,/上次同步/);assert.doesNotMatch(detail.body,/合成不公开标题|合成不公开正文/);assert.deepEqual(wordingProblems(detail.body),[]);
 assert.equal((await reader.get('/console/team/'+owner.user.id)).status,404);
 const resume=Object.fromEntries(['csrf','epoch','expected_state','operation_id'].map(key=>[key,hidden(refreshed.body,key)]));
 assert.equal((await browser.post('/console/knowledge/do/sync-resume',resume)).status,303);
 assert.equal((await browser.post('/console/knowledge/do/sync-mode',{...fields,mode:'local',confirm_purge:'true'})).status,303);
 const replay=await browser.get('/console/knowledge?scope=personal&sync=settings');assert.match(replay.body,/data-toast-success[^>]*>同步方式：同步到 Hub/);assert.doesNotMatch(replay.body,/私人空间内容已清除/);

});

test('conflict facts come from the current owner head and keep conflicted memory out of session content',async t=>{
 const hub=await createTestHub(options);t.after(()=>hub.close());const owner=await hub.createUser('合成冲突作者'),other=await hub.createUser('合成无关成员'),sync=hub.hub.knowledge.personalSync!,raw=sync.transport;
 const exchange=JSON.parse(readFileSync(new URL('../../contracts/test-fixtures/sync/v1/exchange.json',import.meta.url),'utf8'));
 const shared=JSON.parse(readFileSync(new URL('../../contracts/test-fixtures/sync/v1/scenarios.json',import.meta.url),'utf8'));
 const objects=new Map<string,{id:string;canonical:string}>([...shared.objects,...Object.values(exchange.objects) as {id:string;canonical:string}[]].map(row=>[row.id,row]));
 const initial=await sync.state(owner.principal),client_id=randomUUID();await raw.registerClient(owner.principal,{client_id,name:'synthetic visual client'});
 const session=await sync.openSession(owner.principal,{client_id,epoch:initial.epoch,known_state:initial.state_version,base_snapshot:initial.snapshot});
 const id=(name:string):string=>exchange.objects[name].id;
 const upload=async(ids:string[])=>raw.upload(owner.principal,session.session_id,{schema:'personal-sync-upload@1',epoch:initial.epoch,operation_id:randomUUID(),objects:ids.map(id=>{const row=objects.get(id)!;return {id,bytes_base64:Buffer.from(row.canonical).toString('base64')};})});
 const commit=(state:ReturnType<typeof PersonalSyncState.parse>,snapshot:string,base=state.snapshot)=>sync.commit(owner.principal,session.session_id,{schema:'personal-sync-commit@1',epoch:initial.epoch,operation_id:randomUUID(),expected_state:state.state_version,base_snapshot:base,snapshot});
 await upload([id('directory'),exchange.memory.base,id('memory-base-page'),id('memory-base')]);const base=await commit(initial,id('memory-base'));
 await upload([exchange.memory.left,exchange.memory.right,id('memory-left-page'),id('memory-left'),id('memory-right-page'),id('memory-right'),id('memory-conflict-page'),id('memory-conflict')]);
 const left=await commit(base.state,id('memory-left'));const conflict=await commit(left.state,id('memory-conflict'),base.state.snapshot);assert.equal(conflict.conflicts.length,1);
 const browser=await openConsole(hub,owner.token),reader=await openConsole(hub,other.token);
 for(const view of ['','&view=memory']){
  const page=await browser.get('/console/knowledge?scope=personal&sync=settings'+view);assert.equal(page.status,200);assert.match(page.body,/ch-badge--warn/);assert.match(page.body,/ch-stat-label">有冲突/);assert.match(page.body,/ch-stat-value">1/);assert.match(page.body,/<time /);assert.deepEqual(wordingProblems(page.body),[]);
  const absent=await reader.get('/console/knowledge?scope=personal&sync=settings'+view);assert.doesNotMatch(absent.body,/ch-stat-label">有冲突/);
 }
 assert.equal((await hub.hub.knowledge.memory.query(owner.principal,{scope:'personal',for_session:true})).memory_page?.items.length,0);
});

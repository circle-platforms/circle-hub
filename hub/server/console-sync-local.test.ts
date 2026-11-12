// Real password sessions and MCP preserve empty local personal views and an explicit own-account resume entry.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {writePack,workflowPack} from '../runs/packs/testing/builder.ts';
import {createTestHub} from './testing-real.ts';
import {openConsole} from '../../tests/acceptance/support/console.ts';
import {connect} from '../../tests/acceptance/support/mcp.ts';
import {RunRecord} from '../../contracts/src/run.ts';
const hidden=(body:string,name:string)=>new RegExp('name="'+name+'" value="([^"]+)"').exec(body)?.[1]??'';

test('purged personal knowledge and memory stay empty, console offers a fresh Hub epoch, and old grants never revive',async t=>{
 const hub=await createTestHub({repositoryPacks:false,stubs:false,mindmapSkill:false,workbookSkill:false,xmlSkill:false,htmlSkill:false});t.after(()=>hub.close());
 const owner=await hub.createUser('合成本机作者'),other=await hub.createUser('合成其他成员'),spaces=hub.hub.knowledge.spaces!,api=hub.records.personalSync!;
 const entry=await spaces.write(owner.principal,{kind:'observation',statement:'合成旧私人条目',path:'/old'});
 await spaces.grant(owner.principal,{path:'/old',audience:'member',member:other.user.id});
 await hub.hub.knowledge.memory.write(owner.principal,{space:'personal',title:'合成旧私人记忆',markdown:'合成旧偏好',expected_version:null,client_key:'old'});
 await hub.hub.knowledge.memory.write(hub.admin.principal,{space:'team',title:'合成团队保留',markdown:'合成团队偏好',expected_version:null,client_key:'team'});
 const own=await openConsole(hub,owner.token),admin=await openConsole(hub,hub.admin.token),client=await connect(hub,owner.token);t.after(()=>client.close());
 const initial=await api.state(owner.principal);await hub.records.personalPayloads!.purge(owner.principal,initial.epoch);
 for(const path of ['/console/knowledge?scope=personal','/console/knowledge?scope=all','/console/knowledge?view=memory&scope=personal','/console/knowledge?view=memory&scope=all','/console/knowledge/space?space='+owner.user.id]){
  const page=await own.get(path);assert.equal(page.status,200,page.body);assert.match(page.body,/仅保存在客户端设备/);assert.match(page.body,/action="\/console\/knowledge\/do\/sync-resume"/);assert.doesNotMatch(page.body,/SYNC_MODE_LOCAL|合成旧私人|合成旧偏好/);
  assert.doesNotMatch(page.body,/action="\/console\/knowledge\/do\/(?:entry|import|memory-write|memory-grant)"/);
 }
 for(const args of [{},{space:owner.user.id}]){const page=await client.call('get_nodes',args);assert.equal(page.isError,false,page.text);assert.deepEqual(page.out.nodes,[]);assert.equal(page.out.root,undefined);assert.equal(page.out.coverage?.total,0);}
 const memory=await client.call('get_nodes',{memory:{scope:'personal'}});assert.equal(memory.isError,false,memory.text);assert.equal(memory.out.memory_page?.items.length,0);
 const team=await client.call('get_nodes',{memory:{scope:'team'}});assert.equal(team.isError,false,team.text);assert.match(team.text,/合成团队保留/);
 assert.equal((await client.call('get_nodes',{reference:entry.reference})).isError,true);
 assert.equal((await spaces.visible(owner.principal,'personal')).length,0);assert.equal((await spaces.locks(owner.principal)).personal,null);
 // The wire shape explicitly freezes absence, instead of fabricating a private root in local mode.
 assert.ok(RunRecord.shape.knowledge_spaces.unwrap().safeParse(await spaces.locks(owner.principal)).success);
 const directory=await mkdtemp(join(tmpdir(),'synthetic-local-run-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const pack=workflowPack({id:'synthetic-local-review',product:{catalogs:[]}});pack.files['knowledge.json']={schema:'knowledge@1',requires:[]};
 const written=await writePack(join(directory,'review'),pack);
 const published=await hub.hub.registry.publish(hub.admin.principal,written.dir);assert.ok(published.ok,JSON.stringify(published));
 await hub.hub.registry.assign(hub.admin.principal,owner.user.id,pack.id);
 const input=await client.upload(Buffer.from(JSON.stringify({items:[{id:'a',fields:{title:'合成仅本机用户仍能运行'}}]})),'synthetic-run.json','application/json');
 const run=await client.call('start_run',{pack:pack.id,inputs:{target:{reference:input}}});assert.equal(run.isError,false,run.text);assert.equal(run.out.run?.knowledge_spaces?.personal,null);
 const frozen=await client.call('get_nodes',{run:run.out.run!.run,space:owner.user.id});assert.equal(frozen.isError,false,frozen.text);assert.deepEqual(frozen.out.nodes,[]);
 const search=await client.call('get_nodes',{search:'合成旧私人条目',scope:'personal'});assert.equal(search.isError,false,search.text);assert.deepEqual(search.out.matches,[]);
 const page=await own.get('/console/knowledge?scope=personal'),fields={csrf:hidden(page.body,'csrf'),epoch:hidden(page.body,'epoch'),expected_state:hidden(page.body,'expected_state'),space:owner.user.id};
 const adminHome=await admin.get('/console/knowledge');const denied=await admin.post('/console/knowledge/do/sync-resume',{...fields,csrf:hidden(adminHome.body,'csrf')});assert.ok(denied.status>=400);assert.equal((await api.state(owner.principal)).mode,'local');
 const lateEntry=await own.post('/console/knowledge/do/entry',{csrf:fields.csrf,space:owner.user.id,path:'/late',kind:'observation',statement:'合成过期表单',reason:'synthetic-stale-form'});assert.equal(lateEntry.status,400,lateEntry.body);assert.doesNotMatch(lateEntry.body,/内部错误/);
 const lateMemory=await own.post('/console/knowledge/do/memory-write',{csrf:fields.csrf,space:'personal',expected_version:'',title:'合成过期记忆',markdown:'合成过期表单',client_key:'late-form'});assert.equal(lateMemory.status,400,lateMemory.body);assert.doesNotMatch(lateMemory.body,/内部错误/);
 const badCsrf=await own.post('/console/knowledge/do/sync-resume',{...fields,csrf:'invalid'});assert.equal(badCsrf.status,403);
 const resumed=await own.post('/console/knowledge/do/sync-resume',fields);assert.equal(resumed.status,303,resumed.body);
 const next=await api.state(owner.principal);assert.equal(next.mode,'hub');assert.notEqual(next.epoch,initial.epoch);
 const stale=await own.post('/console/knowledge/do/sync-resume',fields);assert.equal(stale.status,400,stale.body);
 const fresh=await client.call('upload_file',{personal_entry:{kind:'observation',statement:'合成新私人条目',path:'/old'}});assert.equal(fresh.isError,false,fresh.text);assert.notEqual(fresh.out.personal_entry?.root,entry.root);
 assert.equal((await spaces.visible(other.principal,'shared')).length,0,'old grants are not resurrected by reusing a directory');
 assert.equal((await client.call('get_nodes',{reference:entry.reference})).isError,true);
});

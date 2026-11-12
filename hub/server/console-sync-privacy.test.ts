import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createTestHub} from './testing-real.ts';
import {openConsole} from '../../tests/acceptance/support/console.ts';
import {connect} from '../../tests/acceptance/support/mcp.ts';
test('real console receipts and team provenance mask cleared source paths without withdrawing team copies',async t=>{
 const hub=await createTestHub({repositoryPacks:false,stubs:false,mindmapSkill:false,workbookSkill:false,xmlSkill:false,htmlSkill:false});t.after(()=>hub.close());
 const owner=await hub.createUser('合成私人作者'),spaces=hub.hub.knowledge.spaces!,path='/synthetic-private-directory';
 const original=await hub.records.artifacts.ingest({bytes:Buffer.from('合成共享原文：保留两份。'),mediaType:'text/plain',origin:{read:{object:'synthetic:document:public'}},author:{user:null},provenanceType:'observed',visibility:{readers:[owner.user.id],admins:true,packs:[],shareable:false}});
 const entry=await spaces.write(owner.principal,{kind:'observation',statement:'合成团队知识保留',path,grounds:[{reference:'src:'+original.body.sha256,quotation:'保留两份'}]});
 const shared=await spaces.share(owner.principal,{root:entry.root,path,entry:entry.entry,team_path:'/synthetic-team-directory'});assert.equal(shared.status,'merged',JSON.stringify(shared));
 const browser=await openConsole(hub,hub.admin.token),mcp=await connect(hub,owner.token);t.after(()=>mcp.close());
 assert.match((await browser.get('/console/records?tab=sharing')).body,/synthetic-private-directory/);
 const epoch=(await hub.records.personalPayloads!.inspect(entry.root))!.epoch;await hub.records.personalPayloads!.purge(owner.principal,epoch);
 const recordPage=await browser.get('/console/records?tab=sharing');assert.equal(recordPage.status,200,recordPage.body);assert.doesNotMatch(recordPage.body,/synthetic-private-directory/);assert.match(recordPage.body,/已清除的私人文件夹/);
 for(const detailed of [false,true]){
  const params:Record<string,string>={space:'team',root:shared.team_root!,path:'/synthetic-team-directory'};if(detailed)params.entry=entry.entry;
  const page=await browser.get('/console/knowledge/space?'+new URLSearchParams(params));assert.equal(page.status,200,page.body);assert.doesNotMatch(page.body,/synthetic-private-directory/);assert.match(page.body,/合成团队知识保留/);
 }
 assert.equal((await mcp.call('get_nodes',{reference:'rec:'+shared.record})).isError,true);
 assert.equal((await mcp.call('get_nodes',{reference:entry.reference})).isError,true);
 assert.equal((await spaces.entry(hub.admin.principal,shared.team_root!,'/synthetic-team-directory',entry.entry))?.body.content.statement,'合成团队知识保留');
});

// Decision 140 block 1, synthetic private uploads, real browser boundaries and MCP; no external systems.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {z} from 'zod';
import {SpaceSourceBody} from '../../contracts/src/spaces.ts';
import {createTestHub} from '../../hub/server/testing-real.ts';
import {openConsole} from './support/console.ts';
import {connect} from './support/mcp.ts';
import {wordingProblems} from '../../hub/server/console/testing-wording.ts';
const csrf=(markup:string)=>/name="csrf" value="([^"]+)"/.exec(markup)![1];
test('only uploader confirmation signs a source and existing MCP sharing records declared team attribution without exposing private records',async()=>{
 const hub=await createTestHub({repositoryPacks:false,stubs:false,mindmapSkill:false,workbookSkill:false,xmlSkill:false,htmlSkill:false});
 let client:Awaited<ReturnType<typeof connect>>|undefined,adminClient:typeof client,peerClient:typeof client;
 try{
  const user=await hub.createUser('合成署名成员'),peer=await hub.createUser('合成署名读者'),spaces=hub.hub.knowledge.spaces!;
  const web=await openConsole(hub,user.token),adminWeb=await openConsole(hub,hub.admin.token),peerWeb=await openConsole(hub,peer.token);
  client=await connect(hub,user.token);adminClient=await connect(hub,hub.admin.token);peerClient=await connect(hub,peer.token);
  const raw='合成原文：保留两份。\n原文未核验Circle42历史依据';
  const file=await spaces.importFile(user.principal,Buffer.from(raw),'text/plain','合成原文.txt','/资料','synthetic-attribution-session');
  const source=(await hub.records.store.find<z.infer<typeof SpaceSourceBody>>({kind:'knowledge_space_source',key:'knowledge.space.source_hash',value:file.body.sha256})).items[0];
  const original=await hub.records.store.get(file.digest),saved=await spaces.write(user.principal,{kind:'observation',statement:'合成带来源条目',grounds:[{reference:'src:'+file.body.sha256,quotation:'保留两份'}]});
  const input={root:saved.root,path:'/',entry:saved.entry};assert.equal((await client.call('upload_file',{share_entry:input})).out.share?.code,'SHARE_UPLOAD_UNSIGNED');
  const url='/console/knowledge/source?'+new URLSearchParams({sha256:file.body.sha256,artifact:file.digest});
  const page=await web.get(url+'#attribute-source');assert.equal(page.status,200);assert.match(page.body,/署名为团队来源…/);assert.match(page.body,/团队已经取得的副本不会因收回文件夹分享而收回/);assert.ok(page.body.includes(raw));assert.deepEqual(wordingProblems(page.body),[]);
  assert.equal((await hub.records.store.list({kind:'knowledge_source_attribution'})).items.length,0,'opening the confirmation is read-only');
  const action='/console/knowledge/do/attribute-source',fields={source:source.digest,artifact:file.digest,csrf:csrf(page.body)};
  assert.equal((await web.post(action,{...fields,csrf:'wrong'})).status,403);
  const cross=await web.send(action,{method:'POST',headers:{origin:'https://192.0.2.9','content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams(fields).toString()});assert.equal(cross.status,403);
  for(const outsider of [adminWeb,peerWeb]){assert.equal((await outsider.get(url)).status,404);const token=csrf((await outsider.get('/console/overview')).body);const denied=await outsider.post(action,{...fields,csrf:token});assert.equal(denied.status,404);assert.ok(!denied.body.includes('合成原文.txt'));}
  assert.equal((await web.post(action,fields)).status,303);assert.equal((await web.post(action,fields)).status,303);
  const declarations=(await hub.records.store.list({kind:'knowledge_source_attribution'})).items;assert.equal(declarations.length,1);const declaration=declarations[0];assert.equal(declaration.provenance,'declared');assert.equal((declaration.body as {by:string}).by,user.user.id);
  const signed=await web.get(url);assert.match(signed.body,/已署名为团队来源/);assert.deepEqual(wordingProblems(signed.body),[]);
  for(const reader of [client,adminClient,peerClient]){const denied=await reader.call('get_nodes',{reference:'rec:'+declaration.digest}),absent=await reader.call('get_nodes',{reference:'rec:'+'f'.repeat(64)});assert.equal(denied.isError,true);assert.equal(denied.out.errors?.[0]?.code,'SOURCE_UNAVAILABLE','a private attribution cannot be read as a generic record');assert.equal(absent.out.errors?.[0]?.code,'SOURCE_ABSENT');}
  const shared=await client.call('upload_file',{share_entry:input});assert.equal(shared.out.share?.status,'merged',shared.text);const root=shared.out.share!.team_root!;
  const teamUrl='/console/knowledge/space?'+new URLSearchParams({space:'team',root,path:'/',entry:saved.entry});
  const team=await peerWeb.get(teamUrl);assert.equal(team.status,200);assert.match(team.body,/署名人/);assert.ok(team.body.includes(user.user.name));assert.match(team.body,/声明/);assert.deepEqual(wordingProblems(team.body),[]);
  const facts=await spaces.entryAttributions(peer.principal,root,'/',saved.entry);assert.equal(facts[0].record,declaration.digest);
  const readUrl='/console/knowledge/source?'+new URLSearchParams({sha256:file.body.sha256,artifact:facts[0].artifact});const read=await peerWeb.get(readUrl);assert.equal(read.status,200);assert.ok(read.body.includes(raw));assert.doesNotMatch(read.body,/href="#attribute-source"/);assert.deepEqual(wordingProblems(read.body),[]);
  assert.equal((await peerWeb.get(url)).status,404,'publishing creates a team association, not private ACL access');assert.deepEqual(await hub.records.store.get(file.digest),original);
 }finally{await client?.close();await adminClient?.close();await peerClient?.close();await hub.close();}
});

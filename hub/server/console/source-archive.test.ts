// A late renderer metadata await must not disclose a previously resolved private original.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createTestHub} from '../testing-real.ts';
import {originalInspector} from './source-archive.ts';
import type {PageContext} from './pages.ts';
import {openConsole} from '../../../tests/acceptance/support/console.ts';
test('the original inspector rechecks access after asynchronous account-name metadata',async()=>{
 const hub=await createTestHub({repositoryPacks:false,stubs:false,mindmapSkill:false,workbookSkill:false,xmlSkill:false,htmlSkill:false});
 try{
  const owner=await hub.createUser('合成原文作者'),reader=await hub.createUser('合成原文读者'),spaces=hub.hub.knowledge.spaces!,file=await spaces.importFile(owner.principal,Buffer.from('合成私有原文正文'),'text/plain','合成私人名称','/分享');await spaces.grant(owner.principal,{path:'/分享',audience:'member',member:reader.user.id});
  const ctx:PageContext={deps:hub.deps,principal:reader.principal,admin:false,chrome:()=>assert.fail('the inspector must reject before rendering page chrome'),csrf:'synthetic-csrf',url:new URL(hub.url+'/console/knowledge/source'),userName:async()=>{await spaces.grant(owner.principal,{path:'/分享',audience:'member',member:reader.user.id,revoke:true});return owner.user.name;}};
  await assert.rejects(originalInspector(ctx,{sha256:file.body.sha256,artifact:file.digest}),{code:'SOURCE_UNAVAILABLE'});
  const independent=await hub.records.artifacts.ingest({bytes:Buffer.from('合成独立原文供私人知识引用'),mediaType:'text/plain',name:'合成独立原文',origin:{upload:{session:'synthetic-independent-source'}},author:{user:reader.user.id},provenanceType:'declared',visibility:{readers:[owner.user.id,reader.user.id],admins:false,packs:[],shareable:false}});
  const entry=await spaces.write(owner.principal,{kind:'observation',path:'/私人知识',statement:'合成私人引文选择',grounds:[{reference:'src:'+independent.body.sha256,quotation:'合成独立原文'}]});await spaces.grant(owner.principal,{path:'/私人知识',audience:'member',member:reader.user.id});
  ctx.userName=async()=>{await spaces.grant(owner.principal,{path:'/私人知识',audience:'member',member:reader.user.id,revoke:true});return reader.user.name;};
  await assert.rejects(originalInspector(ctx,{sha256:independent.body.sha256,artifact:independent.digest,root:entry.root,path:'/私人知识',entry:entry.entry,ground:0}),{code:'SOURCE_UNAVAILABLE'});assert.ok((await spaces.source(reader.principal,independent.body.sha256,undefined,'model',independent.digest))?.bytes,'independent raw read rights cannot lend revoked entry/quote access');
 }finally{await hub.close();}
});

test('the way back from an original leads to the entry it was opened from, in whichever space that entry is',async()=>{
 const hub=await createTestHub({repositoryPacks:false,stubs:false,mindmapSkill:false,workbookSkill:false,xmlSkill:false,htmlSkill:false});
 try{
  const owner=await hub.createUser('合成条目作者'),reader=await hub.createUser('合成条目读者'),spaces=hub.hub.knowledge.spaces!;
  const source=await hub.records.artifacts.ingest({bytes:Buffer.from('合成共享原文供条目引用'),mediaType:'text/plain',name:'合成共享原文',origin:{upload:{session:'synthetic-shared-source'}},author:{user:owner.user.id},provenanceType:'declared',visibility:{readers:[owner.user.id,reader.user.id],admins:false,packs:[],shareable:false}});
  const entry=await spaces.write(owner.principal,{kind:'observation',path:'/共享知识',statement:'合成共享条目',grounds:[{reference:'src:'+source.body.sha256,quotation:'合成共享原文'}]});
  await spaces.grant(owner.principal,{path:'/共享知识',audience:'member',member:reader.user.id});
  const hrefOf=(body:string,text:string)=>new RegExp('<a href="([^"]+)"[^>]*>'+text+'</a>').exec(body)?.[1].replace(/&amp;/g,'&');
  // The owner's own entry, and the same entry read by the member it is shared with: the second is in another account's space.
  for(const account of [owner,reader]){
   const browser=await openConsole(hub,account.token);
   const opened=await browser.get('/console/knowledge/space?'+new URLSearchParams({space:owner.user.id,path:'/共享知识',entry:entry.entry}));assert.equal(opened.status,200,account.user.name);
   const original=hrefOf(opened.body,'打开原文');assert.ok(original,'the entry links to its original');
   const page=await browser.get(original!.split('#')[0]);assert.equal(page.status,200,account.user.name);
   const back=hrefOf(page.body,'返回条目');assert.ok(back,'the original links back to the entry');
   assert.equal(new URLSearchParams(back!.split('?')[1]).get('space'),owner.user.id,'the way back names the space of the entry');
   const returned=await browser.get(back!);assert.equal(returned.status,200,account.user.name+' returns to the entry');assert.match(returned.body,/合成共享条目/);
  }
 }finally{await hub.close();}
});

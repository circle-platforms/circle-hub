// A late renderer metadata await must not disclose a previously resolved private original.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createTestHub} from '../testing-real.ts';
import {originalInspector} from './source-archive.ts';
import type {PageContext} from './pages.ts';
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

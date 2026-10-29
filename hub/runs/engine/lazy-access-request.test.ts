import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { artifactShareKey, withRequestPermissions } from '../../records/api.ts';
import { createDefaultRegistry, createDocumentCache } from '../../refs/api.ts';
import { callPackFunction } from '../../rules/api.ts';
import { openTestRecords } from '../../testing/records.ts';
import { createResolver, type RunScope } from './exact.ts';
import type { EngineContext } from './deps.ts';

test('a request keeps its initial access while a real sandbox locates, and the next request sees withdrawal', async () => {
  const kit = await openTestRecords(), dir = await mkdtemp(join(tmpdir(), 'synthetic-request-auth-'));
  try {
    await writeFile(join(dir,'fn.ts'),`export default async function(input){await new Promise(resolve=>setTimeout(resolve,400));return {selector:'n/x',text:input.text,byteRange:null}}`);
    const admin = (await kit.principals.bootstrapAdmin('synthetic-admin')).user;
    const owner = await kit.principals.createUser(admin,'synthetic-owner'), user = await kit.principals.createUser(admin,'synthetic-reader');
    const text = 'synthetic source';
    const source = await kit.artifacts.ingest({bytes:Buffer.from(text),mediaType:'application/x-synthetic',origin:{upload:{session:'synthetic'}},author:{user:owner.id},provenanceType:'declared',visibility:{readers:[owner.id],admins:true,packs:[],shareable:true}});
    const key=artifactShareKey(source); await kit.authorizations.share(admin,key,[user.id]);
    const parsers=createDefaultRegistry(); let once=false;
    parsers.register({id:'synthetic',version:1,mediaTypes:['application/x-synthetic'],limits:{maxBytes:4096,maxDepth:10,maxNodes:10},parse(){return {parser:'synthetic@1',model:{},summary:()=>({}),listSelectors:()=>['n/x'],async locate(){
      const pending=callPackFunction({packDir:dir,module:'fn.ts'},{text},{timeoutMs:5000},{requireOsIsolation:false});
      if(!once){once=true;await kit.authorizations.unshare(admin,key,user.id);}
      return (await pending).output as {selector:string;text:string;byteRange:null};
    }};}});
    const sha=source.body.sha256, scope={reader:{user:user.id,role:user.role},sources:new Map([[sha,'subject']]),records:new Map(),subject:{shas:new Set([sha]),records:new Set()},root:null,compositions:[],catalogs:[],candidates:async()=>[]} as unknown as RunScope;
    const ctx={deps:{records:kit,knowledge:{treeReader:()=>({})}},parsers,documents:createDocumentCache(),log:()=>{}} as unknown as EngineContext;
    const reference=`src:${sha}/synthetic@1/n/x`;
    const first=await withRequestPermissions(kit.artifacts,user,()=>createResolver(ctx,scope,'model').resolve(reference));
    assert.ok(first.ok); if(first.ok)assert.equal(first.value.text,text);
    const next=await withRequestPermissions(kit.artifacts,user,()=>createResolver(ctx,scope,'model').resolve(reference));
    assert.equal(next.ok,false);
  } finally { await rm(dir,{recursive:true,force:true}); await kit.close(); }
});

test('forty references to one safe source share one authorized read within a request', async () => {
  const kit=await openTestRecords();
  try {
    const admin=(await kit.principals.bootstrapAdmin('synthetic-admin')).user;
    const source=await kit.artifacts.ingest({bytes:Buffer.from('synthetic document'),mediaType:'application/x-synthetic',origin:{upload:{session:'synthetic'}},author:{user:admin.id},provenanceType:'declared',visibility:{readers:[admin.id],admins:true,packs:[],shareable:false}});
    let reads=0;const original=kit.artifacts.source.bind(kit.artifacts);
    const artifacts=new Proxy(kit.artifacts,{get(target,key){if(key==='source')return async (...args:Parameters<typeof original>)=>{reads++;return original(...args);};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
    const parsers=createDefaultRegistry();parsers.register({id:'synthetic',version:1,mediaTypes:['application/x-synthetic'],limits:{maxBytes:4096,maxDepth:10,maxNodes:100},parse(){return {parser:'synthetic@1',model:{},summary:()=>({}),listSelectors:()=>[],prefetch:async()=>{},locate:selector=>({selector,text:'synthetic',byteRange:null})};}});
    const sha=source.body.sha256,scope={reader:{user:admin.id,role:admin.role},sources:new Map([[sha,'subject']]),records:new Map(),subject:{shas:new Set([sha]),records:new Set()},root:null,compositions:[],catalogs:[],candidates:async()=>[]} as unknown as RunScope;
    const ctx={deps:{records:{...kit,artifacts},knowledge:{treeReader:()=>({})}},parsers,documents:createDocumentCache(),log:()=>{}} as unknown as EngineContext;
    const references=Array.from({length:40},(_,i)=>`src:${sha}/synthetic@1/n/${i}`);
    await withRequestPermissions(kit.artifacts,admin,async()=>{const resolver=createResolver(ctx,scope,'model');await resolver.prefetch(references);for(const reference of references)assert.ok((await resolver.resolve(reference)).ok);});
    assert.equal(reads,1);
    await withRequestPermissions(kit.artifacts,admin,async()=>{assert.ok((await createResolver(ctx,scope,'model').resolve(references[0])).ok);});
    assert.equal(reads,2,'the next request makes its own access decision');
  } finally { await kit.close(); }
});

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { artifactShareKey } from '../../records/api.ts';
import { createDefaultRegistry, createDocumentCache } from '../../refs/api.ts';
import { callPackFunction } from '../../rules/api.ts';
import { openTestRecords } from '../../testing/records.ts';
import { createResolver, type RunScope } from './exact.ts';
import type { EngineContext } from './deps.ts';

test('sharing withdrawn while a real sandbox locates a fragment prevents stale disclosure', async () => {
 const kit=await openTestRecords(),dir=await mkdtemp(join(tmpdir(),'synthetic-lazy-auth-'));
 try {
  await writeFile(join(dir,'fn.ts'),`export default async function(input){await new Promise(resolve=>setTimeout(resolve,1000));return {selector:'n/x',text:input.text,byteRange:null}}`);
  const admin=(await kit.principals.bootstrapAdmin('synthetic-admin')).user;
  const owner=await kit.principals.createUser(admin,'synthetic-owner'),user=await kit.principals.createUser(admin,'synthetic-reader');
  const text='SYNTHETIC_PRIVATE_CONTENT';
  const source=await kit.artifacts.ingest({bytes:Buffer.from(text),mediaType:'application/x-synthetic',origin:{upload:{session:'synthetic'}},author:{user:owner.id},provenanceType:'declared',visibility:{readers:[owner.id],admins:true,packs:[],shareable:true}});
  const key=artifactShareKey(source); await kit.authorizations.share(admin,key,[user.id]);
  let duringSandbox=false,completed=false;
  const parsers=createDefaultRegistry();
  parsers.register({id:'synthetic',version:1,mediaTypes:['application/x-synthetic'],limits:{maxBytes:4096,maxDepth:10,maxNodes:10},parse(){return {parser:'synthetic@1',model:{},summary:()=>({}),listSelectors:()=>['n/x'],async locate(){
    const invocation=callPackFunction({packDir:dir,module:'fn.ts',export:'default'},{text},{timeoutMs:5000},{requireOsIsolation:false}).then(value=>{completed=true;return value;});
    await new Promise(resolve=>setTimeout(resolve,250));
    await kit.authorizations.unshare(admin,key,user.id); duringSandbox=!completed;
    const result=await invocation;return result.output as {selector:string;text:string;byteRange:null};
  }};}});
  const sha=source.body.sha256;
  const ctx={deps:{records:kit,knowledge:{treeReader:()=>({})}},parsers,documents:createDocumentCache(),log:()=>{}} as unknown as EngineContext;
  const scope={reader:{user:user.id,role:user.role},sources:new Map([[sha,'subject']]),records:new Map(),subject:{shas:new Set([sha]),records:new Set()},root:null,compositions:[],catalogs:[],candidates:async()=>[]} as unknown as RunScope;
  const outcome=await createResolver(ctx,scope,'model').resolve(`src:${sha}/synthetic@1/n/x`);
  assert.equal(duringSandbox,true); assert.equal(completed,true);
  assert.equal(await kit.artifacts.source(user,sha,{consumer:'model'}),null);
  assert.equal(outcome.ok,false); assert.ok(!JSON.stringify(outcome).includes(text));
  await kit.authorizations.share(admin,key,[user.id]);
  parsers.register({id:'synthetic-bad',version:1,mediaTypes:['application/x-bad'],limits:{maxBytes:4096,maxDepth:10,maxNodes:10},parse(){return {parser:'synthetic-bad@1',model:{},summary:()=>({}),listSelectors:()=>['n/x'],locate:()=>({selector:'n/%41',text:'synthetic',byteRange:null})};}});
  const notes:string[]=[];ctx.log=entry=>notes.push(entry.detail);
  const bad=await createResolver(ctx,scope,'model').resolve(`src:${sha}/synthetic-bad@1/n/x`);
  assert.equal(bad.ok,false);
  assert.ok(!JSON.stringify({bad,notes}).includes('U+0041'), 'package-controlled invalid selector details are not disclosed');
 } finally {await rm(dir,{recursive:true,force:true});await kit.close();}
});

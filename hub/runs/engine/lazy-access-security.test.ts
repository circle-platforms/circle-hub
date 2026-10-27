import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { artifactShareKey } from '../../records/api.ts';
import { createDefaultRegistry, createDocumentCache } from '../../refs/api.ts';
import { SandboxError } from '../../rules/api.ts';
import { openTestRecords } from '../../testing/records.ts';
import { createResolver, type RunScope } from './exact.ts';
import type { EngineContext } from './deps.ts';
import { HubReadFailure } from './retry-read.ts';

test('prefetch and repeated source resolutions recheck current sharing and scan acceptance', async () => {
  const kit = await openTestRecords();
  try {
    const admin = (await kit.principals.bootstrapAdmin('synthetic-admin')).user;
    const owner = await kit.principals.createUser(admin, 'synthetic-owner');
    const user = await kit.principals.createUser(admin, 'synthetic-reader');
    const make = (sha: string) => createResolver({deps:{records:kit,knowledge:{treeReader:()=>({})}},parsers:createDefaultRegistry(),documents:createDocumentCache(),log:()=>{}} as unknown as EngineContext,
      {reader:{user:user.id,role:user.role},sources:new Map([[sha,'subject']]),records:new Map(),subject:{shas:new Set([sha]),records:new Set()},root:null,compositions:[],catalogs:[],candidates:async()=>[]} as unknown as RunScope,'model');
    const upload = await kit.artifacts.ingest({bytes:Buffer.from('合成原文一\n合成原文二'),mediaType:'text/plain',origin:{upload:{session:'synthetic'}},author:{user:owner.id},provenanceType:'declared',visibility:{readers:[owner.id],admins:true,packs:[],shareable:true}});
    const sha=upload.body.sha256, ref=`src:${sha}/text@1/l/1`, key=artifactShareKey(upload);
    await kit.authorizations.share(admin,key,[user.id]);
    const r=make(sha); await r.prefetch([ref]);
    assert.equal((await r.resolve(ref)).ok,true);
    await kit.authorizations.unshare(admin,key,user.id);
    assert.equal(await kit.artifacts.source(user,sha,{consumer:'model'}),null);
    assert.equal((await r.resolve(ref)).ok,false, 'a cached resolution must not outlive sharing');
    await r.prefetch([ref]); await kit.authorizations.share(admin,key,[user.id]);
    assert.equal((await r.resolve(ref)).ok,true, 'a denial is not cached across a later grant');
    await kit.principals.setDisabled(admin,user.id,true);
    assert.equal((await r.resolve(ref)).ok,false, 'a disabled account cannot use cached text');
    await kit.principals.setDisabled(admin,user.id,false);

    const fake=randomBytes(8).toString('hex');
    const source=await kit.artifacts.ingest({bytes:Buffer.from(`ftp://synthetic:${fake}@192.0.2.10/file\n合成说明`),mediaType:'text/plain',origin:{read:{object:'synthetic:manual:1',resource:'synthetic'}},author:{user:null},provenanceType:'observed',visibility:{readers:[],admins:true,packs:['synthetic-reader-pack'],shareable:false}});
    await kit.authorizations.assign(admin,user.id,'synthetic-reader-pack');
    await kit.artifacts.acceptFindings(admin,source.body.sha256);
    const sensitive=make(source.body.sha256), sensitiveRef=`src:${source.body.sha256}/text@1/l/1`;
    await sensitive.prefetch([sensitiveRef]);
    const accepted=await sensitive.resolve(sensitiveRef); assert.ok(accepted.ok && accepted.value.text?.includes(fake));
    await kit.artifacts.revokeFindings(admin,source.body.sha256);
    const revoked=await sensitive.resolve(sensitiveRef); assert.ok(!revoked.ok || revoked.value.text===null);
    await sensitive.prefetch([sensitiveRef]); await kit.artifacts.acceptFindings(admin,source.body.sha256);
    const restored=await sensitive.resolve(sensitiveRef); assert.ok(restored.ok && restored.value.text?.includes(fake));

    const brokenSource=await kit.artifacts.ingest({bytes:Buffer.from('合成待解析内容'),mediaType:'application/x-synthetic',origin:{upload:{session:'synthetic'}},author:{user:user.id},provenanceType:'declared',visibility:{readers:[user.id],admins:true,packs:[],shareable:false}});
    const parsers=createDefaultRegistry();
    const fault=()=>{throw new SandboxError('FUNCTION_THREW',{message:'SYNTHETIC_PRIVATE_DIAGNOSTIC'}, {}, 'SYNTHETIC_PRIVATE_DIAGNOSTIC');};
    parsers.register({id:'synthetic',version:1,mediaTypes:['application/x-synthetic'],limits:{maxBytes:4096,maxDepth:10,maxNodes:10},parse(){return {parser:'synthetic@1',model:{},summary:()=>({}),listSelectors:()=>['n/x'],locate:fault,prefetch:async()=>fault()};}});
    const logs:string[]=[];
    const broken=createResolver({deps:{records:kit,knowledge:{treeReader:()=>({})}},parsers,documents:createDocumentCache(),log:(entry:{detail:string})=>logs.push(entry.detail)} as unknown as EngineContext,
      {reader:{user:user.id,role:user.role},sources:new Map([[brokenSource.body.sha256,'subject']]),records:new Map(),subject:{shas:new Set([brokenSource.body.sha256]),records:new Set()},root:null,compositions:[],catalogs:[],candidates:async()=>[]} as unknown as RunScope,'model');
    const failed=await broken.resolve(`src:${brokenSource.body.sha256}/synthetic@1/n/x`);
    assert.ok(!failed.ok && failed.retryable && failed.code==='SOURCE_RETRYABLE');
    assert.match(failed.message,/FUNCTION_THREW/); assert.match(failed.fix!,/恢复.*重新解析/);
    await assert.rejects(broken.prefetch([`src:${brokenSource.body.sha256}/synthetic@1/n/x`]), error=>error instanceof HubReadFailure && /FUNCTION_THREW/.test(error.message) && /恢复.*重交/.test(error.fix));
    assert.ok(!JSON.stringify({failed,logs}).includes('SYNTHETIC_PRIVATE_DIAGNOSTIC'));
  } finally { await kit.close(); }
});

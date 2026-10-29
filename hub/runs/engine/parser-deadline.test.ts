import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDefaultRegistry, createDocumentCache } from '../../refs/api.ts';
import { SandboxError } from '../../rules/api.ts';
import { openTestRecords } from '../../testing/records.ts';
import type { EngineContext } from './deps.ts';
import { createResolver, type RunScope } from './exact.ts';
import { HubReadFailure } from './retry-read.ts';

test('a document deadline remains an operation timeout through preview and prefetch', async () => {
  const kit=await openTestRecords();
  try {
    const user=(await kit.principals.bootstrapAdmin('synthetic-admin')).user;
    const source=await kit.artifacts.ingest({bytes:Buffer.from('synthetic document'),mediaType:'application/x-synthetic',origin:{upload:{session:'synthetic'}},author:{user:user.id},provenanceType:'declared',visibility:{readers:[user.id],admins:true,packs:[],shareable:false}});
    const parsers=createDefaultRegistry();
    const fault=()=>{throw new SandboxError('SANDBOX_TIMEOUT',{limit:'operation',message:'synthetic private reason'});};
    parsers.register({id:'synthetic',version:1,mediaTypes:['application/x-synthetic'],limits:{maxBytes:4096,maxDepth:10,maxNodes:10},parse(){return {parser:'synthetic@1',model:{},summary:()=>({}),listSelectors:()=>['n/x'],locate:fault,prefetch:async()=>fault()};}});
    const logs:string[]=[];
    const resolver=createResolver({deps:{records:kit,knowledge:{treeReader:()=>({})}},parsers,documents:createDocumentCache(),log:(entry:{detail:string})=>logs.push(entry.detail)} as unknown as EngineContext,
      {reader:{user:user.id,role:user.role},sources:new Map([[source.body.sha256,'subject']]),records:new Map(),subject:{shas:new Set([source.body.sha256]),records:new Set()},root:null,compositions:[],catalogs:[],candidates:async()=>[]} as unknown as RunScope,'model');
    const reference=`src:${source.body.sha256}/synthetic@1/n/x`;
    const result=await resolver.resolve(reference);
    assert.ok(!result.ok && result.code==='SOURCE_RETRYABLE');
    assert.match(result.message,/整次操作超过时限/);
    assert.match(result.message,/无法据此判断单个函数/);
    await assert.rejects(resolver.prefetch([reference]),error=>error instanceof HubReadFailure && /整次操作超过时限/.test(error.message) && /不计修复轮数/.test(error.fix));
    assert.ok(logs.some(line=>line.includes('整次文档操作时限')));
    assert.ok(!JSON.stringify({result,logs}).includes('synthetic private reason'));
  } finally { await kit.close(); }
});

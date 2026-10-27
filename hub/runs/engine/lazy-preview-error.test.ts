import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SandboxError } from '../../rules/api.ts';
import { startPostgres } from '../../testing/postgres.ts';
import { createTestParserRegistry } from '../../testing/parsers.ts';
import { openHarness, sandboxSkip } from './testing/harness.ts';
import { standardDocument, toyMap } from './testing/mindmap.ts';

const skip=await sandboxSkip();
test('resolve_reference returns a retryable missing fact when a bound parser sandbox fails', {skip}, async () => {
  const postgres=await startPostgres();
  const parsers=createTestParserRegistry();
  parsers.register({id:'synthetic',version:1,mediaTypes:['application/x-synthetic'],limits:{maxBytes:4096,maxDepth:10,maxNodes:10},parse(){return {parser:'synthetic@1',model:{},summary:()=>({}),listSelectors:()=>['n/x'],locate:()=>{throw new SandboxError('FUNCTION_THREW',{message:'SYNTHETIC_SECRET'}, {}, 'SYNTHETIC_SECRET');}};}});
  const h=await openHarness(postgres,{parsers});
  try {
    h.review.workflow.inputs.find(input=>input.slot==='notes')!.accepts.push('application/x-synthetic');
    const map=await h.upload(h.alice,toyMap(standardDocument()));
    const source=await h.upload(h.alice,Buffer.from('synthetic source'),'application/x-synthetic');
    const started=await h.service.startRun(h.alice,{pack:'toy-review',product:'Meadow',version:'3.2',inputs:{map:{reference:map},notes:[{reference:source}]}},h.call());
    assert.ok(started.run,JSON.stringify(started.errors));
    const answer=await h.service.resolveReference(h.alice,{run:started.run.run,text:`${source}/synthetic@1/n/x`,expect:'reference'},h.call());
    assert.equal(answer.call_result,'error');
    assert.equal(answer.errors[0]?.code,'SOURCE_RETRYABLE');
    assert.match(answer.errors[0]?.message??'',/FUNCTION_THREW/);
    assert.match(answer.errors[0]?.fix??'',/管理员.*恢复.*重新解析/);
    assert.ok(!JSON.stringify({answer,logs:h.logs}).includes('SYNTHETIC_SECRET'));
  } finally { await h.close(); await postgres.stop(); }
});

import assert from 'node:assert/strict';
import {after,before,test} from 'node:test';
import {startPostgres,type TemporaryPostgres} from '../../testing/postgres.ts';
import {openRetryHarness} from './testing/retry-harness.ts';
import {sandboxSkip} from './testing/harness.ts';
import {standardDocument,toyMap} from './testing/mindmap.ts';
let pg:TemporaryPostgres;const skip=await sandboxSkip();
before(async()=>{pg=await startPostgres();});after(async()=>{await pg?.stop();});
test('fact production checking bound artifacts never fabricates missing model handling',{skip},async()=>{
  const h=await openRetryHarness(pg);
  try{
    for(const check of h.locate.checks)check.judges='artifact_under_verification';
    const map=await h.upload(h.alice,toyMap(standardDocument()));
    const started=await h.service.startRunDetailed(h.alice,{pack:'toy-locate',inputs:{map:{reference:map}}},h.call('observed-production'));
    const answer=started.answer,result=started.production!.result;
    assert.equal(answer.call_result,'ok',JSON.stringify(answer.errors));assert.ok(answer.result);
    assert.deepEqual(result.errors,[]);
    assert.equal(result.partitions.delivered.length,answer.run!.items.length);
    assert.ok(result.partitions.delivered.every(item=>item.requirements.every(r=>r.layers.every(layer=>layer.reason!=='not_covered'&&layer.reason!=='repair_exhausted'))),'existing factual verdicts remain separate from absent model handling');
  }finally{await h.close();}
});

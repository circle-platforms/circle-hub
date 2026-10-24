import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startPostgres, type TemporaryPostgres } from '../../testing/postgres.ts';
import { sandboxSkip, type Harness } from './testing/harness.ts';
import { openRetryHarness as openHarness } from './testing/retry-harness.ts';
import { standardDocument, toyMap } from './testing/mindmap.ts';
let pg: TemporaryPostgres;
let h: Harness;
const skip=await sandboxSkip();
before(async()=>{pg=await startPostgres();if(!skip)h=await openHarness(pg);});
after(async()=>{await h?.close();await pg?.stop();});
test('skipped and uncovered target-only facts retain Hub-computed pass and violation terminals', {skip}, async()=>{
  const map=await h.upload(h.alice,toyMap(standardDocument()));
  const start=await h.service.startRunDetailed(h.alice,{pack:'toy-locate',inputs:{map:{reference:map}}},h.call());
  const run=start.answer.run!;
  const expected=start.production!.result.partitions.delivered.map(i=>[i.item,i.requirements.map(r=>[r.requirement,r.layers.map(l=>l.terminal)])]);
  assert.ok(JSON.stringify(expected).includes('violation'));
  assert.ok(JSON.stringify(expected).includes('pass'));
  for(const items of [[],run.items.map(i=>({item:i.id,handling:'skipped',reason:'先保留该项，核对仍由 Hub 完成'}))]){
    const answer=await h.service.submitResult(h.alice,{run:run.run,model:'synthetic-judge',items},h.call());
    assert.equal(answer.acceptance,'accepted',JSON.stringify(answer.errors));
    assert.equal(answer.result!.partitions.incomplete.length,0);
    if(items.length)for(const item of run.items){assert.ok(answer.errors.some(e=>e.item===item.id&&e.message.includes('先保留该项')));assert.equal(answer.result!.partitions.delivered.find(i=>i.item===item.id)?.skip_reason,'先保留该项，核对仍由 Hub 完成');}
    assert.deepEqual(answer.result!.partitions.delivered.map(i=>[i.item,i.requirements.map(r=>[r.requirement,r.layers.map(l=>l.terminal)])]),expected);
  }
});

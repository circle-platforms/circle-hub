import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startPostgres, type TemporaryPostgres } from '../../testing/postgres.ts';
import { sandboxSkip, type Harness } from './testing/harness.ts';
import { openRetryHarness as openHarness } from './testing/retry-harness.ts';
import { standardDocument, toyMap } from './testing/mindmap.ts';
let pg:TemporaryPostgres;let h:Harness;const skip=await sandboxSkip();
before(async()=>{pg=await startPostgres();if(!skip)h=await openHarness(pg);});
after(async()=>{await h?.close();await pg?.stop();});
test('every skipped item preserves its submitted reason, is named in errors and consumes one shared round', {skip}, async()=>{
  const map=await h.upload(h.alice,toyMap(standardDocument()));
  const run=(await h.service.startRun(h.alice,{pack:'toy-review',product:'Meadow',version:'10.6.1',build:'Rel_MEADOW_10_6_1_7',inputs:{map:{reference:map}}},h.call())).run!;
  for(let attempt=0;attempt<2;attempt++){
    const answer=await h.service.submitResult(h.alice,{run:run.run,model:`synthetic-${attempt}`,items:run.items.map(i=>({item:i.id,handling:'skipped',reason:`合成原因 ${i.id}`})),cross_item:[{nature:'judgment',statement:'合成等级',grounds:[],code:'draft_level',rank:'P4'}]},h.call());
    assert.equal(answer.acceptance,'accepted',JSON.stringify(answer.errors));
    for(const item of answer.result!.partitions.incomplete){
      assert.equal(item.skip_reason,`合成原因 ${item.item}`);
      const error=answer.errors.find(e=>e.item===item.item&&e.requirement==='findings');
      assert.ok(error?.message.includes(item.skip_reason!));
      assert.equal(error?.rounds_left,2-attempt);
    }
  }
});

import assert from 'node:assert/strict';
import {test} from 'node:test';
import {planStateOf} from './plan-state.ts';
test('frozen exclusions resolve exact item and original identities without parsing names',()=>{
  const run={parameters:{exclude:['original-id']},items:[{id:'internal',fields:{autoid:'original-id'}}]};
  assert.equal(planStateOf({item:'internal',handling:'handled'},undefined,run).excluded,true);
  assert.equal(planStateOf({item:'original-id-extra',handling:'handled'},undefined,run).process,true);
});
test('declared skip is not a verified inability and an old accepted result cannot certify a current file',()=>{
  assert.equal(planStateOf({item:'x',handling:'skipped'}).skipped,true);
  const current={item:'x',handling:'handled',slots:{plan:[{data:{changed:true}}]}};
  assert.equal(planStateOf(current,undefined,{result:{acceptance:'accepted',partitions:{passed:[{item:'x'}]}}}).process,true);
  assert.equal(planStateOf({item:'x',handling:'invented'}).process,false);
});

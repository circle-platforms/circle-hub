import assert from 'node:assert/strict';
import {test} from 'node:test';
import {normalize} from '../../packs/common/skills/knowledge-consolidation/scripts/normalize.ts';
test('Structured consolidation deduplicates permitted statements preserves quotes and tool witnesses and rejects unshared fragments',()=>{
  const first={id:'one',kind:'fact',subject:'synthetic',predicate:'procedure',value:'alpha',quote:'Synthetic original',sharingAllowed:true,sourceRecordId:'source-one',evidence:[{evidenceId:'evidence-one',sha256:'a'.repeat(64)}],toolReturn:{observed:true}};
  const result=normalize([first,{...first,id:'two',kind:'correction',quote:'Synthetic correction',evidence:[{evidenceId:'evidence-two',sha256:'b'.repeat(64)}]},{...first,id:'private',sharingAllowed:false}]);
  assert.equal(result.candidates.length,1);assert.equal(result.candidates[0].fragments.length,2);assert.equal(result.candidates[0].evidence.length,2);assert.deepEqual(result.candidates[0].fragments[0].toolReturn,{observed:true});
  assert.equal(result.candidates[0].visibility,'personal');assert.equal(result.candidates[0].state,'candidate');assert.equal(result.unmapped[0].id,'private');assert.deepEqual(normalize([first,first]),normalize([first,first]));
});

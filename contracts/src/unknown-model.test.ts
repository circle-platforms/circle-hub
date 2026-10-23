// Synthetic contract regressions for the unknown-sweep changes; no Hub or product modules execute here.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DISPOSITION,EXIT_ACTION,labelOf} from '../generated/vocabulary.ts';

test('item 4 preserves the disposition code while naming its time-bounded meaning',()=>{
  assert.ok(DISPOSITION.includes('keep_unknown'));
  assert.equal(labelOf('disposition','keep_unknown'),'带期限的暂缓');
  assert.ok(!EXIT_ACTION.some(action=>(action as string)==='keep_unknown'),'keeping unknown is never an exit action');
});

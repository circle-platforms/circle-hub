import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Submission} from './submission.ts';
const body={run:'run_01k00000000000000000000000',model:'synthetic',items:[]};
const check={requirement:'shape',interpreter:'structure@1',table:{},samples:[{item:'positive',expect:[{verdict:'support'}]},{item:'negative',expect:[{verdict:'refute'}]}]};
test('runtime tables declare a requirement, interpreter, inline JSON and item samples only',()=>{
  assert.equal(Submission.safeParse({...body,checks:[check]}).success,true);
  for(const bad of [{...check,interpreter:'structure'}, {...check,samples:[{item:'positive',subject:{},expect:[]}]}, {...check,table:undefined}]) assert.equal(Submission.safeParse({...body,checks:[bad]}).success,false);
});

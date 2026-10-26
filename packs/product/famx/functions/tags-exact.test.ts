import assert from 'node:assert/strict';
import {test} from 'node:test';
import {negativeOf} from './cases-rules.ts';
for(const raw of ['Negative','NEGATIVE','Ｎｅｇａｔｉｖｅ',' Negative','Negative ','[Negative]','[Negative','Negative test','Negative case','负向','异常','neg'])
 test('FAMX: undeclared variant '+JSON.stringify(raw)+' is not negative or positive',()=>assert.equal(negativeOf([raw]),null));
test('FAMX: absent tags do not become positive',()=>assert.equal(negativeOf([]),null));

test('FAMX: exact published negative text declares negative',()=>assert.equal(negativeOf(['negative']),true));

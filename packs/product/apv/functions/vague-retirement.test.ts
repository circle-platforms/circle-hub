import {kityminderParser} from "../../../../hub/testing/parsers.ts";
import assert from 'node:assert/strict';
import {test} from 'node:test';

import {caseNodes} from './cases-nodes.ts';
test('case production preserves structural expectations without deciding their semantic quality',()=>{
 for(const text of ['操作成功','某项约束应当满足','结果等于 7']){
  const document={root:{data:{id:'r',text:'合成脑图'},children:[{data:{id:'c',text:'合成用例',resource:['Functional']},children:[{data:{id:'e',text},children:[]}]}]}};
  const scan=caseNodes(kityminderParser.parse(new TextEncoder().encode(JSON.stringify(document))).model);
  assert.equal(scan.cases[0].hasExpected,true);assert.equal(Object.hasOwn(scan.cases[0],'vague'),false,'no producer-invented semantic boolean');
 }
});

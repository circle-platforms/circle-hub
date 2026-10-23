import assert from 'node:assert/strict';
import {test} from 'node:test';
import {bugIdsOf,caseGold} from './cases.ts';
import {extractAssociatedIds} from './locations.ts';
import {joinGold} from './join.ts';

test('independent id extractors retain nonzero padding and reject zero-only runs',()=>{
  const raw='缺陷 0910011 合成';
  assert.deepEqual(bugIdsOf(raw),['0910011']);
  assert.deepEqual(extractAssociatedIds(raw,[]).bugs,['0910011']);
  assert.deepEqual(bugIdsOf('缺陷 00；bug 000；缺陷 01'),['01']);
  assert.deepEqual(extractAssociatedIds('缺陷 00；bug 000；缺陷 01',[]).bugs,['01']);
  assert.deepEqual(extractAssociatedIds('需求 00021',[]).stories,['00021']);
});
test('written lengths apply before normalization and lists never take a prefix of an overlong number',()=>{
  for(const raw of ['缺陷 1','缺陷 0000000001','缺陷 10.7','缺陷 12:30','缺陷 12a'])assert.deepEqual(bugIdsOf(raw),[],raw);
  assert.deepEqual(bugIdsOf('缺陷 01、00021'),['00021','01']);
  assert.deepEqual(extractAssociatedIds('0123 合成',[]).unclassified,['0123']);
  assert.deepEqual(extractAssociatedIds('2025 合成',[]).unclassified,[]);
  assert.deepEqual(extractAssociatedIds('0000 合成',[]).unclassified,[]);
});
test('classification compares normalized identity while keeping one original spelling',()=>{
  const ids=extractAssociatedIds('0021 合成',['需求 00021','需求 21']);
  assert.deepEqual(ids.stories,['00021']);assert.deepEqual(ids.unclassified,[]);
});
test('the independent join compares keys without rewriting release ids or raw case titles',()=>{
  const title='缺陷 0910011 合成';
  const map={root:{data:{text:'合成文档'},children:[{data:{id:'c1',text:title,resource:['Functional']},children:[]}]}};
  const item=caseGold([{document:'synthetic-doc',map}]).documents[0].items[0];
  assert.equal(item.title,title);assert.deepEqual(item.defects,['0910011']);
  const result=joinGold([{bug:'00910011',status:'fixed',module:'',system:'plm'}],[{document:'synthetic-doc',id:item.id,title:item.title,defects:item.defects}],{plm:[{id:'910011',status:'closed'}]});
  assert.equal(result.closed_traced,1);assert.equal(result.rows[0].bug,'00910011');assert.equal(result.rows[0].cases[0].title,title);
});

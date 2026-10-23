import { labelOf } from '../../../contracts/generated/vocabulary.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RangeTable, CheckOutcome } from '../../../contracts/src/tables.ts';
import { rangeInterpreter } from './range.ts';

const table=(measure:string,empty?:string)=>({schema:'range@1',origin:'Synthetic aggregation rule',checks:[{values:'$.values[*]',threshold:{measure,minimum:1,...(empty===undefined?{}:{empty})}}]});
for(const measure of ['min','max'])for(const empty of [undefined,'refute','support'])test(`empty ${measure} uses ${empty??'default refutation'} without unknown`,()=>{
  const outcomes=rangeInterpreter.run({interpreter:'range@1',table:table(measure,empty),subject:{values:[]},context:{}});
  assert.equal(outcomes.length,1);
  const out=outcomes[0]!;assert.equal(out.verdict,empty==='support'?'support':'refute');
  assert.equal(out.code,empty==='support'?undefined:'core.range.out_of_bounds');
  assert.ok(out.statement.includes(labelOf('verdict',empty==='support'?'support':'refute')));
  assert.equal(out.data?.empty,true);assert.equal(out.reason,undefined);
  assert.ok(CheckOutcome.safeParse(out).success);
});
test('empty verdict choices do not override nonempty values and are not accepted on count or sum',()=>{
  const out=rangeInterpreter.run({interpreter:'range@1',table:table('min','support'),subject:{values:[0]},context:{}})[0]!;
  assert.equal(out.verdict,'refute');assert.equal(out.data?.empty,undefined);
  for(const measure of ['count','sum'])assert.equal(RangeTable.safeParse(table(measure,'support')).success,false);
  for(const alias of ['pass','fail'])assert.equal(RangeTable.safeParse(table('min',alias)).success,false);
});

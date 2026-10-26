import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFacetView} from './views.ts';
import {groupBoard} from './board.ts';
import {thresholdOutcomes} from './thresholds.ts';
import {boundView,facetViewOf,facetRow} from './test-support.ts';
const groups=(rows:ReturnType<typeof facetRow>[])=>{const parsed=readFacetView(boundView('facets',facetViewOf(rows)),'facets');assert.ok(parsed.ok);return groupBoard(parsed.view);};
const row=(negative:boolean|null,status:string,count:number)=>facetRow({line:'10.6',module:'原文不变',has_expected:true,vague_expected:false,negative,test_type_status:status},count);
test('undeclared and invalid tags do not enter either polarity denominator',()=>{
 const board=groups([row(true,'declared',1),row(false,'declared',1),row(null,'undeclared',9)]);
 assert.deepEqual(board[0].ratios.negative,{num:1,den:2});assert.equal(board[0].counts.cases,11);
 const repaired=groups([row(true,'declared',1),row(false,'declared',10)]);assert.deepEqual(repaired[0].ratios.negative,{num:1,den:11});
});
test('zero declared polarity denominator asks for the author declaration instead of reporting zero percent',()=>{
 const group=groups([row(null,'undeclared',3)])[0];assert.equal(group.display.negative,null);
 const outcomes=thresholdOutcomes({items:[{id:group.id,fields:group}],context:{parameters:{max_missing_ratio:1,max_vague_ratio:1,min_negative_ratio:0}}});
 assert.ok(outcomes.some(o=>o.verdict==='unknown'&&o.missing&&o.statement.includes('下一步')));assert.ok(!outcomes.some(o=>o.verdict==='support'));
});

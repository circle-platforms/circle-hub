import assert from 'node:assert/strict';
import test from 'node:test';
import { projectItems } from './project.ts';
import { boundView, facetViewOf, placementFor } from './test-support.ts';

function emptyView(options: {total:number;truncated:boolean;skipped:number;scope?:boolean}) {
  const view=facetViewOf([],options);
  if(options.scope!==undefined)view.scope={complete:options.scope};
  return projectItems({inputs:[boundView('facets',view),placementFor(view)],parameters:{},context:{}});
}

test('an empty incomplete facet page cannot establish that the root has no cases',()=>{
  for(const options of [
    {total:3,truncated:true,skipped:0},
    {total:3,truncated:false,skipped:0},
    {total:0,truncated:true,skipped:0},
    {total:0,truncated:false,skipped:1},
    {total:0,truncated:false,skipped:0,scope:false},
  ]){
    const result=emptyView(options);
    assert.ok('error' in result);
    if('error' in result){
      assert.equal(result.error.code,'quality-board.wrong_view');
      assert.match(result.error.message,/不能据此认定没有用例/);
      assert.ok(result.error.fix.length>0);
    }
  }
  const complete=emptyView({total:0,truncated:false,skipped:0,scope:true});
  assert.ok('error' in complete);
  if('error' in complete)assert.equal(complete.error.code,'quality-board.no_cases');
});

test('an invalid request tells the caller the currently accepted count and tag axes',()=>{
  const result=projectItems({inputs:[],parameters:{},context:{}});
  assert.ok('error' in result);
  if('error' in result){
    assert.ok(result.error.fix.includes('by=line,module,has_expected,negative,test_type_status'));
    assert.ok(result.error.fix.includes('by=line,module,tags,resource_empty,tag_valid'));
    assert.ok(!result.error.fix.includes('vague_expected'));
  }
});

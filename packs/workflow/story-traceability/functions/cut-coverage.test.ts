import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IndexView } from '../../../../contracts/src/views.ts';
import { boundView, caseEntry, indexViewOf } from '../../traceability/functions/test-support.ts';
import project from './project.ts';
import check from './check.ts';
function cutView() {
  const entries = [0,1].map(i => caseEntry({defects:[],stories:['00021'],case:`a${i}`}));
  entries.push(...Array.from({length:2000},(_,i)=>caseEntry({defects:[],stories:['99'],case:`b${i}`})));
  const view=indexViewOf('case','stories',entries);
  Object.assign(view,{cut_keys:['99'],truncated:true,total_entries:2003,key_space_complete:true});
  return IndexView.parse(view);
}
function run(ids:string[],view=cutView(),excluded=0):any {
  const cases=boundView('cases',view);cases.meta={index_excluded_entries:excluded,index_view_sha256:cases.sha256};
  return project({inputs:[boundView('stories',{stories:ids.map(id=>({id,status:'synthetic',stage:null})),unread:[]},`plm:stories:${ids.join('+')}`),cases]});
}
test('a real-shaped unrelated per-key cut preserves exact links and determinate absence together',()=>{
  const result=run(['21','23']);assert.ok(!result.error,JSON.stringify(result.error));
  assert.deepEqual(result.items.map((item:any)=>[item.id,item.fields.case_count_lower_bound,item.fields.coverage_complete]),[['21',false,true],['23',false,true]]);
  const outcomes=check({subject:{items:result.items,context:{groups:result.groups}}}) as any[];
  assert.ok(outcomes.every(row=>row.verdict==='support'));
  assert.match(outcomes[0].statement,/2 个已索引用例追溯：/);
  assert.match(outcomes[1].statement,/没有条目携带需求号 23/);
  const cut=run(['99']);assert.equal(cut.items[0].fields.case_count_lower_bound,true);
});
test('credential exclusions stay conservative without per-key excluded-entry counts',()=>{
  const view=cutView();view.notes.push('1 个条目的文字有凭据扫描命中，没有放进这个视图');
  const result=run(['21','23'],view,1);assert.ok(!result.error);
  assert.equal(result.items[0].fields.case_count_lower_bound,true);
  assert.equal(result.items[1].fields.coverage_complete,true);
});
test('missing entry bodies do not invalidate the key-space absence proof',()=>{
  const view=cutView();delete view.entries[Object.keys(view.entries)[0]];
  const result=run(['23'],view);assert.ok(!result.error);assert.equal(result.items[0].fields.coverage_complete,true);
});

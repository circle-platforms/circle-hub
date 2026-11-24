import assert from 'node:assert/strict';
import {test} from 'node:test';
import {toolText} from './text.ts';
test('an unclassified call error is not upgraded into a confirmed business refutation',()=>{
  const text=toolText('start_run',{call_result:'error',errors:[{code:'UNDECLARED_FAILURE',message:'synthetic call failed',fix:'synthetic next'}]});
  assert.match(text,/synthetic call failed/);assert.match(text,/synthetic next/);assert.doesNotMatch(text,/状态已确认|判断错误/);
});

test('named case groups retain every declared recovery without inventing a decision maker',()=>{
  const context={items:[{id:'case-synthetic',label:'合成用例',location:'src:'+ 'a'.repeat(64),fields:{}}]};
  const errors=[
    {code:'UNDECLARED_FAILURE',item:'case-synthetic',message:'合成事实甲',fix:'先修正甲',warrant:'synthetic-origin@1'},
    {code:'UNDECLARED_FAILURE',item:'case-synthetic',message:'合成事实乙',fix:'再修正乙'},
    {code:'UNDECLARED_FAILURE',item:'case-synthetic',message:'合成事实甲',fix:'另核对丙'},
  ];
  const text=toolText('submit_result',{call_result:'error',acceptance:'not_accepted',errors},context);
  for(const fact of ['合成事实甲','合成事实乙','先修正甲','再修正乙','另核对丙']) assert.ok(text.includes(fact));
  assert.match(text,/合成事实甲（×2）/);assert.doesNotMatch(text,/决定者程序|状态已确认|判断错误/);
});

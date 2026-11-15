import assert from 'node:assert/strict';
import {test} from 'node:test';
import {toolText} from './text.ts';
test('an unclassified call error is not upgraded into a confirmed business refutation',()=>{
  const text=toolText('start_run',{call_result:'error',errors:[{code:'UNDECLARED_FAILURE',message:'synthetic call failed',fix:'synthetic next'}]});
  assert.match(text,/synthetic call failed/);assert.match(text,/synthetic next/);assert.doesNotMatch(text,/状态已确认|判断错误/);
});

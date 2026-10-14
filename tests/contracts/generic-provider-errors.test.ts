import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ApiError,parseExecutionTransitionOutput} from '../../packages/contracts/src/index.ts';

test('Generic provider refusal is registered without importing any product implementation',()=>{
 const error=new ApiError('GATEWAY_REFUSED','Synthetic refusal');
 assert.equal(error.httpStatus,422);assert.equal(error.category,'execution');
 assert.equal(parseExecutionTransitionOutput({schema:'hub-execution-transition/1',state:null,actions:[{kind:'outcome.error',stepId:'refused',occurrence:0,code:'GATEWAY_REFUSED',facts:{}}]}).actions[0].kind,'outcome.error');
});

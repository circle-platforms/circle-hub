import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ApiError,parseExecutionTransitionOutput,registeredErrorCode,registerErrorCodes} from '../../packages/contracts/src/index.ts';

// Node's test-file process imports only core contracts. Product installation or
// implementation side effects cannot register these codes for this test.
for(const code of ['INVALID_EXECUTION_WORKBOOK','COMMAND_VALIDATION_FAILED'])test(`Core execution validation classifies ${code} without a product module`,()=>{
 assert.equal(registeredErrorCode(code),true);const error=new ApiError(code,'Synthetic validation');assert.equal(error.httpStatus,422);assert.equal(error.category,'validation');
 const output=parseExecutionTransitionOutput({schema:'hub-execution-transition/1',state:null,actions:[{kind:'outcome.error',stepId:'validation',occurrence:0,code,facts:{synthetic:true}}]});assert.equal((output.actions[0] as any).code,code);
 assert.doesNotThrow(()=>registerErrorCodes({[code]:[422,'validation']}));assert.equal(new ApiError(code,'Synthetic repeat').category,'validation');
});

test('Core registration still rejects unregistered product judgment codes as terminal error classifications',()=>{
 assert.equal(registeredErrorCode('SYNTHETIC_PRODUCT_JUDGMENT'),false);assert.throws(()=>parseExecutionTransitionOutput({schema:'hub-execution-transition/1',state:null,actions:[{kind:'outcome.error',stepId:'validation',occurrence:0,code:'SYNTHETIC_PRODUCT_JUDGMENT',facts:{}}]}));
});

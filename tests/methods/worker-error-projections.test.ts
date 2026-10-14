import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ExecutionFlows} from '../../packages/execution/src/flow-driver.ts';

test('Worker error metadata retains registered codes and maps unregistered nested error channels to INTERNAL_ERROR',()=>{
 const flow=Object.create(ExecutionFlows.prototype) as ExecutionFlows,input={error:{code:'UNREGISTERED_WORKER_CODE',message:'Synthetic failure',details:{outcomeWorkerNested:{code:'UNREGISTERED_NESTED_CODE',message:'Synthetic nested failure'},error:{code:'HOOK_FAILED',message:'Known nested failure'}}},resultError:{code:'UNREGISTERED_RESULT_CODE',message:'Synthetic result failure'},result:{code:'business-domain-code',label:'Opaque product data'}};
 const projected=flow.metadata(input);assert.equal(projected.error.code,'INTERNAL_ERROR');assert.equal(projected.error.details.outcomeWorkerNested.code,'INTERNAL_ERROR');assert.equal(projected.error.details.error.code,'HOOK_FAILED');assert.equal(projected.resultError.code,'INTERNAL_ERROR');assert.equal(projected.result.code,'business-domain-code');assert.equal(input.error.code,'UNREGISTERED_WORKER_CODE','Projection must not mutate the retained raw report');
 assert.equal((flow as any).errorMetadata({code:'UNREGISTERED_DIRECT_CODE',message:'Synthetic internal error'}).code,'INTERNAL_ERROR');assert.equal(flow.metadata({code:'opaque-product-code',message:'Opaque product result'}).code,'opaque-product-code');
});

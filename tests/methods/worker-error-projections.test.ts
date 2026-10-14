import assert from 'node:assert/strict';
import {test} from 'node:test';
import {canonicalJson,sha256} from '../../packages/contracts/src/index.ts';
import {hydrateReturn} from '../../packages/connectors/src/return-pointers.ts';
import {projectWorkerErrors} from '../../packages/execution/src/worker-report.ts';
import {ExecutionFlows} from '../../packages/execution/src/flow-driver.ts';

test('Worker error metadata retains registered codes and maps unregistered nested error channels to INTERNAL_ERROR',()=>{
 const flow=Object.create(ExecutionFlows.prototype) as ExecutionFlows,input={error:{code:'UNREGISTERED_WORKER_CODE',message:'Synthetic failure',details:{outcomeWorkerNested:{code:'UNREGISTERED_NESTED_CODE',message:'Synthetic nested failure'},error:{code:'HOOK_FAILED',message:'Known nested failure'}}},output:{resultError:{code:'UNREGISTERED_RESULT_CODE',message:'Synthetic result failure',details:{nested:{code:'UNREGISTERED_DEEP_CODE',message:'Synthetic nested result failure'}}},result:{code:'business-domain-code',label:'Opaque product data'}}};
 const projected=flow.metadata(input);assert.equal(projected.error.code,'INTERNAL_ERROR');assert.equal(projected.error.details.outcomeWorkerNested.code,'INTERNAL_ERROR');assert.equal(projected.error.details.error.code,'HOOK_FAILED');assert.equal(projected.output.resultError.code,'INTERNAL_ERROR');assert.equal(projected.output.resultError.details.nested.code,'INTERNAL_ERROR');assert.equal(projected.output.result.code,'business-domain-code');assert.equal(input.error.code,'UNREGISTERED_WORKER_CODE','Projection must not mutate the retained raw report');
 assert.equal((flow as any).errorMetadata({code:'UNREGISTERED_DIRECT_CODE',message:'Synthetic internal error'}).code,'INTERNAL_ERROR');assert.equal(flow.metadata({code:'opaque-product-code',message:'Opaque product result'}).code,'opaque-product-code');
});

test('Worker error projection preserves opaque inline product error and resultError objects at every depth',()=>{
 const product={code:'domain-result',error:{code:'vendor-business-error',message:'Product observation',details:{error:{code:'vendor-nested',message:'Nested product observation'}}},resultError:{code:'vendor-result-error',message:'Another product observation'},items:[{error:{code:'vendor-item-error',message:'Product row'}}]},report={fencingToken:1,inputRevisionId:'inrev_fixture',status:'succeeded',output:{result:product},error:{code:'HOOK_FAILED',message:'Known Hub error'}};
 const projected=projectWorkerErrors(report);assert.deepEqual(projected.output.result,product);assert.equal(projected.error.code,'HOOK_FAILED');assert.deepEqual(report.output.result,product,'Projection must not mutate B originals');
});

test('Worker error projection of an inline product result matches hydration of the same frozen pointer original',async()=>{
 const product={error:{code:'vendor-business-code',message:'Opaque source data'},resultError:{code:'vendor-result-code',message:'Opaque source data'},nested:{error:{code:'vendor-nested-code',message:'Opaque nested data'}}},bytes=Buffer.from(canonicalJson(product)),pointer={path:'flow/op_fixture/result',sourceType:'execution-provider',sha256:sha256(bytes),objectKey:sha256(bytes),size:bytes.length},envelope={fencingToken:1,inputRevisionId:'inrev_fixture',status:'succeeded'};
 const inline=projectWorkerErrors({...envelope,output:{result:product}}),pointed=projectWorkerErrors({...envelope,output:{resultPointer:pointer}}),hydrated=await hydrateReturn({getObject:async()=>bytes} as any,pointed.output.resultPointer);pointed.output.result=JSON.parse(Buffer.from(hydrated.contentBase64,'base64').toString());assert.deepEqual(inline.output.result,pointed.output.result);assert.deepEqual(inline.output.result,product);
});

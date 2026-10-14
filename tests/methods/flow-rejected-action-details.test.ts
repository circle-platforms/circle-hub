import assert from 'node:assert/strict';
import test from 'node:test';
import {ApiError,canonicalHash} from '../../packages/contracts/src/index.ts';
import {ExecutionFlows} from '../../packages/execution/src/flow-driver.ts';

test('Hub rejection details preserve the action and fixed cause while large details remain bounded',()=>{
 const flow=Object.create(ExecutionFlows.prototype),details={values:Array(257).fill('synthetic')},action={stepId:'rejected-action',kind:'tool.call',args:['private-argument-sentinel'],byteSlots:['not-a-disclosure']},cause=new ApiError('INVALID_PAYLOAD','Synthetic Hub validation rejected a binding',details),view=flow.rejectedActionDetails(cause,action);
 assert.equal(view?.stepId,action.stepId);assert.equal(view?.kind,action.kind);assert.equal(view?.cause.code,'INVALID_PAYLOAD');assert.equal(view?.cause.message,cause.message);assert.equal(view?.cause.details.omitted,true);assert.equal(view?.cause.details.sha256,canonicalHash(details));assert.ok(!JSON.stringify(view).includes('private-argument-sentinel'));assert.ok(!JSON.stringify(view).includes('not-a-disclosure'));
 const deep={nested:{nested:{nested:{nested:{nested:{nested:{nested:{nested:{value:'synthetic'}}}}}}}}},bounded=flow.rejectedActionDetails(new ApiError('INVALID_PAYLOAD','Bounded cause',deep),action);assert.equal(bounded?.stepId,action.stepId);assert.equal(bounded?.cause.details.omitted,true,'Adding context must budget nested cause fields without swallowing the fixed action metadata');
});

test('A reported product error or transcript is not a Hub rejection cause and an unparsed action is never invented',()=>{
 const flow=Object.create(ExecutionFlows.prototype),action={stepId:'known-action',kind:'provider.call'};
 assert.equal(flow.rejectedActionDetails({code:'INVALID_PAYLOAD',message:'product-transcript-sentinel',details:{value:'product-secret'}},action),undefined);assert.equal(flow.rejectedActionDetails(new Error('product-transcript-sentinel'),action),undefined);assert.equal(flow.rejectedActionDetails(new ApiError('INVALID_PAYLOAD','Hub rejected the output'),undefined),undefined);
 const transition=flow.rejectedActionDetails(new ApiError('INVALID_PAYLOAD','Output failed F validation'),{stepId:'hub.transition.0',kind:'transition'});assert.equal(transition?.kind,'transition');assert.equal(transition?.stepId,'hub.transition.0');assert.equal(transition?.cause.message,'Output failed F validation');
 const unknown=flow.rejectedActionDetails(new ApiError('UNREGISTERED_SYNTHETIC','Hub error with an unregistered code'),action);assert.equal(unknown?.cause.code,'INTERNAL_ERROR');assert.equal(unknown?.cause.reportedRegistered,false);
});

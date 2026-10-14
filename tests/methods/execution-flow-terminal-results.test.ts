import assert from 'node:assert/strict';
import {test} from 'node:test';
import * as provider from '../../packages/execution/src/flow-provider.ts';

test('M3 terminal authority: an unsuccessful results body cannot replace the separately persisted terminal proof',()=>{
 const terminal={ok:true,task_id:'remote_fixture',state:'done'},failure={ok:false,stage:'validation',dispatched:false};
 const select=(provider as any).terminalReportResult;
 assert.deepEqual(select(terminal,{gatewayRefusal:failure,remoteLeaseReleased:true},'failed'),{...terminal,remoteLeaseReleased:true,interpretationUnavailable:true});
 assert.deepEqual(select(terminal,{},'expired'),{...terminal,remoteLeaseReleased:null,interpretationUnavailable:true});
 assert.deepEqual(select(terminal,{result:{...terminal,result:{items:[]}},remoteLeaseReleased:false},'succeeded'),{...terminal,result:{items:[]},remoteLeaseReleased:false});
});
test('M3 terminal completion: only an expiry-completed terminal operation without a final report can accept one exact fenced follow-up',()=>{
 const allowed=(provider as any).canSupplementTerminalExpiry;
 const row={status:'succeeded',result:{expiryAfterTerminal:true}},step={terminal:true,remote_identity:{terminalSha256:'a'.repeat(64)}};
 assert.equal(allowed(row,step),true);
 for(const invalid of [{...row,status:'failed'},{...row,result:{}},{...row,result:{expiryAfterTerminal:true,reportHash:'b'.repeat(64)}}])assert.equal(allowed(invalid,step),false);
 assert.equal(allowed(row,{...step,terminal:false}),false);assert.equal(allowed(row,{...step,remote_identity:null}),false);
});
test('M3 result validation: a bad result identity after a known terminal is an interpretation error while standalone receipts stay strictly unproven',()=>{
 const policy={remoteIdPath:['id'],requestHashPath:['request'],inputSha256Path:['input'],byteHashesPath:['bytes'],statePath:['state'],terminalValues:['done'],receiptSchema:{type:'object',required:['id','request','input','bytes','state'],properties:{id:{type:'string'},request:{type:'string'},input:{type:'string'},bytes:{type:'object'},state:{const:'done'}},additionalProperties:false}},binding={configuration:{receiptPolicy:policy}},identity={remoteId:'remote_fixture',requestHash:'a'.repeat(64),inputSha256:'b'.repeat(64)},valid={id:identity.remoteId,request:identity.requestHash,input:identity.inputSha256,bytes:{payload:'c'.repeat(64)},state:'done'},validate=(provider as any).terminalResultError;
 assert.equal(validate(binding,valid,identity,valid.bytes),undefined);for(const wrong of [{...valid,request:'d'.repeat(64)},{...valid,id:'another_remote'},{...valid,bytes:{payload:'e'.repeat(64)}},{...valid,state:'running'}]){assert.ok(validate(binding,wrong,identity,valid.bytes));assert.throws(()=>provider.verifyProviderReceipt(binding,wrong,identity,valid.bytes,true));}
});

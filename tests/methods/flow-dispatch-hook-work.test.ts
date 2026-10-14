import assert from 'node:assert/strict';
import test from 'node:test';
import {DISPATCH_HOOK_WORK,freezeDispatchHookWork,requireFreshDispatchHookWork} from '../../packages/execution/src/flow-hooks.ts';

const pin={assetId:'ast_fixture',version:'1.0.0',sha256:'a'.repeat(64)},base={metadataDigest:'f'.repeat(64),operationId:'op_fixture',workerId:'worker_fixture',inputRevisionId:'inrev_fixture',fencingToken:1,requestHash:'b'.repeat(64),method:pin,resource:pin,sources:{input:pin},runtime:{...pin,profileSha256:'c'.repeat(64)},preparationDigest:'d'.repeat(64),input:{binding:{method:pin,resource:{...pin,declaration:{}},source:{input:pin},inputRevision:'inrev_fixture'},subject:{input:{value:'synthetic'},operationId:'op_fixture'}},handlers:[{id:'synthetic-rule',version:'1.0.0',event:'beforeDispatch',order:10,code:"export default()=>({decision:'pass'});"}]};

test('C dispatch work binds every frozen input and handler while remaining absent from the worker JSON envelope',()=>{
 const work=freezeDispatchHookWork(base);requireFreshDispatchHookWork(work,freezeDispatchHookWork(structuredClone(base)));const authorization={authorized:true};Object.defineProperty(authorization,DISPATCH_HOOK_WORK,{value:work});assert.equal(JSON.stringify(authorization),'{"authorized":true}');
 for(const patch of [{workerId:'other'},{fencingToken:2},{inputRevisionId:'other'},{requestHash:'0'.repeat(64)},{metadataDigest:'0'.repeat(64)},{resource:{...pin,version:'2.0.0'}},{method:{...pin,sha256:'0'.repeat(64)}},{preparationDigest:'0'.repeat(64)},{input:{...base.input,subject:{...base.input.subject,input:{value:'changed'}}}},{handlers:[{...base.handlers[0],code:"export default()=>({decision:'block',code:'SYNTHETIC',facts:{}});"}]}])assert.throws(()=>requireFreshDispatchHookWork(work,freezeDispatchHookWork({...base,...patch})),(error:any)=>error.code==='APPROVAL_STALE');
});

test('A copied authority digest cannot certify mutated C work or supply an authorization grant',()=>{
 const work=freezeDispatchHookWork(base);assert.throws(()=>requireFreshDispatchHookWork(work,{...work,fencingToken:2}),(error:any)=>error.code==='APPROVAL_STALE');assert.throws(()=>requireFreshDispatchHookWork(work,undefined),(error:any)=>error.code==='APPROVAL_STALE');assert.ok(!Object.hasOwn(work,'authorized'));assert.ok(!Object.hasOwn(work,'decisions'));
});

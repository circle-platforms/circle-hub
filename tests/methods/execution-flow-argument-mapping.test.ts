import assert from 'node:assert/strict';
import {test} from 'node:test';
import * as mapping from '../../packages/execution/src/flow-arguments.ts';

test('Approved provider parameters bind only frozen input paths or approved finite literals',()=>{
 const input={value:{build:'SYNTHETIC_BUILD',module:'ignored-client-value'}},policy={toolArguments:{submit:{module:{literal:'synthetic-suite'}},prepare:{expected:{inputPath:['value','build']}}}};
 assert.deepEqual(mapping.providerMappedArguments(policy,'submit',{payload:'literal'},input),{payload:'literal',module:'synthetic-suite'});
 assert.deepEqual(mapping.providerMappedArguments(policy,'prepare',{},input),{expected:'SYNTHETIC_BUILD'});
 assert.deepEqual(mapping.providerMappedArguments(policy,'status',{task_id:'remote'},input),{task_id:'remote'});
 assert.throws(()=>mapping.providerMappedArguments(policy,'submit',{module:'product-overwrite'},input),(e:any)=>e.code==='INVALID_PAYLOAD');
 assert.throws(()=>mapping.providerMappedArguments(policy,'prepare',{},{}),(e:any)=>e.code==='INVALID_PAYLOAD');
});

test('Parameter mapping keeps controlled byte arguments exclusive and ordinary strings bounded',()=>{
 const policy={toolArguments:{submit:{module:{literal:'synthetic'}}}};
 assert.throws(()=>mapping.providerMappedArguments(policy,'submit',{}, {},{module:'workbook'}),(e:any)=>e.code==='INVALID_PAYLOAD');
 assert.throws(()=>mapping.providerMappedArguments({toolArguments:{submit:{payload:{inputPath:['value','payload']}}}},'submit',{}, {value:{payload:'x'.repeat(32769)}}),(e:any)=>e.code==='BODY_TOO_LARGE');
 assert.throws(()=>mapping.providerMappedArguments({toolArguments:{submit:{bad:{literal:{constructor:'forged'}}}}},'submit',{}, {}),(e:any)=>e.code==='INVALID_PAYLOAD');
 assert.deepEqual(mapping.providerMappedArguments({},'submit',{label:'bounded'}, {},{payload_b64:'workbook'}),{label:'bounded'});
 for(const value of [undefined,NaN,Infinity,new Date(),new Map(),new Array(2),Object.defineProperty({},'secret',{get(){throw new Error('Do not evaluate accessors');},enumerable:true})])assert.throws(()=>mapping.providerMappedArguments({toolArguments:{submit:{bad:{literal:value}}}},'submit',{}, {}));
 const cycle:any={};cycle.self=cycle;assert.throws(()=>mapping.providerMappedArguments({toolArguments:{submit:{bad:{literal:cycle}}}},'submit',{}, {}));
});

test('Approved mapping declarations reject unsafe paths conflicting source kinds and invalid literal values',()=>{
 for(const source of [{inputPath:['__proto__']},{inputPath:['value'],literal:'shadow'},{literal:NaN},{inputPath:[]}])assert.equal(mapping.ProviderArgumentMapping.safeParse({submit:{module:source}}).success,false);
 assert.equal(mapping.ProviderArgumentMapping.safeParse({submit:{module:{literal:'suite'}},prepare:{device_build:{inputPath:['value','build']}}}).success,true);
});

test('Approved byte parameter mappings preserve every original while renaming only the wire parameter',()=>{
 const policy={byteArguments:{submit:{wire_b64:'original'}}};assert.deepEqual(mapping.providerMappedByteArguments(policy,'submit',{original:'workbook'}),{wire_b64:'workbook'});
 assert.deepEqual(mapping.providerMappedByteArguments({},'submit',{original:'workbook'}),{original:'workbook'});
 for(const [selected,bytes]of [[policy,{}],[policy,{original:'workbook',extra:'other'}],[{byteArguments:{submit:{first:'original',second:'original'}}},{original:'workbook'}]] as [any,Record<string,string>][])assert.throws(()=>mapping.providerMappedByteArguments(selected,'submit',bytes),(e:any)=>e.code==='INVALID_PAYLOAD');
});

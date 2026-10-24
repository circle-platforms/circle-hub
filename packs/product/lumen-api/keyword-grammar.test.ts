import assert from 'node:assert/strict';
import {test} from 'node:test';
import {paramOf} from './functions/endpoints.ts';
test('U22 prose optional markers cannot determine parameter optionality or constraints',()=>{
 for(const prose of ['可选','并非可选','1-100 可选','1-100，不可选'])assert.equal(typeof paramOf(['x','字符串',prose]),'string',prose);
});
test('U22 exact typed columns and boolean field determine a parameter',()=>{
 assert.deepEqual(paramOf(['x','string','false','','','1','12','']),{name:'x',type:'string',optional:false,minLength:1,maxLength:12});
 assert.deepEqual(paramOf(['n','int','true','1','100','','','']),{name:'n',type:'int',optional:true,minimum:1,maximum:100});
 for(const optional of ['YES','yes','1','','TRUE','maybe'])assert.equal(typeof paramOf(['n','int',optional,'1','100','','','']),'string',optional);
});

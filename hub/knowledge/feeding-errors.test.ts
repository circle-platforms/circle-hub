import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomBytes} from 'node:crypto';
import {SandboxError} from '../rules/api.ts';
import {FeedingFunctionFailure,feedingFunctionCall} from './feeding-errors.ts';
const fn='famx@1.0.0/functions/feeding.ts#default';
test('feeding failure retains only the function code and first 500 message characters, never stack or child logs',async()=>{
 const raw='Declaration metadata unavailable: '+'Ω'.repeat(550);const error=new SandboxError('FUNCTION_THREW',{message:raw,stack:'DO_NOT_COPY_STACK',original:'DO_NOT_COPY_EXTRA'},{stdout:'DO_NOT_COPY_STDOUT',stderr:'DO_NOT_COPY_STDERR'});
 await assert.rejects(()=>feedingFunctionCall(fn,[{text:'source body kept private'}],async()=>{throw error;}),value=>{assert.ok(value instanceof FeedingFunctionFailure);assert.deepEqual(value.detail,{function:fn,code:'FUNCTION_THREW',message:Array.from(raw).slice(0,500).join(''),message_status:'included',truncated:true});assert.equal(Array.from(value.detail.message!).length,500);assert.match(value.message,/FUNCTION_THREW/);assert.ok(value.message.includes(fn));assert.ok(!JSON.stringify(value).includes('DO_NOT_COPY'));assert.ok(!value.message.includes('Declaration metadata'));return true;});
});
test('credential scanning covers the complete message before truncation',()=>{
 const token=randomBytes(24).toString('hex');for(const message of ['Authorization: Bearer '+token,'X'.repeat(550)+'\nAuthorization: Bearer '+token]){const value=new FeedingFunctionFailure(new SandboxError('FUNCTION_THREW',{message}),fn,[]);assert.equal(value.detail.message,null);assert.equal(value.detail.message_status,'credential_withheld');assert.ok(!JSON.stringify(value).includes(token));}
});
test('exact source values and partial verbatim source fragments are withheld without storing any original text',()=>{
 const source='PRIVATE_SYNTHETIC_SOURCE_FRAGMENT_FOR_TEST';for(const message of ['bad value: '+source,'bad value: '+source.slice(10,26)]){const value=new FeedingFunctionFailure(new SandboxError('FUNCTION_THREW',{message}),fn,[{nodes:[{text:source}]}]);assert.equal(value.detail.message,null);assert.equal(value.detail.message_status,'source_withheld');assert.ok(!JSON.stringify(value).includes(source.slice(10,26)));}
});
test('uninspectable source scope withholds the message and non-sandbox errors retain their original boundary',async()=>{
 const value=new FeedingFunctionFailure(new SandboxError('FUNCTION_THREW',{message:'Declaration absent'}),fn,[{text:'Z'.repeat(2*1024*1024+1)}]);assert.equal(value.detail.message,null);assert.equal(value.detail.message_status,'source_unchecked');const ordinary=new Error('ordinary boundary');await assert.rejects(()=>feedingFunctionCall(fn,[],async()=>{throw ordinary;}),error=>error===ordinary);
});

test('escaped source text and malformed diagnostic text cannot become persisted message content',()=>{const source='甲乙\n丙丁';const echoed=new FeedingFunctionFailure(new SandboxError('FUNCTION_THREW',{message:JSON.stringify({text:source})}),fn,[{text:source}]);assert.equal(echoed.detail.message,null);assert.equal(echoed.detail.message_status,'source_withheld');const invalid=new FeedingFunctionFailure(new SandboxError('FUNCTION_THREW',{message:'bad \ud800'}),fn,[]);assert.equal(invalid.detail.message,null);});

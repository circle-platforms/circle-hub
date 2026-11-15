import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {HttpCallErrorData, HttpErrorEnvelope, ProtocolError, SCHEMA_REGISTRY, PROTOCOL_CODE_NAMES, callErrorCategory} from '../api.ts';

const categories = {
  CALL_AUTHENTICATION_REQUIRED:'permission_denied',CALL_ORIGIN_REFUSED:'permission_denied',
  CALL_METHOD_UNSUPPORTED:'invalid_parameters',CALL_MEDIA_TYPE_UNSUPPORTED:'invalid_parameters',CALL_REQUEST_INVALID:'invalid_parameters',
  CALL_BUSY:'temporarily_unavailable',CALL_INTERNAL_UNAVAILABLE:'temporarily_unavailable',RUN_EXPORT_NOT_READY:'not_found',
};

test('HTTP error code closure derives from generated protocol names and the eight new precise classifications', () => {
  assert.deepEqual(HttpCallErrorData.shape.code.options,[...PROTOCOL_CODE_NAMES]);
  for (const [code,category] of Object.entries(categories)) {
    assert.equal(callErrorCategory(code),category);
    assert.equal(HttpCallErrorData.safeParse({code,call_error_category:category}).success,true);
  }
  assert.equal(HttpCallErrorData.safeParse({code:'UNREGISTERED_TRANSPORT',call_error_category:null}).success,false);
  assert.equal(HttpCallErrorData.safeParse({code:'SOURCE_UNAVAILABLE',call_error_category:'unknown'}).success,false);
});

test('source-proven pre-handler rejection has literal true while absent observations gain no default', () => {
  const value = {code:'CALL_REQUEST_INVALID',call_error_category:'invalid_parameters',call_not_executed:true};
  assert.deepEqual(HttpCallErrorData.parse(value),value);
  assert.equal(HttpCallErrorData.safeParse({...value,call_not_executed:false}).success,false);
  const internal = HttpCallErrorData.parse({code:'CALL_INTERNAL_UNAVAILABLE',call_error_category:'temporarily_unavailable'});
  assert.equal(internal.call_not_executed,undefined,'internal effect state is not inferred');
  assert.equal(HttpCallErrorData.parse({code:'CALL_BUSY',call_error_category:'temporarily_unavailable'}).call_not_executed,undefined,'busy alone does not prove handler execution state');
});

test('HTTP envelope keeps message and structured facts at error level without private metadata or status inference', () => {
  const error = {message:'合成入口拒绝事实',code:'CALL_ORIGIN_REFUSED',call_error_category:'permission_denied',call_not_executed:true};
  assert.deepEqual(HttpErrorEnvelope.parse({error}),{error});
  assert.equal(HttpErrorEnvelope.safeParse({error:{...error,_meta:{code:error.code}}}).success,false);
  assert.equal(HttpErrorEnvelope.safeParse({error:{message:error.message}}).success,false);
  assert.equal(HttpErrorEnvelope.safeParse({error:{...error,call_error_category:undefined}}).success,false);
  assert.equal(HttpErrorEnvelope.safeParse({error,status:403}).success,false);
});

test('privacy unknown stays null and a consistent authorization example validates shape, not semantic proof', () => {
  const unknown = {code:'SOURCE_UNAVAILABLE',call_error_category:null};
  assert.deepEqual(HttpCallErrorData.parse(unknown),unknown);
  assert.equal(callErrorCategory('SOURCE_UNAVAILABLE'),null);
  assert.equal(callErrorCategory('SOURCE_NOT_PERMITTED'),'permission_denied');
  assert.equal(HttpCallErrorData.parse({code:'SOURCE_NOT_PERMITTED',call_error_category:'permission_denied',call_error_reason:'environment_unassigned'}).call_error_reason,'environment_unassigned');
  assert.equal(HttpCallErrorData.parse(unknown).call_error_reason,undefined);
});

test('public ProtocolError preserves existing missing and unconstrained request ids and validates new optional request facts', () => {
  const original = {code:'SOURCE_UNAVAILABLE',message:'合成缺项',missing:'合成证据',request_id:'legacy arbitrary request identity'};
  const value = {...original,audience:'usr_0'+'a'.repeat(25),due:'2026-11-15T09:00:00.000Z',next_action:'请提供合成证据',items:['doc-1:n7']};
  assert.deepEqual(ProtocolError.parse(value),value);
  assert.deepEqual(ProtocolError.parse(original),original);
  assert.equal(ProtocolError.parse({...original,request_id:''}).request_id,'','old string constraint remains unchanged');
  const absent = ProtocolError.parse({code:'SOURCE_UNAVAILABLE',message:'合成事实'});
  for (const field of ['missing','request_id','audience','due','next_action','items']) assert.equal(field in absent,false,field);
  for (const invalid of [{audience:'not-a-user'},{due:'yesterday'},{items:['']}]) assert.equal(ProtocolError.safeParse({...original,...invalid}).success,false);
});

test('registry and public generated output schemas include transport and request facts', () => {
  assert.equal(SCHEMA_REGISTRY['http-call-error-data@1'],HttpCallErrorData);
  assert.equal(SCHEMA_REGISTRY['http-error-envelope@1'],HttpErrorEnvelope);
  const schema = (name:string)=>JSON.parse(readFileSync(new URL(`../generated/schemas/${name}.v1.schema.json`,import.meta.url),'utf8'));
  assert.deepEqual(schema('http-call-error-data').properties.code.enum,[...PROTOCOL_CODE_NAMES]);
  assert.equal(schema('http-call-error-data').properties.call_not_executed.const,true);
  assert.equal(schema('http-error-envelope').properties.error.properties.message.type,'string');
  const validation = schema('validation').properties.errors.items.properties;
  assert.equal(validation.audience.type,'string');
  assert.equal(validation.due.format,'date-time');
  assert.equal(validation.next_action.type,'string');
  assert.equal(validation.items.type,'array');
  const tools = JSON.parse(readFileSync(new URL('../generated/tools.json',import.meta.url),'utf8'));
  for (const tool of tools) assert.equal(tool.outputSchema.properties.errors.items.properties.audience.type,'string');
});

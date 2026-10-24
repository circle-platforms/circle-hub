import assert from 'node:assert/strict';
import {test} from 'node:test';
import {PROTOCOL_CODES} from '../generated/protocol.ts';
import {LayerResult} from './validation.ts';
test('observed dynamic failure does not invent a violation code',()=>{
  assert.ok(LayerResult.safeParse({layer:'dynamic',terminal:'fail'}).success);
  assert.ok(LayerResult.safeParse({layer:'dynamic',terminal:'fail',code:'synthetic.observed_failure'}).success);
});
test('abandoned work and disposed unknown effects have their own registered protocol codes',()=>{
  assert.ok('RUN_ABANDONED'in PROTOCOL_CODES);
  assert.ok('EFFECT_UNKNOWN_DISPOSED'in PROTOCOL_CODES);
});

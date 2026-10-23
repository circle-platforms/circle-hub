import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isActionKind, isReason } from '../../../contracts/generated/vocabulary.ts';
import { attemptEvidence } from './retry-evidence.ts';
for(const [code, internal, reason] of [
  ['SANDBOX_TIMEOUT',undefined,'timeout'],['SANDBOX_UNAVAILABLE','queue_full','budget_exhausted'],
  ['SANDBOX_UNAVAILABLE','stopping','check_error'],['SANDBOX_UNAVAILABLE','spawn_failed','check_error'],
  ['FUNCTION_THREW',undefined,'check_error'],[undefined,undefined,undefined],
] as const) test(`stored retry evidence maps ${code ?? 'success'} ${internal ?? ''} to generated values`,()=>{
  const row=attemptEvidence('validate','synthetic-pack@1.0.0',{attempt:2,timeoutMs:200,durationMs:100,delayMs:0,retry:false,code,reason:internal},{module:'functions/check.ts'});
  assert.ok(isActionKind(row.operation));assert.equal(row.reason,reason);if(reason)assert.ok(isReason(row.reason));
  assert.equal(row.component,'synthetic-pack@1.0.0');assert.equal(row.code,undefined);
  const json=JSON.stringify(row);for(const forbidden of ['SANDBOX_','FUNCTION_THREW','queue_full','spawn_failed','stopping'])assert.ok(!json.includes(forbidden));
});

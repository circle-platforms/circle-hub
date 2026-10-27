import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IntegrityError } from '../records/api.ts';
import { createDefaultRegistry, resolveReference } from './api.ts';

test('source reader failure discloses a fixed cause and never logs the thrown source text or path', async () => {
  const secret='SYNTHETIC_SOURCE_BYTES /synthetic/private/path';
  for (const integrity of [false,true]) {
    const diagnostics:string[]=[];
    const result=await resolveReference(`src:${'a'.repeat(64)}`,{
      reader:{user:'synthetic',role:'user'},parsers:createDefaultRegistry(),
      sources:{read(){throw integrity ? new IntegrityError(secret) : new Error(secret);}},
      onDiagnostic:diagnostic=>diagnostics.push(diagnostic.message),
    });
    assert.equal(result.resolved,false);
    if(!result.resolved) assert.equal(result.code,integrity?'SOURCE_INTEGRITY_UNPROVEN':'SOURCE_RETRYABLE');
    assert.deepEqual(diagnostics,[`source reader failed: ${integrity?'integrity_unproven':'check_error'}`]);
    assert.ok(!JSON.stringify({result,diagnostics}).includes(secret));
  }
});

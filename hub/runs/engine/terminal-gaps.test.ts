import assert from 'node:assert/strict';
import { test } from 'node:test';
import { staticTerminal, dynamicLayer } from './terminals.ts';
test('an installed check returning no item result is a check error rather than an uninstalled check',()=>{
  const result=staticTerminal({producer:'fact',hasProducer:true,checks:1,outcomes:[],handling:null,expectation:{outcome:'support',codes:[]}});
  assert.equal(result.reason,'check_error');
});
test('output failure retains its dynamic cause and check-work exhaustion is unchecked',()=>{
  assert.equal(dynamicLayer({terminal:'incomplete',reason:'output_failed'}).reason,'output_failed');
  assert.equal(dynamicLayer({terminal:'incomplete',reason:'output_failed'}).terminal,'not_run');
  const result=staticTerminal({producer:'fact',hasProducer:true,checks:1,outcomes:[{check:'c',judges:'subject',outcome:{verdict:'unknown',reason:'budget_exhausted',missing:'缺检查结果',statement:'检查工作上限用完',grounds:[],tier:'advisory'}}],handling:null,expectation:{outcome:'support',codes:[]}});
  assert.equal(result.terminal,'unchecked');
});

test('only explicit premise paths wait for another requirement repair and inherit its exit',async()=>{
  const {waitForRepairs}=await import('./terminals.ts');
  const {claim:declaredClaim,RECOVERY}=await import('../../../contracts/src/fixtures.ts');
  const claim=(await import('../../../contracts/src/claim.ts')).Claim.parse(declaredClaim);
  claim.validity.premises=['/items/0/slots/source/0'];
  const results:import('../../../contracts/src/validation.ts').RequirementResult[]=[{requirement:'dependent',layers:[{layer:'static' as const,terminal:'pass' as const}],status:'satisfied' as const,claims:[claim]}];
  waitForRepairs(results,[{requirement:'source',pointer:'/items/0/slots/source',exit:RECOVERY.exit}]);
  assert.equal(results[0].layers[0].terminal,'incomplete');
  assert.equal(results[0].status,'pending');
});

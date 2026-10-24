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
  const results:import('../../../contracts/src/validation.ts').RequirementResult[]=[{requirement:'dependent',layers:[{layer:'static' as const,terminal:'unchecked' as const,reason:'missing_input' as const,...RECOVERY}],status:'pending' as const,claims:[claim]}];
  waitForRepairs(results,[{requirement:'source',pointer:'/items/0/slots/source',exit:RECOVERY.exit}]);
  assert.equal(results[0].layers[0].terminal,'incomplete');
  assert.equal(results[0].status,'pending');
  assert.ok((await import('../../../contracts/src/validation.ts')).LayerResult.safeParse(results[0].layers[0]).success);
  assert.equal(results[0].layers[0].gaps?.[0].reason,'missing_input','the original missing fact survives beside its dependency');
});


test('repair dependencies never overwrite settled refutations or accept an ancestor premise',async()=>{
  const {waitForRepairs}=await import('./terminals.ts');
  const {claim:fixture,RECOVERY}=await import('../../../contracts/src/fixtures.ts');
  const {Claim}=await import('../../../contracts/src/claim.ts');
  const {partitionItems}=await import('./partitions.ts');
  const make=(premise:string):import('../../../contracts/src/validation.ts').RequirementResult=>({requirement:'dependent',status:'unsatisfied',unsatisfied_reason:'outcome_mismatch',claims:[Claim.parse({...fixture,validity:{...fixture.validity,premises:[premise]}})],layers:[{layer:'static',terminal:'violation',code:'synthetic.violation'}]});
  for(const premise of ['/items/0','/items/0/slots/source/0','/items/0/slots/source/0/detail']){
    const result=make(premise),before=structuredClone(result);
    waitForRepairs([result],[{requirement:'source',pointer:'/items/0/slots/source/0',exit:RECOVERY.exit}]);
    assert.deepEqual(result,before);
    const parts=partitionItems([{item:'synthetic',label:'synthetic',location:`src:${'a'.repeat(64)}`,requirements:[result],required:new Set(['dependent']),notCovered:false,rejection:'synthetic.violation'}],['synthetic']);
    assert.equal(parts.rejected.length,1);assert.equal(parts.incomplete.length,0);
  }
  const unsettled=make('/items/0');unsettled.status='pending';delete unsettled.unsatisfied_reason;
  unsettled.layers=[{layer:'static',terminal:'unchecked',reason:'missing_input',...RECOVERY}];
  const before=structuredClone(unsettled);
  waitForRepairs([unsettled],[{requirement:'source',pointer:'/items/0/slots/source/0',exit:RECOVERY.exit}]);
  assert.deepEqual(unsettled,before,'an ancestor premise does not identify the repaired slot');
});

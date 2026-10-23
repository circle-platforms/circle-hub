import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dynamicDisposition } from './dynamic.ts';

test('each required integrity fact gates verdicts and successful verdicts retain the judgment limit',()=>{
  const facts={owned:true,request:true,remote:true,digest:true,complete:true,unique:true,fresh:true,closed:true,device:true,continuity:true};
  for(const key of Object.keys(facts)) {
    const result=dynamicDisposition('pass',{...facts,[key]:false});
    assert.equal(result.dynamic_terminal,'no_verdict');assert.equal(result.reason,'integrity_unproven');
    assert.ok(result.missing_facts.includes(key));assert.ok(result.next_action);
  }
  for(const reported of ['pass','fail'] as const) {
    const result=dynamicDisposition(reported,facts);
    assert.equal(result.dynamic_terminal,reported);assert.equal(result.qualifier.nature,'judgment');
    assert.ok(result.qualifier.marks.includes('local_ops_not_excluded'));assert.equal(result.accepted_as_fact,false);
  }
});

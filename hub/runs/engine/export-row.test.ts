import assert from 'node:assert/strict';
import {test} from 'node:test';
import {exportedJobRow} from './dispatch-results.ts';
test('job exports preserve unknown exits and the target-reported judgment boundary',()=>{
  const row={item:'synthetic',dynamic_terminal:'no_verdict' as const,qualifier:{nature:'unknown' as const,marks:['target_reported' as const]},accepted_as_fact:false as const,missing_facts:['ownership'],missing_fact:'synthetic gap',next_action:'synthetic next',evidence:{log:'src:'+'a'.repeat(64)}};
  const exported=exportedJobRow(row);assert.deepEqual(exported,row);assert.notEqual(exported.qualifier,row.qualifier);
  assert.equal(exported.accepted_as_fact,false);assert.equal(exported.qualifier!.nature,'unknown');
  row.missing_facts.push('changed');assert.deepEqual(exported.missing_facts,['ownership']);
});
test('qualified pass remains a judgment and optional missing fields are not fabricated',()=>{
  const row={item:'synthetic',dynamic_terminal:'pass' as const,qualifier:{nature:'judgment' as const,marks:['local_ops_not_excluded' as const]},accepted_as_fact:false as const};
  const exported=exportedJobRow(row);assert.deepEqual(exported,row);assert.ok(!('next_action' in exported));assert.ok(!('missing_fact' in exported));
});

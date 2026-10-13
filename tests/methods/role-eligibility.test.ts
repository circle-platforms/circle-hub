import assert from 'node:assert/strict';
import {test} from 'node:test';
import {approvalEligibility,rolePresets} from '../../packages/tasks/src/roles.ts';

test('R3 roles: immutable presets expose three names and viewer has no submit or approval ability',()=>{
  assert.deepEqual(Object.keys(rolePresets).sort(),['admin','member','viewer']);
  for(const role of ['admin','member','viewer'] as const)assert.ok(rolePresets[role].grants.includes('tasks.read'));
  assert.ok(rolePresets.member.grants.includes('tasks.submit'));assert.ok(!rolePresets.member.grants.includes('decisions.approve'));assert.ok(!rolePresets.viewer.grants.includes('tasks.submit'));assert.ok(!rolePresets.viewer.grants.includes('assets.approve'));
});
test('R3 eligibility: members cannot decide and self decisions require disabled two person policy or a sole administrator',()=>{
  const base={role:'admin' as const,principalId:'prn_a',applicantId:'prn_a',twoPersonRule:true,adminCount:2,policyVersion:1};
  assert.equal(approvalEligibility(base).eligible,false);assert.equal(approvalEligibility({...base,role:'member'}).eligible,false);
  const independent=approvalEligibility({...base,principalId:'prn_b'});assert.equal(independent.eligible,true);assert.equal(independent.decisionMode,'independent');assert.equal(independent.singleAdminMode,false);
  const sole=approvalEligibility({...base,adminCount:1});assert.equal(sole.eligible,true);assert.equal(sole.decisionMode,'self');assert.equal(sole.singleAdminMode,true);
  const relaxed=approvalEligibility({...base,twoPersonRule:false});assert.equal(relaxed.eligible,true);assert.equal(relaxed.decisionMode,'self');assert.equal(relaxed.singleAdminMode,false);
  assert.equal(sole.verification.ruleId,'scope-approval-eligibility');assert.equal(sole.verification.result,'passed');assert.ok(!Object.hasOwn(sole.verification,'approved'));
});

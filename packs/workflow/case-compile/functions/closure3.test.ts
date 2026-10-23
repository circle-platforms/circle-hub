import assert from 'node:assert/strict';
import { test } from 'node:test';
import { goodData,subjectOf,CONTRACT_DOC,PROFILE_DOC,contractOf,bedsOf } from './test-support.ts';
import { checkContractShape,checkAddresses } from './checks.ts';
import { hasBalancedCommandText } from './binding.ts';
import { parseProfile } from './profile.ts';
import { entry,signRuntime,profileDocument } from '../testing/runtime.ts';
test('closure3 01 POSIX single quotes cannot escape an apostrophe with a backslash',()=>{const value="widget description 'it\\'s'";assert.equal(hasBalancedCommandText(value),false);const plan=goodData();plan.steps[0].args=[value];assert.ok(checkContractShape(subjectOf(plan)).some(v=>v.code==='case-compile.param_value'));});
test('closure3 02 CIDR host bits still require on-bed addresses and source replacement',()=>{for(const value of ['widget address 192.0.2.250/26','widget address 2001:db8:ffff::7/64','curl 192.0.2.250/1']){const plan=goodData();plan.steps[0].args=[value];assert.ok(checkAddresses(subjectOf(plan)).some(v=>v.code==='case-compile.address_off_bed'),value);}const plan=goodData();plan.steps[0].args=['widget address 192.0.2.200/26'];plan.replacements=[{case:'192.0.2.200',bed:'192.0.2.90'}];assert.ok(checkAddresses(subjectOf(plan,{caseTexts:['192.0.2.200']})).some(v=>v.code==='case-compile.replacement_missing'));});

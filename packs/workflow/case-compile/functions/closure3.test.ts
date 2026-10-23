import assert from 'node:assert/strict';
import { test } from 'node:test';
import { goodData,subjectOf,CONTRACT_DOC,PROFILE_DOC,contractOf,bedsOf } from './test-support.ts';
import { checkContractShape,checkAddresses } from './checks.ts';
import { hasBalancedCommandText } from './binding.ts';
import { parseProfile } from './profile.ts';
import { entry,signRuntime,profileDocument } from '../testing/runtime.ts';
test('closure3 01 POSIX single quotes cannot escape an apostrophe with a backslash',()=>{const value="widget description 'it\\'s'";assert.equal(hasBalancedCommandText(value),false);const plan=goodData();plan.steps[0].args=[value];assert.ok(checkContractShape(subjectOf(plan)).some(v=>v.code==='case-compile.param_value'));});

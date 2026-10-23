// Synthetic review regressions. Every numbered test is first run against the unfixed implementation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkContractShape, checkAddresses, checkExpectedSources } from './checks.ts';
import { goodData, subjectOf, CONTRACT_DOC, PROFILE_DOC, MANIFEST_DOC, MINDMAP_MODEL, AUTOID, bedsOf, contractOf } from './test-support.ts';
import { signRuntime, profileDocument, entry } from '../testing/runtime.ts';
import { parseProfile } from './profile.ts';
import { projectItems } from './project.ts';
import { commandSubject, quoteSubject } from './subject.ts';
import { readAddress } from './bed.ts';
import { literalAddresses, deniedCommand } from './addresses.ts';
import { bindArguments } from './binding.ts';
function extraParameter(object: string, method: string, name: string) {
  const doc = structuredClone(CONTRACT_DOC); const call = doc.entries.find((v) => v.e === object && v.f === method)!;
  call.signature.parameters.push({ name, kind: 'positional_or_keyword', required: false, default: null }); call.signature.optional.push(name);
  const contract = signRuntime(doc); return { contractDoc: contract, profileDoc: profileDocument(contract) };
}
const codes = (values: ReturnType<typeof checkContractShape>) => values.map((v) => v.code);
test('review 01 host arguments without roles and unbounded waits are rejected with repair actions', () => {
  const setup = extraParameter('widget-host', 'shell', 'then'); const data = goodData(); data.steps[1].keywords.then = 'reboot';
  assert.ok(codes(checkContractShape(subjectOf(data, setup))).includes('case-compile.param_unassigned'));
  for (const value of ['abc', '99999999']) { const bad = goodData(); bad.steps[2].args = [value]; assert.ok(codes(checkContractShape(subjectOf(bad))).includes('case-compile.wait_value')); }
});

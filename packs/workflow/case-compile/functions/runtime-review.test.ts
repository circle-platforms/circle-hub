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
test('review 02 netmasks wildcard masks and network prefixes are not off-bed host addresses', () => {
  for (const text of ['widget config 192.0.2.10 255.255.255.192', 'widget route 0.0.0.0 0.0.0.0 192.0.2.10', 'widget acl 192.0.2.0 0.0.0.63', 'widget route 192.0.2.224/27', 'widget broadcast 192.0.2.63']) {
    const data = goodData(); data.steps[0].args = [text]; assert.equal(checkAddresses(subjectOf(data))[0].verdict, 'support', text);
  }
});
test('review 03 unpaired quotes and final backslashes produce a repairable value refutation', () => {
  for (const text of ['widget health interval "60', 'widget health interval 60\\', "widget description it's"]) {
    const data = goodData(); data.steps[0].args = [text]; const result = checkContractShape(subjectOf(data)); assert.ok(codes(result).includes('case-compile.param_value')); assert.ok(result.some((v) => v.statement.includes('引号') || v.statement.includes('反斜杠')));
  }
});
test('review 04 address verification cannot report support for a roleless device parameter', () => {
  const setup = extraParameter('widget-seat', 'configure', 'note'); const data = goodData(); data.steps[0].keywords.note = 'widget address 192.0.2.1';
  const result = checkAddresses(subjectOf(data, setup)); assert.ok(codes(result).includes('case-compile.param_unassigned')); assert.ok(result.every((v) => v.verdict !== 'support'));
});
test('review 05 catalog normalization cannot introduce an unrepaired quote error', () => {
  const data = goodData(); data.steps[0].args = ['widget description ＂abc'];
  assert.ok(codes(checkContractShape(subjectOf(data))).includes('case-compile.param_value'));
  const value = commandSubject({ item: 'fixture', slots: { plan: [{ data }] }, context: { groups: [{ kind: 'case-compile', contract: CONTRACT_DOC, profile: PROFILE_DOC, manifest: MANIFEST_DOC }] } }) as Record<string, unknown>;
  assert.ok(!Object.hasOwn(value, 'phrases'));
});
test('review 06 expectations obey the same single-line and edge-whitespace constraints', () => {
  for (const text of [' 成功', '成功 ', '第一行\n第二行']) { const data = goodData(); data.expects[0].text = text; data.expects[0].quote.text = text; assert.ok(codes(checkExpectedSources(subjectOf(data))).includes('case-compile.expect_value')); }
});

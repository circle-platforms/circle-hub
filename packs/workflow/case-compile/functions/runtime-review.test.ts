import {signTypedRuntime as signRuntime,hostInput,addressInput} from '../testing/typed-fixtures.ts';
// Synthetic review regressions. Every numbered test is first run against the unfixed implementation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkContractShape, checkAddresses, checkExpectedSources } from './checks.ts';
import { goodData, subjectOf, CONTRACT_DOC, PROFILE_DOC, MANIFEST_DOC, MINDMAP_MODEL, AUTOID, bedsOf, contractOf } from './test-support.ts';
import { profileDocument, entry } from '../testing/runtime.ts';
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
  assert.ok(checkContractShape(subjectOf(data,setup)).some(v=>v.verdict==='unknown'&&v.missing?.includes('类型')));
  for (const value of ['abc', '99999999']) { const bad = goodData(); bad.steps[2].args = [value]; assert.ok(codes(checkContractShape(subjectOf(bad))).includes('case-compile.method_forbidden')); }
});
test('review 02 masks and prefixes have explicit types and do not require host membership',()=>{assert.equal(checkAddresses(addressInput('255.255.255.192',{kind:'mask'}))[0].verdict,'support');assert.equal(checkAddresses(addressInput('26',{kind:'ipv4_prefix'}))[0].verdict,'support');assert.equal(checkAddresses(addressInput('192.0.2.63',{bedMember:false}))[0].verdict,'support');});
test('review 03 unpaired quotes and final backslashes produce a repairable value refutation', () => {
  for (const text of ['widget health interval "60', 'widget health interval 60\\', "widget description it's"]) {
    const data = goodData(); data.steps[0].args = [text]; const result = checkContractShape(subjectOf(data)); assert.ok(result.every(v=>v.verdict!=='support'));assert.ok(result.some(v=>v.verdict==='refute'&&v.code==='case-compile.method_forbidden'));
  }
});
test('review 04 address verification cannot report support for a roleless device parameter', () => {
  const setup = extraParameter('widget-seat', 'configure', 'note'); const data = goodData(); data.steps[0].keywords.note = 'widget address 192.0.2.1';
  const result = checkAddresses(subjectOf(data, setup)); assert.ok(result.some(v=>v.verdict==='unknown'&&v.missing?.includes('类型'))); assert.ok(result.every((v) => v.verdict !== 'support'));
});
test('review 05 catalog normalization cannot introduce an unrepaired quote error', () => {
  const data = goodData(); data.steps[0].args = ['widget description ＂abc'];
  assert.ok(checkContractShape(subjectOf(data)).every(v=>v.verdict!=='support'));
  const value = commandSubject({ item: 'fixture', slots: { plan: [{ data }] }, context: { groups: [{ kind: 'case-compile', contract: CONTRACT_DOC, profile: PROFILE_DOC, manifest: MANIFEST_DOC }] } }) as Record<string, unknown>;
  assert.ok(!Object.hasOwn(value, 'phrases'));
});
test('review 06 expectations obey the same single-line and edge-whitespace constraints', () => {
  for (const text of [' 成功', '成功 ', '第一行\n第二行']) { const data = goodData(); data.expects[0].text = text; data.expects[0].quote.text = text; assert.ok(codes(checkExpectedSources(subjectOf(data))).includes('case-compile.expect_value')); }
});
test('review 07 dynamic shell syntax cannot bypass the host rejection boundary', () => {
  for (const text of ['/sbin/re*boot', '/sbin/re?oot', 'r$()eboot', 'echo ready; reboot']) { const data = goodData(); data.steps[1].args = [text]; assert.ok(codes(checkContractShape(hostInput(text))).includes('case-compile.host_shell_dynamic')); }
});
test('review 08 rejection matching uses the same NFKC text as the command catalog', () => {
  const data = goodData(); data.steps[0].args = ['ｓｙｓｔｅｍ　ｃｙｃｌｅ']; assert.ok(checkContractShape(subjectOf(data)).some(v=>v.verdict==='refute'&&v.code==='case-compile.method_forbidden'));
});
test('review 09 noncanonical IPv4 notations cannot hide a host target', () => {
  for (const text of ['ping -c 1 3221226234', 'ping -c 1 0xc00002fa', 'ping -c 1 192.0.762', 'curl http://0300.0.02.0372/']) { const data = goodData(); data.steps[1].args = [text]; assert.equal(checkAddresses(hostInput(text))[0].verdict,'support',text); }
});
function projectionInput(model: unknown) { return { inputs: [{ slot: 'subject', parser: 'kityminder@1', sha256: 'a'.repeat(64), model }, { slot: 'contract', model: CONTRACT_DOC }, { slot: 'profile', model: PROFILE_DOC }, { slot: 'inventory', model: MANIFEST_DOC }], parameters: { autoid: AUTOID } }; }
test('review 10 unsafe numeric autoids diagnose missing original precision rather than not found', () => {
  const model = structuredClone(MINDMAP_MODEL); (model.nodes[2].data as Record<string, unknown>).autoid = Number(AUTOID);
  const result = projectItems(projectionInput(model)) as { error: { code: string; message: string; fix: string } };
  assert.equal(result.error.code, 'case-compile.autoid_imprecise'); assert.match(result.error.message, /安全|精度/); assert.match(result.error.fix, /文本.*重新|文本.*重.*导出/);
});
test('review 11 replacement chains are invalid and undeclared source addresses stay unknown',()=>{const chain=addressInput('192.0.2.90',{source:'192.0.2.200',replacements:[{case:'192.0.2.200',bed:'192.0.2.200'}]});const data=chain.subject.data as ReturnType<typeof goodData>;data.replacements.push({case:'192.0.2.200',bed:'192.0.2.90'});assert.ok(codes(checkAddresses(chain)).includes('case-compile.replacement_invalid'));const phantom=goodData();phantom.replacements=[{case:'192.0.2.251',bed:'192.0.2.90'}];assert.ok(checkAddresses(subjectOf(phantom)).some(v=>v.verdict==='unknown'&&v.missing?.includes('冻结类型化参数身份')));});
import { readFileSync } from 'node:fs';
import { runCheck } from '../../../../hub/rules/api.ts';
test('review 12 unreadable inputs retain document pointers and cannot become vacuous interpreter support', async () => {
  const bad = subjectOf(goodData(), { contractDoc: {} }); const result = checkContractShape(bad)[0]; assert.equal(result.verdict, 'unknown'); assert.match(result.statement, /contract.*\/schema/); assert.ok(Array.isArray(result.data?.problems));
  const data = { ...goodData(), extra: true }; const raw = { item: 'fixture', slots: { plan: [{ data }] }, context: { groups: [{ kind: 'case-compile', contract: CONTRACT_DOC, profile: PROFILE_DOC, manifest: MANIFEST_DOC }] } };
  const command = commandSubject(raw) as Record<string, unknown>; assert.ok(!Object.hasOwn(command, 'phrases'));
  const quotes = quoteSubject(raw) as {blocked:Array<{pointer:string;code:string}>}; assert.ok(quotes.blocked.some(v=>v.pointer==='/data/extra'&&v.code==='case-compile.slots_invalid'));
});
test('review 13 a profile determines exactly one fully specified literal assertion call', () => {
  const none = structuredClone(PROFILE_DOC); none.allowed = none.allowed.filter((v) => v.method !== 'literal'); assert.equal(parseProfile(none, contractOf(), bedsOf()).ok, false);
  const more = structuredClone(CONTRACT_DOC); const literal = more.entries.find((v) => v.e === 'widget-check' && v.f === 'literal')!; literal.signature.parameters.push({ name: 'other', kind: 'positional_or_keyword', required: true, default: null }); literal.signature.required.push('other'); const signed = signRuntime(more);
  assert.equal(parseProfile(profileDocument(signed), contractOf(signed), bedsOf()).ok, false);
});
test('review 14 an optional-only signature still cannot encode a zero-value G cell', () => {
  const method = contractOf().enabled.find((v) => v.object === 'widget-host' && v.method === 'shell')!; const optional = { ...method, parameters: method.parameters.map((v) => ({ ...v, required: false })) };
  const result = bindArguments(optional, { object: optional.object, method: optional.method, args: [], keywords: {} }, '/step'); assert.ok(result.problems.some((v) => v.code === 'param_arity' && v.message.includes('None')));
});
test('review 15 an unreplaced declared source retains a concrete replacement repair',()=>{const result=checkAddresses(addressInput('192.0.2.200',{replacements:[{case:'192.0.2.200',bed:'192.0.2.90'}]}));assert.ok(codes(result).includes('case-compile.replacement_missing'));});
test('review 16 MAC and clock tokens never become off-bed address facts', () => {
  for (const value of ['widget mac 00:11:22:33:44:55', 'widget clock 12:30:45']) { const data = goodData(); data.steps[0].args = [value]; assert.ok(checkAddresses(subjectOf(data)).some(v=>v.verdict==='refute'&&v.code==='case-compile.method_forbidden')); assert.throws(()=>literalAddresses(value)); }
  assert.equal(readAddress(bedsOf()[0], [], '2026-10-23T00:00:00.000Z', '12:30:45').kind, 'not_address');
});
test('review 17 assertion formula prefixes and placeholders are rejected before workbook generation', () => {
  for (const text of ['=成功', '{}', '{0}', '值\u0001尾']) { const data = goodData(); data.expects[0].text = text; data.expects[0].quote.text = text; assert.ok(codes(checkExpectedSources(subjectOf(data))).includes('case-compile.expect_value')); }
});
test('review 18 every imprecise case id has its source pointer and a lossless-input action', () => {
  const model = structuredClone(MINDMAP_MODEL); for (const index of [2, 5]) (model.nodes[index].data as Record<string, unknown>).autoid = Number(AUTOID);
  const result = projectItems(projectionInput(model)) as { error: { code: string }; warnings: Array<{ message: string }> };
  assert.equal(result.error.code, 'case-compile.autoid_imprecise'); assert.equal(result.warnings.length, 2); assert.ok(result.warnings.every((v) => /\/data\/autoid/.test(v.message) && /无损|文本/.test(v.message)));
});
test('review 19 decision 35 opens covered combinations and all bed interfaces without dropping lineage allocations', () => {
  const description = JSON.parse(readFileSync(new URL('../requirements.json', import.meta.url), 'utf8')).requirements.find((v: { key: string }) => v.key === 'bed_addresses').description;
  assert.match(description, /本血缘分配/); assert.match(description, /本台架/);
  assert.equal(checkAddresses(addressInput('192.0.2.1'))[0].verdict,'support');
  const doc = structuredClone(CONTRACT_DOC); doc.entries.push({ ...entry('widget-host', 'fixture_action', [{ name: 'command', kind: 'positional_or_keyword', required: true, default: null }]), dispatch: 'execute_registry' }); const signed = signRuntime(doc); const rawProfile = profileDocument(signed);
  rawProfile.allowed.push({ object: 'widget-host', method: 'fixture_action', parameters: { command: 'host_shell' } } as any); rawProfile.hosts.push({ object: 'widget-host', method: 'fixture_action', device: 'client0' });
  assert.equal(parseProfile(rawProfile, contractOf(signed), bedsOf()).ok, false);
  const missingRoleProfile = profileDocument(signed); const target = goodData(); target.steps[1].method = 'fixture_action';
  const result = checkContractShape(subjectOf(target, { contractDoc: signed, profileDoc: missingRoleProfile })); assert.ok(codes(result).includes('case-compile.method_forbidden')); assert.ok(!codes(result).includes('case-compile.param_unassigned'));
});

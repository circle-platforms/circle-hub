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
test('review 07 dynamic shell syntax cannot bypass the host rejection boundary', () => {
  for (const text of ['/sbin/re*boot', '/sbin/re?oot', 'r$()eboot', 'echo ready; reboot']) { const data = goodData(); data.steps[1].args = [text]; assert.ok(codes(checkContractShape(subjectOf(data))).includes('case-compile.host_shell_dynamic')); }
});
test('review 08 rejection matching uses the same NFKC text as the command catalog', () => {
  const data = goodData(); data.steps[0].args = ['ｓｙｓｔｅｍ　ｃｙｃｌｅ']; assert.ok(codes(checkContractShape(subjectOf(data))).includes('case-compile.device_command_denied'));
});
test('review 09 noncanonical IPv4 notations cannot hide a host target', () => {
  for (const text of ['ping -c 1 3221226234', 'ping -c 1 0xc00002fa', 'ping -c 1 192.0.762', 'curl http://0300.0.02.0372/']) { const data = goodData(); data.steps[1].args = [text]; assert.ok(codes(checkAddresses(subjectOf(data))).includes('case-compile.address_notation'), text); }
});
function projectionInput(model: unknown) { return { inputs: [{ slot: 'subject', parser: 'kityminder@1', sha256: 'a'.repeat(64), model }, { slot: 'contract', model: CONTRACT_DOC }, { slot: 'profile', model: PROFILE_DOC }, { slot: 'inventory', model: MANIFEST_DOC }], parameters: { autoid: AUTOID } }; }
test('review 10 unsafe numeric autoids diagnose missing original precision rather than not found', () => {
  const model = structuredClone(MINDMAP_MODEL); (model.nodes[2].data as Record<string, unknown>).autoid = Number(AUTOID);
  const result = projectItems(projectionInput(model)) as { error: { code: string; message: string; fix: string } };
  assert.equal(result.error.code, 'case-compile.autoid_imprecise'); assert.match(result.error.message, /安全|精度/); assert.match(result.error.fix, /文本.*重新|文本.*重.*导出/);
});
test('review 11 replacement chains and phantom source mappings cannot be disclosed as verified', () => {
  const chain = goodData(); chain.expects[0].quote.text = '原文 192.0.2.250 与 192.0.2.10 健康检查间隔设置成功'; chain.replacements = [{ case: '192.0.2.250', bed: '192.0.2.10' }, { case: '192.0.2.10', bed: '192.0.2.90' }];
  assert.ok(codes(checkAddresses(subjectOf(chain))).includes('case-compile.replacement_invalid'));
  const phantom = goodData(); phantom.replacements = [{ case: '192.0.2.251', bed: '192.0.2.90' }]; assert.ok(codes(checkAddresses(subjectOf(phantom))).includes('case-compile.replacement_invalid'));
});
import { readFileSync } from 'node:fs';
import { runCheck } from '../../../../hub/rules/api.ts';
test('review 12 unreadable inputs retain document pointers and cannot become vacuous interpreter support', async () => {
  const bad = subjectOf(goodData(), { contractDoc: {} }); const result = checkContractShape(bad)[0]; assert.equal(result.verdict, 'unknown'); assert.match(result.statement, /contract.*\/schema/); assert.ok(Array.isArray(result.data?.problems));
  const data = { ...goodData(), extra: true }; const raw = { item: 'fixture', slots: { plan: [{ data }] }, context: { groups: [{ kind: 'case-compile', contract: CONTRACT_DOC, profile: PROFILE_DOC, manifest: MANIFEST_DOC }] } };
  const command = commandSubject(raw) as Record<string, unknown>; assert.ok(!Object.hasOwn(command, 'phrases'));
  const quotes = quoteSubject(raw) as { quotes: unknown[] }; assert.ok(quotes.quotes.length > 0);
  const table = JSON.parse(readFileSync(new URL('../tables/quotes.json', import.meta.url), 'utf8'));
  const out = await runCheck({ interpreter: 'quote@1' }, { subject: quotes, table, context: { pack: 'case-compile' } }); assert.ok(out.every((v) => v.verdict !== 'support'));
});

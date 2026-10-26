// Regenerate synthetic author samples after a format change. Expected codes are specified independently of checks.
import { readdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { signRuntime, profileDocument } from './runtime.ts';
import { CONTRACT_DOC } from '../functions/test-support.ts';
import { goodData, subjectOf, QUOTE, CATALOG_SPEC } from '../functions/test-support.ts';
import { generateWorkbook } from '../functions/generate.ts';
import { generationFixture } from './workbook.ts';
import { workbookCheckInput } from './workbook-model.ts';
import type { PlanSlots } from '../functions/slots.ts';
const root = fileURLToPath(new URL('../', import.meta.url));
const rules: Array<{ name: string; check: string; code: string; change: (value: PlanSlots) => void }> = [
  { name: 'mask-as-host', check:'bed_addresses',code:'address_off_bed',change:v=>{v.steps[1].args=['ping 63.255.255.255'];}},
  { name: 'prefix-shaped-host', check:'bed_addresses',code:'address_off_bed',change:v=>{v.steps[1].args=['ping 224.0.0.0'];}},
  { name: 'g-positional-keyword', check: 'contract_shape', code: 'param_value', change: (v) => { v.steps[1].args = ['FOO=1 echo 192.0.2.90']; } },
  {name:'ipv4-mapped-off-bed',check:'bed_addresses',code:'address_off_bed',change:v=>{v.steps[0].args=['widget address ::ffff:192.0.2.250'];}},
  {name:'leading-zero-address',check:'bed_addresses',code:'address_notation',change:v=>{v.steps[0].args=['widget address 192.000.002.250'];}},
  {name:'cidr-source-replacement',check:'bed_addresses',code:'replacement_missing',change:v=>{v.steps[0].args=['widget address 192.0.2.200/26'];v.replacements=[{case:'192.0.2.200',bed:'192.0.2.90'}];v.expects[0].quote.text='原文 192.0.2.200 健康检查间隔设置成功';}},
  {name:'cidr-interface',check:'bed_addresses',code:'address_off_bed',change:v=>{v.steps[0].args=['widget address 192.0.2.250/26'];}},
  {name:'cidr-url-path',check:'bed_addresses',code:'address_off_bed',change:v=>{v.steps[1].args=['curl 192.0.2.250/1'];}},
  { name:'single-quote-backslash',check:'contract_shape',code:'param_value',change:v=>{v.steps[0].args=["widget description 'it\\'s'"]; }},
  { name: 'quote-unpaired', check: 'contract_shape', code: 'param_value', change: (v) => { v.steps[0].args = ['widget health interval "60']; } },
  { name: 'wait-limit', check: 'contract_shape', code: 'wait_value', change: (v) => { v.steps[2].args = ['99999999']; } },
  { name: 'host-expansion', check: 'contract_shape', code: 'host_shell_dynamic', change: (v) => { v.steps[1].args = ['/sbin/re*boot']; } },
  { name: 'nonstandard-host-target', check: 'bed_addresses', code: 'address_notation', change: (v) => { v.steps[1].args = ['ping 3221226234']; } },
  { name: 'expect-value', check: 'expected_sources', code: 'expect_value', change: (v) => { v.expects[0].text = '{}'; v.expects[0].quote.text = '{}'; } },
  { name: 'replacement-phantom', check: 'bed_addresses', code: 'replacement_invalid', change: (v) => { v.replacements = [{ case: '192.0.2.251', bed: '192.0.2.90' }]; } },
  { name: 'replacement-chain', check: 'bed_addresses', code: 'replacement_invalid', change: (v) => { v.replacements = [{ case: '192.0.2.250', bed: '192.0.2.10' }, { case: '192.0.2.10', bed: '192.0.2.90' }]; v.expects[0].quote.text = '原文 192.0.2.250 与 192.0.2.10 健康检查间隔设置成功'; } },
  { name: 'assertion-in-steps', check: 'contract_shape', code: 'assertion_in_steps', change: (v) => { v.steps.push({ object: 'widget-check', method: 'literal', args: ['未经溯源的断言'], keywords: {} }); } },
  { name: 'blocks-nonempty', check: 'contract_shape', code: 'slots_invalid', change: (v) => { (v as unknown as { blocks: string[] }).blocks = ['setup']; } },
  { name: 'method-forbidden', check: 'contract_shape', code: 'method_forbidden', change: (v) => { v.steps[0].object = 'widget-disabled'; v.steps[0].method = 'cycle'; } },
  { name: 'empty-call', check: 'contract_shape', code: 'method_not_allowed', change: (v) => { v.steps[0].method = 'credential'; v.steps[0].args = []; } },
  { name: 'extra-keyword', check: 'contract_shape', code: 'param_arity', change: (v) => { v.steps[0].keywords.extra = 'x'; } },
  { name: 'missing-required', check: 'contract_shape', code: 'param_arity', change: (v) => { v.steps[0].args = []; } },
  { name: 'positional-keyword', check: 'contract_shape', code: 'param_keyword', change: (v) => { v.steps[0].keywords.line = v.steps[0].args[0]; v.steps[0].args = []; } },
  { name: 'credential-parameter', check: 'contract_shape', code: 'param_sensitive', change: (v) => { v.steps[0].keywords.auth_token = 'synthetic-placeholder'; } },
  { name: 'multiline-value', check: 'contract_shape', code: 'param_value', change: (v) => { v.steps[0].args = ['widget health\ninterval 60']; } },
  { name: 'placeholder-value', check: 'contract_shape', code: 'param_value', change: (v) => { v.steps[0].args = ['widget {}']; } },
  { name: 'indexed-placeholder', check: 'contract_shape', code: 'param_value', change: (v) => { v.steps[0].args = ['widget {0}']; } },
  { name: 'formula-value', check: 'contract_shape', code: 'param_value', change: (v) => { v.steps[0].args = ['=1']; } },
  { name: 'whitespace-value', check: 'contract_shape', code: 'param_value', change: (v) => { v.steps[0].args = [' widget health interval 60']; } },
  { name: 'device-denied', check: 'contract_shape', code: 'device_command_denied', change: (v) => { v.steps[0].args = ['system cycle']; } },
  { name: 'host-denied', check: 'contract_shape', code: 'host_command_denied', change: (v) => { v.steps[1].args = ['sudo reboot']; } },
  { name: 'address-off-bed', check: 'bed_addresses', code: 'address_off_bed', change: (v) => { v.steps[0].args = ['widget address 192.0.2.250']; } },
  { name: 'replacement-not-bijective', check: 'bed_addresses', code: 'replacement_invalid', change: (v) => { v.replacements = [{ case: '192.0.2.200', bed: '192.0.2.90' }, { case: '192.0.2.201', bed: '192.0.2.90' }]; v.expects[0].quote.text = '原地址 192.0.2.200 和 192.0.2.201 健康检查间隔设置成功'; } },
  { name: 'replacement-missing', check: 'bed_addresses', code: 'replacement_missing', change: (v) => { v.replacements = [{ case: '192.0.2.10', bed: '192.0.2.90' }]; v.expects[0].quote.text = '原地址 192.0.2.10 健康检查间隔设置成功'; v.steps[0].args = ['widget address 192.0.2.10']; } },
  { name: 'expect-not-in-quote', check: 'expected_sources', code: 'expect_not_in_quote', change: (v) => { v.expects[0].text = '模型新写的结论'; } },
  { name: 'expect-after-wait', check: 'expected_sources', code: 'expect_after', change: (v) => { v.expects[0].after = 3; } },
  { name: 'expect-without-source', check: 'expected_sources', code: 'expect_without_source', change: (v) => { v.expects[0].quote.reference = ''; } },
  { name: 'expect-none', check: 'expected_sources', code: 'expect_without_source', change: (v) => { v.expects = []; } },
];
export function writeSamples(): void {
  // Only this package's author JSON fixtures are replaced; obsolete 1.x protocol samples cannot be kept as 2.0 inputs.
  for (const polarity of ['positive', 'negative']) for (const file of readdirSync(join(root, 'samples', polarity))) if (file.endsWith('.json')) unlinkSync(join(root, 'samples', polarity, file));
  const save = (polarity: string, name: string, check: string, subject: unknown, code?: string, extras = {}) => {
    const value = { id: `${name.replaceAll('-', '_')}_${polarity}`, source: 'author', check, note: `合成${polarity === 'positive' ? '正' : '反'}例：${name}`, subject, ...extras, expect: [{ verdict: code ? 'refute' : 'support', ...(code ? { code } : {}), item: 'doc-1:c-1', tier: 'blocking' }] };
    writeFileSync(join(root, 'samples', polarity, `${name}.json`), JSON.stringify(value, null, 2) + '\n');
  };
  for (const rule of rules) {
    save('positive', rule.name, rule.check, subjectOf(goodData()).subject);
    const bad = goodData(); rule.change(bad); save('negative', rule.name, rule.check, subjectOf(bad).subject, `case-compile.${rule.code}`);
  }
  const cjk=goodData();cjk.expects[0].quote.text='页面跳转到\n首页';cjk.expects[0].text='页面跳转到首页';save('positive','quote-wide-whitespace','expected_sources',subjectOf(cjk).subject);cjk.expects[0].text='页面跳转到登录页';save('negative','quote-wide-whitespace','expected_sources',subjectOf(cjk).subject,'case-compile.expect_not_in_quote');
  const latin=goodData();latin.expects[0].quote.text='set  10\t0';latin.expects[0].text='set 10 0';save('positive','quote-latin-boundary','expected_sources',subjectOf(latin).subject);latin.expects[0].text='set 100';save('negative','quote-latin-boundary','expected_sources',subjectOf(latin).subject,'case-compile.expect_not_in_quote');
  const quoted=goodData();quoted.steps[1].args=["curl 'http://192.0.2.90/index.html?id=1'"];save('positive','quoted-host-url','contract_shape',subjectOf(quoted).subject);quoted.steps[1].args=['curl http://192.0.2.90/index.html?id=1'];save('negative','quoted-host-url','contract_shape',subjectOf(quoted).subject,'case-compile.host_shell_dynamic');
  const fraction=goodData();fraction.steps[1].args=['ping -i 0.2 -c 3 192.0.2.90'];save('positive','subsecond-host-option','bed_addresses',subjectOf(fraction).subject);fraction.steps[1].args=['curl -m 2.5 http://192.0.2.90/'];save('negative','subsecond-host-option','bed_addresses',subjectOf(fraction).subject,'case-compile.address_notation');
  const extra = structuredClone(CONTRACT_DOC); const method = extra.entries.find((v) => v.e === 'widget-host' && v.f === 'shell')!;
  method.signature.parameters.push({ name: 'then', kind: 'positional_or_keyword', required: false, default: null }); method.signature.optional.push('then');
  const signed = signRuntime(extra); const missing = profileDocument(signed); const assigned = structuredClone(missing); Object.assign(assigned.allowed[1].parameters, { then: 'host_shell' });
  const yes = goodData(); yes.steps[1].keywords.then = 'echo ready';
  save('positive', 'unassigned-parameter', 'contract_shape', subjectOf(yes, { contractDoc: signed, profileDoc: assigned }).subject);
  const no = goodData(); no.steps[1].keywords.then = 'reboot';
  save('negative', 'unassigned-parameter', 'contract_shape', subjectOf(no, { contractDoc: signed, profileDoc: missing }).subject, 'case-compile.param_unassigned');
  for (const [name, phrase, code] of [['commands-not-member', 'widget unknown 60', 'core.catalog.not_member'], ['commands-out-of-range', 'widget health interval 500', 'core.catalog.param_out_of_range']] as const) {
    save('positive', name, 'commands_catalog', { item: 'doc-1:c-1', location: QUOTE.reference, phrases: ['widget health interval 60'], negative: false }, undefined, { catalog: CATALOG_SPEC });
    save('negative', name, 'commands_catalog', { item: 'doc-1:c-1', location: QUOTE.reference, phrases: [phrase], negative: false }, code, { catalog: CATALOG_SPEC });
  }
  const bytes = Buffer.from(generateWorkbook(generationFixture()));
  save('positive', 'workbook-bytes', 'workbook_verified', workbookCheckInput(bytes).subject);
  save('positive','dispatch-policy','dispatch_policy',workbookCheckInput(bytes).subject);
  bytes[10] ^= 1;
  save('negative', 'workbook-bytes', 'workbook_verified', workbookCheckInput(bytes).subject, 'case-compile.workbook_invalid');
  save('negative','dispatch-policy','dispatch_policy',workbookCheckInput(bytes).subject,'case-compile.workbook_invalid');
  for (const polarity of ['positive', 'negative']) save(polarity, 'quote-mismatch', 'expected_quotes', { item: 'doc-1:c-1', quotes: [{ reference: QUOTE.reference, text: polarity === 'positive' ? QUOTE.text : '不存在的引文' }] }, polarity === 'negative' ? 'QUOTE_MISMATCH' : undefined, { sources: { [QUOTE.reference]: QUOTE.text } });
}
if (process.argv[1]?.endsWith('/testing/samples.ts')) writeSamples();

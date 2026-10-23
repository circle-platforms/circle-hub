// Regenerate synthetic author samples after a format change. Expected codes are specified independently of checks.
import { readdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { goodData, subjectOf, QUOTE, CATALOG_SPEC } from '../functions/test-support.ts';
import type { PlanSlots } from '../functions/slots.ts';
const root = fileURLToPath(new URL('../', import.meta.url));
const rules: Array<{ name: string; check: string; code: string; change: (value: PlanSlots) => void }> = [
  { name: 'method-forbidden', check: 'contract_shape', code: 'method_forbidden', change: (v) => { v.steps[0].object = 'widget-disabled'; v.steps[0].method = 'cycle'; } },
  { name: 'method-not-allowed', check: 'contract_shape', code: 'method_not_allowed', change: (v) => { v.steps[0].method = 'credential'; v.steps[0].args = []; } },
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
  { name: 'address-router', check: 'bed_addresses', code: 'address_wrong_device', change: (v) => { v.steps[0].args = ['widget address 192.0.2.1']; } },
  { name: 'replacement-not-bijective', check: 'bed_addresses', code: 'replacement_invalid', change: (v) => { v.replacements = [{ case: '192.0.2.200', bed: '192.0.2.90' }, { case: '192.0.2.201', bed: '192.0.2.90' }]; } },
  { name: 'replacement-missing', check: 'bed_addresses', code: 'replacement_missing', change: (v) => { v.replacements = [{ case: '192.0.2.10', bed: '192.0.2.90' }]; v.steps[0].args = ['widget address 192.0.2.10']; } },
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
  for (const [name, phrase, code] of [['commands-not-member', 'widget unknown 60', 'core.catalog.not_member'], ['commands-out-of-range', 'widget health interval 500', 'core.catalog.param_out_of_range']] as const) {
    save('positive', name, 'commands_catalog', { item: 'doc-1:c-1', location: QUOTE.reference, phrases: ['widget health interval 60'], negative: false }, undefined, { catalog: CATALOG_SPEC });
    save('negative', name, 'commands_catalog', { item: 'doc-1:c-1', location: QUOTE.reference, phrases: [phrase], negative: false }, code, { catalog: CATALOG_SPEC });
  }
  for (const polarity of ['positive', 'negative']) save(polarity, 'quote-mismatch', 'expected_quotes', { item: 'doc-1:c-1', quotes: [{ reference: QUOTE.reference, text: polarity === 'positive' ? QUOTE.text : '不存在的引文' }] }, polarity === 'negative' ? 'QUOTE_MISMATCH' : undefined, { sources: { [QUOTE.reference]: QUOTE.text } });
}
if (process.argv[1]?.endsWith('/testing/samples.ts')) writeSamples();

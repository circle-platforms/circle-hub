// Inverse alternatives of one signature (the inverse-alternatives task): a switch command whose enum alternatives the
// product declared as inverse pairs (on/off) cleans up with the paired value of the same signature. All commands and
// values are synthetic.
import { goodData, subjectOf, CONTRACT_DOC } from '../functions/test-support.ts';
import { runtimeDigest } from '../functions/runtime-contract.ts';
import { compileGrammar } from '../functions/generated/command-grammar.ts';

export const ROOT = 'b'.repeat(64);
export const policy = {
  schema: 'command-policy@1',
  read_only: ['/commands/show'],
  inverse_rules: [{ source_prefix: '/commands/demo/pool', inverse_prefix: '/commands/no/demo/pool', leading_parameters: 1 }],
  inverse_alternatives: [['on', 'off'], ['enable', 'disable']],
};
const specs = [
  { words: ['demo', 'pool', 'add'], types: ['string', 'int'] },
  { words: ['no', 'demo', 'pool', 'add'], types: ['string'] },
  { words: ['demo', 'feature'], types: [] },
  { words: ['demo', 'mode'], types: [] },
  { words: ['demo', 'switch', 'on'], types: [] },
  { words: ['demo', 'switch', 'off'], types: [] },
  { words: ['demo', 'relay', 'enable'], types: [] },
  { words: ['demo', 'relay', 'disable'], types: [] },
  { words: ['demo', 'lamp', 'bright'], types: [] },
  { words: ['demo', 'lamp', 'dim'], types: [] },
];
export const entries = specs.map((spec, index) => ({
  words: spec.words,
  reference: 'tree:' + ROOT + '/commands/' + spec.words.join('/'),
  signatures: [{
    id: '1',
    reference: `src:${ROOT}/xml@1/x/commands/item[${index + 1}]/arguments`,
    params: spec.words[1] === 'feature'
      ? [{ name: 'state', type: 'enum', values: ['on', 'off'], native_type: { name: 'ENUM', declaration: `src:${ROOT}/xml@1/x/commands/item[${index + 1}]/arguments/arg[1]`, grammar: 'famx-command-tree@2' } }]
      : spec.words[1] === 'mode'
        ? [{ name: 'state', type: 'enum', values: ['auto', 'manual'], native_type: { name: 'ENUM', declaration: `src:${ROOT}/xml@1/x/commands/item[${index + 1}]/arguments/arg[1]`, grammar: 'famx-command-tree@2' } }]
        : spec.types.map((type, position) => ({ name: 'p' + position, type, native_type: { name: type === 'int' ? 'U16' : 'STRING', declaration: `src:${ROOT}/xml@1/x/commands/item[${index + 1}]/arguments/arg[${position + 1}]`, grammar: 'famx-command-tree@2' } })),
  }],
}));
export const catalog = { root: ROOT, complete: true, entries, policy };
export const grammar = compileGrammar(entries.map(entry => ({ path: '/commands/' + entry.words.join('/'), words: entry.words, signatures: entry.signatures as never })));

export function fixture(lines: Array<string | { line: string; cleanup: true }>, policyValue: unknown = policy) {
  const data = goodData();
  data.steps = lines.map(value => ({ object: 'widget-seat', method: 'configure', args: [typeof value === 'string' ? value : value.line], keywords: {}, ...(typeof value === 'string' ? {} : { cleanup: true }) }));
  data.expects = [];
  const contract = structuredClone(CONTRACT_DOC);
  delete contract.effects.effect_0.commands;
  contract.effects.effect_0.command_scope = ['/commands/demo/pool', '/commands/no/demo/pool', '/commands/demo/feature', '/commands/demo/mode', '/commands/demo/switch', '/commands/demo/relay', '/commands/demo/lamp', '/commands/show'];
  contract.effects.effect_0.budget = 1000;
  contract.contract_sha256 = runtimeDigest(contract);
  const input = subjectOf(data, { contractDoc: contract, caseTexts: [] });
  input.subject.command_identities = [];
  input.subject.command_catalog = { ...structuredClone(catalog), policy: structuredClone(policyValue) };
  return input;
}

export const cleanup = (line: string) => ({ line, cleanup: true as const });

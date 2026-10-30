// Declared confirmations and net-effect cleanup (the case-compile-ssl-teardown task): a synthetic device command that asks
// for a confirmation, a create/delete pair, and a runner prompt parameter on the configure method. All commands, names and
// values are synthetic.
import { goodData, subjectOf, CONTRACT_DOC } from '../functions/test-support.ts';
import { profileDocument } from './runtime.ts';
import { signTypedRuntime } from './typed-fixtures.ts';

export const ROOT = 'c'.repeat(64);
export const policy = {
  schema: 'command-policy@1',
  read_only: ['/commands/show'],
  inverse_rules: [
    { source_prefix: '/commands/demo/pool', inverse_prefix: '/commands/no/demo/pool', leading_parameters: 1 },
    { source_prefix: '/commands/demo/host/virtual', inverse_prefix: '/commands/clear/demo/host', leading_parameters: 1 },
    { source_prefix: '/commands/demo/start', inverse_prefix: '/commands/demo/stop', leading_parameters: 1 },
  ],
  confirmations: [{ command_prefix: '/commands/clear/demo/host', prompt: 'abort:', answer: 'YES' }],
};
const specs = [
  { words: ['demo', 'pool', 'add'], types: ['string', 'int'] },
  { words: ['no', 'demo', 'pool', 'add'], types: ['string'] },
  { words: ['demo', 'host', 'virtual'], types: ['string', 'string'] },
  { words: ['clear', 'demo', 'host'], types: ['string'] },
  { words: ['demo', 'start'], types: ['string'] },
  { words: ['demo', 'stop'], types: ['string'] },
];
export const entries = specs.map((spec, index) => ({
  words: spec.words,
  reference: 'tree:' + ROOT + '/commands/' + spec.words.join('/'),
  signatures: [{
    id: '1',
    reference: `src:${ROOT}/xml@1/x/commands/item[${index + 1}]/arguments`,
    params: spec.types.map((type, position) => ({ name: 'p' + position, type, native_type: { name: type === 'int' ? 'U16' : 'STRING', declaration: `src:${ROOT}/xml@1/x/commands/item[${index + 1}]/arguments/arg[${position + 1}]`, grammar: 'apv-command-tree@2' } })),
  }],
}));
export const catalog = { root: ROOT, complete: true, entries, policy };

/** The synthetic contract with a typed runner prompt on widget-seat.configure (role runner_option), as the real runner's
 * cmd_config declares one. */
export function promptContract() {
  const contract = structuredClone(CONTRACT_DOC) as any;
  const entry = contract.entries.find((row: any) => row.e === 'widget-seat' && row.f === 'configure');
  entry.signature.parameters.push({ name: 'prompt', kind: 'positional_or_keyword', required: false, default: 'None' });
  entry.signature.optional.push('prompt');
  entry.typed_authority.parameters.prompt = { type: 'runner_prompt', role: 'runner_option' };
  contract.types.runner_prompt = { declaration: { ...contract.types.text.declaration, name: 'runner_prompt' } };
  contract.roles.runner_option = { source: contract.roles.device_cli.source };
  contract.effects.effect_0.roles.push('runner_option');
  delete contract.effects.effect_0.commands;
  contract.effects.effect_0.command_scope = ['/commands/demo/pool', '/commands/no/demo/pool', '/commands/demo/host', '/commands/clear/demo/host', '/commands/demo/start', '/commands/demo/stop', '/commands/show'];
  contract.effects.effect_0.budget = 1000;
  return signTypedRuntime(contract);
}

export interface Step { line: string; cleanup?: true; prompt?: string }
export function fixture(steps: Array<string | Step>, policyValue: unknown = policy) {
  const data = goodData();
  data.steps = steps.map(value => { const step = typeof value === 'string' ? { line: value } : value; return { object: 'widget-seat', method: 'configure', args: [step.line], keywords: (step.prompt === undefined ? {} : { prompt: step.prompt }) as Record<string, string>, ...(step.cleanup ? { cleanup: true } : {}) }; });
  data.expects = [];
  const contract = promptContract();
  const profile = profileDocument(contract) as any;
  profile.allowed.find((call: any) => call.object === 'widget-seat' && call.method === 'configure').parameters.prompt = 'runner_option';
  const input = subjectOf(data, { contractDoc: contract, profileDoc: profile, caseTexts: [] });
  input.subject.command_identities = [];
  input.subject.command_catalog = { ...structuredClone(catalog), policy: structuredClone(policyValue) };
  return input;
}
export const cleanup = (line: string, prompt?: string): Step => ({ line, cleanup: true, ...(prompt === undefined ? {} : { prompt }) });

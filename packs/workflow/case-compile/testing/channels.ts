import { CONTRACT_DOC, QUOTE, bedsOf, goodData, subjectOf } from '../functions/test-support.ts';
import { parseRuntimeContract } from '../functions/runtime-contract.ts';
import { parseProfile } from '../functions/profile.ts';
import { planCommands } from '../functions/plan-commands.ts';
import type { PlanSlots } from '../functions/slots.ts';
import type { GenerationInput } from '../functions/generate.ts';
import { profileDocument } from './runtime.ts';
import { signTypedRuntime } from './typed-fixtures.ts';

export const ROOT = 'e'.repeat(64);
export const DISK = 'Synthetic manual 4.2: a stored file stays on the unit after the runner cleans up';
export const PEER = 'Synthetic manual 7.1: a push also writes the peer unit\'s saved configuration';
export const BOOT = 'Synthetic manual 7.3: switch the boot sync off before a reload or a push';
export const policy = {
  schema: 'command-policy@1',
  read_only: ['/commands/show', '/commands/demo'],
  inverse_rules: [],
  persistence_channels: [
    { id: 'disk', commands: [{ prefix: '/commands/demo/store' }], source: DISK },
    { id: 'peer', commands: [{ prefix: '/commands/demo/mirror/push' }, { prefix: '/commands/demo/link/rank', with_parameter: 3 }], source: PEER },
  ],
  forbidden_combinations: [
    { id: 'boot_reload', side_a: [{ prefix: '/commands/demo/mirror/boot/on' }], side_b: [{ prefix: '/commands/demo/reload' }, { prefix: '/commands/demo/mirror/push' }], source: BOOT },
  ],
};
export const plainPolicy = { schema: 'command-policy@1', read_only: policy.read_only, inverse_rules: [] };

const specs: Array<{ words: string[]; types: Array<string | { type: string; optional: true }> }> = [
  { words: ['demo', 'store', 'memory'], types: [] },
  { words: ['demo', 'store', 'file'], types: ['string'] },
  { words: ['demo', 'mirror', 'push'], types: ['string'] },
  { words: ['demo', 'mirror', 'boot', 'on'], types: [] },
  { words: ['demo', 'mirror', 'boot', 'off'], types: [] },
  { words: ['demo', 'reload', 'file'], types: ['string'] },
  { words: ['demo', 'link', 'rank'], types: ['string', 'int', 'int', { type: 'string', optional: true }] },
  { words: ['demo', 'pool', 'list'], types: [] },
  { words: ['show', 'pool'], types: [] },
];
export const entries = specs.map((spec, index) => ({
  words: spec.words,
  reference: 'tree:' + ROOT + '/commands/' + spec.words.join('/'),
  signatures: [{
    id: '1',
    reference: `src:${ROOT}/xml@1/x/commands/item[${index + 1}]/arguments`,
    params: spec.types.map((raw, position) => {
      const type = typeof raw === 'string' ? raw : raw.type;
      return { name: 'p' + position, type, ...(typeof raw === 'string' ? {} : { optional: true }), native_type: { name: type === 'int' ? 'U16' : 'STRING', declaration: `src:${ROOT}/xml@1/x/commands/item[${index + 1}]/arguments/arg[${position + 1}]`, grammar: 'famx-command-tree@2' } };
    }),
  }],
}));
export const rawCatalog = (policyValue: unknown = policy) => ({ root: ROOT, complete: true, entries: structuredClone(entries), policy: structuredClone(policyValue) });

const signed = (() => {
  const source = structuredClone(CONTRACT_DOC) as any;
  delete source.effects.effect_0.commands;
  source.effects.effect_0.command_scope = ['/commands/demo', '/commands/show'];
  source.effects.effect_0.budget = 1000;
  return signTypedRuntime(source);
})();
export const contractDoc = signed;
export const profileDoc = profileDocument(signed) as any;
const readContract = parseRuntimeContract(contractDoc); if (!readContract.ok) throw new Error('fixture contract');
const readProfile = parseProfile(profileDoc, readContract.contract, bedsOf()); if (!readProfile.ok) throw new Error('fixture profile');
export const contract = readContract.contract, profile = readProfile.profile;

export function plan(lines: string[]): PlanSlots {
  const data = goodData();
  data.steps = lines.map((line) => ({ object: 'widget-seat', method: 'configure', args: [line], keywords: {} }));
  data.expects = [{ text: '健康检查间隔设置成功', quote: { ...QUOTE }, after: 1 }];
  return data;
}
export function recipe(autoid: string, lines: string[], policyValue: unknown = policy): GenerationInput {
  const slots = plan(lines), title = `合成用例 ${autoid.slice(-2)}`;
  const receipt = planCommands(contract, profile, slots, rawCatalog(policyValue)).catalog;
  if (!receipt) throw new Error('fixture catalog');
  return { slots, fields: { command_catalog: receipt, autoid, title, path: ['合成文档', '合成分组', title], priority: '2', steps: [{ text: '原始配置步骤' }] }, contract, profile, plan_run: 'run_00000000000000000000000000', build: 'Fixture_Build_A' };
}
export const AUTOIDS = ['990000000000000041', '990000000000000042', '990000000000000043', '990000000000000044', '990000000000000045'];
export function planInput(lines: string[], policyValue: unknown = policy) {
  const input = subjectOf(plan(lines), { contractDoc, profileDoc, caseTexts: [] });
  input.subject.command_identities = [];
  input.subject.command_catalog = rawCatalog(policyValue);
  return input;
}

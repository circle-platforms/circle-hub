import { generationFixture } from './workbook.ts';
import { CONTRACT_DOC, bedsOf } from '../functions/test-support.ts';
import { signRuntime, profileDocument } from './runtime.ts';
import { parseRuntimeContract } from '../functions/runtime-contract.ts';
import { parseProfile } from '../functions/profile.ts';
export function extraParameterForMerge() {
  const source = structuredClone(CONTRACT_DOC); const method = source.entries.find((v) => v.e === 'widget-host' && v.f === 'shell')!;
  method.signature.parameters.push({ name: 'delay', kind: 'positional_or_keyword', required: false, default: null }); method.signature.optional.push('delay');
  const contractDoc = signRuntime(source); const profileDoc = profileDocument(contractDoc); Object.assign(profileDoc.allowed[1].parameters, { delay: 'wait' });
  const contract = parseRuntimeContract(contractDoc); if (!contract.ok) throw new Error('fixture contract');
  const profile = parseProfile(profileDoc, contract.contract, bedsOf()); if (!profile.ok) throw new Error('fixture profile');
  const recipe = generationFixture(); recipe.contract = contract.contract; recipe.profile = profile.profile; recipe.slots.steps[1].keywords.delay = 2;
  return { recipe, raw: { contractDoc, profileDoc } };
}

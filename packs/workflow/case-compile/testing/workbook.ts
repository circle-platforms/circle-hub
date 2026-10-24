import {planCommands} from '../functions/plan-commands.ts';
import {COMMAND_CATALOG} from '../functions/test-support.ts';
// Synthetic recipe shared by tests, never shipped as a client input or imported by a pack function.
import { contractOf, bedsOf, PROFILE_DOC, COMMAND_IDENTITIES, AUTOID, goodData } from '../functions/test-support.ts';
import { parseProfile } from '../functions/profile.ts';
import IDENTITIES from '../examples/command-identities-v2.json' with {type:'json'};
import type { GenerationInput } from '../functions/generate.ts';
export function generationFixture(): GenerationInput {
  const contract = contractOf(); const profile = parseProfile(PROFILE_DOC, contract, bedsOf()); if (!profile.ok) throw new Error('invalid synthetic profile');
  return { slots: goodData(), fields: { command_catalog:planCommands(contract,profile.profile,goodData(),COMMAND_CATALOG).catalog,command_identities:structuredClone(COMMAND_IDENTITIES),autoid: AUTOID, title: '合成用例', priority: '2', steps: [{ text: '原始配置步骤' }] }, contract, profile: profile.profile, plan_run: 'run_00000000000000000000000000', build: 'Fixture_Build_A' };
}

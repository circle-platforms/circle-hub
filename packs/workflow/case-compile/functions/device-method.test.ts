// The method a device command line is sent with (functions/plan-commands.ts deviceMethodRefusal). The reference compiler lowers
// every device configuration and observation to its configuration method; the contract writes that down as the block form's
// output methods, and a flat plan now follows the same declaration. Run 23: one case observed the peer device with another
// method after a configuration sync; that method left the session at a prompt the device had already changed, and the session
// was logged out, so the case's own cleanup and the runner's cleanup of that device were never sent, twice. Synthetic contract,
// profile and catalog only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture } from '../testing/blocks.ts';
import { signTypedRuntime } from '../testing/typed-fixtures.ts';
import { deviceMethodRefusal, planCommands } from './plan-commands.ts';
import { parseRuntimeContract } from './runtime-contract.ts';
import { parseProfile } from './profile.ts';
import { parseManifest } from './manifest.ts';
import { contractOf, PROFILE_DOC } from './test-support.ts';
import type { PlanSlots } from './slots.ts';

/** The block fixture with a second device method that sends command lines and is not among the declared output methods. */
function withSecondMethod() {
  const base = fixture();
  const doc = structuredClone(base.contractDoc) as Record<string, any>;
  const command = doc.entries.find((row: any) => row.e === 'ORBIT_0' && row.f === 'command');
  doc.entries.push({ ...structuredClone(command), f: 'privileged' });
  const contractDoc = signTypedRuntime(doc);
  const parsed = parseRuntimeContract(contractDoc);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.problems));
  const profileDoc = structuredClone(base.profileDoc) as Record<string, any>;
  profileDoc.allowed.push({ object: 'ORBIT_0', method: 'privileged', reviewed: true, parameters: { line: 'device_cli' } });
  const beds = parseManifest(base.inventory);
  if (!beds.ok) throw new Error('synthetic inventory invalid');
  const profile = parseProfile(profileDoc, parsed.contract, beds.beds);
  if (!profile.ok) throw new Error(JSON.stringify(profile.problems));
  return { ...base, contract: parsed.contract, profile: profile.profile };
}
const flat = (method: string, line = 'demo show'): PlanSlots => ({ bucket: 'bed-a', blocks: [], steps: [{ object: 'ORBIT_0', method, args: [line], keywords: {} }], expects: [], replacements: [] } as unknown as PlanSlots);

test('a device command line is sent only with a method the contract declares for that object’s output', () => {
  const { contract, profile } = withSecondMethod();
  assert.equal(deviceMethodRefusal(contract, profile, 'ORBIT_0', 'command'), null);
  const refused = deviceMethodRefusal(contract, profile, 'ORBIT_0', 'privileged');
  assert.ok(refused !== null);
  assert.equal(refused, '设备命令行要用运行器合约为 ORBIT_0 声明的设备方法下发（runtime.block_model.output_methods），方法 privileged 不在其中；照 InfoTest，设备上的配置和观察都经这些方法下发。这台设备上可以用：command');
  // An object without declared output methods, and a contract without the block form, are not checked.
  assert.equal(deviceMethodRefusal(contract, profile, 'check', 'literal'), null);
  const legacy = contractOf();
  const legacyProfile = parseProfile(PROFILE_DOC, legacy, (parseManifest(fixture().inventory) as any).beds);
  assert.ok(legacyProfile.ok);
  if (legacyProfile.ok) assert.equal(deviceMethodRefusal(legacy, legacyProfile.profile, 'widget-seat', 'configure'), null);
});

test('a flat plan that sends a device command line with an undeclared method is refused before dispatch, the declared method is not', () => {
  const { contract, profile, catalog } = withSecondMethod();
  const refused = planCommands(contract, profile, flat('privileged'), catalog).problems.filter((problem) => problem.verdict === 'refute');
  assert.equal(refused.length, 1, JSON.stringify(refused));
  assert.equal(refused[0].pointer, '/steps/0/args/0');
  assert.match(refused[0].message, /方法 privileged 不在其中；照 InfoTest，设备上的配置和观察都经这些方法下发。这台设备上可以用：command$/);
  const kept = planCommands(contract, profile, flat('command'), catalog);
  assert.deepEqual(kept.problems, [], JSON.stringify(kept.problems));
  assert.equal(kept.identities.length, 1, 'the declared method’s line still resolves to its command');
});

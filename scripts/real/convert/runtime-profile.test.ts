import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runtimeDocument, entry, signRuntime, profileDocument } from '../../../packs/workflow/case-compile/testing/runtime.ts';
import { parseRuntimeContract } from '../../../packs/workflow/case-compile/functions/runtime-contract.ts';
import { checkCoverage, checkProfile, draftProfile } from './runtime-profile.ts';
import { convertTopology } from './bed-topology.ts';
import { topology } from './testing.ts';
import { checkContractShape } from '../../../packs/workflow/case-compile/functions/checks.ts';
import { MANIFEST_DOC, goodData, subjectOf } from '../../../packs/workflow/case-compile/functions/test-support.ts';
function setup() {
  const original = runtimeDocument();
  const contract = signRuntime({ ...original, entries: [...original.entries, entry('widget-seat', 'inspect', [{ name: 'query', kind: 'positional_only', required: true, default: null }]), entry('widget-seat', 'opaque', [{ name: 'binary', kind: 'positional_only', required: true, default: null }])] });
  const profile = { ...profileDocument(contract), synthetic: false, allowed: [...profileDocument(contract).allowed, { object: 'widget-seat', method: 'inspect', parameters: { query: 'device_cli' } }], unopened: [{ object: 'widget-seat', method: 'credential', parameters: [{ name: 'password', missing: '脱敏凭据', reason: '不能传入', next: '核对认证接入' }] }, { object: 'widget-seat', method: 'opaque', parameters: [{ name: 'binary', missing: '合成二进制参数没有角色', reason: '现有角色无法核验', next: '另开包检查任务，增加角色与筛查' }] }], pending: [] };
  const manifest = convertTopology(topology()); return { contract, profile, manifest };
}
test('profile draft includes all seven enabled combinations and separates explicit unopened parameters', () => {
  const { contract, profile, manifest } = setup();
  const draft = draftProfile({ ready: true, device_count: 2 }, manifest, contract, { allowed: profile.allowed, unopened: profile.unopened });
  assert.equal(draft.allowed.length, 5); assert.equal(draft.unopened.length, 2); assert.ok(draft.pending.length);
  assert.ok(draft.allowed.every((v) => v.object !== 'widget-disabled'));
  assert.throws(() => checkProfile(draft, manifest, contract));
  assert.equal(checkProfile(profile, manifest, contract).allowed.length, 5);
});
test('profile check refuses missing extra duplicate roleless and undocumented unopened combinations', () => {
  const { contract, profile, manifest } = setup(); const parsed = parseRuntimeContract(contract); assert.ok(parsed.ok);
  for (const mutate of [(v: any) => v.allowed.pop(), (v: any) => v.allowed.push({ object: 'widget-disabled', method: 'cycle', parameters: {} }), (v: any) => v.unopened.push(v.unopened[0]), (v: any) => delete v.allowed[0].parameters.line, (v: any) => v.unopened[0].parameters[0].next = '']) {
    const bad = structuredClone(profile); mutate(bad); assert.throws(() => checkCoverage(bad, parsed.contract));
  }
  assert.throws(() => checkProfile({ ...profile, runtime: { ...profile.runtime, contract_sha256: 'b'.repeat(64) } }, manifest, contract));
});
test('profile drafts never guess parameter semantics or environment mappings', () => {
  const { contract, manifest } = setup(); const draft = draftProfile({ ready: true, device_count: 2 }, manifest, contract);
  assert.equal(draft.allowed.length, 6); assert.ok(draft.allowed.every((v) => Object.values(v.parameters).every((role) => role === null)));
  assert.equal(draft.seats, null); assert.equal(draft.denied.device, null);
  assert.throws(() => draftProfile({ ready: false, device_count: 2 }, manifest, contract));
  assert.throws(() => draftProfile({ ready: true }, manifest, contract));
});

test('deployment publication refuses empty command screens and synthetic identity markers', () => {
  const { profile, contract, manifest } = setup(); const deployed = { ...profile, synthetic: false };
  for (const [part, expression] of [['device', /denied\/device.*重启.*清配置.*升级.*HA.*--check/], ['host', /denied\/host.*重启.*关机.*格式化.*--check/]] as const) {
    const bad = structuredClone(deployed); bad.denied[part] = []; assert.throws(() => checkProfile(bad, manifest, contract), expression);
  }
  assert.throws(() => checkProfile({ ...deployed, synthetic: true }, manifest, contract), /synthetic.*false.*--check/);
  assert.equal(checkProfile(deployed, manifest, contract).synthetic, false);
});

test('unmodified contracts allow an optional redacted credential without assigning it a role', () => {
  const contract = runtimeDocument(); const profile = { ...profileDocument(contract), synthetic: false, pending: [], unopened: [{ object: 'widget-seat', method: 'credential', parameters: [{ name: 'password', missing: '脱敏凭据不能传入', reason: '不能核验凭据值', next: '集成者只读核对认证方式并另开接入任务' }] }] };
  assert.equal(checkProfile(profile, MANIFEST_DOC, contract).allowed.length, 4);
  const draft = draftProfile({ ready: true, device_count: 2 }, MANIFEST_DOC, contract, profile);
  assert.ok(!Object.hasOwn(draft.allowed.find(v => v.method === 'configure')!.parameters, 'auth_token'));
  assert.ok(draft.unopened.some((v: any) => v.method === 'credential'));
  const supplied = goodData(); supplied.steps[0].keywords.auth_token = 'synthetic-value';
  assert.ok(checkContractShape(subjectOf(supplied, { contractDoc: contract, profileDoc: profile })).some(outcome => outcome.code === 'case-compile.param_sensitive'));
  assert.throws(() => checkProfile({ ...profile, allowed: [...profile.allowed, { object: 'widget-seat', method: 'credential', parameters: {} }], unopened: [] }, MANIFEST_DOC, contract));
});
test('optional ordinary parameters require either a role or an explicit never-supplied declaration', () => {
  const original = runtimeDocument(); const contract = signRuntime({ ...original, entries: original.entries.map(v => v.f === 'shell' ? entry('widget-host', 'shell', [{ name: 'command', kind: 'positional_or_keyword', required: true, default: null }, { name: 'label', kind: 'positional_or_keyword', required: false, default: 'synthetic' }]) : v) });
  const profile = { ...profileDocument(contract), synthetic: false, pending: [], unopened: [{ object: 'widget-seat', method: 'credential', parameters: [{ name: 'password', missing: '脱敏', reason: '不传凭据', next: '核对接入' }] }] };
  const parsed = parseRuntimeContract(contract); assert.ok(parsed.ok);
  assert.throws(() => checkCoverage(profile, parsed.contract));
  const allowed = profile.allowed.map(v => v.method === 'shell' ? { ...v, unsupplied: ['label'] } : v);
  assert.doesNotThrow(() => checkCoverage({ ...profile, allowed }, parsed.contract));
  const supplied = goodData(); supplied.steps[1].keywords.label = 'synthetic-value';
  assert.ok(checkContractShape(subjectOf(supplied, { contractDoc: contract, profileDoc: { ...profile, allowed } })).some(outcome => outcome.code === 'case-compile.param_unassigned'));
  for (const unsupplied of [['command'], ['absent'], ['label', 'label']]) assert.throws(() => checkCoverage({ ...profile, allowed: profile.allowed.map(v => v.method === 'shell' ? { ...v, unsupplied } : v) }, parsed.contract));
});

test('zero parameter methods wait for an explicit allowed or unopened operator decision', () => {
  const original = setup(); const contract = signRuntime({ ...original.contract, entries: [...original.contract.entries, entry('widget-seat', 'snapshot')] });
  const draft = draftProfile({ ready: true, device_count: 2 }, original.manifest, contract);
  assert.ok(!draft.allowed.some(v => v.method === 'snapshot'));
  assert.ok(draft.pending.some(p => p.missing.includes('零参数') && p.next.includes('allowed') && p.next.includes('unopened')));
  const allowed = [...original.profile.allowed, { object: 'widget-seat', method: 'snapshot', parameters: {} }];
  const opened = draftProfile({ ready: true, device_count: 2 }, original.manifest, contract, { allowed, unopened: original.profile.unopened }); assert.ok(opened.allowed.some(v => v.method === 'snapshot'));
  const decision = { object: 'widget-seat', method: 'snapshot', parameters: [], missing: '零参数效果未核实', reason: '没有命令文本可筛查', next: '集成者只读核对方法语义后决定' };
  const parsed = parseRuntimeContract(contract); assert.ok(parsed.ok);
  assert.doesNotThrow(() => checkCoverage({ ...original.profile, unopened: [...original.profile.unopened, decision] }, parsed.contract));
  assert.throws(() => checkCoverage({ ...original.profile, unopened: [...original.profile.unopened, { ...decision, next: '' }] }, parsed.contract));
});


test('profile parser refusals disclose safe field pointers and corrective actions', () => {
  const { profile, manifest, contract } = setup(); const bad = { ...profile, workbook: { ...profile.workbook, header: ['synthetic-private-value'] } };
  assert.throws(() => checkProfile(bad, manifest, contract), error => error instanceof Error && /\/workbook\/header/.test(error.message) && /--check/.test(error.message) && !error.message.includes('synthetic-private-value'));
});

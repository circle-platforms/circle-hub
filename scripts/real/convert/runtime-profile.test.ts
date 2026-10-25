import { test } from 'node:test';
import DISPATCH from '../../../packs/workflow/case-compile/tables/dispatch-roles.json' with { type: 'json' };
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
  const profile = { ...profileDocument(contract), synthetic: false, allowed: [...profileDocument(contract).allowed, { object: 'widget-seat', method: 'inspect', parameters: { query: 'device_cli' }, reviewed: true }], unopened: [{ object: 'widget-seat', method: 'credential', parameters: [{ name: 'password', missing: '脱敏凭据', reason: '不能传入', next: '核对认证接入' }] }, { object: 'widget-seat', method: 'opaque', parameters: [{ name: 'binary', missing: '合成二进制参数没有角色', reason: '现有角色无法核验', next: '另开包检查任务，增加角色与筛查' }] }], pending: [] };
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
  assert.equal(draft.seats, null); assert.equal('denied' in draft, false, 'the retired denial word list is not drafted');
  assert.throws(() => draftProfile({ ready: false, device_count: 2 }, manifest, contract));
  assert.throws(() => draftProfile({ ready: true }, manifest, contract));
});

test('deployment publication refuses the retired denial word list and synthetic identity markers', () => {
  const { profile, contract, manifest } = setup(); const deployed = { ...profile, synthetic: false };
  const bad = structuredClone(deployed); const seat = (bad.allowed as Array<{ object: string; parameters: Record<string, string> }>).find(call => Object.values(call.parameters).includes('device_cli'))!; seat.parameters = {}; assert.throws(() => checkProfile(bad, manifest, contract), /无角色|--check/);
  // R5 retired the denial word list: a profile that still carries it is refused, and one without it needs no screen text.
  for (const denied of [{ device: [], host: [] }, { device: ['reboot'], host: ['shutdown'] }]) {
    assert.throws(() => checkProfile({ ...deployed, denied }, manifest, contract), /拒绝词表已退役/);
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
  // 这份测试合约还不是 runtime-contract@2。形状检查先报未核对，不会把旧合约上的凭据值判成 param_sensitive。
  const held = checkContractShape(subjectOf(supplied, { contractDoc: contract, profileDoc: profile }));
  assert.ok(held.some(outcome => outcome.verdict === 'unknown' && outcome.statement.includes('runtime-contract@2')));
  assert.ok(!held.some(outcome => outcome.code === 'case-compile.param_sensitive'));
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
  // 同上：旧合约未核对，到不了 param_unassigned。角色缺口仍由上面的 checkCoverage 拒绝。
  const held = checkContractShape(subjectOf(supplied, { contractDoc: contract, profileDoc: { ...profile, allowed } }));
  assert.ok(held.some(outcome => outcome.verdict === 'unknown' && outcome.statement.includes('runtime-contract@2')));
  assert.ok(!held.some(outcome => outcome.code === 'case-compile.param_unassigned'));
  for (const unsupplied of [['command'], ['absent'], ['label', 'label']]) assert.throws(() => checkCoverage({ ...profile, allowed: profile.allowed.map(v => v.method === 'shell' ? { ...v, unsupplied } : v) }, parsed.contract));
});

test('zero parameter methods wait for an explicit allowed or unopened operator decision', () => {
  const original = setup(); const contract = signRuntime({ ...original.contract, entries: [...original.contract.entries, entry('widget-seat', 'snapshot')] });
  const draft = draftProfile({ ready: true, device_count: 2 }, original.manifest, contract);
  const pendingIndex = draft.allowed.findIndex(v => v.method === 'snapshot');
  assert.ok(pendingIndex >= 0);
  assert.ok(draft.pending.some(p => p.pointer === `/allowed/${pendingIndex}/reviewed` && p.missing.includes('方法') && p.next.includes('reviewed:true')));
  const allowed = [...original.profile.allowed, { object: 'widget-seat', method: 'snapshot', parameters: {}, reviewed: true }];
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

test('direct dispatch needs the explicit method review decision independently of complete parameter roles', () => {
  const { contract, manifest, profile: supplied } = setup();
  const profile = { ...supplied, allowed: supplied.allowed.map(v => ({ object: v.object, method: v.method, parameters: v.parameters })) };
  const draft = draftProfile({ ready: true, device_count: 2 }, manifest, contract, profile);
  const index = draft.allowed.findIndex(v => v.method === 'configure');
  assert.ok(index >= 0);
  assert.ok(draft.pending.some(p => p.pointer === `/allowed/${index}/reviewed` && p.missing.includes('方法') && p.next.includes('reviewed:true')));
  assert.ok(!Object.hasOwn(draft.allowed[index]!, 'reviewed'));
  const policy = DISPATCH.dispatches.find(row => row.requires_method_review)!;
  assert.deepEqual(draft.pending.find(p => p.pointer === `/allowed/${index}/reviewed`), { pointer: `/allowed/${index}/reviewed`, missing: policy.missing, next: policy.next });
  for (const reviewed of [false, 'true', 1]) {
    const pending = draftProfile({ ready: true, device_count: 2 }, manifest, contract, { ...profile, allowed: profile.allowed.map(v => ({ ...v, reviewed })) });
    assert.ok(pending.pending.some(p => p.pointer === `/allowed/${index}/reviewed`));
  }
  const reviewed = { ...profile, allowed: profile.allowed.map(v => ({ ...v, reviewed: true })) };
  const opened = draftProfile({ ready: true, device_count: 2 }, manifest, contract, reviewed);
  assert.equal((opened.allowed[index] as Record<string, unknown>).reviewed, true);
  assert.ok(!opened.pending.some(p => p.pointer === `/allowed/${index}/reviewed`));
  const parsed = parseRuntimeContract(contract); assert.ok(parsed.ok);
  assert.throws(() => checkCoverage(profile, parsed.contract), /reviewed/);
  assert.doesNotThrow(() => checkCoverage(reviewed, parsed.contract));
});

test('dispatch role coverage leaves unsupported actions unopened and rejects roles outside their dispatch table', () => {
  const original = runtimeDocument();
  const contract = signRuntime({ ...original, entries: original.entries.map(v => v.f === 'configure' ? { ...v, dispatch: 'cmd_primitive' } : v.f === 'shell' ? { ...v, dispatch: 'execute_registry' } : v) });
  const draft = draftProfile({ ready: true, device_count: 2 }, MANIFEST_DOC, contract);
  assert.ok(!draft.allowed.some(v => v.method === 'shell'));
  const unopened = draft.unopened.find((v: any) => v.method === 'shell') as any;
  assert.ok(unopened.parameters.every((p: any) => p.missing.includes('G') && p.next.includes('case-compile')));
  const decisions = { allowed: [{ object: 'widget-seat', method: 'configure', parameters: { line: 'literal_assertion' } }], unopened: [] };
  assert.throws(() => draftProfile({ ready: true, device_count: 2 }, MANIFEST_DOC, contract, decisions), /parameters\/line/);
  for (const row of DISPATCH.dispatches) {
    const candidate = signRuntime({ ...original, entries: original.entries.map(v => v.f === 'configure' ? { ...v, dispatch: row.dispatch } : v) });
    const generated = draftProfile({ ready: true, device_count: 2 }, MANIFEST_DOC, candidate);
    if (!row.roles.length) {
      const blocked = generated.unopened.find((v: any) => v.method === 'configure') as any;
      assert.ok(blocked.parameters.every((p: any) => p.missing === row.missing && p.next === row.next));
      assert.throws(() => draftProfile({ ready: true, device_count: 2 }, MANIFEST_DOC, candidate, { allowed: [{ object: 'widget-seat', method: 'configure', parameters: {}, reviewed: true }], unopened: [] }), /没有可核验/);
    } else for (const role of DISPATCH.dispatches.flatMap(v => v.roles)) {
      const chosen = { allowed: [{ object: 'widget-seat', method: 'configure', parameters: { line: role }, reviewed: true }], unopened: [] };
      if (row.roles.includes(role)) assert.doesNotThrow(() => draftProfile({ ready: true, device_count: 2 }, MANIFEST_DOC, candidate, chosen));
      else assert.throws(() => draftProfile({ ready: true, device_count: 2 }, MANIFEST_DOC, candidate, chosen), /parameters\/line/);
    }
  }
});

test('zero argument opening still requires reviewed true rather than an empty allowed entry', () => {
  const original = runtimeDocument();
  const contract = signRuntime({ ...original, entries: [...original.entries, { ...entry('widget-seat', 'snapshot'), dispatch: 'cmd_primitive' }] });
  const decisions = { allowed: [{ object: 'widget-seat', method: 'snapshot', parameters: {} }], unopened: [] };
  const draft = draftProfile({ ready: true, device_count: 2 }, MANIFEST_DOC, contract, decisions);
  const index = draft.allowed.findIndex(v => v.method === 'snapshot');
  assert.ok(draft.pending.some(p => p.pointer === `/allowed/${index}/reviewed`));
  const opened = draftProfile({ ready: true, device_count: 2 }, MANIFEST_DOC, contract, { ...decisions, allowed: decisions.allowed.map(v => ({ ...v, reviewed: true })) });
  assert.equal((opened.allowed[index] as Record<string, unknown>).reviewed, true);
});

test('optional parameter guidance names unsupplied and redacted roles have their own refusal', () => {
  const original = runtimeDocument();
  const contract = signRuntime({ ...original, entries: original.entries.map(v => v.f === 'shell' ? entry('widget-host', 'shell', [{ name: 'command', kind: 'positional_or_keyword', required: true, default: null }, { name: 'label', kind: 'positional_or_keyword', required: false, default: 'synthetic' }]) : v) });
  const draft = draftProfile({ ready: true, device_count: 2 }, MANIFEST_DOC, contract);
  assert.ok(draft.pending.some(p => p.pointer.endsWith('/parameters/label') && p.next.includes('unsupplied')));
  const { profile, contract: base, manifest } = setup();
  const allowed = profile.allowed.map(v => v.method === 'configure' ? { ...v, parameters: { ...v.parameters, auth_token: 'device_cli' } } : v);
  assert.throws(() => checkProfile({ ...profile, allowed }, manifest, base), /脱敏参数不能定角色.*删去.*--check/);
  assert.throws(() => draftProfile({ ready: true, device_count: 2 }, manifest, base, { ...profile, allowed }), /脱敏参数不能定角色.*删去/);
});

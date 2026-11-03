// Cleanup pairs in reverse order within each device (the cleanup-per-device task): two devices configured in turn may be
// cleaned in either device order, as SyntheticReference's teardown check is not order-sensitive; within one device the later
// configuration is still cleaned first, and a step left over out of that order is named as such, not as one without an
// executed command. Synthetic commands, objects and digests only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkCommandsKnown, checkContractShape } from './checks.ts';
import { runtimeDigest } from './runtime-contract.ts';
import { fixture as oneDevice } from '../testing/inverse-alternatives.ts';
import { signTypedRuntime } from '../testing/typed-fixtures.ts';

const A = 'widget-seat', B = 'widget-seat-b';
type Doc = Record<string, any>;
interface Step { object: string; line: string; cleanup?: true }
const on = (object: string, line: string): Step => ({ object, line });
const undo = (object: string, line: string): Step => ({ object, line, cleanup: true });

/** The inverse-alternatives fixture with a second device object that takes the same device commands; `runner` declares the
 * runner's own cleanup for both devices with these prefixes. */
function twoDevices(steps: Step[], runner?: string[]) {
  const value = oneDevice([]);
  (value.subject.data as Doc).steps = steps.map((step) => ({ object: step.object, method: 'configure', args: [step.line], keywords: {}, ...(step.cleanup ? { cleanup: true } : {}) }));
  const contract = structuredClone(value.subject.contract) as Doc;
  contract.objects.push({ name: B, status: 'enabled' });
  contract.entries.push({ ...structuredClone(contract.entries.find((row: Doc) => row.e === A && row.f === 'configure')), e: B });
  if (runner) contract.cleanup = { source: 'fixture/runner-cleanup-rules', sha256: 'c'.repeat(64), objects: [A, B], rules: [{ prefixes: runner }] };
  const signed = signTypedRuntime(contract) as Doc;
  signed.contract_sha256 = runtimeDigest(signed);
  const profile = structuredClone(value.subject.profile) as Doc;
  profile.allowed.push({ object: B, method: 'configure', parameters: { line: 'device_cli' }, reviewed: true });
  profile.seats.push({ object: B, device: 'dut1', ordinal: 1 });
  profile.runtime.contract_sha256 = signed.original.contract_sha256;
  value.subject.contract = signed as never;
  value.subject.profile = profile as never;
  return value;
}
const rows = (value: ReturnType<typeof twoDevices>) => checkCommandsKnown(value);
const supported = (value: ReturnType<typeof twoDevices>) => { const result = rows(value); assert.ok(result.length > 0 && result.every((row) => row.verdict === 'support'), JSON.stringify(result)); };
const refused = (value: ReturnType<typeof twoDevices>, text: string) => { const result = rows(value); assert.ok(result.some((row) => row.verdict === 'refute' && row.statement.includes(text)), JSON.stringify(result)); return result; };

test('two devices configured in turn are cleaned in either device order', () => {
  const configure = [on(A, 'demo pool add one 10'), on(B, 'demo pool add two 20')];
  supported(twoDevices([...configure, undo(B, 'no demo pool add two'), undo(A, 'no demo pool add one')]));
  supported(twoDevices([...configure, undo(A, 'no demo pool add one'), undo(B, 'no demo pool add two')]));
});

test('with the runner covering both devices, an explicit inverse on the second device is not taken for an extra operation', () => {
  // The shape met on a real bed: a peer entry on each device, the runner clears both, the plan undoes them device by device.
  const steps = [on(A, 'demo feature on'), on(A, 'demo pool add one 10'), on(B, 'demo pool add two 20'), on(A, 'demo relay enable'), undo(A, 'demo relay disable'), undo(A, 'no demo pool add one'), undo(B, 'no demo pool add two')];
  const value = twoDevices(steps, ['demo pool', 'demo feature']);
  supported(value);
  const [shape] = checkContractShape(value);
  assert.equal(shape?.verdict, 'support', JSON.stringify(shape));
  assert.match(shape!.statement, /widget-seat 的“demo feature on”/, 'the switch nobody undid stays the runner\'s');
  assert.doesNotMatch(shape!.statement, /demo pool add/, 'the case undid both pool entries itself');
});

test('an explicit inverse of a runner-covered configuration stands anywhere on its device', () => {
  const steps = [on(A, 'demo pool add one 10'), on(A, 'demo relay enable'), undo(A, 'no demo pool add one'), undo(A, 'demo relay disable')];
  supported(twoDevices(steps, ['demo pool']));
});

test('within one device the later configuration is still cleaned first, and a step left over is named with what it undoes', () => {
  refused(twoDevices([on(A, 'demo pool add one 10'), on(A, 'demo relay enable'), undo(A, 'no demo pool add one'), undo(A, 'demo relay disable')]), '缺同设备、逆序的清理操作');
  const result = refused(twoDevices([on(A, 'demo relay enable'), on(B, 'demo pool add two 20'), undo(A, 'demo lamp dim'), undo(A, 'demo relay disable')]), '清理步骤是第 1 步配置“demo relay enable”的逆操作，但不在同一设备的逆序位置');
  assert.ok(!result.some((row) => row.statement.includes('清理段含没有对应执行命令的额外配置操作')), JSON.stringify(result));
});

test('a cleanup step that undoes nothing live on its device is still an extra operation, even when another device has it live', () => {
  refused(twoDevices([on(A, 'demo pool add one 10'), undo(A, 'no demo pool add one'), undo(B, 'no demo pool add one')]), '清理段含没有对应执行命令的额外配置操作');
});

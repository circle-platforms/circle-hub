// A removal sent ahead of the configuration it clears, the first line of InfoTest's own DNSSEC action (`no ... keygen`, then
// the keygen), is not state left over at the end: the plan's cleanup of what it configures afterwards clears the same thing, so
// the removal owes no cleanup of its own. Every other obligation stays: the configuration after it, a delete of something the
// plan never makes (decision 104), a removal that is not the declared inverse of what follows, one on another device. The
// declaration is read the way the check always reads it (the product's rules and the locked tree, never the words of a line), in
// both shapes a product writes it: one direction (`pool` to `no pool`) and a generic `no` rule that is also declared back.
// Synthetic commands only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkCommandsKnown, checkContractShape } from './checks.ts';
import { runtimeDigest } from './runtime-contract.ts';
import { fixture as oneDevice } from '../testing/inverse-alternatives.ts';
import { fixture, cleanup, policy as directed } from '../testing/confirmations.ts';
import { signTypedRuntime } from '../testing/typed-fixtures.ts';

/** A generic `no` rule declared in both directions, as a product with one prefix for every removal writes it. */
const mirrored = { schema: 'command-policy@1', read_only: ['/commands/show'], inverse_rules: [{ source_prefix: '/commands/no', inverse_prefix: '/commands' }, { source_prefix: '/commands', inverse_prefix: '/commands/no' }] };
const shapes: Array<[string, unknown]> = [['one direction', directed], ['declared back as well', mirrored]];

const supported = (value: unknown) => { const rows = checkCommandsKnown(value); assert.ok(rows.length > 0 && rows.every(row => row.verdict === 'support'), JSON.stringify(rows)); };
const statements = (value: unknown) => checkCommandsKnown(value).filter(row => row.verdict !== 'support').map(row => row.statement).join('\n');
/** The refusal's lines about one command: every `配置命令 <path>` the statement names. */
const named = (text: string) => [...text.matchAll(/配置命令 (\/commands\/[\w/]+)/g)].map(match => match[1]);

for (const [shape, policy] of shapes) {
  test(`${shape}: a removal ahead of the configuration it clears owes no cleanup of its own`, () => {
    supported(fixture(['no demo pool add one', 'demo pool add one 10', cleanup('no demo pool add one')], policy));
    // the removal may stand anywhere ahead of it, with other configuration in between
    supported(fixture(['no demo pool add one', 'demo pool add two 5', 'demo pool add one 10', cleanup('no demo pool add one'), cleanup('no demo pool add two')], policy));
  });

  test(`${shape}: the configuration after the removal still owes its declared cleanup, and the removal is not asked for one`, () => {
    const text = statements(fixture(['no demo pool add one', 'demo pool add one 10'], policy));
    assert.deepEqual(named(text), ['/commands/demo/pool/add'], text);
    assert.match(text, /缺同设备、逆序的清理操作 \/commands\/no\/demo\/pool\/add/);
  });

  test(`${shape}: a delete of something the plan never makes keeps needing its own cleanup (decision 104)`, () => {
    assert.deepEqual(named(statements(fixture(['no demo pool add one'], policy))), ['/commands/no/demo/pool/add']);
    // another name than the one configured afterwards
    assert.deepEqual(named(statements(fixture(['no demo pool add other', 'demo pool add one 10', cleanup('no demo pool add one')], policy))), ['/commands/no/demo/pool/add']);
    // a removal after the configuration is the net effect, as before: nothing is left to clean
    supported(fixture(['demo pool add one 10', 'no demo pool add one'], policy));
  });
}

test('an inverse the product never declared for the command that follows is not a removal of it', () => {
  const none = { ...(directed as object), inverse_rules: [] };
  const text = statements(fixture(['no demo pool add one', 'demo pool add one 10', cleanup('no demo pool add one')], none));
  assert.match(text, /缺唯一的产品逆操作规则/);
  assert.deepEqual(named(text).sort(), ['/commands/demo/pool/add', '/commands/no/demo/pool/add']);
});

test('a removal the locked tree cannot parse is refused as before, however it is placed', () => {
  assert.match(statements(fixture(['no demo pool drop one', 'demo pool add one 10', cleanup('no demo pool add one')])), /不是锁定 \/commands 完整语法可解析的命令/);
});

test('a declared inverse that is not a no form is a removal too: a stop ahead of the start it ends', () => {
  supported(fixture(['demo stop h1', 'demo start h1', cleanup('demo stop h1')]));
  assert.deepEqual(named(statements(fixture(['demo stop h1', 'demo start h1']))), ['/commands/demo/start']);
  assert.deepEqual(named(statements(fixture(['demo stop h1']))), ['/commands/demo/stop']);
});

test('two commands that undo each other are not a removal and a configuration: nothing is exempted there', () => {
  // the second `disable` stays live when `enable` undoes the later one; `enable` also undoes it, so the declaration says nothing of direction
  const text = statements(oneDevice(['demo relay disable', 'demo relay disable', 'demo relay enable']));
  assert.match(text, /缺同设备、逆序的清理操作（声明的枚举互逆：demo relay enable）/);
});

// The same builder as cleanup-per-device.test.ts: a second device object beside the first, and the runner's own cleanup.
const A = 'widget-seat', B = 'widget-seat-b';
type Doc = Record<string, any>;
interface Step { object: string; line: string; cleanup?: true }
const on = (object: string, line: string): Step => ({ object, line });
const undo = (object: string, line: string): Step => ({ object, line, cleanup: true });
function twoDevices(steps: Step[], runner?: string[]) {
  const value = oneDevice([]);
  (value.subject.data as Doc).steps = steps.map(step => ({ object: step.object, method: 'configure', args: [step.line], keywords: {}, ...(step.cleanup ? { cleanup: true } : {}) }));
  const contract = structuredClone(value.subject.contract) as Doc;
  contract.objects.push({ name: B, status: 'enabled' });
  contract.entries.push({ ...structuredClone(contract.entries.find((row: Doc) => row.e === A && row.f === 'configure')), e: B });
  if (runner) contract.cleanup = { source: 'fixture/runner-cleanup-rules', sha256: 'c'.repeat(64), objects: [A, B], rules: [{ prefixes: runner }] };
  const signed = signTypedRuntime(contract) as Doc;
  signed.contract_sha256 = runtimeDigest(signed);
  const profile = structuredClone(value.subject.profile) as Doc;
  profile.allowed.push({ object: B, method: 'configure', parameters: { line: 'device_cli' }, reviewed: true });
  profile.seats.push({ object: B, device: 'dut1', ordinal: 1 });
  value.subject.contract = signed as never;
  value.subject.profile = profile as never;
  return value;
}

test('a removal clears what the same device configures, not what another device does', () => {
  supported(twoDevices([on(A, 'no demo pool add one'), on(A, 'demo pool add one 10'), undo(A, 'no demo pool add one')]));
  const text = statements(twoDevices([on(A, 'no demo pool add one'), on(B, 'demo pool add one 10'), undo(B, 'no demo pool add one')]));
  assert.deepEqual(named(text), ['/commands/no/demo/pool/add'], text);
});

test('with the runner clearing the configuration, the removal ahead of it still needs nothing', () => {
  supported(twoDevices([on(A, 'no demo pool add one'), on(A, 'demo pool add one 10')], ['demo pool']));
  const [shape] = checkContractShape(twoDevices([on(A, 'no demo pool add one'), on(A, 'demo pool add one 10')], ['demo pool']));
  assert.equal(shape?.verdict, 'support', JSON.stringify(shape));
  assert.doesNotMatch(shape!.statement, /no demo pool add one/, 'the removal is not a configuration the runner clears');
});

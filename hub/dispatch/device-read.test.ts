import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalBytes, type ActionBody } from '../records/api.ts';
import type { DeviceReadTarget } from '../../contracts/src/pack.ts';
import { setup } from './testing/context.ts';
import { probes } from './testing/probes.ts';

const PATTERN = '^inspect [a-z0-9 ._:/"\'-]{1,200}$';
const KEY = 'synthetic/device/b';
const KNOWN: Record<string, string> = {
  'inspect peers': 'peers:\nname      address\npeer-1    192.0.2.7\n',
  'inspect units': 'units:\n',
};
const scripted = (command: string): Record<string, unknown> => ({ output: Object.hasOwn(KNOWN, command) ? KNOWN[command] : '' });

type Reply = (command: string, args: Record<string, unknown>) => Record<string, unknown>;

async function ready(options: { reply?: Reply; read?: Record<string, unknown> | null; pattern?: string; help?: boolean; delay?: Record<string, number> } = {}) {
  const sent: Array<Record<string, unknown>> = [];
  const c = await setup({ extraTools: ['inspect_seat', 'ask_position'], ...(options.delay === undefined ? {} : { delay: options.delay }), alter: (name, value) => {
    if (name === 'ask_position') return { help: 'synthetic words', caret: false, entered: false, cleared: true };
    if (name !== 'inspect_seat') return value;
    const args = c.endpoint.calls.filter((e) => e.params.name === 'inspect_seat').at(-1)!.params.arguments as Record<string, unknown>;
    sent.push(args);
    return (options.reply ?? ((command) => scripted(command)))(String(args.command), args);
  } });
  const readable = (user: string) => ({ readers: [user, c.admin.id], admins: true, packs: [], shareable: false });
  const manifest = await c.kit.artifacts.ingest({ bytes: canonicalBytes({ id: 'synthetic-bed', devices: [1, 2].map((n) => ({ interfaces: [{ address: `192.0.2.${n}/24` }] })) }), mediaType: 'application/json', origin: { upload: { session: 'synthetic' } }, author: { user: c.admin.id }, provenanceType: 'declared', visibility: readable(c.owner.id) });
  // A question (help) needs its certified premise; a read asks for none, so it is declared only where a test mixes the two.
  let help = {};
  if (options.help) {
    const proof = await c.kit.artifacts.ingest({ bytes: new TextEncoder().encode('synthetic audit of the help tool'), mediaType: 'text/plain', origin: { upload: { session: 'synthetic' } }, author: { user: c.admin.id }, provenanceType: 'declared', visibility: { readers: [c.admin.id], admins: true, packs: [], shareable: false } });
    help = { probes: { help: { line_pattern: '^[a-z ]{1,200}$', call: { tool: 'ask_position', arguments: { seat: { $value: 'seat_index' }, line: { $value: 'line' }, ticket: { $value: 'lease_id' } } }, text: '/help', caret_only: '/caret', entered: '/entered', cleared: '/cleared' } }, premises: { read_only: { version: '1', evidence: [`src:${proof.body.sha256}`] } } };
  }
  const declared = { ...probes, command_pattern: options.pattern ?? PATTERN, ...(options.read === null ? {} : { read: options.read ?? {} }), ...((help as { probes?: Record<string, unknown> }).probes ?? {}) };
  await c.registry.update(c.admin, c.executor.id, { ...c.executor.definition, manifest_sha256: manifest.body.sha256, allowed_tools: [...c.executor.definition.allowed_tools, 'inspect_seat', 'ask_position'], probes: declared, premises: (help as { premises?: Record<string, unknown> }).premises ?? {} });
  const logs: Array<{ what: string; detail: string }> = [];
  c.service.options.adminLog = (entry) => { logs.push({ what: entry.what, detail: entry.detail }); };
  const target = (line: string, extra: Partial<DeviceReadTarget> = {}): DeviceReadTarget => ({ inventory: manifest.body.sha256, device: '/devices/1', label: 'bed/synthetic-1', line, keys: [KEY], ...extra });
  const traffic = () => c.endpoint.calls.length;
  return { c, sent, logs, target, traffic, inventory: manifest.body.sha256 };
}

test('one line is sent once through the per-seat read inside one gateway lease, with no certified premise, and the device words come back as received', async (t) => {
  const { c, sent, target } = await ready();
  t.after(() => c.close());
  assert.deepEqual((await c.registry.get(c.executor.id))!.definition.premises, {}, 'nothing is certified: the call is the one every precheck sends');
  const [result] = await c.service.readDevices(c.owner, 'run_synthetic', [target('inspect   peers')]);
  assert.equal(result!.missing, null);
  assert.equal(result!.sent, true);
  assert.equal(result!.line, 'inspect peers', 'the line as it was sent');
  const answer = result!.answer!;
  assert.deepEqual([answer.has_output, answer.output, answer.truncated, answer.withheld, answer.anomaly], [true, KNOWN['inspect peers'], false, false, null], 'the device words, as received');
  assert.deepEqual(sent, [{ seat: 1, command: 'inspect peers', ticket: 'synthetic-ticket' }], 'one call: the seat of the device, the line, the gateway lease of this read');
  assert.ok(!c.calls.includes('send_blob') && !c.calls.includes('inspect_slot'), 'nothing is dispatched or prechecked');
  assert.deepEqual(c.calls.filter((name) => ['open_slot', 'inspect_seat', 'close_slot'].includes(name)), ['open_slot', 'inspect_seat', 'close_slot'], 'read inside one gateway lease, released after');
  // The answer as received is stored apart from the text the model may read.
  const raw = await c.kit.artifacts.source(c.admin, answer.reference.slice(4), { consumer: 'function' });
  assert.match(new TextDecoder().decode(raw!.bytes!), /peer-1/);
  assert.match(answer.text_reference ?? '', /^src:[0-9a-f]{64}$/);
  const stored = await c.kit.artifacts.source(c.owner, answer.text_reference!.slice(4), { consumer: 'function' });
  assert.equal(new TextDecoder().decode(stored!.bytes!), KNOWN['inspect peers']);
  // One line in the log: the line, whether there was output, the two references.
  const logged = (await c.kit.store.find<ActionBody>({ kind: 'action', key: 'dispatch.phase', value: 'device_read', limit: 5 })).items;
  assert.equal(logged.length, 1);
  assert.deepEqual([logged[0]!.body.detail.line, logged[0]!.body.detail.has_output, logged[0]!.body.inputs], ['inspect peers', true, [answer.reference, answer.text_reference]]);
});

test('a device that prints nothing is an observation of no output, with no text original', async (t) => {
  const { c, sent, target } = await ready();
  t.after(() => c.close());
  const [result] = await c.service.readDevices(c.owner, 'run_synthetic', [target('inspect nothing')]);
  assert.equal(result!.missing, null);
  assert.deepEqual([result!.answer!.has_output, result!.answer!.output, result!.answer!.text_reference], [false, null, null]);
  assert.match(result!.answer!.reference, /^src:[0-9a-f]{64}$/, 'the answer as received is kept all the same');
  assert.equal(sent.length, 1);
});

test('a line the declaration does not allow, and a device that cannot be read, send nothing: no gateway traffic at all', async (t) => {
  const { c, target, traffic, inventory } = await ready();
  t.after(() => c.close());
  const nothing = async (t1: DeviceReadTarget, expected: RegExp) => {
    const [r] = await c.service.readDevices(c.owner, 'run_synthetic', [t1]);
    assert.equal(r!.answer, null);
    assert.equal(r!.sent, false);
    assert.equal(r!.line, t1.line, 'the line as given');
    assert.match(r!.missing!.fact, expected);
    assert.ok(r!.missing!.next_action.length > 0);
    assert.equal(traffic(), 0, 'not one request reached the gateway');
  };
  await nothing(target('inspect peers; frobnicate'), /不符合执行器声明的只读命令形状/);
  await nothing(target('frobnicate peers'), /不符合执行器声明的只读命令形状/);
  await nothing(target('inspect peers\ninspect units'), /控制字符/);
  await nothing(target('inspect "peers'), /不是一串完整的词/);
  await nothing(target('inspect peers', { keys: ['synthetic/device/other'] }), /不在执行器 .* 管的资源里/);
  await nothing(target('inspect peers', { device: '/devices/9', label: 'bed/absent' }), /没有绑定同一份清单、指向这台设备的执行器版本探针/);
  await nothing(target('inspect peers', { inventory: 'c'.repeat(64) }), /没有绑定同一份清单/);
  c.service.activeLeaseJobs = async () => [{ key: KEY, job: 'job_unfinished' }];
  await nothing(target('inspect peers'), /job_unfinished.*不往它发命令/);
  assert.ok(inventory.length === 64);
});

test('an executor that has the device but did not opt in is named with the next step, and nothing is sent', async (t) => {
  const { c, target, traffic } = await ready({ read: null });
  t.after(() => c.close());
  const [result] = await c.service.readDevices(c.owner, 'run_synthetic', [target('inspect peers')]);
  assert.match(result!.missing!.fact, /这台执行器没有声明可以按请求读设备/);
  assert.match(result!.missing!.next_action, /executor update.*probes\.read/);
  assert.equal(result!.sent, false);
  assert.equal(traffic(), 0);
});

test('the declared shape is the whole gate: a shape that names its commands sends only them', async (t) => {
  const { c, sent, target } = await ready({ pattern: '^inspect (?:version|interfaces|units)$' });
  t.after(() => c.close());
  const [refused] = await c.service.readDevices(c.owner, 'run_synthetic', [target('inspect peers')]);
  assert.match(refused!.missing!.fact, /不符合执行器声明的只读命令形状/);
  assert.equal(sent.length, 0);
  const [read] = await c.service.readDevices(c.owner, 'run_synthetic', [target('inspect units')]);
  assert.equal(read!.answer!.output, KNOWN['inspect units']);
});

test('an answer whose declared place does not hold text is not shown; the answer as received is kept and the administrator told', async (t) => {
  const { c, logs, target } = await ready({ reply: () => ({ output: ['not', 'text'] }) });
  t.after(() => c.close());
  const [result] = await c.service.readDevices(c.owner, 'run_synthetic', [target('inspect peers')]);
  assert.equal(result!.sent, true);
  assert.deepEqual([result!.answer!.has_output, result!.answer!.output, result!.answer!.text_reference], [false, null, null]);
  assert.match(result!.answer!.anomaly ?? '', /不是文字/);
  assert.match(result!.missing!.fact, /不是文字，所以不呈现它的内容/);
  assert.ok(logs.some((l) => l.what === 'device_read' && /不是文字/.test(l.detail)), 'the administrator\'s log has it');
  assert.ok(c.calls.includes('close_slot'), 'the gateway lease is still released');
});

test('a text that looks like a credential is quoted; a long one keeps its start up to the declared bound and says so', async (t) => {
  const secret = 'DB_PASSWORD=hunter22x';
  const long = 'x'.repeat(20000);
  const reply: Reply = (command) => ({ output: command === 'inspect looks-like' ? `name   the name\n${secret}\n` : long });
  const { c, target } = await ready({ reply });
  t.after(() => c.close());
  // Decision 161 / credential-scan@4: looking like a credential does not withhold what a device printed.
  const [quoted] = await c.service.readDevices(c.owner, 'run_synthetic', [target('inspect looks-like')]);
  assert.equal(quoted!.answer!.withheld, false);
  assert.equal(quoted!.answer!.output, `name   the name\n${secret}\n`);
  const [cut] = await c.service.readDevices(c.owner, 'run_synthetic', [target('inspect long')]);
  assert.equal(cut!.answer!.truncated, true);
  assert.equal(cut!.answer!.output!.length, 16000, 'the default bound');
  const whole = await c.kit.artifacts.source(c.owner, cut!.answer!.text_reference!.slice(4), { consumer: 'function' });
  assert.equal(new TextDecoder().decode(whole!.bytes!).length, 20000, 'the original keeps all of it');
  await c.registry.update(c.admin, c.executor.id, { ...(await c.registry.get(c.executor.id))!.definition, probes: { ...probes, command_pattern: PATTERN, read: { max_chars: 100 } } });
  const [shorter] = await c.service.readDevices(c.owner, 'run_synthetic', [target('inspect long')]);
  assert.deepEqual([shorter!.answer!.truncated, shorter!.answer!.output!.length], [true, 100], 'the bound the executor declares');
});

test('a refusal of the target stops at once; it is read again only when the executor declares it safe, three times at most', async (t) => {
  const busy = () => ({ ok: false, error: 'synthetic busy', phase: 'occupied', touched: false });
  const { c, sent, logs, target } = await ready({ reply: busy });
  t.after(() => c.close());
  const [refused] = await c.service.readDevices(c.owner, 'run_synthetic', [target('inspect peers')]);
  assert.equal(sent.length, 1, 'an explicit refusal is not retried by default');
  assert.match(refused!.missing!.fact, /目标拒绝了“inspect peers”这一读/);
  assert.deepEqual([refused!.sent, refused!.answer], [true, null]);
  assert.ok(logs.some((l) => l.what === 'device_read'), 'the administrator\'s log has the cause');
  await c.registry.update(c.admin, c.executor.id, { ...(await c.registry.get(c.executor.id))!.definition, read_retry_when: [{ pointer: '/phase', equals: 'occupied' }, { pointer: '/touched', equals: false }] });
  sent.length = 0;
  const [again] = await c.service.readDevices(c.owner, 'run_synthetic', [target('inspect peers')]);
  assert.equal(sent.length, 3, 'three tries, then it stops');
  assert.match(again!.missing!.fact, /连续三次没有取得完整应答/);
  assert.ok(c.calls.includes('close_slot'), 'the gateway lease is released');
});

test('reads and questions of one executor are queued: the next gateway lease is taken after the one before is released', async (t) => {
  const { c, target } = await ready({ help: true, delay: { inspect_seat: 30, ask_position: 30 } });
  t.after(() => c.close());
  const [first, second, asked] = await Promise.all([
    c.service.readDevices(c.owner, 'run_first', [target('inspect peers')]),
    c.service.readDevices(c.owner, 'run_second', [target('inspect units')]),
    c.service.askDevices(c.owner, 'run_third', [{ ...target('widget'), line: 'widget' }]),
  ]);
  assert.equal(first![0]!.answer!.output, KNOWN['inspect peers']);
  assert.equal(second![0]!.answer!.output, KNOWN['inspect units']);
  assert.equal(asked![0]!.missing, null);
  assert.deepEqual(c.calls.filter((name) => ['open_slot', 'inspect_seat', 'ask_position', 'close_slot'].includes(name)), ['open_slot', 'inspect_seat', 'close_slot', 'open_slot', 'inspect_seat', 'close_slot', 'open_slot', 'ask_position', 'close_slot'], 'never two gateway leases of this executor at once');
});

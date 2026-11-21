import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalBytes } from '../records/api.ts';
import type { DeviceHelpTarget } from '../../contracts/src/pack.ts';
import { setup } from './testing/context.ts';
import { probes } from './testing/probes.ts';


const HELP = {
  line_pattern: '^[A-Za-z0-9 ._:/"\'-]{1,500}$',
  call: { tool: 'ask_position', arguments: { seat: { $value: 'seat_index' }, line: { $value: 'line' }, ticket: { $value: 'lease_id' } } },
  text: '/help', caret_only: '/caret', entered: '/entered', cleared: '/cleared',
};
const KEY = 'synthetic/device/b';
const KNOWN: Record<string, string> = {
  'widget': 'set    configure a widget\nshow   show the widgets',
  'widget set': '<name>   the name of a widget',
  'widget set demo': '<1-9>   a number\n<cr>',
};
const scripted = (line: string): Record<string, unknown> => (Object.hasOwn(KNOWN, line) ? { help: KNOWN[line], caret: false, entered: false, cleared: true } : { help: '', caret: true, entered: false, cleared: true });

type Reply = (line: string, args: Record<string, unknown>) => Record<string, unknown>;

async function ready(options: { reply?: Reply; help?: Record<string, unknown>; premise?: 'good' | 'none' | 'other-version' | 'unreadable-evidence'; delay?: Record<string, number> } = {}) {
  const asked: Array<Record<string, unknown>> = [];
  const c = await setup({ extraTools: ['inspect_seat', 'ask_position'], ...(options.delay === undefined ? {} : { delay: options.delay }), alter: (name, value) => {
    if (name !== 'ask_position') return value;
    const args = c.endpoint.calls.filter((e) => e.params.name === 'ask_position').at(-1)!.params.arguments as Record<string, unknown>;
    asked.push(args);
    return (options.reply ?? ((line) => scripted(line)))(String(args.line), args);
  } });
  const readable = (user: string) => ({ readers: [user, c.admin.id], admins: true, packs: [], shareable: false });
  const manifest = await c.kit.artifacts.ingest({ bytes: canonicalBytes({ id: 'synthetic-bed', devices: [1, 2].map((n) => ({ interfaces: [{ address: `192.0.2.${n}/24` }] })) }), mediaType: 'application/json', origin: { upload: { session: 'synthetic' } }, author: { user: c.admin.id }, provenanceType: 'declared', visibility: readable(c.owner.id) });
  const proof = await c.kit.artifacts.ingest({ bytes: new TextEncoder().encode('synthetic audit of the help tool'), mediaType: 'text/plain', origin: { upload: { session: 'synthetic' } }, author: { user: c.admin.id }, provenanceType: 'declared', visibility: { readers: [c.admin.id], admins: true, packs: [], shareable: false } });
  const premises = options.premise === 'none' ? {}
    : { read_only: { version: options.premise === 'other-version' ? '2' : '1', evidence: [options.premise === 'unreadable-evidence' ? `src:${'f'.repeat(64)}` : `src:${proof.body.sha256}`] } };
  await c.registry.update(c.admin, c.executor.id, { ...c.executor.definition, manifest_sha256: manifest.body.sha256, allowed_tools: [...c.executor.definition.allowed_tools, 'inspect_seat', 'ask_position'], probes: { ...probes, help: options.help ?? HELP }, premises });
  const logs: Array<{ what: string; detail: string }> = [];
  c.service.options.adminLog = (entry) => { logs.push({ what: entry.what, detail: entry.detail }); };
  const target = (line: string, extra: Partial<DeviceHelpTarget> = {}): DeviceHelpTarget => ({ inventory: manifest.body.sha256, device: '/devices/1', label: 'bed/synthetic-1', line, keys: [KEY], ...extra });
  const traffic = () => c.endpoint.calls.length;
  return { c, asked, logs, target, traffic, inventory: manifest.body.sha256 };
}

test('the whole line is asked first and shorter prefixes after it until a position is described; each answer is kept whole', async (t) => {
  const { c, asked, target } = await ready();
  t.after(() => c.close());
  const [result] = await c.service.askDevices(c.owner, 'run_synthetic', [target('widget set demo 5 6')]);
  assert.equal(result!.missing, null);
  assert.equal(result!.line, 'widget set demo 5 6');
  assert.deepEqual(result!.positions.map((p) => [p.prefix, p.words, p.next_word, p.described, p.caret_only]), [
    ['widget set demo 5 6', 5, null, false, true],
    ['widget set demo 5', 4, '6', false, true],
    ['widget set demo', 3, '5', true, false],
  ], 'the device describes the longest prefix it parses; the questioning stops there');
  assert.equal(result!.positions[2]!.text, KNOWN['widget set demo'], 'the device words, as received');
  assert.deepEqual(asked.map((a) => a.line), ['widget set demo 5 6', 'widget set demo 5', 'widget set demo']);
  assert.ok(asked.every((a) => a.seat === 1 && a.ticket === 'synthetic-ticket'), 'the seat of the device and the gateway lease of this questioning');
  assert.ok(asked.every((a) => !/[?\x00-\x1f]/.test(String(a.line))), 'the Hub sends the line alone: no question mark of its own, no line end');
  assert.ok(!c.calls.includes('send_blob') && !c.calls.includes('inspect_slot'), 'nothing is dispatched or prechecked');
  assert.ok(c.calls.indexOf('open_slot') < c.calls.indexOf('ask_position') && c.calls.lastIndexOf('ask_position') < c.calls.indexOf('close_slot'), 'asked inside one gateway lease, released after');
  const described = result!.positions[2]!;
  const raw = await c.kit.artifacts.source(c.admin, described.reference.slice(4), { consumer: 'function' });
  assert.match(new TextDecoder().decode(raw!.bytes!), /configure|1-9/);
  assert.match(described.text_reference ?? '', /^src:[0-9a-f]{64}$/);
  const stored = await c.kit.artifacts.source(c.owner, described.text_reference!.slice(4), { consumer: 'function' });
  assert.equal(new TextDecoder().decode(stored!.bytes!), KNOWN['widget set demo']);
  assert.equal(result!.positions[0]!.text_reference, null, 'a position without words has no text original');
});

test('a line the device parses whole is answered by one question', async (t) => {
  const { c, asked, target } = await ready();
  t.after(() => c.close());
  const [result] = await c.service.askDevices(c.owner, 'run_synthetic', [target('widget set demo')]);
  assert.deepEqual(result!.positions.map((p) => [p.prefix, p.described, p.next_word]), [['widget set demo', true, null]]);
  assert.equal(asked.length, 1);
});

test('a line no prefix of which the device describes is asked to its shortest prefix and says so; a bound on positions is said too', async (t) => {
  const { c, asked, target } = await ready({ reply: () => ({ help: '', caret: true, entered: false, cleared: true }) });
  t.after(() => c.close());
  const [all] = await c.service.askDevices(c.owner, 'run_synthetic', [target('nothing here')]);
  assert.deepEqual(all!.positions.map((p) => p.prefix), ['nothing here', 'nothing']);
  assert.equal(all!.missing, null, 'every prefix was asked: the shortest got no description either');
  const [bounded] = await c.service.askDevices(c.owner, 'run_synthetic', [target('a b c d e f g h i j k l m n')]);
  assert.equal(bounded!.positions.length, 12, 'the executor declares how many positions one question asks');
  assert.match(bounded!.missing!.fact, /只问了最长的 12 个前缀/);
  assert.ok(asked.length > 12);
});

test('a line or a level the declaration does not allow, and a device that cannot be asked, send nothing: no gateway traffic at all', async (t) => {
  const { c, target, traffic, inventory } = await ready();
  t.after(() => c.close());
  const nothing = async (t1: DeviceHelpTarget, expected: RegExp) => {
    const [r] = await c.service.askDevices(c.owner, 'run_synthetic', [t1]);
    assert.deepEqual(r!.positions, []);
    assert.equal(r!.line, t1.line, 'the line as given');
    assert.match(r!.missing!.fact, expected);
    assert.ok(r!.missing!.next_action.length > 0);
    assert.equal(traffic(), 0, 'not one request reached the gateway');
  };
  await nothing(target('widget set demo; frobnicate'), /不符合执行器声明的问法形状/);
  await nothing(target('widget set\ndemo'), /控制字符/);
  await nothing(target('widget set demo', { mode: 'level-a' }), /没有声明级别/);
  await nothing(target('widget', { keys: ['synthetic/device/other'] }), /不在执行器 .* 管的资源里/);
  await nothing(target('widget', { device: '/devices/9', label: 'bed/absent' }), /没有绑定同一份清单、指向这台设备的执行器版本探针/);
  await nothing(target('widget', { inventory: 'c'.repeat(64) }), /没有绑定同一份清单/);
  c.service.activeLeaseJobs = async () => [{ key: KEY, job: 'job_unfinished' }];
  await nothing(target('widget'), /job_unfinished.*不往它的终端里打字/);
  assert.ok(inventory.length === 64);
});

test('an executor that has the device but declares no help is named, and nothing is sent', async (t) => {
  const { c, target, traffic } = await ready();
  t.after(() => c.close());
  await c.registry.update(c.admin, c.executor.id, { ...(await c.registry.get(c.executor.id))!.definition, probes: probes });
  const [result] = await c.service.askDevices(c.owner, 'run_synthetic', [target('widget')]);
  assert.match(result!.missing!.fact, /管着这台设备，但没有声明问位置的调用/);
  assert.equal(traffic(), 0);
});

test('without a certified premise for this version of the target no word is typed; the target is connected and left alone', async () => {
  for (const premise of ['none', 'other-version', 'unreadable-evidence'] as const) {
    const { c, asked, target } = await ready({ premise });
    const [result] = await c.service.askDevices(c.owner, 'run_synthetic', [target('widget')]);
    assert.deepEqual(result!.positions, [], premise);
    assert.match(result!.missing!.fact, /premises\.read_only/, premise);
    assert.match(result!.missing!.fact, /没有往设备发任何字/);
    assert.equal(asked.length, 0, premise);
    assert.ok(!c.calls.includes('open_slot'), `${premise}: not even a gateway lease`);
    await c.close();
  }
});

test('an answer that does not confirm nothing was entered and the line cleared is not shown, and the questioning stops there', async (t) => {
  const { c, asked, logs, target } = await ready({ reply: (line) => ({ ...scripted(line), entered: line === 'widget set demo 5' }) });
  t.after(() => c.close());
  const [result] = await c.service.askDevices(c.owner, 'run_synthetic', [target('widget set demo 5')]);
  assert.deepEqual(asked.map((a) => a.line), ['widget set demo 5'], 'no shorter prefix is typed after it');
  const position = result!.positions[0]!;
  assert.equal(position.text, null);
  assert.equal(position.text_reference, null);
  assert.match(position.anomaly ?? '', /没有按回车/);
  assert.match(result!.missing!.fact, /不呈现它的内容，也不再往下问/);
  assert.ok(logs.some((l) => l.what === 'device_help' && /没有按回车/.test(l.detail)), 'the administrator\'s log has it');
  assert.ok(c.calls.includes('close_slot'), 'the gateway lease is still released');
});

test('a text that looks like a credential is quoted; a very long one keeps its start and says so', async (t) => {
  const secret = 'DB_PASSWORD=hunter22x';
  const long = 'x'.repeat(20000);
  const { c, target } = await ready({ reply: (line) => ({ help: line === 'looks-like' ? `name   the name\n${secret}\n` : long, caret: false, entered: false, cleared: true }) });
  t.after(() => c.close());
  const [quoted] = await c.service.askDevices(c.owner, 'run_synthetic', [target('looks-like')]);
  assert.equal(quoted!.positions[0]!.withheld, false);
  assert.equal(quoted!.positions[0]!.text, `name   the name\n${secret}\n`);
  assert.ok(quoted!.positions[0]!.described);
  assert.ok(JSON.stringify(quoted).includes('hunter22x'), 'the run gets the words as received');
  const [cut] = await c.service.askDevices(c.owner, 'run_synthetic', [target('long')]);
  assert.equal(cut!.positions[0]!.truncated, true);
  assert.equal(cut!.positions[0]!.text!.length, 16000);
  const whole = await c.kit.artifacts.source(c.owner, cut!.positions[0]!.text_reference!.slice(4), { consumer: 'function' });
  assert.equal(new TextDecoder().decode(whole!.bytes!).length, 20000, 'the original keeps all of it');
});

test('a refusal of the target is read again only when the executor declares it safe', async (t) => {
  const busy = () => ({ ok: false, error: 'synthetic busy', phase: 'occupied', touched: false });
  const { c, asked, target } = await ready({ reply: busy });
  t.after(() => c.close());
  const [refused] = await c.service.askDevices(c.owner, 'run_synthetic', [target('widget')]);
  assert.equal(asked.length, 1, 'an explicit refusal is not retried by default');
  assert.match(refused!.missing!.fact, /目标拒绝了对“widget”的这一问/);
  assert.deepEqual(refused!.positions, []);
  await c.registry.update(c.admin, c.executor.id, { ...(await c.registry.get(c.executor.id))!.definition, read_retry_when: [{ pointer: '/phase', equals: 'occupied' }, { pointer: '/touched', equals: false }] });
  asked.length = 0;
  const [again] = await c.service.askDevices(c.owner, 'run_synthetic', [target('widget')]);
  assert.equal(asked.length, 3, 'three tries, then it stops');
  assert.match(again!.missing!.fact, /连续三次没有取得完整应答|目标拒绝了/);
});

test('the level goes to the gateway only from the declared set', async (t) => {
  const levelled = { ...HELP, call: { ...HELP.call, arguments: { ...HELP.call.arguments, level: { $value: 'mode' } } }, modes: ['level-a', 'level-b'] };
  const { c, asked, target, traffic } = await ready({ help: levelled });
  t.after(() => c.close());
  const [ok] = await c.service.askDevices(c.owner, 'run_synthetic', [target('widget', { mode: 'level-b' })]);
  assert.equal(ok!.mode, 'level-b');
  assert.equal(asked[0]!.level, 'level-b');
  const before = traffic();
  const [bad] = await c.service.askDevices(c.owner, 'run_synthetic', [target('widget', { mode: 'level-c' })]);
  assert.match(bad!.missing!.fact, /级别 "level-c" 不在执行器声明的 level-a、level-b 里/);
  assert.equal(traffic(), before);
  const [none] = await c.service.askDevices(c.owner, 'run_synthetic', [target('widget')]);
  assert.match(none!.missing!.fact, /要先说在哪一级问/);
});

test('writers asking at the same moment are queued: the second gateway lease is taken after the first is released', async (t) => {
  const { c, target } = await ready({ delay: { ask_position: 30 } });
  t.after(() => c.close());
  const [first, second] = await Promise.all([
    c.service.askDevices(c.owner, 'run_first', [target('widget set demo')]),
    c.service.askDevices(c.owner, 'run_second', [target('widget')]),
  ]);
  assert.equal(first![0]!.missing, null);
  assert.equal(second![0]!.missing, null);
  assert.deepEqual(first![0]!.positions.map((p) => p.prefix), ['widget set demo']);
  assert.deepEqual(second![0]!.positions.map((p) => p.prefix), ['widget']);
  assert.deepEqual(c.calls.filter((name) => ['open_slot', 'ask_position', 'close_slot'].includes(name)), ['open_slot', 'ask_position', 'close_slot', 'open_slot', 'ask_position', 'close_slot'], 'never two gateway leases of this executor at once');
});

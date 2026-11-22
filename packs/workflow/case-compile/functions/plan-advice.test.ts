import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readSlots } from './slots.ts';
import { expandText } from './length-literals.ts';
import { addressesOf, callStrings, lengthAdvice, planAdvice } from './plan-advice.ts';

const TREE = new Set(['/commands/alpha/on', '/commands/alpha/off', '/commands/alpha/listen', '/commands/alpha/sub/enable', '/commands/alpha/sub/disable', '/commands/alpha/sub/key', '/commands/beta/listen']);
const base = { has: (path: string) => TREE.has(path), pairs: [['on', 'off'], ['enable', 'disable']] as Array<[string, string]> };

test('addresses are read as whole literals', () => {
  assert.deepEqual(addressesOf('probe @192.0.2.70 name A'), ['192.0.2.70']);
  assert.deepEqual(addressesOf('probe http://192.0.2.70:8080/x and 2001:db8::70'), ['192.0.2.70', '2001:db8::70']);
  assert.deepEqual(addressesOf('version 1.2.3.4.5 at 12:30:45'), []);
  assert.deepEqual(addressesOf('alpha listen 192.0.2.701'), []);
});

test('a host that reaches an address configured under a feature whose switch was never set is told so once', () => {
  const advice = planAdvice({ ...base, device: ['alpha sub enable', 'alpha listen 192.0.2.70', 'alpha sub key "k" 1024', 'alpha sub disable'], other: ['probe @192.0.2.70 name', 'probe @192.0.2.70 other'] });
  assert.equal(advice.length, 1);
  assert.match(advice[0], /主机命令访问 192\.0\.2\.70/);
  assert.match(advice[0], /没有执行“alpha on”或“alpha off”/);
  assert.doesNotMatch(advice[0], /必须|一定|不要|不得|禁止|务必|应当|在这些配置之前|恢复/);
  assert.match(advice[0], /由“alpha listen”配置/);
});

test('the switch command itself, with either value, answers the advice', () => {
  for (const value of ['on', 'off']) assert.deepEqual(planAdvice({ ...base, device: ['alpha ' + value, 'alpha listen 192.0.2.70'], other: ['probe @192.0.2.70 name'] }), []);
});

test('a nested switch is asked for only by a command under it', () => {
  const advice = planAdvice({ ...base, device: ['alpha on', 'alpha sub key 192.0.2.70'], other: ['probe 192.0.2.70'] });
  assert.equal(advice.length, 1);
  assert.match(advice[0], /“alpha sub enable”或“alpha sub disable”/);
});

test('a feature without a switch in the tree gives no advice', () => {
  assert.deepEqual(planAdvice({ ...base, device: ['beta listen 192.0.2.70'], other: ['probe @192.0.2.70'] }), []);
});

test('an address no device command of the case configured is named, and the plan is not refused for it', () => {
  const advice = planAdvice({ ...base, device: ['alpha on', 'alpha listen 192.0.2.71'], other: ['probe name @192.0.2.70', 'probe @2001:db8::70 name'] });
  assert.equal(advice.length, 2);
  assert.match(advice[0], /192\.0\.2\.70；本条的设备命令里没有出现这个地址/);
  for (const line of advice) assert.doesNotMatch(line, /必须|一定|不要|不得|禁止|务必|应当|先在|再交|不用改|加上|设置开关/);
  assert.match(advice[1], /2001:db8::70/);
});

test('an address no device command of the plan holds is said together with the ready plans of the same compilation that do hold it', () => {
  const siblings = [
    { path: 'cases/01/ready/01.json', device: ['alpha on', 'alpha listen 192.0.2.70'] },
    { path: 'cases/02/ready/02.json', device: ['alpha on', 'alpha listen 192.0.2.71'] },
    { path: 'cases/03/ready/03.json', device: ['alpha listen 192.0.2.70 53'] },
    { path: 'cases/05/ready/05.json', device: ['alpha listen 192.0.2.70'] },
  ];
  const advice = planAdvice({ ...base, device: ['alpha sub key "k" 1024'], other: ['probe @192.0.2.70 name', 'probe @192.0.2.99 name'], siblings });
  assert.equal(advice.length, 2);
  assert.equal(advice[0], '主机命令访问 192.0.2.70；本条的设备命令里没有出现这个地址。设备在每条用例开始前会被清理。同一次编译里已过全部关口的计划 cases/01/ready/01.json、cases/03/ready/03.json 的设备命令里有这个地址');
  assert.equal(advice[1], '主机命令访问 192.0.2.99；本条的设备命令里没有出现这个地址。设备在每条用例开始前会被清理', 'no ready plan holds this one, so nothing is added');
  for (const line of advice) assert.doesNotMatch(line, /必须|一定|不要|不得|禁止|务必|应当|照抄|参照/);
});

test('a plan without host commands or without addresses gives no advice', () => {
  assert.deepEqual(planAdvice({ ...base, device: ['alpha listen 192.0.2.70'], other: [] }), []);
  assert.deepEqual(planAdvice({ ...base, device: ['alpha listen 192.0.2.70'], other: ['wait 5'] }), []);
});

// Long names of a fixed length: the same fixed parts with two lengths in one plan are said once, with where each length is used.
const NEXT_STEP = '本意是同一个名字就用同一个定长占位；本意不同就保留';
const long = (placeholder: string) => expandText(placeholder).text;
const at = (path: string) => `/slots/plan/0/data/${path}`;

test('names that share their fixed parts and differ in length are one line: the lengths, where each is used, and what to do about it', () => {
  const advice = lengthAdvice([
    { pointer: at('steps/0/args/0'), text: `widget host ${long('{{domain:200|pfx|sfx}}')}` },
    { pointer: at('steps/1/args/0'), text: `show ${long('{{domain:200|pfx|sfx}}')} ${long('{{domain:200|pfx|sfx}}')}` },
    { pointer: at('steps/2/args/0'), text: `no widget host ${long('{{domain:204|pfx|sfx}}')}` },
    { pointer: at('steps/3/keywords/name'), text: long('{{domain:204|pfx|sfx}}') },
    { pointer: at('steps/4/args/0'), text: 'show host example.com' },
  ]);
  assert.deepEqual(advice, [`固定部分相同的定长名字有 2 种长度：200 字符（{{domain:200|pfx|sfx}}）用在 ${at('steps/0/args/0')}、${at('steps/1/args/0')}；204 字符（{{domain:204|pfx|sfx}}）用在 ${at('steps/2/args/0')}、${at('steps/3/keywords/name')}；${NEXT_STEP}`]);
  assert.doesNotMatch(advice[0]!, /必须|一定|不得|禁止|务必|应当/, 'it says what the plan holds and leaves the decision to the writer');
});

test('one length, other fixed parts, ordinary names and a name used twice in one string give no advice', () => {
  const same = long('{{domain:200|pfx|sfx}}');
  assert.deepEqual(lengthAdvice([{ pointer: '/a', text: same }, { pointer: '/b', text: `x ${same}` }, { pointer: '/c', text: `${same} ${same}` }]), [], 'the same length everywhere');
  assert.deepEqual(lengthAdvice([{ pointer: '/a', text: long('{{domain:200|pfx|sfx}}') }, { pointer: '/b', text: long('{{domain:204|other|sfx}}') }]), [], 'another prefix is another name');
  assert.deepEqual(lengthAdvice([{ pointer: '/a', text: long('{{domain:200|pfx|sfx}}') }, { pointer: '/b', text: long('{{domain:204|pfx|end}}') }]), [], 'and so is another suffix');
  assert.deepEqual(lengthAdvice([{ pointer: '/a', text: long('{{domain:200|pfx|sfx}}') }, { pointer: '/b', text: long('{{name:204|pfx.|.sfx}}') }]), [], 'and another kind');
  assert.deepEqual(lengthAdvice([{ pointer: '/a', text: long('{{name:64}}') }, { pointer: '/b', text: long('{{name:70}}') }, { pointer: '/c', text: 'a'.repeat(10) }]).length, 1, 'plain names are told apart by their length too');
  assert.deepEqual(lengthAdvice([{ pointer: '/a', text: 'pool_1 pool_22' }, { pointer: '/b', text: 'a.b.c.example.com' }, { pointer: '/c', text: long('{{name:15}}') }]), [], 'short names are not long names');
  assert.deepEqual(lengthAdvice([]), []);
});

test('each group of names is its own line, in order of their lengths, and a long list of places is cut with the count said', () => {
  const lines = lengthAdvice([
    { pointer: '/a', text: long('{{name:70|pool_}}') }, { pointer: '/b', text: long('{{name:64|pool_}}') },
    { pointer: '/c', text: long('{{domain:100|pfx|sfx}}') }, { pointer: '/d', text: long('{{domain:101|pfx|sfx}}') },
  ]);
  assert.equal(lines.length, 2);
  assert.ok(lines[0]!.startsWith('固定部分相同的定长名字有 2 种长度：64 字符（{{name:64|pool_}}）用在 /b；70 字符（{{name:70|pool_}}）用在 /a；'), lines[0]);
  assert.ok(lines[1]!.includes('100 字符（{{domain:100|pfx|sfx}}）用在 /c；101 字符'), lines[1]);
  const many = lengthAdvice([...Array.from({ length: 8 }, (_, n) => ({ pointer: `/p/${n}`, text: long('{{name:64}}') })), { pointer: '/q', text: long('{{name:65}}') }]);
  assert.ok(many[0]!.includes('64 字符（{{name:64}}）用在 /p/0、/p/1、/p/2、/p/3、/p/4、/p/5 等共 8 处；65 字符'), many[0]);
});

test('the strings a plan sends are found at the place they have in the plan file, for steps as for blocks', () => {
  const quote = { reference: `src:${'a'.repeat(64)}/kityminder@1/n/exp`, text: 'OK' };
  const flat = { bucket: 'bed-a', blocks: [], replacements: [], expects: [], steps: [{ object: 'dut0', method: 'exec', args: ['one', 'two'], keywords: { name: 'three', wait: 5, 'a/b': 'four' } }] };
  const flatSlots = readSlots(flat);
  assert.ok(flatSlots.ok);
  assert.deepEqual(callStrings(flatSlots.slots, { slots: { plan: [{ data: flat }] } }), [
    { pointer: '/slots/plan/0/data/steps/0/args/0', text: 'one' }, { pointer: '/slots/plan/0/data/steps/0/args/1', text: 'two' },
    { pointer: '/slots/plan/0/data/steps/0/keywords/name', text: 'three' }, { pointer: '/slots/plan/0/data/steps/0/keywords/a~1b', text: 'four' },
  ]);
  assert.equal(callStrings(flatSlots.slots, { slots: { plan: { data: flat } } })[0]!.pointer, '/slots/plan/data/steps/0/args/0', 'a plan that is not in a list');
  assert.equal(callStrings(flatSlots.slots, { slots: { plan: [flat] } })[0]!.pointer, '/slots/plan/0/steps/0/args/0', 'and one that holds its slots itself');
  const blocks = {
    bucket: 'bed-a', steps: [], expects: [], replacements: [], block_context: { preconditions: [], causal_links: [{ from: 'b1', to: 'observe', quote }], responders: [] }, criteria: [],
    obligations: [{ expectation: quote.reference, status: 'asserted', assertions: ['a1'] }],
    blocks: [
      { id: 'b1', kind: 'CONFIG', call: { object: 'widget-seat', method: 'configure', args: ['widget health one'], keywords: {} } },
      { id: 'observe', kind: 'OBSERVE_ASSERT', call: { object: 'widget-seat', method: 'show', args: ['show widget'], keywords: {} }, assertions: [{ id: 'a1', output: 'observe', op: 'abs_found', literal: 'OK', quote, expectation: quote.reference }] },
    ],
  };
  const blockSlots = readSlots(blocks);
  assert.ok(blockSlots.ok, JSON.stringify(blockSlots));
  assert.deepEqual(callStrings(blockSlots.slots, { slots: { plan: [{ data: blocks }] } }), [
    { pointer: '/slots/plan/0/data/blocks/0/call/args/0', text: 'widget health one' }, { pointer: '/slots/plan/0/data/blocks/1/call/args/0', text: 'show widget' },
  ]);
});

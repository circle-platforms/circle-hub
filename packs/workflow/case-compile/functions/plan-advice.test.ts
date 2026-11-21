import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addressesOf, planAdvice } from './plan-advice.ts';

// A synthetic tree: one feature with a switch and a nested switch, one feature without.
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
  // Disclosure only: what the plan holds and one fact about the runner, no instruction.
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

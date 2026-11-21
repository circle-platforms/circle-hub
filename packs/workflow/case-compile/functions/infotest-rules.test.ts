// Two mechanical rules taken from the reference engine after run 12 (decision 163): a query whose output is asserted must be sent
// from a host on the target's segment (InfoTest driver_no_declared_path), and an assertion's text must not be part of the command
// whose output it reads (InfoTest assertion_matches_command_echo). Synthetic bed: client0 192.0.2.80/26 runs widget-host.shell;
// dut0 has 192.0.2.74/26 on that segment and 192.0.2.10/26 on one client0 does not touch.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkAddresses, checkExpectedSources } from './checks.ts';
import { hostReaches, interfacesOf } from './bed.ts';
import { bedsOf, CONTRACT_DOC, goodData, QUOTE, subjectOf } from './test-support.ts';
import { signTypedRuntime } from '../testing/typed-fixtures.ts';

const codes = (outcomes: Array<{ verdict: string; code?: string }>) => outcomes.filter((row) => row.verdict === 'refute').map((row) => row.code);
function digPlan(target: string, asserted: boolean) {
  const contract = structuredClone(CONTRACT_DOC) as Record<string, any>;
  contract.effects.effect_1.allowed_programs = [{ program: 'dig', address_prefix: '@' }];
  const data = goodData();
  data.steps[1] = { ...data.steps[1], args: [`dig @${target} example.test`] };
  if (asserted) data.expects.push({ text: '健康检查间隔设置成功', quote: { ...QUOTE }, after: 2 });
  return subjectOf(data, { contractDoc: signTypedRuntime(contract) });
}

test('a listed host reaches an address on one of its own segments only', () => {
  const [bed] = bedsOf();
  assert.equal(hostReaches(bed, 'client0', '192.0.2.74'), true);
  assert.equal(hostReaches(bed, 'client0', '192.0.2.80'), true);
  assert.equal(hostReaches(bed, 'client0', '192.0.2.10'), false);
  assert.equal(hostReaches(bed, 'client0', '2001:db8:1::10'), false);
  assert.equal(hostReaches(bed, 'nobody', '192.0.2.74'), null);
  assert.deepEqual(interfacesOf(bed, 'client0'), ['192.0.2.80/26']);
});

test('an asserted query sent from a host off the target segment is refused, naming the host and its interfaces', () => {
  assert.deepEqual(codes(checkAddresses(digPlan('192.0.2.74', true))), []);
  const off = checkAddresses(digPlan('192.0.2.10', true));
  assert.deepEqual(codes(off), ['case-compile.driver_no_path']);
  const row = off.find((o) => o.verdict === 'refute') as { statement: string; grounds?: unknown };
  assert.match(row.statement, /widget-host\.shell 在清单设备 client0 上执行，它的接口（192\.0\.2\.80\/26）都不在 192\.0\.2\.10 所在网段/);
  assert.match(row.statement, /清单里没有这样的主机/);
  // A query nobody reads is not judged here, as in the reference engine.
  assert.deepEqual(codes(checkAddresses(digPlan('192.0.2.10', false))), []);
});

test('an assertion whose text is part of the command it reads is refused; one taken from the output is not', () => {
  const echoed = goodData();
  echoed.expects = [{ text: 'interval 60', quote: { ...QUOTE, text: '健康检查 widget health interval 60 设置成功' }, after: 1 }];
  assert.deepEqual(codes(checkExpectedSources(subjectOf(echoed))), ['case-compile.assertion_in_command']);
  const statement = (checkExpectedSources(subjectOf(echoed)).find((o) => o.verdict === 'refute') as { statement: string }).statement;
  assert.match(statement, /断言文字“interval 60”就在它读取的第 1 步命令里/);
  assert.deepEqual(codes(checkExpectedSources(subjectOf(goodData()))), []);
});

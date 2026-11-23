import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkAddresses, checkExpectedSources } from './checks.ts';
import { hostReaches, interfacesOf } from './bed.ts';
import { bedsOf, CONTRACT_DOC, goodData, QUOTE, subjectOf } from './test-support.ts';
import { signTypedRuntime } from '../testing/typed-fixtures.ts';

const codes = (outcomes: Array<{ verdict: string; code?: string }>) => outcomes.filter((row) => row.verdict === 'refute').map((row) => row.code);
function queryPlan(target: string, asserted: boolean) {
  const contract = structuredClone(CONTRACT_DOC) as Record<string, any>;
  contract.effects.effect_1.allowed_programs = [{ program: 'probe', address_prefix: '@' }];
  const data = goodData();
  data.steps[1] = { ...data.steps[1], args: [`probe @${target} example.test`] };
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
  assert.deepEqual(codes(checkAddresses(queryPlan('192.0.2.74', true))), []);
  const off = checkAddresses(queryPlan('192.0.2.10', true));
  assert.deepEqual(codes(off), ['case-compile.driver_no_path']);
  const row = off.find((o) => o.verdict === 'refute') as { statement: string; grounds?: unknown };
  assert.match(row.statement, /widget-host\.shell 在清单设备 client0 上执行，它的接口（192\.0\.2\.80\/26）都不在 192\.0\.2\.10 所在网段/);
  assert.match(row.statement, /清单里没有这样的主机/);
  assert.deepEqual(codes(checkAddresses(queryPlan('192.0.2.10', false))), []);
});

test('an assertion whose text is part of the command it reads is refused; one taken from the output is not', () => {
  const echoed = goodData();
  echoed.expects = [{ text: 'interval 60', quote: { ...QUOTE, text: '健康检查 widget health interval 60 设置成功' }, after: 1 }];
  assert.deepEqual(codes(checkExpectedSources(subjectOf(echoed))), ['case-compile.assertion_in_command']);
  const statement = (checkExpectedSources(subjectOf(echoed)).find((o) => o.verdict === 'refute') as { statement: string }).statement;
  assert.match(statement, /断言文字“interval 60”就在它读取的第 1 步命令里/);
  assert.deepEqual(codes(checkExpectedSources(subjectOf(goodData()))), []);
});

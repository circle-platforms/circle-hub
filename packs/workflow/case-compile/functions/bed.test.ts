// Bed facts and the address check: every literal address resolves to a device interface address or an allocated one;
// a blind address (a DUT interface on a segment without a trigger device) is never a listen or virtual address; a
// backend is a server address; off-bed addresses are refused. Addresses stay inside 192.0.2.0/24 and 2001:db8::/32.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkAddresses } from './checks.ts';
import { bedFacts, isBackend, isBlind, listenerOf, readAddress } from './bed.ts';
import { bedsOf, goodData, subjectOf } from './test-support.ts';

const MARK = '（按合成合约核对；不证明在真实设备上跑得通）';

function withSteps(steps: Array<{ object: string; method: string; params: Record<string, unknown> }>): ReturnType<typeof goodData> {
  const data = goodData();
  data.steps = steps;
  return data;
}

describe('台架事实', () => {
  it('监听候选、盲地址、后端候选照清单算出', () => {
    const facts = bedFacts(bedsOf()[0]);
    assert.deepEqual(
      facts.listeners.map((f) => f.address),
      ['192.0.2.10', '192.0.2.74', '2001:db8:1::10'],
    );
    assert.deepEqual(
      facts.blind.map((f) => f.address),
      ['192.0.2.130'],
      'dut1 的网段上没有触发设备',
    );
    assert.equal(listenerOf(facts, '192.0.2.10')?.triggers[0].device, 'router0');
    assert.equal(isBackend(facts, '192.0.2.90'), true);
    assert.equal(facts.backends.length, 1, '服务地址顶替裸接口，只出现一次');
    assert.equal(facts.backends[0].service, 'server0:80/tcp');
    assert.equal(isBlind(facts, '192.0.2.130'), true);
    assert.equal(isBlind(facts, '192.0.2.10'), false);
  });

  it('地址判读：接口地址、分配到的地址（血缘租约）、台架之外', () => {
    const bed = bedsOf()[0];
    const now = '2026-10-23T02:00:00.000Z';
    const leases = [
      { key: 'bed/bed-a/ip/192.0.2.20', until: '2026-10-23T10:00:00.000Z', mine: true },
      { key: 'bed/bed-a/ip/192.0.2.21', until: '2026-10-22T10:00:00.000Z', mine: true },
      { key: 'bed/bed-a/ip/192.0.2.22', until: '2026-10-23T10:00:00.000Z' },
    ];
    assert.deepEqual(readAddress(bed, leases, now, '192.0.2.10'), { kind: 'interface', device: 'dut0', type: 'load-balancer', subnet: '192.0.2.0/26' });
    assert.deepEqual(readAddress(bed, leases, now, '192.0.2.20'), { kind: 'allocated' }, '血缘里的未过期租约是分配到的地址');
    assert.deepEqual(readAddress(bed, leases, now, '192.0.2.21'), { kind: 'off_bed' }, '过期的租约不算');
    assert.deepEqual(readAddress(bed, leases, now, '192.0.2.22'), { kind: 'off_bed' }, '别人持有的租约不算');
    assert.deepEqual(readAddress(bed, leases, now, '192.0.2.200'), { kind: 'off_bed' }, '网段之外一律拒绝');
  });
});

describe('bed_addresses 检查', () => {
  it('正例：监听、虚拟（租约）、目标、后端都对得上', () => {
    const leases = [{ key: 'bed/bed-a/ip/192.0.2.20', until: '2026-10-23T10:00:00.000Z', mine: true }];
    const data = withSteps([
      { object: 'dut', method: 'listen', params: { address: '192.0.2.10', port: 8080 } },
      { object: 'dut', method: 'listen6', params: { address: '2001:db8:1::10' } },
      { object: 'dut', method: 'vip', params: { address: '192.0.2.20' } },
      { object: 'client', method: 'request', params: { target: '192.0.2.90', count: 1 } },
      { object: 'server', method: 'respond', params: { backend: '192.0.2.90', status: 200 } },
    ]);
    const [outcome] = checkAddresses(subjectOf(data, { leases }));
    assert.equal(outcome.verdict, 'support');
    assert.match(outcome.statement, /5 个字面地址都对得上台架 bed-a/);
    assert.ok(outcome.statement.endsWith(MARK), outcome.statement);
  });

  it('反例：台架之外的地址一律拒绝', () => {
    const data = withSteps([{ object: 'client', method: 'request', params: { target: '192.0.2.200', count: 1 } }]);
    const [outcome] = checkAddresses(subjectOf(data));
    assert.deepEqual([outcome.verdict, outcome.code], ['refute', 'case-compile.address_off_bed']);
    assert.match(outcome.statement, /192\.0\.2\.200/);
  });

  it('反例：盲地址不能当监听（网段上没有触发设备）', () => {
    const data = withSteps([{ object: 'dut', method: 'listen', params: { address: '192.0.2.130', port: 8080 } }]);
    const [outcome] = checkAddresses(subjectOf(data));
    assert.deepEqual([outcome.verdict, outcome.code], ['refute', 'case-compile.listen_blind']);
    assert.match(outcome.statement, /没有触发设备/);
  });

  it('反例：监听地址不是被测设备的接口', () => {
    const data = withSteps([{ object: 'dut', method: 'listen', params: { address: '192.0.2.80', port: 8080 } }]);
    const [outcome] = checkAddresses(subjectOf(data));
    assert.deepEqual([outcome.verdict, outcome.code], ['refute', 'case-compile.listen_not_dut']);
  });

  it('反例：后端地址不是服务器设备的地址', () => {
    const data = withSteps([{ object: 'server', method: 'respond', params: { backend: '192.0.2.80', status: 200 } }]);
    const [outcome] = checkAddresses(subjectOf(data));
    assert.deepEqual([outcome.verdict, outcome.code], ['refute', 'case-compile.backend_not_server']);
    assert.match(outcome.statement, /192\.0\.2\.80/);
  });

  it('反例：盲地址不能当虚拟地址', () => {
    const data = withSteps([{ object: 'dut', method: 'vip', params: { address: '192.0.2.130' } }]);
    const [outcome] = checkAddresses(subjectOf(data));
    assert.deepEqual([outcome.verdict, outcome.code], ['refute', 'case-compile.address_blind']);
  });

  it('反例：桶不是清单里的台架名', () => {
    const data = goodData();
    data.bucket = 'bed-z';
    const [outcome] = checkAddresses(subjectOf(data));
    assert.deepEqual([outcome.verdict, outcome.code], ['refute', 'case-compile.bed_unknown']);
    assert.match(outcome.statement, /bed-a/);
    assert.ok(outcome.statement.endsWith(MARK));
  });
});

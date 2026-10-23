// Bed facts and the address check: every literal address resolves to a device interface address or an allocated one;
// a blind address (a DUT interface on a segment without a trigger device) is never a listen or virtual address; a
// backend is a server address; off-bed addresses are refused. Addresses stay inside 192.0.2.0/24 and 2001:db8::/32.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkAddresses } from './checks.ts';
import { bedFacts, isBackend, isBlind, listenerOf, readAddress } from './bed.ts';
import { addressKey, parseManifest } from './manifest.ts';
import { bedsOf, goodData, subjectOf } from './test-support.ts';

const MARK = '（按合成合约核对；不证明在真实设备上跑得通）';

function withSteps(steps: ReturnType<typeof goodData>['steps']): ReturnType<typeof goodData> {
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
    assert.deepEqual(
      facts.backends.map((f) => f.service),
      ['client0:9000/tcp', 'server0:80/tcp'],
      '后端候选照服务条目（bedFacts 本身不动，和 test-bed 的漂移对照保持）',
    );
    assert.equal(isBlind(facts, '192.0.2.130'), true);
    assert.equal(isBlind(facts, '192.0.2.10'), false);
  });

  it('地址判读按数值：记法不同是同一个地址', () => {
    const bed = bedsOf()[0];
    const now = '2026-10-23T02:00:00.000Z';
    const leases = [{ key: 'bed/bed-a/ip/2001:db8:2::20', until: '2026-10-23T10:00:00.000Z', mine: true }];
    assert.equal(addressKey('2001:DB8::10'), addressKey('2001:db8:0:0::10'), '2001:DB8::10 和 2001:db8:0:0::10 是同一个地址');
    assert.deepEqual(readAddress(bed, leases, now, '192.0.2.10'), { kind: 'interface', device: 'dut0', type: 'load-balancer', subnet: '192.0.2.0/26' });
    assert.deepEqual(readAddress(bed, leases, now, '2001:DB8:1::10'), { kind: 'interface', device: 'dut0', type: 'load-balancer', subnet: '2001:db8:1:0:0:0:0:0/64' }, '全大写和小写是同一个接口');
    assert.deepEqual(readAddress(bed, leases, now, '2001:db8:1:0:0:0:0:10'), { kind: 'interface', device: 'dut0', type: 'load-balancer', subnet: '2001:db8:1:0:0:0:0:0/64' }, '全形式和压缩形式是同一个接口');
    assert.deepEqual(readAddress(bed, leases, now, '2001:db8:0:0::10'), { kind: 'off_bed' }, '组数不同是另一个地址');
    assert.deepEqual(readAddress(bed, leases, now, '2001:DB8:2::20'), { kind: 'allocated' }, '租约键的地址部分也按数值比对');
    assert.deepEqual(readAddress(bed, leases, now, '2001:db8:2::21'), { kind: 'off_bed' });
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


describe('literal address verification for runtime plans', () => {
  for (const address of ['192.0.2.10', '192.0.2.74', '192.0.2.90']) it(`own interface or server address is allowed: ${address}`, () => {
    const data = goodData(); data.steps[0].args = [`widget address ${address}`];
    assert.equal(checkAddresses(subjectOf(data))[0].verdict, 'support');
  });
  for (const address of ['192.0.2.1', '192.0.2.80', '192.0.2.130']) it(`other bed interfaces are allowed by decision 35: ${address}`, () => {
    const data = goodData(); data.steps[0].args = [`widget address ${address}`];
    assert.equal(checkAddresses(subjectOf(data))[0].verdict, 'support');
  });
  it('off-bed addresses and unowned leases cannot be used', () => {
    const data = goodData(); data.steps[0].args = ['widget address 192.0.2.200'];
    assert.equal(checkAddresses(subjectOf(data))[0].code, 'case-compile.address_off_bed');
    data.steps[0].args = ['widget address 192.0.2.20'];
    const row = { key: 'bed/bed-a/ip/192.0.2.20', until: '2026-10-23T10:00:00.000Z', mine: true };
    assert.equal(checkAddresses(subjectOf(data, { leases: [row] }))[0].verdict, 'support');
    assert.equal(checkAddresses(subjectOf(data, { leases: [{ ...row, mine: false }] }))[0].code, 'case-compile.address_off_bed');
  });
  it('replacement targets are on bed and the mapping is one-to-one', () => {
    const data = goodData(); data.replacements = [{ case: '192.0.2.200', bed: '192.0.2.90' }, { case: '192.0.2.201', bed: '192.0.2.90' }];
    assert.equal(checkAddresses(subjectOf(data))[0].code, 'case-compile.replacement_invalid');
    data.replacements = [{ case: '192.0.2.200', bed: '192.0.2.250' }]; data.expects[0].quote.text = '原文 192.0.2.200 健康检查间隔设置成功';
    assert.equal(checkAddresses(subjectOf(data))[0].code, 'case-compile.address_off_bed');
  });
  it('a declared replacement must already be applied to plan text', () => {
    const data = goodData(); data.replacements = [{ case: '192.0.2.10', bed: '192.0.2.90' }]; data.expects[0].quote.text = '原地址 192.0.2.10 健康检查间隔设置成功'; data.steps[0].args = ['widget address 192.0.2.10'];
    assert.equal(checkAddresses(subjectOf(data))[0].code, 'case-compile.replacement_missing');
  });
  it('an unknown bed is refused', () => { const data = goodData(); data.bucket = 'absent'; assert.equal(checkAddresses(subjectOf(data))[0].code, 'case-compile.bed_unknown'); });
});

it('literal addresses in invalid extra arguments are still examined', () => {
  const data = goodData(); data.steps[0].args.push('192.0.2.250', '192.0.2.251');
  assert.ok(checkAddresses(subjectOf(data)).some((v) => v.code === 'case-compile.address_off_bed'));
});

it('lineage addresses held without expiry remain allocated while another user cannot use them',()=>{
  const bed=bedsOf()[0];const now='2036-10-24T08:00:00.000Z';
  const lease={key:`bed/${bed.name}/ip/192.0.2.20`,until:null,mine:true};
  assert.deepEqual(readAddress(bed,[lease],now,'192.0.2.20'),{kind:'allocated'});
  assert.deepEqual(readAddress(bed,[{...lease,mine:false}],now,'192.0.2.20'),{kind:'off_bed'});
});

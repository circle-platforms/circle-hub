import {addressInput} from '../testing/typed-fixtures.ts';
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


describe('declared address positions in runtime-contract@2', () => {
 for(const address of ['192.0.2.10','192.0.2.74','192.0.2.90','192.0.2.1','192.0.2.80'])it('allows frozen bed interface '+address,()=>assert.equal(checkAddresses(addressInput(address))[0].verdict,'support'));
 it('refuses a blind-segment address before the volume runs',()=>{
  const out=checkAddresses(addressInput('192.0.2.130'));
  assert.equal(out[0]?.code,'case-compile.environment_unreachable');
  assert.match(out[0]?.statement ?? '', /环境不可达，整卷不跑/);
  assert.match(out[0]?.statement ?? '', /下一步/);
 });
 it('off-bed addresses need a live lease owned by this lineage',()=>{
  assert.equal(checkAddresses(addressInput('192.0.2.200'))[0].code,'case-compile.address_off_bed');
  const lease={key:'bed/bed-a/ip/192.0.2.20',until:'2026-10-23T10:00:00.000Z',mine:true};
  assert.equal(checkAddresses(addressInput('192.0.2.20',{leases:[lease]}))[0].verdict,'support');
  assert.equal(checkAddresses(addressInput('192.0.2.20',{leases:[{...lease,mine:false}]}))[0].code,'case-compile.address_off_bed');
 });
 it('replacements must be bijective and targets must belong to the bed',()=>{
  const duplicate=addressInput('192.0.2.90',{source:'192.0.2.200',replacements:[{case:'192.0.2.200',bed:'192.0.2.90'},{case:'192.0.2.200',bed:'192.0.2.90'}]});assert.ok(checkAddresses(duplicate).some(v=>v.code==='case-compile.replacement_invalid'));
  assert.ok(checkAddresses(addressInput('192.0.2.250',{source:'192.0.2.200',replacements:[{case:'192.0.2.200',bed:'192.0.2.250'}]})).some(v=>v.code==='case-compile.address_off_bed'));
 });
 it('an unchanged declared source is not treated as its replacement',()=>assert.ok(checkAddresses(addressInput('192.0.2.10',{replacements:[{case:'192.0.2.10',bed:'192.0.2.90'}]})).some(v=>v.code==='case-compile.replacement_missing')));
 it('an unknown bed is refused',()=>{const input=addressInput('192.0.2.10');(input.subject.data as ReturnType<typeof goodData>).bucket='absent';assert.equal(checkAddresses(input)[0].code,'case-compile.bed_unknown');});
});
it('extra undeclared arguments are shape violations, never inferred address positions',()=>{const data=goodData();data.steps[0].args.push('192.0.2.250');const out=checkAddresses(subjectOf(data));assert.ok(out.some(v=>v.code==='case-compile.method_forbidden'));assert.ok(!out.some(v=>v.code==='case-compile.address_off_bed'));});

it('lineage addresses held without expiry remain allocated while another user cannot use them',()=>{
  const bed=bedsOf()[0];const now='2036-10-24T08:00:00.000Z';
  const lease={key:`bed/${bed.name}/ip/192.0.2.20`,until:null,mine:true};
  assert.deepEqual(readAddress(bed,[lease],now,'192.0.2.20'),{kind:'allocated'});
  assert.deepEqual(readAddress(bed,[{...lease,mine:false}],now,'192.0.2.20'),{kind:'off_bed'});
});

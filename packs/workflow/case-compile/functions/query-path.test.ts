// Where a query starts and where it goes (decisions 115 and later): an address on a segment no trigger device reaches is
// refused only for a device under test and for a leased address; a query an assertion reads is sent from a host that shares a
// segment with its target; and the refusal says which hosts do. Synthetic bed: a client on 192.0.2.64/26 beside dut0's .74.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkAddresses } from './checks.ts';
import { CONTRACT_DOC, MANIFEST_DOC, PROFILE_DOC, QUOTE, goodData, subjectOf } from './test-support.ts';
import { signTypedRuntime } from '../testing/typed-fixtures.ts';

type Options = { after?: number; device?: string; manifest?: unknown; trigger_types?: string[]; leases?: Array<{ key: string; until: string | null; mine?: boolean }> };
/** The second step is a dig; the expectation reads step `after` (2 by default). `device` is the host device behind widget-host.shell. */
function queryInput(line: string, options: Options = {}) {
  const contract = structuredClone(CONTRACT_DOC) as Record<string, any>; contract.effects.effect_1.allowed_programs = [{ program: 'dig', address_prefix: '@' }];
  const profile = structuredClone(PROFILE_DOC) as any; profile.hosts = [{ object: 'widget-host', method: 'shell', device: options.device ?? 'client0' }];
  if (options.trigger_types) profile.trigger_types = options.trigger_types;
  const data = goodData(); data.steps[1] = { ...data.steps[1], args: [line] }; data.expects = [{ text: '健康检查间隔设置成功', quote: { ...QUOTE }, after: options.after ?? 2 }];
  return subjectOf(data, { contractDoc: signTypedRuntime(contract), profileDoc: profile, ...(options.manifest ? { manifestDoc: options.manifest } : {}), ...(options.leases ? { leases: options.leases as never } : {}) });
}
/** dut1 (192.0.2.130/26) shares its segment with a server only: no router, no client. */
function serverOnlySegment() {
  const doc = structuredClone(MANIFEST_DOC); const devices = doc.beds[0].devices.filter((device) => device.name !== 'console0');
  devices.push({ name: 'server1', type: 'server', product: null, ipv4: ['192.0.2.190/26'], ipv6: [] });
  doc.beds[0].devices = devices; return doc;
}
const kinds = (rows: Array<{ verdict: string; code?: string }>) => rows.map((row) => row.verdict + (row.code ? ':' + row.code.split('.').pop() : ''));

test('a query sent from a host on the target segment passes', () => {
  assert.deepEqual(kinds(checkAddresses(queryInput('dig @192.0.2.74 example.test'))), ['support']);
});

test('a query from a host that shares no segment with its target is refused with the hosts that do and the pairing table', () => {
  const rows = checkAddresses(queryInput('dig @192.0.2.10 example.test'));
  assert.deepEqual(kinds(rows), ['refute:environment_unreachable']); const text = rows[0].statement;
  assert.match(text, /发起机与目标不同网段，整卷不跑/); assert.match(text, /第 2 步在 widget-host\.shell（设备 client0，网段 192\.0\.2\.64\/26）上查询 192\.0\.2\.10，第 2 步的断言读这条查询的回显/);
  assert.match(text, /清单没有声明网段之间的路由，本规则只认同网段/); assert.match(text, /同网段的已开放主机：没有/);
  assert.match(text, /widget-host\.shell（设备 client0） → 192\.0\.2\.74；没有已开放的主机够得着：192\.0\.2\.10、2001:db8:1::10/);
});

test('only a query an assertion reads is judged', () => {
  assert.deepEqual(kinds(checkAddresses(queryInput('dig @192.0.2.10 example.test', { after: 1 }))), ['support']);
});

test('a device under test on a segment without a trigger device is refused, a server there is not', () => {
  const manifest = serverOnlySegment();
  const dut = checkAddresses(queryInput('dig @192.0.2.130 example.test', { manifest, after: 1 }));
  assert.deepEqual(kinds(dut), ['refute:environment_unreachable']);
  assert.match(dut[0].statement, /192\.0\.2\.130 是 dut1 的接口地址，所在网段 192\.0\.2\.128\/26 上没有 client、router 类型的设备（该网段上的其他设备类型：server；触发类型取包默认）/);
  assert.deepEqual(kinds(checkAddresses(queryInput('dig @192.0.2.190 example.test', { manifest, after: 1 }))), ['support'], 'a reply address on a server is on the bed and needs no trigger device');
});

test('a profile that adds server to the trigger types makes that segment reachable from a server host', () => {
  const manifest = serverOnlySegment();
  assert.deepEqual(kinds(checkAddresses(queryInput('dig @192.0.2.130 example.test', { manifest, device: 'server1', trigger_types: ['router', 'client', 'server'] }))), ['support']);
});

test('a leased address on a segment without a trigger device is refused', () => {
  const rows = checkAddresses(queryInput('dig @192.0.2.150 example.test', { after: 1, leases: [{ key: 'bed/bed-a/ip/192.0.2.150', until: '2026-10-23T10:00:00.000Z', mine: true }] }));
  assert.deepEqual(kinds(rows), ['refute:environment_unreachable']); assert.match(rows[0].statement, /192\.0\.2\.150 是本血缘租约的地址，落在没有 client、router 类型设备的网段/);
});

test('when no open host reaches any listener the plan cannot be mended: an unknown that names the fact and the exit', () => {
  const rows = checkAddresses(queryInput('dig @192.0.2.74 example.test', { trigger_types: [] }));
  assert.deepEqual(kinds(rows), ['unknown']); assert.match(rows[0].statement, /缺的事实：本配置没有任何已开放的主机与被测设备的监听地址同网段.*下一步：管理员在 runtime-profile 的 hosts 里开放触发设备的主机方法/);
});

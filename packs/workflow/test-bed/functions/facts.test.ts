// bedFacts: the environment facts of one bed from its normalized manifest — segments and their members, listener
// candidates (a load balancer's interface address on a segment that has at least one trigger device, with the
// pairing), blind addresses (no trigger device on the segment), backend candidates, and the free-address count of
// every segment. Synthetic data only (192.0.2.0/24 in /26 cuts, 2001:db8::/32).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseManifest, type ManifestBed } from './manifest.ts';
import { bedFacts } from './facts.ts';

const manifestOf = (beds: unknown): ManifestBed[] => {
  const parsed = parseManifest({ schema: 'test-bed-manifest@1', beds });
  assert.ok(parsed.ok, parsed.ok ? '' : JSON.stringify(parsed.ok ? undefined : parsed.problems));
  return parsed.ok ? parsed.beds : (undefined as never);
};

/** bed-a: afamx0 on two segments; router0 on the first, client0 on the second; server0 on a third with a service. */
const bedA = () =>
  manifestOf([
    {
      name: 'bed-a',
      devices: [
        { name: 'afamx0', type: 'load-balancer', product: 'famx', ipv4: ['192.0.2.10/26', '192.0.2.74/26'], ipv6: [] },
        { name: 'router0', type: 'router', ipv4: ['192.0.2.1/26'], ipv6: [] },
        { name: 'client0', type: 'client', ipv4: ['192.0.2.80/26'], ipv6: [] },
        { name: 'server0', type: 'server', ipv4: ['192.0.2.90/26'], ipv6: [] },
        { name: 'console0', type: 'console', ipv4: ['192.0.2.140/26'], ipv6: [] },
      ],
      services: [{ host: 'server0', ip: '192.0.2.90', proto: 'tcp', port: 80 }],
      reserved: ['192.0.2.1-192.0.2.9', '192.0.2.65-192.0.2.69'],
    },
  ])[0];

describe('bedFacts of bed-a', () => {
  it('lists every segment with its member devices (both families), sorted', () => {
    const facts = bedFacts(bedA());
    assert.deepEqual(
      facts.segments.map((s) => s.subnet),
      ['192.0.2.0/26', '192.0.2.64/26', '192.0.2.128/26'],
    );
    assert.deepEqual(
      facts.segments[0].members.map((m) => [m.device, m.address]),
      [
        ['afamx0', '192.0.2.10'],
        ['router0', '192.0.2.1'],
      ],
    );
  });
  it('listener candidates: the load balancer addresses on segments that have a trigger device, with the pairing', () => {
    const facts = bedFacts(bedA());
    assert.deepEqual(
      facts.listeners.map((l) => [l.device, l.address, l.subnet, l.triggers.map((t) => t.device).sort()]),
      [
        ['afamx0', '192.0.2.10', '192.0.2.0/26', ['router0']],
        ['afamx0', '192.0.2.74', '192.0.2.64/26', ['client0']],
      ],
    );
  });
  it('backend candidates: server interface addresses and service addresses, service entries carrying proto and port', () => {
    const facts = bedFacts(bedA());
    assert.deepEqual(
      facts.backends.map((b) => [b.device, b.address, b.service ?? null]),
      [['server0', '192.0.2.90', 'server0:80/tcp']],
    );
  });
  it('free addresses per segment: total minus network/broadcast (IPv4), device addresses and reserved ranges', () => {
    const facts = bedFacts(bedA());
    const bySubnet = new Map(facts.segments.map((s) => [s.subnet, s]));
    // .0/26: 62 usable (.0 network, .127 broadcast), 2 device addresses, reserved .1-.9 = 9 → 51
    assert.deepEqual([bySubnet.get('192.0.2.0/26')?.usable, bySubnet.get('192.0.2.0/26')?.free], [62, 51]);
    // .64/26: 62 usable, 3 device addresses (.74, .80, .90), reserved .65-.69 = 5 → 54
    assert.deepEqual([bySubnet.get('192.0.2.64/26')?.usable, bySubnet.get('192.0.2.64/26')?.free], [62, 54]);
    // .128/26: 62 usable, 1 device address, no reserved → 61
    assert.deepEqual([bySubnet.get('192.0.2.128/26')?.free], [61]);
  });
  it('a segment without a trigger device marks the load balancer addresses on it blind, never listeners', () => {
    const bed = manifestOf([
      {
        name: 'bed-b',
        devices: [
          { name: 'lb0', type: 'load-balancer', ipv4: ['192.0.2.130/26'], ipv6: [] },
          { name: 'srv0', type: 'server', ipv4: ['192.0.2.131/26'], ipv6: [] },
        ],
        services: [],
        reserved: [],
      },
    ])[0];
    const facts = bedFacts(bed);
    assert.deepEqual(facts.listeners, []);
    assert.deepEqual(
      facts.blind.map((b) => [b.device, b.address, b.subnet]),
      [['lb0', '192.0.2.130', '192.0.2.128/26']],
    );
  });
  it('a device without any address yields unknown reachability, not an empty fact (defence: import refuses such a device)', () => {
    // Import refuses a device with no interface address at all (manifest.ts), so this bed is built directly: bedFacts
    // stays total and keeps reporting unknown reachability should such a device ever reach it.
    const bed = {
      name: 'bed-c', family: 4 as const, segments: [], reserved: [], services: [],
      devices: [
        { name: 'lb0', type: 'load-balancer' as const, product: null, installed: null, ipv4: [], ipv6: [] },
        { name: 'cli0', type: 'client' as const, product: null, installed: null, ipv4: [{ family: 4 as const, address: '192.0.2.10', value: 0n, subnet: '192.0.2.0/26' }], ipv6: [] },
      ],
    };
    const facts = bedFacts(bed as unknown as Parameters<typeof bedFacts>[0]);
    assert.deepEqual(facts.unknowns, [{ device: 'lb0', reason: '设备没有任何接口地址，可达性未知' }]);
    assert.deepEqual(facts.listeners, []);
  });
  it('IPv6 segments are facts the same way', () => {
    const bed = manifestOf([
      {
        name: 'bed-d',
        devices: [
          { name: 'lb0', type: 'load-balancer', ipv4: [], ipv6: ['2001:db8:2::10/64'] },
          { name: 'cli0', type: 'client', ipv4: [], ipv6: ['2001:db8:2::20/64'] },
        ],
        services: [],
        reserved: [],
      },
    ])[0];
    const facts = bedFacts(bed);
    assert.deepEqual(
      facts.listeners.map((l) => [l.device, l.address, l.triggers.map((t) => t.device)]),
      [['lb0', '2001:db8:2::10', ['cli0']]],
    );
  });
  it('the answer is bounded: a bed of 100 devices answers with at most a few thousand lines', () => {
    const devices = Array.from({ length: 100 }, (_v, i) => ({ name: `d${i}`, type: i % 2 === 0 ? 'client' : 'server', ipv4: [`192.0.2.${10 + i}/26`], ipv6: [] }));
    const bed = manifestOf([{ name: 'bed-big', devices, services: [], reserved: [] }])[0];
    const facts = bedFacts(bed);
    const size = JSON.stringify(facts).length;
    assert.ok(size < 100_000, `${size} bytes`);
  });
});

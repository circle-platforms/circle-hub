// The address math of the bed functions: strict IPv4/IPv6 parsing and formatting written here (no dependency),
// subnet containment, bounded range iteration and nextFree. Sample addresses only: IPv4 192.0.2.0/24 (cut into
// /26 segments), IPv6 2001:db8::/32.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  expandRange,
  formatIp,
  formatSubnet,
  nextFree,
  parseIp,
  parseSubnet,
  subnetContains,
  subnetOf,
} from './addresses.ts';

describe('parseIp', () => {
  it('parses dotted-quad IPv4 exactly: four decimal octets 0-255, no leading zeros, no short forms', () => {
    assert.equal(parseIp('192.0.2.10'), 3221225994n);
    assert.equal(parseIp('0.0.0.0'), 0n);
    assert.equal(parseIp('255.255.255.255'), 4294967295n);
    for (const bad of ['192.0.2', '192.0.2.10.5', '192.0.2.256', '192.0.2.-1', '192.0.02.10', ' 192.0.2.10', '192.0.2.10 ', '192.0.2.a', '1920.2.1', '', '192.0.2.1_']) {
      assert.equal(parseIp(bad), null, bad);
    }
  });
  it('parses IPv6 with compression and embedded IPv4, strictly', () => {
    assert.equal(parseIp('2001:db8::1'), 0x20010db8000000000000000000000001n);
    assert.equal(parseIp('2001:0db8:0000:0000:0000:0000:0000:0001'), 0x20010db8000000000000000000000001n);
    // Upper-case hex letters parse (RFC 4291) and format back canonically lower-case.
    assert.equal(parseIp('2001:DB8::1'), 0x20010db8000000000000000000000001n);
    assert.equal(formatIp(6, parseIp('2001:DB8::1')!), '2001:db8::1');
    assert.equal(parseIp('::'), 0n);
    assert.equal(parseIp('::1'), 1n);
    assert.equal(parseIp('2001:db8::192.0.2.1'), 0x20010db80000000000000000c0000201n);
    for (const bad of ['2001:db8:::1', '2001:db8:', ':2001:db8::1', '2001:db8::1::', '2001:dg8::1', '1:2:3:4:5:6:7:8:9', '2001:db8::1/64', '']) {
      assert.equal(parseIp(bad), null, bad);
    }
  });
  it('IPv6 groups allow one leading zero run of any length within a group (0abc is one group), but not empty groups', () => {
    assert.equal(parseIp('2001:0db8::1') !== null, true);
    assert.equal(parseIp('2001::db8::1'), null);
  });
});

describe('parseSubnet', () => {
  it('parses address/prefix and rejects a bad prefix or address', () => {
    assert.deepEqual(parseSubnet('192.0.2.0/26'), { family: 4, address: 3221225984n, prefix: 26 });
    assert.deepEqual(parseSubnet('2001:db8:1::/64'), { family: 6, address: 0x20010db8000100000000000000000000n, prefix: 64 });
    for (const bad of ['192.0.2.0/33', '192.0.2.0/-1', '192.0.2.0/', '192.0.2.0', '192.0.2.1/26', '2001:db8::/129', '192.0.2.0/26/26']) {
      assert.equal(parseSubnet(bad), null, bad);
    }
  });
  it('a subnet address must have the host bits zero (192.0.2.3/26 is not a subnet address)', () => {
    assert.equal(parseSubnet('192.0.2.3/26'), null);
    assert.equal(parseSubnet('2001:db8:1::1/64'), null);
  });
});

describe('formatIp and formatSubnet', () => {
  it('formats back to the canonical text (IPv6 compressed per RFC 5952: longest zero run, lowercase)', () => {
    assert.equal(formatIp(4, 3221225994n), '192.0.2.10');
    assert.equal(formatIp(6, 0x20010db8000100000000000000000001n), '2001:db8:1::1');
    assert.equal(formatIp(6, 0n), '::');
    assert.equal(formatSubnet({ family: 4, address: 3221225984n, prefix: 26 }), '192.0.2.0/26');
  });
});

describe('subnetOf and subnetContains', () => {
  it('puts an address into a segment by mask and answers containment', () => {
    const segment = parseSubnet('192.0.2.64/26')!;
    const dot74 = parseIp('192.0.2.74')!;
    const dot10 = parseIp('192.0.2.10')!;
    const of74 = subnetOf(4, dot74, 26);
    assert.ok(of74 !== null);
    assert.equal(formatSubnet(of74), '192.0.2.64/26');
    assert.equal(subnetContains(segment, dot74), true);
    assert.equal(subnetContains(segment, dot10), false);
  });
});

describe('expandRange', () => {
  it('iterates a small IPv4 range in order and refuses to expand a huge one', () => {
    assert.deepEqual([...expandRange('192.0.2.1', '192.0.2.4', 16)], [3221225985n, 3221225986n, 3221225987n, 3221225988n]);
    assert.equal([...expandRange('192.0.2.1', '192.0.2.3000', 16)].length, 0);
    assert.equal([...expandRange('192.0.2.1', '192.0.2.70000', 16)].length, 0);
    assert.equal([...expandRange('192.0.2.4', '192.0.2.1', 16)].length, 0, 'start above end yields nothing');
    assert.equal([...expandRange('192.0.2.1', '192.0.2.200', 200)].length, 200);
    assert.equal([...expandRange('192.0.2.1', '192.0.2.200', 199)].length, 0, 'a range larger than the limit yields nothing');
  });
  it('families must match inside one range', () => {
    assert.equal([...expandRange('192.0.2.1', '2001:db8::2', 16)].length, 0);
  });
});

describe('nextFree', () => {
  it('takes the first count free addresses of a subnet, skipping network and broadcast (IPv4), taken and reserved', () => {
    const subnet = parseSubnet('192.0.2.64/26')!;
    const taken = new Set([3221226042n]); // 192.0.2.74
    const reserved = new Set([...expandRange('192.0.2.65', '192.0.2.69', 64)]);
    assert.deepEqual(
      nextFree(subnet, taken, reserved, 3).map((a) => formatIp(4, a)),
      ['192.0.2.70', '192.0.2.71', '192.0.2.72'],
    );
    // .64 is the network address and .127 the broadcast: never handed out.
    const almostFull = parseSubnet('192.0.2.64/26')!;
    const busy = new Set([...expandRange('192.0.2.65', '192.0.2.126', 64)]);
    assert.deepEqual(nextFree(almostFull, busy, new Set(), 2), []);
  });
  it('IPv6 has no network or broadcast to skip; deterministic order from the subnet base', () => {
    const subnet = parseSubnet('2001:db8:1::/64')!;
    const taken = new Set([0x20010db8000100000000000000000000n, 0x20010db8000100000000000000000001n]);
    const got = nextFree(subnet, taken, new Set(), 2);
    assert.deepEqual(got.map((a) => formatIp(6, a)), ['2001:db8:1::2', '2001:db8:1::3']);
  });
  it('asking for more than free yields only the free ones, in order, and count 0 yields none', () => {
    const subnet = parseSubnet('192.0.2.128/26')!;
    assert.deepEqual(nextFree(subnet, new Set(), new Set(), 0), []);
    const two = nextFree(subnet, new Set([...expandRange('192.0.2.130', '192.0.2.190', 64)]), new Set(), 5);
    assert.deepEqual(two.map((a) => formatIp(4, a)), ['192.0.2.129']);
  });
});

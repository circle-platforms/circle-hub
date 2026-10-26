// Strict IPv4/IPv6 address math, written here on purpose (a pack function may load only modules inside the pack,
// and address parsing is exactly the kind of rule that must not drift): parse and format, subnet containment,
// bounded range iteration and nextFree. No imports at run time; every function is total (bad input gives null or
// an empty result, never a throw).
//
// Parsing rules (deliberately strict):
// - IPv4: exactly four groups of decimal digits, each 0-255, no leading zeros ("02" is refused), nothing around.
// - IPv6: eight groups of one to four hexadecimal digits, lowercase or uppercase, one "::" compression at most,
//   an embedded IPv4 dotted quad in the last 32 bits, nothing around. Formatting follows RFC 5952: lowercase,
//   leftmost-longest zero run compressed to "::", at least one digit per group.
// - A subnet is address/prefix with all host bits zero; prefix 0-32 (IPv4) or 0-128 (IPv6).

export type Family = 4 | 6;

export interface Ip {
  family: Family;
  value: bigint;
}

export interface Subnet {
  family: Family;
  address: bigint;
  prefix: number;
}

const V4_MAX = 0xffffffffn;
const V6_MAX = 0xffffffffffffffffffffffffffffffffn;

const OCTET = /^(0|[1-9][0-9]{0,2})$/;

/** A parsed IPv4 dotted quad, or null. Four groups, decimal, 0-255, no leading zeros. */
export function parseIp(text: string): bigint | null {
  const v4 = parseIpv4(text);
  if (v4 !== null) return v4;
  return parseIpv6(text);
}

function parseIpv4(text: string): bigint | null {
  if (typeof text !== 'string' || text.length === 0 || text.length > 15) return null;
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    if (!OCTET.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = (value << 8n) | BigInt(octet);
  }
  return value;
}

const HEX = /^[0-9a-fA-F]{1,4}$/;

function parseIpv6(text: string): bigint | null {
  if (typeof text !== 'string' || text.length === 0 || text.length > 45) return null;
  const doubleColon = text.split('::');
  if (doubleColon.length > 2) return null;
  let head: string[];
  let tail: string[];
  if (doubleColon.length === 2) {
    head = doubleColon[0] === '' ? [] : doubleColon[0].split(':');
    const tailText = doubleColon[1];
    tail = tailText === '' ? [] : tailText.split(':');
  } else {
    head = text.split(':');
    tail = [];
    if (head.some((g) => g === '')) return null; // a lone empty group without :: is a mistake
  }
  // An embedded IPv4 quad may sit at the end of the tail.
  let v4Tail: bigint | null = null;
  if (tail.length > 0) {
    const last = tail[tail.length - 1];
    const quad = parseIpv4(last);
    if (quad !== null) {
      v4Tail = quad;
      tail = tail.slice(0, -1);
    }
  }
  const groups: bigint[] = [];
  for (const group of [...head, ...tail]) {
    if (!HEX.test(group)) return null;
    groups.push(BigInt(`0x${group.toLowerCase()}`));
  }
  const total = groups.length + (v4Tail !== null ? 2 : 0);
  const missing = 8 - total;
  if (doubleColon.length === 2) {
    if (missing < 1) return null; // :: must replace at least one group; eight groups written need no ::
    for (let i = 0; i < missing; i++) groups.splice(head.length + i, 0, 0n);
  } else if (total !== 8) {
    return null;
  }
  if (v4Tail !== null) {
    groups.push(v4Tail >> 16n);
    groups.push(v4Tail & 0xffffn);
  }
  let value = 0n;
  for (const group of groups) value = (value << 16n) | group;
  return value;
}

/** The canonical text of an address (RFC 5952 for IPv6: lowercase, longest leftmost zero run compressed). */
export function formatIp(family: Family, value: bigint): string {
  if (family === 4) {
    const bounded = value & V4_MAX;
    return [3n, 2n, 1n, 0n].map((shift) => String((bounded >> (shift * 8n)) & 0xffn)).join('.');
  }
  const groups: bigint[] = [];
  let rest = value & V6_MAX;
  for (let i = 0; i < 8; i++) {
    groups.unshift(rest & 0xffffn);
    rest >>= 16n;
  }
  // Longest run of zero groups, leftmost on ties; only a run of two or more compresses.
  let bestStart = -1;
  let bestLength = 0;
  let at = 0;
  while (at < 8) {
    if (groups[at] !== 0n) {
      at += 1;
      continue;
    }
    let end = at;
    while (end < 8 && groups[end] === 0n) end += 1;
    if (end - at > bestLength) {
      bestLength = end - at;
      bestStart = at;
    }
    at = end;
  }
  if (bestLength < 2) return groups.map((g) => g.toString(16)).join(':');
  const headText = groups.slice(0, bestStart).map((g) => g.toString(16)).join(':');
  const tailText = groups.slice(bestStart + bestLength).map((g) => g.toString(16)).join(':');
  return `${headText}::${tailText}`;
}

/** An address/prefix with host bits zero, or null. */
export function parseSubnet(text: string): Subnet | null {
  if (typeof text !== 'string' || text.length > 50) return null;
  const slash = text.lastIndexOf('/');
  if (slash <= 0) return null;
  const address = parseIp(text.slice(0, slash));
  if (address === null) return null;
  const family: Family = parseIpv4(text.slice(0, slash)) !== null ? 4 : 6;
  const prefixText = text.slice(slash + 1);
  if (!/^[0-9]{1,3}$/.test(prefixText)) return null;
  const prefix = Number(prefixText);
  if (prefix > (family === 4 ? 32 : 128)) return null;
  const hostBits = BigInt(family === 4 ? 32 : 128) - BigInt(prefix);
  if ((address & ((1n << hostBits) - 1n)) !== 0n) return null;
  return { family, address, prefix };
}

/** Whether the text parses as an IPv4 address (the family probe of manifest parsing). */
export function parseIpv4ish(text: string): boolean {
  return parseIpv4(text) !== null;
}

/**
 * An interface address of a device: "address/prefix" where the prefix names the segment and the address is the
 * device's own (host bits set, unlike a subnet address). Returns the address and its segment.
 */
export function parseInterface(text: string): { family: Family; address: bigint; subnet: Subnet } | null {
  if (typeof text !== 'string' || text.length > 50) return null;
  const slash = text.lastIndexOf('/');
  if (slash <= 0) return null;
  const address = parseIp(text.slice(0, slash));
  if (address === null) return null;
  const family: Family = parseIpv4(text.slice(0, slash)) !== null ? 4 : 6;
  const prefixText = text.slice(slash + 1);
  if (!/^[0-9]{1,3}$/.test(prefixText)) return null;
  const prefix = Number(prefixText);
  if (prefix > (family === 4 ? 32 : 128)) return null;
  const segment = subnetOf(family, address, prefix);
  if (segment === null) return null;
  return { family, address, subnet: segment };
}

export function formatSubnet(subnet: Subnet): string {
  return `${formatIp(subnet.family, subnet.address)}/${subnet.prefix}`;
}

/** The subnet of a prefix length an address falls into. */
export function subnetOf(family: Family, value: bigint, prefix: number): Subnet | null {
  if (prefix < 0 || prefix > (family === 4 ? 32 : 128)) return null;
  const bits = BigInt(family === 4 ? 32 : 128);
  const hostBits = bits - BigInt(prefix);
  return { family, address: (value >> hostBits) << hostBits, prefix };
}

/** Whether a subnet contains an address of the same family. */
export function subnetContains(subnet: Subnet, value: bigint): boolean {
  if (subnet.family === 4 && value > V4_MAX) return false;
  if (subnet.family === 6 && value > V6_MAX) return false;
  const bits = BigInt(subnet.family === 4 ? 32 : 128);
  const hostBits = bits - BigInt(subnet.prefix);
  return (subnet.address >> hostBits) === (value >> hostBits);
}

/**
 * The addresses of "start-end" in order, at most `limit` of them; an empty iteration when the range is empty,
 * malformed, mixed-family or larger than the limit (a /16 or an IPv6 /64 is never expanded).
 */
export function* expandRange(start: string, end: string, limit: number): Generator<bigint> {
  const family: Family = parseIpv4(start) !== null ? 4 : 6;
  const from = parseIp(start);
  const to = parseIp(end);
  if (from === null || to === null) return;
  if ((parseIpv4(start) !== null) !== (parseIpv4(end) !== null)) return;
  if (from > to || to - from >= BigInt(limit)) return;
  for (let at = from; at <= to; at++) {
    if (family === 4 && at > V4_MAX) return;
    yield at;
  }
}

/** The network address of an IPv4 subnet (all host bits zero); IPv6 subnets have none skipped. */
function networkAddress(subnet: Subnet): bigint {
  return subnet.address;
}

/** The broadcast address (all host bits one) of an IPv4 subnet; null for IPv6. */
function broadcastAddress(subnet: Subnet): bigint | null {
  if (subnet.family !== 4) return null;
  const hostBits = 32n - BigInt(subnet.prefix);
  return subnet.address | ((1n << hostBits) - 1n);
}

/** The first `count` addresses of the subnet that are free: not taken, not reserved, not the network or broadcast address. */
export function nextFree(subnet: Subnet, taken: ReadonlySet<bigint>, reserved: ReadonlySet<bigint>, count: number): bigint[] {
  if (!Number.isInteger(count) || count <= 0) return [];
  const bits = BigInt(subnet.family === 4 ? 32 : 128);
  const hostBits = bits - BigInt(subnet.prefix);
  const size = 1n << hostBits;
  // A subnet larger than 2^16 candidates is walked only up to a bound; the manifest's subnets are small.
  const bound = size > 65536n ? 65536n : size;
  const broadcast = broadcastAddress(subnet);
  const network = networkAddress(subnet);
  const out: bigint[] = [];
  for (let offset = 0n; offset < bound && out.length < count; offset++) {
    const candidate = subnet.address + offset;
    if (candidate === network && subnet.family === 4) continue;
    if (broadcast !== null && candidate === broadcast) continue;
    if (taken.has(candidate) || reserved.has(candidate)) continue;
    out.push(candidate);
  }
  return out;
}

/** The allocatable address count of a subnet: all of them for IPv6, minus network and broadcast for IPv4. */
export function segmentUsable(family: Family, subnetText: string): number {
  const subnet = parseSubnet(subnetText);
  if (subnet === null || subnet.family !== family) return 0;
  const size = 1n << BigInt((family === 4 ? 32 : 128) - subnet.prefix);
  if (size > 65536n) return 65536; // bounded: a bigger segment reports its bound, not its true size
  const skipped = family === 4 ? 2 : 0;
  return Number(size) - skipped;
}

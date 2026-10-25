// bedFacts: the environment facts of one bed, computed from its normalized manifest (parseManifest's output).
// Deterministic and bounded: the facts of a bed never exceed a few thousand lines. Unknowns are written as
// unknowns (a device without any address), never defaulted to reachable.
import { parseSubnet, segmentUsable, subnetContains } from './addresses.ts';
import { isRecord } from './common.ts';
import type { InterfaceAddress, ManifestBed } from './manifest.ts';
import { judgeBedSurface } from './surface.ts';

/** One device on a segment, with the interface address it holds there. */
export interface SegmentMember {
  device: string;
  type: string;
  address: string;
}

/** A segment of the bed (from the interface addresses' prefixes) and its members. */
export interface SegmentFact {
  subnet: string;
  family: 4 | 6;
  members: SegmentMember[];
  /** Usable addresses of the segment (IPv4: without network and broadcast). */
  usable: number;
  /** Usable minus the members' addresses and the reserved ranges of the bed in this segment. */
  free: number;
}

/** A listener candidate: a load balancer's interface address on a segment that has at least one trigger device. */
export interface ListenerFact {
  device: string;
  address: string;
  subnet: string;
  /** The trigger devices (router, client) on the same segment, paired with their addresses. */
  triggers: Array<{ device: string; address: string }>;
}

/** A blind address: a load balancer's interface address on a segment without any trigger device. */
export interface BlindFact {
  device: string;
  address: string;
  subnet: string;
}

/** A backend candidate: a server device's interface address, or a service address. */
export interface BackendFact {
  device: string;
  address: string;
  /** The service as "host:port/proto" when this entry comes from services; null for a plain interface address. */
  service: string | null;
}

export interface UnknownFact {
  device: string;
  reason: string;
}

export interface BedFacts {
  bed: string;
  segments: SegmentFact[];
  listeners: ListenerFact[];
  blind: BlindFact[];
  backends: BackendFact[];
  unknowns: UnknownFact[];
}

/** The device types that can send requests on a segment (a listener needs one of them next to it). */
const TRIGGER_TYPES = new Set(['router', 'client']);

/** Segments order by network address (numeric), then prefix; families apart (IPv4 before IPv6). */
function compareSubnets(a: string, b: string): number {
  const sa = parseSubnet(a);
  const sb = parseSubnet(b);
  if (sa === null || sb === null) return a < b ? -1 : a > b ? 1 : 0;
  if (sa.family !== sb.family) return sa.family - sb.family;
  if (sa.address !== sb.address) return sa.address < sb.address ? -1 : 1;
  return sa.prefix - sb.prefix;
}

/** The environment facts of one bed. */
export function bedFacts(bed: ManifestBed): BedFacts {
  const segments = new Map<string, { family: 4 | 6; members: SegmentMember[] }>();
  const addMember = (device: string, type: string, iface: InterfaceAddress): void => {
    const held = segments.get(iface.subnet) ?? { family: iface.family, members: [] };
    held.members.push({ device, type, address: iface.address });
    segments.set(iface.subnet, held);
  };
  for (const device of bed.devices) {
    for (const iface of [...device.ipv4, ...device.ipv6]) addMember(device.name, device.type, iface);
  }
  const reservedIn = new Map<string, number>();
  for (const range of bed.reserved) {
    for (const address of range.addresses) {
      for (const [subnet, held] of segments) {
        // The manifest guarantees every reserved range lies in one segment; count it there once.
        if (held.members.some((m) => m.address.length > 0) && sameSegment(subnet, held.family, address)) {
          reservedIn.set(subnet, (reservedIn.get(subnet) ?? 0) + 1);
          break;
        }
      }
    }
  }
  const listeners: ListenerFact[] = [];
  const blind: BlindFact[] = [];
  const backends: BackendFact[] = [];
  const unknowns: UnknownFact[] = [];
  for (const device of bed.devices) {
    const addresses = [...device.ipv4, ...device.ipv6];
    if (addresses.length === 0) {
      unknowns.push({ device: device.name, reason: '设备没有任何接口地址，可达性未知' });
      continue;
    }
    if (device.type === 'load-balancer') {
      for (const iface of addresses) {
        const held = segments.get(iface.subnet);
        const triggers = (held?.members ?? []).filter((m) => TRIGGER_TYPES.has(m.type) && m.device !== device.name);
        if (triggers.length > 0) {
          listeners.push({ device: device.name, address: iface.address, subnet: iface.subnet, triggers: triggers.map((t) => ({ device: t.device, address: t.address })) });
        } else {
          blind.push({ device: device.name, address: iface.address, subnet: iface.subnet });
        }
      }
    }
    if (device.type === 'server') {
      for (const iface of addresses) backends.push({ device: device.name, address: iface.address, service: null });
    }
  }
  // A service address that is also a server's interface address appears once, as the service entry.
  for (const service of bed.services) {
    const at = backends.findIndex((b) => b.device === service.host && b.address === service.ip);
    if (at >= 0) backends[at] = { device: service.host, address: service.ip, service: `${service.host}:${service.port}/${service.proto}` };
    else backends.push({ device: service.host, address: service.ip, service: `${service.host}:${service.port}/${service.proto}` });
  }
  const segmentFacts: SegmentFact[] = [...segments.entries()]
    .map(([subnet, held]) => {
      const usable = segmentUsable(held.family, subnet);
      const free = usable - held.members.length - (reservedIn.get(subnet) ?? 0);
      return { subnet, family: held.family, members: held.members, usable, free };
    })
    .sort((a, b) => compareSubnets(a.subnet, b.subnet));
  const sortText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  return {
    bed: bed.name,
    segments: segmentFacts,
    listeners: listeners.sort((a, b) => sortText(a.address, b.address) || sortText(a.device, b.device)),
    blind: blind.sort((a, b) => sortText(a.address, b.address) || sortText(a.device, b.device)),
    backends: backends.sort((a, b) => sortText(a.address, b.address) || sortText(a.device, b.device)),
    unknowns,
  };
}

/** Occupancy and residue of one bed, recomputed from the frozen declaration and probe observations. */
export function declaredSurface(bed: ManifestBed, declaration: unknown, probes: unknown): Record<string, unknown> {
  const reads = isRecord(probes) ? Object.entries(probes).map(([id, value]) => ({ id, value })) : [];
  const judged = judgeBedSurface(declaration, bed, reads);
  if (!judged.ok) return { occupancy: 'unknown', missing: judged.missing, next: judged.next, residues: [], automatic: false, cleanup: null, exits: [] };
  return { occupancy: judged.occupancy, residues: judged.residues, automatic: judged.automatic, cleanup: judged.cleanup, exits: judged.exits };
}

/** Whether an address value belongs to the subnet text (same family). */
function sameSegment(subnetText: string, family: 4 | 6, value: bigint): boolean {
  const subnet = parseSubnet(subnetText);
  return subnet !== null && subnet.family === family && subnetContains(subnet, value);
}

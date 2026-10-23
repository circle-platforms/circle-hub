// Bed facts from a manifest bed (the same rules as the test-bed pack's bed-facts, this pack's own copy): interface
// addresses grouped by segment, listen candidates (a DUT interface whose segment also holds a trigger device), blind
// addresses (a DUT interface on a segment without any), backends (server interfaces and the declared services), and
// the devices without any interface address as unknowns. Address use in a plan is judged from these facts plus the
// run's lineage leases (allocated addresses).
import type { ManifestBed } from './manifest.ts';

export const TRIGGER_TYPES: ReadonlySet<string> = new Set(['router', 'client']);

export interface SegmentFact {
  subnet: string;
  family: 'ipv4' | 'ipv6';
  members: Array<{ device: string; type: string; address: string }>;
}

export interface ListenerFact {
  device: string;
  address: string;
  subnet: string;
  triggers: Array<{ device: string; address: string }>;
}

export interface BlindFact {
  device: string;
  address: string;
  subnet: string;
}

export interface BackendFact {
  device: string;
  address: string;
  /** "host:port/proto" of a declared service, null for a bare server interface. */
  service: string | null;
}

export interface BedFacts {
  bed: string;
  segments: SegmentFact[];
  listeners: ListenerFact[];
  blind: BlindFact[];
  backends: BackendFact[];
  unknowns: Array<{ device: string; reason: string }>;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The facts of one bed, computed once and read by every address rule. */
export function bedFacts(bed: ManifestBed): BedFacts {
  const segments = new Map<string, SegmentFact>();
  const listeners: ListenerFact[] = [];
  const blind: BlindFact[] = [];
  const backends: BackendFact[] = [];
  const unknowns: BedFacts['unknowns'] = [];
  for (const device of bed.devices) {
    const addresses = [...device.ipv4, ...device.ipv6];
    if (addresses.length === 0) unknowns.push({ device: device.name, reason: '设备没有任何接口地址，可达性未知' });
    for (const iface of addresses) {
      const held = segments.get(iface.subnet) ?? { subnet: iface.subnet, family: iface.family, members: [] };
      held.members.push({ device: device.name, type: device.type, address: iface.address });
      segments.set(iface.subnet, held);
    }
  }
  for (const device of bed.devices) {
    for (const iface of [...device.ipv4, ...device.ipv6]) {
      if (device.type === 'load-balancer') {
        const triggers = (segments.get(iface.subnet)?.members ?? []).filter((member) => TRIGGER_TYPES.has(member.type) && member.device !== device.name);
        if (triggers.length > 0) listeners.push({ device: device.name, address: iface.address, subnet: iface.subnet, triggers: triggers.map((member) => ({ device: member.device, address: member.address })) });
        else blind.push({ device: device.name, address: iface.address, subnet: iface.subnet });
      }
      if (device.type === 'server') backends.push({ device: device.name, address: iface.address, service: null });
    }
  }
  for (const service of bed.services) {
    const bare = backends.findIndex((fact) => fact.address === service.ip && fact.service === null);
    if (bare >= 0) backends.splice(bare, 1);
    backends.push({ device: service.host, address: service.ip, service: `${service.host}:${service.port}/${service.proto}` });
  }
  const byAddress = <T extends { address: string; device: string }>(a: T, b: T): number => compareText(a.address, b.address) || compareText(a.device, b.device);
  return {
    bed: bed.name,
    segments: [...segments.values()].sort((a, b) => (a.family === b.family ? compareText(a.subnet, b.subnet) : a.family === 'ipv4' ? -1 : 1)),
    listeners: listeners.sort(byAddress),
    blind: blind.sort(byAddress),
    backends: backends.sort(byAddress),
    unknowns: unknowns.sort((a, b) => compareText(a.device, b.device)),
  };
}

export type AddressReading =
  | { kind: 'interface'; device: string; type: string; subnet: string }
  | { kind: 'allocated' }
  | { kind: 'off_bed' };

export interface LeaseRow {
  key: string;
  until: string;
  mine?: boolean;
}

/**
 * What a literal address is on this bed: a device's interface address, an address this run's lineage holds a lease of
 * (bed/<bed>/ip/<address>, marked mine and unexpired at the frozen moment), or off the bed.
 */
export function readAddress(bed: ManifestBed, leases: readonly LeaseRow[], now: string, address: string): AddressReading {
  for (const device of bed.devices) {
    for (const iface of [...device.ipv4, ...device.ipv6]) {
      if (iface.address === address) return { kind: 'interface', device: device.name, type: device.type, subnet: iface.subnet };
    }
  }
  const leased = leases.some((row) => row.mine === true && row.until > now && row.key === `bed/${bed.name}/ip/${address}`);
  return leased ? { kind: 'allocated' } : { kind: 'off_bed' };
}

/** Whether a blind fact names this address (a DUT interface on a segment without a trigger device). */
export function isBlind(facts: BedFacts, address: string): boolean {
  return facts.blind.some((fact) => fact.address === address);
}

/** Whether a backend fact names this address (a server interface or a declared service). */
export function isBackend(facts: BedFacts, address: string): boolean {
  return facts.backends.some((fact) => fact.address === address);
}

/** The listener fact of this address, when it is a DUT interface whose segment holds a trigger device. */
export function listenerOf(facts: BedFacts, address: string): ListenerFact | undefined {
  return facts.listeners.find((fact) => fact.address === address);
}

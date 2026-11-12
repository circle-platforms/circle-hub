// What a run froze of a test-bed booking, read back by other packages (issue 110): the beds and devices of the manifest, the
// builds the devices it booked showed, and the bed lease. The manifest shape, the device lease key and the device pointer are
// this pack's: conclude.ts writes them, so the readers sit beside the writers and booking.test.ts pins the two together.
// Pure: the run body is passed in, nothing is read here. Unknown stays unknown: a booking that is absent answers null, and a
// manifest this pack no longer understands answers a problem, never an empty list that would widen a check.
import { parseBedDeviceKey } from './bed-key.ts';
import { devicePointer } from './conclude.ts';

/** The fields of a run record a booking is read from; structural, so the pack does not import the Hub's contracts. */
export interface BookingBody {
  groups?: unknown;
  leases?: unknown;
  device_observations?: unknown;
  predecessor?: unknown;
}

export type FrozenBeds = { ok: true; beds: Map<string, string[]> } | { ok: false; problem: string };

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const manifestOf = (body: BookingBody | null | undefined): unknown => {
  const group = Array.isArray(body?.groups) ? body.groups[0] : undefined;
  return isRecord(group) ? group.manifest : undefined;
};

/**
 * Bed name to device names, from the manifest a run froze. Null when the run froze none (no booking, nothing to check
 * against); a problem when it froze one this reader cannot read.
 */
export function frozenBeds(body: BookingBody | null | undefined): FrozenBeds | null {
  const manifest = manifestOf(body);
  if (manifest === undefined || manifest === null) return null;
  if (!isRecord(manifest) || !Array.isArray(manifest.beds)) return { ok: false, problem: '运行冻结的台架清单没有 beds 列表，读不出台架和设备' };
  const beds = new Map<string, string[]>();
  for (const bed of manifest.beds) {
    if (!isRecord(bed) || typeof bed.name !== 'string' || !Array.isArray(bed.devices)) continue;
    beds.set(bed.name, bed.devices.flatMap((device) => (isRecord(device) && typeof device.name === 'string' ? [device.name] : [])));
  }
  return { ok: true, beds };
}

/**
 * The installed builds of the devices this run actually booked (`bedDeviceKey`): what each device showed when the booking was
 * granted (decision 112). A booked device nobody looked at adds none; a manifest without an inventory digest adds none.
 */
export function bookedInstalls(body: BookingBody | null | undefined): string[] {
  const group = Array.isArray(body?.groups) ? body.groups[0] : undefined;
  const manifest = manifestOf(body);
  if (!isRecord(group) || !isRecord(manifest) || !Array.isArray(manifest.beds) || typeof group.inventory !== 'string') return [];
  const observed = new Map<string, string>();
  for (const claim of Array.isArray(body?.device_observations) ? body.device_observations : []) {
    if (!isRecord(claim) || !isRecord(claim.statement) || !isRecord(claim.statement.data) || !isRecord(claim.qualifier)) continue;
    const data = claim.statement.data;
    if (claim.qualifier.provenance === 'observed' && data.inventory === group.inventory && typeof data.device === 'string' && typeof data.build === 'string' && data.build.length > 0) observed.set(data.device, data.build);
  }
  const out: string[] = [];
  for (const row of leaseRows(body)) {
    for (const key of row.keys) {
      const parsed = parseBedDeviceKey(key);
      const pointer = parsed === null ? null : devicePointer(manifest, parsed.bed, parsed.device);
      const build = pointer === null ? undefined : observed.get(pointer);
      if (build !== undefined) out.push(build);
    }
  }
  return out;
}

function leaseRows(body: BookingBody | null | undefined): Array<{ lease: unknown; keys: string[] }> {
  return (Array.isArray(body?.leases) ? body.leases : []).filter(isRecord).map((row) => ({ lease: row.lease, keys: Array.isArray(row.keys) ? row.keys.filter((key): key is string => typeof key === 'string') : [] }));
}

/** The acquire lease that holds a device of a bed, or null when the run booked none. */
export function bookedBedLease(body: BookingBody | null | undefined): string | null {
  for (const row of leaseRows(body)) if (typeof row.lease === 'string' && row.keys.some((key) => parseBedDeviceKey(key) !== null)) return row.lease;
  return null;
}

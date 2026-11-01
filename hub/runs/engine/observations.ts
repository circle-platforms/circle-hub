// Device observations as claims (decision 111, B01): what each booked device showed when the booking was granted is an
// observed claim with the probe output as its ground and its moment as its time bound (A05 R[3]); a device that could not be
// looked at is an unknown that names why and that the version probe before a dispatch looks again.
import { Claim } from '../../../contracts/src/claim.ts';
import type { DeviceObservation } from '../../../contracts/src/pack.ts';

const PROBE_RULE = 'dispatch.version_probe@1';
const OBSERVE_RULE = 'runs.observe_devices@1';

const shaOf = (reference: string): string | null => /^src:([0-9a-f]{64})/.exec(reference)?.[1] ?? null;

export function observationClaims(result: { observed: DeviceObservation[]; missing: string | null }, at: string): Claim[] {
  const claims = result.observed.map((o) => {
    const sha = shaOf(o.reference);
    return Claim.parse({
      statement: {
        text: o.build !== null ? `${o.label} 装的是 ${o.build}（设备回显，观察于 ${o.observed_at}）` : `${o.label} 没看出装的是哪个构建：${o.note ?? '版本探针的回显里没有唯一的构建'}`,
        data: { label: o.label, inventory: o.inventory, device: o.device, build: o.build, values: o.values },
        ...(o.build === null ? { verdict: 'unknown', reason: 'missing_input' } : {}),
      },
      qualifier: { nature: o.build !== null ? 'fact' : 'unknown', provenance: 'observed', marks: [], collected_at: o.observed_at },
      grounds: sha !== null ? [o.reference] : [],
      warrant: { producer: 'function', id: PROBE_RULE },
      validity: { status: 'valid', bound: sha !== null ? [sha, o.inventory] : [o.inventory], premises: [] },
    });
  });
  if (result.missing !== null) {
    claims.push(Claim.parse({
      statement: { text: `这次没在设备上看构建：${result.missing}；派发前的版本探测还会再看一次`, data: { missing: result.missing }, verdict: 'unknown', reason: 'missing_input' },
      qualifier: { nature: 'unknown', provenance: 'projected', marks: [], collected_at: at },
      grounds: [],
      warrant: { producer: 'function', id: OBSERVE_RULE },
      validity: { status: 'valid', bound: [], premises: [] },
    }));
  }
  return claims;
}

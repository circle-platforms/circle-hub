import type { ProvenanceType } from '../../../../contracts/generated/vocabulary.ts';
// matchNeed: which bed fits the need, from the normalized manifest beds, the installed-build reports, the build
// alias map (a name to the base build it uses, the same base/base writing as the case-location candidates), the
// lease table (key → until) and now. Pure; the wording of every conclusion says “Hub 记录里”, because Hub records
// cannot exclude local work on the devices (D02).
import type { ManifestBed } from './manifest.ts';

export interface NeedDevice {
  type: string;
  count: number;
}

export interface Need {
  devices: NeedDevice[];
  build?: string;
  hours?: number;
}

/** What one device holds: the reported build, where the report came from, and when. */
export interface Installed {
  build: string;
  source: Extract<ProvenanceType, 'declared' | 'observed'>;
  /** When the report was made; absent for a manifest declaration (the document carries no per-entry time). */
  at?: string;
}

/** A lease as matchNeed sees it: only the key and when it ends. */
export interface LeaseEntry {
  until: string | null;
}

export interface BedMatch {
  bed: string;
  /** Whether the bed has the needed devices of every type. */
  devicesOk: boolean;
  /** no_requirement | match | mismatch | unknown (unknown: no install record, never a mismatch). */
  buildOk: 'no_requirement' | 'match' | 'mismatch' | 'unknown';
  /** observed | declared | none (no install record of the deciding device). */
  buildSource: Extract<ProvenanceType, 'observed' | 'declared'> | 'none';
  /** When the needed devices are all free (the maximum of their leases' ends), null when idle now. */
  earliestFree: string | null;
  occupied: boolean;
  /** How many devices of the needed types the bed has beyond the need (the ordering's third key). */
  spareDevices: number;
  /** The one-line conclusion a person reads. */
  conclusion: string;
}

/** The base build a name maps to: itself when the map has no entry (an exact-name product). */
const baseOf = (builds: Record<string, string>, name: string): string => builds[name] ?? name;

/** The pick of devices of one type when the need wants count of them: the ones without an active lease first,
 * then by name; when fewer free ones exist than wanted, leased ones join (the bed then has an earliest-free time).
 * Exported for the acquire projection: the lease keys are the picked devices. */
export function pickDevices(bed: ManifestBed, leases: Record<string, LeaseEntry>, now: string, type: string, count: number): { picked: string[]; leasedUntil: Array<string|null> } {
  const of = bed.devices.filter((d) => d.type === type);
  const active=(device:string):LeaseEntry|undefined=>{
    const row=leases['bed/'+bed.name+'/'+device];return row&&(row.until===null||Date.parse(row.until)>Date.parse(now))?row:undefined;
  };
  const free=of.filter(d=>!active(d.name)).map(d=>d.name).sort(compareText);
  const taken=of.filter(d=>!!active(d.name)).map(d=>d.name).sort(compareText);
  const picked=[...free,...taken].slice(0,count);
  return {picked,leasedUntil:picked.flatMap(name=>{const row=active(name);return row?[row.until]:[];})};
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The earliest-free text of a moment, or the idle wording. */
function freeText(earliest: string | null): string {
  return earliest === null ? 'Hub 记录里空闲（未排除本地操作）' : `Hub 记录里最早 ${earliest} 空闲（未排除本地操作）`;
}

/** matchNeed over the beds of one manifest; the answer is sorted, best first. */
export function matchNeed(
  beds: readonly ManifestBed[],
  need: Need,
  installed: Record<string, Installed>,
  builds: Record<string, string>,
  leases: Record<string, LeaseEntry>,
  now: string,
): BedMatch[] {
  const needOf = (type: string): number => need.devices.find((d) => d.type === type)?.count ?? 0;
  const wanted = (type: string): boolean => needOf(type) > 0;
  const answers: BedMatch[] = beds.map((bed) => {
    // Devices: every needed type present in the needed count.
    const missing: string[] = [];
    let spare = 0;
    for (const { type, count } of need.devices) {
      const have = bed.devices.filter((d) => d.type === type).length;
      if (have < count) {
        const label = TYPE_LABEL[type] ?? type;
        missing.push(`需要 ${count} 台${label}，台架里有 ${have} 台`);
      } else {
        spare += have - count;
      }
    }
    const devicesOk = missing.length === 0;
    // The pick of needed devices (free first) decides the build verdict and the earliest-free time.
    const picks: string[] = [];
    const leaseEnds: Array<string|null> = [];
    if (devicesOk) {
      for (const { type, count } of need.devices) {
        const pick = pickDevices(bed, leases, now, type, count);
        picks.push(...pick.picked);
        leaseEnds.push(...pick.leasedUntil);
      }
    }
    if(need.devices.length===0)for(const device of bed.devices){const row=leases['bed/'+bed.name+'/'+device.name];if(row&&(row.until===null||Date.parse(row.until)>Date.parse(now)))leaseEnds.push(row.until);}
    const occupied=leaseEnds.length>0;
    const earliestFree=leaseEnds.length===0||leaseEnds.includes(null)?null:(leaseEnds as string[]).reduce((a,b)=>a>b?a:b);
    // Build: over the picked devices of the load-balancer type (the device under test), or every picked device
    // when the need names no load balancer.
    const deciding = picks.filter((name) => {
      const device = bed.devices.find((d) => d.name === name);
      return device !== undefined && (device.type === 'load-balancer' || (need.devices.every((d) => d.type !== 'load-balancer') && wanted(device.type)));
    });
    let buildOk: BedMatch['buildOk'] = 'no_requirement';
    let buildSource: BedMatch['buildSource'] = 'none';
    let buildText = '';
    if (need.build !== undefined && devicesOk) {
      const want = baseOf(builds, need.build);
      const records = deciding.map((name) => ({ name, record: installed[`bed/${bed.name}/${name}`] }));
      const known = records.filter((r) => r.record !== undefined);
      if (known.length === 0) {
        buildOk = 'unknown';
        buildText = '设备上装的构建没有记录（未知）';
      } else if (known.every((r) => baseOf(builds, r.record!.build) === want)) {
        buildOk = 'match';
        const one = known[0].record!;
        buildSource = one.source;
        buildText = one.source === 'observed' ? `构建一致（${need.build}，观察）` : `构建一致（${need.build}，声明，未核对）`;
      } else {
        buildOk = 'mismatch';
        const one = known[0].record!;
        buildSource = one.source;
        buildText = `构建不一致（装的是 ${one.build}，需要升级到 ${need.build}${one.source === 'observed' ? '，观察' : '，声明，未核对'}）`;
      }
    }
    const parts: string[] = [];
    if (!devicesOk) parts.push(missing.join('；'));
    if (devicesOk) parts.push(occupied&&earliestFree===null?'Hub 记录里被占用，没有到期时刻（未排除本地操作）':freeText(earliestFree));
    if (buildText !== '') parts.push(buildText);
    return { bed: bed.name, devicesOk, buildOk, buildSource, earliestFree, occupied, spareDevices: spare, conclusion: parts.join('；') };
  });
  const rankFree = (m: BedMatch): number => (m.devicesOk && !m.occupied ? 0 : 1);
  const rankTime = (m: BedMatch): number => (!m.occupied ? 0 : m.earliestFree === null ? Infinity : Date.parse(m.earliestFree));
  return answers.sort((a, b) => rankFree(a) - rankFree(b) || rankTime(a) - rankTime(b) || a.spareDevices - b.spareDevices || compareText(a.bed, b.bed));
}

/** No bed has the needed build. Per-bed fields stay as matchNeed wrote them; this is only the search-level unknown. */
export interface UnmatchedBuild {
  verdict: 'unknown';
  missing: string;
  fix: string;
}

const UNMATCHED_FIX = '管理员在清单登记在装构建，或把某台升级到该构建后重试';

/** The deciding devices of one fitting bed, the same pick matchNeed uses for the build verdict. */
function decidingDevices(bed: ManifestBed, need: Need, leases: Record<string, LeaseEntry>, now: string): string[] {
  const picks: string[] = [];
  for (const { type, count } of need.devices) picks.push(...pickDevices(bed, leases, now, type, count).picked);
  const wantsBalancer = need.devices.some((device) => device.type === 'load-balancer');
  return picks.filter((name) => {
    const device = bed.devices.find((row) => row.name === name);
    return device !== undefined && (device.type === 'load-balancer' || (!wantsBalancer && need.devices.some((row) => row.type === device.type && row.count > 0)));
  });
}

/**
 * When a build is required and every bed that has the devices fails it: unknown, naming the version line and each
 * deciding device (a missing install record, or the build it actually holds) and the one exit. A matching bed, a need
 * without a build, or a search where no bed has the devices returns null. Existing per-bed fields are not rewritten.
 */
export function unmatchedBuildExit(
  beds: readonly ManifestBed[],
  need: Need,
  installed: Record<string, Installed>,
  builds: Record<string, string>,
  leases: Record<string, LeaseEntry>,
  now: string,
  matches: readonly BedMatch[],
): UnmatchedBuild | null {
  if (need.build === undefined) return null;
  const fitting = matches.filter((row) => row.devicesOk);
  if (fitting.length === 0 || fitting.some((row) => row.buildOk === 'match')) return null;
  const absent: string[] = [];
  const other: string[] = [];
  const want = baseOf(builds, need.build);
  for (const row of fitting) {
    const bed = beds.find((candidate) => candidate.name === row.bed);
    if (bed === undefined) continue;
    for (const name of decidingDevices(bed, need, leases, now)) {
      const record = installed[`bed/${bed.name}/${name}`];
      const where = `${bed.name}/${name}`;
      if (record === undefined) absent.push(where);
      else if (baseOf(builds, record.build) !== want) other.push(`${where} 装的是 ${record.build}`);
    }
  }
  const parts = [`没有任何台架的在装构建匹配版本线 ${need.build}`];
  if (absent.length > 0) parts.push(`缺在装构建记录：${absent.join('、')}`);
  if (other.length > 0) parts.push(`在装构建不是该版本线：${other.join('、')}`);
  return { verdict: 'unknown', missing: parts.join('。'), fix: UNMATCHED_FIX };
}

const TYPE_LABEL: Record<string, string> = {
  'load-balancer': '负载均衡',
  router: '路由器',
  client: '客户端',
  server: '服务器',
  console: '控制台',
};

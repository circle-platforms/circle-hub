import { occupancyText } from './ownership.ts';
import type { LeaseOp } from '../../../../contracts/generated/vocabulary.ts';
// conclude: the one computation the search/facts/acquire conclusions rest on, shared by the projection
// (functions/project.ts) and the check (functions/check-bed.ts), so the check recomputes exactly what the projection
// computed from the same frozen manifest and lease view. The lease context the workflow declares gives only keys and
// ends (RunContext.leases; no tokens, no holders), which is all matchNeed and the address allocation need.
import { formatIp, nextFree, parseIp, parseSubnet, subnetContains, type Subnet } from './addresses.ts';
import { isRecord } from './common.ts';
import { bedFacts, declaredSurface } from './facts.ts';
import { parseManifest, DEVICE_TYPE_LABEL, DEVICE_TYPES, type ManifestBed } from './manifest.ts';
import { matchNeed, pickDevices, type BedMatch, type Installed, type LeaseEntry, type Need, type NeedDevice } from './match.ts';

export type Action = 'search' | 'facts' | Extract<LeaseOp, 'acquire' | 'release' | 'register' | 'unregister' | 'force_release'>;

/** A need as the projection and the check see it (parameters normalized). */
export interface BedNeed {
  devices: NeedDevice[];
  build?: string;
}

/** The frozen lease view (RunContext.leases), or its rows as matchNeed reads them. */
export interface FrozenLeases {
  now: string;
  entries: Array<{ key: string; until: string | null; mine?: boolean; since?: string; run?: string; holder?: {user:string;name:string}; jobs?: string[] }>;
  registrations?: Array<{prefix:string;mine:boolean;owner?:{user:string;name:string}}>;
}

export interface Normalized {
  action: Action;
  need: BedNeed;
  bed: string | null;
  addresses: { segment: string; count: number } | null;
  /** The booking run's id (extend and release; required there, ignored elsewhere). */
  booking: string | null;
  reason: string;
  devices: string[] | null;
}

export interface PlanFailure {
  code: string;
  message: string;
  fix: string;
}


export const ACTION_LABEL: Record<Action, string> = { search: '搜索台架', facts: '环境事实', acquire: '预订台架', release: '释放预订', register:'登记台架', unregister:'注销台架', force_release:'强制释放' };

export function isAction(value: unknown): value is Action {
  return typeof value === 'string' && Object.hasOwn(ACTION_LABEL, value);
}

/** The rows of the frozen lease view as matchNeed reads them. */
export function leaseRecord(frozen: FrozenLeases | undefined): Record<string, LeaseEntry> {
  const out: Record<string, LeaseEntry> = {};
  for (const entry of frozen?.entries ?? []) {
    if (typeof entry?.key === 'string' && (entry.until === null || typeof entry.until === 'string')) out[entry.key] = { until: entry.until };
  }
  return out;
}

/** Parameters of a run call: action (default search), need, bed, addresses and booking, every problem named with its fix. */
export function readParameters(params: Record<string, unknown>): Normalized | PlanFailure {
  const needRaw = isRecord(params.need) ? params.need : {};
  if (params.action === 'extend' || Object.hasOwn(params,'hours') || Object.hasOwn(needRaw,'hours')) return {code:'test-bed.duration_removed',message:'不再接受 hours 或 extend',fix:'台架预订不限时长，用完由运行释放'};
  if (params.action !== undefined && !isAction(params.action)) return {code:'test-bed.bad_action',message:'不认识的台架动作',fix:'使用 search、facts、acquire、release、register、unregister 或 force_release'};
  const action: Action = isAction(params.action) ? params.action : 'search';
  const devices: NeedDevice[] = [];
  const rawDevices = Array.isArray(needRaw.devices) ? needRaw.devices : [];
  for (const raw of rawDevices) {
    const type = isRecord(raw) && typeof raw.type === 'string' ? raw.type : '';
    const count = isRecord(raw) && typeof raw.count === 'number' && Number.isInteger(raw.count) ? raw.count : -1;
    if (!(DEVICE_TYPES as readonly string[]).includes(type)) {
      return { code: 'test-bed.bad_need', message: `need.devices 里的设备类型 ${JSON.stringify(type)} 不在五种里（${Object.values(DEVICE_TYPE_LABEL).join('、')}）`, fix: `type 写 ${DEVICE_TYPES.join('、')} 之一` };
    }
    if (count < 1 || count > 100) return { code: 'test-bed.bad_need', message: `need.devices 里 ${type} 的数量 ${JSON.stringify(raw.count)} 不是 1 到 100 的整数`, fix: 'count 写 1 到 100 的整数' };
    devices.push({ type, count });
  }
  const build = typeof needRaw.build === 'string' && needRaw.build !== '' ? needRaw.build : undefined;
  const bed = typeof params.bed === 'string' && params.bed !== '' ? params.bed : null;
  let addresses: Normalized['addresses'] = null;
  if (params.addresses !== undefined && params.addresses !== null) {
    if (!isRecord(params.addresses) || typeof params.addresses.segment !== 'string' || parseSubnet(params.addresses.segment) === null) {
      return { code: 'test-bed.bad_addresses', message: 'addresses.segment 要写一个网段（如 192.0.2.0/26）', fix: 'addresses 写 { "segment": "192.0.2.0/26", "count": 2 }' };
    }
    const count = params.addresses.count;
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > 64) {
      return { code: 'test-bed.bad_addresses', message: `addresses.count ${JSON.stringify(count)} 不是 1 到 64 的整数`, fix: 'count 写 1 到 64' };
    }
    addresses = { segment: params.addresses.segment, count };
  }
  const booking = typeof params.booking === 'string' && params.booking !== '' ? params.booking : null;
  if ((action === 'release') && booking === null) {
    return { code: 'test-bed.bad_booking', message: `${ACTION_LABEL[action]}要 booking 参数（预订那次运行的编号）`, fix: 'booking 写预订运行的编号（run_…），开始这次运行时 predecessor 写同一个编号' };
  }
  const reason=typeof params.reason==='string'?params.reason:'';
  if ((action==='unregister'||action==='force_release')&&!reason.trim()) return {code:'test-bed.reason_required',message:'必须写释放或注销的理由',fix:'reason 照用户原话填写'};
  if ((action==='register'||action==='unregister'||action==='force_release')&&bed===null) return {code:'test-bed.unknown_bed',message:'必须指定台架',fix:'bed 写当前清单里的台架名'};
  if(params.devices!==undefined && (!Array.isArray(params.devices)||params.devices.length===0||params.devices.some(d=>typeof d!=='string')||new Set(params.devices).size!==params.devices.length))return {code:'test-bed.bad_devices',message:'devices 须为不重复的设备名数组',fix:'devices 写清单里的设备名，不写表示整个台架'};
  return { action, need: { devices, build }, bed, addresses, booking, reason, devices:Array.isArray(params.devices)?params.devices as string[]:null };
}

const matchNeedOf = (need: BedNeed): Need => ({ devices: need.devices, ...(need.build === undefined ? {} : { build: need.build }) });

/** The manifest beds, or the problems the projection fails the whole call with. */
export function manifestBeds(model: unknown): { ok: true; beds: ManifestBed[] } | { ok: false; problems: Array<{ pointer: string; message: string; fix: string }> } {
  const parsed = parseManifest(model);
  if (parsed.ok) return { ok: true, beds: parsed.beds };
  return { ok: false, problems: parsed.problems };
}

export interface SearchFields {
  bed: string;
  devices_ok: boolean;
  missing: string[];
  earliest_free: string | null;
  build_ok: BedMatch['buildOk'];
  build_source: BedMatch['buildSource'];
  spare_devices: number;
  conclusion: string;
}

/** The manifest's declared install records (每台设备的 installed): the lease-key record matchNeed reads, and the
 * alias map of a build name to its base build. Declared, never checked — the conclusions say 声明，未核对 (I03). */
export function declaredInstalls(beds: readonly ManifestBed[]): { installed: Record<string, Installed>; builds: Record<string, string> } {
  const installed: Record<string, Installed> = {};
  const builds: Record<string, string> = {};
  for (const bed of beds) {
    for (const device of bed.devices) {
      const record = device.installed ?? null;
      if (record === null) continue;
      installed[`bed/${bed.name}/${device.name}`] = { build: record.build, source: 'declared' };
      if (record.base !== null) builds[record.build] = record.base;
    }
  }
  return { installed, builds };
}

/** One search conclusion per bed (matchNeed's order); the build verdict reads the manifest's declared installs. */
export function searchFields(beds: ManifestBed[], need: BedNeed, leases: Record<string, LeaseEntry>, now: string, frozen?: FrozenLeases): SearchFields[] {
  // The manifest's installed entries are the phase-1 install records (declared, unchecked; the observed tier comes
  // with the executor). A device without one stays 没有记录（未知）, never a mismatch.
  const { installed, builds } = declaredInstalls(beds);
  const matches = matchNeed(beds, matchNeedOf(need), installed, builds, leases, now);
  return matches.map((m) => ({
    bed: m.bed,
    devices_ok: m.devicesOk,
    missing: m.devicesOk ? [] : m.conclusion.split('；'),
    earliest_free: m.earliestFree,
    build_ok: m.buildOk,
    build_source: m.buildSource,
    spare_devices: m.spareDevices,
    conclusion: m.conclusion+ (frozen ? '；'+occupancyText(beds.find(b=>b.name===m.bed)!,frozen).join('；') : ''),
  }));
}

export interface FactsFields {
  bed: string;
  segments: unknown[];
  listeners: unknown[];
  blind: unknown[];
  backends: unknown[];
  unknowns: unknown[];
  /** The manifest's declared installs of this bed's devices (声明，未核对); empty when none. */
  occupancy: string[];
  installed: Array<{ device: string; build: string; base: string | null }>;
  /** Present only when this run froze a bed-surface declaration. */
  surface?: Record<string, unknown>;
}

/** One facts conclusion per bed (the manifest's order). */
export function factsFields(beds: ManifestBed[], frozen?: FrozenLeases, surface?: { declaration: unknown; probes: unknown }): FactsFields[] {
  return beds.map((bed) => {
    const facts = bedFacts(bed);
    const installed = bed.devices.flatMap((device) => {
      const record = device.installed ?? null;
      return record === null ? [] : [{ device: device.name, build: record.build, base: record.base }];
    });
    const judged = surface ? declaredSurface(bed, surface.declaration, surface.probes) : undefined;
    return { bed: bed.name, occupancy: frozen ? occupancyText(bed,frozen) : [], segments: facts.segments, listeners: facts.listeners, blind: facts.blind, backends: facts.backends, unknowns: facts.unknowns, installed, ...(judged ? { surface: judged } : {}) };
  });
}

export interface AcquirePlan {
  bed: string;
  devices: string[];
  addresses: string[];
  keys: string[];
  conclusion: string;
}

/** The lease request of an acquire: the bed, the picked devices and addresses, the keys and the TTL, or the failure. */
export function acquirePlan(beds: ManifestBed[], need: BedNeed, bedParam: string | null, addressesParam: Normalized['addresses'], leases: Record<string, LeaseEntry>, now: string): { ok: true; plan: AcquirePlan } | { ok: false; failure: PlanFailure } {
  const matches = searchFields(beds, need, leases, now);
  let chosen: SearchFields | undefined;
  if (bedParam !== null) {
    chosen = matches.find((m) => m.bed === bedParam);
    if (chosen === undefined) return { ok: false, failure: { code: 'test-bed.unknown_bed', message: `清单里没有台架 ${bedParam}`, fix: 'bed 写清单里的一个台架名，或不写按 need 选最佳匹配' } };
    if (!chosen.devices_ok) return { ok: false, failure: { code: 'test-bed.bed_short', message: `台架 ${bedParam} 不满足需求：${chosen.conclusion}`, fix: '换 need 或换台架' } };
    if (need.build !== undefined && chosen.build_ok === 'mismatch') return { ok: false, failure: { code: 'test-bed.build_mismatch', message: `台架 ${bedParam} 的构建不一致：${chosen.conclusion}`, fix: '先升级，或换构建一致的台架' } };
  } else {
    // matchNeed's order is idle first: the first fitting bed is idle when one exists, else the earliest to free; a
    // taken bed is refused by the Hub's lease grant with LEASE_UNAVAILABLE and the earliest free moment, not here.
    chosen = matches.find((m) => m.devices_ok && (need.build === undefined || m.build_ok !== 'mismatch'));
    if (chosen === undefined) {
      return { ok: false, failure: { code: 'test-bed.no_bed', message: '没有满足需求的台架', fix: '缩小 need；各台架的最早空闲时刻见 search 的结论' } };
    }
  }
  const bed = beds.find((b) => b.name === (chosen as SearchFields).bed) as ManifestBed;
  const picked: string[] = [];
  for (const { type, count } of need.devices) picked.push(...pickDevices(bed, leases, now, type, count).picked);
  picked.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  // Addresses: the free ones of the segment after members, reserved ranges and the ip keys already leased out.
  const addresses: string[] = [];
  if (addressesParam !== null) {
    const subnet = parseSubnet(addressesParam.segment) as Subnet;
    if (!bed.devices.some((d) => [...d.ipv4, ...d.ipv6].some((a) => a.subnet === addressesParam.segment))) {
      return { ok: false, failure: { code: 'test-bed.no_segment', message: `台架 ${bed.name} 没有网段 ${addressesParam.segment}`, fix: 'addresses.segment 写台架的一个网段' } };
    }
    const taken = new Set<bigint>();
    for (const device of bed.devices) for (const a of [...device.ipv4, ...device.ipv6]) if (a.subnet === addressesParam.segment) taken.add(a.value);
    for (const [key, entry] of Object.entries(leases)) {
      if (key.startsWith(`bed/${bed.name}/ip/`) && (entry.until === null || Date.parse(entry.until) > Date.parse(now))) {
        const value = parseIp(key.slice(`bed/${bed.name}/ip/`.length));
        if (value !== null && subnetContains(subnet, value)) taken.add(value);
      }
    }
    const reserved = new Set<bigint>();
    for (const range of bed.reserved) for (const value of range.addresses) reserved.add(value);
    const free = nextFree(subnet, taken, reserved, addressesParam.count);
    if (free.length < addressesParam.count) {
      return { ok: false, failure: { code: 'test-bed.not_enough_addresses', message: `台架 ${bed.name} 的网段 ${addressesParam.segment} 只有 ${free.length} 个空闲地址，少于 ${addressesParam.count} 个`, fix: '少要几个，或换网段' } };
    }
    for (const value of free) addresses.push(formatIp(subnet.family, value));
  }
  if (picked.length === 0 && addresses.length === 0) {
    return { ok: false, failure: { code: 'test-bed.nothing_to_lease', message: '没有要取得的设备或地址：need.devices 和 addresses 都是空的', fix: '在 need.devices 里要设备，或在 addresses 里要地址' } };
  }
  const keys = [...picked.map((device) => `bed/${bed.name}/${device}`), ...addresses.map((address) => `bed/${bed.name}/ip/${address}`)];
  const parts = [`预订 ${bed.name}`];
  if (picked.length > 0) parts.push(`设备 ${picked.join('、')}`);
  if (addresses.length > 0) parts.push(`地址 ${addresses.join('、')}`);
  parts.push('不限时长，用完由运行释放');
  return { ok: true, plan: { bed: bed.name, devices: picked, addresses, keys, conclusion: parts.join('，') } };
}

/** The keys this run's lineage holds: the frozen view's rows marked mine (D04 R[0], the Hub marks them before the projection). */
export function heldKeys(frozen: FrozenLeases | undefined): string[] {
  return (frozen?.entries ?? []).filter((entry) => entry?.mine === true && typeof entry.key === 'string').map((entry) => entry.key);
}

export interface HeldPlan {
  booking: string;
  /** The one bed the held keys belong to; null when they span several (a hand-written lease table can do that). */
  bed: string | null;
  devices: string[];
  addresses: string[];
  keys: string[];
  conclusion: string;
}

/** The device keys, the address keys and the leftover keys of a held set, each sorted. */
function splitKeys(keys: string[]): { bed: string | null; devices: string[]; addresses: string[]; keys: string[] } {
  const deviceKeys: string[] = [];
  const addressKeys: string[] = [];
  const other: string[] = [];
  const beds = new Set<string>();
  for (const key of keys) {
    const parts = key.split('/');
    if (parts.length === 3 && parts[0] === 'bed') {
      beds.add(parts[1] as string);
      deviceKeys.push(key);
    } else if (parts.length === 4 && parts[0] === 'bed' && parts[2] === 'ip') {
      beds.add(parts[1] as string);
      addressKeys.push(key);
    } else {
      other.push(key);
    }
  }
  const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  deviceKeys.sort(compare);
  addressKeys.sort(compare);
  other.sort(compare);
  const devices = deviceKeys.map((key) => key.split('/')[2] as string);
  const addresses = addressKeys.map((key) => key.split('/')[3] as string);
  return { bed: beds.size === 1 ? ([...beds][0] as string) : null, devices, addresses, keys: [...deviceKeys, ...addressKeys, ...other] };
}

/** The conclusion parts both held actions share: what is held, as devices and addresses. */
function heldParts(verb: string, split: { bed: string | null; devices: string[]; addresses: string[] }, booking: string): string[] {
  const parts = [`${verb} ${split.bed ?? '台架'} 的预订 ${booking}`];
  if (split.devices.length > 0) parts.push(`设备 ${split.devices.join('、')}`);
  if (split.addresses.length > 0) parts.push(`地址 ${split.addresses.join('、')}`);
  return parts;
}

const NOT_HELD: (booking: string) => PlanFailure = (booking) => ({
  code: 'test-bed.not_holder',
  message: `你没有持有这个预订（${booking}）：这次运行的血缘里没有未过期的租约行`,
  fix: 'booking 写你自己的预订运行的编号，开始这次运行时 predecessor 写同一个编号；别人的预订不能续期或释放',
});

/** The release plan: every lineage-held key ends now (irreversible, even when the run later fails). */
export function releasePlan(frozen: FrozenLeases | undefined, booking: string): { ok: true; plan: HeldPlan } | { ok: false; failure: PlanFailure } {
  const held = heldKeys(frozen);
  if (held.length === 0) return { ok: false, failure: NOT_HELD(booking) };
  const split = splitKeys(held);
  return { ok: true, plan: { booking, bed: split.bed, devices: split.devices, addresses: split.addresses, keys: split.keys, conclusion: heldParts('释放', split, booking).join('，') } };
}

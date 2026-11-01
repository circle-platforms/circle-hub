import { occupancyText } from './ownership.ts';
import type { LeaseOp, ProvenanceType } from '../../../../contracts/generated/vocabulary.ts';
// conclude: the one computation the search/facts/acquire conclusions rest on, shared by the projection
// (functions/project.ts) and the check (functions/check-bed.ts), so the check recomputes exactly what the projection
// computed from the same frozen manifest and lease view. The lease context the workflow declares gives only keys and
// ends (RunContext.leases; no tokens, no holders), which is all matchNeed and the address allocation need.
import { formatIp, nextFree, parseIp, parseSubnet, subnetContains, type Subnet } from './addresses.ts';
import { isRecord } from './common.ts';
import { bedFacts, declaredSurface } from './facts.ts';
import { parseManifest, DEVICE_TYPE_LABEL, DEVICE_TYPES, type ManifestBed } from './manifest.ts';
import { matchNeed, pickDevices, unmatchedBuildExit, type BedMatch, type Installed, type LeaseEntry, type Need, type NeedDevice, type UnmatchedBuild } from './match.ts';

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
  /** Where in the call the problem is (decision 114), e.g. /parameters/need/devices/0; absent: the inventory input. */
  pointer?: string;
  /** Whether the facts the refusal rests on are declared (the inventory) or observed (D05 R[8]). */
  provenance?: Extract<ProvenanceType, 'declared' | 'observed'>;
  grounds?: string[];
}


export const ACTION_LABEL: Record<Action, string> = { search: '搜索自动化测试环境', facts: '环境事实', acquire: '预订自动化测试环境', release: '释放预订', register:'登记自动化测试环境', unregister:'注销自动化测试环境', force_release:'强制释放' };

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
  if (params.action === 'extend' || Object.hasOwn(params,'hours') || Object.hasOwn(needRaw,'hours')) return {code:'test-bed.duration_removed',message:'不再接受 hours 或 extend',fix:'自动化测试环境预订不限时长，用完由运行释放'};
  if (params.action !== undefined && !isAction(params.action)) return {code:'test-bed.bad_action',message:'不认识的自动化测试环境动作',fix:'使用 search、facts、acquire、release、register、unregister 或 force_release'};
  const action: Action = isAction(params.action) ? params.action : 'search';
  const devices: NeedDevice[] = [];
  const rawDevices = Array.isArray(needRaw.devices) ? needRaw.devices : [];
  const SHAPE = `每项写成 {"type":"load-balancer","count":2} 这样的对象，type 是 ${DEVICE_TYPES.join('、')} 之一；预订整个自动化测试环境时按清单的类型和数量写全，不写设备名`;
  for (const [i, raw] of rawDevices.entries()) {
    const pointer = `/parameters/need/devices/${i}`;
    // Say what was given, never a value the caller did not write (decision 114).
    if (!isRecord(raw)) return { code: 'test-bed.bad_need', message: `need.devices 第 ${i + 1} 项是 ${JSON.stringify(raw)}，不是 {type, count} 对象`, fix: SHAPE, pointer };
    if (typeof raw.type !== 'string') return { code: 'test-bed.bad_need', message: `need.devices 第 ${i + 1} 项没有 type`, fix: SHAPE, pointer: `${pointer}/type` };
    const type = raw.type;
    if (!(DEVICE_TYPES as readonly string[]).includes(type)) {
      return { code: 'test-bed.bad_need', message: `need.devices 第 ${i + 1} 项的设备类型 ${JSON.stringify(type)} 不在五种里（${Object.values(DEVICE_TYPE_LABEL).join('、')}）`, fix: `type 写 ${DEVICE_TYPES.join('、')} 之一`, pointer: `${pointer}/type` };
    }
    const count = typeof raw.count === 'number' && Number.isInteger(raw.count) ? raw.count : -1;
    if (count < 1 || count > 100) return { code: 'test-bed.bad_need', message: `need.devices 第 ${i + 1} 项 ${type} 的数量${raw.count === undefined ? '没有写' : `是 ${JSON.stringify(raw.count)}`}，要 1 到 100 的整数`, fix: 'count 写 1 到 100 的整数', pointer: `${pointer}/count` };
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
  if ((action==='register'||action==='unregister'||action==='force_release')&&bed===null) return {code:'test-bed.unknown_bed',message:'必须指定自动化测试环境',fix:'bed 写当前清单里的自动化测试环境名'};
  if(params.devices!==undefined && (!Array.isArray(params.devices)||params.devices.length===0||params.devices.some(d=>typeof d!=='string')||new Set(params.devices).size!==params.devices.length))return {code:'test-bed.bad_devices',message:'devices 须为不重复的设备名数组',fix:'devices 写清单里的设备名，不写表示整个自动化测试环境'};
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

/** A device observation as the Hub gives it in the run context (DeviceObservation, decision 112). */
export interface Observation { inventory: string; device: string; label: string; build: string | null; base: string | null; observed_at: string }

/** The JSON Pointer of a device in the raw manifest, by its bed's and its own name; null when either is not there. */
export function devicePointer(model: unknown, bed: string, device: string): string | null {
  const beds = isRecord(model) && Array.isArray(model.beds) ? model.beds : [];
  const bi = beds.findIndex((b) => isRecord(b) && b.name === bed);
  const devices = bi >= 0 && isRecord(beds[bi]) && Array.isArray((beds[bi] as Record<string, unknown>).devices) ? ((beds[bi] as Record<string, unknown>).devices as unknown[]) : [];
  const di = devices.findIndex((d) => isRecord(d) && d.name === device);
  return bi < 0 || di < 0 ? null : `/beds/${bi}/devices/${di}`;
}

/** The observations a run context or a frozen group carries, the malformed ones dropped. */
export function observationsOf(value: unknown): Observation[] {
  return (Array.isArray(value) ? value : []).filter((o): o is Observation => isRecord(o) && typeof o.inventory === 'string' && typeof o.device === 'string' && typeof o.label === 'string' && (o.build === null || typeof o.build === 'string') && (o.base === null || typeof o.base === 'string') && typeof o.observed_at === 'string');
}

/** The installs of a raw manifest bound with this digest, from the observations (decision 112). */
export function installsOf(model: unknown, beds: readonly ManifestBed[], inventory: string | null, observations: readonly Observation[]): Installs {
  return observedInstalls(beds, observations, inventory, (bed, device) => devicePointer(model, bed, device));
}

/** The installed builds of the manifest's devices and the alias map matchNeed reads; built by observedInstalls. */
export interface Installs { installed: Record<string, Installed>; builds: Record<string, string> }

/**
 * The installed builds from what the devices showed (decision 112: the device is the authority, the manifest declares
 * nothing): for each device, the newest observation of this inventory at the device's JSON Pointer that gave a build,
 * with its moment; the alias map takes an observed name to its knowledge-base build. A device never observed has none.
 */
export function observedInstalls(beds: readonly ManifestBed[], observations: readonly Observation[], inventory: string | null, pointerOf: (bed: string, device: string) => string | null): Installs {
  const installed: Record<string, Installed> = {};
  const builds: Record<string, string> = {};
  if (inventory === null) return { installed, builds };
  for (const bed of beds) {
    for (const device of bed.devices) {
      const pointer = pointerOf(bed.name, device.name);
      if (pointer === null) continue;
      const seen = observations.filter((o) => o.inventory === inventory && o.device === pointer && o.build !== null).sort((a, b) => (a.observed_at < b.observed_at ? 1 : a.observed_at > b.observed_at ? -1 : 0))[0];
      if (seen === undefined || seen.build === null) continue;
      installed[`bed/${bed.name}/${device.name}`] = { build: seen.build, source: 'observed', at: seen.observed_at };
      if (seen.base !== null) builds[seen.build] = seen.base;
    }
  }
  return { installed, builds };
}

/**
 * Search-level unknown when a build is required and every bed that has the devices fails it. Null when some bed
 * matches, the need names no build, or no bed has the devices. Per-bed fields stay whatever searchFields computed.
 */
export function unmatchedBuild(beds: ManifestBed[], need: BedNeed, leases: Record<string, LeaseEntry>, now: string, installs: Installs): UnmatchedBuild | null {
  const { installed, builds } = installs;
  const shaped = matchNeedOf(need);
  return unmatchedBuildExit(beds, shaped, installed, builds, leases, now, matchNeed(beds, shaped, installed, builds, leases, now));
}

/** One search conclusion per bed (matchNeed's order); the build verdict reads the devices' newest observations. */
export function searchFields(beds: ManifestBed[], need: BedNeed, leases: Record<string, LeaseEntry>, now: string, installs: Installs, frozen?: FrozenLeases): SearchFields[] {
  // What the devices last showed (decision 112); a device never observed stays 没有观察记录（未知）, never a mismatch.
  const { installed, builds } = installs;
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
  occupancy: string[];
  /** What this bed's devices last showed, each with its moment; empty when none was observed. */
  installed: Array<{ device: string; build: string; base: string | null; observed_at: string | null }>;
  /** Present only when this run froze a bed-surface declaration. */
  surface?: Record<string, unknown>;
}

/** One facts conclusion per bed (the manifest's order). */
export function factsFields(beds: ManifestBed[], installs: Installs, frozen?: FrozenLeases, surface?: { declaration: unknown; probes: unknown }): FactsFields[] {
  return beds.map((bed) => {
    const facts = bedFacts(bed);
    const installed = bed.devices.flatMap((device) => {
      const record = installs.installed[`bed/${bed.name}/${device.name}`];
      return record === undefined ? [] : [{ device: device.name, build: record.build, base: installs.builds[record.build] ?? null, observed_at: record.at ?? null }];
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
export function acquirePlan(beds: ManifestBed[], need: BedNeed, bedParam: string | null, addressesParam: Normalized['addresses'], leases: Record<string, LeaseEntry>, now: string, installs: Installs): { ok: true; plan: AcquirePlan } | { ok: false; failure: PlanFailure } {
  const matches = searchFields(beds, need, leases, now, installs);
  let chosen: SearchFields | undefined;
  if (bedParam !== null) {
    chosen = matches.find((m) => m.bed === bedParam);
    if (chosen === undefined) return { ok: false, failure: { code: 'test-bed.unknown_bed', message: `清单里没有自动化测试环境 ${bedParam}`, fix: 'bed 写清单里的一个自动化测试环境名，或不写按 need 选最佳匹配' } };
    if (!chosen.devices_ok) return { ok: false, failure: { code: 'test-bed.bed_short', message: `自动化测试环境 ${bedParam} 不满足需求：${chosen.conclusion}`, fix: '换 need 或换自动化测试环境' } };
    if (need.build !== undefined && chosen.build_ok === 'mismatch') return { ok: false, failure: { code: 'test-bed.build_mismatch', message: `自动化测试环境 ${bedParam} 的构建不一致：${chosen.conclusion}`, fix: '换一个最近一次观察到装着这个构建的自动化测试环境（search 的结论列出各环境的观察和时间）；要用这个环境现有的构建，去掉 need.build 再预订。test-bed 没有升级设备的动作', provenance: 'observed' } };
  } else {
    // matchNeed's order is idle first: the first fitting bed is idle when one exists, else the earliest to free; a
    // taken bed is refused by the Hub's lease grant with LEASE_UNAVAILABLE and the earliest free moment, not here.
    chosen = matches.find((m) => m.devices_ok && (need.build === undefined || m.build_ok !== 'mismatch'));
    if (chosen === undefined) {
      return { ok: false, failure: { code: 'test-bed.no_bed', message: '没有满足需求的自动化测试环境', fix: '缩小 need；各自动化测试环境的最早空闲时刻见 search 的结论' } };
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
      return { ok: false, failure: { code: 'test-bed.no_segment', message: `自动化测试环境 ${bed.name} 没有网段 ${addressesParam.segment}`, fix: 'addresses.segment 写自动化测试环境的一个网段' } };
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
      return { ok: false, failure: { code: 'test-bed.not_enough_addresses', message: `自动化测试环境 ${bed.name} 的网段 ${addressesParam.segment} 只有 ${free.length} 个空闲地址，少于 ${addressesParam.count} 个`, fix: '少要几个，或换网段' } };
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
  const parts = [`${verb} ${split.bed ?? '自动化测试环境'} 的预订 ${booking}`];
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

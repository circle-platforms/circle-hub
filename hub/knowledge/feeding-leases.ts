import { setTimeout as delay } from 'node:timers/promises';
import { IsoTime } from '../../contracts/src/common.ts';
import { LeaseDetail } from '../../contracts/src/records.ts';
import { LeaseOpSchema } from '../../contracts/generated/vocabulary.ts';
import { RECORD_SCHEMAS } from '../records/constants.ts';
import type { ActionBody, RecordStore, StoredRecord } from '../records/api.ts';
import type { LeaseService } from '../leases/api.ts';
import { runById } from '../runs/api.ts';
import { operationSchema } from './declaration-grade.ts';
import { KnowledgeError } from './errors.ts';

interface LeaseBody { groups?: unknown; predecessor?: unknown }
interface LeaseUnconfirmed { missing: string; next_action: string }
interface LeaseResult { lease: string | null; lease_id: string | null; lease_unconfirmed?: LeaseUnconfirmed }
interface HeldDevice { lease_id: string; user: string; until: string | null }
type HeldLease = Extract<import('zod').z.infer<typeof LeaseDetail>, { keys: string[] }>;
type HistoryService = Pick<LeaseService, 'history'>;
// The longest the Hub waits for the lease clock to pass a receipt before it reads the history again.
const SETTLE_WAIT_MS = 1000;
type Check<T> = { ok: true; value: T } | { ok: false; missing: string; next_action?: string };

const KEY = /^[a-z0-9][a-z0-9:._/-]{0,199}$/;
const NEXT = '重传本次采集；仍无法确定时请管理员核对台架与租约记录，不能把不确定当成有租约或无租约';

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function problem(missing: string, next_action = NEXT): Check<never> {
  return { ok: false, missing, next_action };
}

function unconfirmed(missing: string, next_action = NEXT): LeaseResult {
  return { lease: null, lease_id: null, lease_unconfirmed: { missing, next_action } };
}

function uncertain(check: Check<unknown>): LeaseResult {
  return check.ok ? unconfirmed('租约核验未完成') : unconfirmed(check.missing, check.next_action);
}

function manifest(body: LeaseBody | null | undefined): Check<Record<string, unknown> | null> {
  if (body?.groups === undefined) return { ok: true, value: null };
  if (!Array.isArray(body.groups)) return problem('运行或预订前驱的台架组结构不完整');
  const found = body.groups.flatMap(group => object(group) && object(group.manifest) && Array.isArray(group.manifest.beds) ? [group.manifest] : []);
  if (found.length > 1) return problem('预订前驱有多份台架清单，不能选择其中一份推定设备身份');
  return { ok: true, value: found[0] ?? null };
}

async function runManifest(store: RecordStore, runId: string | null): Promise<Check<Record<string, unknown> | null>> {
  const seen = new Set<string>();
  let current = runId;
  while (current !== null) {
    if (seen.has(current)) return problem('预订前驱链成环，无法确定台架清单');
    if (seen.size >= 32) return problem('预订前驱链超过 32 层，无法确定台架清单');
    seen.add(current);
    const run = await runById(store, current);
    if (!run) return problem('运行或预订前驱记录缺失，无法确定台架清单');
    const frozen = manifest(run.body);
    if (!frozen.ok) return frozen;
    if (frozen.value) return frozen;
    current = typeof run.body.predecessor === 'string' ? run.body.predecessor : null;
  }
  return { ok: true, value: null };
}

function manifestDevices(frozen: Record<string, unknown>): Check<{ names: string[]; beds: Map<string, string[]> }> {
  const names = new Set<string>();
  const beds = new Map<string, string[]>();
  for (const bed of frozen.beds as unknown[]) {
    if (!object(bed) || typeof bed.name !== 'string' || !Array.isArray(bed.devices) || beds.has(bed.name)) return problem('运行冻结的台架清单结构不完整或有重名台架，无法确定床与设备身份');
    const devices: string[] = [];
    for (const device of bed.devices) {
      if (!object(device) || typeof device.name !== 'string' || devices.includes(device.name)) return problem('运行冻结的设备清单结构不完整或有重名设备，无法确定床与设备身份');
      names.add(device.name);
      devices.push(device.name);
    }
    beds.set(bed.name, devices);
  }
  return { ok: true, value: { names: [...names].sort(), beds } };
}

function leaseDetail(record: StoredRecord<ActionBody>, key?: string): Check<{ detail: HeldLease; lease_id: string; at: number; record: StoredRecord<ActionBody> } | null> {
  if (record.integrity_note || record.schema !== RECORD_SCHEMAS.action || record.provenance !== 'observed' || record.body.action !== 'lease') {
    return problem(`租约动作 rec:${record.digest} 未通过完整性核对；请管理员核对记录后重传`);
  }
  const raw = record.body.detail;
  if (!object(raw)) return problem(`租约动作 rec:${record.digest} 的结构不完整；请管理员核对记录后重传`);
  if (raw.keys === undefined) {
    if (LeaseOpSchema.extract(['register', 'unregister']).safeParse(raw.op).success) return { ok: true, value: null };
    return problem(`租约动作 rec:${record.digest} 缺少 keys，不能确定它是否覆盖声明的设备；请管理员核对记录后重传`);
  }
  const projected = Object.fromEntries(['op', 'lease', 'keys', 'holder', 'until', 'token'].map(key => [key, raw[key]]));
  const parsed = LeaseDetail.safeParse(projected);
  if (!parsed.success || !('keys' in parsed.data)) return problem(`租约动作 rec:${record.digest} 的结构不完整；请管理员核对记录后重传`);
  if (key !== undefined && !parsed.data.keys.includes(key)) return problem(`租约动作 rec:${record.digest} 不覆盖完整设备键 ${key}；请管理员核对记录`);
  let leaseId = parsed.data.lease;
  if (parsed.data.op === 'extend' && parsed.data.keys.length > 1) {
    if (!Array.isArray(raw.key_leases)) return problem(`批量续租 rec:${record.digest} 缺逐键租约身份，不能任选摘要中的租约；请管理员核对记录`);
    const identities = new Map<string, string>();
    for (const entry of raw.key_leases) {
      if (!object(entry) || typeof entry.key !== 'string' || typeof entry.lease !== 'string' || identities.has(entry.key)) return problem(`批量续租 rec:${record.digest} 的逐键租约身份不完整`);
      identities.set(entry.key, entry.lease);
    }
    if (identities.size !== parsed.data.keys.length || parsed.data.keys.some(resource => !identities.has(resource))) return problem(`批量续租 rec:${record.digest} 的键与逐键租约身份不一致`);
    leaseId = identities.get(key!)!;
  }
  const at = IsoTime.safeParse(record.body.started_at);
  const received = IsoTime.safeParse(record.created_at);
  if (!at.success || !received.success || Date.parse(at.data) !== Date.parse(received.data) || record.body.ended_at !== record.body.started_at) {
    return problem(`租约动作 rec:${record.digest} 的发生时刻与记录时刻不一致或无效；请管理员核对记录后重传`);
  }
  if (parsed.data.until !== null && !IsoTime.safeParse(parsed.data.until).success) return problem(`租约动作 rec:${record.digest} 的到期时刻无效；请管理员核对记录后重传`);
  return { ok: true, value: { detail: parsed.data, lease_id: leaseId, at: Date.parse(at.data), record } };
}

export async function operationLease(
  store: RecordStore,
  input: { key?: string; bed?: string; device: string; user: string; capturedAt: string; receivedAt?: string },
  leases?: HistoryService,
): Promise<LeaseResult> {
  const capturedAt = IsoTime.safeParse(input.capturedAt);
  const receivedAt = IsoTime.safeParse(input.receivedAt ?? input.capturedAt);
  if (!capturedAt.success || !receivedAt.success) return unconfirmed('声明的采集时刻或 Hub 收到时刻无效；校正时钟后重新采集上传');
  const from = Date.parse(capturedAt.data), to = Date.parse(receivedAt.data);
  if (from > to) return unconfirmed('声明的采集时刻晚于 Hub 收到时刻，无法证明连续租约；校正客户端时钟后重新采集上传');
  const key = input.key ?? (input.bed ? `bed/${input.bed}/${input.device}` : undefined);
  if (!key || !KEY.test(key) || !key.startsWith('bed/') || key.split('/').length !== 3) return unconfirmed('缺完整有效的台架（床）与设备身份；在提案中写明床后重交');
  if (!leases) return unconfirmed('缺租约历史只读查询接口；管理员完成接线后重传');
  const window = { key, from: capturedAt.data, to: receivedAt.data };
  let answer = await leases.history(window);
  // A receipt the lease clock has not passed yet can still gain a lease change inside the window (round five, item 1). When
  // the clock passes it within a second (the same millisecond, or a small skew) the Hub reads again once it has: an
  // unconfirmed record would stay, since the same capture submitted again reuses it (round six, item 1).
  if (answer.settled === false) {
    const wait = Date.parse(receivedAt.data) - Date.parse(answer.asOf) + 1;
    if (wait <= SETTLE_WAIT_MS) {
      await delay(Math.max(wait, 1));
      answer = await leases.history(window);
    }
  }
  const { before, events, complete, unattributable = [], settled } = answer;
  if (!complete) return unconfirmed('声明采集至收到时刻之间的租约记录超过有界读取上限；缩小时间窗口或让管理员核对记录后重传');
  if (settled === false) return unconfirmed('Hub 的收到时刻比租约时钟（数据库时钟）的当前时刻晚一秒以上，两个时钟不一致，窗口内仍可能出现租约动作，不能确认；请管理员校准 Hub 与数据库的时钟。同一采集再交会沿用这条未确认记录，校准后重新执行并采集这一步');
  if (unattributable.length > 0) return uncertain(leaseDetail(unattributable[0]!));
  const initial = before ? leaseDetail(before, key) : null;
  if (initial && !initial.ok) return uncertain(initial);
  if (initial?.value === null) return unconfirmed('窗口前的租约动作不是设备持有记录，无法确定覆盖关系；请管理员核对记录');
  let held: HeldDevice | null = null;
  if (initial?.value) {
    if (!initial.value.detail.keys.includes(key)) return unconfirmed(`窗口前动作 rec:${initial.value.record.digest} 不覆盖完整设备键 ${key}；请管理员核对记录`);
    if (LeaseOpSchema.extract(['acquire', 'extend']).safeParse(initial.value.detail.op).success) held = { lease_id: initial.value.lease_id, user: initial.value.detail.holder.user, until: initial.value.detail.until };
    if (initial.value.at >= from) return unconfirmed('窗口前的租约动作越过了声明采集时刻；请管理员核对记录');
  }
  if (held?.until !== undefined && held.until !== null) {
    const expiry = Date.parse(held.until);
    if (expiry === from) return unconfirmed('租约到期与采集同毫秒，先后未能确认；请管理员核对租约记录后重传');
    if (expiry < from) held = null;
  }
  let previous = initial?.value?.at ?? from;
  for (const record of events) {
    const checked = leaseDetail(record, key);
    if (!checked.ok) return uncertain(checked);
    if (checked.value === null) return unconfirmed('设备窗口内混入非持有租约动作；请管理员核对记录');
    const { detail, lease_id, at } = checked.value;
    if (!detail.keys.includes(key)) return unconfirmed(`窗口内动作 rec:${record.digest} 不覆盖完整设备键 ${key}；请管理员核对记录`);
    if (at === from || at === to) return unconfirmed(`租约动作 rec:${record.digest} 与采集或收到时刻同毫秒，先后未能确认；重传或让管理员核对租约记录`);
    if (at < previous || at < from || at > to) return unconfirmed('租约动作的时间窗口或追加次序不一致；请管理员核对租约记录');
    previous = at;
    if (detail.op !== 'extend') return unconfirmed('租约在声明采集至 Hub 收到之间取得、释放或被接管，不能证明同一租约连续覆盖；核对操作与租约时间后重传');
    if (!held || held.lease_id !== lease_id || held.user !== detail.holder.user) return unconfirmed('续租记录缺少同一租约与持有者的连续前序，不能证明连续覆盖；请管理员核对后重传');
    if (held.until !== null && Date.parse(held.until) <= at) return unconfirmed('续租前已经到期或先后不明，不能证明连续覆盖；请管理员核对后重传');
    if (detail.until !== null && held.until !== null && Date.parse(detail.until) < Date.parse(held.until)) return unconfirmed('续租记录的到期时间倒退，不能证明连续覆盖；请管理员核对后重传');
    held.until = detail.until;
  }
  if (!held) return { lease: null, lease_id: null };
  if (held.until !== null && Date.parse(held.until) <= to) return unconfirmed('租约在声明采集至 Hub 收到之间到期，不能证明连续覆盖；核对操作与租约时间后重传');
  if (held.user !== input.user) return { lease: null, lease_id: null };
  return { lease: key, lease_id: held.lease_id };
}

export async function completeOperationDevice(
  store: RecordStore,
  input: { run: string | null; device: unknown; bed?: unknown; user: string; capturedAt: string; receivedAt: string; captureTimeDeclared?: boolean },
  leases?: HistoryService,
): Promise<{ device: string; bed?: string; lease: string | null; lease_id: string | null; lease_unconfirmed?: LeaseUnconfirmed } | Record<string, never>> {
  const device = input.device;
  if (device === undefined) {
    if (input.bed !== undefined) throw new KnowledgeError('台架声明必须同时带设备声明；补齐 device，或删掉 bed 后重交', { code: 'SUBMISSION_SCHEMA_VIOLATION' });
    return {};
  }
  if (typeof device !== 'string' || device.length === 0 || device.length > 200 || device.trim() !== device || /[\p{Cc}\p{Cf}]/u.test(device)) {
    throw new KnowledgeError('设备名须是 1 到 200 个字符的完整声明，不含控制字符或首尾空白；按运行绑定的台架清单修正', { code: 'SUBMISSION_SCHEMA_VIOLATION' });
  }
  const declaredBed = input.bed;
  if (declaredBed !== undefined && (typeof declaredBed !== 'string' || declaredBed.length === 0 || declaredBed.length > 200 || declaredBed.trim() !== declaredBed || /[\p{Cc}\p{Cf}]/u.test(declaredBed))) {
    throw new KnowledgeError('台架名须是 1 到 200 个字符的完整声明，不含控制字符或首尾空白；按运行绑定的台架清单修正', { code: 'SUBMISSION_SCHEMA_VIOLATION' });
  }
  const withIdentity = (result: LeaseResult, bed = declaredBed) => ({ device, ...(bed === undefined ? {} : { bed }), ...result });
  const frozen = await runManifest(store, input.run);
  if (!frozen.ok) return withIdentity(uncertain(frozen));
  let bed = declaredBed;
  if (frozen.value) {
    const inventory = manifestDevices(frozen.value);
    if (!inventory.ok) return withIdentity(uncertain(inventory));
    if (bed !== undefined && !inventory.value.beds.has(bed)) {
      throw new KnowledgeError(`台架 ${bed} 不在运行绑定的清单里；清单台架：${[...inventory.value.beds.keys()].join('、') || '（空）'}；按清单修正 bed 后重交`, { code: 'SUBMISSION_SCHEMA_VIOLATION' });
    }
    const candidates = bed === undefined ? inventory.value.names : inventory.value.beds.get(bed)!;
    if (!candidates.includes(device)) {
      const where = bed === undefined ? '运行绑定的台架清单' : `台架 ${bed}`;
      throw new KnowledgeError(`设备 ${device} 不在${where}里；设备名：${candidates.join('、') || '（空）'}；按清单修正 device 后重交`, { code: 'SUBMISSION_SCHEMA_VIOLATION' });
    }
    if (bed === undefined) {
      const matches = [...inventory.value.beds].filter(([, devices]) => devices.includes(device));
      if (matches.length !== 1) return withIdentity(unconfirmed(`设备 ${device} 同时属于多个台架 ${matches.map(([name]) => name).join('、')}，缺台架身份；在提案中写明床后重交`));
      bed = matches[0]![0];
    }
  }
  if (bed === undefined) return withIdentity(unconfirmed('运行未绑定台架清单且声明里没有床身份；在提案中写明床，或先预订台架使运行冻结清单后重交'));
  // The bed is known here (declared or derived from the frozen manifest) even when the capture time is not: keep it in the record and its identity.
  if (input.captureTimeDeclared === false) return withIdentity(unconfirmed('客户端没有明确声明采集时刻，上传时刻不能替代它；用支持 captured_at 的客户端重新采集上传，或补交带明确采集时刻的新原件', '升级采集客户端，重新采集并在 upload_file 中显式传 captured_at 后重交；本次记录保留为租约未能确认，不按上传时刻判定'), bed);
  return withIdentity(await operationLease(store, { ...input, device, bed, key: `bed/${bed}/${device}` }, leases), bed);
}

export function operationDeviceStatus(body: unknown): { device: string; bed?: string; lease: string | null; lease_id: string | null; lease_unconfirmed?: LeaseUnconfirmed } | null {
  if (!object(body) || !operationSchema(body.schema) || typeof body.device !== 'string' || body.device.length === 0) return null;
  if (body.bed !== undefined && typeof body.bed !== 'string') return null;
  if (body.lease === undefined || body.lease_id === undefined || body.lease !== null && typeof body.lease !== 'string' || body.lease_id !== null && typeof body.lease_id !== 'string') return null;
  if (body.lease === null) { if (body.lease_id !== null) return null; }
  else if (typeof body.lease_id !== 'string') return null;
  const value = body.lease_unconfirmed;
  if (value !== undefined && (!object(value) || typeof value.missing !== 'string' || typeof value.next_action !== 'string')) return null;
  const status = { device: body.device, lease: body.lease, lease_id: body.lease_id };
  const unknown: LeaseUnconfirmed | undefined = value === undefined ? undefined : { missing: value.missing as string, next_action: value.next_action as string };
  if (unknown && (body.lease !== null || body.lease_id !== null)) return null;
  return { ...status, ...(body.bed === undefined ? {} : { bed: body.bed }), ...(unknown === undefined ? {} : { lease_unconfirmed: unknown }) };
}

export function operationDeviceNote(body: unknown): string | null {
  const status = operationDeviceStatus(body);
  if (!status) return null;
  if (status.lease_unconfirmed) return `设备 ${status.device}；租约未能确认：${status.lease_unconfirmed.missing}；下一步：${status.lease_unconfirmed.next_action}`;
  return `设备 ${status.device}；${status.lease === null ? '无租约（未授权）' : `租约 ${status.lease}（记录 ${status.lease_id}）`}`;
}

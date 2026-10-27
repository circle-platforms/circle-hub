import { IsoTime } from '../../contracts/src/common.ts';
import { LeaseDetail } from '../../contracts/src/records.ts';
import { RECORD_SCHEMAS } from '../records/constants.ts';
import type { ActionBody, RecordStore, StoredRecord } from '../records/api.ts';
import { runById } from '../runs/api.ts';
import { operationSchema } from './declaration-grade.ts';
import { KnowledgeError } from './errors.ts';

interface LeaseBody { groups?: unknown; predecessor?: unknown }
interface HeldDevice { lease: string; user: string; until: string | null }

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function unavailable(message: string): never {
  throw new KnowledgeError(message, { code: 'SOURCE_UNAVAILABLE' });
}

function manifest(body: LeaseBody | null | undefined): Record<string, unknown> | null {
  if (!Array.isArray(body?.groups)) return null;
  for (const group of body.groups) {
    if (object(group) && object(group.manifest) && Array.isArray(group.manifest.beds)) return group.manifest;
  }
  return null;
}

async function runManifest(store: RecordStore, runId: string | null): Promise<Record<string, unknown> | null> {
  const seen = new Set<string>();
  let current = runId;
  while (current !== null) {
    if (seen.has(current)) unavailable('预订前驱链成环，无法确定设备清单');
    if (seen.size >= 32) unavailable('预订前驱链超过 32 层，无法确定设备清单');
    seen.add(current);
    const run = await runById(store, current);
    if (!run) unavailable('运行或预订前驱记录缺失，无法确定设备清单');
    const frozen = manifest(run.body);
    if (frozen) return frozen;
    current = typeof run?.body.predecessor === 'string' ? run.body.predecessor : null;
  }
  return null;
}

function manifestDevices(frozen: Record<string, unknown>): { names: string[]; keys: string[] } {
  const names = new Set<string>();
  const keys = new Set<string>();
  for (const bed of frozen.beds as unknown[]) {
    if (!object(bed) || typeof bed.name !== 'string' || !Array.isArray(bed.devices)) unavailable('运行冻结的台架清单结构不完整，无法核对设备名');
    for (const device of bed.devices) {
      if (!object(device) || typeof device.name !== 'string') unavailable('运行冻结的设备清单结构不完整，无法核对设备名');
      names.add(device.name);
      keys.add(`bed/${bed.name}/${device.name}`);
    }
  }
  return { names: [...names].sort(), keys: [...keys].sort() };
}

function leaseDetail(record: StoredRecord<ActionBody>) {
  if (record.integrity_note || record.schema !== RECORD_SCHEMAS.action || record.body.action !== 'lease') {
    unavailable('租约动作记录未通过完整性核对，不能把未知租约当成无租约');
  }
  const raw = record.body.detail;
  if (!object(raw) || raw.keys === undefined) return null;
  const projected = Object.fromEntries(['op', 'lease', 'keys', 'holder', 'until', 'token'].map(key => [key, raw[key]]));
  const parsed = LeaseDetail.safeParse(projected);
  if (!parsed.success || !('keys' in parsed.data)) unavailable('租约动作结构不完整，无法按采集时刻重放');
  const at = IsoTime.safeParse(record.body.started_at);
  if (!at.success) unavailable('租约动作缺有效的发生时刻，无法按采集时刻重放');
  if (parsed.data.until !== null && !IsoTime.safeParse(parsed.data.until).success) unavailable('租约动作的到期时刻无效，无法按采集时刻重放');
  return { detail: parsed.data, at: Date.parse(at.data) };
}

export async function operationLease(
  store: RecordStore,
  input: { run: string | null; device: string; user: string; capturedAt: string; keys?: readonly string[] },
): Promise<string | null> {
  const capturedAt = IsoTime.safeParse(input.capturedAt);
  if (!capturedAt.success) unavailable('原件缺有效的采集时刻，无法核对租约');
  const at = Date.parse(capturedAt.data);
  const held = new Map<string, HeldDevice>();
  const actions = await store.findMany<ActionBody>({ key: 'action.kind', values: ['lease'], kind: 'action' });
  const replay = actions.map(leaseDetail).filter(row => row !== null && row.at <= at).sort((a, b) => a!.at - b!.at);
  for (const row of replay) {
    const { detail } = row!;
    for (const key of detail.keys) {
      const current = held.get(key);
      if (detail.op === 'acquire') held.set(key, { lease: detail.lease, user: detail.holder.user, until: detail.until });
      else if (detail.op === 'extend' && current) current.until = detail.until;
      else if (detail.op === 'release' || detail.op === 'force_release' || detail.op === 'take_over') held.delete(key);
    }
  }
  const matching = [...held.entries()].filter(([key, value]) => {
    if (value.user !== input.user || value.until !== null && Date.parse(value.until) <= at) return false;
    if (input.keys) return input.keys.includes(key);
    const parts = key.split('/');
    return parts.length === 3 && parts[0] === 'bed' && parts[2] === input.device;
  });
  const leases = new Set(matching.map(([, value]) => value.lease));
  if (leases.size > 1) unavailable(`设备 ${input.device} 在采集时刻有多份候选租约，缺少可确定其一的台架绑定；不能任选一份`);
  return leases.values().next().value ?? null;
}

export async function completeOperationDevice(
  store: RecordStore,
  input: { run: string | null; device: unknown; user: string; capturedAt: string },
): Promise<{ device: string; lease: string | null } | Record<string, never>> {
  const device = input.device;
  if (device === undefined) return {};
  if (typeof device !== 'string' || device.length === 0 || device.length > 200 || device.trim() !== device || /[\p{Cc}\p{Cf}]/u.test(device)) {
    throw new KnowledgeError('设备名须是 1 到 200 个字符的完整声明，不含控制字符或首尾空白；按运行绑定的台架清单修正', { code: 'SUBMISSION_SCHEMA_VIOLATION' });
  }
  const frozen = await runManifest(store, input.run);
  let keys: string[] | undefined;
  if (frozen) {
    const inventory = manifestDevices(frozen);
    if (!inventory.names.includes(device)) {
      throw new KnowledgeError(`设备 ${device} 不在运行绑定的台架清单里；清单设备名：${inventory.names.join('、') || '（空）'}；按清单修正 device 后重交`, { code: 'SUBMISSION_SCHEMA_VIOLATION' });
    }
    keys = inventory.keys.filter(key => key.split('/')[2] === device);
  }
  return { device, lease: await operationLease(store, { ...input, device, keys }) };
}

export function operationDeviceStatus(body: unknown): { device: string; lease: string | null } | null {
  if (!object(body) || !operationSchema(body.schema) || typeof body.device !== 'string' || body.device.length === 0) return null;
  if (body.lease !== null && typeof body.lease !== 'string') return null;
  return { device: body.device, lease: body.lease };
}

export function operationDeviceNote(body: unknown): string | null {
  const status = operationDeviceStatus(body);
  if (!status) return null;
  return `设备 ${status.device}；${status.lease === null ? '无租约（未授权）' : `租约 ${status.lease}`}`;
}

// The device and bed an operation record was captured on: its identity, nothing about leases. Beds, devices and their leases
// belong to the test-bed pack (owner's decision, 2026-10-30): a record says which bed and device it touched and never claims
// a lease, as InfoTest's probe records name their bed and leave the lease empty.
import type { RecordStore } from '../records/api.ts';
import { runById } from '../runs/api.ts';
import { operationSchema } from './declaration-grade.ts';
import { KnowledgeError } from './errors.ts';

interface RunBody { groups?: unknown }

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function refuse(message: string): never {
  throw new KnowledgeError(message, { code: 'SUBMISSION_SCHEMA_VIOLATION' });
}

/** Bed name to device names, from the manifest a run or booking froze; null when it froze none. */
function frozenBeds(body: RunBody | null | undefined): Map<string, string[]> | null {
  const group = Array.isArray(body?.groups) ? body.groups[0] : undefined;
  if (!object(group) || !object(group.manifest) || !Array.isArray(group.manifest.beds)) return null;
  const beds = new Map<string, string[]>();
  for (const bed of group.manifest.beds) {
    if (!object(bed) || typeof bed.name !== 'string' || !Array.isArray(bed.devices)) continue;
    beds.set(bed.name, bed.devices.flatMap(device => object(device) && typeof device.name === 'string' ? [device.name] : []));
  }
  return beds;
}

/** The beds this run froze, or else those of the booking it continues, as `reproductionLease` reads its lease. */
async function runBeds(store: RecordStore, runId: string | null): Promise<Map<string, string[]> | null> {
  if (runId === null) return null;
  const run = await runById(store, runId);
  const own = frozenBeds(run?.body);
  if (own) return own;
  const predecessor = run?.body.predecessor;
  return typeof predecessor === 'string' ? frozenBeds((await runById(store, predecessor))?.body) : null;
}

function wellFormed(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 && value.trim() === value && !/[\p{Cc}\p{Cf}]/u.test(value);
}

/**
 * The device and bed of an operation record. With a bed manifest frozen by the run or its booking, both are checked against
 * it and the bed is taken from it when only one bed has the device; without one, the declaration is kept as written.
 */
export async function completeOperationDevice(store: RecordStore, input: { run: string | null; device: unknown; bed?: unknown }): Promise<{ device: string; bed?: string } | Record<string, never>> {
  const { device, bed: declared } = input;
  if (device === undefined) {
    if (declared !== undefined) refuse('台架声明必须同时带设备声明；补齐 device，或删掉 bed 后重交');
    return {};
  }
  if (!wellFormed(device)) refuse('设备名须是 1 到 200 个字符的完整声明，不含控制字符或首尾空白；按运行绑定的台架清单修正');
  if (declared !== undefined && !wellFormed(declared)) refuse('台架名须是 1 到 200 个字符的完整声明，不含控制字符或首尾空白；按运行绑定的台架清单修正');
  const beds = await runBeds(store, input.run);
  if (!beds) return { device, ...(declared === undefined ? {} : { bed: declared }) };
  if (declared !== undefined) {
    const devices = beds.get(declared);
    if (!devices) refuse(`台架 ${declared} 不在运行绑定的清单里；清单台架：${[...beds.keys()].join('、') || '（空）'}；按清单修正 bed 后重交`);
    if (!devices.includes(device)) refuse(`设备 ${device} 不在台架 ${declared} 里；设备名：${devices.join('、') || '（空）'}；按清单修正 device 后重交`);
    return { device, bed: declared };
  }
  const holders = [...beds].filter(([, devices]) => devices.includes(device)).map(([name]) => name);
  if (holders.length === 0) refuse(`设备 ${device} 不在运行绑定的台架清单里；设备名：${[...new Set([...beds.values()].flat())].join('、') || '（空）'}；按清单修正 device 后重交`);
  if (holders.length > 1) refuse(`设备 ${device} 同时属于台架 ${holders.join('、')}；在提案中写明 bed 后重交`);
  return { device, bed: holders[0]! };
}

/** What a view says about an operation record's device and bed, or null when it names none. */
export function operationDeviceNote(body: unknown): string | null {
  if (!object(body) || !operationSchema(body.schema) || typeof body.device !== 'string' || body.device.length === 0) return null;
  return `设备 ${body.device}${typeof body.bed === 'string' ? `（台架 ${body.bed}）` : ''}`;
}

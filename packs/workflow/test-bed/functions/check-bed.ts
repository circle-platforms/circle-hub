// The bed check (pack function, applies run): one outcome per item, recomputed from the frozen manifest, parameters
// and lease view of the run's groups with the same code the projection used (functions/conclude.ts). Support when the
// frozen fields equal the recomputation; refute (test-bed.<action>_mismatch) with the fields that differ. Grounds are
// the item's location (its bed in the inventory document) and the fields it was checked against.
import { isRecord } from './common.ts';
import { acquirePlan, factsFields, leaseRecord, manifestBeds, readParameters, searchFields, type Action, type BedNeed, type FrozenLeases } from './conclude.ts';

const TIER = 'advisory' as const;

interface CheckOutcome {
  verdict: 'support' | 'refute' | 'unknown';
  reason?: string;
  code?: string;
  statement: string;
  grounds: string[];
  tier: typeof TIER;
  item?: string;
  pointer?: string;
  data?: Record<string, unknown>;
}

interface SubjectItem {
  id?: unknown;
  location?: unknown;
  fields?: unknown;
}

/** Deep-compare two JSON values: objects by their keys in either order (the sandbox may reorder them), arrays in order. */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => sameJson(value, (b as unknown[])[index]));
  }
  if (isRecord(a) && isRecord(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) if (!sameJson(a[key], b[key])) return false;
    return true;
  }
  return false;
}

/** The members of `expected` whose frozen value differs from the recomputation, for the refute's data. */
function differing(expected: Record<string, unknown>, actual: Record<string, unknown>, keys: readonly string[]): string[] {
  return keys.filter((key) => !sameJson(expected[key], actual[key]));
}

function refute(item: string, at: number, code: string, statement: string, location: unknown, data: Record<string, unknown>): CheckOutcome {
  return { verdict: 'refute', code, statement, grounds: typeof location === 'string' ? [location] : [], tier: TIER, item, pointer: `/items/${at}/fields`, data };
}

function support(item: string, at: number, statement: string, location: unknown, data: Record<string, unknown>): CheckOutcome {
  return { verdict: 'support', statement, grounds: typeof location === 'string' ? [location] : [], tier: TIER, item, pointer: `/items/${at}/fields`, data };
}

/** The frozen run context: the groups' first record carries the manifest, the parameters and the lease view. */
function frozenOf(subject: unknown): { action: Action; need: BedNeed; bed: string | null; addresses: { segment: string; count: number } | null; manifest: unknown; leases: FrozenLeases } | null {
  const raw = isRecord(subject) && isRecord(subject.context) && Array.isArray(subject.context.groups) ? subject.context.groups[0] : undefined;
  if (!isRecord(raw) || raw.manifest === undefined) return null;
  const read = readParameters({ action: raw.action, need: raw.need, hours: (isRecord(raw.need) ? raw.need.hours : undefined), bed: raw.bed, addresses: raw.addresses });
  if ('code' in read) return null;
  const leases = isRecord(raw.leases) && typeof raw.leases.now === 'string' && Array.isArray(raw.leases.entries) ? (raw.leases as unknown as FrozenLeases) : { now: new Date(0).toISOString(), entries: [] };
  return { action: read.action, need: read.need, bed: read.bed, addresses: read.addresses, manifest: raw.manifest, leases };
}

/** Outcomes of the bed check for a subject: one per item whose fields carry an action. */
export function bedOutcomes(subject: unknown): CheckOutcome[] {
  const raw = isRecord(subject) ? subject : {};
  const items = Array.isArray(raw.items) ? (raw.items as SubjectItem[]) : [];
  const frozen = frozenOf(subject);
  if (frozen === null) return [{ verdict: 'unknown', reason: 'check_error', statement: '运行的 groups 里没有冻结的清单或参数（任务包缺陷）', grounds: [], tier: TIER }];
  const manifest = manifestBeds(frozen.manifest);
  if (!manifest.ok) return [{ verdict: 'unknown', reason: 'check_error', statement: '冻结的清单不再能解析（任务包缺陷）', grounds: [], tier: TIER }];
  const leases = leaseRecord(frozen.leases);
  const out: CheckOutcome[] = [];
  for (const [at, item] of items.entries()) {
    if (!isRecord(item) || typeof item.id !== 'string' || item.id === '' || !isRecord(item.fields)) continue;
    const id = item.id;
    const fields = item.fields;
    const action = fields.action;
    try {
      if (action === 'search') {
        const expected = searchFields(manifest.beds, frozen.need, leases, frozen.leases.now).find((f) => f.bed === fields.bed);
        if (expected === undefined) {
          out.push(refute(id, at, 'test-bed.search_mismatch', `台架 ${String(fields.bed)} 不在清单里`, item.location, { bed: fields.bed }));
          continue;
        }
        const keys = ['devices_ok', 'missing', 'earliest_free', 'build_ok', 'build_source', 'spare_devices', 'conclusion'] as const;
        const diff = differing(fields as Record<string, unknown>, expected as unknown as Record<string, unknown>, keys);
        if (diff.length > 0) {
          out.push(refute(id, at, 'test-bed.search_mismatch', `台架 ${expected.bed} 的搜索结论与冻结清单或租约视图不符（${diff.join('、')}）`, item.location, { differing: diff, expected: keys.map((k) => [k, fields[k]]), actual: keys.map((k) => expected[k as keyof typeof expected]) }));
          continue;
        }
        out.push(support(id, at, `台架 ${expected.bed}：${expected.conclusion}`, item.location, { bed: expected.bed, devices_ok: expected.devices_ok, earliest_free: expected.earliest_free, build_ok: expected.build_ok, build_source: expected.build_source, conclusion: expected.conclusion }));
        continue;
      }
      if (action === 'facts') {
        const expected = factsFields(manifest.beds).find((f) => f.bed === fields.bed);
        if (expected === undefined) {
          out.push(refute(id, at, 'test-bed.facts_mismatch', `台架 ${String(fields.bed)} 不在清单里`, item.location, { bed: fields.bed }));
          continue;
        }
        const keys = ['segments', 'listeners', 'blind', 'backends', 'unknowns'] as const;
        const diff = differing(fields as Record<string, unknown>, expected as unknown as Record<string, unknown>, keys);
        if (diff.length > 0) {
          out.push(refute(id, at, 'test-bed.facts_mismatch', `台架 ${expected.bed} 的环境事实与冻结清单不符（${diff.join('、')}）`, item.location, { differing: diff }));
          continue;
        }
        out.push(support(id, at, `台架 ${expected.bed} 的环境事实与清单一致`, item.location, { bed: expected.bed, listeners: expected.listeners, blind: expected.blind, backends: expected.backends, unknowns: expected.unknowns }));
        continue;
      }
      if (action === 'acquire') {
        const planned = acquirePlan(manifest.beds, frozen.need, frozen.bed, frozen.addresses, leases, frozen.leases.now);
        if (!planned.ok) {
          out.push(refute(id, at, 'test-bed.acquire_mismatch', `按冻结内容重算预订失败：${planned.failure.message}`, item.location, { failure: planned.failure.code }));
          continue;
        }
        const plan = planned.plan;
        const keysOfFields = Array.isArray(fields.keys) ? [...fields.keys].sort() : [];
        const keysOfPlan = [...plan.keys].sort();
        const diffs: string[] = [];
        if (fields.bed !== plan.bed) diffs.push('bed');
        if (!sameJson([...(Array.isArray(fields.devices) ? fields.devices : [])].sort(), plan.devices)) diffs.push('devices');
        if (!sameJson([...(Array.isArray(fields.addresses) ? fields.addresses : [])].sort(), plan.addresses)) diffs.push('addresses');
        if (!sameJson(keysOfFields, keysOfPlan)) diffs.push('keys');
        if (fields.ttl_seconds !== plan.ttl_seconds) diffs.push('ttl_seconds');
        if (diffs.length > 0) {
          out.push(refute(id, at, 'test-bed.acquire_mismatch', `台架 ${plan.bed} 的预订计划与冻结清单或租约视图不符（${diffs.join('、')}）`, item.location, { differing: diffs, expected_keys: keysOfFields, actual_keys: keysOfPlan }));
          continue;
        }
        out.push(support(id, at, plan.conclusion, item.location, { bed: plan.bed, devices: plan.devices, addresses: plan.addresses, keys: plan.keys, ttl_seconds: plan.ttl_seconds, conclusion: plan.conclusion }));
        continue;
      }
      out.push({ verdict: 'unknown', reason: 'check_error', statement: `条目 ${id} 的动作 ${JSON.stringify(action)} 不认识（任务包缺陷）`, grounds: typeof item.location === 'string' ? [item.location] : [], tier: TIER, item: id, pointer: `/items/${at}/fields` });
    } catch (error) {
      out.push({ verdict: 'unknown', reason: 'check_error', statement: `台架结论复核出错（任务包缺陷）：${error instanceof Error ? error.message : String(error)}`, grounds: [], tier: TIER, item: id });
    }
  }
  if (out.length === 0) out.push({ verdict: 'unknown', reason: 'check_error', statement: '台架结论复核的被判对象里没有条目（子对象构建函数没有给出 items）', grounds: [], tier: TIER });
  return out;
}

/** Pack check function: PackCheckInput of hub/rules -> check-outcome@1 array. */
export default function bedCheck(input: unknown): unknown {
  try {
    return bedOutcomes(isRecord(input) ? input.subject : undefined);
  } catch (error) {
    return [{ verdict: 'unknown', reason: 'check_error', statement: `台架结论复核出错（任务包缺陷）：${error instanceof Error ? error.message : String(error)}`, grounds: [], tier: TIER }];
  }
}

// The test-bed projection (pack function, ProjectionInput -> ProjectionOutput): read the bed inventory named document
// (doc:doc:<name>, json@1), then, per `action`:
// - search: one item per bed (matchNeed order), the conclusion of searchFields; an invalid manifest fails the whole
//   call with every problem and its pointer;
// - facts: one item per bed, the environment facts of bedFacts;
// - acquire: the chosen bed (the `bed` parameter, else the best match), one item with the lease plan, and
//   `lease_requests` for the Hub to grant (keys bed/<bed>/<device> and bed/<bed>/ip/<address>, TTL in seconds, the
//   workflow's cap; a grant failure is the Hub's LEASE_UNAVAILABLE with the earliest free moment);
// - extend / release: one item for the booking (the `booking` parameter names the booking run; the run starts with it
//   as predecessor), the lease operation on every key the frozen view marks mine, or the honest refusal
//   "你没有持有这个预订" when the lineage holds nothing.
// The frozen groups carry the raw manifest, the normalized parameters and the frozen lease view, so the check
// recomputes everything from them (functions/conclude.ts is the one computation both sides use).
import type { LeaseOp } from '../../../../contracts/generated/vocabulary.ts';
import { ownershipPlan, type OwnershipRequest } from './ownership.ts';
import { isRecord } from './common.ts';
import {
  acquirePlan,
  factsFields,
  leaseRecord,
  manifestBeds,
  readParameters,
  releasePlan,
  searchFields,
  unmatchedBuild,
  type AcquirePlan,
  type Action,
  type FrozenLeases,
  type Normalized,
  type PlanFailure,
  devicePointer,
  installsOf,
  observationsOf,
} from './conclude.ts';

interface Slot {
  slot: string;
  model: unknown;
  sha256?: unknown;
}

type LeaseRequest = OwnershipRequest | { op?: Extract<LeaseOp,'acquire'>; keys:string[] } | { op:Extract<LeaseOp,'release'>; keys:string[] };

interface Out {
  items: Array<{ id: string; label: string; summary: string; location: { parser: string; selector: string }; fields: Record<string, unknown> }>;
  groups?: Array<Record<string, unknown>>;
  warnings: Array<{ code: string; message: string }>;
  lease_requests?: LeaseRequest[];
  /** The booked devices the Hub looks at once the booking is granted (decision 112), by the inventory digest and pointer. */
  observe?: Array<{ inventory: string; device: string; label: string }>;
}

interface Failure {
  error: { code: string; message: string; fix: string; documents?: string[]; pointer?: string } & Claimed;
  warnings: Array<{ code: string; message: string }>;
}

/** The claim fields a refusal adds (D05 R[8]): the inventory fragments it rests on and whether its facts are declared. */
type Claimed = Pick<PlanFailure, 'provenance' | 'grounds' | 'pointer'>;

function failure(code: string, message: string, fix: string, warnings: Array<{ code: string; message: string }> = [], claim: Claimed = {}): Failure {
  return { error: { code, message, fix, ...claim }, warnings };
}

/** The raw index of a bed name in the document's beds array (the fragment selector's last segment). */
function bedIndex(model: unknown, name: string): number {
  const raw = isRecord(model) && Array.isArray(model.beds) ? model.beds : [];
  const at = raw.findIndex((b) => isRecord(b) && b.name === name);
  return at < 0 ? 0 : at;
}

const locationOf = (model: unknown, name: string): { parser: string; selector: string } => ({ parser: 'json@1', selector: `p/beds/${bedIndex(model, name)}` });

export default function project(input: unknown): Out | Failure {
  const params = isRecord(input) ? input : {};
  const inputs = Array.isArray(params.inputs) ? params.inputs : [];
  const slot = inputs.find((candidate): candidate is Slot => isRecord(candidate) && candidate.slot === 'inventory');
  if (slot === undefined || slot.model === null || slot.model === undefined) {
    return failure('test-bed.no_inventory', '没有自动化测试环境清单', '在 inputs.inventory 里写命名文档 {"external": "doc:doc:<名字>"}（管理员用 circle-hub doc put 发布）');
  }
  const read = readParameters(isRecord(params.parameters) ? params.parameters : {});
  if ('code' in read) return failure(read.code, read.message, read.fix, [], read.pointer === undefined ? {} : { pointer: read.pointer });
  const normalized: Normalized = read;
  const manifest = manifestBeds(slot.model);
  if (!manifest.ok) {
    return failure(
      'test-bed.manifest_invalid',
      `自动化测试环境清单有 ${manifest.problems.length} 个问题，整份拒绝`,
      manifest.problems[0] === undefined ? '按清单的形状（test-bed-manifest@1）改正后重新发布' : `${manifest.problems[0].pointer === '' ? '整份' : manifest.problems[0].pointer}：${manifest.problems[0].fix}`,
      manifest.problems.slice(0, 100).map((problem: { pointer: string; message: string; fix: string }) => ({ code: 'test-bed.manifest_problem', message: `${problem.pointer === '' ? '整份' : problem.pointer}：${problem.message}（处理：${problem.fix}）` })),
    );
  }
  const beds = manifest.beds;
  const context = isRecord(params.context) ? params.context : {};
  const frozenLeases = isRecord(context.leases) ? (context.leases as unknown as FrozenLeases) : undefined;
  const now = typeof frozenLeases?.now === 'string' ? frozenLeases.now : new Date(0).toISOString();
  const leases = leaseRecord(frozenLeases);
  const action: Action = normalized.action;
  // What the devices last showed is the installed build (decision 112); the manifest declares none any more.
  const inventory = typeof slot.sha256 === 'string' ? slot.sha256 : null;
  const observations = observationsOf(context.observations).filter((o) => o.inventory === inventory);
  const installs = installsOf(slot.model, beds, inventory, observations);

  const surface = context.surface !== undefined ? { declaration: context.surface, probes: context.probes } : undefined;
  const groups = [
    {
      action,
      need: normalized.need,
      bed: normalized.bed,
      addresses: normalized.addresses,
      booking: normalized.booking,
      reason: normalized.reason,
      devices: normalized.devices,
      manifest: slot.model,
      inventory,
      observations,
      leases: { now, entries: frozenLeases?.entries ?? [], registrations: frozenLeases?.registrations ?? [] },
      ...(surface ? { surface: context.surface, probes: context.probes } : {}),
    },
  ];
  const warnings: Array<{ code: string; message: string }> = [];
  if (beds.some((bed) => bed.devices.some((device) => device.installed !== undefined && device.installed !== null))) {
    warnings.push({ code: 'test-bed.declared_install_ignored', message: '清单里写了在装构建，现在不再使用：以设备上实际看到的为准（搜索给出最近一次观察和它的时间，预订时 Hub 会在设备上看一次）' });
  }

  if (action === 'search') {
    const fields = searchFields(beds, normalized.need, leases, now, installs, frozenLeases);
    const gap = unmatchedBuild(beds, normalized.need, leases, now, installs);
    if (gap) warnings.push({ code: 'test-bed.no_matching_build', message: `${gap.missing}。下一步：${gap.fix}` });
    return {
      items: fields.map((f) => ({
        id: f.bed,
        label: f.bed,
        summary: f.conclusion,
        location: locationOf(slot.model, f.bed),
        fields: { action, ...f },
      })),
      groups,
      warnings,
    };
  }
  if (action === 'facts') {
    const fields = factsFields(beds, installs, frozenLeases, surface);
    return {
      items: fields.map((f) => ({
        id: f.bed,
        label: f.bed,
        summary: `监听 ${f.listeners.length}，盲地址 ${f.blind.length}，后端 ${f.backends.length}，网段 ${f.segments.length}${f.installed.length > 0 ? `，最近观察到的构建 ${f.installed.length} 项（观察，各带时间）` : ''}；${f.occupancy.join('；')}`,
        location: locationOf(slot.model, f.bed),
        fields: { action, ...f },
      })),
      groups,
      warnings,
    };
  }
  if(action==='register'||action==='unregister'||action==='force_release'){
    const planned=ownershipPlan(beds,normalized,frozenLeases);
    if(!planned.ok)return failure(planned.failure.code,planned.failure.message,planned.failure.fix);
    return {items:[{id:planned.fields.bed,label:planned.fields.bed,summary:planned.fields.conclusion,location:locationOf(slot.model,planned.fields.bed),fields:planned.fields}],groups:[{...groups[0],lease_requests:[planned.request]}],warnings,lease_requests:[planned.request]};
  }
  if (action === 'release') {
    const booking = normalized.booking as string;
    const held = releasePlan(frozenLeases, booking);
    if (!held.ok) return failure(held.failure.code, held.failure.message, held.failure.fix);
    const plan = held.plan;
    const request: LeaseRequest = {op:'release',keys:plan.keys};
    return {
      items: [
        {
          id: plan.bed ?? 'booking',
          label: `释放预订 ${booking}`,
          summary: plan.conclusion,
          location: plan.bed !== null ? locationOf(slot.model, plan.bed) : { parser: 'json@1', selector: 'p/' },
          fields: { action, booking, bed: plan.bed, devices: plan.devices, addresses: plan.addresses, keys: plan.keys, conclusion: plan.conclusion },
        },
      ],
      groups: [{ ...groups[0], lease_requests: [request] }],
      warnings,
      lease_requests: [request],
    };
  }
  // acquire
  const planned = acquirePlan(beds, normalized.need, normalized.bed, normalized.addresses, leases, now, installs);
  if (!planned.ok) {
    // A refusal about a named bed rests on that bed's fragment of the frozen inventory.
    const named = normalized.bed !== null && beds.some((bed) => bed.name === normalized.bed) && typeof slot.sha256 === 'string';
    const grounds = named ? [`src:${slot.sha256 as string}/json@1/p/beds/${bedIndex(slot.model, normalized.bed as string)}`] : [];
    return failure(planned.failure.code, planned.failure.message, planned.failure.fix, [], { ...(planned.failure.provenance ? { provenance: planned.failure.provenance } : {}), ...(grounds.length > 0 ? { grounds } : {}) });
  }
  const plan: AcquirePlan = planned.plan;
  return {
    items: [
      {
        id: plan.bed,
        label: `预订 ${plan.bed}`,
        summary: plan.conclusion,
        location: locationOf(slot.model, plan.bed),
        fields: { action, bed: plan.bed, devices: plan.devices, addresses: plan.addresses, keys: plan.keys, conclusion: plan.conclusion },
      },
    ],
    groups: [{ ...groups[0], lease_requests: [{ keys: plan.keys }] }],
    warnings,
    lease_requests: [{ keys: plan.keys }],
    // The Hub looks at every booked device once the booking is granted; it probes those an executor has a version seat for.
    observe: inventory === null ? [] : plan.devices.flatMap((name) => {
      const pointer = devicePointer(slot.model, plan.bed, name);
      return pointer === null ? [] : [{ inventory, device: pointer, label: `${plan.bed}/${name}` }];
    }),
  };
}

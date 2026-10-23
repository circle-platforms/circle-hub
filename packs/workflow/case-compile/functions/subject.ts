// Frozen raw inputs are revalidated on every check. This pack only verifies the authored plan slots.
import { isRecord } from './text.ts';
import { parseRuntimeContract } from './runtime-contract.ts';
import { parseProfile, allowedCall } from './profile.ts';
import { parseManifest } from './manifest.ts';
import { readSlots } from './slots.ts';
import { bindArguments } from './binding.ts';
import type { LeaseRow } from './bed.ts';
export interface PlanSubject { item: string; location: string | null; data: unknown; contract: unknown; profile: unknown; manifest: unknown; leases: LeaseRow[]; now: string }
export function planDataOf(record: Record<string, unknown>): unknown {
  const slots = isRecord(record.slots) ? record.slots : {};
  const plan = Array.isArray(slots.plan) ? slots.plan[0] : slots.plan;
  return isRecord(plan) ? isRecord(plan.data) ? plan.data : plan : undefined;
}
export function planSubject(input: unknown): PlanSubject {
  const raw = isRecord(input) ? input : {};
  const context = isRecord(raw.context) ? raw.context : {};
  const groups = Array.isArray(context.groups) ? context.groups : [];
  const group = groups.find((v) => isRecord(v) && v.kind === 'case-compile');
  const frozen = isRecord(group) ? group : {};
  const leases = isRecord(frozen.leases) ? frozen.leases : {};
  const item = isRecord(raw.item) ? raw.item : {};
  return { item: typeof raw.item === 'string' ? raw.item : typeof item.id === 'string' ? item.id : '', location: typeof raw.location === 'string' ? raw.location : typeof item.location === 'string' ? item.location : null, data: planDataOf(raw), contract: frozen.contract, profile: frozen.profile, manifest: frozen.manifest, leases: Array.isArray(leases.entries) ? leases.entries as LeaseRow[] : [], now: typeof leases.now === 'string' ? leases.now : new Date(0).toISOString() };
}
export function commandSubject(input: unknown): unknown {
  const subject = planSubject(input); const read = readSlots(subject.data); const contract = parseRuntimeContract(subject.contract); const beds = parseManifest(subject.manifest);
  const profile = contract.ok && beds.ok ? parseProfile(subject.profile, contract.contract, beds.beds) : null;
  const phrases: string[] = [];
  if (read.ok && contract.ok && profile?.ok) for (const step of read.slots.steps) {
    const allowed = allowedCall(profile.profile, step.object, step.method);
    const method = contract.contract.enabled.find((v) => v.object === step.object && v.method === step.method);
    if (!allowed || !method) continue;
    for (const v of bindArguments(method, step, '').values) if (allowed.parameters[v.name] === 'device_cli' && typeof v.value === 'string') phrases.push(v.value);
  }
  return { item: subject.item, location: subject.location, phrases, negative: false };
}
export function quoteSubject(input: unknown): unknown {
  const subject = planSubject(input); const read = readSlots(subject.data);
  return { item: subject.item, quotes: read.ok ? read.slots.expects.map((v) => v.quote) : [] };
}

/** Workbook input is frozen by projection; only original metadata and current submitted slots are joined here. */
export function workbookSubject(input: unknown): unknown {
  const raw = isRecord(input) ? input : {}; const context = isRecord(raw.context) ? raw.context : {};
  const groups = Array.isArray(context.groups) ? context.groups : []; const group = groups.find((v) => isRecord(v) && v.kind === 'case-compile');
  const frozen = isRecord(group) ? group : {}; const item = isRecord(raw.item) ? raw.item : {};
  return { ...planSubject(input), fields: isRecord(item.fields) ? item.fields : {}, workbook: frozen.workbook ?? null, generation: frozen.generation ?? null, manifest_sha256: frozen.manifest_sha256 ?? null };
}

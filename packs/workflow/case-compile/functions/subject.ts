// Frozen raw inputs are revalidated on every check. This pack only verifies the authored plan slots.
import { checkContractShape } from './checks.ts';
import { isRecord } from './text.ts';
import { parseRuntimeContract } from './runtime-contract.ts';
import { parseProfile, allowedCall } from './profile.ts';
import { parseManifest } from './manifest.ts';
import { readSlots } from './slots.ts';
import { bindArguments, hasBalancedCommandText } from './binding.ts';
import type { LeaseRow } from './bed.ts';
export interface PlanSubject { command_identities?:unknown; item: string; location: string | null; data: unknown; contract: unknown; profile: unknown; manifest: unknown; leases: LeaseRow[]; now: string; case_texts: string[] }
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
  return { command_identities:isRecord(item.fields)?item.fields.command_identities:undefined,case_texts: authoredCaseTexts(item.fields), item: typeof raw.item === 'string' ? raw.item : typeof item.id === 'string' ? item.id : '', location: typeof raw.location === 'string' ? raw.location : typeof item.location === 'string' ? item.location : null, data: planDataOf(raw), contract: frozen.contract, profile: frozen.profile, manifest: frozen.manifest, leases: Array.isArray(leases.entries) ? leases.entries as LeaseRow[] : [], now: typeof leases.now === 'string' ? leases.now : new Date(0).toISOString() };
}
export function commandSubject(input:unknown):unknown{return planSubject(input);}
export function quoteSubject(input: unknown): unknown {
  const subject = planSubject(input); const outcomes = checkContractShape({subject}); const gap = outcomes.find(v => v.verdict === 'unknown'); if (gap) return { item: subject.item, location: subject.location, missing: gap.missing, reason: gap.reason }; const blocked=outcomes.filter(v=>v.verdict==='refute'&&v.pointer&&v.code).map(v=>({check:'contract_shape',pointer:v.pointer!,code:v.code!}));if(blocked.length)return {blocked}; const read = readSlots(subject.data); const contract = parseRuntimeContract(subject.contract); const beds = parseManifest(subject.manifest);
  const profile = contract.ok && beds.ok ? parseProfile(subject.profile, contract.contract, beds.beds) : null;
  // quote@1 has no required option: an explicit missing-field record produces missing_input, never a fictitious quote.
  if (!read.ok || !contract.ok || !beds.ok || !profile?.ok) return { item: subject.item, quotes: [{}], unreadable: true };
  return { item: subject.item, quotes: read.slots.expects.map((v) => v.quote) };
}

/** Authored source text is distinct from the model's final step values. */
export function authoredCaseTexts(value: unknown): string[] {
  const fields = isRecord(value) ? value : {}; const out: string[] = [];
  if (typeof fields.title === 'string') out.push(fields.title);
  if (Array.isArray(fields.expected)) for (const v of fields.expected) if (typeof v === 'string') out.push(v);
  if (Array.isArray(fields.steps)) for (const step of fields.steps) if (isRecord(step)) { if (typeof step.text === 'string') out.push(step.text); if (Array.isArray(step.expected)) for (const v of step.expected) if (typeof v === 'string') out.push(v); }
  return out;
}

/** Workbook input is frozen by projection; only original metadata and current submitted slots are joined here. */
export function workbookSubject(input: unknown): unknown {
  const raw = isRecord(input) ? input : {}; const context = isRecord(raw.context) ? raw.context : {};
  const groups = Array.isArray(context.groups) ? context.groups : []; const group = groups.find((v) => isRecord(v) && v.kind === 'case-compile');
  const frozen = isRecord(group) ? group : {}; const item = isRecord(raw.item) ? raw.item : {};
  return { ...planSubject(input), fields: isRecord(item.fields) ? item.fields : {}, workbook: frozen.workbook ?? null, generation: frozen.generation ?? null, manifest_sha256: frozen.manifest_sha256 ?? null };
}

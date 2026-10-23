// Subject builders for the case-compile checks: the item's submitted plan (the plan slot's claim data), plus the
// frozen run context — the RAW contract and manifest documents (the checks re-parse and recompute everything, and
// the raw documents serialize into samples, which parsed values with bigints never could) and the frozen lease view.
// commandSubject collects the command-line parameter values for catalog@1; quoteSubject the expected results' quotes.
import { isRecord } from './text.ts';
import { parseContract } from './contract.ts';
import { parseManifest } from './manifest.ts';
import { readSlots } from './plan.ts';
import type { LeaseRow } from './bed.ts';

export interface PlanSubject {
  item: string;
  location: string | null;
  /** The submitted claim data of the plan slot (raw). */
  data: unknown;
  /** The raw compile-contract@1 document, as frozen on the run. */
  contract: unknown;
  /** The raw test-bed-manifest@1 document, as frozen on the run. */
  manifest: unknown;
  leases: LeaseRow[];
  now: string;
}

function groupOf(input: unknown): { [key: string]: unknown } | null {
  const raw = isRecord(input) ? input : {};
  const context = isRecord(raw.context) ? raw.context : {};
  const groups = Array.isArray(context.groups) ? context.groups : [];
  const found = groups.find((group) => isRecord(group) && group.kind === 'case-compile');
  return isRecord(found) ? found : null;
}

function itemIdOf(record: { [key: string]: unknown }): string {
  if (typeof record.item === 'string') return record.item;
  if (isRecord(record.item) && typeof record.item.id === 'string') return record.item.id;
  return '';
}

function locationOf(record: { [key: string]: unknown }): string | null {
  if (typeof record.location === 'string') return record.location;
  if (isRecord(record.item) && typeof record.item.location === 'string') return record.item.location;
  return null;
}

/** The submitted claim data of the plan slot: claim.data when present, else the claim itself. */
export function planDataOf(record: { [key: string]: unknown }): unknown {
  const slots = isRecord(record.slots) ? record.slots : {};
  const plan = Array.isArray(slots.plan) ? slots.plan[0] : slots.plan;
  if (!isRecord(plan)) return undefined;
  return isRecord(plan.data) ? plan.data : plan;
}

export function planSubject(input: unknown): PlanSubject {
  const record = isRecord(input) ? input : {};
  const group = groupOf(input);
  const leases = group !== null && isRecord(group.leases) && Array.isArray(group.leases.entries) ? (group.leases.entries as LeaseRow[]) : [];
  const now = group !== null && isRecord(group.leases) && typeof group.leases.now === 'string' ? group.leases.now : new Date(0).toISOString();
  return {
    item: itemIdOf(record),
    location: locationOf(record),
    data: planDataOf(record),
    contract: group?.contract,
    manifest: group?.manifest,
    leases,
    now,
  };
}

/** The command lines of the plan (the values of the contract's command parameters) for the catalog@1 interpreter. */
export function commandSubject(input: unknown): unknown {
  const subject = planSubject(input);
  const phrases: string[] = [];
  const read = readSlots(subject.data);
  const contractRead = isRecord(subject.contract) ? parseContract(subject.contract) : null;
  if (read.ok && contractRead !== null && contractRead.ok) {
    for (const step of read.slots.steps) {
      const method = contractRead.contract.objects.find((candidate) => candidate.name === step.object)?.methods.find((candidate) => candidate.name === step.method);
      for (const param of method?.params ?? []) {
        if (!param.command) continue;
        const value = step.params[param.name] ?? param.default;
        if (typeof value === 'string' && value.trim() !== '') phrases.push(value.trim());
      }
    }
  }
  return { item: subject.item, location: subject.location, phrases, negative: false };
}

/** The expected results' quotes for the quote@1 interpreter. */
export function quoteSubject(input: unknown): unknown {
  const subject = planSubject(input);
  const quotes: Array<{ reference: string; text: string }> = [];
  const read = readSlots(subject.data);
  if (read.ok) for (const expect of read.slots.expects) if (expect.quote.reference !== '' && expect.quote.text !== '') quotes.push(expect.quote);
  return { item: subject.item, quotes };
}

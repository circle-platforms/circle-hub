// Building check outcomes (V01): one place for statements, tiers, grounds and the item an outcome is about.
import { CORE_VIOLATION_CODES, PROTOCOL_CODES, type CoreViolationCode, type ProtocolCode } from '../../contracts/generated/protocol.ts';
import type { CheckTier, Reason } from '../../contracts/generated/vocabulary.ts';
import { labelOf } from '../../contracts/generated/vocabulary.ts';
import { ReferenceUri } from '../../contracts/src/reference.ts';
import type { CheckOutcome } from '../../contracts/src/tables.ts';
import { getAt } from './json.ts';

/** What every outcome of one check on one subject shares. */
export interface OutcomeBase {
  tier: CheckTier;
  item?: string;
  grounds: string[];
}

export function isReferenceUri(value: unknown): value is string {
  return typeof value === 'string' && ReferenceUri.safeParse(value).success;
}

/** A non-empty contract clause (C05 R[1]). */
export const hasBasis = (basis: unknown): boolean => typeof basis === 'string' && basis.trim() !== '';

/** Tier of a table's outcomes: its own, else blocking only when it names the contract clause it relies on (C05 R[1]). */
export function tierOf(table: { tier?: CheckTier; basis?: string }): CheckTier {
  return table.tier ?? (hasBasis(table.basis) ? 'blocking' : 'advisory');
}

/** Item identity and location ground read through a table's `item` and `location` pointers. */
export function baseFor(root: unknown, table: { tier?: CheckTier; basis?: string; item?: string; location?: string }): OutcomeBase {
  const base: OutcomeBase = { tier: tierOf(table), grounds: [] };
  if (table.item !== undefined) {
    const found = getAt(root, table.item);
    if (found.found && (typeof found.value === 'string' || typeof found.value === 'number')) base.item = String(found.value);
  }
  if (table.location !== undefined) {
    const found = getAt(root, table.location);
    if (found.found && isReferenceUri(found.value)) base.grounds.push(found.value);
  }
  return base;
}

const unique = (values: string[]): string[] => [...new Set(values)];

interface Extra {
  missing?: string;
  pointer?: string;
  grounds?: string[];
  data?: Record<string, unknown>;
}

function shape(base: OutcomeBase, outcome: Omit<CheckOutcome, 'tier' | 'grounds'>, extra: Extra): CheckOutcome {
  const out: CheckOutcome = { ...outcome, grounds: unique([...(extra.grounds ?? []), ...base.grounds]), tier: base.tier };
  if (base.item !== undefined) out.item = base.item;
  if (extra.pointer !== undefined) out.pointer = extra.pointer;
  if (extra.data !== undefined) out.data = extra.data;
  return out;
}

export function support(base: OutcomeBase, statement: string, extra: Extra = {}): CheckOutcome {
  return shape(base, { verdict: 'support', statement }, extra);
}

/** Refutation with a core violation code; the statement starts with the registered description of the code. */
export function refute(base: OutcomeBase, code: CoreViolationCode, detail: string, extra: Extra = {}): CheckOutcome {
  return shape(base, { verdict: 'refute', code, statement: `${CORE_VIOLATION_CODES[code].when}：${detail}` }, extra);
}

/** Refutation with a protocol code (quotation mismatch). */
export function refuteProtocol(base: OutcomeBase, code: ProtocolCode, detail: string, extra: Extra = {}): CheckOutcome {
  return shape(base, { verdict: 'refute', code, statement: `${PROTOCOL_CODES[code].when}：${detail}` }, extra);
}

/** Unknown with its reason (V01 R[2]); the statement starts with the reason label. */
export function unknown(base: OutcomeBase, reason: Reason, detail: string, extra: Extra = {}): CheckOutcome {
  return shape(base, { verdict: 'unknown', reason, missing: extra.missing ?? detail, statement: `${labelOf('verdict', 'unknown')}（${labelOf('reason', reason)}）：${detail}` }, extra);
}

/** Code-point quoted value for statements. */
export function quoted(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
  const chars = [...text];
  return `“${chars.length > 80 ? `${chars.slice(0, 80).join('')}…` : text}”`;
}

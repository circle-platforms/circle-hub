// Source validation and exact lookup for the model-owned registry. No message interpretation or identity inference.
import type { CallErrorCategory, PermissionRole } from '../generated/vocabulary.ts';

export type CallErrorReasonClassification = { readonly category: CallErrorCategory } | { readonly conclusion: true } | { readonly unknown: true };
export interface CallErrorReasonRule {
  readonly codes: readonly string[];
  readonly classification: CallErrorReasonClassification;
  readonly next_by_role: Readonly<Record<PermissionRole, string | null>>;
}

export function validateCallErrorReasonRegistry(
  rows: unknown, reasons: readonly string[], categories: readonly string[], roles: readonly string[],
): string[] {
  const problems: string[] = [];
  if (!Array.isArray(rows)) return ['callErrorReasons must be an array'];
  const seen = new Set<string>();
  const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
  for (const [index, row] of rows.entries()) {
    const path = `callErrorReasons[${index}]`;
    if (!object(row)) { problems.push(`${path} must be an object`); continue; }
    if (typeof row.reason !== 'string' || !reasons.includes(row.reason) || seen.has(row.reason)) problems.push(`${path}.reason must uniquely match call_error_reason`);
    else seen.add(row.reason);
    if (!Array.isArray(row.codes) || !row.codes.length || row.codes.some(code => typeof code !== 'string' || !code.trim()) || new Set(row.codes).size !== row.codes.length) problems.push(`${path}.codes must be distinct exact machine codes`);
    const value = row.classification;
    if (!object(value) || Object.keys(value).length !== 1 || !(
      typeof value.category === 'string' && categories.includes(value.category) || value.conclusion === true || value.unknown === true
    )) problems.push(`${path}.classification must select one call category, conclusion or unknown`);
    const next = row.next_by_role;
    if (!object(next) || Object.keys(next).length !== roles.length || roles.some(role => !Object.hasOwn(next, role) || !(
      typeof next[role] === 'string' && (next[role] as string).trim().length > 0 || next[role] === null && object(value) && !('category' in value)
    ))) problems.push(`${path}.next_by_role must cover every actual permission role`);
  }
  for (const reason of reasons) if (!seen.has(reason)) problems.push(`callErrorReasons missing ${reason}`);
  return problems;
}

/** A false permission boolean cannot supply a reason: only this exact, source-selected tuple is looked up. */
export function resolveCallErrorReasonRule(
  registry: Readonly<Record<string, CallErrorReasonRule>>, code: string, reason: string, actualRole: PermissionRole,
): { classification: CallErrorReasonClassification; nextAction: string | null } | null {
  if (!Object.hasOwn(registry, reason)) return null;
  const rule = registry[reason];
  if (!rule.codes.includes(code) || !Object.hasOwn(rule.next_by_role, actualRole)) return null;
  return { classification: rule.classification, nextAction: rule.next_by_role[actualRole] };
}

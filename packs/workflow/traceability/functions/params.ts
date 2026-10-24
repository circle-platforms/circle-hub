// The run parameters of the pack (workflow.json declares them): the defect statuses to include. The engine checks the value
// against its schema; this reader is defensive anyway (a direct call, a sample) and reports what it ignores.
import {RELEASE_STATUS} from './generated/vocabulary.ts';
import { compareText } from './text.ts';

export type Parameters = { statuses: string[]; ignored: string[] };

export const STATUSES = RELEASE_STATUS;
export const DEFAULT_STATUSES: readonly string[] = [...STATUSES].sort(compareText);

/** Reads the statuses parameter: absent is the default (fixed and known); anything else is refused by the caller. */
export function readStatuses(raw: unknown): Parameters {
  if (raw === undefined) return { statuses: [...DEFAULT_STATUSES], ignored: [] };
  const valid = Array.isArray(raw) && raw.length > 0 && raw.every((v) => (STATUSES as readonly string[]).includes(v as string)) && new Set(raw).size === raw.length;
  if (!valid) return { statuses: [...DEFAULT_STATUSES], ignored: ['statuses'] };
  return { statuses: [...new Set(raw as string[])].sort(compareText), ignored: [] };
}

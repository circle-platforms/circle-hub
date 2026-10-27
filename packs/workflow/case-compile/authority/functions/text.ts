import type { Verdict, CheckTier, Reason as UnknownReason } from '../../../../../contracts/generated/vocabulary.ts';
// Shared helpers of the case-compile pack functions (pure TypeScript, no imports outside the pack).

export const PACK = 'case-compile';

export function isRecord(value: unknown): value is { [key: string]: unknown } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`;
}

export function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

export interface PackWarning {
  code: string;
  message: string;
}

export function refusal(code: string, message: string, fix: string, warnings: PackWarning[] = []): { error: { code: string; message: string; fix: string }; warnings: PackWarning[] } {
  return { error: { code: `${PACK}.${code}`, message, fix }, warnings };
}

/** A check outcome, statement always closed by the two markers (the synthetic one only when the contract is synthetic). */
export interface Outcome {
  judgment_sources?:string[];
  missing?: string;
  verdict: Extract<Verdict, 'support' | 'refute' | 'unknown'>;
  code?: string;
  statement: string;
  grounds: string[];
  tier: CheckTier;
  reason?: Extract<UnknownReason, 'missing_input' | 'integrity_unproven' | 'check_error' | 'output_failed'>;
  item?: string;
  /** Where the judged content sits in the subject (the /data/... forms of this pack, or the interpreter's own). */
  pointer?: string;
  data?: { [key: string]: unknown };
}

/** The two markers every conclusion of this pack carries (task page A.5): never "可以运行". */
export function markers(synthetic: boolean, identity?: { runtimeVersion: string; digest: string }): string {
  const basis = synthetic ? '按合成合约核对' : '按发布的运行器合约核对';
  const who = identity ? `；运行时 ${identity.runtimeVersion}；身份 ${(identity as { pinned?: { identity: string } }).pinned?.identity.slice(0, 12) ?? identity.digest.slice(0, 12)}` : '';
  return `（${basis}${who}；不证明在真实设备上跑得通）`;
}

export function outcome(kind: Outcome['verdict'], statement: string, tier: Outcome['tier'], item: string, extras: Partial<Outcome> = {}): Outcome {
  return { verdict: kind, statement, grounds: [], tier, item, ...extras };
}

/** Wraps a check so a defect of the pack itself is a check_error, never an exception across the boundary. */
export function guarded(run: () => unknown, failure: (message: string) => unknown): unknown {
  try {
    return run();
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  }
}

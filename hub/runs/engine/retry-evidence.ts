// Persist generated action/reason values, never the sandbox's internal control codes or startup classifications.
import type { ActionKind, Reason } from '../../../contracts/generated/vocabulary.ts';
import type { SandboxOptions } from '../../rules/api.ts';
type FunctionAttempt = Parameters<NonNullable<SandboxOptions['onAttempt']>>[0];
import type { ReadAttempt } from './retry-read.ts';

export function attemptEvidence(operation: ActionKind, component: string, attempt: FunctionAttempt | ReadAttempt,
  metadata: Record<string, unknown> = {}): Record<string, unknown> {
  const common = { ...metadata, operation, component, attempt: attempt.attempt, durationMs: attempt.durationMs,
    delayMs: attempt.delayMs, retry: attempt.retry };
  if ('timeoutMs' in attempt) {
    const reason: Reason | undefined = attempt.code === undefined ? undefined : attempt.code === 'SANDBOX_TIMEOUT' ? 'timeout'
      : attempt.code === 'SANDBOX_UNAVAILABLE' && attempt.reason === 'queue_full' ? 'budget_exhausted' : 'check_error';
    return {...common, timeoutMs:attempt.timeoutMs, ...(reason ? {reason} : {})};
  }
  return {...common, ...(attempt.reason ? {reason:attempt.reason} : {})};
}

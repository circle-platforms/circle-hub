// Local, integrity-checked reference reads: fixed registered reasons and a bounded backoff, never free-text failures.
import { setTimeout } from 'node:timers/promises';
import type { ProtocolCode } from '../../../contracts/generated/protocol.ts';
import type { Reason } from '../../../contracts/generated/vocabulary.ts';

export type ReadFailureReason = Extract<Reason, 'check_error' | 'integrity_unproven' | 'missing_input' | 'budget_exhausted'>
  | Extract<ProtocolCode, 'SOURCE_UNAVAILABLE' | 'REFERENCE_UNRESOLVED'>;
export interface ReadAttempt {
  attempt: number;
  durationMs: number;
  delayMs: number;
  retry: boolean;
  reason?: ReadFailureReason;
}

export async function retryRead<T>(read: () => Promise<T>, classify: (value: T) => { reason: ReadFailureReason; retry: boolean } | null,
  observe?: (attempt: ReadAttempt) => void): Promise<T> {
  const notify = (attempt: ReadAttempt): void => { try { observe?.(attempt); } catch { /* Diagnostics are inert. */ } };
  for (let attempt = 1; ; attempt++) {
    const started = Date.now();
    let value: T;
    try { value = await read(); }
    catch (error) {
      const retry = attempt < 3; const delayMs = retry ? 50 * 2 ** (attempt - 1) : 0;
      notify({ attempt, durationMs: Date.now() - started, delayMs, retry, reason: 'check_error' });
      if (!retry) throw error;
      await setTimeout(delayMs); continue;
    }
    const failure = classify(value);
    const retry = failure?.retry === true && attempt < 3;
    const delayMs = retry ? 50 * 2 ** (attempt - 1) : 0;
    notify({ attempt, durationMs: Date.now() - started, delayMs, retry, ...(failure ? { reason: failure.reason } : {}) });
    if (!retry) return value;
    await setTimeout(delayMs);
  }
}

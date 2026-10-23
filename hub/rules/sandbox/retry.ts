// Retry only transient parent-side sandbox failures. Each attempt keeps the caller's resolved resource limits.
import { setTimeout } from 'node:timers/promises';
import { SandboxError, type SandboxErrorCode } from './errors.ts';

const exhausted = new WeakSet<SandboxError>();
/** Parent-only identity marker: a completed retry policy, never sent to a pack or record. */
export function isExhaustedFunctionFailure(error: unknown): boolean { return error instanceof SandboxError && exhausted.has(error); }

export interface FunctionAttempt {
  attempt: number;
  timeoutMs: number;
  durationMs: number;
  delayMs: number;
  retry: boolean;
  code?: SandboxErrorCode;
  reason?: string;
}

export function transientFunctionFailure(error: unknown): error is SandboxError {
  return error instanceof SandboxError && (error.code === 'SANDBOX_TIMEOUT'
    || (error.code === 'SANDBOX_UNAVAILABLE' && ['queue_full', 'stopping', 'spawn_failed'].includes(String(error.detail.reason))));
}

export async function retryFunction<T>(execute: () => Promise<T>, timeoutMs: number, observe?: (attempt: FunctionAttempt) => void, options: { retryWallTimeout?: boolean } = {}): Promise<T> {
  const notify = (attempt: FunctionAttempt): void => { try { observe?.(attempt); } catch { /* Diagnostics cannot change execution. */ } };
  let timeouts = 0;
  for (let attempt = 1; ; attempt++) {
    const started = Date.now();
    try {
      const value = await execute();
      notify({ attempt, timeoutMs, durationMs: Date.now() - started, delayMs: 0, retry: false });
      return value;
    } catch (error) {
      const wallTimeout = error instanceof SandboxError && error.code === 'SANDBOX_TIMEOUT' && error.detail.limit === 'time';
      const retry = attempt < 3 && transientFunctionFailure(error)
        && (error.code !== 'SANDBOX_TIMEOUT' || (wallTimeout && options.retryWallTimeout === true && timeouts++ === 0));
      const delayMs = retry ? 50 * 2 ** (attempt - 1) : 0;
      notify({ attempt, timeoutMs, durationMs: Date.now() - started, delayMs, retry,
        ...(error instanceof SandboxError ? { code: error.code,
          ...(typeof error.detail.reason === 'string' ? { reason: error.detail.reason } : {}) } : {}) });
      if (!retry) { if (transientFunctionFailure(error)) exhausted.add(error); throw error; }
      await setTimeout(delayMs);
    }
  }
}

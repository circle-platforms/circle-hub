// One evaluation-scoped batch per pure check function. Every result still passes runCheck independently.
import { callPackFunction, callPackFunctionBatch, DEFAULT_LIMITS, SandboxError, type PackFunctionTarget, type SandboxOptions, type SandboxLimits, type SandboxResult } from '../../rules/api.ts';
import { CHECK_PARALLELISM } from './deps.ts';
import { mapLimited } from './util.ts';

type Call = { target: PackFunctionTarget; input: unknown; limits: Partial<SandboxLimits>; options: SandboxOptions;
  resolve: (result: SandboxResult) => void; reject: (error: unknown) => void };
type Group = { ids: string[]; arrived: Set<string>; calls: Map<string, Call>; started: boolean };

/** Split ordered JSON inputs at the serialized array's UTF-8 byte cap; an oversized item stays alone for its own error boundary. */
export function splitInputBatches<T>(inputs: readonly T[], inputBytes: number): T[][] {
  const batches: T[][] = []; let batch: T[] = []; let bytes = 2;
  for (const input of inputs) {
    const itemBytes = Buffer.byteLength(JSON.stringify([input])) - 2;
    const separatorBytes = batch.length ? 1 : 0;
    if (batch.length && bytes + separatorBytes + itemBytes > inputBytes) {
      batches.push(batch); batch = []; bytes = 2;
    }
    batch.push(input); bytes += (batch.length > 1 ? 1 : 0) + itemBytes;
    if (bytes > inputBytes) { batches.push(batch); batch = []; bytes = 2; }
  }
  if (batch.length) batches.push(batch);
  return batches;
}

export function createFunctionBatches(optionsFor: (check: string, target: PackFunctionTarget, count: number) => SandboxOptions, onCancel?: (error: unknown) => void) {
  const groups = new Map<string, Group>(); let cancelled = false; let cancellation: unknown;
  const cancel = (error: unknown): void => {
    cancelled = true; cancellation = error;
    try { onCancel?.(error); } catch { /* Cancellation must still release all waiters. */ }
    for (const group of groups.values()) for (const call of group.calls.values()) call.reject(error);
  };
  const launch = (check: string, group: Group): void => {
    if (cancelled || group.started || group.arrived.size < group.ids.length) return;
    group.started = true;
    const calls = group.ids.flatMap(id => { const call = group.calls.get(id); return call ? [call] : []; });
    if (!calls.length) return;
    void (async () => {
      const batches = splitInputBatches(calls, calls[0].limits.inputBytes ?? DEFAULT_LIMITS.inputBytes);
      for (const batch of batches) {
        if (cancelled) { for (const call of batch) call.reject(cancellation); return; }
        if (batch.length > 1) {
          try {
            const result = await callPackFunctionBatch(batch[0].target, batch.map(call => call.input), batch[0].limits, optionsFor(check, batch[0].target, batch.length));
            for (const [index, value] of result.entries()) value.ok ? batch[index].resolve(value.result) : batch[index].reject(value.error);
            continue;
          } catch (error) {
            if (error instanceof SandboxError && error.code === 'SANDBOX_UNAVAILABLE' && error.detail.reason === 'stopping') { cancel(error); return; }
            // Aggregate limits, timeout or a violation may concern one item. Re-run only this batch under the original caps.
          }
        }
        await mapLimited(batch, CHECK_PARALLELISM, async call => {
          if (cancelled) { call.reject(cancellation); return; }
          try { call.resolve(await callPackFunction(call.target, call.input, call.limits, call.options)); }
          catch (error) { call.reject(error); }
        });
      }
    })().catch(cancel);
  };
  return {
    define(check: string, ids: string[]) { groups.set(check, { ids, arrived: new Set(), calls: new Map(), started: false }); },
    runner(check: string, item: string): typeof callPackFunction {
      return async (target, input, limits = {}, options = {}) => {
        if (cancelled) throw cancellation;
        const group = groups.get(check);
        if (!group) return callPackFunction(target, input, limits, options);
        return new Promise<SandboxResult>((resolve, reject) => {
          group.calls.set(item, { target, input, limits, options, resolve, reject }); group.arrived.add(item); launch(check, group);
        });
      };
    },
    finish(check: string, item: string) { const group = groups.get(check); if (group) { group.arrived.add(item); launch(check, group); } },
    cancel,
  };
}

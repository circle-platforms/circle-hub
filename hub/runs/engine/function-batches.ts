// One evaluation-scoped batch per pure check function. Every result still passes runCheck independently.
import { callPackFunction, callPackFunctionBatch, SandboxError, type PackFunctionTarget, type SandboxOptions, type SandboxLimits, type SandboxResult } from '../../rules/api.ts';
import { CHECK_PARALLELISM } from './deps.ts';
import { mapLimited } from './util.ts';

type Call = { target: PackFunctionTarget; input: unknown; limits: Partial<SandboxLimits>; options: SandboxOptions;
  resolve: (result: SandboxResult) => void; reject: (error: unknown) => void };
type Group = { ids: string[]; arrived: Set<string>; calls: Map<string, Call>; started: boolean };

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
      if (calls.length > 1) {
        try {
          const result = await callPackFunctionBatch(calls[0].target, calls.map(call => call.input), calls[0].limits, optionsFor(check, calls[0].target, calls.length));
          for (const [index, value] of result.entries()) value.ok ? calls[index].resolve(value.result) : calls[index].reject(value.error);
          return;
        } catch (error) {
          if (error instanceof SandboxError && error.code === 'SANDBOX_UNAVAILABLE' && error.detail.reason === 'stopping') { cancel(error); return; }
          // Aggregate limits, timeout or a violation may concern one item. Re-run separately under the original caps.
        }
      }
      await mapLimited(calls, CHECK_PARALLELISM, async call => {
        if (cancelled) { call.reject(cancellation); return; }
        try { call.resolve(await callPackFunction(call.target, call.input, call.limits, call.options)); }
        catch (error) { call.reject(error); }
      });
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

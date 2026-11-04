// The dispatch policy check: the same install check at acceptance and again immediately before the Hub writes its
// dispatch intent (W03 F[0], P11 R[3]); the dispatch parameters come only from the checked install fact, by the bindings
// of policies/install.json.
import { isRecord, readTable } from './common.ts';
import { installOutcome, type Outcome } from './install.ts';

const at = (value: unknown, path: string): unknown => path.split('/').slice(1).reduce<unknown>((node, key) => (isRecord(node) ? node[key] : undefined), value);

export default function check(input: unknown): Outcome[] {
  const raw = isRecord(input) ? input : {};
  const outcome = installOutcome(raw.subject, raw.table);
  if (outcome.verdict !== 'support') return [outcome];
  const table = readTable(raw.table);
  const parameters: Record<string, unknown> = {};
  for (const [key, path] of Object.entries(table?.parameters ?? {})) parameters[key] = at(outcome.data, path);
  const strings = ['target', 'manifest_sha256', 'build', 'sha256', 'generator'];
  const complete = Object.keys(parameters).length === 6 && strings.every((key) => typeof parameters[key] === 'string' && parameters[key] !== '')
    && Array.isArray(parameters.items) && parameters.items.length > 0;
  if (!complete) {
    return [{ verdict: 'unknown', reason: 'check_error', missing: '派发参数表没有给全 target、manifest_sha256、build、sha256、items、generator；联系任务包作者修正 policies/install.json', statement: '派发参数不完整', grounds: outcome.grounds, tier: 'blocking', ...(outcome.item ? { item: outcome.item } : {}) }];
  }
  return [{ ...outcome, data: { ...outcome.data, parameters } }];
}

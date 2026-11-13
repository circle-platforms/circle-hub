/** Values only a run supplies (decision 120): the executor describes how to reach the bed, not which build it should run, so
 * a definition's precheck context never stands in for them (one registered before the rule keeps parsing; its build is not read). */
const RUN_LOCKED = new Set(['build', 'build_base']);
export function environmentOf(context: Readonly<Record<string, unknown>>): Record<string, unknown> { return Object.fromEntries(Object.entries(context).filter(([key]) => !RUN_LOCKED.has(key))); }
/** The values only a run supplies that a declared value is bound to. */
export function runBound(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(runBound);
  if (value === null || typeof value !== 'object') return [];
  const o = value as Record<string, unknown>;
  return Object.keys(o).length === 1 && typeof o.$value === 'string' ? (RUN_LOCKED.has(o.$value) ? [o.$value] : []) : Object.values(o).flatMap(runBound);
}

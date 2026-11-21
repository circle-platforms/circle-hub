const RUN_LOCKED = new Set(['build', 'build_base']);
export function environmentOf(context: Readonly<Record<string, unknown>>): Record<string, unknown> { return Object.fromEntries(Object.entries(context).filter(([key]) => !RUN_LOCKED.has(key))); }
export function runBound(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(runBound);
  if (value === null || typeof value !== 'object') return [];
  const o = value as Record<string, unknown>;
  return Object.keys(o).length === 1 && typeof o.$value === 'string' ? (RUN_LOCKED.has(o.$value) ? [o.$value] : []) : Object.values(o).flatMap(runBound);
}

// Subject builder of the pack's checks (run-subject-input@1 -> the check's subject): the items with their fields and the
// run facts the scheme needs, which a check function does not receive otherwise (its context names the run, requirement and
// pack only): the bound product line, all its names, the frozen parameters and, when the workflow asked for them
// (workflow.json context), the frozen builds of the bound product.
import { guarded, isRecord, strings } from './text.ts';
import type { ContextBuild, LocateSubject } from './types.ts';

export function buildSubject(input: unknown): LocateSubject {
  const raw = isRecord(input) ? input : {};
  const context = isRecord(raw.context) ? raw.context : {};
  const items = (Array.isArray(raw.items) ? raw.items : []).filter(isRecord).map((item) => ({
    id: typeof item.id === 'string' ? item.id : '',
    location: typeof item.location === 'string' ? item.location : '',
    fields: (isRecord(item.fields) ? item.fields : {}) as LocateSubject['items'][number]['fields'],
  }));
  return {
    items,
    context: {
      product: typeof context.product === 'string' ? context.product : null,
      names: strings(context.names),
      parameters: isRecord(context.parameters) ? context.parameters : {},
      ...(Array.isArray(context.builds) ? { builds: context.builds as ContextBuild[] } : {}),
    },
  };
}

export default function subject(input: unknown): unknown {
  return guarded<unknown>(
    () => buildSubject(input),
    () => ({ items: [], context: { product: null, names: [], parameters: {} } }),
  );
}

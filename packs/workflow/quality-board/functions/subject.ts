// Subject builder of the quality-board checks (run-subject-input@1 -> the checks' subject): the items with their frozen
// fields, and the run facts the checks need — the frozen parameters (the thresholds) and the view facts in the run's groups.
import { guarded, isRecord, strings } from './text.ts';
import type { BoardSubject, GroupBoard, RunFacts } from './types.ts';

export function buildSubject(input: unknown): BoardSubject {
  const raw = isRecord(input) ? input : {};
  const context = isRecord(raw.context) ? raw.context : {};
  const items = (Array.isArray(raw.items) ? raw.items : []).filter(isRecord).map((item) => ({
    id: typeof item.id === 'string' ? item.id : '',
    location: typeof item.location === 'string' ? item.location : '',
    fields: (isRecord(item.fields) ? item.fields : {}) as unknown as GroupBoard,
  }));
  return {
    items,
    context: {
      product: typeof context.product === 'string' ? context.product : null,
      names: strings(context.names),
      parameters: isRecord(context.parameters) ? context.parameters : {},
      groups: (Array.isArray(context.groups) ? context.groups : []).filter(isRecord) as unknown as RunFacts[],
    },
  };
}

export default function subject(input: unknown): unknown {
  return guarded<unknown>(
    () => buildSubject(input),
    () => ({ items: [], context: { product: null, names: [], parameters: {}, groups: [] } }),
  );
}

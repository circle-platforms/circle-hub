// Subject builder of the bed check (run-subject-input@1 -> the check's subject): the items with their frozen fields,
// and the run facts the check needs — the frozen parameters and the groups the projection put in the run record (the
// raw manifest, the normalized parameters, the frozen lease view). Without this builder the engine's default subject
// carries no context (evaluate.ts), so the check could never see the manifest or the lease view.
import { isRecord } from './common.ts';

export interface BedSubject {
  items: Array<{ id: string; location: string; fields: Record<string, unknown> }>;
  context: {
    product: string | null;
    names: string[];
    parameters: Record<string, unknown>;
    groups: Array<Record<string, unknown>>;
  };
}

export function buildSubject(input: unknown): BedSubject {
  const raw = isRecord(input) ? input : {};
  const context = isRecord(raw.context) ? raw.context : {};
  const items = (Array.isArray(raw.items) ? raw.items : []).filter(isRecord).map((item) => ({
    id: typeof item.id === 'string' ? item.id : '',
    location: typeof item.location === 'string' ? item.location : '',
    fields: isRecord(item.fields) ? item.fields : {},
  }));
  return {
    items,
    context: {
      product: typeof context.product === 'string' ? context.product : null,
      names: (Array.isArray(context.names) ? context.names : []).filter((name): name is string => typeof name === 'string'),
      parameters: isRecord(context.parameters) ? context.parameters : {},
      groups: (Array.isArray(context.groups) ? context.groups : []).filter(isRecord),
    },
  };
}

export default function subject(input: unknown): unknown {
  try {
    return buildSubject(input);
  } catch {
    return { items: [], context: { product: null, names: [], parameters: {}, groups: [] } };
  }
}

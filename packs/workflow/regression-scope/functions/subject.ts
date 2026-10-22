// Subject builder (run-subject-input@1 -> the check's subject): the items, plus the note the projection froze on the run.

import { PACK, guarded, isRecord } from './text.ts';

export function buildSubject(input: unknown): { items: { [key: string]: unknown }[]; note: { [key: string]: unknown } | null } {
  const raw = isRecord(input) ? input : {};
  const context = isRecord(raw.context) ? raw.context : {};
  const groups = Array.isArray(context.groups) ? context.groups : [];
  const found = groups.find((group) => isRecord(group) && group.kind === PACK);
  const note = isRecord(found) ? found : null;
  const items = (Array.isArray(raw.items) ? raw.items : []).filter(isRecord).map((item) => ({
    id: typeof item.id === 'string' ? item.id : '',
    location: typeof item.location === 'string' ? item.location : '',
    fields: isRecord(item.fields) ? item.fields : {},
  }));
  return { items, note };
}

export default function subject(input: unknown): unknown {
  return guarded(
    () => buildSubject(input),
    () => ({ items: [], note: null }),
  );
}

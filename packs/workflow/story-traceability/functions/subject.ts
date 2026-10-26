// Preserve the run's frozen projection groups for the integrity check.
import { isRecord } from './text.ts';
export default function subject(input: unknown): unknown {
  const raw = isRecord(input) ? input : {};
  return { items: Array.isArray(raw.items) ? raw.items : [], context: isRecord(raw.context) ? raw.context : {} };
}

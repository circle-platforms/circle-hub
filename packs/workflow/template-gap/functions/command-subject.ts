// Re-read command universes from the frozen index, not from the item's display rows.
import { isRecord } from './common.ts';
export function commandSubject(input: unknown): Record<string, unknown> {
  const raw = isRecord(input) ? input : {}; const item = isRecord(raw.item) ? raw.item : {};
  const context = isRecord(raw.context) ? raw.context : {};
  const groups = Array.isArray(context.groups) ? context.groups.filter(isRecord) : [];
  const document = groups.find(g => g.kind === 'document' && g.id === item.id);
  const index = groups.find(g => g.kind === 'case_index');
  const slots=isRecord(raw.slots)?raw.slots:{};
  return { source:document?.classification_source,claims:slots.coverage,scope_complete:isRecord(item.fields)&&item.fields.scope_complete===true,item: item.id ?? null, location: item.location ?? null, document: document?.id ?? item.id ?? null, uploaded: document?.uploaded ?? null, case_rule: document?.case_rule ?? null, cases: document?.command_cases ?? null, nodes: document?.command_nodes ?? null, case_count: document?.cases ?? null, skipped: document?.command_skips ?? [], index: index?.view ?? null, index_reference: index?.reference ?? null, scope: groups.filter(g => g.kind === 'document' && g.uploaded === false).map(g => g.id).sort(), lock: { product: context.product ?? null, root: context.root ?? null, build: context.build ?? null } };
}
export default commandSubject;

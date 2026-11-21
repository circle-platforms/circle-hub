// The workflow's refresh function (workflow.json refresh, ItemRefreshInput -> ItemRefreshOutput): at every evaluation and every run
// export the Hub resolves the latest accepted result of the recompose run bound after the start (inputs.recomposition_result by run id)
// and calls this once; it lays each case's own admitted record over its frozen item (SubjectItem.late), or says why it is not admitted
// and, when the case only waits for its own record to be accepted, what it waits for. Pure and deterministic: the Hub digests the output
// into locks.late.refresh and a replay recomputes it from the recorded reference.
import { lateRecomposition, type LateMarker } from './recomposition.ts';
import { isRecord } from './text.ts';

/** The inputs of the run this function reads (workflow.json refresh.reads): the frozen recompose run record. */
const RUN_SLOT = 'recomposition_run';

function markerOf(fields: Record<string, unknown>): LateMarker | null {
  const marker = fields.recomposition_late;
  return isRecord(marker) && typeof marker.slot === 'string' && typeof marker.run === 'string' && typeof marker.source === 'string' && typeof marker.node === 'string'
    ? { slot: marker.slot, run: marker.run, source: marker.source, node: marker.node }
    : null;
}

export function refreshItems(input: unknown): { items: Array<{ id: string; late: Record<string, unknown> }> } {
  const raw = isRecord(input) ? input : {};
  const items = Array.isArray(raw.items) ? raw.items.filter(isRecord) : [];
  const inputs = Array.isArray(raw.inputs) ? raw.inputs.filter(isRecord) : [];
  const late = Array.isArray(raw.late) ? raw.late.filter(isRecord) : [];
  const context = isRecord(raw.context) ? raw.context : {};
  const runInput = inputs.find((bound) => bound.slot === RUN_SLOT);
  const out: Array<{ id: string; late: Record<string, unknown> }> = [];
  for (const item of items) {
    if (typeof item.id !== 'string') continue;
    const fields = isRecord(item.fields) ? item.fields : {};
    const marker = markerOf(fields);
    if (!marker) continue;
    const entry = late.find((row) => row.slot === marker.slot);
    // A late slot the Hub did not resolve at all is no result yet, with the Hub's own words when it gave any.
    const resolved = entry === undefined
      ? { run: marker.run, input: null, missing: `Hub 这次没有给出槽 ${marker.slot} 的晚绑定结果` }
      : { run: typeof entry.run === 'string' ? entry.run : marker.run, input: isRecord(entry.input) ? entry.input : null, ...(typeof entry.missing === 'string' && entry.missing.trim() ? { missing: entry.missing } : {}) };
    out.push({ id: item.id, late: lateRecomposition(runInput, resolved, context, marker.source, marker.node, typeof fields.autoid === 'string' ? fields.autoid : undefined) });
  }
  return { items: out };
}

export default function refresh(input: unknown): unknown {
  return refreshItems(input);
}

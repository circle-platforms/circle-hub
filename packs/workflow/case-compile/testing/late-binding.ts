// Synthetic late-binding inputs shaped as the Hub hands them (docs/hub-r4-tasks/t18-late-binding.md section 2): the frozen recompose
// run record bound by rec:, the recompose run's latest accepted validation result as a BoundInput read from its record (meta
// {record, kind, schema, created_at, source}), ItemRefreshInput, SubjectItem.late and run-late@1. Test support only; synthetic content.
import { createHash } from 'node:crypto';
import { fixture } from './recompose.ts';
import { canonicalJson } from '../functions/canonical-json.ts';

export const RECOMPOSE_RUN = 'run_01synthrecomposeaaaaaaaaa';
export const PLAN_RUN = 'run_01synthplanaaaaaaaaaaaaaaa';
export const PACK = 'recompose@1.2.7';
const PACK_DIGEST = 'd'.repeat(64);
export const digestOf = (value: unknown): string => createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');

/** Two cases of one synthetic mind map, each with its own complete recomposition record, and the run context they belong to. */
export function twoCases() {
  const f = fixture();
  const one = structuredClone(f.record);
  const two = structuredClone(f.record);
  two.case = { ...two.case, id: 'orbit-case-0002', node: 'n/case-2' };
  return { records: [one, two], source: f.record.case.source_ref as string, context: f.context };
}

/** The recompose run record: one item per case, by its source and node. */
export function runBody(records: any[], context: any, extra: Record<string, unknown> = {}) {
  return { run: RECOMPOSE_RUN, pack: PACK, pack_digest: PACK_DIGEST, product: context.product, root: context.root, product_pack_digest: context.product_pack_digest, predecessor: null, items: records.map((record, index) => ({ id: `recompose-item-${index + 1}`, fields: { source_ref: record.case.source_ref, node: record.case.node, case_id: record.case.id } })), ...extra };
}

/** One row of a recompose result: the record requirement of an item, satisfied with the record, or in another status without one. */
export function recordRow(item: string, record: any | null, status = 'satisfied') {
  return { item, requirements: [{ requirement: 'record', status, claims: record ? [{ warrant: { producer: 'model' }, validity: { status: 'valid' }, statement: { text: '合成重组判断', data: record } }] : [] }] };
}

/** An accepted validation result of the recompose run. */
export function resultBody(rows: any[], extra: Record<string, unknown> = {}) {
  return { schema: 'validation@1', run: RECOMPOSE_RUN, acceptance: 'accepted', locks: { pack: PACK, pack_digest: PACK_DIGEST }, partitions: { delivered: rows }, ...extra };
}

/** A Hub record bound as an input, as the Hub reads a rec: binding (and, at evaluation, a late reference) into a BoundInput. */
export function boundRecord(slot: string, kind: 'run' | 'validation_result', body: unknown, record: string) {
  const model = { kind, schema: kind === 'run' ? 'run@1' : 'validation@1', created_at: '2026-11-17T00:00:00.000Z', body };
  return { slot, external: null, sha256: digestOf(model), media_type: 'application/json', parser: 'json@1', model, meta: { record, kind, schema: model.schema, created_at: model.created_at, source: digestOf(model) } };
}

/** The frozen items of a plan run that binds the recomposition result after its start (what functions/project.ts writes). */
export function lateItems(records: any[], source: string) {
  return records.map((record, index) => ({
    id: `synthetic-map:case-${index + 1}`, label: `合成用例${index + 1}`, location: `${source}/kityminder@1/${record.case.node}`,
    fields: { autoid: record.case.id, recomposition_late: { slot: 'recomposition_result', run: RECOMPOSE_RUN, source, node: record.case.node } },
  }));
}

/** ItemRefreshInput: the frozen items, the frozen reads, the late slots as the Hub resolved them now, the parameters and the context. */
export function refreshInput(items: unknown[], runInput: unknown, result: unknown | null, context: any, missing?: string) {
  return {
    items, inputs: [runInput], parameters: {},
    late: [{ slot: 'recomposition_result', run: RECOMPOSE_RUN, input: result, ...(missing !== undefined ? { missing } : {}) }],
    context: { ...context, run: PLAN_RUN, late_inputs: [{ slot: 'recomposition_result', run: RECOMPOSE_RUN, ...(result ? { reference: 'rec:' + (result as any).meta.record } : { missing: missing ?? '运行还没有已受理提交' }) }] },
  };
}

/** run-late@1 as GET /run-export/<run>/late answers it, from a refresh output. */
export function runLate(output: { items: Array<{ id: string; late: Record<string, unknown> }> }, reference?: string) {
  return { schema: 'run-late@1', run: PLAN_RUN, run_reference: 'rec:' + 'c'.repeat(64), resolved_at: '2026-11-17T00:00:00.000Z', late: { inputs: [{ slot: 'recomposition_result', run: RECOMPOSE_RUN, ...(reference ? { reference } : { missing: '运行还没有已受理提交' }) }], refresh: digestOf(output) }, items: output.items };
}

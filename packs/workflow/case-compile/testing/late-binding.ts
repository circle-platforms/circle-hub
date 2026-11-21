import { createHash } from 'node:crypto';
import { fixture } from './recompose.ts';
import { canonicalJson } from '../functions/canonical-json.ts';

export const RECOMPOSE_RUN = 'run_01synthrecomposeaaaaaaaaa';
export const PLAN_RUN = 'run_01synthplanaaaaaaaaaaaaaaa';
export const PACK = 'recompose@1.2.7';
const PACK_DIGEST = 'd'.repeat(64);
export const digestOf = (value: unknown): string => createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');

export function twoCases() {
  const f = fixture();
  const one = structuredClone(f.record);
  const two = structuredClone(f.record);
  two.case = { ...two.case, id: 'orbit-case-0002', node: 'n/case-2' };
  return { records: [one, two], source: f.record.case.source_ref as string, context: f.context };
}

export function runBody(records: any[], context: any, extra: Record<string, unknown> = {}) {
  return { run: RECOMPOSE_RUN, pack: PACK, pack_digest: PACK_DIGEST, product: context.product, root: context.root, product_pack_digest: context.product_pack_digest, predecessor: null, items: records.map((record, index) => ({ id: `recompose-item-${index + 1}`, fields: { source_ref: record.case.source_ref, node: record.case.node, case_id: record.case.id } })), ...extra };
}

export function recordRow(item: string, record: any | null, status = 'satisfied') {
  return { item, requirements: [{ requirement: 'record', status, claims: record ? [{ warrant: { producer: 'model' }, validity: { status: 'valid' }, statement: { text: '合成重组判断', data: record } }] : [] }] };
}

export function resultBody(rows: any[], extra: Record<string, unknown> = {}) {
  return { schema: 'validation@1', run: RECOMPOSE_RUN, acceptance: 'accepted', locks: { pack: PACK, pack_digest: PACK_DIGEST }, partitions: { delivered: rows }, ...extra };
}

export function boundRecord(slot: string, kind: 'run' | 'validation_result', body: unknown, record: string) {
  const model = { kind, schema: kind === 'run' ? 'run@1' : 'validation@1', created_at: '2026-11-17T00:00:00.000Z', body };
  return { slot, external: null, sha256: digestOf(model), media_type: 'application/json', parser: 'json@1', model, meta: { record, kind, schema: model.schema, created_at: model.created_at, source: digestOf(model) } };
}

export function lateItems(records: any[], source: string) {
  return records.map((record, index) => ({
    id: `synthetic-map:case-${index + 1}`, label: `合成用例${index + 1}`, location: `${source}/kityminder@1/${record.case.node}`,
    fields: { autoid: record.case.id, recomposition_late: { slot: 'recomposition_result', run: RECOMPOSE_RUN, source, node: record.case.node } },
  }));
}

export function refreshInput(items: unknown[], runInput: unknown, result: unknown | null, context: any, missing?: string) {
  return {
    items, inputs: [runInput], parameters: {},
    late: [{ slot: 'recomposition_result', run: RECOMPOSE_RUN, input: result, ...(missing !== undefined ? { missing } : {}) }],
    context: { ...context, run: PLAN_RUN, late_inputs: [{ slot: 'recomposition_result', run: RECOMPOSE_RUN, ...(result ? { reference: 'rec:' + (result as any).meta.record } : { missing: missing ?? '运行还没有已受理提交' }) }] },
  };
}

export function runLate(output: { items: Array<{ id: string; late: Record<string, unknown> }> }, reference?: string) {
  return { schema: 'run-late@1', run: PLAN_RUN, run_reference: 'rec:' + 'c'.repeat(64), resolved_at: '2026-11-17T00:00:00.000Z', late: { inputs: [{ slot: 'recomposition_result', run: RECOMPOSE_RUN, ...(reference ? { reference } : { missing: '运行还没有已受理提交' }) }], refresh: digestOf(output) }, items: output.items };
}

// Test builders of hand-built index views and bound inputs (never published). The builders mirror index-view@1: keys are
// derived from the entries' data the way the Hub's knowledge reader derives them (a list field by each element), so a test
// that tampers with the totals or the order does it explicitly.
import { createHash } from 'node:crypto';
import type { BoundInput } from './types.ts';

export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

export const PRODUCT = 'famx';
export const NAMES = ['FAMX', 'FAMY'];
export const BUILD = 'Rel_FAMX_10_6_1_57';
export const ROOT = sha256('traceability synthetic root of Rel_FAMX_10_6_1_57');

export interface ViewEntrySpec {
  digest: string;
  kind: string;
  statement: string;
  data: Record<string, unknown>;
  reference: string;
}

let seq = 0;
/** A defect entry as the product pack's release-notes producer writes it: data.bug the id, data.status fixed or known. */
export function defectEntry(spec: { bug: string; status?: string; statement?: string; module?: string; system?: string; digest?: string }): ViewEntrySpec {
  const statement = spec.statement ?? `缺陷 ${spec.bug} 的合成摘要`;
  const digest = spec.digest ?? sha256(`defect|${spec.bug}|${spec.status ?? 'fixed'}|${statement}|${seq++}`);
  return {
    digest,
    kind: 'defect',
    statement,
    data: { declaration_status:'declared',bug: spec.bug, status: spec.status ?? 'fixed', text: statement, build: BUILD, module: spec.module ?? 'SSL', ...(spec.system === undefined ? {} : { system: spec.system }) },
    reference: `tree:${ROOT}/release-notes/${digest.slice(0, 12)}@${digest}`,
  };
}

/** A case entry as the product pack's cases producer writes it: data.node is the case's node id in its document, and
 * data.defects holds the bug ids its document carries. */
export function caseEntry(spec: { defects: string[]; case?: string; title?: string; document?: string; stories?: string[]; digest?: string }): ViewEntrySpec {
  const id = spec.case ?? `C${seq}`;
  const title = spec.title ?? `用例 ${id}`;
  const digest = spec.digest ?? sha256(`case|${spec.defects.join(',')}|${id}|${title}|${seq++}`);
  return {
    digest,
    kind: 'case',
    statement: title,
    data: {
      node: id,
      title,
      document: spec.document ?? '24001',
      defects: [...spec.defects],
      ...(spec.stories !== undefined ? { stories: [...spec.stories] } : {}),
      line: '10.6.1',
      module: 'SSL',
      has_expected: true,
      vague_expected: false,
      negative: false,
    },
    reference: `tree:${ROOT}/cases/${digest.slice(0, 12)}@${digest}`,
  };
}

/** The entry as an index view answers it with `fields=document,node,title`: only those data fields, an empty statement. */
export function slimCaseEntry(spec: ViewEntrySpec): ViewEntrySpec {
  const data: Record<string, unknown> = {};
  for (const field of ['document', 'node', 'title']) if (Object.hasOwn(spec.data, field)) data[field] = spec.data[field];
  return { ...spec, statement: '', data };
}

/** The values of the key field an entry is indexed under (the reader's rule: a list field by each element). */
function keyValues(data: Record<string, unknown>, key: string): string[] {
  const value = data[key];
  const list = Array.isArray(value) ? value : [value];
  const out: string[] = [];
  for (const v of list) {
    if (v === null || v === undefined) continue;
    const text = typeof v === 'string' ? v : JSON.stringify(v);
    if (text !== undefined && !out.includes(text)) out.push(text);
  }
  return out;
}

export interface ViewOverrides {
  product?: string;
  build?: string;
  root?: string;
  keys?: Record<string, string[]>;
  total_keys?: number;
  total_entries?: number;
  truncated?: boolean;
  skipped?: number;
  notes?: string[];
}

/** A hand-built index-view@1 model. By default the keys and the totals are derived from the entries. With `slim`, the
 * entries carry only those data fields and an empty statement and the view records them — as the reader answers with
 * `fields=` (the keys are still derived from the full data, as the reader indexes before slimming). */
export function indexViewOf(kind: string, key: string, entries: ViewEntrySpec[], overrides: ViewOverrides = {}, slim: string[] | null = null): Record<string, unknown> {
  const keys: Record<string, string[]> = {};
  for (const spec of entries) {
    for (const value of keyValues(spec.data, key)) {
      (keys[value] ??= []).push(spec.digest);
    }
  }
  for (const list of Object.values(keys)) list.sort();
  const record: Record<string, unknown> = {};
  for (const spec of entries) {
    const entry = slim === null ? spec : slimCaseEntry(spec);
    record[spec.digest] = { entry: spec.digest, kind: spec.kind, statement: entry.statement, data: entry.data, reference: spec.reference };
  }
  return {
    schema: 'index-view@1',
    product: overrides.product ?? PRODUCT,
    build: { build: overrides.build ?? BUILD, root: overrides.root ?? ROOT },
    kind,
    key,
    keys: overrides.keys ?? keys,
    entries: record,
    ...(slim !== null ? { fields: [...slim].sort() } : {}),
    total_keys: overrides.total_keys ?? Object.keys(overrides.keys ?? keys).length,
    total_entries: overrides.total_entries ?? entries.length,
    truncated: overrides.truncated ?? false,
    skipped: overrides.skipped ?? 0,
    notes: overrides.notes ?? [],
  };
}

/** The external id of a knowledge index view. */
export const indexId = (kind: string, key: string, build = BUILD, product = PRODUCT): string =>
  `knowledge:index:${product}:${build}?kind=${kind}&key=${key}`;

/** A bound input as the run engine hands it to the projection (json@1 model of the stored view bytes). */
export function boundView(slot: string, view: Record<string, unknown>, external?: string): BoundInput {
  const bytes = new TextEncoder().encode(JSON.stringify(view));
  return {
    slot,
    external: external ?? null,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    media_type: 'application/json',
    parser: 'json@1',
    model: view,
    meta: null,
  };
}

/** The defects view and the cases view of a corpus, bound as the run binds them. The cases view is the slim one
 * (fields=document,node,title), as the pack's workflow.json asks for it; `slimCases: false` keeps the full entries (the
 * join re-verification reads the raw defect ids, which only full entries carry). */
export function boundPair(defects: ViewEntrySpec[], cases: ViewEntrySpec[], options: { defectsView?: ViewOverrides; casesView?: ViewOverrides; slimCases?: boolean } = {}): { defects: Record<string, unknown>; cases: Record<string, unknown>; inputs: BoundInput[] } {
  const slim = options.slimCases !== false;
  const dv = indexViewOf('defect', 'bug', defects, options.defectsView);
  const cv = indexViewOf('case', 'defects', cases, options.casesView, slim ? ['document', 'node', 'title'] : null);
  return { defects: dv, cases: cv, inputs: [boundView('defects', dv, indexId('defect', 'bug')), boundView('cases', cv, indexId('case', 'defects') + (slim ? '&fields=document,node,title' : ''))] };
}

/** A copy of a JSON value with every record's members in reverse order (the matrix must not depend on member order). */
export function reversed(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reversed);
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).reverse()) out[key] = reversed((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}

/** A deterministic pseudo-random source (mulberry32), so a failure reproduces from the seed. */
export function randomOf(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

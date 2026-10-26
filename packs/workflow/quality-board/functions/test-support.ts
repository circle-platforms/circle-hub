// Test builders of hand-built facet views and bound inputs (never published). facetViewOfCorpus groups a synthetic corpus
// of case entries into facet rows the way the Hub's knowledge reader does (one row per distinct value combination, a
// missing field is null), so the pack's grouping can be checked against a plain count over the corpus.
import { createHash } from 'node:crypto';
import type { BoundInput } from './types.ts';

export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

export const PRODUCT = 'famx';
export const NAMES = ['FAMX', 'FAMY'];
export const BUILD = 'Rel_FAMX_10_6_1_57';
export const ROOT = sha256('quality-board synthetic root of Rel_FAMX_10_6_1_57');

/** The five fields the board's view is keyed by; the caller may add priority. */
export const BY = ['line', 'module', 'has_expected', 'vague_expected', 'negative','test_type_status'];

export type Scalar = string | number | boolean | null;

/** A synthetic case entry's data fields (the cases producer's documented shape). */
export interface CorpusCase {
  line?: Scalar;
  module?: Scalar;
  has_expected?: Scalar;
  vague_expected?: Scalar;
  negative?: Scalar;
  test_type_status?: Scalar;
  priority?: Scalar;
}

export type FacetRow = { values: Record<string, Scalar>; count: number };

/** One row of a facet view by hand. */
export function facetRow(values: Record<string, Scalar>, count: number): FacetRow {
  const authored={...values};
  if(Object.hasOwn(authored,'negative')&&!Object.hasOwn(authored,'test_type_status'))authored.test_type_status=typeof authored.negative==='boolean'?'declared':'undeclared';
  if(Object.hasOwn(authored,'tags')){authored.resource_empty??=authored.tags===null;authored.tag_valid??=true;}
  return { values:authored, count };
}

export interface ViewOverrides {
  product?: string;
  build?: string;
  root?: string;
  by?: string[];
  total?: number;
  truncated?: boolean;
  skipped?: number;
  notes?: string[];
}

/** A hand-built facet-view@1 model. */
export function facetViewOf(rows: FacetRow[], overrides: ViewOverrides = {}): Record<string, unknown> {
  return {
    schema: 'facet-view@1',
    product: overrides.product ?? PRODUCT,
    build: { build: overrides.build ?? BUILD, root: overrides.root ?? ROOT },
    kind: 'case',
    by: overrides.by ?? BY,
    rows: rows.map((row) => ({ values: row.values, count: row.count })),
    totals: {empty:Object.fromEntries((overrides.by??BY).map(field=>[field,rows.filter(row=>row.values[field]===null||row.values[field]===undefined).reduce((n,row)=>n+row.count,0)]))},
    total: overrides.total ?? rows.reduce((sum, row) => sum + row.count, 0),
    truncated: overrides.truncated ?? false,
    skipped: overrides.skipped ?? 0,
    notes: overrides.notes ?? [],
  };
}

/** The rows of a corpus under the reader's rule: one row per distinct combination of the by fields, counted. */
export function rowsOfCorpus(corpus: CorpusCase[], by: readonly string[] = BY): FacetRow[] {
  const map = new Map<string, { values: Record<string, Scalar>; count: number }>();
  for (const original of corpus) {
    const entry={...original,test_type_status:original.test_type_status??(typeof original.negative==='boolean'?'declared':'undeclared')};
    const values: Record<string, Scalar> = {};
    for (const field of by) values[field] = (entry as Record<string, Scalar>)[field] ?? null;
    const key = JSON.stringify(by.map((field) => values[field]));
    const held = map.get(key);
    if (held === undefined) map.set(key, { values, count: 1 });
    else held.count++;
  }
  return [...map.values()];
}

/** The external id of the facets view the board reads. */
export const facetsId = (build = BUILD, product = PRODUCT, by: readonly string[] = BY): string => `knowledge:facets:${product}:${build}?kind=case&by=${by.join(',')}`;

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

/** A copy of a JSON value with every record's members in reverse order and every array reversed (order independence). */
export function reversed(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reversed).reverse();
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

/** A complete synthetic placement view for tests whose focus is the metric view. */
export function placementFor(view: Record<string, unknown>, unplaced = 0): BoundInput {
  const build = view.build as { build: string; root: string };
  const total = view.total as number;
  return boundView('placement', facetViewOf([
    ...(unplaced > 0 ? [facetRow({ commands: null }, unplaced)] : []),
    ...(total > unplaced ? [facetRow({ commands: '/synthetic' }, total - unplaced)] : []),
  ], { by: ['commands'], product: view.product as string, build: build.build, root: build.root, total }));
}

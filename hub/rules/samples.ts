// Positive and negative samples of the core interpreters (C05 R[0]), stored as JSON next to each interpreter. runSamples is
// the conformance suite: the tests run it, and the Hub can run it at start to refuse a broken build.
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import type { CheckOutcome } from '../../contracts/src/tables.ts';
import { buildCatalog, type CatalogSpec } from './catalog/view.ts';
import { INTERPRETERS } from './interpreters/registry.ts';
import type { CheckContext } from './types.ts';

export interface ExpectedOutcome {
  verdict: CheckOutcome['verdict'];
  code?: string;
  reason?: string;
  tier?: string;
  item?: string;
  pointer?: string;
  /** Each key must equal the outcome's data at that key. */
  data?: Record<string, unknown>;
}

export interface Sample {
  name: string;
  note?: string;
  /** The table, or the name of one in the file's `tables`. */
  table: unknown;
  subject: unknown;
  /** Defaults to the file's catalog. */
  catalog?: CatalogSpec;
  sources?: Record<string, string>;
  context?: CheckContext;
  expect: ExpectedOutcome[];
}

export interface SampleFile {
  interpreter: string;
  /** Tables shared by several samples, by name. */
  tables?: Record<string, unknown>;
  /** Catalog shared by the samples (catalog@1). */
  catalog?: CatalogSpec;
  positive: Sample[];
  negative: Sample[];
}

export interface SampleResult {
  interpreter: string;
  kind: 'positive' | 'negative';
  name: string;
  ok: boolean;
  problems: string[];
  outcomes: CheckOutcome[];
}

/** Samples of `name@1` live in interpreters/name.samples.json. */
export function loadSamples(interpreter: string): SampleFile {
  if (!INTERPRETERS.has(interpreter)) throw new Error(`no interpreter ${interpreter}`);
  const file = interpreter.split('@')[0];
  return JSON.parse(readFileSync(new URL(`./interpreters/${file}.samples.json`, import.meta.url), 'utf8')) as SampleFile;
}

function compare(expected: ExpectedOutcome[], actual: CheckOutcome[]): string[] {
  const problems: string[] = [];
  if (expected.length !== actual.length) problems.push(`expected ${expected.length} outcomes, got ${actual.length}`);
  expected.forEach((e, i) => {
    const a = actual[i];
    if (!a) return;
    for (const key of ['verdict', 'code', 'reason', 'tier', 'item', 'pointer'] as const) {
      if (e[key] !== undefined && e[key] !== a[key]) problems.push(`#${i} ${key}: expected ${e[key]}, got ${a[key]}`);
    }
    for (const [key, value] of Object.entries(e.data ?? {})) {
      if (!isDeepStrictEqual(a.data?.[key], value)) problems.push(`#${i} data.${key}: expected ${JSON.stringify(value)}, got ${JSON.stringify(a.data?.[key])}`);
    }
  });
  return problems;
}

/** Runs the samples of one interpreter, or of all. A positive sample must give only support; a negative one some refutation. */
export function runSamples(interpreter?: string): SampleResult[] {
  const ids = interpreter ? [interpreter] : [...INTERPRETERS.keys()];
  const results: SampleResult[] = [];
  for (const id of ids) {
    const impl = INTERPRETERS.get(id);
    const file = loadSamples(id);
    for (const kind of ['positive', 'negative'] as const) {
      for (const sample of file[kind]) {
        const problems: string[] = [];
        if (!impl) problems.push(`interpreter ${id} is not installed`);
        const table = typeof sample.table === 'string' ? file.tables?.[sample.table] : sample.table;
        if (table === undefined) problems.push(`no table ${String(sample.table)}`);
        const tableIssues = impl ? impl.validateTable(table) : [];
        if (tableIssues.length > 0) problems.push(`table invalid: ${JSON.stringify(tableIssues)}`);
        const catalog = sample.catalog ?? file.catalog;
        const outcomes = impl
          ? impl.run({
              interpreter: id,
              table,
              subject: sample.subject,
              catalog: catalog ? buildCatalog(catalog) : undefined,
              sources: sample.sources ? { text: (ref) => sample.sources?.[ref] } : undefined,
              context: sample.context ?? {},
            })
          : [];
        problems.push(...compare(sample.expect, outcomes));
        if (kind === 'positive' && outcomes.some((o) => o.verdict !== 'support')) problems.push('a positive sample must give only support');
        if (kind === 'negative' && !outcomes.some((o) => o.verdict === 'refute')) problems.push('a negative sample must give a refutation');
        results.push({ interpreter: id, kind, name: sample.name, ok: problems.length === 0, problems, outcomes });
      }
    }
  }
  return results;
}

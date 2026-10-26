// Compares the case-index facet view (knowledge:facets:<product>:<build>?kind=case&by=document,line,train,module)
// against the independent locations gold (architecture 6b, item 2).
// Reports the counts of equal, unequal, only-gold, and only-facet documents,
// and details every discrepancy (document, field, gold value, facet value).
// Imports nothing from hub/ or packs/.
//
// Usage:
//   node scripts/real/accept/location-index.ts --facets <facets.json> --gold <locations.json> [--out <report.json>]
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DocumentLocationGold, LocationsGold } from '../gold/locations.ts';
import { lineKey } from '../gold/locations.ts';

export type LocationField = 'line' | 'train' | 'module';

export const CANDIDATE_FIELDS: LocationField[] = ['line', 'train', 'module'];

export interface RowInconsistency {
  document: string;
  field: LocationField;
  values: string[];
}

export interface Discrepancy {
  document: string;
  field: LocationField;
  gold: string | null;
  facet: string | null;
  reason?: string;
}

export interface LocationIndexComparison {
  equal: number;
  unequal: number;
  onlyGold: number;
  onlyFacet: number;
  uncomparedFields: LocationField[];
  inconsistencies: RowInconsistency[];
  discrepancies: Discrepancy[];
  summary: string;
}

export interface FacetRowValues {
  document?: string | number | null;
  line?: string | null;
  train?: string | null;
  module?: string | null;
  [key: string]: unknown;
}

export interface FacetDocumentEntry {
  line: string | null;
  train: string | null;
  module: string | null;
}

export interface FacetDocumentMap extends Map<string, FacetDocumentEntry> {
  by?: string[] | null;
  inconsistencies?: RowInconsistency[];
}

/**
 * Extracts facet view grouping dimensions (by) from raw view JSON.
 */
export function extractFacetBy(raw: unknown): string[] | null {
  if (!raw || typeof raw !== 'object') return null;
  const top = raw as Record<string, unknown>;
  const candidate = top.by ?? top.facets ?? top.dimensions;
  if (Array.isArray(candidate)) {
    return candidate.map(String).map((s) => s.trim()).filter(Boolean);
  }
  if (typeof candidate === 'string' && candidate.trim()) {
    return candidate.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return null;
}

/**
 * Extracts document records from facet view JSON.
 * Multiple rows for the same document must have consistent values for line and module;
 * inconsistencies are recorded and exposed on the returned map and comparison result.
 */
export function parseFacetView(raw: unknown): FacetDocumentMap {
  const result: FacetDocumentMap = new Map();
  const inconsistencies: RowInconsistency[] = [];
  const byList = extractFacetBy(raw);
  result.by = byList;
  result.inconsistencies = inconsistencies;

  if (!raw || typeof raw !== 'object') return result;

  const top = raw as Record<string, unknown>;
  const rows = Array.isArray(top.rows) ? top.rows : [];

  const fieldValues = new Map<string, Record<LocationField, Set<string | null>>>();

  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const values = (row as { values?: unknown }).values;
    if (!values || typeof values !== 'object') continue;
    const v = values as FacetRowValues;
    if (v.document === undefined || v.document === null) continue;
    const docId = String(v.document).trim();
    if (!docId) continue;

    let docFields = fieldValues.get(docId);
    if (!docFields) {
      docFields = {
        line: new Set<string | null>(),
        train: new Set<string | null>(),
        module: new Set<string | null>(),
      };
      fieldValues.set(docId, docFields);
    }

    for (const f of CANDIDATE_FIELDS) {
      if (byList !== null && !byList.includes(f)) {
        continue;
      }
      if (byList === null && !(f in v)) {
        continue;
      }
      const rawVal = v[f];
      const val = typeof rawVal === 'string'
        ? (rawVal.trim() === '' ? null : rawVal.trim())
        : (rawVal === null ? null : (rawVal !== undefined ? String(rawVal).trim() || null : null));
      docFields[f].add(val);
    }
  }

  for (const [docId, docFields] of fieldValues.entries()) {
    const entry: FacetDocumentEntry = {
      line: null,
      train: null,
      module: null,
    };

    for (const f of CANDIDATE_FIELDS) {
      const set = docFields[f];
      if (set.size === 0) {
        entry[f] = null;
      } else if (set.size === 1) {
        entry[f] = Array.from(set)[0];
      } else {
        const distinct = Array.from(set).map((v) => (v === null ? 'null' : v));
        inconsistencies.push({
          document: docId,
          field: f,
          values: distinct,
        });
        entry[f] = distinct.join(', ');
      }
    }

    result.set(docId, entry);
  }

  return result;
}

/**
 * Extracts document records from gold input (LocationsGold, DocumentLocationGold array, or mixed).
 * Reads both fully conforming and nonconforming partial documents so that all documents participate.
 */
export function parseGoldLocations(raw: unknown): Map<string, { line: string | null; train: string | null; module: string | null; conforming?: boolean }> {
  const result = new Map<string, { line: string | null; train: string | null; module: string | null; conforming?: boolean }>();
  if (!raw || typeof raw !== 'object') return result;

  const top = raw as Record<string, unknown>;
  const list: DocumentLocationGold[] = Array.isArray(raw)
    ? (raw as DocumentLocationGold[])
    : Array.isArray(top.all)
      ? (top.all as DocumentLocationGold[])
      : Array.isArray(top.documents)
        ? (top.documents as DocumentLocationGold[])
        : [];

  for (const doc of list) {
    if (!doc || typeof doc !== 'object') continue;
    if (typeof doc.document === 'string' && doc.document.trim()) {
      const entry: { line: string | null; train: string | null; module: string | null; conforming?: boolean } = {
        line: doc.line ?? null,
        train: doc.train ?? null,
        module: doc.module ?? null,
      };
      if (doc.conforming !== undefined) {
        entry.conforming = doc.conforming;
      }
      result.set(doc.document.trim(), entry);
    }
  }

  if (Array.isArray(top.nonconforming)) {
    for (const item of top.nonconforming) {
      if (!item || typeof item !== 'object') continue;
      const doc = item as Record<string, unknown>;
      if (typeof doc.document === 'string' && doc.document.trim()) {
        const docId = doc.document.trim();
        if (!result.has(docId)) {
          const entry: { line: string | null; train: string | null; module: string | null; conforming?: boolean } = {
            line: typeof doc.line === 'string' && doc.line ? doc.line : null,
            train: typeof doc.train === 'string' && doc.train ? doc.train : null,
            module: typeof doc.module === 'string' && doc.module ? doc.module : null,
          };
          if (doc.conforming !== undefined) {
            entry.conforming = Boolean(doc.conforming);
          } else {
            entry.conforming = false;
          }
          result.set(docId, entry);
        }
      }
    }
  }

  return result;
}

/**
 * Compares two field values where null participates in comparison.
 */
export function matchFieldValue(field: LocationField, goldVal: string | null, facetVal: string | null): boolean {
  const normGold = goldVal === null || goldVal === '' ? null : goldVal;
  const normFacet = facetVal === null || facetVal === '' ? null : facetVal;
  if (normGold === null && normFacet === null) return true;
  if (normGold === null || normFacet === null) return false;
  if (field === 'line') {
    return lineKey(normGold) === lineKey(normFacet);
  }
  return normGold === normFacet;
}

/**
 * Compares facet view entries against independent gold locations.
 * Only compares fields present in the facet view (by), with null values participating in comparison.
 */
export function compareLocationIndex(facetsInput: unknown, goldInput: unknown): LocationIndexComparison {
  const facetDocs = parseFacetView(facetsInput);
  const goldDocs = parseGoldLocations(goldInput);

  const byList = facetDocs.by;
  let comparedFields: LocationField[];
  let uncomparedFields: LocationField[];

  if (byList !== null && byList !== undefined) {
    comparedFields = CANDIDATE_FIELDS.filter((f) => byList.includes(f));
    uncomparedFields = CANDIDATE_FIELDS.filter((f) => !byList.includes(f));
  } else {
    const rawRows = (facetsInput && typeof facetsInput === 'object' && Array.isArray((facetsInput as Record<string, unknown>).rows))
      ? (facetsInput as Record<string, unknown>).rows as Array<{ values?: Record<string, unknown> }>
      : [];
    const fieldsInRows = CANDIDATE_FIELDS.filter((f) =>
      rawRows.some((r) => r && r.values && typeof r.values === 'object' && f in r.values)
    );
    comparedFields = fieldsInRows.length > 0 ? fieldsInRows : [...CANDIDATE_FIELDS];
    uncomparedFields = CANDIDATE_FIELDS.filter((f) => !comparedFields.includes(f));
  }

  let equalCount = 0;
  let unequalCount = 0;
  const discrepancies: Discrepancy[] = [];
  const commonDocIds = new Set<string>();

  const allInconsistencies = facetDocs.inconsistencies ?? [];
  const inconsistenciesByDoc = new Map<string, RowInconsistency[]>();
  for (const inc of allInconsistencies) {
    const list = inconsistenciesByDoc.get(inc.document) ?? [];
    list.push(inc);
    inconsistenciesByDoc.set(inc.document, list);
  }

  for (const [docId, gold] of goldDocs.entries()) {
    if (facetDocs.has(docId)) {
      commonDocIds.add(docId);
      const facet = facetDocs.get(docId)!;
      const docInconsistencies = inconsistenciesByDoc.get(docId) ?? [];

      const docDiscrepancies: Discrepancy[] = [];

      // Record any multi-row inconsistencies for compared fields
      for (const inc of docInconsistencies) {
        if (comparedFields.includes(inc.field)) {
          docDiscrepancies.push({
            document: docId,
            field: inc.field,
            gold: gold[inc.field] ?? null,
            facet: inc.values.join(', '),
            reason: '分面视图多行间取值不一致',
          });
        }
      }

      // Check compared fields that were not already marked inconsistent
      const inconsistentFields = new Set(docInconsistencies.map((i) => i.field));
      for (const f of comparedFields) {
        if (inconsistentFields.has(f)) continue;

        const gVal = gold[f] ?? null;
        const fVal = facet[f] ?? null;
        if (!matchFieldValue(f, gVal, fVal)) {
          docDiscrepancies.push({
            document: docId,
            field: f,
            gold: gVal,
            facet: fVal,
          });
        }
      }

      if (docDiscrepancies.length === 0) {
        equalCount += 1;
      } else {
        unequalCount += 1;
        discrepancies.push(...docDiscrepancies);
      }
    }
  }

  const onlyGoldCount = goldDocs.size - commonDocIds.size;
  const onlyFacetCount = facetDocs.size - commonDocIds.size;

  const lines = [
    `用例索引分面视图与独立依据比较：相等 ${equalCount} 份文档，不等 ${unequalCount} 份文档，仅在独立依据 ${onlyGoldCount} 份，仅在分面视图 ${onlyFacetCount} 份`,
  ];
  for (const f of uncomparedFields) {
    lines.push(`字段 ${f}：视图里没有这个字段，未比对`);
  }
  if (allInconsistencies.length > 0) {
    lines.push('分面视图多行间取值不一致的文档：');
    for (const inc of allInconsistencies) {
      lines.push(`  - 文档 ${inc.document}：字段 ${inc.field} 在多行中出现不同取值 [${inc.values.join(', ')}]`);
    }
  }
  if (discrepancies.length > 0) {
    lines.push('不等的文档详细差异：');
    for (const d of discrepancies) {
      const reasonSuffix = d.reason ? `（${d.reason}）` : '';
      lines.push(`  - 文档 ${d.document}：字段 ${d.field} 独立依据“${d.gold ?? '无'}” vs 分面视图“${d.facet ?? '无'}”${reasonSuffix}`);
    }
  }

  return {
    equal: equalCount,
    unequal: unequalCount,
    onlyGold: onlyGoldCount,
    onlyFacet: onlyFacetCount,
    uncomparedFields,
    inconsistencies: allInconsistencies,
    discrepancies,
    summary: lines.join('\n'),
  };
}

export async function main(argv: string[]): Promise<number> {
  const value = (name: string): string | undefined => {
    const at = argv.indexOf(`--${name}`);
    return at >= 0 ? argv[at + 1] : undefined;
  };

  const facetsPath = value('facets');
  const goldPath = value('gold');
  const outPath = value('out');

  if (!facetsPath || !goldPath) {
    process.stderr.write('用法：node scripts/real/accept/location-index.ts --facets <facets.json> --gold <locations.json> [--out <report.json>]\n');
    return 2;
  }

  try {
    const facetsJson = JSON.parse(readFileSync(resolve(facetsPath), 'utf8')) as unknown;
    const goldJson = JSON.parse(readFileSync(resolve(goldPath), 'utf8')) as unknown;

    const result = compareLocationIndex(facetsJson, goldJson);
    process.stdout.write(`${result.summary}\n`);

    if (outPath) {
      writeFileSync(resolve(outPath), `${JSON.stringify(result, null, 2)}\n`);
    }

    return result.unequal === 0 ? 0 : 1;
  } catch (error) {
    process.stderr.write(`比较用例索引分面视图与独立依据失败：${(error as Error).message.split('\n')[0]}\n`);
    return 1;
  }
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('accept/location-index.ts')) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}

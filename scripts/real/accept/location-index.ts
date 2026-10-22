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

export interface Discrepancy {
  document: string;
  field: 'line' | 'train' | 'module';
  gold: string | null;
  facet: string | null;
}

export interface LocationIndexComparison {
  equal: number;
  unequal: number;
  onlyGold: number;
  onlyFacet: number;
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

/**
 * Extracts document records from facet view JSON.
 */
export function parseFacetView(raw: unknown): Map<string, { line: string | null; train: string | null; module: string | null }> {
  const result = new Map<string, { line: string | null; train: string | null; module: string | null }>();
  if (!raw || typeof raw !== 'object') return result;

  const top = raw as Record<string, unknown>;
  const rows = Array.isArray(top.rows) ? top.rows : [];

  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const values = (row as { values?: unknown }).values;
    if (!values || typeof values !== 'object') continue;
    const v = values as FacetRowValues;
    if (v.document === undefined || v.document === null) continue;
    const docId = String(v.document).trim();
    if (!docId) continue;

    const line = typeof v.line === 'string' ? v.line.trim() : null;
    const train = typeof v.train === 'string' ? v.train.trim() : null;
    const moduleName = typeof v.module === 'string' ? v.module.trim() : null;

    result.set(docId, { line, train, module: moduleName });
  }

  return result;
}

/**
 * Extracts conforming document records from gold input (either LocationsGold or DocumentLocationGold array).
 */
export function parseGoldLocations(raw: unknown): Map<string, { line: string; train: string; module: string }> {
  const result = new Map<string, { line: string; train: string; module: string }>();
  if (!raw || typeof raw !== 'object') return result;

  const list: DocumentLocationGold[] = Array.isArray(raw)
    ? (raw as DocumentLocationGold[])
    : Array.isArray((raw as LocationsGold).documents)
      ? (raw as LocationsGold).documents
      : [];

  for (const doc of list) {
    if (!doc || typeof doc !== 'object') continue;
    if (typeof doc.document === 'string' && doc.document.trim()) {
      result.set(doc.document.trim(), {
        line: doc.line ?? '',
        train: doc.train ?? '',
        module: doc.module ?? '',
      });
    }
  }

  return result;
}

/**
 * Compares facet view entries against independent gold locations.
 */
export function compareLocationIndex(facetsInput: unknown, goldInput: unknown): LocationIndexComparison {
  const facetDocs = parseFacetView(facetsInput);
  const goldDocs = parseGoldLocations(goldInput);

  let equalCount = 0;
  let unequalCount = 0;
  const discrepancies: Discrepancy[] = [];

  const commonDocIds = new Set<string>();

  for (const [docId, gold] of goldDocs.entries()) {
    if (facetDocs.has(docId)) {
      commonDocIds.add(docId);
      const facet = facetDocs.get(docId)!;

      const lineMatches = lineKey(gold.line) === lineKey(facet.line ?? '');
      const trainMatches = gold.train === (facet.train ?? '');
      const moduleMatches = gold.module === (facet.module ?? '');

      if (lineMatches && trainMatches && moduleMatches) {
        equalCount += 1;
      } else {
        unequalCount += 1;
        if (!lineMatches) {
          discrepancies.push({ document: docId, field: 'line', gold: gold.line, facet: facet.line });
        }
        if (!trainMatches) {
          discrepancies.push({ document: docId, field: 'train', gold: gold.train, facet: facet.train });
        }
        if (!moduleMatches) {
          discrepancies.push({ document: docId, field: 'module', gold: gold.module, facet: facet.module });
        }
      }
    }
  }

  const onlyGoldCount = goldDocs.size - commonDocIds.size;
  const onlyFacetCount = facetDocs.size - commonDocIds.size;

  const lines = [
    `用例索引分面视图与独立依据比较：相等 ${equalCount} 份文档，不等 ${unequalCount} 份文档，仅在独立依据 ${onlyGoldCount} 份，仅在分面视图 ${onlyFacetCount} 份`,
  ];
  if (discrepancies.length > 0) {
    lines.push('不等的文档详细差异：');
    for (const d of discrepancies) {
      lines.push(`  - 文档 ${d.document}：字段 ${d.field} 独立依据“${d.gold ?? '无'}” vs 分面视图“${d.facet ?? '无'}”`);
    }
  }

  return {
    equal: equalCount,
    unequal: unequalCount,
    onlyGold: onlyGoldCount,
    onlyFacet: onlyFacetCount,
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

// Tests for scripts/real/accept/location-index.ts:
// - parseFacetView: extracts document fields from facet view
// - parseGoldLocations: extracts document fields from locations gold
// - compareLocationIndex: equal, unequal, onlyGold, onlyFacet, discrepancies details
// - main CLI: exit codes, report writing
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  compareLocationIndex,
  main,
  parseFacetView,
  parseGoldLocations,
} from './location-index.ts';

describe('location index comparison', () => {
  it('parseFacetView extracts document records from facet view rows', () => {
    const raw = {
      schema: 'facet-view@1',
      rows: [
        {
          values: { document: '900101', line: '7.1', train: '7.1-R2-2026/5', module: '信标' },
          count: 10,
        },
        {
          values: { document: '900102', line: '7.1', train: '7.1-R2-2026/5', module: null },
          count: 5,
        },
      ],
    };

    const map = parseFacetView(raw);
    assert.equal(map.size, 2);
    assert.deepEqual(map.get('900101'), { line: '7.1', train: '7.1-R2-2026/5', module: '信标' });
    assert.deepEqual(map.get('900102'), { line: '7.1', train: '7.1-R2-2026/5', module: null });
  });

  it('parseGoldLocations extracts document records from gold input', () => {
    const raw = {
      root: '7715',
      documents: [
        { document: '900101', line: '7.1', train: '7.1-R2-2026/5', module: '信标' },
        { document: '900103', line: '7.1', train: '7.1-R2-2026/5', module: '健康检查' },
      ],
      nonconforming: [],
    };

    const map = parseGoldLocations(raw);
    assert.equal(map.size, 2);
    assert.deepEqual(map.get('900101'), { line: '7.1', train: '7.1-R2-2026/5', module: '信标' });
  });

  it('compareLocationIndex reports equal, unequal, and single-side counts with discrepancy details', () => {
    const facets = {
      schema: 'facet-view@1',
      rows: [
        {
          values: { document: '900101', line: '7.1.0', train: '7.1-R2-2026/5', module: '信标' }, // line matches 7.1 via lineKey
          count: 12,
        },
        {
          values: { document: '900102', line: '7.1', train: '7.1-R2-2026/5', module: '路由' }, // module mismatch (gold is 信标)
          count: 8,
        },
        {
          values: { document: '900103', line: '7.2', train: '7.2-R1-2026/7', module: '健康检查' }, // line mismatch (gold is 7.1)
          count: 15,
        },
        {
          values: { document: '900199', line: '7.1', train: '7.1-R2-2026/5', module: 'SSL' }, // only in facet
          count: 3,
        },
      ],
    };

    const gold = {
      root: '7715',
      documents: [
        { document: '900101', line: '7.1', train: '7.1-R2-2026/5', module: '信标' },
        { document: '900102', line: '7.1', train: '7.1-R2-2026/5', module: '信标' },
        { document: '900103', line: '7.1', train: '7.1-R2-2026/5', module: '健康检查' },
        { document: '900104', line: '7.2', train: '7.2-R1-2026/7', module: '健康检查' }, // only in gold
      ],
      nonconforming: [],
    };

    const result = compareLocationIndex(facets, gold);

    assert.equal(result.equal, 1); // 900101
    assert.equal(result.unequal, 2); // 900102, 900103
    assert.equal(result.onlyGold, 1); // 900104
    assert.equal(result.onlyFacet, 1); // 900199

    assert.equal(result.discrepancies.length, 3);

    const d102 = result.discrepancies.find((d) => d.document === '900102' && d.field === 'module')!;
    assert.equal(d102.gold, '信标');
    assert.equal(d102.facet, '路由');

    const d103Line = result.discrepancies.find((d) => d.document === '900103' && d.field === 'line')!;
    assert.equal(d103Line.gold, '7.1');
    assert.equal(d103Line.facet, '7.2');

    const d103Train = result.discrepancies.find((d) => d.document === '900103' && d.field === 'train')!;
    assert.equal(d103Train.gold, '7.1-R2-2026/5');
    assert.equal(d103Train.facet, '7.2-R1-2026/7');

    assert.match(result.summary, /相等 1 份文档，不等 2 份文档/);
    assert.match(result.summary, /仅在独立依据 1 份，仅在分面视图 1 份/);
  });

  it('main CLI exits 0 on match and exits 1 on discrepancy', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'location-index-test-'));
    try {
      const facetsPath = join(dir, 'facets.json');
      const goldPath = join(dir, 'gold.json');
      const reportPath = join(dir, 'report.json');

      const matchingFacets = {
        schema: 'facet-view@1',
        rows: [
          { values: { document: '900101', line: '7.1', train: '7.1-R2-2026/5', module: '信标' }, count: 1 },
        ],
      };
      const matchingGold = {
        documents: [
          { document: '900101', line: '7.1', train: '7.1-R2-2026/5', module: '信标' },
        ],
      };

      writeFileSync(facetsPath, JSON.stringify(matchingFacets));
      writeFileSync(goldPath, JSON.stringify(matchingGold));

      const code0 = await main(['--facets', facetsPath, '--gold', goldPath, '--out', reportPath]);
      assert.equal(code0, 0);

      // Now create a mismatch
      const mismatchFacets = {
        schema: 'facet-view@1',
        rows: [
          { values: { document: '900101', line: '7.2', train: '7.1-R2-2026/5', module: '信标' }, count: 1 },
        ],
      };
      writeFileSync(facetsPath, JSON.stringify(mismatchFacets));

      const code1 = await main(['--facets', facetsPath, '--gold', goldPath]);
      assert.equal(code1, 1);

      // Missing arguments
      const code2 = await main(['--facets', facetsPath]);
      assert.equal(code2, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

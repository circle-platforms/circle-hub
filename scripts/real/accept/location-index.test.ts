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
  extractFacetBy,
  main,
  matchFieldValue,
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

  it('extractFacetBy handles array, comma-separated string, and missing fields', () => {
    assert.deepEqual(extractFacetBy({ by: ['document', 'line', 'module'] }), ['document', 'line', 'module']);
    assert.deepEqual(extractFacetBy({ by: 'document, line, module' }), ['document', 'line', 'module']);
    assert.deepEqual(extractFacetBy({ facets: ['line', 'train'] }), ['line', 'train']);
    assert.deepEqual(extractFacetBy({ dimensions: 'line,module' }), ['line', 'module']);
    assert.equal(extractFacetBy({ schema: 'facet-view@1' }), null);
    assert.equal(extractFacetBy(null), null);
  });

  it('handles facet view with custom by (without train) and multiple rows per document', () => {
    // Real facet shape:
    // by = ['document', 'line', 'module', 'has_expected', 'vague_expected', 'negative']
    // Doc 950001: appears in two rows (has_expected true & false), same line & module -> consistent and equal
    // Doc 950002: appears in two rows with conflicting line ('7.1' vs '7.2') -> inconsistent, unequal
    // Doc 950003: appears in one row, matches line & module, gold has train -> equal (train is not in by, so not compared)
    const facets = {
      schema: 'facet-view@1',
      by: ['document', 'line', 'module', 'has_expected', 'vague_expected', 'negative'],
      rows: [
        {
          values: { document: '950001', line: '7.1', module: '信标', has_expected: true, vague_expected: false, negative: false },
          count: 5,
        },
        {
          values: { document: '950001', line: '7.1', module: '信标', has_expected: false, vague_expected: false, negative: false },
          count: 3,
        },
        {
          values: { document: '950002', line: '7.1', module: '信标', has_expected: true, vague_expected: false, negative: false },
          count: 2,
        },
        {
          values: { document: '950002', line: '7.2', module: '信标', has_expected: false, vague_expected: false, negative: false },
          count: 1,
        },
        {
          values: { document: '950003', line: '7.1', module: '路由', has_expected: true, vague_expected: false, negative: false },
          count: 4,
        },
      ],
    };

    const gold = {
      root: '7716',
      documents: [
        { document: '950001', line: '7.1', train: '7.1-R2-2026/5', module: '信标' },
        { document: '950002', line: '7.1', train: '7.1-R2-2026/5', module: '信标' },
        { document: '950003', line: '7.1', train: '7.1-R2-2026/5', module: '路由' },
      ],
      nonconforming: [],
    };

    const result = compareLocationIndex(facets, gold);

    // 950001: equal (train omitted from by, line and module match)
    // 950003: equal (train omitted from by, line and module match)
    // 950002: unequal (line has inconsistent values '7.1' and '7.2' across rows)
    assert.equal(result.equal, 2);
    assert.equal(result.unequal, 1);
    assert.deepEqual(result.uncomparedFields, ['train']);
    assert.match(result.summary, /字段 train：视图里没有这个字段，未比对/);
    assert.match(result.summary, /分面视图多行间取值不一致的文档/);
    assert.match(result.summary, /文档 950002：字段 line 在多行中出现不同取值 \[7.1, 7.2\]/);

    assert.equal(result.inconsistencies.length, 1);
    assert.equal(result.inconsistencies[0].document, '950002');
    assert.equal(result.inconsistencies[0].field, 'line');
    assert.deepEqual(result.inconsistencies[0].values, ['7.1', '7.2']);

    const d950002 = result.discrepancies.find((d) => d.document === '950002')!;
    assert.ok(d950002);
    assert.equal(d950002.field, 'line');
    assert.equal(d950002.gold, '7.1');
    assert.equal(d950002.facet, '7.1, 7.2');
    assert.equal(d950002.reason, '分面视图多行间取值不一致');
  });

  it('handles partial locations where document is directly under release train (no module layer)', () => {
    // Synthetic case 1: "火车下面直接放文档"
    // Document 950021 is placed directly under train folder, so module is null and conforming is false.
    // Facet view has by=['document', 'line', 'module'], line='10.6.1', module=null.
    // They must compare equal on both line and module (null === null).
    const facets = {
      schema: 'facet-view@1',
      by: ['document', 'line', 'module'],
      rows: [
        {
          values: { document: '950021', line: '10.6.1', module: null },
          count: 8,
        },
      ],
    };

    const gold = {
      root: '7716',
      documents: [],
      nonconforming: [
        {
          document: '950021',
          title: '需求 950021 探活配置',
          ancestors: ['030：项目', '060：10.6.1', '004：10.6.1-R2-2026/7'],
          reason: '发布火车下面没有模块层',
          line: '10.6.1',
          train: '10.6.1-R2-2026/7',
          module: null,
          conforming: false,
        },
      ],
    };

    const result = compareLocationIndex(facets, gold);

    assert.equal(result.equal, 1);
    assert.equal(result.unequal, 0);
    assert.equal(result.discrepancies.length, 0);
  });

  it('handles partial locations with missing version line (缺版本线) and compares nulls', () => {
    // Synthetic case 2: "缺版本线"
    // Document 950022 has no version line in ancestors -> line=null, train=null, module=null, conforming=false.
    // Facet view 1: line=null, module=null -> equal.
    // Document 950023: gold has line=null, but facet view has line='10.6.1' -> unequal discrepancy.
    const facets = {
      schema: 'facet-view@1',
      by: ['document', 'line', 'module'],
      rows: [
        {
          values: { document: '950022', line: null, module: null },
          count: 3,
        },
        {
          values: { document: '950023', line: '10.6.1', module: null },
          count: 2,
        },
      ],
    };

    const gold = {
      root: '7716',
      documents: [],
      nonconforming: [
        {
          document: '950022',
          title: '未归档文档一',
          ancestors: ['030：未归档项目'],
          reason: '缺少版本线节点',
          line: null,
          train: null,
          module: null,
          conforming: false,
        },
        {
          document: '950023',
          title: '未归档文档二',
          ancestors: ['030：未归档项目'],
          reason: '缺少版本线节点',
          line: null,
          train: null,
          module: null,
          conforming: false,
        },
      ],
    };

    const result = compareLocationIndex(facets, gold);

    assert.equal(result.equal, 1); // 950022 matches (both line and module are null)
    assert.equal(result.unequal, 1); // 950023 mismatches (gold.line is null, facet.line is '10.6.1')
    assert.equal(result.discrepancies.length, 1);

    const d23 = result.discrepancies[0];
    assert.equal(d23.document, '950023');
    assert.equal(d23.field, 'line');
    assert.equal(d23.gold, null);
    assert.equal(d23.facet, '10.6.1');
  });

  it('matchFieldValue compares null and non-null values correctly', () => {
    assert.equal(matchFieldValue('line', null, null), true);
    assert.equal(matchFieldValue('line', '', null), true);
    assert.equal(matchFieldValue('line', '10.6.0', '10.6'), true);
    assert.equal(matchFieldValue('line', '10.6.1', null), false);
    assert.equal(matchFieldValue('module', null, null), true);
    assert.equal(matchFieldValue('module', '信标', '信标'), true);
    assert.equal(matchFieldValue('module', '信标', null), false);
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

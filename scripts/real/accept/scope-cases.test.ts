// Synthetic tests for scripts/real/accept/scope-cases.ts (acceptance gap 6b, scope-cases):
//   - 两个根、三类路径的小例子：同一用例挂在两条变更路径下只算一个；挂在没变的路径下的不进期望；删除路径上的只进巡检
//   - 分页拼接
//   - 输入不全的判定（游标未取全、条目缺少 data）
//   - 比较的正反例与 50 条上限截断
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import {
  compareCaseSets,
  computeScopeCases,
  extractCasesFromNodes,
  extractCasesFromRun,
  main,
  parseGetNodesLines,
  renderReport,
  type CommandDiff,
  type KnowledgeNode,
  type RunShowExport,
} from './scope-cases.ts';

describe('scope-cases evaluation', () => {
  let tempDir: string;

  before(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'scope-cases-test-'));
  });

  after(() => {
    if (tempDir) {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  test('两个根、三类路径的小例子：去重、未变更排除、删除仅巡检', () => {
    const diff: CommandDiff = {
      added: ['/commands/sys/add'],
      modified: ['/commands/sys/mod'],
      removed: ['/commands/sys/del'],
    };

    // Later root:
    // - /commands/sys/add (added): case doc1:A
    // - /commands/sys/mod (modified): case doc1:A (duplicate across paths), case doc1:B
    // - /commands/sys/stay (unchanged): case doc1:Stay
    const laterNodes: KnowledgeNode[] = [
      {
        path: '/commands/sys/add',
        entries: [
          { kind: 'case', data: { document: 'doc1', node: 'A' }, statement: 'Case A on add' },
          { kind: 'definition', statement: 'Definition on add' },
        ],
      },
      {
        path: '/commands/sys/mod',
        entries: [
          { kind: 'case', data: { document: 'doc1', node: 'A' }, statement: 'Case A on mod' },
          { kind: 'case', data: { document: 'doc1', node: 'B' }, statement: 'Case B on mod' },
        ],
      },
      {
        path: '/commands/sys/stay',
        entries: [{ kind: 'case', data: { document: 'doc1', node: 'Stay' }, statement: 'Unchanged' }],
      },
    ];

    // Earlier root:
    // - /commands/sys/mod (modified): case doc1:B
    // - /commands/sys/del (removed): case doc1:C
    // - /commands/sys/stay (unchanged): case doc1:Stay
    const earlierNodes: KnowledgeNode[] = [
      {
        path: '/commands/sys/mod',
        entries: [{ kind: 'case', data: { document: 'doc1', node: 'B' }, statement: 'Case B on mod' }],
      },
      {
        path: '/commands/sys/del',
        entries: [{ kind: 'case', data: { document: 'doc1', node: 'C' }, statement: 'Case C on del' }],
      },
      {
        path: '/commands/sys/stay',
        entries: [{ kind: 'case', data: { document: 'doc1', node: 'Stay' }, statement: 'Unchanged' }],
      },
    ];

    const regressionRun: RunShowExport = {
      run: {
        items: [
          { id: 'doc1:A', label: 'Case A' },
          { id: 'doc1:B', label: 'Case B' },
        ],
      },
    };

    const maintenanceRun: RunShowExport = {
      run: {
        items: [
          { id: 'doc1:B', label: 'Case B' },
          { id: 'doc1:C', label: 'Case C' },
        ],
      },
    };

    const report = computeScopeCases({
      diff,
      earlierNodesLines: [JSON.stringify({ call_result: 'ok', nodes: earlierNodes, next: null })],
      laterNodesLines: [JSON.stringify({ call_result: 'ok', nodes: laterNodes, next: null })],
      regressionRun,
      maintenanceRun,
    });

    assert.equal(report.isIncomplete, false);
    assert.equal(report.allEqual, true);

    // Regression: doc1:A and doc1:B (doc1:Stay excluded, doc1:C from removed excluded)
    assert.equal(report.regression.expectedCount, 2);
    assert.equal(report.regression.actualCount, 2);
    assert.equal(report.regression.equal, true);

    // Maintenance: doc1:B and doc1:C (doc1:Stay excluded, doc1:A from added excluded)
    assert.equal(report.maintenance.expectedCount, 2);
    assert.equal(report.maintenance.actualCount, 2);
    assert.equal(report.maintenance.equal, true);
  });

  test('分页拼接：跨多行应答的游标翻页拼接完整', () => {
    const diff: CommandDiff = {
      added: ['/commands/page1'],
      modified: ['/commands/page2'],
      removed: [],
    };

    const lines = [
      JSON.stringify({
        call_result: 'ok',
        next: 'cursor-2',
        nodes: [{ path: '/commands/page1', entries: [{ kind: 'case', data: { document: 'd', node: '1' } }] }],
      }),
      JSON.stringify({
        call_result: 'ok',
        next: null,
        nodes: [{ path: '/commands/page2', entries: [{ kind: 'case', data: { document: 'd', node: '2' } }] }],
      }),
    ];

    const parsed = parseGetNodesLines(lines);
    assert.equal(parsed.incompleteReasons.length, 0);
    assert.equal(parsed.nodes.length, 2);

    const regressionPaths = new Set(['/commands/page1', '/commands/page2']);
    const extracted = extractCasesFromNodes(parsed.nodes, regressionPaths);
    assert.equal(extracted.incompleteReasons.length, 0);
    assert.deepEqual([...extracted.cases].sort(), ['d:1', 'd:2']);
  });

  test('输入不全的判定：游标未取全与条目缺少 data', () => {
    // Case 1: Unfinished cursor
    const unfinLines = [
      JSON.stringify({
        call_result: 'ok',
        next: 'cursor-dangling',
        nodes: [{ path: '/commands/p', entries: [{ kind: 'case', data: { document: 'd', node: '1' } }] }],
      }),
    ];
    const unfinParsed = parseGetNodesLines(unfinLines);
    assert.ok(unfinParsed.incompleteReasons.some((r) => r.includes('游标（cursor-dangling）')));

    // Case 2: Case entry without data
    const noDataNodes: KnowledgeNode[] = [
      {
        path: '/commands/p',
        entries: [{ kind: 'case', statement: 'bad entry without data' }],
      },
    ];
    const noDataExtracted = extractCasesFromNodes(noDataNodes, new Set(['/commands/p']));
    assert.ok(noDataExtracted.incompleteReasons.some((r) => r.includes('没有 data')));

    // Case 3: Case entry data missing document or node
    const missingFieldNodes: KnowledgeNode[] = [
      {
        path: '/commands/p',
        entries: [{ kind: 'case', data: { title: 'missing doc and node' } }],
      },
    ];
    const missingFieldExtracted = extractCasesFromNodes(missingFieldNodes, new Set(['/commands/p']));
    assert.ok(missingFieldExtracted.incompleteReasons.some((r) => r.includes('缺少 document 或 node')));

    // Integration check: computeScopeCases flags isIncomplete and does not report equal
    const diff: CommandDiff = { added: ['/commands/p'], modified: [], removed: [] };
    const report = computeScopeCases({
      diff,
      earlierNodesLines: [JSON.stringify({ call_result: 'ok', nodes: [], next: null })],
      laterNodesLines: unfinLines,
      regressionRun: { run: { items: [{ id: 'd:1' }] } },
      maintenanceRun: { run: { items: [] } },
    });
    assert.equal(report.isIncomplete, true);
    assert.equal(report.allEqual, false);

    const rendered = renderReport(report);
    assert.match(rendered, /输入缺项：/ );
    assert.match(rendered, /判定：输入不全/);
  });

  test('比较的正反例与 50 条上限截断', () => {
    const expected = new Set(['c1', 'c2', 'c3']);
    const actualMatching = new Set(['c1', 'c2', 'c3']);
    const compMatch = compareCaseSets(expected, actualMatching);
    assert.equal(compMatch.equal, true);
    assert.equal(compMatch.sharedCount, 3);
    assert.equal(compMatch.onlyInRun.length, 0);
    assert.equal(compMatch.onlyInExpected.length, 0);

    const actualMismatch = new Set(['c2', 'c3', 'cExtra']);
    const compMismatch = compareCaseSets(expected, actualMismatch);
    assert.equal(compMismatch.equal, false);
    assert.deepEqual(compMismatch.onlyInRun, ['cExtra']);
    assert.deepEqual(compMismatch.onlyInExpected, ['c1']);

    // Truncation check at 50
    const manyExpected = new Set<string>();
    for (let i = 1; i <= 65; i++) manyExpected.add(`missing:${i}`);
    const compMany = compareCaseSets(manyExpected, new Set());
    assert.equal(compMany.onlyInExpected.length, 65);

    const mockReport = {
      regressionPathsCount: 5,
      maintenancePathsCount: 2,
      isIncomplete: false,
      incompleteReasons: [],
      regression: compMany,
      maintenance: compMatch,
      allEqual: false,
    };
    const rendered = renderReport(mockReport);
    assert.match(rendered, /只在期望 65/);
    assert.match(rendered, /判定：不相等/);
  });

  test('extractCasesFromRun handles run.items and direct items with fallback to fields', () => {
    const runExport: RunShowExport = {
      items: [
        { id: 'doc1:node1' },
        { fields: { document: 'doc2', node: 'node2' } },
      ],
    };
    const extracted = extractCasesFromRun(runExport);
    assert.deepEqual([...extracted].sort(), ['doc1:node1', 'doc2:node2']);
  });

  test('main CLI reads files, exits 0 on match and exits 1 on mismatch', () => {
    const diffFile = join(tempDir, 'diff.json');
    const earlierFile = join(tempDir, 'earlier.jsonl');
    const laterFile = join(tempDir, 'later.jsonl');
    const regRunFile = join(tempDir, 'reg.json');
    const maintRunFile = join(tempDir, 'maint.json');

    writeFileSync(diffFile, JSON.stringify({ added: ['/commands/a'], modified: [], removed: ['/commands/b'] }));
    writeFileSync(earlierFile, JSON.stringify({ call_result: 'ok', nodes: [{ path: '/commands/b', entries: [{ kind: 'case', data: { document: 'd', node: 'm' } }] }] }));
    writeFileSync(laterFile, JSON.stringify({ call_result: 'ok', nodes: [{ path: '/commands/a', entries: [{ kind: 'case', data: { document: 'd', node: 'r' } }] }] }));
    writeFileSync(regRunFile, JSON.stringify({ run: { items: [{ id: 'd:r' }] } }));
    writeFileSync(maintRunFile, JSON.stringify({ run: { items: [{ id: 'd:m' }] } }));

    // Valid call exits 0
    const code0 = main([
      '--diff',
      diffFile,
      '--earlier-nodes',
      earlierFile,
      '--later-nodes',
      laterFile,
      '--regression-run',
      regRunFile,
      '--maintenance-run',
      maintRunFile,
    ]);
    assert.equal(code0, 0);

    // Mismatched run exits 1
    writeFileSync(regRunFile, JSON.stringify({ run: { items: [{ id: 'd:wrong' }] } }));
    const code1 = main([
      '--diff',
      diffFile,
      '--earlier-nodes',
      earlierFile,
      '--later-nodes',
      laterFile,
      '--regression-run',
      regRunFile,
      '--maintenance-run',
      maintRunFile,
    ]);
    assert.equal(code1, 1);

    // Missing args exits 2
    const code2 = main(['--diff', diffFile]);
    assert.equal(code2, 2);
  });
});

import { caseCommandsGold } from '../gold/case-commands.ts';
test('gold and legacy expectations agree, additional gold path changes verdict, excluded cases are removed', () => {
  const xml = '<commands><menu name="widget"><item name="add"/><item name="remove"/></menu></commands>';
  const map = { root: { data: { text: 'root' }, children: [{ data: { id: 'synthetic-case', text: 'widget add', resource: ['Functional'] } }, { data: { text: 'widget add', resource: ['Functional'] } }] } };
  const gold = caseCommandsGold(xml, [{ document: 'synthetic-doc', map }]);
  const diff = { added: ['/commands/widget/add'], removed: [], modified: [] };
  const runs = { regressionRun: { items: [{ id: 'synthetic-doc:synthetic-case' }, { id: 'synthetic-doc:@2' }] }, maintenanceRun: { items: [] } };
  const actual = computeScopeCases({ diff, earlierCases: gold, laterCases: gold, ...runs });
  const legacy = computeScopeCases({ diff, earlierNodesLines: [], laterNodesLines: [JSON.stringify({ nodes: [{ path: '/commands/widget/add', entries: [{ kind: 'case', data: { document: 'synthetic-doc', node: 'synthetic-case' } }] }] })], regressionRun: { items: [{ id: 'synthetic-doc:synthetic-case' }] }, maintenanceRun: { items: [] } });
  assert.deepEqual(actual.regression, legacy.regression); assert.equal(actual.allEqual, true); assert.equal(actual.excluded?.later, 1);
  const changed = structuredClone(gold); changed.cases.push({ ...changed.cases.find((c) => c.comparable)!, key: 'synthetic-doc:extra', node: 'extra' });
  const mismatch = computeScopeCases({ diff, earlierCases: gold, laterCases: changed, ...runs });
  assert.equal(mismatch.allEqual, false);
  assert.ok(!renderReport(mismatch).includes('synthetic-doc')); assert.ok(!renderReport(mismatch).includes('/commands/'));
});
test('incomplete legacy reasons are displayed as categories without private path or cursor values', () => {
  const report = computeScopeCases({ diff: { added: [], modified: [], removed: [] }, earlierNodesLines: [JSON.stringify({ next: 'opaque-private-cursor', nodes: [] })], laterNodesLines: [], regressionRun: { items: [] }, maintenanceRun: { items: [] } });
  const output = renderReport(report); assert.match(output, /分页未完 1 项/); assert.match(output, /下一步.*next/); assert.ok(!output.includes('opaque-private-cursor')); assert.ok(output.endsWith('判定：输入不全'));
});

test('scope comparison uses body placement while retaining title-only legacy measurements',()=>{
 const xml='<commands><menu name="widget"><item name="add"/></menu></commands>';
 const map={root:{data:{text:'root'},children:[{data:{id:'body',text:'plain',resource:['Functional']},children:[{data:{text:'widget add'},children:[{data:{text:'done'}}]}]}]}};
 const gold=caseCommandsGold(xml,[{document:'synthetic-body',map}]);assert.equal(gold.cases[0].paths.length,0);
 const input={diff:{added:['/commands/widget/add'],removed:[],modified:[]},earlierCases:gold,laterCases:gold,regressionRun:{items:[{id:'synthetic-body:body'}]},maintenanceRun:{items:[]}};
 assert.equal(computeScopeCases(input).allEqual,true);
 assert.equal(computeScopeCases({...input,regressionRun:{items:[]}}).allEqual,false);
});

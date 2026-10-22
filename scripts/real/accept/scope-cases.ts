// Compares the regression scope and maintenance sweep items of a build pair against the
// independent command diff and get_nodes outputs (acceptance gap 6b, scope-cases).
// Inputs:
//   - --diff: independent command diff from scripts/real/gold/command-diff.ts ({ added, removed, modified })
//   - --earlier-nodes: get_nodes responses for earlier root on changed paths (JSON Lines, paginated by cursor)
//   - --later-nodes: get_nodes responses for later root on changed paths (JSON Lines, paginated by cursor)
//   - --regression-run: circle-hub run show <run> --json export for the regression scope run
//   - --maintenance-run: circle-hub run show <run> --json export for the maintenance sweep run
//
// Rules (docs/hub-r4-tasks/scope-cases.md):
//   1. Expected regression scope: nodes on added and modified paths in later root, entries with kind === 'case',
//      deduped by data.document and data.node.
//   2. Expected maintenance sweep: nodes on removed and modified paths in earlier root, entries with kind === 'case',
//      deduped by data.document and data.node.
//   3. Compare item by item with the run items (id as document:node).
//   4. Report incomplete input (without judging equality) if:
//      - any get_nodes response has a next page cursor without a following page in the file;
//      - or any case entry lacks data (or document/node in data).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface CommandDiff {
  added: string[];
  removed: string[];
  modified: string[];
}

export interface NodeEntry {
  entry?: string;
  kind?: string;
  statement?: string;
  reference?: string;
  applicability?: string;
  data?: Record<string, unknown>;
}

export interface KnowledgeNode {
  path: string;
  name?: string;
  level?: string;
  digest?: string;
  entries?: NodeEntry[];
}

export interface GetNodesOutput {
  call_result?: 'ok' | 'error';
  next?: string | null;
  root?: string;
  nodes?: KnowledgeNode[];
  errors?: unknown[];
}

export interface RunItem {
  id?: string;
  label?: string;
  fields?: Record<string, unknown>;
  summary?: string;
  location?: unknown;
}

export interface RunShowExport {
  run?: {
    items?: RunItem[];
    [key: string]: unknown;
  };
  items?: RunItem[];
  [key: string]: unknown;
}

export interface ParsedGetNodes {
  nodes: KnowledgeNode[];
  incompleteReasons: string[];
}

/** Parses get_nodes JSONL responses and checks for unfinished pagination. */
export function parseGetNodesLines(lines: readonly string[]): ParsedGetNodes {
  const nodes: KnowledgeNode[] = [];
  const incompleteReasons: string[] = [];

  const validLines: GetNodesOutput[] = [];
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as GetNodesOutput;
      validLines.push(parsed);
    } catch (error) {
      incompleteReasons.push(`第 ${i + 1} 行不是有效 JSON：${(error as Error).message}`);
    }
  }

  if (validLines.length === 0 && lines.length > 0) {
    incompleteReasons.push('文件没有有效的应答行');
    return { nodes, incompleteReasons };
  }

  for (let i = 0; i < validLines.length; i++) {
    const resp = validLines[i];
    if (resp.call_result === 'error') {
      incompleteReasons.push(`第 ${i + 1} 行应答为出错（call_result: error）`);
    }

    const next = resp.next;
    const hasNext = typeof next === 'string' && next.length > 0;
    if (hasNext && i === validLines.length - 1) {
      incompleteReasons.push(`第 ${i + 1} 行带着下一页游标（${next}），文件里却没有下一页`);
    }

    if (Array.isArray(resp.nodes)) {
      for (const node of resp.nodes) {
        nodes.push(node);
      }
    }
  }

  return { nodes, incompleteReasons };
}

/** Extracts unique case ids (document:node) from nodes on relevant paths, checking for missing data. */
export function extractCasesFromNodes(
  nodes: readonly KnowledgeNode[],
  relevantPaths: ReadonlySet<string>,
): { cases: Set<string>; incompleteReasons: string[] } {
  const cases = new Set<string>();
  const incompleteReasons: string[] = [];

  for (const node of nodes) {
    if (!relevantPaths.has(node.path)) continue;
    const entries = node.entries ?? [];
    for (const entry of entries) {
      if (entry.kind === 'case') {
        if (!entry.data || typeof entry.data !== 'object' || Array.isArray(entry.data)) {
          incompleteReasons.push(`节点 ${node.path} 上的用例条目（${entry.entry ?? entry.statement ?? 'unknown'}）没有 data`);
          continue;
        }
        const doc = entry.data.document;
        const nodeId = entry.data.node;
        if (doc === undefined || doc === null || nodeId === undefined || nodeId === null) {
          incompleteReasons.push(`节点 ${node.path} 上的用例条目 data 里缺少 document 或 node`);
          continue;
        }
        cases.add(`${String(doc)}:${String(nodeId)}`);
      }
    }
  }

  return { cases, incompleteReasons };
}

/** Extracts actual case ids (document:node) from run show --json export. */
export function extractCasesFromRun(runData: RunShowExport): Set<string> {
  const items = runData.run?.items ?? runData.items ?? [];
  const cases = new Set<string>();

  for (const item of items) {
    if (typeof item.id === 'string' && item.id.length > 0) {
      cases.add(item.id);
    } else if (item.fields && item.fields.document !== undefined && item.fields.node !== undefined) {
      cases.add(`${String(item.fields.document)}:${String(item.fields.node)}`);
    }
  }

  return cases;
}

export interface SetComparison {
  expectedCount: number;
  actualCount: number;
  sharedCount: number;
  onlyInRun: string[];
  onlyInExpected: string[];
  equal: boolean;
}

export function compareCaseSets(expected: ReadonlySet<string>, actual: ReadonlySet<string>): SetComparison {
  const shared: string[] = [];
  const onlyInRun: string[] = [];
  const onlyInExpected: string[] = [];

  for (const id of actual) {
    if (expected.has(id)) {
      shared.push(id);
    } else {
      onlyInRun.push(id);
    }
  }
  for (const id of expected) {
    if (!actual.has(id)) {
      onlyInExpected.push(id);
    }
  }

  shared.sort();
  onlyInRun.sort();
  onlyInExpected.sort();

  return {
    expectedCount: expected.size,
    actualCount: actual.size,
    sharedCount: shared.length,
    onlyInRun,
    onlyInExpected,
    equal: onlyInRun.length === 0 && onlyInExpected.length === 0,
  };
}

export interface ScopeCasesReport {
  regressionPathsCount: number;
  maintenancePathsCount: number;
  isIncomplete: boolean;
  incompleteReasons: string[];
  regression: SetComparison;
  maintenance: SetComparison;
  allEqual: boolean;
}

export function computeScopeCases(inputs: {
  diff: CommandDiff;
  earlierNodesLines: readonly string[];
  laterNodesLines: readonly string[];
  regressionRun: RunShowExport;
  maintenanceRun: RunShowExport;
}): ScopeCasesReport {
  const regressionPaths = new Set<string>([...inputs.diff.added, ...inputs.diff.modified]);
  const maintenancePaths = new Set<string>([...inputs.diff.removed, ...inputs.diff.modified]);

  const earlierParsed = parseGetNodesLines(inputs.earlierNodesLines);
  const laterParsed = parseGetNodesLines(inputs.laterNodesLines);

  const laterCasesResult = extractCasesFromNodes(laterParsed.nodes, regressionPaths);
  const earlierCasesResult = extractCasesFromNodes(earlierParsed.nodes, maintenancePaths);

  const incompleteReasons: string[] = [
    ...earlierParsed.incompleteReasons.map((r) => `前一个构建：${r}`),
    ...laterParsed.incompleteReasons.map((r) => `后一个构建：${r}`),
    ...earlierCasesResult.incompleteReasons.map((r) => `前一个构建：${r}`),
    ...laterCasesResult.incompleteReasons.map((r) => `后一个构建：${r}`),
  ];
  const isIncomplete = incompleteReasons.length > 0;

  const actualRegressionCases = extractCasesFromRun(inputs.regressionRun);
  const actualMaintenanceCases = extractCasesFromRun(inputs.maintenanceRun);

  const regressionComparison = compareCaseSets(laterCasesResult.cases, actualRegressionCases);
  const maintenanceComparison = compareCaseSets(earlierCasesResult.cases, actualMaintenanceCases);

  const allEqual = !isIncomplete && regressionComparison.equal && maintenanceComparison.equal;

  return {
    regressionPathsCount: regressionPaths.size,
    maintenancePathsCount: maintenancePaths.size,
    isIncomplete,
    incompleteReasons,
    regression: regressionComparison,
    maintenance: maintenanceComparison,
    allEqual,
  };
}

export function renderReport(report: ScopeCasesReport): string {
  const lines: string[] = [];
  lines.push('== 跨版本线回归范围与维护巡检条目核对 ==');
  lines.push('');

  if (report.isIncomplete) {
    lines.push('【输入判定】输入不全（不作相等判定）：');
    for (const reason of report.incompleteReasons) {
      lines.push(`  - ${reason}`);
    }
    lines.push('');
  }

  lines.push(`【回归范围】（基于后一个根，新增+修改路径共 ${report.regressionPathsCount} 条）`);
  lines.push(`  - 期望条目：${report.regression.expectedCount} 个，实际运行：${report.regression.actualCount} 个`);
  lines.push(`  - 相等：${report.regression.sharedCount} 个，只在运行里：${report.regression.onlyInRun.length} 个，只在期望里：${report.regression.onlyInExpected.length} 个`);
  if (!report.isIncomplete) {
    lines.push(`  - 判定：${report.regression.equal ? '完全相等' : '不相等'}`);
  }
  if (report.regression.onlyInRun.length > 0) {
    lines.push(`  - 只在运行里的条目（共 ${report.regression.onlyInRun.length} 条${report.regression.onlyInRun.length > 50 ? '，前 50 条' : ''}）：`);
    for (const id of report.regression.onlyInRun.slice(0, 50)) {
      lines.push(`    * ${id}`);
    }
  }
  if (report.regression.onlyInExpected.length > 0) {
    lines.push(`  - 只在期望里的条目（共 ${report.regression.onlyInExpected.length} 条${report.regression.onlyInExpected.length > 50 ? '，前 50 条' : ''}）：`);
    for (const id of report.regression.onlyInExpected.slice(0, 50)) {
      lines.push(`    * ${id}`);
    }
  }

  lines.push('');
  lines.push(`【维护巡检】（基于前一个根，删除+修改路径共 ${report.maintenancePathsCount} 条）`);
  lines.push(`  - 期望条目：${report.maintenance.expectedCount} 个，实际运行：${report.maintenance.actualCount} 个`);
  lines.push(`  - 相等：${report.maintenance.sharedCount} 个，只在运行里：${report.maintenance.onlyInRun.length} 个，只在期望里：${report.maintenance.onlyInExpected.length} 个`);
  if (!report.isIncomplete) {
    lines.push(`  - 判定：${report.maintenance.equal ? '完全相等' : '不相等'}`);
  }
  if (report.maintenance.onlyInRun.length > 0) {
    lines.push(`  - 只在运行里的条目（共 ${report.maintenance.onlyInRun.length} 条${report.maintenance.onlyInRun.length > 50 ? '，前 50 条' : ''}）：`);
    for (const id of report.maintenance.onlyInRun.slice(0, 50)) {
      lines.push(`    * ${id}`);
    }
  }
  if (report.maintenance.onlyInExpected.length > 0) {
    lines.push(`  - 只在期望里的条目（共 ${report.maintenance.onlyInExpected.length} 条${report.maintenance.onlyInExpected.length > 50 ? '，前 50 条' : ''}）：`);
    for (const id of report.maintenance.onlyInExpected.slice(0, 50)) {
      lines.push(`    * ${id}`);
    }
  }

  lines.push('');
  if (report.isIncomplete) {
    lines.push('【最终结论】输入不全');
  } else if (report.allEqual) {
    lines.push('【最终结论】全部相等（回归范围与维护巡检用例均与期望完全一致）');
  } else {
    lines.push('【最终结论】存在不一致');
  }

  return lines.join('\n');
}

export function main(argv: string[] = process.argv.slice(2)): number {
  const value = (name: string): string | undefined => {
    const at = argv.indexOf(`--${name}`);
    return at >= 0 ? argv[at + 1] : undefined;
  };

  const diffPath = value('diff');
  const earlierNodesPath = value('earlier-nodes') ?? value('earlier');
  const laterNodesPath = value('later-nodes') ?? value('later');
  const regressionRunPath = value('regression-run') ?? value('regression');
  const maintenanceRunPath = value('maintenance-run') ?? value('maintenance');

  if (!diffPath || !earlierNodesPath || !laterNodesPath || !regressionRunPath || !maintenanceRunPath) {
    process.stderr.write(
      '用法：node scripts/real/accept/scope-cases.ts --diff <diff.json> --earlier-nodes <earlier.jsonl> --later-nodes <later.jsonl> --regression-run <reg.json> --maintenance-run <maint.json>\n',
    );
    return 2;
  }

  try {
    const diff = JSON.parse(readFileSync(resolve(diffPath), 'utf8')) as CommandDiff;
    const earlierLines = readFileSync(resolve(earlierNodesPath), 'utf8').split('\n');
    const laterLines = readFileSync(resolve(laterNodesPath), 'utf8').split('\n');
    const regressionRun = JSON.parse(readFileSync(resolve(regressionRunPath), 'utf8')) as RunShowExport;
    const maintenanceRun = JSON.parse(readFileSync(resolve(maintenanceRunPath), 'utf8')) as RunShowExport;

    const report = computeScopeCases({
      diff,
      earlierNodesLines: earlierLines,
      laterNodesLines: laterLines,
      regressionRun,
      maintenanceRun,
    });

    process.stdout.write(`${renderReport(report)}\n`);
    return report.allEqual ? 0 : 1;
  } catch (error) {
    process.stderr.write(`读取输入出错：${(error as Error).message}\n`);
    return 1;
  }
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('accept/scope-cases.ts')) {
  process.exitCode = main();
}

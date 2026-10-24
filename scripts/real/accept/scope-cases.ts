// Compares the regression scope and maintenance sweep items of a build pair against the
// independent command diff and case-command gold (or legacy get_nodes outputs) (acceptance gap 6b, scope-cases).
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
import { readFileSync, writeFileSync } from 'node:fs';
import { summarizeIncomplete, renderIncomplete } from './command-index.ts';
import { resolve } from 'node:path';
import { comparableNode, documentKey, sha256, type CommandsGold } from '../gold/case-commands.ts';

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
  excluded?: { earlier: number; later: number };
}

export function computeScopeCases(inputs: {
  diff: CommandDiff;
  earlierNodesLines?: readonly string[];
  laterNodesLines?: readonly string[];
  earlierCases?: CommandsGold;
  laterCases?: CommandsGold;
  regressionRun: RunShowExport;
  maintenanceRun: RunShowExport;
}): ScopeCasesReport {
  const regressionPaths = new Set<string>([...inputs.diff.added, ...inputs.diff.modified]);
  const maintenancePaths = new Set<string>([...inputs.diff.removed, ...inputs.diff.modified]);

  const earlierParsed = parseGetNodesLines(inputs.earlierNodesLines ?? []);
  const laterParsed = parseGetNodesLines(inputs.laterNodesLines ?? []);

  const laterCasesResult = inputs.laterCases ? casesFromGold(inputs.laterCases, regressionPaths) : extractCasesFromNodes(laterParsed.nodes, regressionPaths);
  const earlierCasesResult = inputs.earlierCases ? casesFromGold(inputs.earlierCases, maintenancePaths) : extractCasesFromNodes(earlierParsed.nodes, maintenancePaths);

  const incompleteReasons: string[] = [
    ...earlierParsed.incompleteReasons.map((r) => `前一个构建：${r}`),
    ...laterParsed.incompleteReasons.map((r) => `后一个构建：${r}`),
    ...earlierCasesResult.incompleteReasons.map((r) => `前一个构建：${r}`),
    ...laterCasesResult.incompleteReasons.map((r) => `后一个构建：${r}`),
  ];
  if (!!inputs.earlierCases !== !!inputs.laterCases) incompleteReasons.push('前后构建必须同时给 gold');
  if ((inputs.earlierCases || inputs.laterCases) && (inputs.earlierNodesLines || inputs.laterNodesLines)) incompleteReasons.push('gold 与节点方式不能混用');
  const isIncomplete = incompleteReasons.length > 0;

  const actualRegressionCases = filterRun(inputs.regressionRun, inputs.laterCases);
  const actualMaintenanceCases = filterRun(inputs.maintenanceRun, inputs.earlierCases);

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
    excluded: { earlier: inputs.earlierCases?.totals.excluded ?? 0, later: inputs.laterCases?.totals.excluded ?? 0 },
  };
}

function casesFromGold(gold: CommandsGold, paths: ReadonlySet<string>): { cases: Set<string>; incompleteReasons: string[] } {
  if (gold.schema !== 'case-commands-gold@1' || !Array.isArray(gold.cases)) throw new Error('金标准格式无效');
  return { cases: new Set(gold.cases.filter((c) => c.comparable && (c.placement_paths??c.paths).some((p) => paths.has(p.path))).map((c) => c.key)), incompleteReasons: [] };
}
function filterRun(run: RunShowExport, gold?: CommandsGold): Set<string> {
  const cases = extractCasesFromRun(run);
  if (!gold) return cases;
  const excluded = new Set(gold.cases.filter((c) => !c.comparable).map((c) => c.key));
  return new Set([...cases].map((key) => documentKey(key)).filter((key) => {
    const node = key.slice(key.lastIndexOf(':') + 1);
    return comparableNode(node) && !excluded.has(key);
  }));
}
export function renderReport(report: ScopeCasesReport): string {
  const lines = [`路径：回归 ${report.regressionPathsCount}，巡检 ${report.maintenancePathsCount}`, `不比较：前一构建 ${report.excluded?.earlier ?? 0}，后一构建 ${report.excluded?.later ?? 0}`, `输入缺项：${report.incompleteReasons.length}`];
  for (const [name, comparison] of [['回归范围', report.regression], ['维护巡检', report.maintenance]] as const) {
    lines.push(`${name}：期望 ${comparison.expectedCount}，运行 ${comparison.actualCount}，共有 ${comparison.sharedCount}，只在运行 ${comparison.onlyInRun.length}，只在期望 ${comparison.onlyInExpected.length}`);
    lines.push(`${name}差异 SHA-256：${sha256(JSON.stringify({ onlyInRun: comparison.onlyInRun, onlyInExpected: comparison.onlyInExpected }))}`);
  }
  lines.push(...renderIncomplete(summarizeIncomplete(report.incompleteReasons)));
  lines.push(`判定：${report.isIncomplete ? '输入不全' : report.allEqual ? '相等' : '不相等'}`);
  return lines.join('\n');
}

export function main(argv: string[] = process.argv.slice(2)): number {
  const value = (name: string): string | undefined => {
    const at = argv.indexOf(`--${name}`);
    return at >= 0 ? argv[at + 1] : undefined;
  };

  const diffPath = value('diff');
  const earlierCasesPath = value('earlier-cases');
  const laterCasesPath = value('later-cases');
  const earlierNodesPath = value('earlier-nodes') ?? value('earlier');
  const laterNodesPath = value('later-nodes') ?? value('later');
  const regressionRunPath = value('regression-run') ?? value('regression');
  const maintenanceRunPath = value('maintenance-run') ?? value('maintenance');

  if (!diffPath || !(earlierCasesPath && laterCasesPath || earlierNodesPath && laterNodesPath) || !!earlierCasesPath !== !!laterCasesPath || !!earlierCasesPath && !!(earlierNodesPath || laterNodesPath) || !regressionRunPath || !maintenanceRunPath) {
    process.stderr.write(
      '用法：node scripts/real/accept/scope-cases.ts --diff <diff.json> (--earlier-cases <gold.json> --later-cases <gold.json> | --earlier-nodes <earlier.jsonl> --later-nodes <later.jsonl>) --out <report.json> --regression-run <reg.json> --maintenance-run <maint.json>\n',
    );
    return 2;
  }

  try {
    const diff = JSON.parse(readFileSync(resolve(diffPath), 'utf8')) as CommandDiff;
    const earlierLines = earlierNodesPath ? readFileSync(resolve(earlierNodesPath), 'utf8').split('\n') : undefined;
    const laterLines = laterNodesPath ? readFileSync(resolve(laterNodesPath), 'utf8').split('\n') : undefined;
    const regressionRun = JSON.parse(readFileSync(resolve(regressionRunPath), 'utf8')) as RunShowExport;
    const maintenanceRun = JSON.parse(readFileSync(resolve(maintenanceRunPath), 'utf8')) as RunShowExport;

    const report = computeScopeCases({
      diff,
      earlierCases: earlierCasesPath ? JSON.parse(readFileSync(earlierCasesPath, 'utf8')) as CommandsGold : undefined,
      laterCases: laterCasesPath ? JSON.parse(readFileSync(laterCasesPath, 'utf8')) as CommandsGold : undefined,
      earlierNodesLines: earlierLines,
      laterNodesLines: laterLines,
      regressionRun,
      maintenanceRun,
    });

    if (value('out')) writeFileSync(value('out')!, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${renderReport(report)}\n`);
    return report.allEqual ? 0 : 1;
  } catch (error) {
    process.stderr.write('读取输入出错：检查格式和文件可读性\n');
    return 1;
  }
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('accept/scope-cases.ts')) {
  process.exitCode = main();
}

// Metamorphic check for template gap on real mindmaps (architecture 6b, Part B).
// Given an exported original mindmap and the Hub's template-gap check result on it:
// For categories marked as present ("有", at most 3):
// - Replica 1: delete all case nodes covering this category (listed in evidence).
// - Replica 2: restore one of the deleted case nodes into Replica 1.
// - Replica 3: reverse sibling nodes at every level of the original mindmap.
// Uploads replicas as application/json via upload_file, runs template-gap via start_run (hub-call.ts),
// and checks:
// - Replica 1: this category is missing (缺) and all other categories remain unchanged.
// - Replica 2: this category is present (有).
// - Replica 3: item summary and check report match the original.
// Reports expected and actual for each check.
// Imports nothing from hub/ or packs/.
//
// Usage:
//   node scripts/real/accept/template-gap-metamorphic.ts \
//     --mindmap <mindmap.km.json> \
//     --result <result.json> \
//     [--token-file <token> | --token-env <env>] \
//     [--url <http://127.0.0.1:7420/mcp>] \
//     [--session <id>] \
//     [--max-categories 3] \
//     [--out <report.md>]
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Check, Report } from '../lib/report.ts';
import { renderReport, summary } from '../lib/report.ts';
import { callTools, type CallOptions, type ToolText } from '../hub-call.ts';

export interface KmNodeData {
  id?: string;
  text?: string;
  priority?: number;
  resource?: string[];
  [key: string]: unknown;
}

export interface KmNode {
  data: KmNodeData;
  children: KmNode[];
}

export interface KityMinderDoc {
  root: KmNode;
  template?: string;
  theme?: string;
  version?: string;
  [key: string]: unknown;
}

export interface CategoryResult {
  id: string;
  label: string;
  present: boolean;
  count: number;
  evidence: string[];
}

export interface HubGapResult {
  documentId?: string;
  categories: CategoryResult[];
  summary?: string;
  missing?: string[];
  reportText?: string;
}

export interface RemovedNodeRecord {
  node: KmNode;
  parentId: string | null;
  index: number;
}

export type ToolCaller = (calls: Array<{ tool: string; args: unknown }>) => Promise<ToolText[]>;

/**
 * Normalizes an evidence string into a bare node id.
 * Format in template-gap: "<documentId>:<nodeId>", bare "<nodeId>", or "<nodeId>#<copy>".
 */
export function cleanNodeId(evidenceStr: string): string {
  let s = evidenceStr.trim();
  const colonIdx = s.lastIndexOf(':');
  if (colonIdx >= 0) {
    s = s.slice(colonIdx + 1);
  }
  const hashIdx = s.indexOf('#');
  if (hashIdx >= 0) {
    s = s.slice(0, hashIdx);
  }
  return s.trim();
}

/**
 * Parses start_run plain text into HubGapResult when structured output is not provided.
 */
export function parseGapTextResult(text: string): HubGapResult {
  let summary: string | undefined;
  const itemMatch = /-\s+([0-9a-zA-Z_-]+)\s+\|\s+([^|\n]+)\s+\|\s+([^\n]+)/.exec(text);
  if (itemMatch) {
    summary = itemMatch[3].trim();
  } else {
    const sumMatch = /(用例\s*\d+\s*个[^\n]+)/.exec(text);
    if (sumMatch) summary = sumMatch[1].trim();
  }

  const missing: string[] = [];
  if (summary) {
    const missMatch = /缺\s*\d+\s*个模板类别(?:（[^）]+）)?：([^\n；;]+)/.exec(summary);
    if (missMatch) {
      const parts = missMatch[1].split(/[、,，]/);
      for (const part of parts) {
        const idMatch = /\(([^)]+)\)|（([^）]+)）/.exec(part);
        if (idMatch) {
          missing.push((idMatch[1] ?? idMatch[2]).trim());
        } else {
          const raw = part.trim();
          if (raw) missing.push(raw);
        }
      }
    }
  }

  return { categories: [], summary, missing, reportText: text };
}

/**
 * Extracts categories, summary, and missing list from any valid Hub result shape:
 * - { item: { summary, fields: { categories, missing } } }
 * - { items: [{ summary, fields: { categories, missing } }] }
 * - { run: { items: [...] } }
 * - { fields: { categories, missing } }
 * - raw start_run text
 */
export function extractGapResult(raw: unknown): HubGapResult {
  if (raw === undefined || raw === null) {
    return { categories: [], missing: [] };
  }

  let data = raw;
  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw);
    } catch {
      return parseGapTextResult(raw);
    }
  }

  if (!data || typeof data !== 'object') {
    return { categories: [], missing: [] };
  }

  const obj = data as Record<string, unknown>;

  let itemObj: Record<string, unknown> | null = null;
  if (Array.isArray(obj.items) && obj.items.length > 0 && typeof obj.items[0] === 'object') {
    itemObj = obj.items[0] as Record<string, unknown>;
  } else if (obj.item && typeof obj.item === 'object') {
    itemObj = obj.item as Record<string, unknown>;
  } else if (obj.run && typeof obj.run === 'object') {
    const run = obj.run as Record<string, unknown>;
    if (Array.isArray(run.items) && run.items.length > 0 && typeof run.items[0] === 'object') {
      itemObj = run.items[0] as Record<string, unknown>;
    }
  } else if (obj.fields && typeof obj.fields === 'object') {
    itemObj = obj;
  } else if (Array.isArray(obj.categories)) {
    itemObj = { fields: obj };
  }

  const fields = (itemObj?.fields && typeof itemObj.fields === 'object' ? itemObj.fields : itemObj) as Record<string, unknown> | null;
  const summary = (itemObj?.summary as string | undefined) ?? (fields?.summary as string | undefined);
  const documentId = (itemObj?.id as string | undefined) ?? (fields?.document as string | undefined);

  const missing: string[] = [];
  if (fields && Array.isArray(fields.missing)) {
    for (const m of fields.missing) {
      if (typeof m === 'string' && m) missing.push(m);
    }
  }

  const categories: CategoryResult[] = [];
  if (fields && Array.isArray(fields.categories)) {
    for (const c of fields.categories) {
      if (c && typeof c === 'object') {
        const cat = c as Record<string, unknown>;
        const id = typeof cat.id === 'string' ? cat.id : '';
        const label = typeof cat.label === 'string' ? cat.label : id;
        const present = cat.present === true;
        const count = typeof cat.count === 'number' ? cat.count : present ? 1 : 0;
        const evidence: string[] = [];
        if (Array.isArray(cat.evidence)) {
          for (const ev of cat.evidence) {
            if (typeof ev === 'string' && ev) evidence.push(ev);
          }
        }
        if (id) {
          categories.push({ id, label, present, count, evidence });
        }
      }
    }
  }

  return { documentId, categories, summary, missing };
}

/**
 * Replica 1: Deletes all case nodes in the mindmap tree whose data.id is in nodeIdsToRemove.
 * Leaves all other nodes and node IDs completely untouched.
 * Returns the modified mindmap and records of the removed nodes for Replica 2.
 */
export function createReplicaWithoutCategory(
  doc: KityMinderDoc,
  nodeIdsToRemove: Set<string>,
): { replica: KityMinderDoc; removedNodes: RemovedNodeRecord[] } {
  const replica = structuredClone(doc);
  const removedNodes: RemovedNodeRecord[] = [];

  const visit = (parent: KmNode): void => {
    if (!Array.isArray(parent.children) || parent.children.length === 0) return;

    const remainingChildren: KmNode[] = [];
    for (let i = 0; i < parent.children.length; i++) {
      const child = parent.children[i];
      const childId = child.data?.id;
      if (childId !== undefined && nodeIdsToRemove.has(childId)) {
        removedNodes.push({
          node: structuredClone(child),
          parentId: parent.data?.id ?? null,
          index: i,
        });
      } else {
        visit(child);
        remainingChildren.push(child);
      }
    }
    parent.children = remainingChildren;
  };

  visit(replica.root);
  return { replica, removedNodes };
}

/**
 * Replica 2: Restores one of the removed case nodes into Replica 1.
 * Places it back under its original parent node.
 * Node IDs and subtree structure remain completely untouched.
 */
export function createReplicaWithRestoredNode(
  replica1Doc: KityMinderDoc,
  nodeToRestore: RemovedNodeRecord,
): KityMinderDoc {
  const replica = structuredClone(replica1Doc);

  let inserted = false;
  const visit = (parent: KmNode): void => {
    if (inserted) return;
    const parentId = parent.data?.id ?? null;
    if (parentId === nodeToRestore.parentId || (nodeToRestore.parentId === null && parent === replica.root)) {
      const idx = Math.min(nodeToRestore.index, parent.children.length);
      parent.children.splice(idx, 0, structuredClone(nodeToRestore.node));
      inserted = true;
      return;
    }
    if (Array.isArray(parent.children)) {
      for (const child of parent.children) {
        visit(child);
        if (inserted) return;
      }
    }
  };

  visit(replica.root);
  if (!inserted) {
    replica.root.children.push(structuredClone(nodeToRestore.node));
  }

  return replica;
}

/**
 * Replica 3: Reverses sibling nodes at every level of the mindmap tree.
 * Node IDs, data, texts, and properties are completely unchanged.
 */
export function createReplicaWithReversedSiblings(doc: KityMinderDoc): KityMinderDoc {
  const replica = structuredClone(doc);

  const reverseLevel = (node: KmNode): void => {
    if (Array.isArray(node.children) && node.children.length > 0) {
      node.children.reverse();
      for (const child of node.children) {
        reverseLevel(child);
      }
    }
  };

  reverseLevel(replica.root);
  return replica;
}

/**
 * Uploads a mindmap JSON via upload_file and starts a template-gap run via start_run.
 */
export async function uploadAndRunReplica(
  replicaDoc: KityMinderDoc,
  caller: ToolCaller,
): Promise<{ reference: string; runResult: HubGapResult; text: string }> {
  const jsonContent = JSON.stringify(replicaDoc);
  const base64 = Buffer.from(jsonContent).toString('base64');

  const uploadResults = await caller([
    {
      tool: 'upload_file',
      args: { file_path: base64, media_type: 'application/json' },
    },
  ]);
  const uploadRes = uploadResults[0];
  if (uploadRes.isError) {
    throw new Error(`upload_file 出错：${uploadRes.text}`);
  }

  let reference: string | undefined;
  if (uploadRes.structured && typeof uploadRes.structured === 'object') {
    const s = uploadRes.structured as { reference?: string };
    if (typeof s.reference === 'string') reference = s.reference;
  }
  if (!reference) {
    const m = /src:[0-9a-f]{64}/.exec(uploadRes.text);
    if (m) reference = m[0];
  }
  if (!reference) {
    throw new Error(`upload_file 未返回引用：${uploadRes.text}`);
  }

  const startResults = await caller([
    {
      tool: 'start_run',
      args: { pack: 'template-gap', inputs: { documents: { reference } } },
    },
  ]);
  const startRes = startResults[0];
  if (startRes.isError) {
    throw new Error(`start_run 出错：${startRes.text}`);
  }

  const runResult = extractGapResult(startRes.structured ?? startRes.text);
  return { reference, runResult, text: startRes.text };
}

/**
 * Checks equality between two string arrays (order-insensitive set comparison).
 */
function setsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const setA = new Set(a);
  return b.every((x) => setA.has(x));
}

/**
 * Evaluates metamorphic checks for one target category:
 * 1a. Replica 1: target category is missing (缺).
 * 1b. Replica 1: all other categories remain unchanged in coverage.
 * 2.  Replica 2: target category is present (有).
 * 3a. Replica 3: item summary equals original.
 * 3b. Replica 3: check report (missing categories / report text) equals original.
 */
export function evaluateReplicaChecks(params: {
  categoryId: string;
  categoryLabel: string;
  origResult: HubGapResult;
  r1Result: HubGapResult;
  r2Result: HubGapResult;
  r3Result: HubGapResult;
  removedCount: number;
  restoredNodeId: string;
}): Check[] {
  const { categoryId, categoryLabel, origResult, r1Result, r2Result, r3Result, removedCount, restoredNodeId } = params;
  const area = '模板查缺蜕变核对';
  const checks: Check[] = [];

  // Check 1a: Replica 1 category is missing
  const r1Cat = r1Result.categories.find((c) => c.id === categoryId);
  const r1MissingList = r1Result.missing ?? [];
  const r1IsMissing =
    (r1Cat !== undefined && (!r1Cat.present || r1Cat.count === 0)) ||
    r1MissingList.includes(categoryId);

  checks.push({
    area,
    name: `类别 ${categoryId}（${categoryLabel}）：副本 1 类别缺失`,
    expected: `类别 ${categoryId}（${categoryLabel}）在副本 1 中缺失（缺）`,
    actual: r1IsMissing
      ? `副本 1 中类别 ${categoryId} 为缺失（缺）`
      : `副本 1 中类别 ${categoryId} 仍为存在（有，用例数 ${r1Cat?.count ?? '未知'}）`,
    ok: r1IsMissing,
    evidence: [`副本 1 删除了 ${removedCount} 个覆盖用例节点`],
  });

  // Check 1b: Replica 1 other categories remain unchanged
  const otherMismatches: string[] = [];
  if (origResult.categories.length > 0 && r1Result.categories.length > 0) {
    for (const origCat of origResult.categories) {
      if (origCat.id === categoryId) continue;
      const r1Other = r1Result.categories.find((c) => c.id === origCat.id);
      if (r1Other && origCat.present !== r1Other.present) {
        otherMismatches.push(
          `${origCat.id}（原件${origCat.present ? '有' : '缺'} vs 副本1${r1Other.present ? '有' : '缺'}）`,
        );
      }
    }
  } else if (origResult.missing && r1Result.missing) {
    const origOtherMissing = new Set(origResult.missing.filter((m) => m !== categoryId));
    const r1OtherMissing = new Set(r1Result.missing.filter((m) => m !== categoryId));
    if (!setsEqual([...origOtherMissing], [...r1OtherMissing])) {
      otherMismatches.push(`缺失列表不一致：原件 [${[...origOtherMissing].join(',')}] vs 副本1 [${[...r1OtherMissing].join(',')}]`);
    }
  }

  const otherOk = otherMismatches.length === 0;
  checks.push({
    area,
    name: `类别 ${categoryId}（${categoryLabel}）：副本 1 其余类别保持不变`,
    expected: `除 ${categoryId} 外其余类别覆盖状态与原件一致`,
    actual: otherOk
      ? `其余所有类别覆盖状态均与原件保持一致`
      : `其余类别存在变化：${otherMismatches.join('；')}`,
    ok: otherOk,
    evidence: [`原件共 ${origResult.categories.length || 'N'} 个类别`],
  });

  // Check 2: Replica 2 category restored to present
  const r2Cat = r2Result.categories.find((c) => c.id === categoryId);
  const r2MissingList = r2Result.missing ?? [];
  const r2IsPresent =
    (r2Cat !== undefined && r2Cat.present && r2Cat.count > 0) ||
    (!r2MissingList.includes(categoryId) && r2MissingList.length < (r1MissingList.length || 1));

  checks.push({
    area,
    name: `类别 ${categoryId}（${categoryLabel}）：副本 2 恢复存在`,
    expected: `类别 ${categoryId}（${categoryLabel}）在副本 2 中存在（有）`,
    actual: r2IsPresent
      ? `副本 2 中类别 ${categoryId} 为存在（有，恢复后用例数 ${r2Cat?.count ?? 1}）`
      : `副本 2 中类别 ${categoryId} 仍为缺失（缺）`,
    ok: r2IsPresent,
    evidence: [`副本 2 加回了用例节点 ${restoredNodeId}`],
  });

  // Check 3a: Replica 3 item summary matches original
  const origSummary = origResult.summary?.trim();
  const r3Summary = r3Result.summary?.trim();
  const summaryMatches = origSummary !== undefined && r3Summary !== undefined && origSummary === r3Summary;

  checks.push({
    area,
    name: `类别 ${categoryId}（${categoryLabel}）：副本 3 条目摘要相同`,
    expected: `摘要与原件一致：${origSummary ?? '（原件无摘要）'}`,
    actual: summaryMatches
      ? `摘要完全一致：${r3Summary}`
      : `摘要不一致：${r3Summary ?? '（副本 3 无摘要）'}`,
    ok: summaryMatches,
    evidence: ['副本 3 将每层兄弟节点倒序后由 Hub 运行产生'],
  });

  // Check 3b: Replica 3 check report (missing categories / report text) matches original
  const origMissing = origResult.missing ?? [];
  const r3Missing = r3Result.missing ?? [];
  const missingMatches = setsEqual(origMissing, r3Missing);
  const textMatches =
    origResult.reportText && r3Result.reportText ? origResult.reportText.trim() === r3Result.reportText.trim() : true;
  const reportMatches = missingMatches && textMatches;

  checks.push({
    area,
    name: `类别 ${categoryId}（${categoryLabel}）：副本 3 查缺报告相同`,
    expected: `报告缺失类别与原件一致：${origMissing.length > 0 ? origMissing.join('、') : '无缺失'}`,
    actual: reportMatches
      ? `查缺报告判定与原件完全相同（缺失：${r3Missing.length > 0 ? r3Missing.join('、') : '无缺失'}）`
      : `查缺报告判定不一致：副本 3 缺失 [${r3Missing.join('、')}] vs 原件 [${origMissing.join('、')}]`,
    ok: reportMatches,
    evidence: ['副本 3 将每层兄弟节点倒序后由 Hub 运行产生'],
  });

  return checks;
}

export interface MetamorphicReport {
  title: string;
  generatedAt: string;
  documentId?: string;
  categoriesTested: string[];
  checks: Check[];
  summary: { total: number; passed: number; failed: number };
  markdown: string;
}

/**
 * Runs metamorphic testing over an original mindmap and original check result:
 * 1. Picks up to maxCategories (default 3) categories with present === true.
 * 2. Generates Replica 3 (reverse siblings of original doc), runs it once.
 * 3. For each category:
 *    - Generates Replica 1 (delete case nodes in evidence) and runs it.
 *    - Generates Replica 2 (restores one case node) and runs it.
 *    - Evaluates the 5 metamorphic checks.
 * 4. Produces the final markdown report.
 */
export async function runMetamorphicCheck(
  doc: KityMinderDoc,
  origResult: HubGapResult,
  caller: ToolCaller,
  options: { maxCategories?: number } = {},
): Promise<MetamorphicReport> {
  const maxCategories = options.maxCategories ?? 3;

  // Filter categories marked as present ("有") with evidence
  const presentCategories = origResult.categories.filter((c) => c.present && c.evidence.length > 0);

  // Prefer categories where count <= evidence.length so deleting evidence removes all cases
  const completeEvidence = presentCategories.filter((c) => c.count <= c.evidence.length);
  const targetPool = completeEvidence.length >= maxCategories ? completeEvidence : presentCategories;
  const selectedCategories = targetPool.slice(0, maxCategories);

  const allChecks: Check[] = [];
  const categoriesTested: string[] = [];

  if (selectedCategories.length === 0) {
    const reportObj: Report = {
      title: '模板查缺真实文档蜕变核对报告',
      generatedAt: new Date().toISOString(),
      checks: [
        {
          area: '模板查缺蜕变核对',
          name: '原件包含至少一个标为“有”的类别',
          expected: '原件查缺结果包含至少一个 present === true 的类别',
          actual: '原件查缺结果中没有标为“有”的类别',
          ok: false,
          note: '无法进行删除用例的蜕变核对',
        },
      ],
      limits: ['原件未覆盖任何模板类别，未执行蜕变测试'],
    };
    return {
      title: reportObj.title,
      generatedAt: reportObj.generatedAt,
      documentId: origResult.documentId,
      categoriesTested: [],
      checks: reportObj.checks,
      summary: summary(reportObj.checks),
      markdown: renderReport(reportObj),
    };
  }

  // 1. Generate, upload and run Replica 3 once
  const replica3Doc = createReplicaWithReversedSiblings(doc);
  const { runResult: r3Result } = await uploadAndRunReplica(replica3Doc, caller);

  // 2. For each category, generate and run Replica 1 and Replica 2
  for (const cat of selectedCategories) {
    categoriesTested.push(cat.id);
    const nodeIds = new Set(cat.evidence.map(cleanNodeId));

    // Replica 1: delete covering cases
    const { replica: replica1Doc, removedNodes } = createReplicaWithoutCategory(doc, nodeIds);
    if (removedNodes.length === 0) {
      allChecks.push({
        area: '模板查缺蜕变核对',
        name: `类别 ${cat.id}（${cat.label}）：原件中找到覆盖用例节点`,
        expected: `原件中找到 evidence 所列节点（${[...nodeIds].join('、')}）`,
        actual: '原件脑图中未找到任何匹配的节点编号',
        ok: false,
        evidence: cat.evidence,
      });
      continue;
    }

    const { runResult: r1Result } = await uploadAndRunReplica(replica1Doc, caller);

    // Replica 2: restore one case node into Replica 1
    const nodeToRestore = removedNodes[0];
    const replica2Doc = createReplicaWithRestoredNode(replica1Doc, nodeToRestore);
    const { runResult: r2Result } = await uploadAndRunReplica(replica2Doc, caller);

    // Evaluate checks for this category
    const checks = evaluateReplicaChecks({
      categoryId: cat.id,
      categoryLabel: cat.label,
      origResult,
      r1Result,
      r2Result,
      r3Result,
      removedCount: removedNodes.length,
      restoredNodeId: nodeToRestore.node.data?.id ?? 'unknown',
    });

    allChecks.push(...checks);
  }

  const reportObj: Report = {
    title: '模板查缺真实文档蜕变核对报告',
    generatedAt: new Date().toISOString(),
    checks: allChecks,
    limits: [
      '蜕变核对使用集成者上传的文件副本，验证 Hub 查缺规则对用例删除、加回和节点换序的敏感性与稳健性',
      '每个类别加回一个用例验证单用例即可覆盖该类别，其余可能关联相同用例的类别可能受到部分影响',
    ],
  };

  const reportSummary = summary(allChecks);
  const markdown = renderReport(reportObj);

  return {
    title: reportObj.title,
    generatedAt: reportObj.generatedAt,
    documentId: origResult.documentId,
    categoriesTested,
    checks: allChecks,
    summary: reportSummary,
    markdown,
  };
}

export async function main(argv: string[]): Promise<number> {
  const value = (name: string): string | undefined => {
    const at = argv.indexOf(`--${name}`);
    return at >= 0 ? argv[at + 1] : undefined;
  };

  const mindmapPath = value('mindmap');
  const resultPath = value('result');
  const tokenFile = value('token-file');
  const tokenEnv = value('token-env');
  const url = value('url') ?? 'http://127.0.0.1:7420/mcp';
  const session = value('session') ?? randomUUID();
  const maxCategoriesArg = value('max-categories');
  const outPath = value('out');
  const outJsonPath = value('out-json');

  if (!mindmapPath || !resultPath) {
    process.stderr.write(
      '用法：node scripts/real/accept/template-gap-metamorphic.ts --mindmap <mindmap.km.json> --result <result.json> [--token-file <file> | --token-env <env>] [--url <url>] [--session <id>] [--max-categories 3] [--out <report.md>]\n',
    );
    return 2;
  }

  const token =
    tokenFile !== undefined
      ? readFileSync(resolve(tokenFile), 'utf8').trim()
      : tokenEnv !== undefined
        ? (process.env[tokenEnv] ?? '')
        : '';

  if (!token) {
    process.stderr.write('错误：需要提供 --token-file 或 --token-env 以通过 Hub MCP 调用 upload_file 和 start_run\n');
    return 2;
  }

  try {
    const mindmapContent = readFileSync(resolve(mindmapPath), 'utf8');
    const mindmapDoc = JSON.parse(mindmapContent) as KityMinderDoc;

    const resultContent = readFileSync(resolve(resultPath), 'utf8');
    const origResult = extractGapResult(resultContent);

    const callOptions: CallOptions = { url, token, session };
    const caller: ToolCaller = (calls) => callTools(callOptions, calls);

    const maxCategories = maxCategoriesArg ? parseInt(maxCategoriesArg, 10) : 3;
    const report = await runMetamorphicCheck(mindmapDoc, origResult, caller, { maxCategories });

    process.stdout.write(`${report.markdown}\n`);

    if (outPath) {
      writeFileSync(resolve(outPath), `${report.markdown}\n`);
    }
    if (outJsonPath) {
      writeFileSync(resolve(outJsonPath), `${JSON.stringify(report, null, 2)}\n`);
    }

    return report.summary.failed === 0 ? 0 : 1;
  } catch (error) {
    process.stderr.write(`蜕变核对执行失败：${(error as Error).message.split('\n')[0]}\n`);
    return 1;
  }
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('template-gap-metamorphic.ts')) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}

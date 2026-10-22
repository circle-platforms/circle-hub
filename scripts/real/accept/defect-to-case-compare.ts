// Compare, for one defect-to-case run, the drafted cases with the regression document that already exists for the
// defect (acceptance gap C, 6b). Three inputs, all exported from the run and the agile platform:
// - --gold: the independent gold of the existing regression document (scripts/real/gold/regression-doc.ts);
// - --drafts: the run's submission (submit_result body; the validation result carries no drafts, so it is a third input);
// - --result: the run's validation result (validation@1 JSON).
// The report holds three things, and nothing is recomputed that the Hub already judged:
// 1. the overlap of command heads: how many of the drafts' heads the existing document uses too, and the reverse
//    (reported, never a pass/fail);
// 2. whether every expected result's quotation was judged verbatim by the Hub — read from the `grounded`
//    requirement's claims in the validation result, never re-judged here;
// 3. the drafts identical to an existing case (command head and every parameter value equal): the set this script
//    computes from gold and submission against the set the Hub's duplicate check flagged
//    (defect-to-case.duplicate_case claims), and whether the two sets are equal.
//   node scripts/real/accept/defect-to-case-compare.ts --gold <gold.json> --drafts <submission.json> --result <validation.json>
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { normalizeHead, normalizeParameters, splitCommand, type RegressionDocGold, type SplitCommand } from '../gold/regression-doc.ts';

export interface DraftCase {
  title: string;
  steps: Array<{ command?: string }>;
  expected: Array<{ text: string }>;
}

export interface HeadOverlap {
  draftHeads: number;
  docHeads: number;
  shared: number;
  /** shared / draftHeads; null when the drafts use no command. */
  draftRatio: number | null;
  /** shared / docHeads; null when the document uses no command. */
  docRatio: number | null;
  missingInDoc: string[];
  missingInDrafts: string[];
  /** Unrecognized command lines from the regression document gold. */
  unrecognizedInDoc?: string[];
}

export interface QuotesReport {
  claims: number;
  support: number;
  problems: string[];
  allVerbatim: boolean;
}

export interface DuplicatesReport {
  goldIdentical: string[];
  hubFlagged: string[];
  equal: boolean;
  onlyGold: string[];
  onlyHub: string[];
}

export interface Comparison {
  headOverlap: HeadOverlap;
  quotes: QuotesReport;
  duplicates: DuplicatesReport;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The drafts of a submission body (submit_result): items[].slots.cases[].data. */
export function draftsOf(submission: unknown): DraftCase[] {
  const items = isRecord(submission) && Array.isArray(submission.items) ? submission.items : [];
  const out: DraftCase[] = [];
  for (const item of items) {
    const cases = isRecord(item) && isRecord(item.slots) && Array.isArray(item.slots.cases) ? item.slots.cases : [];
    for (const entry of cases) {
      const data = isRecord(entry) && isRecord(entry.data) ? entry.data : {};
      out.push({
        title: typeof data.title === 'string' ? data.title : '',
        steps: Array.isArray(data.steps) ? (data.steps as DraftCase['steps']) : [],
        expected: Array.isArray(data.expected) ? (data.expected as DraftCase['expected']) : [],
      });
    }
  }
  return out;
}

/** The (head, parameters) pairs of one case's command lines, in comparison form. */
function commandKeysOf(commands: readonly SplitCommand[]): string[] {
  const keys = new Set<string>();
  for (const command of commands) {
    const key = `${normalizeHead(command.head)}${normalizeParameters(command.parameters).join('')}`;
    if (key !== '') keys.add(key);
  }
  return [...keys].sort();
}

function headSetOf(commands: readonly SplitCommand[]): Set<string> {
  return new Set(commands.map((c) => normalizeHead(c.head)).filter((h) => h !== ''));
}

const docCasesOf = (gold: unknown): Array<{ commands: SplitCommand[] }> => {
  if (isRecord(gold) && Array.isArray(gold.cases)) return gold.cases as Array<{ commands: SplitCommand[] }>;
  if (isRecord(gold) && Array.isArray(gold.documents)) return (gold.documents as RegressionDocGold[]).flatMap((d) => d.cases);
  return [];
};

function overlapOf(drafts: readonly DraftCase[], gold: unknown): HeadOverlap {
  const docCommands = docCasesOf(gold).flatMap((c) => c.commands);
  const draftCommands = drafts.flatMap((d) => d.steps.flatMap((s) => (typeof s.command === 'string' ? splitCommand(s.command) : [])));
  const draftHeads = headSetOf(draftCommands);
  const docHeads = headSetOf(docCommands);
  const shared = [...draftHeads].filter((h) => docHeads.has(h));
  const unrec = isRecord(gold) && Array.isArray(gold.unrecognizedCommands)
    ? (gold.unrecognizedCommands as string[])
    : isRecord(gold) && Array.isArray(gold.documents)
      ? (gold.documents as RegressionDocGold[]).flatMap((d) => d.unrecognizedCommands ?? [])
      : [];
  const unrecognizedInDoc = [...new Set(unrec)].sort();
  return {
    draftHeads: draftHeads.size,
    docHeads: docHeads.size,
    shared: shared.length,
    draftRatio: draftHeads.size === 0 ? null : shared.length / draftHeads.size,
    docRatio: docHeads.size === 0 ? null : shared.length / docHeads.size,
    missingInDoc: [...draftHeads].filter((h) => !docHeads.has(h)).sort(),
    missingInDrafts: [...docHeads].filter((h) => !draftHeads.has(h)).sort(),
    ...(unrecognizedInDoc.length > 0 ? { unrecognizedInDoc } : {}),
  };
}

interface Claim {
  requirement?: string;
  statement?: { text?: string; code?: string; verdict?: string };
}

/** Every claim of a validation result (partitions' requirements plus the cross-item ones); a claim that does not
 * repeat its requirement inherits the bucket's key. */
function claimsOf(result: unknown): Claim[] {
  const partitions = isRecord(result) && isRecord(result.partitions) ? Object.values(result.partitions) : [];
  const claims: Claim[] = [];
  for (const partition of partitions) {
    if (!Array.isArray(partition)) continue;
    for (const bucket of partition) {
      const requirements = isRecord(bucket) && Array.isArray(bucket.requirements) ? bucket.requirements : [];
      for (const requirement of requirements) {
        if (!isRecord(requirement) || !Array.isArray(requirement.claims)) continue;
        const key = typeof requirement.requirement === 'string' ? requirement.requirement : undefined;
        for (const claim of requirement.claims as Claim[]) claims.push({ ...claim, requirement: claim.requirement ?? key });
      }
    }
  }
  const cross = isRecord(result) && Array.isArray(result.cross_item) ? (result.cross_item as Claim[]) : [];
  return [...claims, ...cross];
}

function quotesReportOf(result: unknown): QuotesReport {
  const claims = claimsOf(result).filter((c) => c.requirement === 'grounded');
  const support = claims.filter((c) => c.statement?.verdict === 'support').length;
  const problems = claims.filter((c) => c.statement?.verdict !== 'support').map((c) => `${c.statement?.verdict ?? '?'}：${c.statement?.text ?? ''}`);
  return { claims: claims.length, support, problems, allVerbatim: claims.length > 0 && support === claims.length };
}

const HUB_DUPLICATE = /起草用例“([^”]+)”与已索引用例重复/;

function duplicatesReportOf(drafts: readonly DraftCase[], gold: unknown, result: unknown): DuplicatesReport {
  const docKeys = new Set(docCasesOf(gold).flatMap((c) => commandKeysOf(c.commands)));
  const goldIdentical = drafts
    .filter((draft) => {
      const keys = commandKeysOf(draft.steps.flatMap((s) => (typeof s.command === 'string' ? splitCommand(s.command) : [])));
      return keys.length > 0 && keys.every((key) => docKeys.has(key));
    })
    .map((draft) => draft.title);
  const hubFlagged = claimsOf(result)
    .filter((c) => c.statement?.code === 'defect-to-case.duplicate_case' && c.statement.verdict === 'refute')
    .map((c) => HUB_DUPLICATE.exec(c.statement?.text ?? '')?.[1])
    .filter((title): title is string => typeof title === 'string');
  const onlyGold = goldIdentical.filter((title) => !hubFlagged.includes(title)).sort();
  const onlyHub = hubFlagged.filter((title) => !goldIdentical.includes(title)).sort();
  return { goldIdentical: [...goldIdentical].sort(), hubFlagged: [...hubFlagged].sort(), equal: onlyGold.length === 0 && onlyHub.length === 0, onlyGold, onlyHub };
}

export function computeComparison(gold: unknown, submission: unknown, result: unknown): Comparison {
  const drafts = draftsOf(submission);
  return {
    headOverlap: overlapOf(drafts, gold),
    quotes: quotesReportOf(result),
    duplicates: duplicatesReportOf(drafts, gold, result),
  };
}

const percent = (ratio: number | null): string => (ratio === null ? '无（集合为空）' : `${(ratio * 100).toFixed(1)}%`);

export function renderComparison(comparison: Comparison): string {
  const { headOverlap: h, quotes: q, duplicates: d } = comparison;
  const lines: string[] = ['缺陷转用例与已有回归文档的比对', ''];
  lines.push(`1. 命令头重叠（只报告，不判通过）：草稿用到 ${h.draftHeads} 个命令头，已有文档用到 ${h.docHeads} 个，共同 ${h.shared} 个`);
  lines.push(`   草稿的命令头里已有文档也用到的比例：${percent(h.draftRatio)}；已有文档的命令头里草稿也用到的比例：${percent(h.docRatio)}`);
  if (h.missingInDoc.length > 0) lines.push(`   草稿有、已有文档没有：${h.missingInDoc.join('、')}`);
  if (h.missingInDrafts.length > 0) lines.push(`   已有文档有、草稿没有：${h.missingInDrafts.join('、')}`);
  if (h.unrecognizedInDoc && h.unrecognizedInDoc.length > 0) {
    lines.push(`   已有文档未识别的命令行：${h.unrecognizedInDoc.join('、')}`);
  }
  lines.push('');
  lines.push(`2. 期望结果的引文（读 Hub 的判定，不重做）：grounded 主张 ${q.claims} 条，支持 ${q.support} 条`);
  lines.push(q.allVerbatim ? '   每条期望结果的引用都已被 Hub 判为逐字' : '   不是每条引用都被判为逐字：');
  for (const problem of q.problems) lines.push(`   - ${problem}`);
  lines.push('');
  lines.push('3. 与已有用例完全相同（命令头和参数值都相同）的草稿：');
  lines.push(`   gold 算出的集合（${d.goldIdentical.length}）：${d.goldIdentical.length > 0 ? d.goldIdentical.join('、') : '（空）'}`);
  lines.push(`   Hub 查重标出的集合（${d.hubFlagged.length}）：${d.hubFlagged.length > 0 ? d.hubFlagged.join('、') : '（空）'}`);
  lines.push(`   两个集合${d.equal ? '相等' : '不相等'}`);
  for (const title of d.onlyGold) lines.push(`   - 只在 gold 的集合里：${title}`);
  for (const title of d.onlyHub) lines.push(`   - 只在 Hub 标出的集合里：${title}`);
  return lines.join('\n');
}

export function main(argv: string[]): number {
  const value = (name: string): string | undefined => {
    const at = argv.indexOf(`--${name}`);
    return at >= 0 ? argv[at + 1] : undefined;
  };
  const [goldPath, draftsPath, resultPath] = [value('gold'), value('drafts'), value('result')];
  if (goldPath === undefined || draftsPath === undefined || resultPath === undefined) {
    process.stderr.write('用法：node scripts/real/accept/defect-to-case-compare.ts --gold <gold.json> --drafts <submission.json> --result <validation.json>\n');
    return 2;
  }
  try {
    const gold = JSON.parse(readFileSync(resolve(goldPath), 'utf8')) as unknown;
    const submission = JSON.parse(readFileSync(resolve(draftsPath), 'utf8')) as unknown;
    const result = JSON.parse(readFileSync(resolve(resultPath), 'utf8')) as unknown;
    process.stdout.write(`${renderComparison(computeComparison(gold, submission, result))}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`读不了输入：${(error as Error).message.split('\n')[0]}\n`);
    return 1;
  }
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('accept/defect-to-case-compare.ts')) {
  process.exitCode = main(process.argv.slice(2));
}

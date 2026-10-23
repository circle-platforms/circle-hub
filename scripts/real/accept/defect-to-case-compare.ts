// Compare, for one defect-to-case run, the drafted cases with the regression document that already exists for the
// defect (acceptance gap C, 6b). Three inputs, all exported from the run and the agile platform:
// - --gold: the independent gold of the existing regression document (scripts/real/gold/regression-doc.ts);
// - --drafts: the run's submission (submit_result body; the validation result carries no drafts, so it is a third input);
// - --result: the run's validation result (validation@1 JSON).
// Command domains and source quotations are rejudged independently before comparison with Hub requirement statuses.
// A document overlap is descriptive only; full-index duplicate recounting is a separate oracle.
// Optional inputs: --commands, --run, --sources, --manual, --fix-field and --details (outside Git).
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync, realpathSync, lstatSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import {
  buildCatalog,
  normalizeHead,
  normalizeParameters,
  parseCommandsFromText,
  splitCommand,
  type RegressionDocGold,
  type SplitCommand,
} from '../gold/regression-doc.ts';

import { VERDICT } from '../../../contracts/generated/vocabulary.ts';
const [SUPPORT, REFUTE, UNKNOWN] = VERDICT;
import { quotesReport, type QuoteInputs } from '../gold/quotes.ts';
import { domainReport, decodeCommandXml } from '../gold/command-domains.ts';

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
  /** Command lines in drafts not found in the catalog. */
  unrecognizedInDrafts?: string[];
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
  quoteOracle: ReturnType<typeof quotesReport>;
  parameters?: { same: number; different: number; absent: number; draftPairs: number; docPairs: number; shared: number; docRatio: number | null; domains: ReturnType<typeof domainReport> };
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

/** The parsed commands and unrecognized lines of draft steps. */
export function parseDraftSteps(
  steps: ReadonlyArray<{ command?: string }>,
  catalog?: Set<string>,
): { commands: SplitCommand[]; unrecognized: string[] } {
  const commands: SplitCommand[] = [];
  const unrecognized: string[] = [];
  for (const step of steps) {
    if (typeof step.command !== 'string') continue;
    for (const rawLine of step.command.split('\n')) {
      const line = rawLine.trim();
      if (line === '') continue;
      const res = parseCommandsFromText(line, catalog);
      commands.push(...res.commands);
      unrecognized.push(...res.unrecognized);
    }
  }
  return { commands, unrecognized };
}

function overlapOf(drafts: readonly DraftCase[], gold: unknown, catalog?: Set<string>): HeadOverlap {
  const docCommands = docCasesOf(gold).flatMap((c) => c.commands);
  const parsedDrafts = drafts.map((d) => parseDraftSteps(d.steps, catalog));
  const draftCommands = parsedDrafts.flatMap((p) => p.commands);
  const draftHeads = headSetOf(draftCommands);
  const docHeads = headSetOf(docCommands);
  const shared = [...draftHeads].filter((h) => docHeads.has(h));
  const unrecDoc = isRecord(gold) && Array.isArray(gold.unrecognizedCommands)
    ? (gold.unrecognizedCommands as string[])
    : isRecord(gold) && Array.isArray(gold.documents)
      ? (gold.documents as RegressionDocGold[]).flatMap((d) => d.unrecognizedCommands ?? [])
      : [];
  const unrecognizedInDoc = [...new Set(unrecDoc)].sort();
  const unrecDrafts = [...new Set(parsedDrafts.flatMap((p) => p.unrecognized))].sort();
  return {
    draftHeads: draftHeads.size,
    docHeads: docHeads.size,
    shared: shared.length,
    draftRatio: draftHeads.size === 0 ? null : shared.length / draftHeads.size,
    docRatio: docHeads.size === 0 ? null : shared.length / docHeads.size,
    missingInDoc: [...draftHeads].filter((h) => !docHeads.has(h)).sort(),
    missingInDrafts: [...docHeads].filter((h) => !draftHeads.has(h)).sort(),
    ...(unrecognizedInDoc.length > 0 ? { unrecognizedInDoc } : {}),
    ...(unrecDrafts.length > 0 ? { unrecognizedInDrafts: unrecDrafts } : {}),
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
  const support = claims.filter((c) => c.statement?.verdict === SUPPORT).length;
  const problems = claims.filter((c) => c.statement?.verdict !== SUPPORT).map((c) => `${c.statement?.verdict ?? '?'}：${c.statement?.text ?? ''}`);
  return { claims: claims.length, support, problems, allVerbatim: claims.length > 0 && support === claims.length };
}

const HUB_DUPLICATE = /起草用例“([^”]+)”与已索引用例重复/;

function duplicatesReportOf(
  drafts: readonly DraftCase[],
  gold: unknown,
  result: unknown,
  catalog?: Set<string>,
): DuplicatesReport {
  const docKeys = new Set(docCasesOf(gold).flatMap((c) => commandKeysOf(c.commands)));
  const goldIdentical = drafts
    .filter((draft) => {
      const { commands, unrecognized } = parseDraftSteps(draft.steps, catalog);
      if (unrecognized.length > 0) return false;
      const keys = commandKeysOf(commands);
      return keys.length > 0 && keys.every((key) => docKeys.has(key));
    })
    .map((draft) => draft.title);
  const hubFlagged = claimsOf(result)
    .filter((c) => c.statement?.code === 'defect-to-case.duplicate_case' && c.statement.verdict === REFUTE)
    .map((c) => HUB_DUPLICATE.exec(c.statement?.text ?? '')?.[1])
    .filter((title): title is string => typeof title === 'string');
  const onlyGold = goldIdentical.filter((title) => !hubFlagged.includes(title)).sort();
  const onlyHub = hubFlagged.filter((title) => !goldIdentical.includes(title)).sort();
  return { goldIdentical: [...goldIdentical].sort(), hubFlagged: [...hubFlagged].sort(), equal: onlyGold.length === 0 && onlyHub.length === 0, onlyGold, onlyHub };
}

export interface CompareOptions extends QuoteInputs {
  commandTreeXml?: string;
  catalog?: Set<string>;
}

function parametersReport(drafts: DraftCase[], gold: unknown, submission: unknown, hub: unknown, xml: string) {
  const catalog = buildCatalog(xml);
  const doc = docCasesOf(gold).flatMap(c => c.commands);
  const draft = drafts.flatMap(d => parseDraftSteps(d.steps, catalog).commands);
  const pair = (c: SplitCommand) => JSON.stringify([normalizeHead(c.head), c.parameters]);
  const docPairs = new Set(doc.map(pair)), draftPairs = new Set(draft.map(pair));
  const heads = new Set(doc.map(c => normalizeHead(c.head)));
  const same = draft.filter(c => docPairs.has(pair(c))).length;
  const different = draft.filter(c => !docPairs.has(pair(c)) && heads.has(normalizeHead(c.head))).length;
  const absent = draft.filter(c => !heads.has(normalizeHead(c.head))).length;
  const shared = [...docPairs].filter(p => draftPairs.has(p)).length;
  return { same, different, absent, draftPairs: draftPairs.size, docPairs: docPairs.size, shared, docRatio: docPairs.size ? shared / docPairs.size : null, domains: domainReport(submission, hub, xml) };
}

export function computeComparison(
  gold: unknown,
  submission: unknown,
  result: unknown,
  options: CompareOptions = {},
): Comparison {
  const catalog = options.catalog ?? (options.commandTreeXml ? buildCatalog(options.commandTreeXml) : undefined);
  const drafts = draftsOf(submission);
  return {
    headOverlap: overlapOf(drafts, gold, catalog),
    ...(options.commandTreeXml ? { parameters: parametersReport(drafts, gold, submission, result, options.commandTreeXml) } : {}),
    quotes: quotesReportOf(result),
    quoteOracle: quotesReport(submission, result, options),
    duplicates: duplicatesReportOf(drafts, gold, result, catalog),
  };
}

const percent = (ratio: number | null): string => (ratio === null ? '无（集合为空）' : `${(ratio * 100).toFixed(1)}%`);

export function renderComparison(comparison: Comparison): string {
  const { headOverlap: h, quotes: q, duplicates: d } = comparison;
  const lines: string[] = ['缺陷转用例与已有回归文档的比对', ''];
  lines.push(`1. 命令头重叠（只报告，不判通过）：草稿用到 ${h.draftHeads} 个命令头，已有文档用到 ${h.docHeads} 个，共同 ${h.shared} 个`);
  lines.push(`   草稿的命令头里已有文档也用到的比例：${percent(h.draftRatio)}；已有文档的命令头里草稿也用到的比例：${percent(h.docRatio)}`);
  lines.push(`   草稿独有 ${h.missingInDoc.length}；文档独有 ${h.missingInDrafts.length}；未识别文档行 ${h.unrecognizedInDoc?.length ?? 0}；未识别草稿行 ${h.unrecognizedInDrafts?.length ?? 0}`);
  lines.push('');
  lines.push(`2. Hub 引文主张（仅作对照）：grounded 主张 ${q.claims} 条，支持 ${q.support} 条`);
  lines.push('   独立重判不采信这些主张作为答案');
  lines.push(`   引文问题 ${q.problems.length} 条`);
  lines.push('');
  lines.push('3. 与已有用例完全相同（命令头和参数值都相同）的草稿：');
  lines.push(`   gold 集合 ${d.goldIdentical.length}；Hub 集合 ${d.hubFlagged.length}；仅 gold ${d.onlyGold.length}；仅 Hub ${d.onlyHub.length}`);
  lines.push(`   回归文档命令组合对照${d.equal ? '相同' : '不同'}（仅报告，不是全量查重结论）`);
  const p = comparison.parameters;
  lines.push(p ? `参数组合（只报告）：相同 ${p.same}；同头异参 ${p.different}；文档无命令头 ${p.absent}；文档组合覆盖 ${percent(p.docRatio)}` : '参数：设计缺口；缺构建命令树原件，需集成者 Claude 导出');
  if (p) {
    const items = p.domains.items;
    lines.push(`取值域：支持 ${p.domains.counts.support}；反驳 ${p.domains.counts.refute}；其中目录外 ${p.domains.notMember}；暂态待补证 ${p.domains.counts.unknown}`);
    lines.push(`已知差异分组：逐步判 ${p.domains.items.filter(i => i.differenceCategories.includes('negative_step_rule')).length}；简化匹配 ${p.domains.items.filter(i => i.differenceCategories.includes('simplified_refutation_match')).length}（诊断对照，默认仍不通过）`);
    lines.push(`命令与参数：${items.length > 0 && items.every(i => i.comparison === 'equal' && !i.hasUnknown) ? '通过' : '不通过'}；一致 ${items.filter(i => i.comparison === 'equal').length}；不一致 ${items.filter(i => i.comparison === 'different').length}；待补证条目 ${items.filter(i => i.comparison === 'unknown' || i.hasUnknown).length}`);
  }
  const independent = comparison.quoteOracle;
  lines.push(`引文重判：支持 ${independent.counts.support}；反驳 ${independent.counts.refute}；暂态待补证 ${independent.counts.unknown}；仅必要条件 ${independent.necessaryOnly}`);
  for (const category of ['fix','defect_other','manual','other','unknown_defect_field']) {
    const row = independent.targets[category];
    lines.push(`引文来源类别 ${category}：支持 ${row.support}；反驳 ${row.refute}；暂态待补证 ${row.unknown}`);
  }
  lines.push(`期望文字逐字 ${independent.expectedVerbatim}；改写 ${independent.paraphrased}（只报告）`);
  lines.push(`引文：${independent.details.length > 0 && independent.counts.refute === 0 && independent.counts.unknown === 0 && independent.items.every(i => i.comparison === 'equal') ? '通过' : '不通过'}`);
  lines.push(`引文来源：${independent.details.length > 0 && independent.details.every(d => d.category === 'fix' || d.category === 'manual') ? '通过' : '不通过'}`);
  const questions = evidenceQuestions(comparison);
  if (questions.length) lines.push(`设计缺口 ${questions.length} 项；补证动作：请求集成者 Claude 按位置补齐事实后重算；不作为已完成的未知`);
  return lines.join('\n');
}

/** Refuse repository destinations, including symlinked paths and other worktrees. */
export function outsideGit(path: string): string {
  const full = resolve(path);
  let ancestor = full;
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  if (existsSync(full) && lstatSync(full).isSymbolicLink()) throw new Error('unsafe destination');
  const actual = realpathSync(ancestor);
  const folder = lstatSync(actual).isDirectory() ? actual : dirname(actual);
  if (spawnSync('git', ['-C', folder, 'rev-parse', '--is-inside-work-tree', '--is-inside-git-dir'], { encoding: 'utf8' }).stdout.split(/\s+/).includes('true')) throw new Error('repository destination');
  return full;
}

export function writePrivateJson(path: string, value: unknown): void {
  const full = outsideGit(path);
  mkdirSync(dirname(full), { recursive: true, mode: 0o700 });
  writeFileSync(full, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
}

export interface EvidenceQuestion { draft?: number; command?: number; expected?: number; item_position?: number; category: string; missing_fact: string; next_action: string; owner: string }
/** An unresolved observation is a transition: each one names a fact and an executable follow-up, never a terminal verdict. */
export function evidenceQuestions(comparison: Comparison): EvidenceQuestion[] {
  const questions: EvidenceQuestion[] = [];
  if (!comparison.parameters) questions.push({ category: 'design_gap', missing_fact: 'build_command_tree_original', next_action: 'request_command_tree_export', owner: 'Claude' });
  for (const d of comparison.parameters?.domains.details ?? []) for (const [command, outcome] of d.outcomes.entries()) if (outcome.verdict === UNKNOWN) questions.push({ draft: d.draft, command: command + 1, category: 'design_gap', missing_fact: outcome.gap?.fact ?? 'command_domain_rule', next_action: outcome.gap?.action ?? 'request_rule_from_named_integrator', owner: 'Claude' });
  for (const d of comparison.parameters?.domains.details ?? []) if (d.verdict === UNKNOWN && d.outcomes.every(o => o.verdict !== UNKNOWN)) questions.push({ draft: d.draft, category: 'design_gap', missing_fact: d.outcomes.length === 0 ? 'draft_commands' : 'negative_and_refutation_intent', next_action: 'clarify_intent_or_complete_draft_in_repair_round', owner: 'Claude' });
  for (const d of comparison.quoteOracle.details) if (d.verdict === UNKNOWN || d.category === 'unknown_defect_field') questions.push({ draft: d.draft, expected: d.expected, category: 'design_gap', missing_fact: d.category === 'unknown_defect_field' ? 'fix_field_binding' : d.gap?.fact ?? 'reference_fragment', next_action: d.category === 'unknown_defect_field' ? 'request_fix_field_name' : d.gap?.action ?? 'request_source_export', owner: 'Claude' });
  for (const [item_position, item] of (comparison.parameters?.domains.items ?? []).entries()) if (item.comparison === 'unknown' && !item.hasUnknown) questions.push({ item_position: item_position + 1, category: 'design_gap', missing_fact: 'current_commands_requirement_result', next_action: 'replay_submission_and_read_current_result', owner: 'Claude' });
  for (const [item_position, item] of comparison.quoteOracle.items.entries()) if (item.comparison === 'unknown' && comparison.quoteOracle.counts.unknown === 0) questions.push({ item_position: item_position + 1, category: 'design_gap', missing_fact: 'current_grounded_requirement_result', next_action: 'replay_submission_and_read_current_result', owner: 'Claude' });
  return questions;
}

/** Details contain positions and explanatory categories only, never input strings. */
export function comparisonDetails(comparison: Comparison): unknown[] {
  return [
    ...(comparison.parameters?.domains.differences ?? []),
    ...(comparison.parameters?.domains.details.flatMap(d => d.outcomes.map((o, command) => ({ draft: d.draft, command: command + 1, category: o.category }))) ?? []),
    ...comparison.quoteOracle.details.map(d => ({ draft: d.draft, expected: d.expected, category: [d.category, d.verdict, d.reason ?? '', d.scope, d.expectedVerbatim === false ? 'paraphrased' : ''].filter(Boolean).join('.') })),

  ];
}

export function main(argv: string[]): number {
  const value = (name: string): string | undefined => {
    const at = argv.indexOf(`--${name}`);
    return at >= 0 ? argv[at + 1] : undefined;
  };
  const [goldPath, draftsPath, resultPath] = [value('gold'), value('drafts'), value('result')];
  if (goldPath === undefined || draftsPath === undefined || resultPath === undefined) {
    process.stderr.write('用法：node scripts/real/accept/defect-to-case-compare.ts --gold <gold.json> --drafts <submission.json> --result <validation.json> [--commands <xmlFile>]\n');
    return 2;
  }
  const commandsPath = value('commands') ?? value('catalog') ?? value('command-tree');
  let commandTreeXml: string | undefined;
  if (commandsPath) {
    try {
      commandTreeXml = decodeCommandXml(readFileSync(resolve(commandsPath)));
    } catch (error) {
      process.stderr.write('输入读取：不通过\n');
      return 1;
    }
  }
  try {
    const gold = JSON.parse(readFileSync(resolve(goldPath), 'utf8')) as unknown;
    const submission = JSON.parse(readFileSync(resolve(draftsPath), 'utf8')) as unknown;
    const result = JSON.parse(readFileSync(resolve(resultPath), 'utf8')) as unknown;
    const sources = new Map<string, Uint8Array>();
    if (value('sources')) for (const name of readdirSync(value('sources')!)) if (/^[a-f0-9]{64}$/.test(name)) sources.set(name, readFileSync(join(value('sources')!, name)));
    const run = value('run') ? JSON.parse(readFileSync(value('run')!, 'utf8')) : undefined;
    const manual = value('manual') ? [readFileSync(value('manual')!)] : undefined;
    const comparison = computeComparison(gold, submission, result, { commandTreeXml, sources, run, manual, fixField: value('fix-field') });
    if (value('details')) writePrivateJson(value('details')!, { positions: comparisonDetails(comparison), requests: evidenceQuestions(comparison).map(q => ({ ...q, action_status: 'requested' })) });
    process.stdout.write(`${renderComparison(comparison)}\n`);
    return evidenceQuestions(comparison).length > 0 ? 1 : 0;
  } catch (error) {
    process.stderr.write('输入或明细写入：不通过\n');
    return 1;
  }
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('accept/defect-to-case-compare.ts')) {
  process.exitCode = main(process.argv.slice(2));
}

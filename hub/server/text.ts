
// Reader-facing text; the original tool data stays in structuredContent.
// Reader-facing text; the original tool data stays in structuredContent.
import { createHash } from 'node:crypto';
import type { DispatchNote } from '../dispatch/api.ts';
import { viewIdExample } from '../knowledge/api.ts';
import { z } from 'zod';
import { CHECK_TIER, DYNAMIC_TERMINAL, LAYER, PARTITION, REQUIREMENT_STATUS, STATIC_TERMINAL, UNSATISFIED_REASON, axisLabel, labelOf, isReason, isKnowledgeEntryStatus, type KnowledgeEntryStatus, type Layer, type Partition, type Reason, type SourceRole } from '../../contracts/generated/vocabulary.ts';
import type { Claim } from '../../contracts/src/claim.ts';
import type { ProtocolError } from '../../contracts/src/common.ts';
import { ItemProjection, type PackSummary, type RequirementSummary, type RunSummary, type SlotSchema } from '../../contracts/src/run.ts';
import { Submission } from '../../contracts/src/submission.ts';
import { StartRunInput, type GetNodesOutput, type ListTaskPacksOutput, type ResolveReferenceOutput, type StartRunOutput, type SubmitResultOutput, type UploadFileOutput } from '../../contracts/src/tools.ts';
import { PartitionCounts, StoredValidationResult, StoredPartitionItem, Partitions, ValidationResult, partitionCountsOf, isUnknownTerminal, type ItemResult, type RequirementResult } from '../../contracts/src/validation.ts';
import { oneLine, type Entry, type Omission } from './budget.ts';
import { MODEL_LABELS, NOT_APPLICABLE, coverageText, terminalLabel, terminalSymbol, userClaimText, userVerdict, userReason, userNextStep, USER_DECIDER, type Labels, type LayerTerminal } from './claims.ts';
import { callErrorFact, callErrorNext } from './call-error-category.ts';
import { SOURCE_UNKNOWN_CODES, callErrorCategoryOf, errorPresentationOf } from './error-reasons.ts';
import { fixByRole, proseByRole, type CallerRole } from './fix-by-role.ts';
import { ENVIRONMENT_ASSIGNMENT_PREVIEW, packListHead } from './pack-words.ts';
import { isEscalatedError } from './refusal-escalate.ts';
import { toolLocalMinute } from '../telemetry/api.ts';

type ListOut = z.infer<typeof ListTaskPacksOutput>;
type UploadOut = z.infer<typeof UploadFileOutput>;
type StartOut = z.infer<typeof StartRunOutput>;
type NodesOut = z.infer<typeof GetNodesOutput>;
type Content = NonNullable<NodesOut['content']>;
type KnowledgeNode = NonNullable<NodesOut['nodes']>[number];
type ResolveOut = z.infer<typeof ResolveReferenceOutput>;
type SubmitOut = z.infer<typeof SubmitResultOutput>;

/** Frozen source details available to the display layer. */
export interface TextContext {
  /** list_task_packs: the exact filters and absolute offset needed to continue the same list. */
  packList?: { offset: number; kind?: string; packId?: string; contextUnread?: boolean };
  /** The server takes get_nodes {reference, cursor} and passes the cursor back here: only then are page cursors offered. */
  paging?: boolean;
  /** get_nodes with a reference: the page cursor the caller gave (made by pageCursor for an earlier page). */
  cursor?: string | null;
  /** start_run: the validation result that answer.result names (a production run), so that its problems can be listed. */
  production?: ValidationResult | null;
  items?: readonly ItemProjection[];
  /** start_run: rec:<digest> of the run record; submit_result: rec:<digest> of the stored validation result, accepted or not. */
  record?: string | null;
  /** start_run: the expected sources the run could not bind (evidence gaps). */
  unavailable?: readonly { external: string; role: SourceRole }[];
  /** start_run: what the pack's expected-sources function reported, its failure included (further evidence gaps). */
  gaps?: readonly { code: string; message: string }[];
  /** Caller role and account name for D3 next-step wording; omit or non-admin → member projection. */
  caller?: { role: CallerRole; name?: string };
}

function callerRole(context: TextContext): CallerRole {
  return context.caller?.role === 'admin' ? 'admin' : 'user';
}

function callerName(context: TextContext): string | undefined {
  const name = context.caller?.name;
  return typeof name === 'string' && name.length > 0 ? name : undefined;
}
/** The longest a field is shown inside a line; a longer one keeps its start and is marked (Clip). */
const CLIP = { name: 300, code: 200, label: 300, summary: 300, problemLabel: 80, problemMessage: 200, field: 1500, message: 1000, fix: 500, path: 1000, data: 4000, line: 3000 } as const;

/** The example reference of an upload in example calls: valid syntax, plainly not a real digest. */
const EXAMPLE_SOURCE = `src:${'0'.repeat(64)}`;
const MODEL_PLACEHOLDER = '<模型名与配置>';
/** An input slot that takes an external object type, written system:type (the rule of hub/server/tools.ts isExternalType). */
const EXTERNAL_TYPE = /^[a-z][a-z0-9-]*:[a-z][a-z0-9_-]*$/;
const required = (yes: boolean): string => (yes ? '必填' : '可选');
/** How to read a field shortened with a 全文 marker. */
const WHOLE_MORE = '读全文：用 get_nodes 读各处“全文”后面的引用';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
const recordsOf = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});

/**
 * Shortens fields on one line and remembers what it left out, for the entry being built: a field longer than its limit
 * keeps its start (cut at a character boundary) and is marked …（共 N 个字符，全文 <reference>）.
 */
class Clip {
  readonly omitted: Omission[] = [];
  readonly #whole: string | null;
  readonly #more: string | null;

  constructor(whole: string | null = null, more: string | null = null) {
    this.#whole = whole;
    this.#more = more ?? (whole !== null ? WHOLE_MORE : null);
  }

  field(text: string, max: number, what: string, more: string | null = this.#more): string {
    const line = oneLine(text);
    if (line.length <= max) return line;
    let end = max;
    const code = line.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end--;
    this.omitted.push({ what, more });
    return `${line.slice(0, end)}…（共 ${line.length} 个字符${this.#whole !== null ? `，全文 ${this.#whole}` : ''}）`;
  }

  entry(lines: string | readonly string[]): Entry {
    if (this.omitted.length === 0) return lines;
    return { lines: typeof lines === 'string' ? [lines] : lines, omitted: [...this.omitted] };
  }
}

/**
 * The claim fields of an error after its statement (B01, D05 R[8]): qualifier, grounds, rule, the missing fact and the
 * candidate causes, the residual 其他 always last; open hypotheses are not told apart (V08 R[2]). `field` clips a value.
 */
function errorClaimParts(e: ProtocolError, field: (text: string, what: string) => string): string[] {
  const parts: string[] = [];
  const qualifier = [
    e.provenance !== undefined ? labelOf('provenance_type', e.provenance) : null,
    e.collected_at !== undefined ? `采集于 ${e.collected_at}` : null,
    e.coverage !== undefined ? `查找范围${coverageText(e.coverage)}` : null,
  ].filter((part): part is string => part !== null);
  if (qualifier.length > 0) parts.push(`限定：${qualifier.join('，')}`);
  if (e.grounds !== undefined && e.grounds.length > 0) parts.push(`根据：${e.grounds.map((g) => field(g, '根据的超出部分')).join('、')}`);
  if (e.warrant !== undefined) parts.push(`规则：${field(e.warrant, '规则的超出部分')}`);
  if (e.missing !== undefined) parts.push(`缺失事实：${field(e.missing, '缺失事实的超出部分')}`);
  if (e.hypotheses !== undefined && e.hypotheses.length > 0) {
    const open = e.hypotheses.filter((h) => h.status === 'open').length + 1;
    const listed = e.hypotheses.map((h, i) => {
      const about = [
        labelOf('hypothesis_status', h.status),
        h.prediction !== undefined ? `规则的预测：${field(h.prediction, '预测的超出部分')}` : null,
        h.support !== undefined && h.support.length > 0 ? `支持：${h.support.map((s) => field(s, '支持的超出部分')).join('、')}` : null,
        h.refute !== undefined && h.refute.length > 0 ? `反驳：${h.refute.map((s) => field(s, '反驳的超出部分')).join('、')}` : null,
      ].filter((part): part is string => part !== null);
      return `${i + 1}. ${field(h.statement, '假设的超出部分')}（${about.join('；')}）`;
    });
    listed.push(`${e.hypotheses.length + 1}. 其他（${labelOf('hypothesis_status', 'open')}：以上都不是）`);
    parts.push(`原因未定，假设${open > 1 ? `（${open} 个开放，未区分）` : ''}：${listed.join('；')}`);
  }
  return parts;
}

/** The options of an error with their coverage: how many there are, how many are listed and where the rest are (A05 R[1]). */
function optionsPart(e: ProtocolError, option: (text: string) => string): string | null {
  if (e.options === undefined || e.options.length === 0) return null;
  const coverage = e.options_coverage;
  const head = coverage === undefined ? '可选' : `可选（${coverage.complete ? `共 ${coverage.examined} 个，全部列出` : `列出 ${coverage.examined} 个${coverage.total !== undefined ? `，共 ${coverage.total} 个` : '，总数未知'}`}${coverage.note ? `；${coverage.note}` : ''}）`;
  return `${head}：${e.options.map(option).join('、')}`;
}

export function errorLine(e: ProtocolError): string {
  const parts = [`- ${e.code}：${oneLine(e.message)}`, ...errorClaimParts(e, (text) => oneLine(text))];
  if (e.fix) parts.push(`修正：${oneLine(e.fix)}`);
  if (e.path !== undefined) parts.push(`位置 ${e.path === '' ? '（整份）' : oneLine(e.path)}`);
  if (e.item !== undefined) parts.push(`条目 ${oneLine(e.item)}`);
  if (e.requirement !== undefined) parts.push(`要求项 ${oneLine(e.requirement)}`);
  if (e.rounds_left !== undefined) parts.push(`剩余修复轮数 ${e.rounds_left}`);
  const options = optionsPart(e, oneLine);
  if (options !== null) parts.push(options);
  return parts.join('；');
}

/** One claim on one line: its fields in DISPLAY_ORDER, as label：text. */
export function claimLine(claim: Claim): string {
  return userClaimText(claim);
}

/** The reasons of the items a partition holds with a reason (held back, incomplete), counted in order of first use: （模型声明跳过 47，提交未覆盖 3）; nothing when none carries one. */
function reasonCounts(items: readonly ItemResult[] | undefined, { of: labelOf }: Labels = MODEL_LABELS): string {
  const counted = new Map<Reason, number>();
  for (const item of items ?? []) if ('reason' in item) counted.set(item.reason, (counted.get(item.reason) ?? 0) + 1);
  return counted.size === 0 ? '' : `（${[...counted].map(([reason, n]) => `${labelOf('reason', reason)} ${n}`).join('，')}）`;
}

/** Items per partition (a declared skip is told apart from an item the submission did not cover) and the items with an unknown terminal (V03 R[4]); unknown is never an error. */
export function countsText(counts: PartitionCounts, partitions?: Partitions, labels: Labels = MODEL_LABELS): string {
  const { of: labelOf, axis: axisLabel } = labels;
  const shown = PARTITION.map((p) => `${labelOf('partition', p)} ${counts[p]}${reasonCounts(partitions?.[p], labels)}`).join('，');
  return `${axisLabel('partition')}：${shown}；${labelOf('nature', 'unknown')} ${counts.unknown}${counts.pending_unknown ? `；其中 ${counts.pending_unknown} 个还有未决未知` : ''}`;
}

/** The partition counts line: receipt, items per partition and the items with an unknown terminal. */
export function countsLine(acceptance: SubmitOut['acceptance'], partitions: Partitions | undefined, labels: Labels = MODEL_LABELS): string {
  const receipt = `${labels.axis('acceptance')}：${labels.of('acceptance', acceptance)}`;
  if (partitions === undefined) return `${receipt}；没有分区（未受理的提交不分区）`;
  return `${receipt}；${countsText(partitionCountsOf(partitions), partitions, labels)}`;
}

function unknownError(error: ProtocolError): boolean {
  return isReason(error.code) || Object.hasOwn(SOURCE_UNKNOWN_CODES, error.code);
}

/** Ensure a clause ends with a sentence stop (owner 13:05: `<类别词>：<事实>。<下一步>。`). */
function asSentence(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return '';
  return /[。！？]$/.test(trimmed) ? trimmed : `${trimmed}。`;
}

/** Codes whose fact/next always go through D3 helpers (table-driven next; no keyword rewrite). */
const D3_FACT_REWRITE = new Set([
  'SOURCE_NOT_PERMITTED',
  'LEASE_UNAVAILABLE',
  'LEASE_EXPIRED',
  'SOURCE_INTEGRITY_UNPROVEN',
  'SOURCE_ABSENT',
  'SHARE_DUPLICATE',
  'MEMORY_CURSOR_STALE',
  'EFFECT_CONTENT_UNVERIFIED',
  'EFFECT_RELEASE_UNMET',
  'TEAM_PARSER_REQUIRED',
  'SYNC_MODE_LOCAL',
  'SOURCE_PENDING_REVIEW',
  'SYNC_PURGE_CONFIRMATION_REQUIRED',
  'RUN_SUPERSEDED',
  'RUN_ABANDONED',
]);

/**
 * Call-refusal line: category word, fact, next step; then optional independent appendages in fixed order:
 * 规则见… → 这是一小时内第 N 次… → 还可以重交 N 次。
 * When the fact already ends with the next-step sentence, do not print it twice (Boss 06:48 / round-29).
 */
function callErrorLine(category: string, message: string, fix: string | undefined, roundsLeft?: number): string {
  const { fact, next, rounds } = callErrorParts(category, message, fix, roundsLeft);
  return `${category}：${fact}${next}${rounds}`;
}

/** The sentences of one call refusal: the fact, the next step (empty when the fact already says it) and the rounds left. */
interface CallErrorParts { category: string; fact: string; next: string; rounds: string }

function callErrorParts(category: string, message: string, fix: string | undefined, roundsLeft?: number): CallErrorParts {
  const factBody = message.replace(/^无权限：|^已被占用：|^暂时不可用：|^参数无效：|^不存在：/, '').trim();
  const fact = asSentence(factBody);
  const nextRaw = fix && fix.trim().length > 0 ? fix.trim() : '由使用者核对输入资料';
  const nextSentence = asSentence(nextRaw);
  const factHasNext = nextRaw.length > 0 && (factBody.includes(nextRaw) || fact.includes(nextSentence));
  const next = factHasNext ? '' : nextSentence;
  const rounds = roundsLeft === undefined ? '' : asSentence(`还可以重交 ${roundsLeft} 次`);
  return { category, fact, next, rounds };
}

/**
 * Refusals in the order they came. Refusals of one category that give the same next step and the same rounds left say them
 * once, after their facts, at the place of the first of them, and every fact stays on a line of its own; a refusal alone keeps
 * the one-sentence form, and a line already written stays as it is. Nothing is merged by what its words say, only by the
 * next step being the same sentence.
 */
function callErrorLines(rows: readonly (CallErrorParts | string)[]): string[] {
  const keyOf = (row: CallErrorParts): string => `${row.category}\0${row.next}\0${row.rounds}`;
  const shared = new Map<string, CallErrorParts[]>();
  for (const row of rows) if (typeof row !== 'string' && row.next !== '') shared.set(keyOf(row), [...(shared.get(keyOf(row)) ?? []), row]);
  const lines: string[] = [];
  const said = new Set<string>();
  for (const row of rows) {
    if (typeof row === 'string') { lines.push(row); continue; }
    const group = row.next === '' ? undefined : shared.get(keyOf(row));
    if (group === undefined || group.length < 2) { lines.push(`${row.category}：${row.fact}${row.next}${row.rounds}`); continue; }
    if (said.has(keyOf(row))) continue;
    said.add(keyOf(row));
    lines.push(`${row.category}：`, ...group.map((member) => `- ${member.fact}`), row.next.startsWith('下一步') ? row.next : `下一步${row.next}`);
    if (row.rounds !== '') lines.push(row.rounds);
  }
  return lines;
}

/**
 * Pack-marked program-determined error (not missing input). Field name reserved until agy lands:
 * claim.statement.data.determination === 'error' (Boss 06:48 b).
 */
function packMarkedDeterminedError(claim: Claim): boolean {
  const data = claim.statement.data;
  return isRecord(data) && data.determination === 'error';
}

function requirementDeterminedError(requirement: RequirementResult): boolean {
  if (requirement.unsatisfied_reason === 'outcome_mismatch') return true;
  return requirement.claims.some((claim) => claim.statement.verdict === 'refute' || packMarkedDeterminedError(claim));
}

/** SOURCE_UNAVAILABLE keeps the unknown string; subject is「当前账户」(Boss afternoon). */
function conclusionErrorLine(error: ProtocolError, message: string, fix: string | undefined, options: { rounds?: boolean } = {}): string {
  const withRounds = options.rounds !== false;
  const presentation = errorPresentationOf(error.code);
  if (presentation.kind === 'unavailable') {
    return [
      '当前账户读不到这份资料',
      '状态未知',
      '原因缺资料',
      '下一步由使用者联系管理员核对',
      withRounds && error.rounds_left !== undefined ? `还可以重交 ${error.rounds_left} 次` : null,
      '决定者程序',
    ].filter((part) => part !== null).join('；');
  }
  // A call error without a declared category is not evidence of a business refutation.
  const status = unknownError(error) ? ['状态未知', isReason(error.code) ? `原因${labelOf('reason', error.code)}` : '原因缺资料'] : [];
  const next = fix && fix.trim().length > 0 ? fix.trim() : '缺少来源声明的修正指引，需补齐这次调用的下一步处理资料';
  return [
    message, ...status,
    `下一步${next.replace(/^下一步/, '')}`,
    withRounds && error.rounds_left !== undefined ? `还可以重交 ${error.rounds_left} 次` : null,
    unknownError(error) ? '决定者程序' : null,
  ].filter((part) => part !== null).join('；');
}

/**
 * Group item-level submit errors: one block per original case; identical fact lines merge with（×N）only when
 * verbatim equal (transitional; Boss 06:48 a). Shared「还可以重交」「决定者程序」once per case.
 */
function submitErrorBlocks(
  errors: readonly ProtocolError[],
  context: TextContext,
  represented: ReadonlySet<string>,
): string[] {
  const role = callerRole(context);
  const account = callerName(context);
  type Row = { error: ProtocolError; fact: string; category: string | null; fix: string | undefined; escalated: boolean };
  const groups = new Map<string, { label: string; rows: Row[]; rounds?: number }>();

  for (const error of errors) {
    if (error.item !== undefined && represented.has(error.item)) continue;
    const original = context.items?.find((item) => item.id === error.item);
    const missingRecord = error.code === 'SOURCE_RETRYABLE' && error.path === '/result';
    const message = missingRecord ? '核对结果的读取资料尚未取回' : error.message;
    const escalated = isEscalatedError(error);
    const fix = missingRecord
      ? proseByRole(role, 'missing_result_record')
      : escalated
        ? error.fix
        : fixByRole(error.code, role, error.fix, account);
    const category = callErrorCategoryOf(error.code);
    const factCore = !missingRecord && category !== null && D3_FACT_REWRITE.has(error.code) && original === undefined
      ? callErrorFact(error.code, error.message)
      : message;
    const labelled = original === undefined ? factCore : `${caseName(original, original.label)}，${factCore}`;
    const key = error.item ?? `\0${error.path ?? ''}\0${error.code}\0${error.message}`;
    const group = groups.get(key) ?? {
      label: original ? caseName(original, original.label) : '',
      rows: [],
      rounds: undefined,
    };
    const resolvedFix = missingRecord
      ? fix
      : category !== null
        ? (escalated
          ? fix
          : D3_FACT_REWRITE.has(error.code)
            ? callErrorNext(error.code, role, fix, error.message, account, error.path)
            : fix)
        : (fix ?? '缺少来源声明的下一步处理资料');
    group.rows.push({
      error,
      fact: labelled,
      category,
      fix: resolvedFix,
      escalated,
    });
    if (error.rounds_left !== undefined) {
      group.rounds = group.rounds === undefined ? error.rounds_left : Math.min(group.rounds, error.rounds_left);
    }
    groups.set(key, group);
  }

  const lines: (CallErrorParts | string)[] = [];
  for (const group of groups.values()) {
    const byFact = new Map<string, { row: Row; count: number }>();
    for (const row of group.rows) {
      const factKey = row.fact; // verbatim only (Boss 06:48 a)
      const seen = byFact.get(factKey);
      if (seen) seen.count += 1;
      else byFact.set(factKey, { row, count: 1 });
    }
    const unique = [...byFact.values()];
    const roundsLeft = group.rounds;
    if (group.label && (unique.every(({ row }) => row.category === null) || unique.length > 1 || (unique[0]?.count ?? 0) > 1)) {
      lines.push(`${group.label}：`);
      for (const { row, count } of unique) {
        const mark = count > 1 ? `（×${count}）` : '';
        if (row.category !== null) {
          const factOnly = row.fact.startsWith(group.label) ? row.fact.slice(group.label.length).replace(/^，/, '') : row.fact;
          lines.push(`- ${row.category}：${factOnly}${mark}`);
        } else {
          const factOnly = row.fact.startsWith(group.label) ? row.fact.slice(group.label.length).replace(/^，/, '') : row.fact;
          lines.push(`- ${factOnly}${mark}`);
        }
      }
      const nextSteps = [...new Set(group.rows.map(row => row.fix?.trim()).filter((fix): fix is string => Boolean(fix)))];
      if (nextSteps.length === 0) nextSteps.push('缺少来源声明的下一步处理资料');
      for (const next of nextSteps) lines.push(asSentence(next.startsWith('下一步') ? next : `下一步${next}`));
      if (roundsLeft !== undefined) lines.push(asSentence(`还可以重交 ${roundsLeft} 次`));
      const conclusions = group.rows.filter(row => row.category === null);
      if (conclusions.length > 0 && conclusions.every(row => unknownError(row.error))) lines.push('决定者程序。');
      continue;
    }

    // Single error, no case header: keep the historical one-line shapes.
    for (const { row, count } of unique) {
      const mark = count > 1 ? `（×${count}）` : '';
      if (row.category !== null) {
        const next = row.escalated
          ? row.fix
          : (row.fix ?? '由使用者核对输入资料');
        lines.push(callErrorParts(row.category, `${row.fact}${mark}`, next, roundsLeft));
      } else {
        lines.push(conclusionErrorLine(row.error, `${row.fact}${mark}`, row.fix, { rounds: true }));
      }
    }
  }
  return callErrorLines(lines);
}

function errorText(v: { errors: ProtocolError[]; trace: string }, context: TextContext = {}): string {
  const role = callerRole(context);
  const account = callerName(context);
  const allUnknown = v.errors.length > 0 && v.errors.every(unknownError);
  // Call refusals use the five-category sentence form: no 「这次核对有错误。」 lead (Boss 13:05).
  const lead = allUnknown ? '资料尚未取得。' : null;
  const lines = v.errors.map((error): CallErrorParts | string => {
    // Preserve D5 escalation already merged into structured fix (do not let fixByRole drop it).
    const escalated = isEscalatedError(error);
    const fix = escalated ? error.fix : fixByRole(error.code, role, error.fix, account);
    const presentation = errorPresentationOf(error.code);
    if (presentation.kind === 'unavailable') {
      return conclusionErrorLine(error, error.message, fix);
    }
    const category = callErrorCategoryOf(error.code);
    if (category !== null) {
      const fact = D3_FACT_REWRITE.has(error.code)
        ? callErrorFact(error.code, error.message)
        : error.message.replace(/^无权限：|^已被占用：|^暂时不可用：|^参数无效：|^不存在：/, '');
      const next = escalated
        ? fix
        : D3_FACT_REWRITE.has(error.code)
          ? callErrorNext(error.code, role, fix, error.message, account, error.path)
          : (fix ?? '由使用者核对输入资料');
      return callErrorParts(category, fact, next, error.rounds_left);
    }
    return conclusionErrorLine(error, error.message, fix);
  });
  return [lead, ...callErrorLines(lines)].filter((part): part is string => part !== null && part.length > 0).join('\n');
}

// ---------------------------------------------------------------- page cursors (get_nodes with a reference)

const CURSOR = /^(0|[1-9][0-9]{0,8})(?:\.([1-9][0-9]{0,8}))?-([0-9a-f]{12})$/;
const bindingOf = (reference: string): string => createHash('sha256').update(reference).digest('hex').slice(0, 12);

/**
 * The cursor of the page of a reference's content that starts at line `line` (0-based) and, inside a line longer than a
 * page, at UTF-16 offset `offset` of it: bound to that (canonical) reference.
 */
export function pageCursor(reference: string, line: number, offset = 0): string {
  return `${line}${offset > 0 ? `.${offset}` : ''}-${bindingOf(reference)}`;
}

/** Where a page cursor starts, or null when it was not made for this (canonical) reference. */
export function cursorPosition(reference: string, cursor: string): { line: number; offset: number } | null {
  const match = CURSOR.exec(cursor);
  if (match === null || match[3] !== bindingOf(reference)) return null;
  return { line: Number(match[1]), offset: match[2] === undefined ? 0 : Number(match[2]) };
}

/** The line a page cursor starts at, or null when it was not made for this (canonical) reference. */
export function cursorLine(reference: string, cursor: string): number | null {
  return cursorPosition(reference, cursor)?.line ?? null;
}

/** Why a cursor cannot page the content of this reference (Chinese, for the caller), or null when it can. */
export function pageCursorProblem(reference: string, cursor: string): string | null {
  return cursorPosition(reference, cursor) === null ? 'cursor 不是这个引用的翻页位置：照抄上一页末尾给出的 cursor，并且和同一个引用一起给' : null;
}

// ---------------------------------------------------------------- list_task_packs

/** The input binding an example call gives for one accepted type: an upload reference, or an external object identity. */
function bindingExample(accepts: string): { reference: string } | { external: string } {
  // A knowledge view is not named by one number: show the form its parser requires, with the required parameters.
  const view = accepts.startsWith('knowledge:') ? viewIdExample(accepts.slice('knowledge:'.length)) : null;
  if (view !== null) return { external: view };
  return EXTERNAL_TYPE.test(accepts) ? { external: `${accepts}:<编号>` } : { reference: EXAMPLE_SOURCE };
}

/**
 * An example start_run call for a pack, on one line: the pack, the first name of the product lines it is bound to (a pack
 * bound to several lines refuses a call without one), each required input with the binding shape of its first accepted
 * type and each required parameter with a placeholder. It always parses with StartRunInput.
 */
export function startRunExample(pack: PackSummary): string {
  const product = pack.products.length > 0 ? { product: pack.products[0] } : {};
  const inputs = Object.fromEntries(pack.inputs.filter((i) => i.required).map((i) => [i.slot, bindingExample(i.accepts[0] ?? '')]));
  const parameters = Object.fromEntries(pack.parameters.filter((p) => p.required).map((p) => [p.name, `<${p.name}>`]));
  const call = { pack: pack.pack, ...(pack.space?{pack_space:pack.space}:{}),...product, inputs, ...(Object.keys(parameters).length > 0 ? { parameters } : {}) };
  return JSON.stringify(StartRunInput.safeParse(call).success ? call : { pack: pack.pack, inputs: {} });
}

/** Tool-facing clock: month-day, minute, Hub zone (Boss 20:53). Console keeps browser-local formatting. */
function localMinute(value: string): string {
  return toolLocalMinute(value);
}

function listText(v: ListOut, context: TextContext): string {
  if (v.call_result === 'error') return errorText(v, context);
  const index = v.index ?? v.packs;
  // Boss 03:45 #4: when Codex projects unassigned_workflows_count, disclose that Hub has more packs than this member can use.
  const capabilities = (v as ListOut & {
    member_capabilities?: {
      unassigned_workflows_count?: number;
      environmentAccess?: { enforced?: boolean };
    };
  }).member_capabilities;
  const unassigned = capabilities?.unassigned_workflows_count;
  const role = callerRole(context);
  const head = typeof unassigned === 'number' && unassigned > 0
    ? proseByRole(role, 'unassigned_packs', { usable: index.length, unassigned })
    : packListHead(index.length);
  const lines = [head, ...index.map(pack => pack.title)];
  for (const observation of v.context?.observations ?? []) {
    lines.push(`测试环境 ${observation.label}，${observation.build === null ? '构建未知' : `构建 ${observation.build}`}；读取时间 ${localMinute(observation.observed_at)}`);
  }
  if (context.packList?.contextUnread) lines.push(proseByRole(role, 'context_unread'));
  for (const pack of v.packs) {
    lines.push(`${pack.title}，${pack.description}`);
    if (pack.products.length) lines.push(`产品 ${pack.products.join('、')}`);
    lines.push(...pack.inputs.map(input => `${input.description}，${required(input.required)}`));
    lines.push(...pack.parameters.map(parameter => `${parameter.description}，${required(parameter.required)}`));
    if (pack.local_tools) lines.push(`已提供 ${pack.local_tools.count} 个本地工具。`);
  }
  // 15:20: same preview fact as the console banner while environment assignment is not enforced.
  if (capabilities?.environmentAccess?.enforced === false) lines.push(ENVIRONMENT_ASSIGNMENT_PREVIEW);
  return lines.join('\n');
}

// ---------------------------------------------------------------- upload_file

function uploadText(v: UploadOut, context: TextContext): string {
  if (v.call_result === 'error') return errorText(v, context);
  if (v.memory_write) return '记忆已保存。';
  if (v.memory_share) return '记忆共享已核对。';
  if (v.share) return '共享已核对，个人资料保留。';
  if (v.withdrawn_reference) return '资料已撤回。';
  if (v.personal_entry) return '个人资料已保存。';
  return `资料已上传${v.size === undefined ? '' : `，共 ${v.size} 字节`}。`;
}

/** The item slot keys of a slot schema (one list per key in every handled item's slots). */
const slotKeys = (slots: SlotSchema | undefined): string[] => Object.keys(recordsOf(slots?.schema.properties));
const crossKeys = (slots: SlotSchema | undefined): string[] => Object.keys(recordsOf(slots?.schema.$defs));
const isProductionRun = (run: RunSummary): boolean => run.requirements.length > 0 && run.requirements.every((r) => r.accepted_producer === 'fact');

/**
 * The example submit_result of a run on one line: one handled item per example item (the first two) with an empty list for
 * each slot key, an empty cross_item when the slots declare cross-item entries. A production run takes commentary only: no
 * item slots, one cross-item judgment. Once the lists are filled it parses with Submission.
 */
export function submitExample(run: RunSummary): string {
  const model = run.model_identity !== undefined && run.session !== undefined ? {} : {model: MODEL_PLACEHOLDER};
  if (isProductionRun(run)) {
    const commentary = (grounds: string[]) => ({ run: run.run, ...model, items: [], cross_item: [{ nature: 'judgment', statement: '<你的评论>', grounds }] });
    const grounded = commentary(run.items.length > 0 ? [run.items[0].location] : []);
    return JSON.stringify(Submission.safeParse(grounded).success ? grounded : commentary([]));
  }
  const keys = slotKeys(run.slots);
  const items = run.items.slice(0, 2).map((item) => ({ item: item.id, handling: 'handled', slots: Object.fromEntries(keys.map((key) => [key, []])) }));
  const example = { run: run.run, ...model, items, ...(crossKeys(run.slots).length > 0 ? { cross_item: [] } : {}) };
  return JSON.stringify(Submission.safeParse(example).success ? example : { run: run.run, model: MODEL_PLACEHOLDER, items: [] });
}

// ---------------------------------------------------------------- validation results

/** Items in partition order with their partition and index in it. */
function itemsOf(partitions: Partitions): { partition: Partition; index: number; item: ItemResult }[] {
  return PARTITION.flatMap((partition) => partitions[partition].map((item, index) => ({ partition, index, item })));
}

/**
 * Per requirement over the items of a result (display rule 4): how many items satisfy it, do not (by reason) or are not
 * decided, then per layer how many items have each terminal, violations and failures by check tier; a layer the
 * requirement does not declare is not applicable. A requirement no item carries (a run-level one) is counted by its
 * cross-item claims. `declared` gives the order, the names and the declared layers.
 */
export function requirementCounts(result: ValidationResult, declared: readonly Pick<RequirementSummary, 'key' | 'name' | 'layers'>[] = []): string[] {
  interface Tally {
    status: Map<string, number>;
    reasons: Map<string, number>;
    terminals: Map<string, number>;
    tiers: Map<string, number>;
    layers: Set<Layer>;
  }
  const add = (map: Map<string, number>, key: string): void => {
    map.set(key, (map.get(key) ?? 0) + 1);
  };
  const keys: string[] = declared.map((d) => d.key);
  const tallies = new Map<string, Tally>();
  for (const { item } of itemsOf(result.partitions)) {
    for (const r of item.requirements) {
      let t = tallies.get(r.requirement);
      if (t === undefined) {
        t = { status: new Map(), reasons: new Map(), terminals: new Map(), tiers: new Map(), layers: new Set() };
        tallies.set(r.requirement, t);
        if (!keys.includes(r.requirement)) keys.push(r.requirement);
      }
      add(t.status, r.status);
      if (r.unsatisfied_reason !== undefined) add(t.reasons, r.unsatisfied_reason);
      for (const l of r.layers) {
        t.layers.add(l.layer);
        add(t.terminals, `${l.layer}:${l.terminal}`);
        if (l.tier !== undefined) add(t.tiers, `${l.layer}:${l.terminal}:${l.tier}`);
      }
    }
  }
  return keys.map((key) => {
    const d = declared.find((x) => x.key === key);
    const name = `${new Clip().field(key, CLIP.code, '')}${d !== undefined ? ` ${new Clip().field(d.name, CLIP.name, '')}` : ''}`;
    const t = tallies.get(key);
    if (t === undefined) {
      const claims = result.cross_item.filter((c) => c.requirement === key).length;
      return `- ${name}：没有条目结果${claims > 0 ? `；跨条目主张 ${claims} 条` : ''}`;
    }
    const status = REQUIREMENT_STATUS.map((s) => {
      const reasons = s === 'unsatisfied' ? UNSATISFIED_REASON.filter((r) => t.reasons.has(r)).map((r) => `${labelOf('unsatisfied_reason', r)} ${t.reasons.get(r)}`) : [];
      return `${labelOf('requirement_status', s)} ${t.status.get(s) ?? 0}${reasons.length > 0 ? `（${reasons.join('，')}）` : ''}`;
    }).join('，');
    const layers = d?.layers ?? LAYER.filter((l) => t.layers.has(l));
    const perLayer = LAYER.map((layer) => {
      if (!layers.includes(layer)) return `${labelOf('layer', layer)}：${NOT_APPLICABLE}`;
      const order: readonly string[] = layer === 'static' ? STATIC_TERMINAL : DYNAMIC_TERMINAL;
      const counted = order.flatMap((terminal) => {
        const n = t.terminals.get(`${layer}:${terminal}`) ?? 0;
        if (n === 0) return [];
        const tiers = CHECK_TIER.filter((tier) => t.tiers.has(`${layer}:${terminal}:${tier}`)).map((tier) => `${labelOf('check_tier', tier)} ${t.tiers.get(`${layer}:${terminal}:${tier}`)}`);
        const shown = { layer, terminal } as LayerTerminal;
        return [`${terminalSymbol(shown)} ${terminalLabel(shown)} ${n}${tiers.length > 0 ? `（${tiers.join('，')}）` : ''}`];
      });
      return `${labelOf('layer', layer)}：${counted.length > 0 ? counted.join('，') : '没有结果'}`;
    });
    return `- ${name}：${status}；${perLayer.join('；')}`;
  });
}

/** The message of a requirement's problem: the statement of the claim with the layer's code, else of its first claim. */
function messageOf(r: RequirementResult): string | null {
  const code = r.layers.find((l) => l.code !== undefined)?.code;
  const claim = r.claims.find((c) => code !== undefined && c.statement.code === code) ?? r.claims[0];
  return claim === undefined ? null : claim.statement.text;
}

/** Text of an entry whatever its form. */
const entryLines = (entry: Entry): readonly string[] => (typeof entry === 'string' ? [entry] : Array.isArray(entry) ? (entry as readonly string[]) : (entry as { lines: readonly string[] }).lines);

// ---------------------------------------------------------------- start_run

const visibly = (line: string): string => line.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, control => `\\x${control.charCodeAt(0).toString(16).padStart(2, '0')}`);

function itemSummary(item: ItemProjection): string {
  const counts = recordsOf(recordsOf(item.fields.review_counts).total);
  if (typeof counts.cases === 'number' && typeof counts.affectedCases === 'number' && typeof counts.findings === 'number') return `已核对 ${counts.cases} 条原始用例，其中 ${counts.affectedCases} 条有问题，共 ${counts.findings} 处问题${typeof counts.suggestions === 'number' ? `、${counts.suggestions} 条建议` : ''}`;
  return item.summary || '等待核对';
}

/** Slot placeholder written by submit-records; not a conclusion of its own when a check already spoke. */
const SLOT_JUDGMENT_PLACEHOLDER = '模型的重组判断';

/**
 * Reader label for one original case. Prefer fields.title when the pack wrote it
 * (recompose project.ts → intent text; patch text-next-pack-part for agy/cc-next).
 * Until that lands: case_id present but title absent →「标题未知」(do not echo case_id/label twice).
 */
function caseName(item: ItemProjection | undefined, label: string): string {
  if (item && isRecord(item.fields.review_counts)) return label;
  const id = item?.fields.autoid ?? item?.fields.case_id;
  const titled = item?.fields.title;
  const title = typeof titled === 'string' && titled.length > 0
    ? titled
    : item?.fields.case_id !== undefined && item.fields.title === undefined
      ? '标题未知'
      : label;
  return `原始用例 ${typeof id === 'string' || typeof id === 'number' ? `${id} ` : ''}${title}`;
}

/** Unique claim statements in order; drop the slot placeholder when a real check statement is present. */
function conclusionStatements(texts: readonly string[]): string[] {
  const unique: string[] = [];
  for (const text of texts) {
    if (!text || unique.includes(text)) continue;
    unique.push(text);
  }
  const withoutPlaceholder = unique.filter((text) => text !== SLOT_JUDGMENT_PLACEHOLDER);
  return withoutPlaceholder.length > 0 ? withoutPlaceholder : unique;
}

function awaitingExcel(item: ItemResult): boolean {
  if (item.requirements.some((requirement) => requirement.requirement === 'workbook_verified' && requirement.status !== 'satisfied')) return true;
  return false;
}

function itemConclusion(item: ItemResult, original: ItemProjection | undefined): string {
  const pending = item.requirements.some(requirement => requirement.status === 'pending' || requirement.unsatisfied_reason === 'independence_unknown');
  const wrong = item.requirements.filter(requirement => requirement.status === 'unsatisfied' && requirement.unsatisfied_reason === 'outcome_mismatch');
  const claims = item.requirements.flatMap(requirement => requirement.claims);
  const model = claims.some(claim => claim.qualifier.nature === 'judgment' || claim.warrant.producer === 'model');
  const partial = claims.some(claim => claim.qualifier.coverage?.complete === false || claim.qualifier.marks.includes('partial'));
  const packDetermined = item.requirements.some(requirement => requirement.claims.some(packMarkedDeterminedError));
  const determined = wrong.length > 0 || packDetermined || item.requirements.some(requirementDeterminedError);
  const unknown = !determined && (partial || pending || item.requirements.length === 0 || claims.some(claim => claim.qualifier.nature === 'unknown' || claim.validity.status !== 'valid' || userVerdict(claim.statement.verdict) === null) || item.requirements.some(requirement => requirement.layers.some(layer => isUnknownTerminal(layer) || layer.terminal === 'incomplete')));
  const status = determined ? (model ? '未确认' : '已确认') : unknown ? '未知' : model ? '未确认' : '已确认';
  const judgment = determined ? '错误' : unknown ? null : '正确';
  const excel = unknown && !determined && awaitingExcel(item);
  const problems = item.requirements.filter(requirement => requirement.status !== 'satisfied' || requirement.layers.some(layer => isUnknownTerminal(layer) || layer.terminal === 'incomplete') || requirement.claims.some(packMarkedDeterminedError));
  const layers = problems.flatMap(requirement => requirement.layers.filter(layer => layer.terminal !== 'pass' && layer.terminal !== 'judgment'));
  const recordGap = problems.some((requirement) => requirement.requirement === 'record');
  // Prefer concrete missing/refute facts for record (and similar) gaps; Excel/in-flight keep their fixed statements.
  const gapFacts = excel ? [] : [...new Set(problems.flatMap((requirement) => {
    const fromLayers = requirement.layers.flatMap((layer) => typeof layer.missing === 'string' ? [layer.missing] : []);
    const fromClaims = requirement.claims
      .filter((claim) => claim.statement.verdict === 'unknown' || claim.statement.verdict === 'refute' || packMarkedDeterminedError(claim))
      .map((claim) => claim.statement.text);
    return [...fromLayers, ...fromClaims];
  }).filter((text) => text.length > 0))];
  // In progress: waiting on the next step / device output — keep 状态未知, do not force a reason word (Boss 20:53).
  // Concrete layer reasons (not_covered, missing_input, check_error, …) stay on the reason-word path.
  const concreteGap = layers.some((layer) => (layer.reason !== undefined && layer.reason !== 'awaiting_step') || layer.attribution !== undefined);
  const inFlight = unknown && !determined && !excel && !partial && !concreteGap
    && (pending || item.requirements.length === 0 || layers.some((layer) => layer.reason === 'awaiting_step' || layer.terminal === 'incomplete' || isUnknownTerminal(layer)));
  const statement = determined
    ? conclusionStatements([
      ...wrong.map((requirement) => messageOf(requirement)).filter((text): text is string => Boolean(text)),
      ...gapFacts,
    ]).join('；') || '核对发现错误'
    : inFlight
      ? '上机验证还在进行，还没有设备输出'
      : excel
        ? '还没有确认结论'
        : unknown
          ? (gapFacts.length > 0 ? gapFacts.join('；') : '还没有确认结论')
          : conclusionStatements(claims.map(claim => claim.statement.text)).join('；') || '已按要求核对';
  const parts = [`${caseName(original, item.label)}：${statement}`, `状态${status}`];
  if (judgment !== null) parts.push(`判断${judgment}`);
  if (excel) {
    parts.push('下一步由模型生成并上传自动化用例 Excel 后重新交给 Hub 检查');
  } else if (inFlight) {
    parts.push('下一步由模型在上机验证结束后读取设备输出');
  } else if (determined) {
    parts.push(`原因${[...new Set(layers.map(userReason))].join('、') || '还没查清'}`);
    parts.push(recordGap ? '下一步由模型改正重组记录后重交' : '下一步由模型改正');
  } else if (unknown) {
    parts.push(`原因${partial ? '缺资料' : [...new Set(layers.map(userReason))].join('、') || '还没查清'}`);
    parts.push(recordGap
      ? '下一步由模型改正重组记录后重交'
      : `下一步${partial ? '使用者补齐资料后重新交给 Hub 检查' : [...new Set(layers.map(userNextStep))].join('；') || '使用者核对资料后重新交给 Hub 检查'}`);
  }
  // Evidence must not restate quote texts already shown as「引文 … 与所引片段逐字一致」.
  const quotes = [...new Set(claims.flatMap(claim => claim.resolutions?.filter(value => !value.references.includes(value.text)).map(value => value.text) ?? []))].filter((text) => !statement.includes(text));
  if (quotes.length) parts.push(`证据${quotes.join('；')}`);
  if (item.replaced_criteria?.length) parts.push(...item.replaced_criteria.map(change => `原始用例的要求由${change.old}改为${change.new}`));
  parts.push(`决定者${[...new Set(claims.map(claim => USER_DECIDER[claim.warrant.producer]))].join('、') || '程序'}`);
  return parts.join('；');
}

function resultConclusions(result: ValidationResult, originals: readonly ItemProjection[] = []): string[] {
  const items = new Map(originals.map(item => [item.id, item]));
  const conclusions = itemsOf(result.partitions).map(({ item }) => itemConclusion(item, items.get(item.item)));
  return result.acceptance === 'accepted' && conclusions.length === 0 ? ['没有需要核对的原始用例。'] : conclusions;
}

function startText(v: StartOut, context: TextContext): string {
  if (v.call_result === 'error' || v.run === undefined) return errorText(v, context);
  const run = v.run;
  const lines = [run.build === undefined ? '资料已读取。' : `资料已读取，本次核对采用构建 ${run.build}。`];
  if (context.production !== undefined && context.production !== null) lines.push(...resultConclusions(context.production, run.items), ...context.production.cross_item.map(claimLine));
  else lines.push(...run.items.map(item => `${caseName(item, item.label)}，${itemSummary(item)}；状态未知；原因缺资料；下一步由模型按说明核对原始用例；决定者程序`));
  for (const source of run.sources) if (source.coverage?.complete === false) lines.push('原始用例或资料尚未读全；状态未知；原因缺资料；下一步由使用者补齐资料。');
  for (const gap of context.unavailable ?? []) lines.push(`状态未知；原因缺资料；下一步由使用者提供可读取的${gap.role === 'subject' ? '原始用例' : '资料'}。`);
  for (const change of run.criterion_changes ?? []) {
    const item = run.items.find(item => item.id === change.item);
    const state = change.superseded_by ? '已有新的修改意见' : change.accepted === true ? '修改意见已确认' : change.accepted === false ? `修改意见未确认，${change.reason}` : change.expired ? '修改意见已过期' : '修改意见尚未确认';
    lines.push(`${caseName(item, item?.label ?? '')}，${change.assertion}；${state}；状态${change.accepted === true ? '已确认' : '未确认'}；下一步${change.next_action}；决定者使用者`);
  }
  for (const observation of run.device_observations ?? []) {
    const data = observation.statement.data;
    // Booking fact for devices that take no commands: one plain line, no verification conclusion chain (Boss 20:53).
    if (data?.kind === 'no_command_devices' && typeof observation.statement.text === 'string') {
      lines.push(observation.statement.text);
      continue;
    }
    if (typeof data?.label === 'string') {
      const text = `测试环境 ${data.label}，${typeof data.build === 'string' ? `构建 ${data.build}` : '构建未知'}${observation.qualifier.collected_at ? `，读取时间 ${localMinute(observation.qualifier.collected_at)}` : ''}`;
      lines.push(claimLine({ ...observation, statement: { ...observation.statement, text } }));
    } else lines.push(claimLine(observation));
  }
  if (run.device_help?.length) lines.push('设备输出仅供参考，不能作为原始用例的期望依据。');
  for (const claim of run.device_help ?? []) {
    lines.push(claimLine(claim));
    const words = claim.statement.data?.help;
    if (typeof words === 'string') lines.push('设备输出', ...words.split(/\r\n|\r|\n/).map(visibly));
  }
  return lines.join('\n');
}

/** A node: its line, all its entries (the definitions to cite), its children and the related references the service gave. */
function nodeEntry(node: KnowledgeNode, _root: string, role: CallerRole): Entry {
  const lines = [node.name, ...node.entries.map(entry => entry.statement)];
  for (const entry of node.entries) {
    for (const ground of entry.grounds ?? []) lines.push(`证据${ground.quotation}`);
  }
  for (const view of node.contributions ?? []) {
    const contribution = view.contribution;
    if (contribution === undefined) {
      lines.push('相关资料尚未读全；状态未知；原因缺资料；下一步由使用者继续读取完整资料。');
      continue;
    }
    if (!('statement' in contribution)) {
      lines.push(proseByRole(role, 'contribution_unreadable'));
      if (view.note !== null) lines.push(view.note);
      continue;
    }
    const changed = view.status !== 'valid';
    lines.push(`${contribution.statement}；状态${changed ? '未知' : '未确认'}${changed ? '；原因缺资料；下一步由使用者重新核对原句' : ''}；决定者模型`);
    if (view.status === 'grounds_withdrawn') lines.push('资料或证据已撤回，历史原句保留。');
    if (view.status === 'cited_fragment_changed') lines.push('被引用的原句已经改变。');
    lines.push(`证据${contribution.source.quote}`);
    const feeding = contribution.feeding;
    if (feeding && 'device' in feeding && feeding.device) lines.push(`测试环境 ${feeding.device}${'bed' in feeding && feeding.bed ? `，${feeding.bed}` : ''}`);
    const conflict = contribution.relation?.kind === 'contradicts' || feeding && 'relations' in feeding && feeding.relations?.some(relation => relation.kind === 'contradicts');
    if (conflict) lines.push('两份资料的说法有冲突；状态未知；原因还没查清；下一步由使用者核对两边原句。');
  }
  lines.push(...node.children.map(child => child.name));
  if (node.backlinks) {
    lines.push(`相关资料共 ${node.backlinks.total ?? node.backlinks.entries.length} 份。`);
    lines.push(...node.backlinks.entries.map(link => link.summary));
    if (node.backlinks.total !== null && node.backlinks.entries.length < node.backlinks.total) lines.push('还有相关资料未列出；状态未知；原因缺资料；下一步由使用者继续读取相关资料。');
  }
  return lines;
}

const MEMORY_NOTE = '记忆只供参考，不作为核对原始用例的资料或证据。';
const ENTRY_QUALIFICATION = {
  verified: '', unverified: '',
  withdrawn: '资料或证据已撤回，当前结论状态未知；原因缺资料；下一步由使用者重新核对当前资料。以下是当时保存的原文。\n',
  superseded: '资料已有新版本，以下是当时保存的原文。\n',
} as const satisfies Record<KnowledgeEntryStatus, string>;

function nodesText(v: NodesOut, context: TextContext): string {
  if (v.call_result === 'error') return errorText(v, context);
  if (v.memory_document) return `${v.memory_document.title}\n${MEMORY_NOTE}\n${v.memory_document.markdown}`;
  if (v.memory_page) return [MEMORY_NOTE, ...v.memory_page.items.map(document => document.title)].join('\n');
  if (v.matches !== undefined) return [`找到 ${v.matches.length} 份相关资料，仅作参考。`, ...v.matches.map(hit => hit.statement), ...(v.warnings ?? []).map(warning => `${warning.message}；下一步${warning.fix ?? '使用者核对资料'}`)].join('\n');
  if (v.call_status) {
    const status = v.call_status;
    return [`正在处理 ${status.active_total} 次，已结束 ${status.completed.length} 次。`, ...(status.active.map(call => `开始时间 ${localMinute(call.started_at)}`)), ...(status.missing ? [`状态未知；原因缺资料；${status.missing}`] : []), `下一步${status.next_action}`].join('\n');
  }
  if (v.content !== undefined) {
    const content = v.content, status = content.structure?.entry_status;
    const entryQualification = isKnowledgeEntryStatus(status) ? ENTRY_QUALIFICATION[status] : '';
    const withdrawn = content.structure?.grounds_withdrawn, hidden = content.structure?.grounds_withdrawn_hidden_count;
    const groundsWithdrawn = Array.isArray(withdrawn) && withdrawn.length > 0 || typeof hidden === 'number' && hidden > 0;
    const groundsQualification = groundsWithdrawn && status !== 'withdrawn' ? '证据已撤回，当前结论状态未知；原因缺资料；下一步由使用者重新核对当前资料。以下是当时保存的结论。\n' : '';
    return entryQualification + groundsQualification + contentText(content, v.trace, context);
  }
  const nodes = v.nodes ?? [];
  const role = callerRole(context);
  return ['手册和命令树', ...nodes.flatMap(node => entryLines(nodeEntry(node, v.root ?? '', role))), ...(v.next ? ['还有资料未列出，请继续读取。'] : [])].join('\n');
}

/** Whether UTF-16 offset `at` of `text` falls between the two halves of a surrogate pair (no page starts there). */
function insidePair(text: string, at: number): boolean {
  if (at <= 0 || at >= text.length) return false;
  const before = text.charCodeAt(at - 1);
  const after = text.charCodeAt(at);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

/** The content a reference points at, whole from the reader's position (a cursor an earlier answer gave), else from the start. */
function contentText(c: Content, _trace: string, context: TextContext): string {
  if (c.text === undefined) {
    if (c.read_tier === 'retain_only') {
      return `${c.note ? `${c.note}；` : ''}原文尚未读出；状态未知；原因缺资料；下一步：这份来源只保留，不会放开；需要其中的内容时，按原对象重新读取，得到一份可读的新记录。`;
    }
    return `${c.note ? `${c.note}；` : ''}${proseByRole(callerRole(context), 'content_unread')}`;
  }
  if (c.reference.startsWith('rec:')) {
    let value: unknown;
    try { value = JSON.parse(c.text); } catch { return c.text; }
    if (typeof value === 'string') return value;
    const result = StoredValidationResult.safeParse(value);
    if (result.success) return [...resultConclusions(result.data, context.items), ...result.data.cross_item.map(claimLine)].join('\n');
    const shape = z.union(PARTITION.map(partition => StoredPartitionItem[partition]));
    const item = shape.safeParse(value);
    if (item.success) return itemConclusion(item.data, context.items?.find(original => original.id === item.data.item));
    const items = shape.array().safeParse(value);
    if (items.success) return items.data.length ? items.data.map(item => itemConclusion(item, context.items?.find(original => original.id === item.item))).join('\n') : '没有原始用例。';
    const originals = ItemProjection.array().safeParse(value);
    if (originals.success) return originals.data.length ? originals.data.map(item => caseName(item, item.label)).join('\n') : '没有原始用例。';
    return '资料已读取，完整内容在机器可读答复中。';
  }
  const lines = c.text.split('\n');
  const position = context.cursor ? cursorPosition(c.reference, context.cursor) : null;
  const valid = position !== null && lines[position.line] !== undefined && (position.offset === 0 || position.offset < lines[position.line].length) && !insidePair(lines[position.line], position.offset);
  const start = valid ? position : { line: 0, offset: 0 };
  const notice = context.cursor && !valid ? '读取位置无效，下面从头显示。\n' : '';
  return `${notice}原文（${c.text.length} 个字符）：\n${[lines[start.line].slice(start.offset), ...lines.slice(start.line + 1)].join('\n')}`;
}

// ---------------------------------------------------------------- resolve_reference

function resolveText(v: ResolveOut, context: TextContext): string {
  if (v.call_result === 'error' || v.resolution === undefined) return errorText(v, context);
  const state = v.resolution === 'resolved' ? '已确认' : '未知';
  const lines = [`原句核对状态${state}。`, ...v.references.map(reference => reference.text)];
  if (state === '未知') lines.push('原因还没查清；下一步由使用者给出更完整的原句。');
  return lines.join('\n');
}

// ---------------------------------------------------------------- submit_result

/** Five call-error category heads (owner 2026-11-14): no status/judgment/decider chain after these. */
const CALL_ERROR_HEAD = /^(参数无效|无权限|不存在|已被占用|暂时不可用)：/;

/**
 * Member next steps aligned with formatReleaseRefusal (hub/dispatch/refusal-text.ts).
 * Used when accepted/reasons dropped the self-serve path and left only「联系管理员…」.
 */
const RELEASE_IDENTITY_MEMBER_NEXT =
  '先确认预订的是哪个测试环境，用它对应的运行环境配置重新做脚本编写和脚本合并，再发起上机验证；预订和配置都没错时，请管理员核对执行器的声明';
const RELEASE_RESULT_MEMBER_NEXT =
  '按脚本合并返回的错误逐条改正，脚本合并正确后再发起上机验证';
const RELEASE_GENERIC_MEMBER_NEXT =
  '能在自动化用例 Excel 或预订上改的，改正后再发起上机验证；其余请管理员按放行条件逐条对照处理';
const RELEASE_IDENTITY_ADMIN_NEXT =
  '按执行器声明的测试环境和清单重新做脚本编写和脚本合并，再发起上机验证；或者登记一个和这次核对一致的执行器';
const RELEASE_RESULT_ADMIN_NEXT =
  '按脚本合并返回的错误逐条改正，脚本合并正确后再发起上机验证';
const RELEASE_GENERIC_ADMIN_NEXT =
  '按上面的错误补齐后，再发起上机验证';

function noteBlob(note: DispatchNote): string {
  return [note.text, note.next_action ?? '', ...(note.missing_facts ?? []).flatMap((row) => [row.fact, row.next_action])].join('\0');
}

function releaseIdentityNote(blob: string): boolean {
  return /目标或清单摘要与当前执行器声明不一致|核验目标与清单等于执行器声明/.test(blob);
}

function releaseResultNote(blob: string): boolean {
  return /核验结果没有未消除错误|脚本合并的结果里还有错误/.test(blob);
}

/** True when the note is a release-gate refusal that lost the self-serve next step. */
function releaseRefusalNeedsNext(blob: string, message: string): boolean {
  if (/先确认预订|按脚本合并返回的错误逐条改正|现在可以做：/.test(message)) return false;
  return releaseIdentityNote(blob) || releaseResultNote(blob)
    || /联系管理员核对当前环境的清单绑定|联系管理员查看具体放行条件|上机前的放行条件尚未满足|放行条件/.test(blob);
}

function releaseNextByRole(note: DispatchNote, role: CallerRole): string | null {
  const blob = noteBlob(note);
  // Already carries formatReleaseRefusal self-serve / diagnosed next — leave it.
  if (/先确认预订|按脚本合并返回的错误逐条改正|现在可以做：/.test(note.text)) return null;
  if (!releaseRefusalNeedsNext(blob, note.text) && !releaseIdentityNote(blob) && !releaseResultNote(blob)) return null;
  if (releaseIdentityNote(blob)) {
    if (role === 'admin') {
      const explain = note.executor
        ? `。逐条对照：circle-hub job explain-release --executor ${note.executor}`
        : '';
      // 【问题】DispatchNote 无 run id，拼不出完整的 explain-release --run …；有 executor 时仍给管理命令半句。
      return RELEASE_IDENTITY_ADMIN_NEXT + explain;
    }
    return RELEASE_IDENTITY_MEMBER_NEXT;
  }
  if (releaseResultNote(blob)) {
    if (role === 'admin') {
      const explain = note.executor
        ? `。逐条对照：circle-hub job explain-release --executor ${note.executor}`
        : '';
      return RELEASE_RESULT_ADMIN_NEXT + explain;
    }
    return RELEASE_RESULT_MEMBER_NEXT;
  }
  if (role === 'admin') {
    const explain = note.executor
      ? `。逐条对照：circle-hub job explain-release --executor ${note.executor}`
      : '';
    return RELEASE_GENERIC_ADMIN_NEXT + explain;
  }
  return RELEASE_GENERIC_MEMBER_NEXT;
}

/** Split `<类别词>：<事实>。<下一步>。` (formatCallError / callErrorLine); last sentence is the next step when ≥2. */
function splitCallErrorProse(message: string): { category: string; fact: string; next: string } | null {
  const matched = message.trim().match(/^(参数无效|无权限|不存在|已被占用|暂时不可用)：(.+)$/s);
  if (!matched) return null;
  const body = matched[2].trim();
  const sentences = body.match(/[^。！？]+[。！？]/gu);
  if (sentences && sentences.length >= 2) {
    const next = sentences[sentences.length - 1].replace(/[。！？]$/u, '').trim();
    const fact = sentences.slice(0, -1).join('').replace(/[。！？]$/u, '').trim();
    return { category: matched[1], fact, next };
  }
  return { category: matched[1], fact: body.replace(/[。！？]$/u, '').trim(), next: '' };
}

/**
 * Decision 155 puts three dispatch outcomes in `dispatch[].text`. Reader wording is usually owned by hub/dispatch;
 * this exit still (Boss 15:02): (1) never appends a conclusion chain onto five-category call-error prose;
 * (2) restores formatReleaseRefusal member/admin next steps when accepted/reasons dropped them;
 * (3) does not let the booking rewrite cover an existing occupied/absent/expired category sentence.
 */
function dispatchNoteLine(note: DispatchNote, role: CallerRole): string {
  const message = note.text;
  const callError = CALL_ERROR_HEAD.test(message.trim());

  // Booking rewrite: only when the note is not already a five-category call-error sentence (E1 must not wipe 已被占用/不存在).
  if (
    !callError
    && note.submission_verified === true
    && note.outcome === 'not_dispatched'
    && note.frozen !== true
    && note.booking?.coverage_complete === false
  ) {
    const count = note.booking.declared_device_count;
    const devices = typeof count === 'number' && Number.isInteger(count) && count >= 0 ? `共 ${count} 台设备` : '设备数量尚未核对';
    return `脚本合并正确（已确认）；本次没有上机验证，因为这次运行没有带着测试环境的预订；测试环境：${note.booking.target}（${devices}）；下一步：先预订整个测试环境，再从脚本编写重开并核验合并。`;
  }
  // a job that was not sent, was refused by the target or is proven not executed has no device return; its
  // `result` reference is only the pre-dispatch check conclusion, so it is never "设备输出已取回".
  const notRun = note.outcome === 'not_dispatched' || note.outcome === 'target_rejected' || note.outcome === 'proven_not_executed';
  if (note.result !== undefined && !notRun) {
    return '设备输出已取回；状态未知；原因还没查清；下一步由模型核对设备输出。';
  }

  // Five-category call errors: keep `<类别词>：<事实>。<下一步>。` — no 状态/判断/决定者 chain.
  if (callError) {
    const parts = splitCallErrorProse(message);
    if (parts === null) return message;
    const better = releaseNextByRole(note, role);
    const next = better
      ?? (parts.next.length > 0 ? parts.next : undefined)
      ?? (note.missing_facts?.length ? [...new Set(note.missing_facts.map((row) => row.next_action))].join('；') : note.next_action)
      ?? undefined;
    return callErrorLine(parts.category, parts.fact, next);
  }

  // In-progress dispatch notes already say what is waiting and who acts next — no reason-word chain (Boss 20:53).
  if (
    message.includes('下一步由模型稍后把这次脚本合并原样再交一次，读取进展')
    || /已按工作流的规定自动开始上机验证/.test(message)
    || message.includes('正在做上机验证前的核对')
    || (message.includes('上机验证还在进行') && !message.includes('上机验证结果未知'))
  ) {
    return message;
  }

  // Owner 2026-11-12: unanswered stays 「上机验证结果未知」. Match the dispatch package's reader wording.
  if (message.includes('上机验证结果未知') || /不要重交，也不要另开/.test(message)) {
    return `${message}；状态未知；原因还没查清；决定者程序`;
  }
  if (
    message.includes('上机验证没有发出') ||
    message.includes('什么都没有发到目标') ||
    message.includes('目标没有接收') ||
    /目标在“.+”阶段拒绝/.test(message) ||
    message.includes('已证明目标没有执行')
  ) {
    // C14: when release refusal already names the错误 and next step, do not append「原因还没查清」.
    const diagnosed = message.includes('放行条件里有 ') || message.includes('还没有核对');
    const better = releaseNextByRole(note, role);
    let body = message;
    if (better && !/现在可以做：|先确认预订|按脚本合并返回的错误逐条改正/.test(message)) {
      body = /下一步/.test(message)
        ? message.replace(/下一步：[^；]*/u, `下一步：${better}`)
        : `${message.replace(/[。；]?$/u, '')}。现在可以做：${better}`;
    }
    return diagnosed
      ? `${body}；状态已确认；判断错误；决定者程序`
      : `${body}；状态已确认；判断错误；原因还没查清；决定者程序`;
  }
  // a job that did not go out and carries the Hub's own facts says them (reason and named next step, from the
  // structure) instead of the generic "原因还没查清；下一步由使用者继续读取设备输出".
  if (notRun) {
    const fact = note.missing_facts?.length ? [...new Set(note.missing_facts.map((row) => row.fact))].join('；') : '未取得可读取的未派发原因';
    const next = note.missing_facts?.length ? [...new Set(note.missing_facts.map((row) => row.next_action))].join('；') : note.next_action ?? '由使用者联系测试环境管理员核对未派发记录并补齐原因';
    return `上机验证${labelOf('effect_outcome', note.outcome!)}：${fact}。下一步：${next}；未取得用例在设备上的判断，状态未知；决定者程序仅披露派发记录`;
  }
  return `${message}；状态未知；原因还没查清；下一步由使用者继续读取设备输出；决定者程序`;
}

/** Lead sentence for submit_result: only the producer-supplied step_name (trimmed), else the neutral form (CHANGELOG Unreleased: submit_result lead / step_name). */
function submitLead(v: Pick<SubmitOut, 'acceptance' | 'step_name'>): string {
  const name = typeof v.step_name === 'string' ? v.step_name.trim() : '';
  const labeled = name.length > 0 ? name : null;
  if (v.acceptance === 'accepted') return labeled ? `${labeled}已核对。` : '核对已完成。';
  return labeled ? `${labeled}有错误。` : '核对有错误。';
}

function submitText(v: SubmitOut, context: TextContext): string {
  const role = callerRole(context);
  const lines = [submitLead(v)];
  const represented = new Set(v.acceptance === 'accepted' && v.result !== undefined ? itemsOf(v.result.partitions).map(({ item }) => item.item) : []);
  if (v.acceptance === 'accepted' && v.result !== undefined) {
    lines.push(...resultConclusions(v.result, context.items));
    lines.push(...v.result.cross_item.map(claimLine));
  }
  if (v.result?.contributions) {
    const saved = v.result.contributions;
    lines.push(`资料已保存 ${saved.stored.length} 条，未保存 ${saved.not_stored.length} 条。`);
    for (const rejected of saved.not_stored) {
      const original = context.items?.find(item => item.id === rejected.item);
      lines.push(`${original ? caseName(original, original.label) : '资料未保存'}，${rejected.reason}；状态已确认；判断错误；原因缺资料；下一步由使用者补齐资料。`);
    }
  }
  lines.push(...sayOnce((v.dispatch ?? []).map((note) => dispatchNoteLine(note, role))));
  lines.push(...submitErrorBlocks(v.errors, context, represented));
  return lines.join('\n');
}

/**
 * A line the reader would read twice is said once, with how many times it came: jobs of a run that ended the same way, with
 * nothing in their note to tell them apart, are one fact of the run. Lines that differ at all stay as they are, in order; the
 * notes themselves, each with its job, stay whole in the structured answer.
 */
function sayOnce(lines: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1);
  return [...counts].map(([line, count]) => (count > 1 ? `${line}（×${count}）` : line));
}

// ---------------------------------------------------------------- entry point

const RENDERERS: Record<string, (value: never, context: TextContext) => string> = {
  list_task_packs: listText,
  upload_file: uploadText,
  start_run: startText,
  get_nodes: nodesText,
  resolve_reference: resolveText,
  submit_result: submitText,
};

export function modelReferencesText(value: Record<string, unknown>, context: TextContext = {}): string {
  return '供模型引用\n' + JSON.stringify({
    ...value,
    original_cases: context.items?.map(item => ({ id: item.id, autoid: item.fields.autoid ?? item.fields.case_id ?? null, title: item.fields.title ?? null })),
    source_context: context.unavailable === undefined && context.gaps === undefined ? undefined : { unavailable: context.unavailable, gaps: context.gaps },
  });
}

/** User-facing text; identifiers remain in structuredContent. */
export function toolText(tool: string, value: unknown, context: TextContext = {}): string {
  const render = RENDERERS[tool] as ((value: unknown, context: TextContext) => string) | undefined;
  if (render === undefined) throw new Error(`no text renderer for ${tool}`);
  return render(value, context);
}

/** A readable failure when a validated answer cannot be rendered. */
export function fallbackText(_tool: string, _value: unknown, context: TextContext = {}): string {
  return proseByRole(callerRole(context), 'fallback');
}

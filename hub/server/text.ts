
// Reader-facing text; the original tool data stays in structuredContent.
// Reader-facing text; the original tool data stays in structuredContent.
import { createHash } from 'node:crypto';
import { viewIdExample } from '../knowledge/api.ts';
import { z } from 'zod';
import { CHECK_TIER, DYNAMIC_TERMINAL, LAYER, PARTITION, REQUIREMENT_STATUS, STATIC_TERMINAL, UNSATISFIED_REASON, axisLabel, labelOf, type Layer, type Partition, type Reason, type SourceRole } from '../../contracts/generated/vocabulary.ts';
import type { ProtocolCode } from '../../contracts/generated/protocol.ts';
import type { Claim } from '../../contracts/src/claim.ts';
import type { ProtocolError } from '../../contracts/src/common.ts';
import { ItemProjection, type PackSummary, type RequirementSummary, type RunSummary, type SlotSchema } from '../../contracts/src/run.ts';
import { Submission } from '../../contracts/src/submission.ts';
import { StartRunInput, type GetNodesOutput, type ListTaskPacksOutput, type ResolveReferenceOutput, type StartRunOutput, type SubmitResultOutput, type UploadFileOutput } from '../../contracts/src/tools.ts';
import { PartitionCounts, StoredValidationResult, StoredPartitionItem, Partitions, ValidationResult, partitionCountsOf, isUnknownTerminal, type ItemResult, type RequirementResult } from '../../contracts/src/validation.ts';
import { oneLine, type Entry, type Omission } from './budget.ts';
import { MODEL_LABELS, NOT_APPLICABLE, coverageText, terminalLabel, terminalSymbol, userClaimText, userReason, userNextStep, USER_DECIDER, type Labels, type LayerTerminal } from './claims.ts';

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

const SOURCE_READ_ERRORS = {
  SOURCE_UNPARSEABLE: true, SOURCE_UNAVAILABLE: true, SOURCE_NOT_PERMITTED: true, SOURCE_RETRYABLE: true,
  SOURCE_INTEGRITY_UNPROVEN: true, SOURCE_READ_FAILED: true, SOURCE_READ_LIMIT: true,
  SOURCE_REDIRECT_REFUSED: true, SOURCE_ABSENT: true, SOURCE_PENDING_REVIEW: true,
} satisfies Partial<Record<ProtocolCode, true>>;

function sourceUnknown(error: ProtocolError): boolean {
  return Object.hasOwn(SOURCE_READ_ERRORS, error.code);
}

function errorText(v: { errors: ProtocolError[]; trace: string }): string {
  return [v.errors.every(sourceUnknown) ? '资料尚未取得。' : '这次核对有错误。', ...v.errors.map(error => [
    error.message, ...(sourceUnknown(error) ? ['状态未知', '原因缺资料'] : ['状态已确认', '判断错误', '原因还没查清']),
    error.fix ? `下一步${error.fix}` : '下一步由使用者核对输入资料',
    error.rounds_left === undefined ? null : `最多重交 ${error.rounds_left} 次`, '决定者程序',
  ].filter(part => part !== null).join('；'))].join('\n');
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

function localMinute(value: string): string {
  return new Date(value).toLocaleString('sv-SE', { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }).slice(0, 16);
}

function listText(v: ListOut, context: TextContext): string {
  if (v.call_result === 'error') return errorText(v);
  const index = v.index ?? v.packs;
  const lines = [`可用的工作流和技能共 ${index.length} 个。`, ...index.map(pack => pack.title)];
  for (const observation of v.context?.observations ?? []) {
    lines.push(`测试环境 ${observation.label}，${observation.build === null ? '构建未知' : `构建 ${observation.build}`}；读取时间 ${localMinute(observation.observed_at)}`);
  }
  if (context.packList?.contextUnread) lines.push('测试环境的资料尚未读出；状态未知；原因缺资料；下一步由使用者请管理员核对读取权限。');
  for (const pack of v.packs) {
    lines.push(`${pack.title}，${pack.description}`);
    if (pack.products.length) lines.push(`产品 ${pack.products.join('、')}`);
    lines.push(...pack.inputs.map(input => `${input.description}，${required(input.required)}`));
    lines.push(...pack.parameters.map(parameter => `${parameter.description}，${required(parameter.required)}`));
    if (pack.local_tools) lines.push(`已提供 ${pack.local_tools.count} 个本地工具。`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------- upload_file

function uploadText(v: UploadOut): string {
  if (v.call_result === 'error') return errorText(v);
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

function caseName(item: ItemProjection | undefined, label: string): string {
  if (item && isRecord(item.fields.review_counts)) return label;
  const id = item?.fields.autoid;
  return `原始用例 ${typeof id === 'string' || typeof id === 'number' ? `${id} ` : ''}${label}`;
}

function itemConclusion(item: ItemResult, original: ItemProjection | undefined): string {
  const pending = item.requirements.some(requirement => requirement.status === 'pending' || requirement.unsatisfied_reason === 'independence_unknown');
  const wrong = item.requirements.filter(requirement => requirement.status === 'unsatisfied' && requirement.unsatisfied_reason === 'outcome_mismatch');
  const claims = item.requirements.flatMap(requirement => requirement.claims);
  const model = claims.some(claim => claim.qualifier.nature === 'judgment' || claim.warrant.producer === 'model');
  const partial = claims.some(claim => claim.qualifier.coverage?.complete === false || claim.qualifier.marks.includes('partial'));
  const unknown = partial || pending || item.requirements.length === 0 || claims.some(claim => claim.qualifier.nature === 'unknown' || claim.validity.status !== 'valid' || claim.statement.verdict === 'unknown' || claim.statement.verdict === 'abstain') || item.requirements.some(requirement => requirement.layers.some(layer => isUnknownTerminal(layer) || layer.terminal === 'incomplete'));
  const status = unknown ? '未知' : model ? '未确认' : '已确认';
  const judgment = wrong.length ? '错误' : unknown ? null : '正确';
  const statement = wrong.length ? wrong.map(requirement => messageOf(requirement)).filter(Boolean).join('；') || '核对发现错误' : unknown ? '还没有确认结论' : claims.map(claim => claim.statement.text).join('；') || '已按要求核对';
  const parts = [`${caseName(original, item.label)}，${statement}`, `状态${status}`];
  if (judgment !== null) parts.push(`判断${judgment}`);
  if (unknown || judgment === '错误') {
    const problems = item.requirements.filter(requirement => requirement.status !== 'satisfied' || requirement.layers.some(layer => isUnknownTerminal(layer) || layer.terminal === 'incomplete'));
    const layers = problems.flatMap(requirement => requirement.layers.filter(layer => layer.terminal !== 'pass' && layer.terminal !== 'judgment'));
    parts.push(`原因${partial ? '缺资料' : [...new Set(layers.map(userReason))].join('、') || '还没查清'}`);
    parts.push(`下一步${partial ? '使用者补齐资料后重新交给 Hub 检查' : [...new Set(layers.map(userNextStep))].join('；') || '使用者核对资料后重新交给 Hub 检查'}`);
  }
  const quotes = claims.flatMap(claim => claim.resolutions?.map(value => value.text) ?? []);
  if (quotes.length) parts.push(`证据${quotes.join('；')}`);
  if (item.replaced_criteria?.length) parts.push(...item.replaced_criteria.map(change => `原始用例的要求由${change.old}改为${change.new}`));
  parts.push(`决定者${[...new Set(claims.map(claim => USER_DECIDER[claim.warrant.producer]))].join('、') || '程序'}`);
  return parts.join('；');
}

function resultConclusions(result: ValidationResult, originals: readonly ItemProjection[] = []): string[] {
  const items = new Map(originals.map(item => [item.id, item]));
  return itemsOf(result.partitions).map(({ item }) => itemConclusion(item, items.get(item.item)));
}

function startText(v: StartOut, context: TextContext): string {
  if (v.call_result === 'error' || v.run === undefined) return errorText(v);
  const run = v.run;
  const lines = [run.build === undefined ? '已读入原始用例。' : `已读入原始用例，手册和命令树采用构建 ${run.build}。`];
  if (context.production !== undefined && context.production !== null) lines.push(...resultConclusions(context.production, run.items), ...context.production.cross_item.map(claimLine));
  else lines.push(...run.items.map(item => `${caseName(item, item.label)}，${itemSummary(item)}；状态未知；原因缺资料；下一步由模型按说明核对原始用例；决定者程序`));
  for (const source of run.sources) if (source.coverage?.complete === false) lines.push('原始用例或资料尚未读全；状态未知；原因缺资料；下一步由使用者补齐资料。');
  for (const gap of context.unavailable ?? []) lines.push(`状态未知；原因缺资料；下一步由使用者提供可读取的${gap.role === 'subject' ? '原始用例' : '资料'}。`);
  for (const gap of context.gaps ?? []) lines.push(`状态未知；原因缺资料；${gap.message}；下一步由使用者补齐资料。`);
  for (const change of run.criterion_changes ?? []) {
    const item = run.items.find(item => item.id === change.item);
    const state = change.superseded_by ? '已有新的修改意见' : change.accepted === true ? '修改意见已确认' : change.accepted === false ? `修改意见未确认，${change.reason}` : change.expired ? '修改意见已过期' : '修改意见尚未确认';
    lines.push(`${caseName(item, item?.label ?? '')}，${change.assertion}；${state}；状态${change.accepted === true ? '已确认' : '未确认'}；下一步${change.next_action}；决定者使用者`);
  }
  for (const observation of run.device_observations ?? []) {
    const data = observation.statement.data;
    if (typeof data?.label === 'string') {
      const text = `测试环境 ${data.label}，${typeof data.build === 'string' ? `构建 ${data.build}` : '构建未知'}${observation.qualifier.collected_at ? `，读取时间 ${localMinute(observation.qualifier.collected_at)}` : ''}`;
      lines.push(claimLine({ ...observation, statement: { ...observation.statement, text } }));
    } else lines.push(claimLine(observation));
  }
  for (const claim of run.device_help ?? []) {
    lines.push(claimLine(claim));
    const words = claim.statement.data?.help;
    if (typeof words === 'string') lines.push('设备输出', ...words.split(/\r\n|\r|\n/).map(visibly));
  }
  if (run.instructions) lines.push('核对说明', run.instructions);
  return lines.join('\n');
}

/** A node: its line, all its entries (the definitions to cite), its children and the related references the service gave. */
function nodeEntry(node: KnowledgeNode, _root: string): Entry {
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
      lines.push('原文不可读取；状态未知；原因缺资料；下一步由使用者请管理员核对读取权限。');
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

function nodesText(v: NodesOut, context: TextContext): string {
  if (v.call_result === 'error') return errorText(v);
  if (v.memory_document) return `${v.memory_document.title}\n${v.memory_document.markdown}`;
  if (v.memory_page) return v.memory_page.items.map(document => document.title).join('\n');
  if (v.matches !== undefined) return [`找到 ${v.matches.length} 份相关资料，仅作参考。`, ...v.matches.map(hit => hit.statement), ...(v.warnings ?? []).map(warning => `${warning.message}；下一步${warning.fix ?? '使用者核对资料'}`)].join('\n');
  if (v.call_status) {
    const status = v.call_status;
    return [`正在处理 ${status.active_total} 次，已结束 ${status.completed.length} 次。`, ...(status.active.map(call => `开始时间 ${localMinute(call.started_at)}`)), ...(status.missing ? [`状态未知；原因缺资料；${status.missing}`] : []), `下一步${status.next_action}`].join('\n');
  }
  if (v.content !== undefined) return contentText(v.content, v.trace, context);
  const nodes = v.nodes ?? [];
  return ['手册和命令树', ...nodes.flatMap(node => entryLines(nodeEntry(node, v.root ?? ''))), ...(v.next ? ['还有资料未列出，请继续读取。'] : [])].join('\n');
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
    const next = c.read_tier === 'retain_only' ? '请管理员核看原文为何只保留；误报经管理员接受后重新读取；含真凭据或按策略只保留的不会放行' : '由使用者请管理员核对读取权限';
    return `${c.note ? `${c.note}；` : ''}原文尚未读出；状态未知；原因缺资料；下一步${next}。`;
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

function resolveText(v: ResolveOut): string {
  if (v.call_result === 'error' || v.resolution === undefined) return errorText(v);
  const state = v.resolution === 'resolved' ? '已确认' : '未知';
  const lines = [`原句核对状态${state}。`, ...v.references.map(reference => reference.text)];
  if (state === '未知') lines.push('原因还没查清；下一步由使用者给出更完整的原句。');
  return lines.join('\n');
}

// ---------------------------------------------------------------- submit_result

function submitText(v: SubmitOut, context: TextContext): string {
  const lines = [v.acceptance === 'accepted' ? '脚本合并已核对。' : '脚本合并有错误。'];
  if (v.result !== undefined) {
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
  if (v.dispatch?.length) lines.push(v.dispatch.some(note => note.result !== undefined) ? '设备输出已取回；状态未知；原因还没查清；下一步由模型核对设备输出。' : '上机验证还没有结论；状态未知；原因还没查清；下一步由使用者继续读取设备输出。');
  for (const error of v.errors) {
    const original = context.items?.find(item => item.id === error.item);
    const missingRecord = error.code === 'SOURCE_RETRYABLE' && error.path === '/result';
    const message = missingRecord ? '核对结果的读取资料尚未取回' : error.message;
    const fix = missingRecord ? '由使用者请管理员核对保存的结果后重新读取' : error.fix;
    const parts = [original === undefined ? message : `${caseName(original, original.label)}，${message}`, ...(sourceUnknown(error) ? ['状态未知', '原因缺资料'] : ['状态已确认', '判断错误', '原因还没查清'])];
    if (fix) parts.push(`下一步${fix}`);
    if (error.rounds_left !== undefined) parts.push(`最多重交 ${error.rounds_left} 次`);
    parts.push('决定者程序');
    lines.push(parts.join('；'));
  }
  return lines.join('\n');
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

export function feedingText(text: string, value: unknown): string {
  const pending = recordsOf(value).feeding_pending;
  if (!Array.isArray(pending)) return text;
  const rows = [...new Set(pending.map(entry => {
    const row = recordsOf(entry);
    return `状态未知；原因缺资料；${String(row.missing)}；下一步${String(row.next_action)}`;
  }))];
  return [text, ...rows].join('\n');
}

/** User-facing text; identifiers remain in structuredContent. */
export function toolText(tool: string, value: unknown, context: TextContext = {}): string {
  const render = RENDERERS[tool] as ((value: unknown, context: TextContext) => string) | undefined;
  if (render === undefined) throw new Error(`no text renderer for ${tool}`);
  return render(value, context);
}

/** A readable failure when a validated answer cannot be rendered. */
export function fallbackText(_tool: string, _value: unknown, _context: TextContext = {}): string {
  return '答复正文未能显示；状态未知；原因临时故障；下一步由使用者查看机器可读答复，或请管理员检查。';
}

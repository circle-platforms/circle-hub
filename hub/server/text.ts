import { isAbandonedResult } from '../runs/api.ts';
import { isCallResult, isAcceptance } from '../../contracts/generated/vocabulary.ts';
// The Chinese plain text of every tool answer (D05 R[0], R[1], R[6]; display rules 0, 4-7 and 11): the only content block,
// and the only part of a tool result the real Circle client hands to the model (structuredContent never reaches it). Every
// text is laid out within TEXT_BUDGET (budget.ts): the facts a model works from come first (receipt and counts, the state of
// each requirement, every problem and unknown), long lists lose whole entries from their end, a long field keeps its start
// and says how long it was and where the whole is, and one note before the trace line names what was left out or shortened
// and exactly how to read it. A way to read is offered only in a form the server takes: page cursors only when the server
// says it pages (TextContext.paging); otherwise byte ranges and text@1 line ranges of sources, record pointers and the
// console page. structuredContent keeps the whole answer as JSON.
import { createHash } from 'node:crypto';
import { applicabilityText } from '../knowledge/api.ts';
import { ZodError, type z } from 'zod';
import { REFERENCE_FORMS } from '../../contracts/generated/protocol.ts';
import {
  CHECK_TIER,
  DYNAMIC_TERMINAL,
  LAYER,
  PARTITION,
  REFERENCE_SCHEME,
  REQUIREMENT_STATUS,
  STATIC_TERMINAL,
  UNSATISFIED_REASON,
  axisLabel,
  labelOf,
  type Layer,
  type Partition,
  type Reason,
  type SourceRole,
} from '../../contracts/generated/vocabulary.ts';
import type { Claim } from '../../contracts/src/claim.ts';
import type { ProtocolError } from '../../contracts/src/common.ts';
import { ItemProjection, type PackSummary, type RequirementSummary, type RunSummary, type SlotSchema, type SourceBinding } from '../../contracts/src/run.ts';
import { Submission } from '../../contracts/src/submission.ts';
import {
  StartRunInput,
  type GetNodesOutput,
  type ListTaskPacksOutput,
  type ResolveReferenceOutput,
  type StartRunOutput,
  type SubmitResultOutput,
  type UploadFileOutput,
} from '../../contracts/src/tools.ts';
import { PartitionCounts, StoredValidationResult, StoredPartitionItem, Partitions, ValidationResult, readStoredValidationResult, storedItemNotices, partitionCountsOf, type ItemResult, type RequirementResult } from '../../contracts/src/validation.ts';
import { ReferenceSyntaxError, UNAVAILABLE_MESSAGE, canonicalJson, parseReference, pointerTokens, recReference, srcFragment, withRange, type Reference } from '../refs/api.ts';
import { TEXT_BUDGET, fit, oneLine, softCap, type Block, type Entry, type Omission } from './budget.ts';
import { NOT_APPLICABLE, claimFields, coverageText, requirementText, statusText, terminalLabel, terminalSymbol, terminalText, type LayerTerminal } from './claims.ts';

type ListOut = z.infer<typeof ListTaskPacksOutput>;
type UploadOut = z.infer<typeof UploadFileOutput>;
type StartOut = z.infer<typeof StartRunOutput>;
type NodesOut = z.infer<typeof GetNodesOutput>;
type Content = NonNullable<NodesOut['content']>;
type KnowledgeNode = NonNullable<NodesOut['nodes']>[number];
type ResolveOut = z.infer<typeof ResolveReferenceOutput>;
type SubmitOut = z.infer<typeof SubmitResultOutput>;

/**
 * What a text may use besides the validated answer. The server passes what it knows; without it every text still fits the
 * budget and names only ways to read that work without it (sources by range, records by pointer, the console page).
 */
export interface TextContext {
  /** The server takes get_nodes {reference, cursor} and passes the cursor back here: only then are page cursors offered. */
  paging?: boolean;
  /** get_nodes with a reference: the page cursor the caller gave (made by pageCursor for an earlier page). */
  cursor?: string | null;
  /** start_run: the validation result that answer.result names (a production run), so that its problems can be listed. */
  production?: ValidationResult | null;
  /** start_run: rec:<digest> of the run record; submit_result: rec:<digest> of the stored validation result, accepted or not. */
  record?: string | null;
  /** start_run: the expected sources the run could not bind (evidence gaps). */
  unavailable?: readonly { external: string; role: SourceRole }[];
  /** start_run: what the pack's expected-sources function reported, its failure included (further evidence gaps). */
  gaps?: readonly { code: string; message: string }[];
}

// ---------------------------------------------------------------- shared lines

/** A long procedure or problem list keeps this much at its own priority; the rest yields to what follows (softCap). */
const SOFT_CAP = Math.floor(TEXT_BUDGET * 0.3);
/** Up to this many items a list whose locations follow no rule gives each item's location; a longer one is id, label and summary only (ItemProjection.summary). */
const LOCATED_ITEMS = 50;
/** The longest a field is shown inside a line; a longer one keeps its start and is marked (Clip). */
const CLIP = { name: 300, code: 200, label: 300, summary: 300, problemLabel: 80, problemMessage: 200, field: 1500, message: 1000, fix: 500, path: 1000, data: 4000, line: 3000 } as const;
type Limits = { readonly [K in keyof typeof CLIP]: number };
/** Content read by reference is the place to read things whole: no field is shortened there (long lines are paged). */
const WHOLE: Limits = Object.fromEntries(Object.keys(CLIP).map((key) => [key, Number.POSITIVE_INFINITY])) as unknown as Limits;
/** Room kept on a page of knowledge nodes for the note (it can carry a get_nodes call of child paths). */
const NODE_NOTE_ROOM = 8000;
/** The longest get_nodes call of node paths a note gives. */
const PATHS_CALL = 6000;
/** GetNodesInput.paths takes at most this many paths. */
const MAX_PATHS = 256;

/** The example reference of an upload in example calls: valid syntax, plainly not a real digest. */
const EXAMPLE_SOURCE = `src:${'0'.repeat(64)}`;
const MODEL_PLACEHOLDER = '<模型名与配置>';
/** An input slot that takes an external object type, written system:type (the rule of hub/server/tools.ts isExternalType). */
const EXTERNAL_TYPE = /^[a-z][a-z0-9-]*:[a-z][a-z0-9_-]*$/;
const SEPARATOR = ' | ';

/** Where a person reads everything about a run: the console's run page, the authoritative view (display rule 17). */
const seeConsole = (run: string): string => `在控制台运行页 /console/runs/${run} 查看`;
const RUNS_PAGE = '在控制台运行页 /console/runs 查看';
const callText = (tool: string, args: Record<string, unknown>): string => `${tool} ${JSON.stringify(args)}`;
const readCall = (reference: string): string => callText('get_nodes', { reference });
const required = (yes: boolean): string => (yes ? '必填' : '可选');
const traceLine = (trace: string): string => `追踪 ${trace}`;
/** How to read a field shortened with a 全文 marker. */
const WHOLE_MORE = '读全文：用 get_nodes 读各处“全文”后面的引用';
const NUMBER = /^(0|[1-9][0-9]*)$/;

const sizeOf = (lines: readonly string[]): number => lines.reduce((sum, line) => sum + line.length + 1, 0);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
const recordsOf = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});
const stringsOf = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);

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

export function errorLine(e: ProtocolError): string {
  const parts = [`- ${e.code}：${oneLine(e.message)}`];
  if (e.fix) parts.push(`修正：${oneLine(e.fix)}`);
  if (e.path !== undefined) parts.push(`位置 ${e.path === '' ? '（整份）' : oneLine(e.path)}`);
  if (e.item !== undefined) parts.push(`条目 ${oneLine(e.item)}`);
  if (e.requirement !== undefined) parts.push(`要求项 ${oneLine(e.requirement)}`);
  if (e.rounds_left !== undefined) parts.push(`剩余修复轮数 ${e.rounds_left}`);
  if (e.options !== undefined && e.options.length > 0) parts.push(`可选：${e.options.map(oneLine).join('、')}`);
  return parts.join('；');
}

/** One claim on one line: its fields in DISPLAY_ORDER, as label：text. */
export function claimLine(claim: Claim): string {
  return claimFields(claim)
    .map(([label, text]) => `${label}：${oneLine(text)}`)
    .join('；');
}

/** A claim on one line with every field at most `max` characters. */
function claimText(claim: Claim, clip: Clip, max: number): string {
  return claimFields(claim)
    .map(([label, text]) => `${label}：${clip.field(text, max, `主张${label}的超出部分`)}`)
    .join('；');
}

/** The reasons of the items a partition holds with a reason (held back, incomplete), counted in order of first use: （模型声明跳过 47，提交未覆盖 3）; nothing when none carries one. */
function reasonCounts(items: readonly ItemResult[] | undefined): string {
  const counted = new Map<Reason, number>();
  for (const item of items ?? []) if ('reason' in item) counted.set(item.reason, (counted.get(item.reason) ?? 0) + 1);
  return counted.size === 0 ? '' : `（${[...counted].map(([reason, n]) => `${labelOf('reason', reason)} ${n}`).join('，')}）`;
}

/** Items per partition (a declared skip is told apart from an item the submission did not cover) and the items with an unknown terminal (V03 R[4]); unknown is never an error. */
export function countsText(counts: PartitionCounts, partitions?: Partitions): string {
  const shown = PARTITION.map((p) => `${labelOf('partition', p)} ${counts[p]}${reasonCounts(partitions?.[p])}`).join('，');
  return `${axisLabel('partition')}：${shown}；${labelOf('nature', 'unknown')} ${counts.unknown}${counts.pending_unknown ? `；其中 ${counts.pending_unknown} 个还有未决未知` : ''}`;
}

/** The partition counts line: receipt, items per partition and the items with an unknown terminal. */
export function countsLine(acceptance: SubmitOut['acceptance'], partitions: Partitions | undefined): string {
  const receipt = `${axisLabel('acceptance')}：${labelOf('acceptance', acceptance)}`;
  if (partitions === undefined) return `${receipt}；没有分区（未受理的提交不分区）`;
  return `${receipt}；${countsText(partitionCountsOf(partitions), partitions)}`;
}

// ---------------------------------------------------------------- errors

interface ErrorList {
  /** With `shared`: the count of errors, then a line per code with its count and the fix all its errors share (said once). */
  summary: { head: string; entries: Entry[] } | null;
  /** One line per error; a fix the code's summary line gives is not repeated. */
  entries: Entry[];
}

/**
 * Errors as answers show them: with `shared`, a count line per code with the fix all its errors share first; then one line
 * per error (message, fix unless shared, path, item, requirement, rounds left, options). `whole(i)` names where error i is
 * whole (a record pointer), or null.
 */
function errorList(errors: readonly ProtocolError[], limits: Limits, shared: boolean, whole: (i: number) => string | null = () => null, more: string | null = null): ErrorList {
  const byCode = new Map<string, { count: number; fixes: Set<string | undefined> }>();
  for (const e of errors) {
    const group = byCode.get(e.code) ?? { count: 0, fixes: new Set<string | undefined>() };
    group.count++;
    group.fixes.add(e.fix);
    byCode.set(e.code, group);
  }
  const fixOf = new Map<string, string>();
  let summary: ErrorList['summary'] = null;
  if (shared) {
    const codes: Entry[] = [];
    for (const [code, group] of byCode) {
      const fixes = [...group.fixes];
      const fix = fixes.length === 1 && fixes[0] !== undefined && fixes[0] !== '' ? fixes[0] : null;
      if (fix !== null) fixOf.set(code, fix);
      const clip = new Clip(null, more);
      codes.push(clip.entry(`  ${clip.field(code, limits.code, '错误代码的超出部分')} ${group.count} 个；${fix !== null ? `修正：${clip.field(fix, limits.fix, '修正说明的超出部分')}` : '修正见每条'}`));
    }
    summary = { head: `错误 ${errors.length} 个，按代码：`, entries: codes };
  }
  const entries = errors.map((e, i) => {
    const clip = new Clip(whole(i), more);
    const parts = [`- ${clip.field(e.code, limits.code, '错误代码的超出部分')}：${clip.field(e.message, limits.message, '错误说明的超出部分')}`];
    if (e.fix && fixOf.get(e.code) !== e.fix) parts.push(`修正：${clip.field(e.fix, limits.fix, '修正说明的超出部分')}`);
    if (e.path !== undefined) parts.push(`位置 ${e.path === '' ? '（整份）' : clip.field(e.path, limits.path, '错误位置的超出部分')}`);
    if (e.item !== undefined) parts.push(`条目 ${oneLine(e.item)}`);
    if (e.requirement !== undefined) parts.push(`要求项 ${clip.field(e.requirement, limits.code, '要求项名的超出部分')}`);
    if (e.rounds_left !== undefined) parts.push(`剩余修复轮数 ${e.rounds_left}`);
    if (e.options !== undefined && e.options.length > 0) {
      const shown = e.options.slice(0, 20).map((o) => clip.field(o, limits.code, '可选项的超出部分'));
      parts.push(`可选：${shown.join('、')}${e.options.length > 20 ? ` 等 ${e.options.length} 个` : ''}`);
    }
    return clip.entry(parts.join('；'));
  });
  return { summary, entries };
}

const fixFirst = (): string => '改正上面列出的问题后再调用，其余问题会在下一次回答里列出';

/** The answer of a protocol error: the codes, every error with its fix, the trace. */
function errorText(v: { errors: ProtocolError[]; trace: string }): string {
  const codes = new Clip();
  const head = codes.field(`${labelOf('call_result', 'error')}：${[...new Set(v.errors.map((e) => e.code))].join('、')}`, CLIP.line, '错误代码的超出部分');
  const list = errorList(v.errors, CLIP, false);
  return fit(
    [
      { priority: 0, head: [head], omitted: codes.omitted },
      { priority: 1, head: ['错误与修正：'], entries: list.entries, unit: '错误', measure: '个', more: fixFirst },
    ],
    { tail: [traceLine(v.trace)] },
  ).text;
}

/** A value of a structure summary or of entry data on one line: scalars as they are, anything else as compact JSON. */
function valueText(value: unknown): string {
  if (typeof value === 'string') return oneLine(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return String(value);
  return JSON.stringify(value) ?? '';
}

/** The parser that recognised the bytes and its structure summary (counts and shape, never text), one field a line. */
function structureLines(structure: Record<string, unknown>, more: string | null): { head: string[]; entries: Entry[] } {
  const { parser, summary, ...rest } = structure;
  const fields = isRecord(summary) ? summary : summary === undefined ? {} : { summary };
  const entries = Object.entries({ ...fields, ...rest }).map(([key, value]) => {
    const clip = new Clip(null, more);
    return clip.entry(`  ${clip.field(key, CLIP.name, '结构摘要字段名的超出部分')} ${clip.field(valueText(value), CLIP.line, '结构摘要取值的超出部分')}`);
  });
  const head = typeof parser === 'string' ? [`解析器 ${oneLine(parser)} 认出了这份文件`] : [];
  head.push(entries.length > 0 ? '结构摘要：' : '结构摘要：（空）');
  return { head, entries };
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
  const call = { pack: pack.pack, ...product, inputs, ...(Object.keys(parameters).length > 0 ? { parameters } : {}) };
  return JSON.stringify(StartRunInput.safeParse(call).success ? call : { pack: pack.pack, inputs: {} });
}

/** The facts of a requirement: id and name, kind (accepted producer), layers, done rule, repair rounds. */
function requirementFacts(q: RequirementSummary, clip: Clip): string {
  const declared = q.layers.map((l) => labelOf('layer', l)).join('、');
  const undeclared = LAYER.filter((l) => !q.layers.includes(l)).map((l) => `${labelOf('layer', l)}：${NOT_APPLICABLE}`);
  return [
    `${clip.field(q.key, CLIP.code, '要求项键的超出部分')} ${clip.field(q.name, CLIP.name, '要求项名称的超出部分')}：${axisLabel('accepted_producer')} ${labelOf('accepted_producer', q.accepted_producer)}`,
    `${axisLabel('layer')} ${declared}${undeclared.length > 0 ? `（${undeclared.join('；')}）` : ''}`,
    labelOf('done_rule', q.done_rule),
    `修复轮数 ${q.repair_rounds}`,
    `规则 ${q.rules.length ? q.rules.join('、') : '无'}`,
    `运行内表的已裁定解释器 ${q.run_interpreters.length ? q.run_interpreters.join('、') : '无'}`,
  ].join('；');
}

/** A pack as one entry: its line, products, inputs, parameters, the example call and its requirements. */
function packEntry(p: PackSummary): Entry {
  const clip = new Clip(null, '在控制台任务包页 /console/packs 查看');
  const lines: string[] = [`- ${clip.field(p.pack, CLIP.name, '任务包编号的超出部分')} ${clip.field(p.title, CLIP.name, '任务包标题的超出部分')}（${labelOf('pack_kind', p.kind)}）：${clip.field(p.description, CLIP.message, '任务包说明的超出部分')}`];
  if (p.products.length > 0) lines.push(`  产品：${p.products.map((name) => clip.field(name, CLIP.name, '产品名的超出部分')).join('、')}`);
  for (const input of p.inputs) {
    const shapes = [...new Set(input.accepts.map((a) => JSON.stringify(bindingExample(a))))].join(' 或 ');
    lines.push(
      `  输入 ${clip.field(input.slot, CLIP.code, '输入槽名的超出部分')}（${labelOf('source_role', input.role)}，${required(input.required)}${input.many ? '，可多个' : ''}）：${clip.field(input.description, CLIP.message, '输入说明的超出部分')}；接受 ${clip.field(input.accepts.join('、'), CLIP.line, '接受类型的超出部分')}；写法 ${clip.field(shapes, CLIP.line, '输入写法的超出部分')}`,
    );
  }
  for (const parameter of p.parameters) lines.push(`  参数 ${clip.field(parameter.name, CLIP.code, '参数名的超出部分')}（${required(parameter.required)}）：${clip.field(parameter.description, CLIP.message, '参数说明的超出部分')}${parameter.schema !== undefined ? `；模式 ${clip.field(JSON.stringify(parameter.schema), CLIP.line, '参数模式的超出部分')}` : ''}`);
  lines.push(`  示例 start_run：${startRunExample(p)}`);
  for (const r of p.requirements) lines.push(`  要求项 ${requirementFacts(r, clip)}`);
  return clip.entry(lines);
}

function listText(v: ListOut): string {
  if (v.call_result === 'error') return errorText(v);
  const head = [`可用的任务包 ${v.packs.length} 个`];
  if (v.packs.some((p) => p.inputs.length > 0 || p.parameters.length > 0)) {
    const product = v.packs.some((p) => p.products.length > 0) ? '；product 换成被判对象所属产品线的名字（“产品”里列出的任一个）' : '';
    head.push(`示例 start_run 里的 ${EXAMPLE_SOURCE.slice(0, 8)}… 换成 upload_file 返回的引用，尖括号里的占位换成真实的编号或取值${product}`);
  }
  const packs: Block = { priority: 1, entries: v.packs.map(packEntry), unit: '任务包', measure: '个', more: () => '任务包：在控制台任务包页 /console/packs 查看' };
  return fit([{ priority: 0, head }, packs], { tail: [traceLine(v.trace)] }).text;
}

// ---------------------------------------------------------------- upload_file

function uploadText(v: UploadOut): string {
  const head = [`${axisLabel('acceptance')}：${labelOf('acceptance', v.acceptance)}${v.reference ? `，引用 ${v.reference}` : ''}`];
  if (v.size !== undefined) head.push(`大小 ${v.size} 字节${v.media_type ? `，媒体类型 ${oneLine(v.media_type)}` : ''}`);
  if (v.sha256 !== undefined) head.push(`sha256 ${v.sha256}`);
  const blocks: Block[] = [{ priority: 0, head }];
  if (v.errors.length > 0) blocks.push({ priority: 1, head: ['错误与修正：'], entries: errorList(v.errors, CLIP, false).entries, unit: '错误', measure: '个', more: fixFirst });
  if (v.acceptance === 'accepted') {
    if (v.structure === undefined) blocks.push({ priority: 1, head: ['没有核心解析器认出这份文件'] });
    else {
      const read = v.reference === undefined ? null : `读原文：${readCall(v.reference)}`;
      const structure = structureLines(v.structure, read);
      blocks.push({ priority: 2, head: structure.head, entries: structure.entries, unit: '结构摘要', measure: '行', more: () => read });
    }
  }
  return fit(blocks, { tail: [traceLine(v.trace)] }).text;
}

// ---------------------------------------------------------------- items of a run

/** How every item's location follows from its id, said once instead of per line (no per-item location column). */
interface LocationRule {
  prefix: string;
  /** How the id completes the prefix; '' when every item has the prefix itself as its location. */
  said: string;
}

const DERIVATIONS: readonly { said: string; colon: boolean; part: (id: string) => string }[] = [
  { said: '加上条目编号', colon: false, part: (id) => id },
  { said: '加上编号里第一个冒号后面的部分', colon: true, part: (id) => id.slice(id.indexOf(':') + 1) },
  { said: '加上编号里最后一个冒号后面的部分', colon: true, part: (id) => id.slice(id.lastIndexOf(':') + 1) },
];

/** The rule location = one common prefix + (a part of) the id, when one holds for every item of a list of at least two. */
function locationRule(items: readonly Pick<ItemProjection, 'id' | 'location'>[]): LocationRule | null {
  if (items.length < 2) return null;
  if (items.every((item) => item.location === items[0].location)) return { prefix: items[0].location, said: '' };
  for (const d of DERIVATIONS) {
    let prefix: string | null = null;
    let holds = true;
    for (const item of items) {
      const tail = d.part(item.id);
      if ((d.colon && !item.id.includes(':')) || tail === '' || !item.location.endsWith(tail)) {
        holds = false;
        break;
      }
      const own = item.location.slice(0, item.location.length - tail.length);
      if (prefix === null) prefix = own;
      else if (own !== prefix) {
        holds = false;
        break;
      }
    }
    if (holds && prefix !== null && prefix !== '') return { prefix, said: d.said };
  }
  return null;
}

/**
 * Each item on one line: id | label | summary (and the carry-over offer). Where the items are: one rule for all when the
 * locations follow the ids; else each item's location for a short list, and where to read them for a long one.
 * `record` is the run record (rec:<digest>), whose items the long fields point at.
 */
function itemLines(items: readonly ItemProjection[], record: string | null, run: string | null): { head: string[]; entries: Entry[] } {
  const rule = locationRule(items);
  const located = rule === null && items.length <= LOCATED_ITEMS;
  const entries = items.map((item, i) => {
    const clip = new Clip(record === null ? null : `${record}#/items/${i}`, record === null ? (run === null ? RUNS_PAGE : seeConsole(run)) : null);
    const columns = [oneLine(item.id), clip.field(item.label, CLIP.label, '条目名称的超出部分')];
    if (item.summary !== undefined && item.summary !== '') columns.push(clip.field(item.summary, CLIP.summary, '条目摘要的超出部分'));
    if (located) columns.push(`位置 ${item.location}`);
    if (item.reuse !== undefined) columns.push(`可沿用 ${item.reuse}`);
    return clip.entry(`- ${columns.join(SEPARATOR)}`);
  });
  const head = [`条目（${items.length} 个；编号${SEPARATOR}名称${SEPARATOR}摘要${located ? `${SEPARATOR}位置` : ''}）：`];
  if (rule !== null && rule.said === '') head.push(`位置：每个条目的位置都是 ${rule.prefix}`);
  else if (rule !== null) head.push(`位置：每个条目的位置是 ${rule.prefix} ${rule.said}，例如 ${items[0].id} 的位置是 ${items[0].location}`);
  else if (!located && items.length > 0) {
    head.push(`位置：${record !== null ? `用 ${readCall(`${record}#/items/0/location`)} 读，把 0 换成条目在这个列表里的序号（从 0 起）` : run !== null ? seeConsole(run) : RUNS_PAGE}`);
  }
  return { head, entries };
}

// ---------------------------------------------------------------- slot schema, compact

/** A JSON Schema written short: enum values, const, [items], {field, field?}; descriptions and patterns left out. */
function typeSig(schema: unknown, depth = 0): string {
  if (schema === true) return 'any';
  if (!isRecord(schema)) return 'never';
  if (depth > 4) return '…';
  if (Object.hasOwn(schema, 'const')) return JSON.stringify(schema.const) ?? 'null';
  if (Array.isArray(schema.enum)) return schema.enum.map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join('|');
  const type = schema.type;
  if (type === 'array') return `[${typeSig(schema.items, depth + 1)}]`;
  if (type === 'object' || isRecord(schema.properties)) {
    const fields = recordsOf(schema.properties);
    const must = new Set(stringsOf(schema.required));
    const parts = Object.entries(fields).map(([name, sub]) => `${name}${must.has(name) ? '' : '?'}: ${typeSig(sub, depth + 1)}`);
    return parts.length === 0 ? 'object' : `{${parts.join(', ')}}`;
  }
  for (const key of ['anyOf', 'oneOf'] as const) {
    if (Array.isArray(schema[key])) return (schema[key] as unknown[]).map((s) => typeSig(s, depth + 1)).join(' 或 ');
  }
  if (Array.isArray(schema.allOf)) return (schema.allOf as unknown[]).map((s) => typeSig(s, depth + 1)).join(' 且 ');
  if (typeof type === 'string') return type;
  if (Array.isArray(type)) return type.join('|');
  return 'any';
}

/** One field of a statement: name, 必填, its short type and its description (an enum's description lists its codes). */
function fieldText(name: string, schema: unknown, mandatory: boolean): string {
  const s = recordsOf(schema);
  const items = recordsOf(s.items);
  const description = typeof s.description === 'string' ? s.description : typeof items.description === 'string' ? items.description : null;
  const label = `${name}${mandatory ? '（必填）' : ''}`;
  if (Array.isArray(s.enum) && description !== null) return `${label}: ${oneLine(description)}`;
  return `${label}: ${typeSig(schema)}${description !== null ? `（${oneLine(description)}）` : ''}`;
}

/** Alternatives of required fields (an anyOf of `required` lists), said as 至少给出 a、b 之一. */
function alternativesText(schema: Record<string, unknown>): string | null {
  if (!Array.isArray(schema.anyOf)) return null;
  const names = schema.anyOf.flatMap((alternative) => stringsOf(recordsOf(alternative).required));
  return names.length > 0 ? `至少给出 ${names.join('、')} 之一` : null;
}

/** A slot key or a cross-item definition: its description, the list bounds and each statement field. */
function slotText(schema: unknown): string {
  const s = recordsOf(schema);
  const parts: string[] = [];
  if (typeof s.description === 'string') parts.push(oneLine(s.description));
  const statement = s.type === 'array' ? recordsOf(s.items) : s;
  if (s.type === 'array') {
    const bounds = [typeof s.minItems === 'number' ? `至少 ${s.minItems} 条` : null, typeof s.maxItems === 'number' ? `最多 ${s.maxItems} 条` : null].filter(Boolean);
    parts.push(`陈述的列表${bounds.length > 0 ? `（${bounds.join('，')}）` : ''}`);
  }
  const must = new Set(stringsOf(statement.required));
  const fields = Object.entries(recordsOf(statement.properties)).map(([name, sub]) => fieldText(name, sub, must.has(name)));
  if (fields.length > 0) parts.push(`每条：${fields.join('；')}`);
  const alternatives = alternativesText(statement);
  if (alternatives !== null) parts.push(alternatives);
  if (parts.length === 0) parts.push(typeSig(schema));
  return parts.join('；');
}

/** The slot schema of a run, compact: one line per slot key and per cross-item definition (its sha256 names the full one). */
function slotSchemaLines(slots: SlotSchema, more: string | null): { head: string[]; entries: Entry[] } {
  const schema = slots.schema;
  const must = new Set(stringsOf(schema.required));
  const lines: string[] = [];
  for (const [key, sub] of Object.entries(recordsOf(schema.properties))) lines.push(`- ${key}${must.has(key) ? '' : '（可不填）'}：${slotText(sub)}`);
  for (const [key, sub] of Object.entries(recordsOf(schema.$defs))) lines.push(`- cross_item ${key}：${slotText(sub)}；其余字段按 submit_result 的 cross_item`);
  if (lines.length === 0) lines.push(`- ${typeSig(schema)}（没有声明键）`);
  const head = [
    `槽位模式（sha256 ${slots.sha256}）：每个已处理的条目给一条 slots，每个键一个陈述列表，没有要报告的写空列表 []`,
    `引用写法：${REFERENCE_SCHEME.map((s) => REFERENCE_FORMS[s]).join('；')}`,
  ];
  const entries = lines.map((line) => {
    const clip = new Clip(null, more);
    return clip.entry(clip.field(line, CLIP.line, '槽位模式行的超出部分'));
  });
  return { head, entries };
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
  if (isProductionRun(run)) {
    const commentary = (grounds: string[]) => ({ run: run.run, model: MODEL_PLACEHOLDER, items: [], cross_item: [{ nature: 'judgment', statement: '<你的评论>', grounds }] });
    const grounded = commentary(run.items.length > 0 ? [run.items[0].location] : []);
    return JSON.stringify(Submission.safeParse(grounded).success ? grounded : commentary([]));
  }
  const keys = slotKeys(run.slots);
  const items = run.items.slice(0, 2).map((item) => ({ item: item.id, handling: 'handled', slots: Object.fromEntries(keys.map((key) => [key, []])) }));
  const example = { run: run.run, model: MODEL_PLACEHOLDER, items, ...(crossKeys(run.slots).length > 0 ? { cross_item: [] } : {}) };
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

/** Why an item is in its partition: the code of a rejected item, the reason of a held or incomplete one. */
function partitionWhy(item: ItemResult, clip: Clip): string {
  if ('code' in item) return `（${clip.field(item.code, CLIP.code, '拒收代码的超出部分')}）`;
  if ('reason' in item) return `（${labelOf('reason', item.reason)}）`;
  return '';
}

/** A requirement result that needs attention: not satisfied, or a layer whose terminal is not pass or judgment. */
const needsAttention = (r: RequirementResult): boolean => r.status !== 'satisfied' || r.layers.some((l) => l.terminal !== 'pass' && l.terminal !== 'judgment');

/** The message of a requirement's problem: the statement of the claim with the layer's code, else of its first claim. */
function messageOf(r: RequirementResult): string | null {
  const code = r.layers.find((l) => l.code !== undefined)?.code;
  const claim = r.claims.find((c) => code !== undefined && c.statement.code === code) ?? r.claims[0];
  return claim === undefined ? null : claim.statement.text;
}

interface ProblemLine {
  entry: Entry;
  /** JSON Pointer tokens of the item in the result. */
  tokens: string[];
  item: string;
}

const PROBLEMS_HEAD = `条目${SEPARATOR}名称${SEPARATOR}分区${SEPARATOR}要求项${SEPARATOR}终态${SEPARATOR}满足状态${SEPARATOR}说明`;

/**
 * Everything of a result that needs attention, one line per (item, requirement): every requirement that is not satisfied
 * or has a terminal other than pass or judgment (violations satisfied as expected included, with their status), and every
 * item that was not delivered (alone on its line when none of its requirements needs attention). `record` is the result
 * (rec:<digest>) whose items hold the whole label and message.
 */
function problemLines(result: ValidationResult, record: string | null, more: string | null): ProblemLine[] {
  const lines: ProblemLine[] = [];
  const digest = record === null ? null : recordOf(record);
  for (const { partition, index, item } of itemsOf(result.partitions)) {
    const tokens = ['partitions', partition, String(index)];
    const whole = digest === null ? null : recReference(digest, tokens);
    const problems = item.requirements.filter(needsAttention);
    const base = (clip: Clip): string[] => [oneLine(item.item), clip.field(item.label, CLIP.problemLabel, '条目名称的超出部分'), `${labelOf('partition', partition)}${partitionWhy(item, clip)}`];
    if (problems.length === 0) {
      if (partition === 'delivered') continue;
      const clip = new Clip(whole, more);
      lines.push({ entry: clip.entry(`- ${base(clip).join(SEPARATOR)}`), tokens, item: item.item });
      continue;
    }
    for (const r of problems) {
      const clip = new Clip(whole, more);
      const shown = r.layers.filter((l) => l.terminal !== 'pass' && l.terminal !== 'judgment');
      const terminals = (shown.length > 0 ? shown : r.layers).map(terminalText).join('；');
      const columns = [...base(clip), clip.field(r.requirement, CLIP.code, '要求项键的超出部分'), terminals === '' ? '—' : terminals, statusText(r)];
      const notices=storedItemNotices({requirements:[r]});
      if(notices.length)columns.push(clip.field(notices.map(n=>n.message).join('、'),CLIP.problemMessage,'历史记录缺失提示的超出部分'));
      const message = messageOf(r);
      if (message !== null) columns.push(clip.field(message, CLIP.problemMessage, '问题说明的超出部分'));
      lines.push({ entry: clip.entry(`- ${columns.join(SEPARATOR)}`), tokens, item: item.item });
    }
  }
  return lines;
}

/** An item of a validation result: its line, then each requirement and the fields of its claims in DISPLAY_ORDER. */
function itemBlock(partition: Partition, item: ItemResult, clip: Clip, limits: Limits): string[] {
  const head = `- ${[oneLine(item.item), clip.field(item.label, limits.label, '条目名称的超出部分'), `${labelOf('partition', partition)}${partitionWhy(item, clip)}`].join(SEPARATOR)}${item.carried_over ? `；沿用 ${item.carried_over}` : ''}`;
  const lines = [head];
  for(const change of item.replaced_criteria??[])lines.push('  · '+clip.field(`被取代的判据 ${change.criterion}：旧值 ${change.old}；新值 ${change.new}；声明 ${change.declaration}；复核 ${change.review}；复核人 ${change.reviewer}`,limits.field,'被取代判据的超出部分'));
  for (const r of item.requirements) {
    lines.push(`  · ${clip.field(requirementText(r), limits.field, '要求项结果的超出部分')}`);
    for (const claim of r.claims) lines.push(`    - ${claimText(claim, clip, limits.field)}`);
  }
  for(const notice of storedItemNotices(item))lines.push('  · '+clip.field('历史记录 '+notice.path+'：'+notice.message,limits.field,'历史记录缺失提示的超出部分'));
  return lines;
}

/** Text of an entry whatever its form. */
const entryLines = (entry: Entry): readonly string[] => (typeof entry === 'string' ? [entry] : Array.isArray(entry) ? (entry as readonly string[]) : (entry as { lines: readonly string[] }).lines);
const entryOmitted = (entry: Entry): readonly Omission[] => (typeof entry === 'object' && !Array.isArray(entry) ? (entry as { omitted: readonly Omission[] }).omitted : []);

interface PagedLine {
  text: string;
  /** The item the line belongs to, so that a page starting inside an item says whose lines follow. */
  item: string | null;
  /** JSON Pointer tokens (in the record) of the value the line shows, for reading it on its own; null when none. */
  tokens: string[] | null;
  omitted: readonly Omission[];
}

const plain = (text: string): PagedLine => ({ text, item: null, tokens: null, omitted: [] });

/** The lines of a validation result read by reference, and where its parts start (pages and cursors line up with them). */
interface ResultLayout {
  lines: PagedLine[];
  /** Index of the first line of each part: error lines, cross-item claims, problem lines; -1 when the part is empty. */
  errorsAt: number;
  crossAt: number;
  problemsAt: number;
  /** Index of the first line of each item's block, in partition order. */
  itemAt: number[];
}

const RESULT_PARTS = `依次是：要求项的计数、错误、跨条目主张、问题与未知、各条目的明细（按分区：${PARTITION.map((p) => labelOf('partition', p)).join('、')}）`;

/**
 * A validation result as lines, its parts in the order answers show them: requirement counts, errors, cross-item claims,
 * problems and unknowns, then every item with its requirements and claims, nothing shortened but the problem lines.
 */
function resultLayout(result: ValidationResult, record: string | null): ResultLayout {
  const lines: PagedLine[] = [];
  const accepted = result.acceptance === 'accepted';
  if (accepted) {
    lines.push(plain('要求项（满足状态与各层终态的条目数）：'));
    const counts = requirementCounts(result);
    lines.push(...(counts.length > 0 ? counts : ['- 没有条目结果']).map(plain));
  }
  let errorsAt = -1;
  if (result.errors.length > 0) {
    const list = errorList(result.errors, WHOLE, true);
    if (list.summary !== null) lines.push(plain(list.summary.head), ...list.summary.entries.map((entry) => plain(entryLines(entry).join(' '))));
    errorsAt = lines.length;
    list.entries.forEach((entry, i) => lines.push({ text: entryLines(entry).join(' '), item: null, tokens: ['errors', String(i)], omitted: [] }));
  }
  let crossAt = -1;
  if (result.cross_item.length > 0) {
    lines.push(plain(`跨条目主张（不计入分区，${result.cross_item.length} 条）：`));
    crossAt = lines.length;
    result.cross_item.forEach((claim, k) => lines.push({ text: `- ${claimLine(claim)}`, item: null, tokens: ['cross_item', String(k)], omitted: [] }));
  }
  let problemsAt = -1;
  const itemAt: number[] = [];
  if (accepted) {
    const problems = problemLines(result, record, null);
    lines.push(plain(problems.length > 0 ? `问题与未知（${problems.length} 条；${PROBLEMS_HEAD}）：` : '问题与未知：没有'));
    problemsAt = problems.length > 0 ? lines.length : -1;
    for (const p of problems) lines.push({ text: entryLines(p.entry)[0], item: p.item, tokens: p.tokens, omitted: entryOmitted(p.entry) });
    const all = itemsOf(result.partitions);
    lines.push(plain(all.length > 0 ? '条目明细（每个条目下是它的要求项和主张）：' : '条目明细：没有条目'));
    for (const { partition, index, item } of all) {
      itemAt.push(lines.length);
      const tokens = ['partitions', partition, String(index)];
      for (const text of itemBlock(partition, item, new Clip(), WHOLE)) lines.push({ text, item: item.item, tokens, omitted: [] });
    }
  }
  return { lines, errorsAt, crossAt, problemsAt, itemAt };
}

/** The record digest of a rec: reference (rec:<digest>, with or without a pointer). */
const recordOf = (reference: string): string => {
  const ref = parseReference(reference);
  if (ref.scheme !== 'rec') throw new Error(`not a rec: reference: ${reference.slice(0, 80)}`);
  return ref.record;
};

/** How to read the part of a stored result that starts at line `at` of its layout, or the item `tokens` name. */
function resultWay(reference: string, at: number, tokens: string[] | null, paging: boolean): string {
  if (paging) return `${callText('get_nodes', { reference, cursor: pageCursor(reference, at) })}，再按每页末尾给出的 cursor 接着读`;
  if (tokens === null) return readCall(reference);
  const numbered = NUMBER.test(tokens.at(-1) ?? '');
  return `逐个读 ${readCall(recReference(recordOf(reference), tokens))}${numbered ? '，读完把末尾的序号加一读下一个' : ''}`;
}

// ---------------------------------------------------------------- start_run

function startText(v: StartOut, context: TextContext): string {
  if (v.call_result === 'error' || v.run === undefined) return errorText(v);
  const r = v.run;
  const record = context.record ?? null;
  const paging = context.paging === true;
  const blocks: Block[] = [];
  let supportedBlock:(Block & {entries:readonly Entry[]})|undefined;
  const headClip = new Clip(null, seeConsole(r.run));
  const head = [`运行 ${r.run}：任务包 ${headClip.field(r.pack, CLIP.name, '任务包编号的超出部分')}，条目 ${r.items.length} 个，要求项 ${r.requirements.length} 个`];
  const production = v.result ?? null;
  const full = production !== null ? (context.production ?? null) : null;
  const layout = full !== null ? resultLayout(full, production!.reference) : null;
  if (production !== null) {
    // The run's result first (D05 R[1]): its counts, the state of every requirement, where the whole result is.
    head.push(`结果（start_run 时由 Hub 算出）：${countsText(production.counts)}`);
    if (full !== null) head.push('要求项（满足状态与各层终态的条目数）：', ...requirementCounts(full, r.requirements));
    const read = paging
      ? `${readCall(production.reference)} 读第一页，再按每页末尾给出的 cursor 接着读`
      : `${readCall(production.reference)} 读开头，单个条目读 ${readCall(`${production.reference}#/partitions/<分区>/<序号>`)}`;
    head.push(`完整结果 ${production.reference}：用 ${read}；也可${seeConsole(r.run)}${full === null ? '；问题与未知的明细在完整结果里' : ''}`);
  }
  const target = [r.product && `产品 ${headClip.field(r.product, CLIP.name, '产品名的超出部分')}`, r.version && `版本 ${headClip.field(r.version, CLIP.name, '版本名的超出部分')}`, r.build && `构建 ${headClip.field(r.build, CLIP.name, '构建名的超出部分')}`].filter(Boolean);
  if (target.length > 0) head.push(target.join('，'));
  head.push(r.root !== undefined ? `锁定的知识根 ${r.root}` : '知识根：没有锁定');
  if (r.unversioned_root !== undefined) head.push(`不分版本的知识根 ${r.unversioned_root}（构建未声明）`);
  else if (r.product !== undefined) head.push('这条产品线还没有不分版本的根；下一步：同步这条产品线');
  if (r.predecessor !== undefined) head.push(`前驱运行 ${r.predecessor}`);
  blocks.push({ priority: 0, head, omitted: headClip.omitted });
  if(r.criterion_changes?.length)blocks.push({priority:1,head:['判据变更声明：'],entries:r.criterion_changes.map(change=>{
    const clip=new Clip(null,seeConsole(r.run));
    const state=change.superseded_by?`由后一份提交的同名声明取代：${change.superseded_by}`:change.accepted===true?`已接受；复核人 ${change.reviewer}；理由 ${change.reason}；开始以后才接受的只进后续修订`:change.accepted===false?`未接受；复核人 ${change.reviewer}；理由 ${change.reason}`:change.expired?'已过期，仍等作者以外的账号复核；新修订不带这条声明':'还没有回答；等作者以外的账号复核；新修订不带这条声明';
    return clip.entry(`- ${clip.field(change.assertion,CLIP.field,'声明的超出部分')}；声明 ${change.declaration}；请求 ${change.request}；${state}；受众 ${change.audience}；期限 ${change.due}；旧值 ${clip.field(change.old,CLIP.field,'旧判据的超出部分')}；新值 ${clip.field(change.new,CLIP.field,'新判据的超出部分')}；下一步 ${clip.field(change.next_action,CLIP.field,'下一步的超出部分')}`);
  }),unit:'判据变更声明',measure:'条',more:()=>seeConsole(r.run)});

  if (full !== null && layout !== null && production !== null) {
    if (full.cross_item.length > 0) {
      const clip = (k: number) => new Clip(`${production.reference}#/cross_item/${k}`);
      blocks.push({
        priority: 1,
        head: [`跨条目主张（不计入分区，${full.cross_item.length} 条）：`],
        entries: full.cross_item.map((claim, k) => {
          const c = clip(k);
          const projectionNote=claim.requirement===undefined && claim.pointer!==undefined && /^\/groups\/\d+$/.test(claim.pointer) && claim.qualifier.nature==='fact' && claim.statement.verdict==='support' && claim.warrant.producer==='function';
          const scope=projectionNote?`投影说明（${labelOf('check_tier','advisory')}，不参与要求项）：`:'';
          return c.entry(`- ${scope}${claimText(claim, c, CLIP.field)}`);
        }),
        unit: '跨条目主张',
        measure: '条',
        more: (from) => `跨条目主张：${resultWay(production.reference, layout.crossAt + from, ['cross_item', String(from)], paging)}`,
      });
    }
    const supported = itemsOf(full.partitions).flatMap(({partition, index, item}) =>
      item.requirements.flatMap((requirement, r) => requirement.claims.flatMap((claim, c) =>
        claim.qualifier.nature === 'fact' && claim.statement.verdict === 'support' && claim.warrant.producer === 'function' && claim.validity.status === 'valid'
          ? [{claim, tokens:['partitions',partition,String(index),'requirements',String(r),'claims',String(c)]}] : [])));
    if (supported.length > 0) supportedBlock = {
      priority: 4, head: [`生产运行说明（条目检查的支持事实，${supported.length} 条）：`],
      entries: supported.map(({claim, tokens}) => {
        const clip = new Clip(`${production.reference}#/${tokens.join('/')}`);
        return clip.entry(`- ${clip.field(claim.item ?? '', CLIP.name, '条目编号的超出部分')}：${claimText(claim, clip, CLIP.field)}`);
      }),
      unit:'支持事实',measure:'条',more:from => `其余支持事实：${resultWay(production.reference, 0, supported[from].tokens, false)}`,
    };
    const problems = problemLines(full, production.reference, null);
    pushCapped(
      blocks,
      {
        priority: 1,
        head: [problems.length > 0 ? `问题与未知（${problems.length} 条；${PROBLEMS_HEAD}）：` : '问题与未知：没有'],
        entries: problems.map((p) => p.entry),
        unit: '问题与未知',
        measure: '条',
        more: (from) => `问题与未知：${resultWay(production.reference, layout.problemsAt + from, problems[from]?.tokens ?? null, paging)}`,
      },
      2,
    );
  }
  if (r.target_basis.length > 0) {
    blocks.push({
      priority: 4,
      head: ['版本依据：'],
      entries: r.target_basis.map((c) => {
        const clip = new Clip(null, seeConsole(r.run));
        return clip.entry(`- ${claimText(c, clip, CLIP.field)}`);
      }),
      unit: '版本依据',
      measure: '条',
      more: () => `版本依据：${seeConsole(r.run)}`,
    });
  }
  // A page of the run record's text has the same lines as here, so a cursor names the same line in both.
  const paged = (pointer: string, from: number): string | null => {
    if (record === null || !paging) return null;
    const reference = `${record}#${pointer}`;
    return `${callText('get_nodes', { reference, cursor: pageCursor(reference, from) })}，再按每页末尾给出的 cursor 接着读`;
  };
  // Lines are shown as the pack wrote them; only a line longer than CLIP.line is shortened.
  const procedure = r.instructions.split('\n').map((line, i): Entry => {
    if (line.length <= CLIP.line) return line;
    const clip = new Clip(null, `规程全文：${paged('/instructions', i) ?? seeConsole(r.run)}`);
    return clip.entry(clip.field(line, CLIP.line, '规程行的超出部分'));
  });
  pushCapped(blocks, { priority: 2, head: ['规程：'], entries: procedure, unit: '规程', measure: '行', more: (from) => `规程：${paged('/instructions', from) ?? seeConsole(r.run)}` }, 5);
  blocks.push({
    priority: 1,
    head: ['要求项：'],
    entries: r.requirements.map((q) => {
      const clip = new Clip(null, seeConsole(r.run));
      return clip.entry(`- ${requirementFacts(q, clip)}`);
    }),
    unit: '要求项',
    measure: '个',
    more: () => `要求项：${seeConsole(r.run)}`,
  });
  if(r.input_defaults?.length)blocks.push({
    priority:1,head:['输入缺省绑定：'],entries:r.input_defaults.map(binding=>binding.kind==='input'?`- ${binding.slot} 按前驱 ${binding.predecessor} 冻结的输入 ${binding.reference} 绑定`:`- ${binding.slot} 按前驱 ${binding.predecessor} 的已受理结果 ${binding.reference} 绑定`),unit:'绑定',measure:'个',
    more:()=>`绑定来历：${record===null?seeConsole(r.run):readCall(record+'#/input_defaults')}`,
  });
  const sources = r.sources.map((s) => sourceEntry(s, r.run));
  const gaps: Entry[] = [
    ...(context.unavailable ?? []).map((g) => {
      const clip = new Clip(null, seeConsole(r.run));
      return clip.entry(`- ${labelOf('attribution', 'data_gap')}：${labelOf('source_role', g.role)} ${clip.field(g.external, CLIP.name, '外部对象编号的超出部分')}：${UNAVAILABLE_MESSAGE}`);
    }),
    ...(context.gaps ?? []).map((g) => {
      const clip = new Clip(null, seeConsole(r.run));
      return clip.entry(`- ${labelOf('attribution', 'data_gap')}：${clip.field(g.code, CLIP.code, '缺口代码的超出部分')}：${clip.field(g.message, CLIP.message, '缺口说明的超出部分')}`);
    }),
  ];
  blocks.push({ priority: 1, head: [sources.length + gaps.length > 0 ? '来源：' : '来源：没有绑定'], entries: [...sources, ...gaps], unit: '来源', measure: '个', more: () => `来源：${seeConsole(r.run)}` });
  const items = itemLines(r.items, record, r.run);
  const itemsMore = (from: number): string => {
    const next = paged('/items', from);
    if (next !== null) return `条目：${next}；也可${seeConsole(r.run)}`;
    if (record !== null) return `条目：逐个读 ${readCall(`${record}#/items/${from}`)}，读完把末尾的序号加一读下一个；也可${seeConsole(r.run)}`;
    return `条目：${seeConsole(r.run)}`;
  };
  blocks.push({ priority: 3, head: items.head, entries: items.entries, unit: '条目', measure: '个', more: itemsMore });
  if(supportedBlock)pushCapped(blocks,supportedBlock,5);
  if (r.slots !== undefined) {
    const schemaWay = record === null ? seeConsole(r.run) : `${readCall(`${record}#/slots/schema`)}${paging ? '，再按每页末尾给出的 cursor 接着读' : ''}`;
    const schema = slotSchemaLines(r.slots, `完整的槽位模式：${schemaWay}`);
    // The compact lines leave out descriptions and patterns: say once where the whole JSON Schema is.
    if (record !== null) schema.head.splice(1, 0, `完整的槽位模式（JSON Schema，带说明和写法）：${schemaWay}`);
    blocks.push({ priority: 1, head: schema.head, entries: schema.entries, unit: '槽位模式', measure: '行', more: () => `完整的槽位模式：${schemaWay}` });
  }
  const reuse = r.items.some((it) => it.reuse !== undefined);
  const explain = isProductionRun(r)
    ? '示例 submit_result（可选：事实由 Hub 算出，提交只补充模型的评论，记为判断）：'
    : `示例 submit_result（一行 JSON；把空列表换成你的陈述，跳过的条目写 {"item":"<编号>","handling":"skipped","reason":"<理由>"}${reuse ? '；有“可沿用”的条目可以用 "reuse":"<该引用>" 代替 slots' : ''}）：`;
  blocks.push({ priority: 0, head: [explain, submitExample(r)] });
  return fit(blocks, { fallback: seeConsole(r.run), tail: [traceLine(v.trace)] }).text;
}

/** Pushes a list as two blocks (softCap): its first SOFT_CAP characters at its own priority, the rest at priority `rest`. */
function pushCapped(blocks: Block[], block: Block & { entries: readonly Entry[] }, rest: number): void {
  blocks.push(...softCap(block, SOFT_CAP, rest, blocks.length));
}

function sourceEntry(s: SourceBinding, run: string): Entry {
  const clip = new Clip(null, seeConsole(run));
  const parts = [
    s.slot && `输入 ${clip.field(s.slot, CLIP.code, '输入槽名的超出部分')}`,
    s.external && `外部对象 ${clip.field(s.external, CLIP.name, '外部对象编号的超出部分')}`,
    s.media_type && clip.field(s.media_type, CLIP.name, '媒体类型的超出部分'),
    s.label && clip.field(s.label, CLIP.name, '来源名称的超出部分'),
    s.coverage?.complete===false && `读取覆盖 ${clip.field(coverageText(s.coverage)??'',CLIP.message,'读取覆盖说明的超出部分')}`,
  ].filter(Boolean);
  return clip.entry(`- ${labelOf('source_role', s.role)} ${s.reference}${parts.length > 0 ? `（${parts.join('，')}）` : ''}`);
}

// ---------------------------------------------------------------- get_nodes: knowledge nodes

/** The console page of a knowledge node. */
const nodePage = (root: string, path: string): string => `在控制台知识库页 /console/knowledge/tree?root=${root}&path=${encodeURIComponent(path)} 查看`;

/** A get_nodes call of as many of `paths` as fit within PATHS_CALL characters (and MAX_PATHS), and how many it holds. */
function pathsCall(root: string, paths: readonly string[]): { call: string; count: number } {
  let size = callText('get_nodes', { root, paths: [], depth: 0 }).length;
  let n = 0;
  while (n < paths.length && n < MAX_PATHS) {
    const add = JSON.stringify(paths[n]).length + (n > 0 ? 1 : 0);
    if (n > 0 && size + add > PATHS_CALL) break;
    size += add;
    n++;
  }
  return { call: callText('get_nodes', { root, paths: paths.slice(0, n), depth: 0 }), count: n };
}

/**
 * A node: its line, its entries (the definitions to cite) and its children. A node too long for one page keeps its line and
 * as many entries, then children, as fit `room`, and names what it left out with a way to read it.
 */
function nodeEntry(node: KnowledgeNode, root: string, room: number): Entry {
  const page = nodePage(root, node.path);
  const own = new Clip(null, page);
  const relationCount=node.backlinks?.configured?`；反向关联共 ${node.backlinks.total} 个条目`:'';
  const head = `- ${node.path}（${labelOf('node_level', node.level)}）${own.field(node.name, CLIP.name, '节点名称的超出部分')}：子节点 ${node.children.length} 个，条目 ${node.entries.length} 个；引用 ${node.reference}${relationCount}`;
  const entries = node.entries.map((entry) => {
    const clip = new Clip(null, page);
    const statement = clip.field(entry.statement, CLIP.field, '条目陈述的超出部分', '读条目陈述全文：用 get_nodes 按那一行的引用读');
    const data = entry.data === undefined ? '' : `；数据 ${clip.field(JSON.stringify(entry.data), CLIP.data, '条目数据的超出部分')}`;
    const fields=entry.applicability_fields;
    const state=fields?'；条件状态 '+Object.entries(fields).map(([field,value])=>`${labelOf('applicability_field',field as import('../../contracts/generated/vocabulary.ts').ApplicabilityField)}：声明 ${value.declaration_status===null?'出处未核验':labelOf('declaration_status',value.declaration_status)}，判断 ${value.judgment_status===null?'尚未核读完':labelOf('judgment_status',value.judgment_status)}，声明值 ${value.declaration_value===null?'null':clip.field(JSON.stringify(value.declaration_value),CLIP.data,'声明值超出部分')}${value.judgments.length?'；判断引用 '+value.judgments.map(ref=>'rec:'+ref).join(' '):''}${value.conflicted?'；存在冲突，需复核':''}`).join('；'):'';
    return { text: `  · [${labelOf('entry_kind', entry.kind)}] ${statement}（适用 ${clip.field(entry.applicability, CLIP.name, '适用条件的超出部分')}）；引用 ${entry.reference}${data}${state}`, omitted: clip.omitted };
  });
  for (const view of node.contributions ?? []) {
    const clip = new Clip(`rec:${view.record}`);
    const c = view.contribution;
    if(c===undefined){entries.push({text:`  · [${labelOf('knowledge_layer','contribution')}] ${clip.field(view.note,CLIP.field,'回注说明的超出部分')}；引用 rec:${view.record}`,omitted:clip.omitted});continue;}
    if(!('statement'in c)){
      entries.push({text:`  · [${labelOf('knowledge_layer',c.layer)}] ${clip.field(view.note??labelOf('validity_status',view.status),CLIP.field,'受限说明的超出部分')}；来源 ${c.source.reference}；提交人 ${c.submitted_by}；时间 ${c.submitted_at}；依据 ${labelOf('basis_rank',c.basis_rank)}；引用 rec:${view.record}`,omitted:clip.omitted});
      continue;
    }
    if(c.kind==='applicability_claim'&&c.applicability_claim){const a=c.applicability_claim;entries.push({text:`  · [适用条件主张 / 判断] ${labelOf('applicability_field',a.field)}：${clip.field(JSON.stringify(a.value),CLIP.field,'条件值超出部分')}；目标 ${a.entry}；章节 ${a.section.join(' / ')}；逐字引文 ${clip.field(a.evidence.text,CLIP.field,'引文超出部分')}；来源 ${c.source.reference}；模型 ${clip.field(c.model,CLIP.name,'模型标识超出部分')}；校验组成 rec:${a.admission.composition}；引用 rec:${view.record}`,omitted:clip.omitted});continue;}
    entries.push({ text: `  · [${labelOf('knowledge_layer', c.layer)} / ${labelOf('document_output_kind', c.kind)}] ${clip.field(c.statement, CLIP.field, '回注陈述的超出部分')}；来源 ${c.source.reference}（${labelOf('provenance_type',c.source.provenance)}）；适用 ${clip.field(applicabilityText(c.applicability),CLIP.name,'适用条件的超出部分')}；提交人 ${c.submitted_by}；时间 ${c.submitted_at}；依据 ${labelOf('basis_rank',c.basis_rank)}；引用 rec:${view.record}${view.note === null ? '' : '；'+view.note}${c.relation === undefined ? '' : '；关系 '+labelOf('relation_kind',c.relation.kind)+' → '+c.relation.other.reference}`, omitted: clip.omitted });
  }
  const children = node.children.map((child) => {
    const clip = new Clip(null, page);
    return { text: `  子节点 ${child.path} ${clip.field(child.name, CLIP.name, '子节点名称的超出部分')}`, omitted: clip.omitted };
  });
  const lines = [head];
  const omitted: Omission[] = [...own.omitted];
  let used = head.length + 1;
  let keptEntries = 0;
  while (keptEntries < entries.length && used + entries[keptEntries].text.length + 1 <= room) used += entries[keptEntries++].text.length + 1;
  let keptChildren = 0;
  while (keptEntries === entries.length && keptChildren < children.length && used + children[keptChildren].text.length + 1 <= room) used += children[keptChildren++].text.length + 1;
  for (const e of entries.slice(0, keptEntries)) {
    lines.push(e.text);
    omitted.push(...e.omitted);
  }
  for (const c of children.slice(0, keptChildren)) {
    lines.push(c.text);
    omitted.push(...c.omitted);
  }
  if(node.backlinks){
    const related=node.backlinks.entries;let shown=0;
    for(const link of related){
      const clip=new Clip(null,page);
      const line=`  关联引用 ${link.reference}；摘要 ${clip.field(link.summary.replace(/\s+/g,' '),CLIP.line,'关联摘要的超出部分')}`;
      if(used+line.length+1>room)break;lines.push(line);used+=line.length+1;shown++;omitted.push(...clip.omitted);
    }
    for(const note of node.backlinks.notes){const line='  关联说明：'+plain(note);if(used+line.length+1<=room){lines.push(line);used+=line.length+1;}}
    const total=node.backlinks.total;
    if(total!==null&&shown<total)omitted.push({what:`反向关联条目 ${total-shown} 个`,more:`反向视图还有记录：${node.backlinks.view_id ?? "请用同一运行重新读取节点以取得视图标识"}，读取后沿视图游标翻页`});
  }
  if (keptEntries < entries.length) {
    const left = [...node.entries.map(e => e.reference), ...(node.contributions ?? []).map(e => `rec:${e.record}`)].slice(keptEntries);
    let listed = 0;
    let size = 0;
    while (listed < left.length && (listed === 0 || size + left[listed].length + 1 <= 3000)) size += left[listed++].length + 1;
    omitted.push({
      what: `节点 ${node.path} 的条目 ${left.length} 个`,
      more: `节点 ${node.path} 的其余条目：每个引用用 get_nodes {"reference":"<引用>"} 读一次：${left.slice(0, listed).join('、')}${listed < left.length ? `；再往后的 ${left.length - listed} 个条目${page}` : ''}`,
    });
  }
  if (keptChildren < children.length) {
    const left = node.children.slice(keptChildren).map((c) => c.path);
    const { call, count } = pathsCall(root, left);
    omitted.push({ what: `节点 ${node.path} 的子节点 ${left.length} 个`, more: `节点 ${node.path} 的其余子节点：${call}${count < left.length ? `；再往后的 ${left.length - count} 个子节点${page}` : ''}` });
  }
  return omitted.length === 0 ? lines : { lines, omitted };
}

function nodesText(v: NodesOut, context: TextContext): string {
  if (v.call_result === 'error') return errorText(v);
  if (v.content !== undefined) return contentText(v.content, v.trace, context);
  const nodes = v.nodes ?? [];
  const root = v.root ?? '';
  const head = [`知识根 ${root}：节点 ${nodes.length} 个`];
  const headClip = new Clip(null, nodePage(root, nodes[0]?.path ?? '/'));
  const covered = coverageText(v.coverage);
  if (covered !== null) head.push(`覆盖：${headClip.field(covered, CLIP.line, '覆盖说明的超出部分')}`);
  // The service's cursor is copied whole: it is a token.
  if (typeof v.next === 'string') head.push(`还有下一页：用同样的 root、paths 和 depth，再加 cursor ${v.next}`);
  const tail = [traceLine(v.trace)];
  const room = TEXT_BUDGET - sizeOf(head) - sizeOf(tail) - NODE_NOTE_ROOM;
  const more = (from: number): string => {
    const paths = nodes.slice(from).map((n) => n.path);
    const { call, count } = pathsCall(root, paths);
    const rest = paths.length - count;
    return `这一页其余 ${paths.length} 个节点：${call}${rest > 0 ? `；其后的 ${rest} 个节点（从 ${paths[count]} 起）的路径没有列出：读它们的上级节点（depth 1）可以看到` : ''}`;
  };
  return fit([{ priority: 0, head, omitted: headClip.omitted }, { priority: 1, entries: nodes.map((node) => nodeEntry(node, root, room)), unit: '节点', measure: '个', more }], { tail }).text;
}

// ---------------------------------------------------------------- get_nodes: content by reference

interface ContentView {
  /** Lines before the page, on every page (what the content is). */
  head: string[];
  lines: PagedLine[];
  unit: string;
  /** The run the content belongs to, for the console page. */
  run: string | null;
  /** The record of a rec: reference (for pointers to parts of it), else null. */
  record: string | null;
  /** The node of a tree: reference, for its console page; else null. */
  tree: { root: string; path: string } | null;
  /** Raw text (a source, or a string value), paged by lines. */
  text: boolean;
}

/** JSON as lines (JSON.stringify with one space), each member of the top value pointing at itself. */
function jsonLines(value: unknown, tokens: readonly string[]): PagedLine[] {
  if (value === null || typeof value !== 'object') return JSON.stringify(value, null, 1).split('\n').map(plain);
  const array = Array.isArray(value);
  const members: [string, unknown][] = array ? (value as unknown[]).map((v, i) => [String(i), v]) : Object.entries(value as Record<string, unknown>);
  if (members.length === 0) return [plain(array ? '[]' : '{}')];
  const lines: PagedLine[] = [plain(array ? '[' : '{')];
  members.forEach(([key, child], k) => {
    const own = JSON.stringify(child, null, 1).split('\n');
    const last = k === members.length - 1;
    own.forEach((line, j) => {
      const text = j === 0 ? ` ${array ? '' : `${JSON.stringify(key)}: `}${line}` : ` ${line}`;
      lines.push({ text: j === own.length - 1 && !last ? `${text},` : text, item: null, tokens: [...tokens, key], omitted: [] });
    });
  });
  lines.push(plain(array ? ']' : '}'));
  return lines;
}

/** The last content view, so that reading one reference page by page parses it once. */
let lastView: { reference: string; text: string; view: ContentView } | null = null;

/**
 * What the text of a reference is shown as: a validation result, a partition or one item of it, the errors of a result or
 * the items of a run as their lines; other JSON of a record pretty-printed (one member a line where it can); a source or a
 * string value as its own lines.
 */
function contentView(c: Content & { text: string }): ContentView {
  if (lastView !== null && lastView.reference === c.reference && lastView.text === c.text) return lastView.view;
  const view = buildView(c);
  lastView = { reference: c.reference, text: c.text, view };
  return view;
}

function buildView(c: Content & { text: string }): ContentView {
  const text: ContentView = { head: [], lines: c.text.split('\n').map(plain), unit: '原文', run: null, record: null, tree: null, text: true };
  if (c.reference.startsWith('src:')) return text;
  let ref: Reference;
  try {
    ref = parseReference(c.reference);
  } catch (error) {
    if (error instanceof ReferenceSyntaxError) return text;
    throw error;
  }
  if (ref.scheme === 'tree') return { ...text, tree: { root: ref.root, path: ref.path } };
  if (ref.scheme !== 'rec') return text;
  const tokens = ref.pointer === undefined ? [] : pointerTokens(ref.pointer);
  let value: unknown;
  try {
    value = JSON.parse(c.text);
  } catch {
    return { ...text, record: ref.record };
  }
  // A string value is given as it is; only canonical JSON of an object or array is a value to lay out.
  if (value === null || typeof value !== 'object' || canonicalJson(value) !== c.text) return { ...text, record: ref.record };
  const record = ref.record;
  if (tokens.length === 0) {
    let read:ReturnType<typeof readStoredValidationResult>|null;
    try{read=readStoredValidationResult(value);}catch(error){if(!(error instanceof ZodError))throw error;read=null;}
    if (read !== null) {
      const result = read.result;
      const notices=read.notices;
      const management=isAbandonedResult(result);
      const unwritten=management?result.cross_item.find(c=>c.warrant.id==='runs.engine@1'&&c.statement.data?.run_disposition==='abandon')?.statement.data?.legacy_unwritten_fields:undefined;
      const missingExits=notices.filter(n=>n.message==='出口未写'),missingFacts=notices.filter(n=>n.message==='缺失事实未写');
      const head = [
        ...(management?['管理放弃：要求项未满足（已放弃）；技术层沿用原记录，未重验；保留未知计数，不改变原效果及冻结。',`原技术记录有 ${typeof unwritten==='number'?unwritten:0} 处字段未写；管理出口不是旧技术出口，原件不回填。`]:[]),
        `结果 ${c.reference}（运行 ${result.run}）：${result.system_input?'系统交付；'+countsText(partitionCountsOf(result.partitions),result.partitions):countsLine(result.acceptance, result.acceptance === 'accepted' ? result.partitions : undefined)}`,
        `修复轮数：已用 ${result.rounds.used}，最多 ${result.rounds.max}；覆盖：${oneLine(coverageText(result.coverage) ?? '')}；锁定：任务包 ${oneLine(result.locks.pack)}${result.locks.root ? `，知识根 ${result.locks.root}` : ''}`,
        ...(notices.length?[`旧结果：出口未写 ${missingExits.length} 处，缺失事实未写 ${missingFacts.length} 处；首处 ${notices[0].path}。原记录不回填，请按具名请求补齐事实后重评或开新修订`]:[]),
        ...(result.system_input?[`系统交付输入摘要 ${result.submission}；来源 ${result.system_input}`]:[]),
        `内容${RESULT_PARTS}`,
      ];
      return { head, lines: resultLayout(result, recReference(record)).lines, unit: '结果', run: result.run, record, tree: null, text: false };
    }
  }
  if (tokens[0] === 'partitions' && (tokens.length === 2 || tokens.length === 3) && (PARTITION as readonly string[]).includes(tokens[1]) && (tokens.length === 2 || NUMBER.test(tokens[2]))) {
    const p = tokens[1] as Partition;
    const shape = StoredPartitionItem[p];
    const parsed = tokens.length === 2 ? shape.array().safeParse(value) : shape.safeParse(value);
    if (parsed.success) {
      const items = (Array.isArray(parsed.data) ? parsed.data : [parsed.data]) as ItemResult[];
      const lines = items.flatMap((item, i) => {
        const own = tokens.length === 2 ? [...tokens, String(i)] : tokens;
        return itemBlock(p, item, new Clip(), WHOLE).map((line) => ({ text: line, item: item.item, tokens: own, omitted: [] }));
      });
      return { head: [`结果的${labelOf('partition', p)}部分 ${c.reference}：条目 ${items.length} 个`], lines, unit: '结果', run: null, record, tree: null, text: false };
    }
  }
  if (tokens.length === 1 && tokens[0] === 'items') {
    const parsed = ItemProjection.array().safeParse(value);
    if (parsed.success) {
      const items = itemLines(parsed.data, recReference(record), null);
      const lines = items.entries.map((entry, i) => ({ text: entryLines(entry)[0], item: parsed.data[i].id, tokens: ['items', String(i)], omitted: entryOmitted(entry) }));
      return { head: [`运行的条目 ${c.reference}`, ...items.head], lines, unit: '条目', run: null, record, tree: null, text: false };
    }
  }
  return { head: [], lines: jsonLines(value, tokens), unit: '内容', run: null, record, tree: null, text: false };
}

/** Line starts and ends as text@1 counts lines (CR LF, CR or LF; a final line break opens no line). */
function textLines(text: string): { starts: number[]; ends: number[] } {
  const starts: number[] = [];
  const ends: number[] = [];
  if (text.length === 0) return { starts, ends };
  const breaks = /\r\n|\r|\n/g;
  let start = 0;
  for (let match = breaks.exec(text); match !== null; match = breaks.exec(text)) {
    starts.push(start);
    ends.push(match.index);
    start = match.index + match[0].length;
  }
  if (start < text.length) {
    starts.push(start);
    ends.push(text.length);
  }
  return { starts, ends };
}

/**
 * A reference that reads a source from UTF-16 index `at` of its text to its end, without a cursor: a byte range of the
 * same fragment, or for a whole source the text@1 lines from there (with a byte range when `at` is inside a line).
 */
function sourceFrom(reference: string, text: string, at: number, lines: () => { starts: number[]; ends: number[] }): string | null {
  let ref: Reference;
  try {
    ref = parseReference(reference);
  } catch (error) {
    if (error instanceof ReferenceSyntaxError) return null;
    throw error;
  }
  if (ref.scheme !== 'src') return null;
  if (ref.selector !== undefined) {
    const base = ref.range?.[0] ?? 0;
    const end = ref.range?.[1] ?? base + Buffer.byteLength(text, 'utf8');
    const from = base + Buffer.byteLength(text.slice(0, at), 'utf8');
    return from < end ? withRange(reference, [from, end]) : null;
  }
  const { starts, ends } = lines();
  let k = 0;
  let hi = starts.length - 1;
  while (k < hi) {
    const mid = (k + hi + 1) >> 1;
    if (starts[mid] <= at) k = mid;
    else hi = mid - 1;
  }
  if (starts.length === 0 || at >= ends[ends.length - 1]) return null;
  const total = starts.length;
  const selector = ['l', k + 1 === total ? String(total) : `${k + 1}-${total}`];
  const offset = at - starts[k];
  if (offset <= 0) return srcFragment(ref.sha256, 'text@1', selector);
  const x = Buffer.byteLength(text.slice(starts[k], at), 'utf8');
  let y = 0;
  for (let j = k; j < total; j++) y += Buffer.byteLength(text.slice(starts[j], ends[j]), 'utf8') + (j < total - 1 ? 1 : 0);
  return x < y ? srcFragment(ref.sha256, 'text@1', selector, [x, y]) : null;
}

/** Where a page shows from: a line and a UTF-16 offset inside it (a line longer than a page is shown in pieces). */
interface Position {
  line: number;
  offset: number;
}

/** Whether UTF-16 offset `at` of `text` falls between the two halves of a surrogate pair (no page starts there). */
function insidePair(text: string, at: number): boolean {
  if (at <= 0 || at >= text.length) return false;
  const before = text.charCodeAt(at - 1);
  const after = text.charCodeAt(at);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

/** The end of the piece of `text` from `from` that takes at most `room` characters: never inside a surrogate pair, never just before a CR. */
function pieceEnd(text: string, from: number, room: number): number {
  let end = Math.min(text.length, from + Math.max(1, room));
  if (end < text.length) {
    const code = text.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end = end - 1 > from ? end - 1 : end + 1;
    if (end < text.length && text.charCodeAt(end) === 0x0d) end++;
  }
  return end;
}

/** Page the disclosed structure itself, never manufacture source byte ranges from a summary. */
function structurePage(c:Content,trace:string,context:TextContext):string {
  const {parser,summary,...rest}=c.structure!;
  const fields=isRecord(summary)?summary:summary===undefined?{}:{summary};
  const lines=Object.entries({...fields,...rest}).map(([key,value])=>`  ${oneLine(key)} ${valueText(value)}`);
  const head=[`内容 ${c.reference}：${labelOf('read_tier',c.read_tier)}`,...(c.sha256?[`sha256 ${c.sha256}`]:[]),...(c.note?[oneLine(c.note)]:[]),...(typeof parser==='string'?[`解析器 ${oneLine(parser)} 认出了这份文件`]:[]),'结构摘要：'];
  const tail=[traceLine(trace)];
  if(!lines.length)return fit([{priority:0,head:[...head,'（空）']}],{tail}).text;
  const at=context.cursor?cursorPosition(c.reference,context.cursor):null;
  const valid=at && lines[at.line] && at.offset<lines[at.line].length;
  const start=valid?at:{line:0,offset:0};
  if(context.cursor && !valid)head.push('cursor 不对应本页结构的有效位置，下面从第一页显示');
  const way=(line:number,offset=0):string=>context.paging===true
    ? `下一页：${callText('get_nodes',{reference:c.reference,cursor:pageCursor(c.reference,line,offset)})}`
    : '缺少结构续读入口；请管理员提供可公开的结构摘录，再用 get_nodes 按摘录引用读取';
  const room=TEXT_BUDGET-sizeOf(head)-sizeOf(tail)-1500;
  const end=pieceEnd(lines[start.line],start.offset,room);
  let entries:Entry[],more:(shown:number)=>string;
  if(end<lines[start.line].length) {
    const next=way(start.line,end);
    entries=[{lines:[lines[start.line].slice(start.offset,end)],omitted:[{what:'本行及后续结构摘要',more:next}]}];
    more=()=>next;
  } else {
    entries=[lines[start.line].slice(start.offset),...lines.slice(start.line+1)];
    more=shown=>way(start.line+shown,shown===0?start.offset:0);
  }
  return fit([{priority:0,head},{priority:1,entries,unit:'结构摘要',measure:'行',first:start.line+1,more}],{tail,fallback:way(start.line,start.offset)}).text;
}

/**
 * The content a reference points at, one page at a time within the budget: whole lines, and a line longer than the room
 * of a page in pieces. The way to the rest is a page cursor when the server pages; otherwise a byte range or text@1 lines of
 * a source, a pointer to the next part of a record, or the console page.
 */
function contentText(c: Content, trace: string, context: TextContext): string {
  if(c.text===undefined && c.structure!==undefined)return structurePage(c,trace,context);
  const tail = [traceLine(trace)];
  const head = [`内容 ${c.reference}：${labelOf('read_tier', c.read_tier)}`];
  if (c.sha256 !== undefined) head.push(`sha256 ${c.sha256}`);
  if (c.note !== undefined) head.push(oneLine(c.note));
  const blocks: Block[] = [{ priority: 0, head }];
  if (c.structure !== undefined) {
    const structure = structureLines(c.structure, null);
    blocks.push({ priority: 2, head: structure.head, entries: structure.entries, unit: '结构摘要', measure: '行', more: () => null });
  }
  if (c.text === undefined) return fit(blocks, { tail }).text;
  const textOf = c.text;
  const view = contentView({ ...c, text: textOf });
  const lines = view.lines;
  if (lines.length === 0) {
    // An empty partition or item list (every item delivered leaves three partitions empty): the head says 0; nothing to page.
    blocks.push({ priority: 1, head: view.head });
    return fit(blocks, { tail }).text;
  }
  const paging = context.paging === true;
  const pageHead: string[] = [];
  let start: Position = { line: 0, offset: 0 };
  const cursor = context.cursor ?? null;
  if (cursor !== null) {
    const at = cursorPosition(c.reference, cursor);
    // The server's own cursors never split a character (pieceEnd); an offset that would is not a page position.
    const line = at === null ? undefined : lines[at.line];
    if (at !== null && line !== undefined && (at.offset === 0 || (at.offset < line.text.length && !insidePair(line.text, at.offset)))) start = at;
    else pageHead.push(`cursor ${oneLine(cursor).slice(0, 100)} 不是这个引用的翻页位置，下面从第一页显示`);
  }
  const from = `第 ${start.line + 1} 行${start.offset > 0 ? `的第 ${start.offset + 1} 个字符` : ''}起`;
  if (view.text) pageHead.unshift(start.line === 0 && start.offset === 0 ? `原文（${textOf.length} 个字符）：` : `原文（共 ${textOf.length} 个字符、${lines.length} 行），从${from}：`);
  else pageHead.unshift(...view.head, `共 ${lines.length} 行，这一页从${from}：`);
  const first = lines[start.line];
  if (start.offset > 0) pageHead.push(`（接上页：第 ${start.line + 1} 行的前 ${start.offset} 个字符在上一页）`);
  else if (start.line > 0 && first.item !== null && lines[start.line - 1].item === first.item) pageHead.push(`（接上页：条目 ${first.item}）`);

  let starts: number[] | null = null;
  const lineStart = (line: number): number => {
    starts ??= (() => {
      const out = [0];
      for (let i = textOf.indexOf('\n'); i >= 0; i = textOf.indexOf('\n', i + 1)) out.push(i + 1);
      return out;
    })();
    return starts[line] ?? textOf.length;
  };
  let tl: { starts: number[]; ends: number[] } | null = null;
  const wayFrom = (at: Position): string => {
    if (paging) return `下一页：${callText('get_nodes', { reference: c.reference, cursor: pageCursor(c.reference, at.line, at.offset) })}${view.run !== null ? `；也可${seeConsole(view.run)}` : ''}`;
    if (view.text) {
      const reference = sourceFrom(c.reference, textOf, lineStart(at.line) + at.offset, () => (tl ??= textLines(textOf)));
      if (reference !== null) return `接着读：${readCall(reference)}`;
    }
    const tokens = lines[at.line]?.tokens ?? null;
    if (tokens !== null && view.record !== null) {
      const numbered = NUMBER.test(tokens.at(-1) ?? '');
      return `逐个读：${readCall(recReference(view.record, tokens))}${numbered ? '，读完把末尾的序号加一读下一个' : ''}${view.run !== null ? `；也可${seeConsole(view.run)}` : ''}`;
    }
    if (view.tree !== null) return `其余部分${nodePage(view.tree.root, view.tree.path)}`;
    return view.run !== null ? `其余部分${seeConsole(view.run)}` : `其余部分${RUNS_PAGE}`;
  };

  // The room the first line has on this page: the budget less the heads, the trace and the note (with its way on).
  const longestWay = Math.max(wayFrom({ line: start.line, offset: start.offset + 1 }).length, wayFrom({ line: Math.min(start.line + 1, lines.length - 1), offset: 0 }).length);
  const room = TEXT_BUDGET - sizeOf(head) - sizeOf(pageHead) - sizeOf(tail) - longestWay - 1500;
  const rest = first.text.slice(start.offset);
  const entries: Entry[] = [];
  const end = rest.length + 1 <= room ? first.text.length : pieceEnd(first.text, start.offset, room - 1);
  if (end < first.text.length) {
    // A piece of a line too long for the page, and nothing after it: the rest of the line comes first on the next page.
    const way = wayFrom({ line: start.line, offset: end });
    const omitted: Omission[] = [...first.omitted, { what: `第 ${start.line + 1} 行的其余 ${first.text.length - end} 个字符`, more: way }];
    const later = lines.length - start.line - 1;
    if (later > 0) omitted.push({ what: `${view.unit} ${later} 行（第 ${start.line + 2}${later > 1 ? ` 到第 ${lines.length}` : ''} 行）`, more: way });
    entries.push({ lines: [first.text.slice(start.offset, end)], omitted });
  } else {
    entries.push(first.omitted.length > 0 ? { lines: [rest], omitted: first.omitted } : rest);
    for (let i = start.line + 1; i < lines.length; i++) entries.push(lines[i].omitted.length > 0 ? { lines: [lines[i].text], omitted: lines[i].omitted } : lines[i].text);
  }
  const more = (n: number): string => wayFrom(n === 0 ? start : { line: start.line + n, offset: 0 });
  blocks.push({ priority: 1, head: pageHead, entries, unit: view.unit, measure: '行', first: start.line + 1, more });
  return fit(blocks, { tail }).text;
}

// ---------------------------------------------------------------- resolve_reference

function resolveText(v: ResolveOut): string {
  if (v.call_result === 'error' || v.resolution === undefined) return errorText(v);
  const head = [`${axisLabel('resolution')}：${labelOf('resolution', v.resolution)}，可能所指 ${v.references.length} 个（预览，不作凭据）`];
  const references = v.references.map((r) => {
    const clip = new Clip(null, '读全文：用 get_nodes 按各可能所指的引用读');
    return clip.entry(`- ${r.reference}：${clip.field(r.text, CLIP.message, '可能所指原文的超出部分')}${r.role ? `（${labelOf('source_role', r.role)}）` : ''}`);
  });
  const diagnostics = v.diagnostics.map((d) => {
    const clip = new Clip();
    return clip.entry(`诊断：${clip.field(d, CLIP.message, '诊断的超出部分')}`);
  });
  return fit(
    [
      { priority: 0, head },
      { priority: 1, entries: references, unit: '可能所指', measure: '个', more: () => '给出更长、更精确的原文再调用 resolve_reference，或用 get_nodes 按引用读每一个可能所指' },
      { priority: 2, entries: diagnostics, unit: '诊断', measure: '条', more: () => '给出更精确的原文再调用 resolve_reference' },
    ],
    { tail: [traceLine(v.trace)] },
  ).text;
}

// ---------------------------------------------------------------- submit_result

function submitText(v: SubmitOut, context: TextContext): string {
  const result = v.result;
  const accepted = v.acceptance === 'accepted' && result !== undefined;
  const record = context.record ?? null;
  const paging = context.paging === true;
  const run = result?.run ?? null;
  const layout = result !== undefined && record !== null ? resultLayout(result, record) : null;
  const toConsole = run !== null ? seeConsole(run) : RUNS_PAGE;
  const head = [countsLine(v.acceptance, accepted ? result.partitions : undefined)];
  if (result !== undefined) {
    const covered = coverageText(result.coverage);
    head.push(`修复轮数：已用 ${result.rounds.used}，最多 ${result.rounds.max}${covered !== null ? `；覆盖：${oneLine(covered)}` : ''}`);
    head.push(`锁定：任务包 ${oneLine(result.locks.pack)}${result.locks.root ? `，知识根 ${result.locks.root}` : ''}`);
    if (result.trace !== v.trace) head.push(`结果出自追踪 ${result.trace} 的那次调用（同一提交的重复调用返回存下的结果）`);
    if (record !== null) head.push(`存下的结果 ${record}（用 get_nodes 按引用读；也可${toConsole}）`);
  }
  if (result?.contributions !== undefined) {
    const c = result.contributions;
    head.push(`回注：提交 ${c.submitted} 条，入层 ${c.stored.length} 条，未入层 ${c.not_stored.length} 条`);
    for (const entry of c.stored) head.push(`回注条目 ${oneLine(entry.item)}：rec:${entry.record}`);
    for (const entry of c.not_stored) head.push(`未入层条目 ${oneLine(entry.item)}：${oneLine(entry.reason)}`);
  }
  const blocks: Block[] = [{ priority: 0, head }];
  if (accepted) blocks.push({ priority: 0, head: ['要求项（满足状态与各层终态的条目数）：', ...requirementCounts(result)] });
  if (v.errors.length > 0) {
    const whole = (i: number): string | null => (record !== null ? `${record}#/errors/${i}` : null);
    const list = errorList(v.errors, CLIP, true, whole, record !== null ? null : toConsole);
    // The way to the errors left out: the stored result when it is known (resubmitting to see them costs repair rounds).
    const errorsMore = (from: number): string => {
      if (layout !== null && record !== null) return `其余错误：${resultWay(record, layout.errorsAt + from, ['errors', String(from)], paging)}`;
      if (accepted) return `其余错误：${toConsole}`;
      return `其余错误：改正上面列出的问题再提交，那次回答会列出它们，但那次提交也会让错误落在其陈述里的要求项用掉一轮修复；也可${toConsole}`;
    };
    if (list.summary !== null) {
      const codesWay = record !== null ? `各代码的错误数：${readCall(record)}` : `各代码的错误数：${toConsole}`;
      pushCapped(blocks, { priority: 0, head: [list.summary.head], entries: list.summary.entries, unit: '错误代码', measure: '个', more: () => codesWay }, 2);
    }
    blocks.push({ priority: 1, head: ['错误（逐条）：'], entries: list.entries, unit: '错误', measure: '个', more: errorsMore });
  }
  if (accepted) {
    const reference = record;
    const way = (at: (from: number) => number, tokens: (from: number) => string[] | null) => (from: number): string =>
      layout !== null && reference !== null ? resultWay(reference, at(from), tokens(from), paging) : toConsole;
    if (result.cross_item.length > 0) {
      blocks.push({
        priority: 1,
        head: [`跨条目主张（不计入分区，${result.cross_item.length} 条）：`],
        entries: result.cross_item.map((claim, k) => {
          const clip = new Clip(reference === null ? null : `${reference}#/cross_item/${k}`, reference === null ? toConsole : null);
          return clip.entry(`- ${claimText(claim, clip, CLIP.field)}`);
        }),
        unit: '跨条目主张',
        measure: '条',
        more: (from) => `跨条目主张：${way((n) => (layout?.crossAt ?? 0) + n, (n) => ['cross_item', String(n)])(from)}`,
      });
    }
    const problems = problemLines(result, reference, reference === null ? toConsole : null);
    pushCapped(
      blocks,
      {
        priority: 2,
        head: [problems.length > 0 ? `问题与未知（${problems.length} 条；${PROBLEMS_HEAD}）：` : '问题与未知：没有'],
        entries: problems.map((p) => p.entry),
        unit: '问题与未知',
        measure: '条',
        more: (from) => `问题与未知：${way((n) => (layout?.problemsAt ?? 0) + n, (n) => problems[n]?.tokens ?? null)(from)}`,
      },
      3,
    );
    const all = itemsOf(result.partitions);
    if (all.length > 0) {
      blocks.push({
        priority: 4,
        head: ['条目明细（每个条目下是它的要求项和主张）：'],
        entries: all.map(({ partition, index, item }) => {
          const clip = new Clip(reference === null ? null : `${reference}#/partitions/${partition}/${index}`, reference === null ? toConsole : null);
          return clip.entry(itemBlock(partition, item, clip, CLIP));
        }),
        unit: '条目明细',
        measure: '个',
        more: (from) => `条目明细：${way((n) => layout?.itemAt[n] ?? 0, (n) => (all[n] === undefined ? null : ['partitions', all[n].partition, String(all[n].index)]))(from)}`,
      });
    }
  }
  return fit(blocks, { fallback: toConsole, tail: [traceLine(v.trace)] }).text;
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

/** Feeding disclosure participates in the same answer budget, including the fallback renderer. */
export function feedingText(text:string,value:unknown):string {
  const v=recordsOf(value),more='完整喂入清单和未知见本次回答的 structuredContent；运行详情见控制台运行页';
  const rows:string[]=[];
  if(Array.isArray(v.feeding_pending))for(const pending of v.feeding_pending){const p=recordsOf(pending);rows.push('喂入未知：'+String(p.missing)+'；下一步：'+String(p.next_action));}
  if('feeding_objects'in v)rows.push('喂入清单：'+JSON.stringify(v.feeding_objects)+('feeding_offset'in v?'；冻结序号：'+JSON.stringify(v.feeding_offset):'；缺冻结序号：旧运行需另开运行'));
  if(!rows.length)return text;
  // Fit disclosures first so that even a large feeding receipt cannot consume the whole answer.
  const disclosure=fit([{priority:0,entries:rows,unit:'喂入说明',measure:'条',more:()=>more}],{budget:6000,fallback:more}).text;
  const lines=text.split('\n'),tail=lines.splice(-2),trace=tail.pop();
  return fit([{priority:0,entries:lines,unit:'回答原文',measure:'行',more:()=>more}],{tail:[...tail,disclosure,...(trace?[trace]:[])],fallback:more}).text;
}

/** The plain text of a validated tool answer, at most TEXT_BUDGET characters, ending with the trace line. */
export function toolText(tool: string, value: unknown, context: TextContext = {}): string {
  const render = RENDERERS[tool] as ((value: unknown, context: TextContext) => string) | undefined;
  if (render === undefined) throw new Error(`no text renderer for ${tool}`);
  return render(value, context);
}

const FALLBACK_NOTE = '这次回答的文字没能排出（原因已记入管理员日志）';
const isDigestReference = (value: unknown): value is string => typeof value === 'string' && /^rec:[0-9a-f]{64}(#\S*)?$/.test(value);
const RUN_ID = /^run_[0-9a-z]{26}$/;

/**
 * The text of a valid answer whose full text could not be laid out (a defect: the server notes the reason): the outcome,
 * the receipt and counts, the run, the error codes, where the stored result is, and the trace, so that an answer that was
 * stored is never lost to its text. Reads only what it can check, and never throws.
 */
export function fallbackText(tool: string, value: unknown, context: TextContext = {}): string {
  const v = recordsOf(value);
  const lines: string[] = [];
  let run: string | null = null;
  try {
    if (isCallResult(v.call_result)) lines.push(`${axisLabel('call_result')}：${labelOf('call_result', v.call_result)}`);
    const result = recordsOf(v.result);
    if (isAcceptance(v.acceptance)) {
      const partitions = v.acceptance === 'accepted' ? Partitions.safeParse(result.partitions) : null;
      lines.push(countsLine(v.acceptance, partitions?.success === true ? partitions.data : undefined));
    }
    const codes = Array.isArray(v.errors) ? [...new Set(v.errors.map((e) => recordsOf(e).code).filter((code): code is string => typeof code === 'string'))] : [];
    if (codes.length > 0) lines.push(`错误代码：${oneLine(codes.slice(0, 20).join('、')).slice(0, 2000)}`);
    const summary = recordsOf(v.run);
    if (typeof summary.run === 'string' && RUN_ID.test(summary.run)) {
      run = summary.run;
      lines.push(`运行 ${run}${typeof summary.pack === 'string' ? `：任务包 ${oneLine(summary.pack).slice(0, CLIP.name)}` : ''}`);
    } else if (typeof result.run === 'string' && RUN_ID.test(result.run)) {
      run = result.run;
      lines.push(`运行 ${run}`);
    }
    if (tool === 'start_run' && isDigestReference(result.reference)) {
      const counts = PartitionCounts.safeParse(result.counts);
      if (counts.success) lines.push(`结果（start_run 时由 Hub 算出）：${countsText(counts.data)}`);
      lines.push(`完整结果 ${result.reference}（用 get_nodes 按引用读）`);
    }
    if (tool === 'submit_result' && isDigestReference(context.record)) lines.push(`存下的结果 ${context.record}（用 get_nodes 按引用读）`);
    const content = recordsOf(v.content);
    if (tool === 'get_nodes' && typeof content.reference === 'string') lines.push(`内容 ${oneLine(content.reference).slice(0, CLIP.path)}`);
  } catch {
    // Whatever could be read is kept; the note and the trace still follow.
  }
  const where = run !== null ? `；回答本身有效；完整内容${seeConsole(run)}` : lines.length > 0 ? '；回答本身有效' : '';
  lines.push(`${FALLBACK_NOTE}${where}`);
  lines.push(traceLine(typeof v.trace === 'string' ? oneLine(v.trace).slice(0, 64) : '（未知）'));
  return lines.join('\n');
}

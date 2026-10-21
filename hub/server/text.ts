// The Chinese plain text of every tool answer (D05 R[0], R[1], R[6]; display rules 0 and 11). It is the only content block, so
// it carries what a model needs to work from it alone: the receipt, partition counts and unknown count first for a
// submission (unknown is never an error), every item of the partition list with its requirements and the fields of their
// claims in DISPLAY_ORDER, every run item as id, label and summary (the contracts' rule for long lists), the slot schema,
// and the text of a source read by reference. structuredContent holds the same answer as JSON.
import type { z } from 'zod';
import { PARTITION, axisLabel, labelOf } from '../../contracts/generated/vocabulary.ts';
import type { Claim } from '../../contracts/src/claim.ts';
import type { ProtocolError } from '../../contracts/src/common.ts';
import type {
  GetNodesOutput,
  ListTaskPacksOutput,
  ResolveReferenceOutput,
  StartRunOutput,
  SubmitResultOutput,
  UploadFileOutput,
} from '../../contracts/src/tools.ts';
import { partitionCountsOf, type Partitions } from '../../contracts/src/validation.ts';
import { claimFields, coverageText, terminalText } from './claims.ts';

/** Up to this many items the start_run text also gives each item's location; a longer list is id, label and summary only. */
const LOCATED_ITEMS = 50;

type ListOut = z.infer<typeof ListTaskPacksOutput>;
type UploadOut = z.infer<typeof UploadFileOutput>;
type StartOut = z.infer<typeof StartRunOutput>;
type NodesOut = z.infer<typeof GetNodesOutput>;
type ResolveOut = z.infer<typeof ResolveReferenceOutput>;
type SubmitOut = z.infer<typeof SubmitResultOutput>;

export function errorLine(e: ProtocolError): string {
  const parts = [`- ${e.code}：${e.message}`];
  if (e.fix) parts.push(`修正：${e.fix}`);
  if (e.path !== undefined) parts.push(`位置 ${e.path === '' ? '（整份）' : e.path}`);
  if (e.item !== undefined) parts.push(`条目 ${e.item}`);
  if (e.requirement !== undefined) parts.push(`要求项 ${e.requirement}`);
  if (e.rounds_left !== undefined) parts.push(`剩余修复轮数 ${e.rounds_left}`);
  if (e.options !== undefined && e.options.length > 0) parts.push(`可选：${e.options.join('、')}`);
  return parts.join('；');
}

/** One claim on one line: its fields in DISPLAY_ORDER, as label：text. */
export function claimLine(claim: Claim): string {
  return claimFields(claim)
    .map(([label, text]) => `${label}：${text}`)
    .join('；');
}

/** A value of a structure summary or of entry data on one line: scalars as they are, anything else as compact JSON. */
function valueText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return String(value);
  return JSON.stringify(value) ?? '';
}

/** The fields of a summary object as key value pairs on one line. */
function fieldsText(summary: Record<string, unknown>): string {
  return Object.entries(summary)
    .map(([key, value]) => `${key} ${valueText(value)}`)
    .join('，');
}

function failure(errors: ProtocolError[]): string {
  return `${labelOf('call_result', 'error')}：${[...new Set(errors.map((e) => e.code))].join('、')}`;
}

function trailer(lines: string[], value: { trace: string; errors: ProtocolError[] }, withErrors = true): string {
  if (withErrors && value.errors.length > 0) lines.push('错误与修正：', ...value.errors.map(errorLine));
  lines.push(`追踪 ${value.trace}`);
  return lines.join('\n');
}

function listText(v: ListOut): string {
  if (v.call_result === 'error') return trailer([failure(v.errors)], v);
  const lines = [`可用的任务包 ${v.packs.length} 个`];
  for (const p of v.packs) {
    lines.push(`- ${p.pack} ${p.title}（${labelOf('pack_kind', p.kind)}）：${p.description}`);
    if (p.products.length > 0) lines.push(`  产品：${p.products.join('、')}`);
    for (const input of p.inputs) {
      lines.push(`  输入 ${input.slot}（${labelOf('source_role', input.role)}，${input.required ? '必填' : '可选'}${input.many ? '，可多个' : ''}）：${input.description}；接受 ${input.accepts.join('、')}`);
    }
    for (const parameter of p.parameters) lines.push(`  参数 ${parameter.name}（${parameter.required ? '必填' : '可选'}）：${parameter.description}`);
    for (const r of p.requirements) {
      lines.push(`  要求项 ${r.key} ${r.name}：${labelOf('accepted_producer', r.accepted_producer)}；${axisLabel('layer')} ${r.layers.map((l) => labelOf('layer', l)).join('、')}；${labelOf('done_rule', r.done_rule)}`);
    }
  }
  return trailer(lines, v, false);
}

/** The parser that recognised the bytes and its structure summary (counts and shape, never text). */
function structureLines(structure: Record<string, unknown> | undefined): string[] {
  if (structure === undefined) return [];
  const { parser, summary, ...rest } = structure;
  const fields = typeof summary === 'object' && summary !== null && !Array.isArray(summary) ? (summary as Record<string, unknown>) : summary === undefined ? {} : { summary };
  const text = fieldsText({ ...fields, ...rest });
  const lines = typeof parser === 'string' ? [`解析器 ${parser} 认出了这份文件`] : [];
  lines.push(`结构摘要：${text.length > 0 ? text : '（空）'}`);
  return lines;
}

function uploadText(v: UploadOut): string {
  const lines = [`${axisLabel('acceptance')}：${labelOf('acceptance', v.acceptance)}${v.reference ? `，引用 ${v.reference}` : ''}`];
  if (v.size !== undefined) lines.push(`大小 ${v.size} 字节${v.media_type ? `，媒体类型 ${v.media_type}` : ''}`);
  if (v.sha256 !== undefined) lines.push(`sha256 ${v.sha256}`);
  if (v.acceptance === 'accepted') lines.push(...(v.structure === undefined ? ['没有核心解析器认出这份文件'] : structureLines(v.structure)));
  return trailer(lines, v);
}

function startText(v: StartOut): string {
  if (v.call_result === 'error' || v.run === undefined) return trailer([failure(v.errors)], v);
  const r = v.run;
  const lines = [`运行 ${r.run}：任务包 ${r.pack}，条目 ${r.items.length} 个，要求项 ${r.requirements.length} 个`];
  const target = [r.product && `产品 ${r.product}`, r.version && `版本 ${r.version}`, r.build && `构建 ${r.build}`].filter(Boolean);
  if (target.length > 0) lines.push(target.join('，'));
  if (r.root !== undefined) lines.push(`锁定的知识根 ${r.root}`);
  if (r.predecessor !== undefined) lines.push(`前驱运行 ${r.predecessor}`);
  if (r.target_basis.length > 0) {
    lines.push('版本依据：');
    for (const claim of r.target_basis) lines.push(`- ${claimLine(claim)}`);
  }
  if (r.sources.length > 0) {
    lines.push('来源：');
    for (const s of r.sources) {
      lines.push(`- ${labelOf('source_role', s.role)} ${s.reference}${s.slot ? `，输入 ${s.slot}` : ''}${s.external ? `，外部对象 ${s.external}` : ''}${s.label ? `，${s.label}` : ''}`);
    }
  }
  lines.push('要求项：');
  for (const q of r.requirements) {
    lines.push(`- ${q.key} ${q.name}：${labelOf('accepted_producer', q.accepted_producer)}；${axisLabel('layer')} ${q.layers.map((l) => labelOf('layer', l)).join('、')}（其他层不适用）；${labelOf('done_rule', q.done_rule)}；修复轮数 ${q.repair_rounds}`);
  }
  const located = r.items.length <= LOCATED_ITEMS;
  lines.push(located ? `条目（${r.items.length} 个）：` : `条目（${r.items.length} 个，多于 ${LOCATED_ITEMS} 个时只列编号、名称和摘要）：`);
  for (const item of r.items) {
    const parts = [`- ${item.id} ${item.label}${item.summary ? `：${item.summary}` : ''}`];
    if (located) parts.push(`（位置 ${item.location}）`);
    if (item.reuse) parts.push(`，可沿用 ${item.reuse}`);
    lines.push(parts.join(''));
  }
  if (r.slots !== undefined) lines.push(`槽位模式（JSON Schema，sha256 ${r.slots.sha256}）：`, JSON.stringify(r.slots.schema));
  lines.push('规程：', r.instructions);
  return trailer(lines, v);
}

function nodesText(v: NodesOut): string {
  if (v.call_result === 'error') return trailer([failure(v.errors)], v);
  if (v.content !== undefined) {
    const c = v.content;
    const lines = [`内容 ${c.reference}：${labelOf('read_tier', c.read_tier)}`];
    if (c.sha256 !== undefined) lines.push(`sha256 ${c.sha256}`);
    if (c.note !== undefined) lines.push(c.note);
    if (c.structure !== undefined) lines.push(...structureLines(c.structure));
    if (c.text !== undefined) lines.push(`原文（${c.text.length} 个字符）：`, c.text);
    return trailer(lines, v);
  }
  const nodes = v.nodes ?? [];
  const lines = [`知识根 ${v.root ?? ''}：节点 ${nodes.length} 个`];
  const covered = coverageText(v.coverage);
  if (covered !== null) lines.push(`覆盖：${covered}`);
  if (typeof v.next === 'string') lines.push(`还有下一页：cursor ${v.next}`);
  for (const node of nodes) {
    lines.push(`- ${node.path}（${node.level}）${node.name}：子节点 ${node.children.length} 个，条目 ${node.entries.length} 个；引用 ${node.reference}`);
    for (const child of node.children) lines.push(`  子节点 ${child.path} ${child.name}`);
    for (const entry of node.entries) {
      lines.push(`  · [${entry.kind}] ${entry.statement}（适用 ${entry.applicability}）；引用 ${entry.reference}${entry.data === undefined ? '' : `；数据 ${JSON.stringify(entry.data)}`}`);
    }
  }
  return trailer(lines, v);
}

function resolveText(v: ResolveOut): string {
  if (v.call_result === 'error' || v.resolution === undefined) return trailer([failure(v.errors)], v);
  const lines = [`${axisLabel('resolution')}：${labelOf('resolution', v.resolution)}，可能所指 ${v.references.length} 个（预览，不作凭据）`];
  for (const r of v.references) lines.push(`- ${r.reference}：${r.text}${r.role ? `（${labelOf('source_role', r.role)}）` : ''}`);
  for (const d of v.diagnostics) lines.push(`诊断：${d}`);
  return trailer(lines, v);
}

/** The partition counts line: receipt, items per partition and the items with an unknown terminal. */
export function countsLine(acceptance: SubmitOut['acceptance'], partitions: Partitions | undefined): string {
  const receipt = `${axisLabel('acceptance')}：${labelOf('acceptance', acceptance)}`;
  if (partitions === undefined) return `${receipt}；没有分区（未受理的提交不分区）`;
  const counts = partitionCountsOf(partitions);
  const parts = PARTITION.map((p) => `${labelOf('partition', p)} ${counts[p]}`);
  return `${receipt}；${axisLabel('partition')}：${parts.join('，')}；${labelOf('nature', 'unknown')} ${counts.unknown}`;
}

function submitText(v: SubmitOut): string {
  const accepted = v.acceptance === 'accepted' && v.result !== undefined;
  const lines = [countsLine(v.acceptance, accepted ? v.result?.partitions : undefined)];
  const result = v.result;
  if (result !== undefined) {
    lines.push(`修复轮数：已用 ${result.rounds.used}，最多 ${result.rounds.max}`);
    const covered = coverageText(result.coverage);
    if (covered !== null) lines.push(`覆盖：${covered}`);
    lines.push(`锁定：任务包 ${result.locks.pack}${result.locks.root ? `，知识根 ${result.locks.root}` : ''}`);
    for (const p of PARTITION) {
      const items = result.partitions[p];
      if (items.length === 0) continue;
      lines.push(`${labelOf('partition', p)}：`);
      for (const item of items) {
        const why = 'code' in item ? `，${item.code}` : 'reason' in item ? `，${labelOf('reason', item.reason)}` : '';
        lines.push(`- ${item.item} ${item.label}${why}${item.carried_over ? `，沿用 ${item.carried_over}` : ''}`);
        for (const r of item.requirements) {
          const status = `${labelOf('requirement_status', r.status)}${r.unsatisfied_reason ? `（${labelOf('unsatisfied_reason', r.unsatisfied_reason)}）` : ''}`;
          lines.push(`  · ${r.requirement}：${r.layers.map(terminalText).join('；') || '没有判定层'}；${status}`);
          // D05 R[6]: every item of the partition list carries the fields of its claims.
          for (const claim of r.claims) lines.push(`    - ${claimLine(claim)}`);
        }
      }
    }
    if (result.cross_item.length > 0) {
      lines.push('跨条目主张（不计入分区）：');
      for (const claim of result.cross_item) lines.push(`- ${claimLine(claim)}`);
    }
  }
  return trailer(lines, v);
}

const RENDERERS: Record<string, (value: never) => string> = {
  list_task_packs: listText,
  upload_file: uploadText,
  start_run: startText,
  get_nodes: nodesText,
  resolve_reference: resolveText,
  submit_result: submitText,
};

/** The plain text of a validated tool answer. */
export function toolText(tool: string, value: unknown): string {
  const render = RENDERERS[tool] as ((value: unknown) => string) | undefined;
  if (render === undefined) throw new Error(`no text renderer for ${tool}`);
  return render(value);
}

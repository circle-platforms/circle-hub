// The projection of the workflow (workflow@1 projection, ProjectionInput -> ProjectionOutput): the cases of the mind map bound
// to the subject slot, by projectItems (project.ts). The document id is the agile document id of an external input
// (agile:mindmap:<id>), else the mind-map root's id. Parameters (workflow.json names): case_rule, case_priority, group_priority,
// precondition_priority (caseRule ... of project.ts); block: one subtree (a node id, or the texts of the nodes from the root
// down to it); slice: the cases from..to of the target (or of the block) in document order. A run has at most MAX_ITEMS
// items (the client reads about 50,000 characters of a tool result): a bigger target is refused with a fix that names the
// blocks and the slices that reach every case. Every item carries a summary line of at most 200 characters (path, tags,
// priority, expected result; the label is the case title), because a model reads items as id, label and summary only.
// The whole document is projected without the sandbox's output limit and only the run's part is bounded by it, so a block
// of a document whose whole projection would be too large still projects. A scope group freezes the effective recognition
// parameters and every expected item of the root or explicit block, plus this slice's selected ids, for later reconciliation.
import type { BoundInput, ProjectedItem, ProjectionOutput } from '../../../../contracts/src/pack.ts';
import { failure, guarded, isRecord, withWorkflowNames } from './common.ts';
import { LIMITS, projectItems, resolvedCaseParameters } from './project.ts';
import { createReviewScope, REVIEW_SCOPE_GROUP } from './review-scope.ts';
import { clip, collapseWhitespace, utf8Length } from './text.ts';
import type { CaseItem, GroupEntry, KityMinderModel, MindMapNode, PackError, Warning } from './types.ts';

export const SUBJECT_SLOT = 'subject';
/** Most items of one run (a tool result of about 50,000 characters or more never reaches the model). */
export const MAX_ITEMS = 100;
export const MAX_SUMMARY = 200;
/** Blocks named in the fix of a refusal. */
const MAX_LISTED = 40;
/** Characters of a fix the server shows of a refusal (hub/server text: CLIP.fix); the plan is chosen to stay readable in them. */
const SHOWN_FIX = 500;
/** Levels of groups a block plan descends. */
const MAX_PLAN_DEPTH = 8;
/** Run parameters (workflow.json names) of the case rule, and the names project.ts reads them under. */
export const CASE_PARAMETERS = { case_rule: 'caseRule', case_priority: 'casePriority', group_priority: 'groupPriority', precondition_priority: 'preconditionPriority' } as const;

type Model = KityMinderModel;

/** The document id of the subject: the agile document id, the meta id, else the root node's id. */
export function documentIdOf(subject: Pick<BoundInput, 'external' | 'meta' | 'model'>): string {
  const external = typeof subject.external === 'string' ? /^agile:mindmap:([^@]+)/.exec(subject.external) : null;
  if (external !== null) return external[1];
  const meta = isRecord(subject.meta) ? subject.meta : {};
  if (typeof meta.id === 'string' && meta.id !== '') return meta.id;
  const model = subject.model as Model | null;
  const root = isRecord(model) && Array.isArray(model.nodes) ? model.nodes[0] : undefined;
  return root !== undefined && typeof root.id === 'string' && root.id !== '' ? root.id : 'document';
}

const textKey = (text: string): string => collapseWhitespace(text);

/** The node indices of a block parameter: a node id, or node texts from the root (or from its children) down. */
export function blockNodes(model: Model, block: unknown): number[] {
  const nodes = model.nodes;
  if (typeof block === 'string') {
    if (model.duplicateIds.includes(block)) return nodes.flatMap((n, k) => (n.id === block ? [k] : []));
    const k = nodes.findIndex((n) => n.id === block);
    return k < 0 ? [] : [k];
  }
  if (!Array.isArray(block) || block.length === 0 || !block.every((s) => typeof s === 'string')) return [];
  const wanted = (block as string[]).map(textKey);
  const out: number[] = [];
  nodes.forEach((node, k) => {
    const chain: MindMapNode[] = [];
    for (let at: number | null = k; at !== null && chain.length <= wanted.length; at = nodes[at].parent) chain.unshift(nodes[at]);
    const texts = chain.map((n) => textKey(n.text));
    const fromRoot = texts.length === wanted.length && texts.every((t, i) => t === wanted[i]) && chain[0] === nodes[0];
    const belowRoot = texts.length === wanted.length + 1 && chain[0] === nodes[0] && texts.slice(1).every((t, i) => t === wanted[i]);
    if (fromRoot || belowRoot) out.push(k);
  });
  return out;
}

/** Whether node `k` is `top` or lies below it. */
function within(model: Model, k: number, top: number): boolean {
  for (let at: number | null = k; at !== null; at = model.nodes[at].parent) if (at === top) return true;
  return false;
}

/** The node path of a node as a block parameter: its id when it names one node, else its texts from the root's child down. */
function blockValue(model: Model, k: number): string {
  const node = model.nodes[k];
  if (node.id !== null && !model.duplicateIds.includes(node.id)) return JSON.stringify(node.id);
  const texts: string[] = [];
  for (let at: number | null = k; at !== null && at !== 0; at = model.nodes[at].parent) texts.unshift(collapseWhitespace(model.nodes[at].text));
  return JSON.stringify(texts);
}

type Listed = { node: number; label: string; cases: number };

/** The groups below `top`, each with its case count and its outermost subgroups, and the cases below `top` in no group. */
function groupTree(model: Model, groups: readonly GroupEntry[], cases: readonly number[], top: number): { count: Map<number, number>; children: Map<number, number[]>; label: (k: number) => string; loose: number } {
  const bySelector = new Map(model.nodes.map((n, k) => [n.selector, k]));
  const labels = new Map<number, string>();
  for (const g of groups) {
    const k = bySelector.get(g.location.selector);
    if (k !== undefined && k !== top && within(model, k, top)) labels.set(k, g.label);
  }
  const count = new Map<number, number>();
  let loose = 0;
  for (const c of cases) {
    if (!within(model, c, top)) continue;
    let grouped = false;
    for (let at = model.nodes[c].parent; at !== null && at !== top; at = model.nodes[at].parent) {
      if (!labels.has(at)) continue;
      count.set(at, (count.get(at) ?? 0) + 1);
      grouped = true;
    }
    if (!grouped) loose += 1;
  }
  const children = new Map<number, number[]>();
  for (const k of labels.keys()) {
    let parent = top;
    for (let at = model.nodes[k].parent; at !== null && at !== top; at = model.nodes[at].parent) {
      if (labels.has(at)) {
        parent = at;
        break;
      }
    }
    children.set(parent, [...(children.get(parent) ?? []), k]);
  }
  for (const list of children.values()) list.sort((a, b) => a - b);
  return { count, children, label: (k) => labels.get(k) ?? collapseWhitespace(model.nodes[k].text), loose };
}

/** The outermost groups below `top` that hold cases, with their case counts (a group of more than MAX_ITEMS included). */
export function outerGroups(model: Model, groups: readonly GroupEntry[], cases: readonly number[], top: number): { groups: Listed[]; loose: number } {
  const tree = groupTree(model, groups, cases, top);
  const listed = (tree.children.get(top) ?? []).filter((k) => (tree.count.get(k) ?? 0) > 0).map((k) => ({ node: k, label: tree.label(k), cases: tree.count.get(k) ?? 0 }));
  return { groups: listed, loose: tree.loose };
}

/**
 * Blocks of at most MAX_ITEMS cases under `top`: the outermost groups, a bigger group replaced by its own blocks when they
 * hold all of its cases. A bigger group with cases outside its subgroups (or deeper than the plan descends) is `tooBig`: it is
 * reviewed in slices as a whole, and its cases are not loose. `loose` counts the cases below `top` in no group.
 */
export function blocksOf(model: Model, groups: readonly GroupEntry[], cases: readonly number[], top: number): { blocks: Listed[]; loose: number; tooBig: Listed[] } {
  const tree = groupTree(model, groups, cases, top);
  const entry = (k: number): Listed => ({ node: k, label: tree.label(k), cases: tree.count.get(k) ?? 0 });
  const plan = (k: number, depth: number): { blocks: Listed[]; tooBig: Listed[] } => {
    const n = tree.count.get(k) ?? 0;
    if (n <= MAX_ITEMS) return { blocks: [entry(k)], tooBig: [] };
    if (depth >= MAX_PLAN_DEPTH) return { blocks: [], tooBig: [entry(k)] };
    const blocks: Listed[] = [];
    const tooBig: Listed[] = [];
    let covered = 0;
    for (const child of tree.children.get(k) ?? []) {
      if ((tree.count.get(child) ?? 0) === 0) continue;
      const sub = plan(child, depth + 1);
      blocks.push(...sub.blocks);
      tooBig.push(...sub.tooBig);
      covered += tree.count.get(child) ?? 0;
    }
    // Cases of the group that sit in none of its subgroups: no subtree holds exactly them, so the group is sliced whole.
    return covered < n ? { blocks: [], tooBig: [entry(k)] } : { blocks, tooBig };
  };
  const blocks: Listed[] = [];
  const tooBig: Listed[] = [];
  for (const k of tree.children.get(top) ?? []) {
    if ((tree.count.get(k) ?? 0) === 0) continue;
    const sub = plan(k, 0);
    blocks.push(...sub.blocks);
    tooBig.push(...sub.tooBig);
  }
  return { blocks, loose: tree.loose, tooBig };
}

/** One line about a case for the model: the path below the document title, tags, negative, priority, steps, first expected result. */
export function summaryOf(item: CaseItem): string {
  const f = item.fields;
  const parts: string[] = [];
  const path = f.path.slice(1);
  if (path.length > 0) parts.push(clip(collapseWhitespace(path.slice(-2).join(' › ')), 48).text);
  const tags = f.tags.filter((t) => collapseWhitespace(t) !== '');
  parts.push(tags.length > 0 ? `标签 ${clip(tags.join(','), 30).text}` : '无标签');
  if (f.negative === true) parts.push('反向');
  if (f.priority !== null) parts.push(`优先级 ${clip(String(f.priority), 6).text}`);
  if (f.steps.length > 0) parts.push(`${f.steps.length} 步`);
  if (f.preconditions.length > 0) parts.push(`前置 ${f.preconditions.length} 条`);
  parts.push(f.expectedCount === 0 ? '无期望结果' : `期望：${clip(collapseWhitespace(f.expected[0] ?? ''), 64).text}${f.expectedCount > 1 ? `（共 ${f.expectedCount} 条）` : ''}`);
  return clip(parts.join('｜'), MAX_SUMMARY).text;
}

/** The slice parameter: { from, to } with 1 <= from <= to, at most MAX_ITEMS cases; anything else is a reason, null when absent. */
function readSlice(value: unknown): { from: number; to: number } | string | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value) || !Number.isSafeInteger(value.from) || !Number.isSafeInteger(value.to)) return 'slice 写成 {"from": 起, "to": 止}，两个都是从 1 数的整数';
  const from = value.from as number;
  const to = value.to as number;
  if (from < 1 || to < from) return `slice 的 from（${from}）要不小于 1，to（${to}）要不小于 from`;
  if (to - from + 1 > MAX_ITEMS) return `slice 从 ${from} 到 ${to} 有 ${to - from + 1} 个用例，一段最多 ${MAX_ITEMS} 个`;
  return { from, to };
}

const sliceText = (from: number, to: number): string => `slice={"from":${from},"to":${to}}`;

/** The fix of a target of more than MAX_ITEMS cases: one run per part, the worst verdict, the slices, then the group blocks. */
function tooManyFix(model: Model, groups: readonly GroupEntry[], cases: readonly number[], top: number): string {
  const n = cases.length;
  const segments = Math.ceil(n / MAX_ITEMS);
  const head = '每一块单独开始一次评审运行，各块独立初评、独立复核，整体结论取各块中最差的（FAIL 重于 PARTIAL 重于 PASS）。';
  const slices = `按用例顺序分段：参数 ${sliceText(1, MAX_ITEMS)}，下一段 from ${MAX_ITEMS + 1}，每段至多 ${MAX_ITEMS} 个，共 ${segments} 段${top !== 0 ? '（和这里的 block 一起写）' : ''}。`;
  const plan = blocksOf(model, groups, cases, top);
  const entry = (b: Listed, note = ''): string => `block=${blockValue(model, b.node)}（${clip(b.label, 16).text}，${b.cases} 例${note}）`;
  const flat = plan.blocks.map((b) => entry(b));
  const room = SHOWN_FIX - head.length - slices.length - '按分组分块（参数 block，优先）：'.length;
  const notes: string[] = [];
  let listing: string[];
  if (plan.tooBig.length === 0 && plan.loose === 0 && flat.join('；').length <= room) {
    listing = flat;
    notes.push('这些分块合起来是全部用例');
  } else {
    // The outermost groups: few, and a group of more than MAX_ITEMS cases is refused again with its own blocks, or sliced.
    const outer = outerGroups(model, groups, cases, top);
    listing = outer.groups.map((g) => entry(g, g.cases > MAX_ITEMS ? '，要再分：用它作 block 开始运行会列出它下面的分块，或者再加 slice' : ''));
    if (plan.loose === 0 && outer.groups.every((g) => g.cases <= MAX_ITEMS)) notes.push('这些分块合起来是全部用例');
    if (plan.loose > 0) {
      notes.push(
        top === 0
          ? `另有 ${plan.loose} 例不在任何分组下，只能按 slice 分段评审（分段和分组二选一，不要重叠）`
          : `其中 ${plan.loose} 例不在更小的分组里，按 slice 分段评审这一块（分段和分组二选一，不要重叠）`,
      );
    }
  }
  if (listing.length > MAX_LISTED) notes.push(`另有 ${listing.length - MAX_LISTED} 个分组没有列出，按 slice 分段可以覆盖全部用例`);
  if (listing.length === 0) return `${head}${slices}${top === 0 ? '这份脑图里没有分组节点' : '这一块里没有更小的分组'}，按上面的 slice 分段。`;
  return `${head}${slices}按分组分块（参数 block，优先）：${listing.slice(0, MAX_LISTED).join('；')}${notes.length > 0 ? `。${notes.join('；')}` : ''}`;
}

export function projection(input: unknown): ProjectionOutput {
  if (!isRecord(input) || !Array.isArray(input.inputs)) return failure('invalid_input', '输入里没有 inputs 数组', '按 projection-input@1 传入（Hub 自己调用时总是这样）');
  const subject = (input.inputs as unknown[]).find((i): i is BoundInput => isRecord(i) && i.slot === SUBJECT_SLOT) as BoundInput | undefined;
  if (subject === undefined) return failure('invalid_input', '没有绑定被评审的脑图（输入槽 subject）', '在 inputs.subject 里给出脑图');
  if (subject.parser !== 'kityminder@1' || !isRecord(subject.model)) {
    return failure('invalid_input', `被评审的源文件不是 KityMinder 脑图（解析器 ${String(subject.parser)}）`, '给出敏捷平台的脑图（agile:mindmap:<文档编号>）或上传 KityMinder 导出的 JSON');
  }
  const model = subject.model as unknown as Model;
  const parameters = isRecord(input.parameters) ? input.parameters : {};
  const own: Record<string, unknown> = {};
  for (const [name, inner] of Object.entries(CASE_PARAMETERS)) if (Object.hasOwn(parameters, name)) own[inner] = parameters[name];
  const documentId = documentIdOf(subject);
  // The whole document, unbounded: the run gets at most one block of it, bounded below.
  const projected = projectItems({ documents: [{ slot: SUBJECT_SLOT, documentId, model }], parameters: own, limits: { outputBytes: Number.POSITIVE_INFINITY } });
  if ('error' in projected) return { error: projected.error, warnings: projected.warnings };
  const bySelector = new Map(model.nodes.map((n, k) => [n.selector, k]));
  const nodeOf = (item: { location: { selector: string } }): number => bySelector.get(item.location.selector) ?? -1;
  const warnings: Warning[] = projected.warnings;

  let top = 0;
  const block = parameters.block;
  if (block !== undefined && block !== null) {
    const found = blockNodes(model, block);
    if (found.length === 0) {
      const outer = outerGroups(model, projected.groups, projected.items.map(nodeOf), 0).groups.slice(0, MAX_LISTED);
      const options = outer.map((g) => `${blockValue(model, g.node)}（${clip(g.label, 16).text}，${g.cases} 例）`).join('；');
      return failure('block_not_found', `参数 block 指定的子树在脑图里找不到：${clip(JSON.stringify(block), 120).text}`, `block 写一个节点编号（data.id），或从根往下的节点文字列表；最外层的分组：${options || '（没有分组节点）'}`, warnings, [documentId]);
    }
    if (found.length > 1) {
      return failure('block_ambiguous', `参数 block 指定的子树在脑图里有 ${found.length} 处`, `改用其中一处的节点编号：${found.slice(0, 10).map((k) => blockValue(model, k)).join('、')}`, warnings, [documentId]);
    }
    top = found[0];
  }
  const inBlock = projected.items.filter((item) => within(model, nodeOf(item), top));
  const where = top === 0 ? '这份脑图' : `子树“${clip(collapseWhitespace(model.nodes[top].text), 40).text}”`;
  if (inBlock.length === 0) {
    return failure('no_case', `参数 block 指定的子树（${clip(collapseWhitespace(model.nodes[top].text), 60).text}）里没有用例`, '换一个有用例的子树，或者去掉 block 参数', warnings, [documentId]);
  }
  const slice = readSlice(parameters.slice);
  if (typeof slice === 'string') return failure('slice_invalid', `参数 slice 无效：${slice}`, `${where}有 ${inBlock.length} 个用例；slice 写 {"from": 起, "to": 止}，1 ≤ 起 ≤ 止，一段至多 ${MAX_ITEMS} 个`, warnings, [documentId]);
  if (slice !== null && slice.from > inBlock.length) {
    return failure('slice_invalid', `参数 slice 从第 ${slice.from} 个用例开始，${where}只有 ${inBlock.length} 个用例`, `slice 的 from 写 1 到 ${inBlock.length} 之间的数`, warnings, [documentId]);
  }
  const selected = slice === null ? inBlock : inBlock.slice(slice.from - 1, Math.min(slice.to, inBlock.length));
  if (selected.length > MAX_ITEMS) {
    return failure('too_many_cases', `${where}有 ${inBlock.length} 个用例，超过一次运行最多 ${MAX_ITEMS} 个条目`, tooManyFix(model, projected.groups, inBlock.map(nodeOf), top), warnings, [documentId]);
  }
  const recognition = resolvedCaseParameters(own);
  const caseRule = recognition.caseRule;
  const marked_only = caseRule === 'marked' ? selected.filter((item) => item.fields.tags.length === 0).length : 0;
  const ruleSummary = `用例规则：${caseRule === 'marked' ? '标签或标记' : '只认标签'}；其中 ${marked_only} 个只靠标记识别（没有标签）`;
  const items: ProjectedItem[] = selected.map((item) => ({
    id: item.id,
    label: item.label,
    summary: summaryOf(item),
    location: { slot: SUBJECT_SLOT, parser: item.location.parser, selector: item.location.selector },
    fields: { ...(item.fields as unknown as Record<string, unknown>), case_rule: caseRule, marked_only },
  }));
  // The groups the run's cases sit in (with a slice), else every group of the block.
  const holding = new Set<number>();
  if (slice !== null) for (const item of selected) for (let at = model.nodes[nodeOf(item)].parent; at !== null; at = model.nodes[at].parent) holding.add(at);
  const groups: Record<string, unknown>[] = projected.groups
    .filter((g) => {
      const k = bySelector.get(g.location.selector) ?? -1;
      return within(model, k, top) && (slice === null || holding.has(k));
    })
    .map((g) => ({ kind: 'group', id: g.id, label: g.label, selector: g.location.selector, priority: g.priority, cases: g.cases }));
  groups.unshift({
    kind: 'document',
    id: documentId,
    title: collapseWhitespace(model.nodes[0]?.text ?? ''),
    cases: selected.length,
    case_rule: caseRule,
    marked_only,
    rule_summary: ruleSummary,
    data: { case_rule: caseRule, marked_only },
    ...(top !== 0 ? { block: { selector: model.nodes[top].selector, label: collapseWhitespace(model.nodes[top].text), value: JSON.parse(blockValue(model, top)) as unknown } } : {}),
    ...(slice !== null ? { slice: { from: slice.from, to: slice.from + selected.length - 1, of: inBlock.length } } : {}),
  });
  groups.push({ kind: REVIEW_SCOPE_GROUP, data: { review_scope: createReviewScope({
    source: subject.sha256,
    document: documentId,
    parameters: { case_rule: caseRule, case_priority: recognition.casePriority, group_priority: recognition.groupPriority, precondition_priority: recognition.preconditionPriority },
    expected: inBlock.map(item => ({ item: item.id, location: `src:${subject.sha256}/${item.location.parser}/${item.location.selector}` })),
    selected: selected.map(item => item.id),
  }) } });
  const unnumbered = projected.unnumbered.filter((id) => selected.some((item) => item.id === id));
  if (unnumbered.length > 0) groups.push({ kind: 'unnumbered', items: unnumbered });
  const output = { items, groups, warnings };
  // The run's part is bounded by the sandbox's output limit (texts of up to 4,000 characters and lists of up to 100 entries).
  const bytes = utf8Length(JSON.stringify(output));
  if (bytes > LIMITS.outputBytes) {
    return failure('too_large', `${where}这一段的投影结果有 ${bytes} 字节，超过输出上限 ${LIMITS.outputBytes} 字节`, '用更小的分块或分段开始运行（参数 block、slice）', [], [documentId]);
  }
  return output;
}

export default function (input: unknown): unknown {
  return guarded(() => withWorkflowNames(projection(input) as { warnings: Warning[]; error?: PackError }));
}

// Injects known defects into a copy of a KityMinder export and writes down what was injected, so that the review of the copy
// can be scored against an answer that is independent of the Hub (brief section 6b, review). The source is never changed; the
// copy and the gold hold real content and belong outside Git.
import { createHash, randomUUID } from 'node:crypto';
import { goldQuoteContains } from '../gold/quote-widths.ts';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { VAGUE_EXPECTED, caseGold, caseNodesOf, foldKey, parseMindMap } from '../gold/cases.ts';

export const PUBLIC_REFUSALS = {
  gold_kind_missing:'标准答案没有 kind：用现在的 inject-defects.ts 重新注入',
  blank_tags:'这个用例的读法在 gold/cases.ts 和 Hub 之间不一致（空标签）：换一个用例',
  keep_invalid:'--keep 必须为正整数',
  session_json:'会话 JSON 无效，重新导出后重跑',
  session_unreadable:'会话文件不可读，补取后重跑',
  session_shape:'会话 JSON 要有字符串 args 数组和 prompt，从会话文件修正后重跑',
  session_reserved:'会话 args 含驱动保留标志，从会话文件删除后重跑',
} as const;
export type PublicRefusalReason = keyof typeof PUBLIC_REFUSALS;
export class PublicRefusal extends Error {
  readonly reason: PublicRefusalReason;
  constructor(reason: PublicRefusalReason, index?: number) {
    super(reason === 'gold_kind_missing' ? `标准答案第 ${index ?? 1} 条没有 kind：用现在的 inject-defects.ts 重新注入` : PUBLIC_REFUSALS[reason]);
    this.reason = reason; this.name = 'PublicRefusal';
  }
}

const INJECTION_REASONS = {
  node_not_found:'目标节点不存在', root_change:'根节点不能执行此操作', group_not_group:'目标是用例，不是分组',
  group_empty:'分组没有用例', group_not_negative:'分组包含非反向用例', empty_operand:'from、to、quote 或 text 必须为非空文本',
  seen_by:'seen_by 不符合可见性', missing_manual:'缺少 --manual 输入', quote_not_verbatim:'quote 不在片段里或格式不合法',
  to_in_quote:'to 不构成矛盾', target_not_case:'目标不是当前规则下的用例', from_not_found:'期望中找不到 from',
  vague_not_word:'text 不在含糊期望词表', no_expected:'用例没有期望结果', already_vague:'用例期望结果已经全是含糊的',
  vague_not_unique:'注入未唯一改变目标用例', word_not_found:'用例命令中找不到 from', move_target_case:'移动目标不是分组',
  unexpected:'注入脚本异常，请按私有诊断修正后重跑',
} as const;
export type InjectionReason = keyof typeof INJECTION_REASONS;
export class InjectionConditionError extends Error {
  readonly reason: InjectionReason;
  constructor(reason: InjectionReason, detail: string) { super(detail); this.name='InjectionConditionError'; this.reason=reason; }
}

export interface MindNode {
  data: { id?: string; text?: string; resource?: string[]; [key: string]: unknown };
  children?: MindNode[];
}
export interface MindTree {
  root: MindNode;
  [key: string]: unknown;
}

/** What one injection does. A case is a tagged node (data.resource); its children are its expected results. */
export type Operation =
  | { kind: 'delete_expected'; node: string }
  | { kind: 'replace_expected'; node: string; text: string }
  | { kind: 'duplicate'; node: string }
  | { kind: 'move'; node: string; to: string }
  | { kind: 'replace_command_word'; node: string; from: string; to: string }
  | { kind: 'delete_negative_group'; node: string }
  | { kind: 'contradict_manual'; node: string; from: string; to: string; quote: string }
  | { kind: 'vague_expected'; node: string; text: string };

/** One planned defect: a label for the report and which requirement should be able to see it. */
export interface Planned {
  label: string;
  /** mechanical: the Hub's own literal check can see it; judgment: only a model's finding can. */
  seen_by: 'mechanical' | 'judgment';
  op: Operation;
}

export interface GoldEntry {
  label: string;
  seen_by: 'mechanical' | 'judgment';
  /** Which injection kind produced the entry (= op.kind); scoring counts by it. */
  kind: Operation['kind'];
  /** The node the defect sits on (for a duplicate: the original). */
  node: string;
  /** The copy a duplicate made; both are the defect. */
  copy?: string;
  note: string;
  /** For contradict_manual: the verbatim quote from the manual fragment and the fragment's sha256. */
  quote?: string;
  manual_sha256?: string;
  /** For replace_command_word: the word replaced and what it was replaced with. */
  from?: string;
  to?: string;
  /** For delete_negative_group: the cases deleted with the group. */
  deletedCases?: string[];
}

const isCase = (node: MindNode): boolean => Array.isArray(node.data.resource) && node.data.resource.length > 0;
const isNegative = (node: MindNode): boolean =>
  Array.isArray(node.data.resource) &&
  node.data.resource.some((t) => /^(?:negative|negativ|负向|反向)$/i.test(String(t).trim()));

/** The case nodes in document order: tagged nodes, outermost first (a tagged node below a case belongs to that case). */
export function caseNodes(tree: MindTree): MindNode[] {
  const out: MindNode[] = [];
  const walk = (node: MindNode): void => {
    if (isCase(node)) {
      out.push(node);
      return;
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(tree.root);
  return out;
}

const clone = <T>(value: T): T => structuredClone(value);

/** Compare recognition with raw array presence; cases.ts remains an import-only reference. */
function rawReading(tree: MindTree, parsed: ReturnType<typeof parseMindMap>, caseRule: 'marked'|'tagged') {
  const raw: MindNode[] = [];
  const visit = (node: MindNode): void => {raw.push(node);for(const child of (node.children ?? []).slice(0,1000))visit(child);};
  visit(tree.root);
  const view = {nodes:parsed.nodes.map((node,i)=>({...node,resource:Array.isArray(raw[i].data.resource)?raw[i].data.resource!.map(tag=>typeof tag==='string'?tag:''):[]}))};
  return {raw,cases:caseNodesOf(view,{caseRule})};
}
function refuseBlankSubtree(node: MindNode): void {
  const tags=node.data.resource;
  if(Array.isArray(tags) && tags.length>0 && tags.every(tag=>typeof tag!=='string' || !tag.trim())) throw new PublicRefusal('blank_tags');
  for(const child of node.children ?? [])refuseBlankSubtree(child);
}
function guardInjectionReading(tree: MindTree,node:MindNode,caseRule:'marked'|'tagged',groupOperation:boolean):void {
  const parsed=parseMindMap(tree), view=rawReading(tree,parsed,caseRule), index=view.raw.indexOf(node);
  const oldCase=caseNodesOf(parsed,{caseRule}).some(n=>n.index===index), rawCase=view.cases.some(n=>n.index===index);
  if(oldCase!==rawCase)throw new PublicRefusal('blank_tags');
  refuseBlankSubtree(node);
  if(!groupOperation && !rawCase)throw new InjectionConditionError('target_not_case','目标未被当前 raw-array 规则投影为用例');
}

/** The document up to and including the n-th case: everything after it is cut, groups that start before it stay. */
export function firstCases(tree: MindTree, n: number, options: { caseRule?: 'marked' | 'tagged' } = {}): MindTree {
  if (!Number.isSafeInteger(n) || n < 1) throw new PublicRefusal('keep_invalid');
  const copy = clone(tree), parsed = parseMindMap(copy), cases = caseNodesOf(parsed, options);
  const rawView=rawReading(copy,parsed,options.caseRule ?? 'marked');
  if(JSON.stringify(cases.slice(0,n).map(c=>c.index))!==JSON.stringify(rawView.cases.slice(0,n).map(c=>c.index)))throw new PublicRefusal('blank_tags');
  for(const selected of cases.slice(0,n))refuseBlankSubtree(rawView.raw[selected.index]);
  if (cases.length <= n && rawView.cases.length <= n) return copy;
  const selected = new Set(cases.slice(0, n).map(node => node.index)), caseIndices = new Set(cases.map(node => node.index));
  const positions = new Map<MindNode, number>(), ends = new Map<number, number>(); let ordinal = 0;
  const visit = (node: MindNode): void => { const at = ordinal++; positions.set(node, at); for (const child of (node.children ?? []).slice(0, 1000)) visit(child); ends.set(at, ordinal - 1); };
  visit(copy.root);
  const boundary = ends.get(cases[n - 1].index)!;
  const prune = (node: MindNode): boolean => {
    const index = positions.get(node);
    if (index === undefined || index > boundary || caseIndices.has(index) && !selected.has(index)) return false;
    if (node.children) node.children = node.children.filter(prune);
    return true;
  };
  prune(copy.root); return copy;
}

const idOf = (node: MindNode): string => String(node.data.id ?? '');

function locate(tree: MindTree, id: string): { node: MindNode; parent: MindNode | null } {
  const walk = (node: MindNode, parent: MindNode | null): { node: MindNode; parent: MindNode | null } | null => {
    if (idOf(node) === id) return { node, parent };
    for (const child of node.children ?? []) {
      const hit = walk(child, node);
      if (hit !== null) return hit;
    }
    return null;
  };
  const found = walk(tree.root, null);
  if (found === null) throw new InjectionConditionError('node_not_found', `node ${id} is not in the document`);
  return found;
}

/** A node id for a copy: derived from the original, so the same plan gives the same copy; 12 hexadecimal characters like the editor's. */
const copyId = (id: string): string => createHash('sha256').update(`${id}:copy`).digest('hex').slice(0, 12);

function copyOf(node: MindNode): MindNode {
  const out = clone(node);
  const rename = (n: MindNode): void => {
    n.data.id = copyId(idOf(n));
    for (const child of n.children ?? []) rename(child);
  };
  rename(out);
  return out;
}

/** The manual (or spec) fragment contradict_manual quotes: its bytes and their sha256. */
export interface ManualFragment {
  text: string;
  sha256: string;
}

export interface InjectOptions {
  /** Which nodes are cases (scripts/real/gold/cases.ts caseNodesOf); default 'marked', the run's default. */
  caseRule?: 'marked' | 'tagged';
  /** The manual fragment a contradict_manual plan quotes; required when the plan has that kind. */
  manual?: ManualFragment;
}

/** The ids of the nodes the case rule recognizes as cases in this tree. */
const caseIdsOf = (tree: MindTree, caseRule: 'marked' | 'tagged'): Set<string> => {
  const ids = caseNodesOf(parseMindMap(tree), { caseRule }).map((n) => n.id).filter((id) => id !== '');
  return new Set(ids);
};

/** The expected-result leaves of one case, read the way gold/cases.ts reads it: leaves under the case, priority-3
 * preconditions are not expected results, a nested tagged node is a case of its own and its leaves stay there. */
const expectedLeaves = (caseNode: MindNode): MindNode[] => {
  const out: MindNode[] = [];
  const walk = (node: MindNode): void => {
    for (const child of node.children ?? []) {
      if (Array.isArray(child.data.resource) && child.data.resource.length > 0) continue;
      if ((child.children ?? []).length === 0) {
        if (child.data.priority === 3) continue;
        out.push(child);
      } else {
        walk(child);
      }
    }
  };
  walk(caseNode);
  return out;
};

const vague = (text: string): boolean => new Set(VAGUE_EXPECTED.map(foldKey)).has(foldKey(text));

const vagueCasesOf = (tree: MindTree, caseRule: 'marked' | 'tagged'): Set<string> =>
  new Set(caseGold([{ document: 'x', map: tree }], { caseRule }).documents[0]!.vagueCases);


/** Applies the planned defects to a copy of the tree, in order; returns the copy and what was done. */
export function inject(tree: MindTree, plan: readonly Planned[], options: InjectOptions = {}): { tree: MindTree; gold: GoldEntry[] } {
  const copy = clone(tree);
  const gold: GoldEntry[] = [];
  for (const [index, { label, seen_by, op }] of plan.entries()) {
    try {
    const { node, parent } = locate(copy, op.node);
    guardInjectionReading(copy,node,options.caseRule ?? 'marked',op.kind==='delete_negative_group');

    if (op.kind === 'delete_negative_group') {
      if (parent === null) throw new InjectionConditionError('root_change', 'the root cannot be deleted');
      if (isCase(node)) throw new InjectionConditionError('group_not_group', `node ${op.node} is a case, not a group`);
      const casesInGroup = caseNodes({ root: node });
      if (casesInGroup.length === 0) throw new InjectionConditionError('group_empty', `group ${op.node} contains no cases`);
      const nonNegative = casesInGroup.filter((c) => !isNegative(c));
      if (nonNegative.length > 0) {
        throw new InjectionConditionError('group_not_negative', `group ${op.node} contains non-negative cases: ${nonNegative.map(idOf).join(', ')}`);
      }
      const deletedCases = casesInGroup.map(idOf);
      parent.children = (parent.children ?? []).filter((c) => c !== node);
      gold.push({
        label,
        seen_by,
        kind: op.kind,
        node: op.node,
        deletedCases,
        note: `删掉了只含反向用例的分组 ${op.node}，内含用例：${deletedCases.join('、')}`,
      });
      continue;
    }

    if (op.kind === 'contradict_manual') {
      if ([op.from, op.to, op.quote].some(text => typeof text !== 'string' || !text.trim())) throw new InjectionConditionError('empty_operand', 'from、to、quote 必须是非空文本');
      if (seen_by !== 'judgment') throw new InjectionConditionError('seen_by', 'contradict_manual 只有模型判断才看得见，seen_by 必须是 judgment');
      if (options.manual === undefined) throw new InjectionConditionError('missing_manual', '计划里有 contradict_manual，却没有给手册片段（inject-defects.ts 的 --manual）');
      if (!goldQuoteContains(options.manual.text, op.quote)) {
        throw new InjectionConditionError('quote_not_verbatim', `quote 不是逐字出自手册片段（按决定 37 对齐空白）：${op.quote}`);
      }
      if (op.quote.includes(op.to)) throw new InjectionConditionError('to_in_quote', `to（${op.to}）出现在 quote 里，矛盾不成立`);
      if (!caseIdsOf(copy, options.caseRule ?? 'marked').has(op.node)) {
        throw new InjectionConditionError('target_not_case', `node ${op.node} is not a case by the ${options.caseRule ?? 'marked'} case rule`);
      }
      const target = expectedLeaves(node).find((leaf) => typeof leaf.data.text === 'string' && leaf.data.text.includes(op.from));
      if (target === undefined) throw new InjectionConditionError('from_not_found', `no expected result of case ${op.node} contains "${op.from}"`);
      target.data.text = String(target.data.text).replace(op.from, op.to);
      gold.push({
        label,
        seen_by,
        kind: op.kind,
        node: op.node,
        from: op.from,
        to: op.to,
        quote: op.quote,
        manual_sha256: options.manual.sha256,
        note: `期望结果里的“${op.from}”换成了与手册片段矛盾的“${op.to}”`,
      });
      continue;
    } else if (op.kind === 'vague_expected') {
      if (typeof op.text !== 'string' || !op.text.trim()) throw new InjectionConditionError('empty_operand', 'text 必须是非空文本');
      if (seen_by !== 'judgment') throw new InjectionConditionError('seen_by', 'vague_expected 只有模型判断才看得见，seen_by 必须是 judgment');
      if (!vague(op.text)) throw new InjectionConditionError('vague_not_word', `text（${op.text}）不在含糊期望词表里`);
      if (!caseIdsOf(copy, options.caseRule ?? 'marked').has(op.node)) {
        throw new InjectionConditionError('target_not_case', `node ${op.node} is not a case by the ${options.caseRule ?? 'marked'} case rule`);
      }
      const leaves = expectedLeaves(node);
      if (leaves.length === 0) throw new InjectionConditionError('no_expected', `case ${op.node} has no expected results to make vague`);
      if (leaves.every((leaf) => vague(String(leaf.data.text ?? '')))) throw new InjectionConditionError('already_vague', `case ${op.node} 的期望结果已经全是含糊的`);
      const before = vagueCasesOf(copy, options.caseRule ?? 'marked');
      for (const leaf of leaves) leaf.data.text = op.text;
      const after = vagueCasesOf(copy, options.caseRule ?? 'marked');
      const flipped = [...after].filter((id) => !before.has(id));
      if (flipped.length !== 1 || flipped[0] !== op.node) {
        throw new InjectionConditionError('vague_not_unique', flipped.length === 0 ? '注入后这个用例没有变成含糊（没有可确认的新增身份）' : `注入后从不含糊变成含糊的用例不止这一个：${flipped.join('、')}`);
      }
      gold.push({ label, seen_by, kind: op.kind, node: op.node, note: `每条期望结果都换成了同一句含糊的“${op.text}”` });
      continue;
    }
    if (!isCase(node)) throw new InjectionConditionError('target_not_case', `node ${op.node} is not a case (it carries no tag)`);
    if (op.kind === 'delete_expected') {
      node.children = [];
      gold.push({ label, seen_by, kind: 'delete_expected', node: op.node, note: '期望结果整个删掉' });
    } else if (op.kind === 'replace_expected') {
      const first = node.children?.[0];
      if (first === undefined) node.children = [{ data: { id: copyId(`${op.node}:expected`), text: op.text }, children: [] }];
      else first.data.text = op.text;
      gold.push({ label, seen_by, kind: 'replace_expected', node: op.node, note: '期望结果换成另一段文字' });
    } else if (op.kind === 'duplicate') {
      if (parent === null) throw new InjectionConditionError('root_change', 'the root cannot be duplicated');
      const twin = copyOf(node);
      const siblings = parent.children ?? [];
      siblings.splice(siblings.indexOf(node) + 1, 0, twin);
      parent.children = siblings;
      gold.push({ label, seen_by, kind: 'duplicate', node: op.node, copy: idOf(twin), note: '同一分组里多了一份完全相同的用例' });
    } else if (op.kind === 'replace_command_word') {
      let replaced = false;
      const tryReplace = (n: MindNode) => {
        if (typeof n.data.text === 'string' && n.data.text.includes(op.from)) {
          n.data.text = n.data.text.replace(op.from, op.to);
          replaced = true;
        }
        for (const child of n.children ?? []) {
          tryReplace(child);
        }
      };
      tryReplace(node);
      if (!replaced) {
        throw new InjectionConditionError('word_not_found', `command word "${op.from}" not found in case ${op.node}`);
      }
      gold.push({
        label,
        seen_by,
        kind: 'replace_command_word',
        node: op.node,
        from: op.from,
        to: op.to,
        note: `用例命令行中的“${op.from}”换成了目录中不存在的“${op.to}”`,
      });
    } else if (op.kind === 'move') {
      if (parent === null) throw new InjectionConditionError('root_change', 'the root cannot be moved');
      const target = locate(copy, op.to).node;
      if (isCase(target)) throw new InjectionConditionError('group_not_group', `node ${op.to} is a case, not a group`);
      parent.children = (parent.children ?? []).filter((c) => c !== node);
      target.children = [...(target.children ?? []), node];
      gold.push({ label, seen_by, kind: 'move', node: op.node, note: `用例挪到了分组 ${op.to} 下` });
    }
    } catch (error) { throw new InjectionRefusal(index + 1, op.kind, error); }
  }
  return { tree: copy, gold };
}

export class InjectionRefusal extends Error {
  readonly reason: InjectionReason | PublicRefusalReason;
  detail: string;
  constructor(index: number, kind: string, error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    const safeKind = ['delete_expected','replace_expected','duplicate','move','replace_command_word','delete_negative_group','contradict_manual','vague_expected'].includes(kind) ? kind : '未识别种类';
    const reason = error instanceof InjectionConditionError || error instanceof PublicRefusal ? error.reason : 'unexpected';
    const publicReason = error instanceof PublicRefusal ? error.message : INJECTION_REASONS[reason as InjectionReason];
    super(`计划第 ${index} 条（${safeKind}）：${publicReason}`);
    this.reason = reason;
    this.detail = detail;
  }
}
export function refusalSummary(error: unknown): string { return error instanceof InjectionRefusal || error instanceof PublicRefusal ? error.message : '输入或计分条件不满足；请按私有诊断补齐输入后重跑'; }
export function recordRefusal(out: string | undefined, error: unknown): string | undefined {
  if (!out) return;
  const path = resolve(out);
  const check = (start: string) => { for (let at = start; ; at = dirname(at)) { if (existsSync(join(at, '.git'))) throw new Error('拒绝写入 Git'); if (dirname(at) === at) break; } };
  try {
    check(path); let parent = path; while (!existsSync(parent)) parent = dirname(parent);
    check(resolve(realpathSync(parent), relative(parent, path)));
    mkdirSync(path, { recursive: true, mode: 0o700 });
    const name = 'refusal-' + new Date().toISOString().replace(/[:.]/g,'-') + '-' + process.pid + '-' + randomUUID() + '.txt';
    writeFileSync(join(path, name), error instanceof InjectionRefusal ? error.detail : error instanceof Error ? error.stack ?? error.message : String(error), { flag: 'wx', mode: 0o600 });
    return name;
  } catch { /* Never expose the original error when its private record cannot be written. */ }
}

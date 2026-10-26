// Item projection of the case-review pack (W01): parsed KityMinder documents in, case items out.
//
// Conventions of the team's test mind maps (the README gives the counts measured on sampled documents):
// - caseRule tagged (default, the brief's rule): a case is a node whose `resource` (the tag list) is a non-empty array.
//   caseRule marked: also an untagged node outside every case that carries the case priority (2 in template v3), has
//   children and holds no tagged node and no node with the case priority. Under tagged such nodes are only counted (warning);
// - a tagged node with the group priority (1) that holds tagged nodes or nodes with the case priority is a group: a tag on
//   a group node does not make it a case;
// - inside a case: a leaf is an expected result, unless it carries the precondition priority (3); a child with children
//   is an operation step, and the leaves below it are its expected results; a case below a case is an item of its own;
// - any other node with a priority outside every case is a group, not an item.
// Identity (W01 R[2]): `<documentId>:<data.id>` when the id occurs on one case of the document; every copy of a duplicated
// id gets `#1`, `#2`, ..., a missing or unusable id a position. Those pack identities are listed in `unnumbered` (the Hub
// does not carry them across revisions) and the structure tables judge the numbering. For well-formed input a document
// without any case is the only refusal (W01 R[3]); a result above the output limit is refused with a fix.
// Passes over the visited nodes (walk, flags from the leaves up, roles, items) keep a document linear in its size.
import { PACK, failure, guarded, isRecord, warningSink, type WarningSink } from './common.ts';
import { declareResourceTags } from './tags.ts';
import { clip, collapseWhitespace, isBlank, isWhiteSpace, selectorSegment, textOf, utf8Length } from './text.ts';
import type { CaseItem, CaseRule, GroupEntry, ItemLocation, ProjectionOutput, ProjectionResult, Warning } from './types.ts';

const PARSER = 'kityminder@1';

export const LIMITS = {
  /** Deepest level visited, the same as the kityminder@1 parser's default. */
  maxDepth: 200,
  /** Code points kept of one text. Real node texts stay below 1,000. */
  maxText: 4000,
  /** Entries kept of one list (tags, expected results, steps, preconditions); counts stay complete. */
  maxList: 100,
  maxItemId: 200,
  maxDocumentId: 120,
  /** Longest id selector; longer ids are addressed by position so the reference stays within its limit. */
  maxSelector: 4096,
  /** Per-node warnings kept; summaries per document are kept apart from this budget. */
  maxWarnings: 100,
  maxLabel: 200,
  /** Node selectors and ids named in one summary warning. */
  maxNamed: 20,
  /** Default output budget: the sandbox's default output limit (8 MiB). */
  outputBytes: 8 * 1024 * 1024,
} as const;

export type Parameters = { caseRule: CaseRule; casePriority: number; groupPriority: number | null; preconditionPriority: number | null };

const DEFAULTS: Parameters = { caseRule: 'marked', casePriority: 2, groupPriority: 1, preconditionPriority: 3 };
const CASE_RULES = ['tagged', 'marked'] as const satisfies readonly CaseRule[];

// Compile-time check that the list names every case rule.
type MissingRule = Exclude<CaseRule, (typeof CASE_RULES)[number]>;
const allRules: [MissingRule] extends [never] ? true : never = true;
void allRules;

const isPriority = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 9;

function readParameters(raw: unknown, warnings: WarningSink): Parameters {
  const out: Parameters = { ...DEFAULTS };
  if (!isRecord(raw)) return out;
  const ignored = (parameter: string, rule: string, fallback: string): void =>
    warnings.note({ code: `${PACK}.parameter_ignored`, message: `参数 ${parameter} 的取值无效（${rule}），按默认值 ${fallback} 处理`, data: { parameter } });
  if (Object.hasOwn(raw, 'caseRule')) {
    const value = raw.caseRule;
    const rule = CASE_RULES.find((candidate) => candidate === value);
    if (rule !== undefined) out.caseRule = rule;
    else ignored('caseRule', '应为 tagged 或 marked', DEFAULTS.caseRule);
  }
  if (Object.hasOwn(raw, 'casePriority')) {
    if (isPriority(raw.casePriority)) out.casePriority = raw.casePriority;
    else ignored('casePriority', '应为 1 到 9 的整数', String(DEFAULTS.casePriority));
  }
  for (const name of ['groupPriority', 'preconditionPriority'] as const) {
    if (!Object.hasOwn(raw, name)) continue;
    const value = raw[name];
    if (value === null || isPriority(value)) out[name] = value;
    else ignored(name, '应为 1 到 9 的整数或 null', String(DEFAULTS[name]));
  }
  return out;
}

export function resolvedCaseParameters(raw: unknown): Parameters {
  return readParameters(raw, warningSink());
}

/**
 * The output limit of the call. Infinity (never JSON, so only an in-process caller can pass it) means the caller bounds the
 * output itself: the run adapter projects the whole document and returns at most one block of it.
 */
function readOutputBytes(raw: unknown, warnings: WarningSink): number {
  if (!isRecord(raw) || !Object.hasOwn(raw, 'outputBytes')) return LIMITS.outputBytes;
  const value = raw.outputBytes;
  if (value === Number.POSITIVE_INFINITY) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 1024) return value;
  warnings.note({
    code: `${PACK}.parameter_ignored`,
    message: `limits.outputBytes 的取值无效（应为不小于 1024 的整数），按 ${LIMITS.outputBytes} 字节处理`,
    data: { parameter: 'limits.outputBytes' },
  });
  return LIMITS.outputBytes;
}

/** data.id as the parser reads it: a non-empty string, or a finite number written out. */
function rawIdOf(data: { [key: string]: unknown }): string | null {
  const id = data.id;
  if (typeof id === 'string' && id !== '') return id;
  if (typeof id === 'number' && Number.isFinite(id)) return String(id);
  return null;
}

function priorityOf(data: { [key: string]: unknown }): number | string | null {
  const value = data.priority;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') return value;
  return null;
}

function degreeOf(data: { [key: string]: unknown }): number | null {
  const value = data.degree;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isTagged(data: { [key: string]: unknown }): boolean {
  return Array.isArray(data.resource) && data.resource.length > 0;
}

/** No colon (it separates the document from the node in an item id), no white space, no control character. */
function documentIdProblem(id: string): boolean {
  for (let i = 0; i < id.length; i++) {
    const code = id.charCodeAt(i);
    if (code === 0x3a || code < 0x20 || (code >= 0x7f && code <= 0x9f) || isWhiteSpace(code)) return true;
  }
  return false;
}

const labelOf = (title: string): string => {
  const text = collapseWhitespace(title);
  return text === '' ? '（空标题）' : clip(text, LIMITS.maxLabel).text;
};

// Roles of visited nodes.
const OTHER = 0;
const CASE = 1;
const GROUP = 2;
/** An untagged node in the case form, not projected (caseRule tagged). */
const CANDIDATE = 3;
/** Inside a case or a candidate. */
const INNER = 4;

type Visit = { node: number; parent: number; position: number; text: string; leaf: boolean; data: { [key: string]: unknown } };

type Output = { items: CaseItem[]; groups: GroupEntry[]; unnumbered: string[] };

/** Projects one document into `out`; returns the number of cases and of untagged nodes in the case form left out. */
function projectDocument(
  documentId: string,
  nodes: readonly unknown[],
  parameters: Parameters,
  out: Output,
  warnings: WarningSink,
): { cases: number; candidates: number } {
  const n = nodes.length;
  const stats = { malformed: 0, deep: 0, clippedTexts: 0, clippedLists: 0, nonTextTags: 0 };
  const keep = (text: string): string => {
    const clipped = clip(text, LIMITS.maxText);
    if (clipped.clipped) stats.clippedTexts += 1;
    return clipped.text;
  };
  const pushLimited = (list: string[], text: string): void => {
    if (list.length < LIMITS.maxList) list.push(text);
    else stats.clippedLists += 1;
  };
  const dataOf = (raw: unknown): { [key: string]: unknown } => (isRecord(raw) && isRecord(raw.data) ? raw.data : {});

  // 1. Walk with an explicit stack: visits in pre-order (a child after its parent), each node at most once.
  const visits: Visit[] = [];
  const reached = new Uint8Array(n);
  type Frame = { node: number; parent: number; position: number; depth: number };
  const stack: Frame[] = n > 0 ? [{ node: 0, parent: -1, position: -1, depth: 0 }] : [];
  while (stack.length > 0) {
    const frame = stack.pop() as Frame;
    const raw = nodes[frame.node];
    if (reached[frame.node] === 1 || !isRecord(raw)) {
      stats.malformed += 1;
      continue;
    }
    reached[frame.node] = 1;
    const data = dataOf(raw);
    const text = keep(typeof raw.text === 'string' ? raw.text : (textOf(data.text) ?? ''));
    // [node index, position in the children array]; index 0 is the root and never a child.
    const childList: Array<[number, number]> = [];
    const children = Array.isArray(raw.children) ? raw.children : [];
    if (raw.children !== undefined && !Array.isArray(raw.children)) stats.malformed += 1;
    for (let position = 0; position < children.length; position++) {
      const child = children[position];
      if (typeof child === 'number' && Number.isSafeInteger(child) && child > 0 && child < n) childList.push([child, position]);
      else stats.malformed += 1;
    }
    const visit = visits.length;
    visits.push({ node: frame.node, parent: frame.parent, position: frame.position, text, leaf: childList.length === 0, data });
    if (frame.depth >= LIMITS.maxDepth) {
      stats.deep += childList.length;
      continue;
    }
    for (let k = childList.length - 1; k >= 0; k--) stack.push({ node: childList[k][0], parent: visit, position: childList[k][1], depth: frame.depth + 1 });
  }

  // 2. From the leaves up: does a node hold a tagged node or a node with the case priority?
  const holds = new Uint8Array(visits.length);
  for (let v = visits.length - 1; v > 0; v--) {
    const { parent, data } = visits[v];
    if (holds[v] === 1 || isTagged(data) || data.priority === parameters.casePriority) holds[parent] = 1;
  }

  // 3. Roles, top down. `within`: the case or candidate a node sits in, -1 outside all of them.
  const role = new Uint8Array(visits.length);
  const within = new Int32Array(visits.length).fill(-1);
  for (let v = 0; v < visits.length; v++) {
    const { parent, data, leaf } = visits[v];
    const inside = parent === -1 ? -1 : role[parent] === CASE || role[parent] === CANDIDATE ? parent : within[parent];
    within[v] = inside;
    if (isTagged(data)) {
      const container = inside === -1 && parameters.groupPriority !== null && data.priority === parameters.groupPriority && holds[v] === 1;
      role[v] = container ? GROUP : CASE;
    } else if (inside !== -1) role[v] = INNER;
    else if (data.priority === parameters.casePriority && !leaf && holds[v] === 0) role[v] = parameters.caseRule === 'marked' ? CASE : CANDIDATE;
    else if (Object.hasOwn(data, 'priority')) role[v] = GROUP;
    else role[v] = OTHER;
  }

  // 4. Identities. Ids are counted over every node, as the parser does (only an id that occurs once addresses a node);
  // item numbering counts cases only, and a pack identity never takes the id of a real node.
  const idCount = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const id = rawIdOf(dataOf(nodes[i]));
    if (id !== null) idCount.set(id, (idCount.get(id) ?? 0) + 1);
  }
  const real = new Set<string>();
  for (const id of idCount.keys()) real.add(`${documentId}:${id}`);
  const caseIds = new Map<string, number>();
  for (let v = 0; v < visits.length; v++) {
    if (role[v] !== CASE) continue;
    const id = rawIdOf(visits[v].data);
    if (id !== null) caseIds.set(id, (caseIds.get(id) ?? 0) + 1);
  }
  const assigned = new Set<string>();
  const free = (candidate: string): boolean => !assigned.has(candidate) && !real.has(candidate);
  const positional = (node: number): string => {
    let id = `${documentId}:@${node}`;
    for (let k = 2; !free(id); k++) id = `${documentId}:@${node}#${k}`;
    assigned.add(id);
    return id;
  };
  const numbering = { duplicated: 0, duplicatedIds: [] as string[], missing: 0, unusable: 0 };
  const copies = new Map<string, number>();
  const caseIdentity = (visit: Visit): { id: string; numbered: boolean } => {
    const rawId = rawIdOf(visit.data);
    if (rawId === null) {
      numbering.missing += 1;
      return { id: positional(visit.node), numbered: false };
    }
    const plain = `${documentId}:${rawId}`;
    if (plain.length > LIMITS.maxItemId) {
      numbering.unusable += 1;
      return { id: positional(visit.node), numbered: false };
    }
    if (caseIds.get(rawId) === 1) {
      assigned.add(plain);
      return { id: plain, numbered: true };
    }
    numbering.duplicated += 1;
    if (!copies.has(rawId)) numbering.duplicatedIds.push(rawId);
    let k = copies.get(rawId) ?? 0;
    let id: string;
    do {
      k += 1;
      id = `${plain}#${k}`;
    } while (!free(id));
    copies.set(rawId, k);
    if (id.length > LIMITS.maxItemId) return { id: positional(visit.node), numbered: false };
    assigned.add(id);
    return { id, numbered: false };
  };
  const locate = (v: number): ItemLocation => {
    const rawId = rawIdOf(visits[v].data);
    if (rawId !== null && idCount.get(rawId) === 1 && !rawId.startsWith('@')) {
      const segment = selectorSegment(rawId);
      if (segment !== null && segment.length + 2 <= LIMITS.maxSelector) return { parser: PARSER, selector: `n/${segment}` };
    }
    const steps: string[] = [];
    for (let at = v; visits[at].parent !== -1; at = visits[at].parent) steps.push(String(visits[at].position));
    return { parser: PARSER, selector: ['i', ...steps.reverse()].join('/') };
  };
  const pathOf = (v: number): string[] => {
    const path: string[] = [];
    for (let at = visits[v].parent; at !== -1; at = visits[at].parent) path.push(visits[at].text);
    return path.reverse();
  };

  // 5. Items in document order; the nodes inside a case fill its fields.
  const details: Warning[] = [];
  const caseOf = new Int32Array(visits.length).fill(-1);
  const stepOf = new Int32Array(visits.length).fill(-1);
  const groupCases = new Int32Array(visits.length);
  const states: Array<{ item: CaseItem; expected: number }> = [];
  const untagged = { count: 0, nodes: [] as string[] };
  const marker = parameters.preconditionPriority;
  for (let v = 0; v < visits.length; v++) {
    const visit = visits[v];
    if (role[v] === CASE) {
      const { id, numbered } = caseIdentity(visit);
      if (!numbered) out.unnumbered.push(id);
      const location = locate(v);
      const label = labelOf(visit.text);
      const tags: string[] = [];
      for (const entry of Array.isArray(visit.data.resource) ? (visit.data.resource as unknown[]) : []) {
        const tag = typeof entry === 'string' ? entry : null;
        if (tag === null) stats.nonTextTags += 1;
        else pushLimited(tags, keep(tag));
      }
      if (!isTagged(visit.data)) {
        untagged.count += 1;
        if (untagged.nodes.length < LIMITS.maxNamed) untagged.nodes.push(location.selector);
      }
      const tagDeclaration = declareResourceTags(visit.data.resource);
      const tagsNormalized = tagDeclaration.types;
      const autoid = textOf(visit.data.autoid);
      const note = visit.data.note;
      const nested = within[v] !== -1;
      const item: CaseItem = {
        id,
        label,
        location,
        fields: {
          document: documentId,
          nodeId: rawIdOf(visit.data),
          path: pathOf(v),
          title: visit.text,
          priority: priorityOf(visit.data),
          degree: degreeOf(visit.data),
          tags,
          tagsNormalized,
          resource: visit.data.resource ?? null,
          resourcePresent: Object.hasOwn(visit.data,'resource'),
          tagDeclaration,
          expected: [],
          expectedSelectors: [],
          expectedCount: 0,
          steps: [],
          preconditions: [],
          autoid: autoid === null || isBlank(autoid) ? null : autoid,
          automated: (autoid !== null && !isBlank(autoid)) || (typeof visit.data.auto === 'string' && visit.data.auto.trim().toUpperCase() === 'YES'),
          negative: tagDeclaration.negative,
          hasNote: typeof note === 'string' && !isBlank(note),
          nested,
        },
      };
      if (nested) {
        const outer = states[caseOf[within[v]]].item;
        details.push({
          code: `${PACK}.nested_case`,
          message: `用例“${label}”在用例“${outer.label}”下面，按单独的用例投影`,
          document: documentId,
          item: id,
          node: location.selector,
          data: { outer: outer.id },
        });
      }
      out.items.push(item);
      caseOf[v] = states.length;
      states.push({ item, expected: 0 });
      for (let at = visit.parent; at !== -1; at = visits[at].parent) if (role[at] === GROUP) groupCases[at] += 1;
    } else if (role[v] === INNER) {
      const owner = within[v];
      if (role[owner] !== CASE) continue; // inside a candidate: not projected
      const state = states[caseOf[owner]];
      const fields = state.item.fields;
      const parentStep = visit.parent === owner ? -1 : stepOf[visit.parent];
      if (visit.leaf && marker !== null && visit.data.priority === marker) {
        pushLimited(fields.preconditions, visit.text);
      } else if (parentStep === -1 && !visit.leaf) {
        if (fields.steps.length < LIMITS.maxList) {
          fields.steps.push({ text: visit.text, expected: [] });
          stepOf[v] = fields.steps.length - 1;
        } else {
          // Leaves below a step past the limit still count as expected results.
          stats.clippedLists += 1;
          stepOf[v] = LIMITS.maxList;
        }
      } else if (visit.leaf) {
        pushLimited(fields.expected, visit.text);
        pushLimited(fields.expectedSelectors!, locate(v).selector);
        state.expected += 1;
        if (parentStep !== -1 && parentStep < fields.steps.length) pushLimited(fields.steps[parentStep].expected, visit.text);
      } else {
        stepOf[v] = parentStep;
      }
    } else if (role[v] === CANDIDATE) {
      untagged.count += 1;
      if (untagged.nodes.length < LIMITS.maxNamed) untagged.nodes.push(locate(v).selector);
    } else if (role[v] === GROUP && isTagged(visit.data)) {
      details.push({
        code: `${PACK}.tagged_group`,
        message: `“${labelOf(visit.text)}”带标签，但优先级是分组的 ${String(parameters.groupPriority)}，下面还有用例，按分组处理，不算用例`,
        document: documentId,
        node: locate(v).selector,
      });
    }
  }
  for (const state of states) state.item.fields.expectedCount = state.expected;
  // Groups after the cases, so a group never takes the identity of a case.
  for (let v = 0; v < visits.length; v++) {
    if (role[v] !== GROUP) continue;
    const visit = visits[v];
    const rawId = rawIdOf(visit.data);
    let id: string | null = null;
    if (rawId !== null && idCount.get(rawId) === 1) {
      const plain = `${documentId}:${rawId}`;
      if (plain.length <= LIMITS.maxItemId && !assigned.has(plain)) {
        assigned.add(plain);
        id = plain;
      }
    }
    out.groups.push({ id: id ?? positional(visit.node), label: labelOf(visit.text), location: locate(v), document: documentId, priority: priorityOf(visit.data), cases: groupCases[v] });
  }

  // Summaries first, then the per-node warnings of the document.
  const notes: Warning[] = [];
  if (untagged.count > 0) {
    const projected = parameters.caseRule === 'marked';
    notes.push({
      code: `${PACK}.untagged_cases`,
      message: projected
        ? `${untagged.count} 个没有标签的节点按团队模板的用例写法（优先级 ${parameters.casePriority}、有子节点、下面没有别的用例）当用例投影；它们的标签为空，是否反向未知`
        : `${untagged.count} 个没有标签的节点像用例（优先级 ${parameters.casePriority}、有子节点、下面没有别的用例），按规则 caseRule=tagged 没有投影；去掉运行参数 caseRule（或设为 marked）可以把它们当没有标签的用例投影`,
      document: documentId,
      data: { count: untagged.count, projected, nodes: untagged.nodes },
    });
  }
  if (numbering.duplicated > 0) {
    const examples = numbering.duplicatedIds.slice(0, LIMITS.maxNamed).map((id) => clip(id, 60).text);
    notes.push({
      code: `${PACK}.node_id_duplicate`,
      message: `${numbering.duplicated} 个用例共用 ${numbering.duplicatedIds.length} 个节点编号（${examples.slice(0, 5).join('、')}${numbering.duplicatedIds.length > 5 ? ' 等' : ''}），每个副本编为带序号的包内编号（编号#1、编号#2 …），按位置定位，跨修订不对应`,
      document: documentId,
      data: { cases: numbering.duplicated, ids: numbering.duplicatedIds.length, examples },
    });
  }
  if (numbering.missing > 0) {
    notes.push({ code: `${PACK}.node_id_missing`, message: `${numbering.missing} 个用例没有节点编号，按位置编号（@节点序号），跨修订不对应`, document: documentId, data: { count: numbering.missing } });
  }
  if (numbering.unusable > 0) {
    notes.push({
      code: `${PACK}.node_id_unusable`,
      message: `${numbering.unusable} 个用例的节点编号太长，写不进 ${LIMITS.maxItemId} 个字符的条目编号，按位置编号，跨修订不对应`,
      document: documentId,
      data: { count: numbering.unusable },
    });
  }
  const counted: Array<[number, string, string]> = [
    [stats.malformed, 'model_malformed', `文档结构有 ${stats.malformed} 处异常（节点不是对象、子节点下标无效或节点被引用多次），这些地方没有投影`],
    [stats.deep, 'depth_limit', `文档超过 ${LIMITS.maxDepth} 层，更深的 ${stats.deep} 个子树没有投影`],
    [stats.clippedTexts, 'text_clipped', `${stats.clippedTexts} 段文字超过 ${LIMITS.maxText} 个字符，已截断`],
    [stats.clippedLists, 'list_clipped', `有 ${stats.clippedLists} 条标签、期望结果、步骤或前置条件超过每个用例 ${LIMITS.maxList} 条的上限，没有列出；计数仍按全部`],
    [stats.nonTextTags, 'tag_not_text', `${stats.nonTextTags} 个标签不是文字，已忽略`],
  ];
  for (const [count, code, message] of counted) if (count > 0) notes.push({ code: `${PACK}.${code}`, message, document: documentId, data: { count } });
  for (const warning of notes) warnings.note(warning);
  for (const warning of details) warnings.add(warning);
  return { cases: states.length, candidates: parameters.caseRule === 'marked' ? 0 : untagged.count };
}

export function projectItems(input: unknown): ProjectionOutput {
  const warnings = warningSink(LIMITS.maxWarnings);
  if (!isRecord(input) || !Array.isArray(input.documents)) {
    return failure('invalid_input', '输入里没有 documents 数组', '按 { documents: [{ slot, documentId, model }], parameters?, limits? } 传入解析后的脑图');
  }
  if (input.documents.length === 0) return failure('invalid_input', '没有要投影的文档', '至少传入一份解析后的脑图');
  const parameters = readParameters(input.parameters, warnings);
  const outputBytes = readOutputBytes(input.limits, warnings);
  const out: Output = { items: [], groups: [], unnumbered: [] };
  const seen = new Set<string>();
  const empty: Array<{ id: string; candidates: number }> = [];
  for (const [position, raw] of input.documents.entries()) {
    const at = `第 ${position + 1} 份文档`;
    if (!isRecord(raw)) return failure('invalid_input', `${at}不是对象`, '每份文档写成 { slot, documentId, model }', warnings.list());
    const documentId = textOf(raw.documentId);
    if (documentId === null || isBlank(documentId) || documentId.length > LIMITS.maxDocumentId) {
      return failure('invalid_input', `${at}的 documentId 缺失、为空或超过 ${LIMITS.maxDocumentId} 个字符`, '给每份文档一个简短的文档编号', warnings.list());
    }
    if (documentIdProblem(documentId)) {
      return failure(
        'invalid_input',
        `${at}的 documentId“${clip(documentId, 40).text}”含有冒号、空白或控制字符：条目编号写成“文档编号:节点编号”，文档编号里有这些字符会让不同文档的条目编号相撞`,
        '用不含冒号和空白的文档编号，例如敏捷平台的脑图编号',
        warnings.list(),
      );
    }
    if (seen.has(documentId)) return failure('invalid_input', `文档编号 ${documentId} 出现了两次`, '每份文档只传一次', warnings.list());
    seen.add(documentId);
    const model = raw.model;
    if (!isRecord(model) || !Array.isArray(model.nodes) || model.nodes.length === 0) {
      return failure('invalid_input', `文档 ${documentId} 的 model 不是 kityminder@1 解析结果（缺少 nodes）`, '先用 kityminder@1 解析脑图，再传入解析结果', warnings.list(), [documentId]);
    }
    const found = projectDocument(documentId, model.nodes, parameters, out, warnings);
    if (found.cases === 0) empty.push({ id: documentId, candidates: found.candidates });
  }
  if (empty.length > 0) {
    const names = empty.length === 1 ? `文档 ${empty[0].id} ` : `${empty.length} 份文档（${empty.map((entry) => entry.id).join('、')}）`;
    const candidates = empty.reduce((sum, entry) => sum + entry.candidates, 0);
    const rule = parameters.caseRule === 'tagged' ? '用例是标签（resource）不为空的节点' : `用例是标签（resource）不为空的节点，或者带用例优先级 ${parameters.casePriority}、有子节点的节点`;
    const hint = candidates > 0 ? `；其中有 ${candidates} 个没有标签的节点像用例（优先级 ${parameters.casePriority}、有子节点）` : '';
    const fix =
      candidates > 0
        ? '去掉运行参数 caseRule（或设为 marked）重新开始运行，这些没有标签的节点会当作没有标签的用例投影；或者把这些文档从输入里去掉'
        : '把没有用例的文档从输入里去掉，或者换成测试用例脑图，再重新开始运行';
    return failure('no_case', `${names}里没有用例节点：${rule}${hint}`, fix, warnings.list(), empty.map((entry) => entry.id));
  }
  const result: ProjectionResult = { items: out.items, groups: out.groups, unnumbered: out.unnumbered, warnings: warnings.list() };
  if (outputBytes === Number.POSITIVE_INFINITY) return result;
  const bytes = utf8Length(JSON.stringify(result));
  if (bytes > outputBytes) {
    const documents = [...seen];
    const refusal = failure(
      'too_large',
      `投影结果有 ${bytes} 字节（${out.items.length} 个用例），超过这次调用的输出上限 ${outputBytes} 字节`,
      '把脑图拆成几份文档分别开始运行；或者请管理员调高投影函数的输出上限',
      result.warnings,
      documents,
    );
    if (utf8Length(JSON.stringify(refusal)) <= outputBytes) return refusal;
    return failure('too_large', refusal.error.message, refusal.error.fix, [], documents.slice(0, LIMITS.maxNamed));
  }
  return result;
}

export default function (input: unknown): unknown {
  return guarded(() => projectItems(input));
}

// The cases of one parsed mind map (ported from the case-review projection, W01), with the identities case-review gives its
// items, so that the evidence of a template category names the same cases a review run of the document would.
// - a case is a node whose `resource` (the tag list) is a non-empty array, or (under the unified default rule `marked`,
//   2026-10-22 owner decision) an untagged node outside every case that carries the case priority (2), has children and holds
//   no tagged node and no node with the case priority; under caseRule tagged it is restricted to tagged nodes only;
// - a tagged node with the group priority (1) outside every case that holds tagged nodes or nodes with the case priority (2)
//   is a group; once nothing like that is below it, it is a case (case-review's rule, kept for parity; README deviation 5:
//   removing or adding cases below such a node changes its role);
// - inside a case: a leaf is an expected result unless it carries the precondition priority (3); a child with children is a
//   step and the leaves below it are expected results too; a tagged node below a case is a case of its own;
// - an untagged node outside every case that carries the case priority, has children and holds no tagged node and no node
//   with the case priority is written like a case of the team template: under marked it is counted as a case with tags: []
//   (reporting missing tags on template test types); under tagged it is counted as untagged, not a case.
// Identity (W01 R[2]): `<document>:<data.id>` when the id occurs on one case; every copy of an id several cases share gets
// `#1`, `#2`, ... in document order; a missing id, or one too long for an item id, gives `@<node index>`.
// Passes over the visited nodes (walk with an explicit stack, flags from the leaves up, roles, cases) keep it linear; a case
// names its node in the shared table of visited nodes instead of copying the texts of its ancestors.
import { PACK, isRecord, type WarningSink } from './common.ts';
import { clip, selectorSegment, textOf } from './text.ts';
import type { CaseRecord } from './types.ts';

/** The priorities of the team template v3: group 1, case 2, precondition 3 (case-review's defaults). */
export const PRIORITIES = { group: 1, case: 2, precondition: 3 } as const;

export const CASE_LIMITS = {
  /** Deepest level visited, the same as the kityminder@1 parser's default. */
  maxDepth: 200,
  maxItemId: 200,
  /** Longest id selector (the reference selector limit); longer ids are addressed by position. */
  maxSelector: 4096,
  /** Node selectors and ids named in one summary warning. */
  maxNamed: 20,
} as const;

/** The visited nodes of a document in pre-order (a parent before its children): their texts and their parents (-1: root). */
export type NodeTable = { texts: string[]; parents: Int32Array };

export type DocumentCases = {
  cases: CaseRecord[];
  /** Untagged nodes written like cases; under the tagged rule they are not cases. */
  untagged: number;
  markedOnly: number;
  caseRule: 'marked' | 'tagged';
  /** How often each data.id occurs over all nodes: the parser addresses a node by its id only when it occurs once. */
  ids: Map<string, number>;
  /** data.id of the root node, or null. */
  rootId: string | null;
  /** The visited nodes; CaseRecord.visit indexes it. */
  nodes: NodeTable;
};

// Roles of visited nodes.
const OTHER = 0;
const CASE = 1;
const GROUP = 2;
/** An untagged node in the case form, not a case under the tagged rule. */
const CANDIDATE = 3;
/** Inside a case or a candidate. */
const INNER = 4;

type Data = { [key: string]: unknown };
type Visit = { node: number; parent: number; position: number; text: string; leaf: boolean; data: Data };

/** data.id as the parser reads it: a non-empty string, or a finite number written out. */
export function rawIdOf(data: Data): string | null {
  const id = data.id;
  if (typeof id === 'string' && id !== '') return id;
  if (typeof id === 'number' && Number.isFinite(id)) return String(id);
  return null;
}

const isTagged = (data: Data): boolean => Array.isArray(data.resource) && data.resource.length > 0;
const dataOf = (raw: unknown): Data => (isRecord(raw) && isRecord(raw.data) ? raw.data : {});

/** The `n/<id>` selector the parser gives a node whose id occurs once, or null. */
export function idSelector(id: string | null, ids: ReadonlyMap<string, number>): string | null {
  if (id === null || ids.get(id) !== 1 || id.startsWith('@')) return null;
  const segment = selectorSegment(id);
  return segment !== null && segment.length + 2 <= CASE_LIMITS.maxSelector ? `n/${segment}` : null;
}

/** Texts of the ancestors of a case, from the root (the document title) down to its parent. */
export function casePath(nodes: NodeTable, record: Pick<CaseRecord, 'visit'>): string[] {
  const path: string[] = [];
  for (let at = nodes.parents[record.visit]; at !== -1; at = nodes.parents[at]) path.push(nodes.texts[at]);
  return path.reverse();
}

export function casesOf(
  documentId: string,
  nodes: readonly unknown[],
  warnings: WarningSink,
  options: { caseRule?: 'tagged' | 'marked' } = {},
): DocumentCases {
  const caseRule = options.caseRule ?? 'marked';
  const n = nodes.length;
  const stats = { malformed: 0, deep: 0, nonTextTags: 0 };

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
    const text = typeof raw.text === 'string' ? raw.text : (textOf(data.text) ?? '');
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
    if (frame.depth >= CASE_LIMITS.maxDepth) {
      stats.deep += childList.length;
      continue;
    }
    for (let k = childList.length - 1; k >= 0; k--) stack.push({ node: childList[k][0], parent: visit, position: childList[k][1], depth: frame.depth + 1 });
  }

  // 2. From the leaves up: does a node hold a tagged node or a node with the case priority?
  const holds = new Uint8Array(visits.length);
  for (let v = visits.length - 1; v > 0; v--) {
    const { parent, data } = visits[v];
    if (holds[v] === 1 || isTagged(data) || data.priority === PRIORITIES.case) holds[parent] = 1;
  }

  // 3. Roles, top down. `within`: the case or candidate a node sits in, -1 outside all of them.
  const role = new Uint8Array(visits.length);
  const within = new Int32Array(visits.length).fill(-1);
  const taggedGroups = { count: 0, nodes: [] as number[] };
  for (let v = 0; v < visits.length; v++) {
    const { parent, data, leaf } = visits[v];
    const inside = parent === -1 ? -1 : role[parent] === CASE || role[parent] === CANDIDATE ? parent : within[parent];
    within[v] = inside;
    if (isTagged(data)) {
      role[v] = inside === -1 && data.priority === PRIORITIES.group && holds[v] === 1 ? GROUP : CASE;
      if (role[v] === GROUP) {
        taggedGroups.count += 1;
        if (taggedGroups.nodes.length < CASE_LIMITS.maxNamed) taggedGroups.nodes.push(v);
      }
    } else if (inside !== -1) role[v] = INNER;
    else if (data.priority === PRIORITIES.case && !leaf && holds[v] === 0) role[v] = caseRule === 'marked' ? CASE : CANDIDATE;
    else if (Object.hasOwn(data, 'priority')) role[v] = GROUP;
    else role[v] = OTHER;
  }

  // 4. Identities. Ids are counted over every node, as the parser does; numbering counts cases only, and a pack identity
  // never takes the id of a real node.
  const ids = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const id = rawIdOf(dataOf(nodes[i]));
    if (id !== null) ids.set(id, (ids.get(id) ?? 0) + 1);
  }
  const real = new Set<string>();
  for (const id of ids.keys()) real.add(`${documentId}:${id}`);
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
  const caseIdentity = (visit: Visit): string => {
    const rawId = rawIdOf(visit.data);
    if (rawId === null) {
      numbering.missing += 1;
      return positional(visit.node);
    }
    const plain = `${documentId}:${rawId}`;
    if (plain.length > CASE_LIMITS.maxItemId) {
      numbering.unusable += 1;
      return positional(visit.node);
    }
    if (caseIds.get(rawId) === 1) {
      assigned.add(plain);
      return plain;
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
    if (id.length > CASE_LIMITS.maxItemId) return positional(visit.node);
    assigned.add(id);
    return id;
  };
  const locate = (v: number): string => {
    const selector = idSelector(rawIdOf(visits[v].data), ids);
    if (selector !== null) return selector;
    const steps: string[] = [];
    for (let at = v; visits[at].parent !== -1; at = visits[at].parent) steps.push(String(visits[at].position));
    return ['i', ...steps.reverse()].join('/');
  };

  // 5. Cases in document order; the nodes inside a case fill its texts.
  const cases: CaseRecord[] = [];
  const caseOf = new Int32Array(visits.length).fill(-1);
  const stepOf = new Int32Array(visits.length).fill(-1);
  const untagged = { count: 0, nodes: [] as string[] };
  let markedOnly = 0;
  for (let v = 0; v < visits.length; v++) {
    const visit = visits[v];
    if (role[v] === CASE) {
      const tags: string[] = [];
      const resource = Array.isArray(visit.data.resource) ? (visit.data.resource as unknown[]) : [];
      for (const entry of resource) {
        const tag = typeof entry === 'string' ? entry : null;
        if (tag === null) stats.nonTextTags += 1;
        else tags.push(tag);
      }
      if (!isTagged(visit.data)) markedOnly += 1;
      caseOf[v] = cases.length;
      cases.push({ id: caseIdentity(visit), nodeId: rawIdOf(visit.data), visit: v, title: visit.text, tags, resource:visit.data.resource, ...(Object.hasOwn(visit.data, 'category_ids') ? { category_ids: visit.data.category_ids } : {}), steps: [], expected: [], preconditions: [] });
    } else if (role[v] === INNER) {
      const owner = within[v];
      if (role[owner] !== CASE) continue; // inside a candidate: not a case
      const record = cases[caseOf[owner]];
      const parentStep = visit.parent === owner ? -1 : stepOf[visit.parent];
      if (visit.leaf && visit.data.priority === PRIORITIES.precondition) record.preconditions.push(visit.text);
      else if (parentStep === -1 && !visit.leaf) {
        record.steps.push(visit.text);
        stepOf[v] = record.steps.length - 1;
      } else if (visit.leaf) record.expected.push(visit.text);
      else stepOf[v] = parentStep;
    } else if (role[v] === CANDIDATE) {
      untagged.count += 1;
      if (untagged.nodes.length < CASE_LIMITS.maxNamed) untagged.nodes.push(locate(v));
    }
  }

  // Summaries of the document.
  if (untagged.count > 0) {
    warnings.note({
      code: `${PACK}.untagged_cases`,
      message: `${untagged.count} 个没有标签的节点像用例（优先级 ${PRIORITIES.case}、有子节点、下面没有别的用例），按规则 case_rule=tagged 没有计入：模板 v3 的用例要带测试类型标签`,
      document: documentId,
      data: { count: untagged.count, nodes: untagged.nodes },
    });
  }
  if (taggedGroups.count > 0) {
    warnings.note({
      code: `${PACK}.tagged_group`,
      message: `${taggedGroups.count} 个带标签的节点有分组的优先级 ${PRIORITIES.group}、下面有用例，按分组处理：它们的标签不计入任何类别；下面的用例都去掉后，这样的节点会算用例`,
      document: documentId,
      data: { count: taggedGroups.count, nodes: taggedGroups.nodes.map(locate) },
    });
  }
  if (numbering.duplicated > 0) {
    const examples = numbering.duplicatedIds.slice(0, CASE_LIMITS.maxNamed).map((id) => clip(id, 60).text);
    warnings.note({
      code: `${PACK}.node_id_duplicate`,
      message: `${numbering.duplicated} 个用例共用 ${numbering.duplicatedIds.length} 个节点编号（${examples.slice(0, 5).join('、')}${numbering.duplicatedIds.length > 5 ? ' 等' : ''}），作为证据时每个副本编为带序号的编号（编号#1、编号#2 …，按文档顺序），跨修订不对应`,
      document: documentId,
      data: { cases: numbering.duplicated, ids: numbering.duplicatedIds.length, examples },
    });
  }
  if (numbering.missing > 0) {
    warnings.note({ code: `${PACK}.node_id_missing`, message: `${numbering.missing} 个用例没有节点编号，作为证据时按位置编号（@节点序号），跨修订不对应`, document: documentId, data: { count: numbering.missing } });
  }
  if (numbering.unusable > 0) {
    warnings.note({
      code: `${PACK}.node_id_unusable`,
      message: `${numbering.unusable} 个用例的节点编号太长，写不进 ${CASE_LIMITS.maxItemId} 个字符的编号，作为证据时按位置编号，跨修订不对应`,
      document: documentId,
      data: { count: numbering.unusable },
    });
  }
  const counted: Array<[number, string, string]> = [
    [stats.malformed, 'model_malformed', `文档结构有 ${stats.malformed} 处异常（节点不是对象、子节点下标无效或节点被引用多次），这些地方没有读取`],
    [stats.deep, 'depth_limit', `文档超过 ${CASE_LIMITS.maxDepth} 层，更深的 ${stats.deep} 个子树没有读取`],
    [stats.nonTextTags, 'tag_not_text', `${stats.nonTextTags} 个标签不是文字，已忽略`],
  ];
  for (const [count, code, message] of counted) if (count > 0) warnings.note({ code: `${PACK}.${code}`, message, document: documentId, data: { count } });

  const table: NodeTable = { texts: visits.map((visit) => visit.text), parents: Int32Array.from(visits, (visit) => visit.parent) };
  return { cases, untagged: untagged.count, markedOnly, caseRule, ids, rootId: n > 0 ? rawIdOf(dataOf(nodes[0])) : null, nodes: table };
}

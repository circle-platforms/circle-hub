// The case nodes of a parsed KityMinder test mind map (kityminder@1 model: nodes in pre-order with child indices, texts,
// data and canonical selectors), by the case rule of the case-review projection (packs/workflow/case-review project.ts):
// - a tagged node (non-empty `resource`) is a case, unless it sits outside every case with the group priority and holds
//   tagged nodes or nodes with the case priority (then it is a group);
// - an untagged node outside every case with the case priority that has children and holds neither is a case too (the
//   team template's case marker: the marked rule); a node either rule names is one case;
// - inside a case a leaf is an expected result unless it carries the precondition priority; a child with children is a
//   step, the leaves below it are expected results too; a case below a case is a case of its own.
// Passes over the visited nodes (walk with an explicit stack, flags from the leaves up, roles top down) keep a document
// linear in its size; hostile models (invalid child indices, cycles, shared children, deep trees) are survived and counted.
// caseKeys gives each case the node part of its case-review item id (`<document>:<key>`).
import { CASE_RULE, isBlank } from './cases-rules.ts';
import { isRecord } from './util.ts';

export type CaseNode = {
  caseStructure?:unknown;
  /** Index of the node in model.nodes. */
  index: number;
  /** The parser's canonical selector of the node. */
  selector: string;
  /** data.id when it is a non-empty string or a finite number (as text), else null: the ids case-review numbers by. */
  id: string | null;
  title: string;
  /** Texts of the nodes above the case, from the mind map's root down. */
  path: string[];
  priority: number | string | null;
  tags: string[];
  /** Original author field, without text conversion or trimming. */
  resource?: unknown;
  expectedCount: number;
  /** Some expected text is not blank. */
  hasExpected: boolean;
  steps: number;
  /** Step and expected-result text, kept for the same deterministic command scan as titles. */
  bodyTexts: string[];
  stepTexts?:string[];
  expectedTexts?:string[];
  autoid: string | null;
  /** Named by the tagged rule (else by the marked rule only). */
  tagged: boolean;
};

export type CaseScan = { cases: CaseNode[]; nodes: number; malformed: number; deep: number };

/** Deepest level visited, as the kityminder@1 parser and the case-review projection. */
export const MAX_DEPTH = 200;

const OTHER = 0;
const CASE = 1;
const GROUP = 2;
const INNER = 3;

type Visit = { node: number; parent: number; text: string; leaf: boolean; data: Record<string, unknown>; selector: string | null };

const textOf = (value: unknown): string | null =>
  typeof value === 'string' ? value : (typeof value === 'number' && Number.isFinite(value)) || typeof value === 'boolean' ? String(value) : null;

const isTagged = (data: Record<string, unknown>): boolean => Array.isArray(data.resource) && data.resource.length > 0;

/** data.id as case-review reads it (project.ts rawIdOf): a non-empty string, or a finite number as text. */
function rawIdOf(data: unknown): string | null {
  const id = isRecord(data) ? data.id : undefined;
  if (typeof id === 'string' && id !== '') return id;
  return typeof id === 'number' && Number.isFinite(id) ? String(id) : null;
}

function priorityOf(data: Record<string, unknown>): number | string | null {
  const value = data.priority;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return typeof value === 'string' ? value : null;
}

/** Every case node of a kityminder@1 model, in document order. */
export function caseNodes(model: unknown): CaseScan {
  const nodes = isRecord(model) && Array.isArray(model.nodes) ? (model.nodes as unknown[]) : [];
  const n = nodes.length;
  const out: CaseScan = { cases: [], nodes: n, malformed: 0, deep: 0 };
  if (n === 0) return out;

  // 1. Pre-order walk from the root with an explicit stack; each node at most once.
  const visits: Visit[] = [];
  const reached = new Uint8Array(n);
  type Frame = { node: number; parent: number; depth: number };
  const stack: Frame[] = [{ node: 0, parent: -1, depth: 0 }];
  while (stack.length > 0) {
    const frame = stack.pop() as Frame;
    const raw = nodes[frame.node];
    if (reached[frame.node] === 1 || !isRecord(raw)) {
      out.malformed += 1;
      continue;
    }
    reached[frame.node] = 1;
    const data = isRecord(raw.data) ? raw.data : {};
    const text = typeof raw.text === 'string' ? raw.text : (textOf(data.text) ?? '');
    const children: number[] = [];
    for (const child of Array.isArray(raw.children) ? raw.children : []) {
      if (typeof child === 'number' && Number.isSafeInteger(child) && child > 0 && child < n) children.push(child);
      else out.malformed += 1;
    }
    const visit = visits.length;
    visits.push({ node: frame.node, parent: frame.parent, text, leaf: children.length === 0, data, selector: typeof raw.selector === 'string' && raw.selector !== '' ? raw.selector : null });
    if (frame.depth >= MAX_DEPTH) {
      out.deep += children.length;
      continue;
    }
    for (let k = children.length - 1; k >= 0; k--) stack.push({ node: children[k], parent: visit, depth: frame.depth + 1 });
  }

  // 2. From the leaves up: does a node hold a tagged node or a node with the case priority?
  const holds = new Uint8Array(visits.length);
  for (let v = visits.length - 1; v > 0; v--) {
    const { parent, data } = visits[v];
    if (holds[v] === 1 || isTagged(data) || data.priority === CASE_RULE.casePriority) holds[parent] = 1;
  }

  // 3. Roles top down; `within` is the case a node sits in (-1 outside every case).
  const role = new Uint8Array(visits.length);
  const within = new Int32Array(visits.length).fill(-1);
  for (let v = 0; v < visits.length; v++) {
    const { parent, data, leaf } = visits[v];
    const inside = parent === -1 ? -1 : role[parent] === CASE ? parent : within[parent];
    within[v] = inside;
    if (isTagged(data)) role[v] = inside === -1 && data.priority === CASE_RULE.groupPriority && holds[v] === 1 ? GROUP : CASE;
    else if (inside !== -1) role[v] = INNER;
    else if (data.priority === CASE_RULE.casePriority && !leaf && holds[v] === 0) role[v] = CASE;
    else if (Object.hasOwn(data, 'priority')) role[v] = GROUP;
    else role[v] = OTHER;
  }

  // 4. The cases and their contents, in document order.
  const stateOf = new Int32Array(visits.length).fill(-1);
  const stepOf = new Int32Array(visits.length).fill(-1);
  const states: CaseNode[] = [];
  for (let v = 0; v < visits.length; v++) {
    const visit = visits[v];
    if (role[v] === CASE) {
      const path: string[] = [];
      for (let at = visit.parent; at !== -1; at = visits[at].parent) path.push(visits[at].text);
      path.reverse();
      const tags: string[] = [];
      for (const entry of Array.isArray(visit.data.resource) ? (visit.data.resource as unknown[]) : []) {
        const tag = typeof entry === 'string' ? entry : null;
        if (tag !== null) tags.push(tag);
      }
      const autoid = textOf(visit.data.autoid);
      stateOf[v] = states.length;
      states.push({
        index: visit.node,
        selector: visit.selector ?? '',
        id: rawIdOf(visit.data),
        title: visit.text,
        path,
        priority: priorityOf(visit.data),
        tags,
        resource: visit.data.resource,
        caseStructure:visit.data.case_structure,
        expectedCount: 0,
        hasExpected: false,
        steps: 0,
        bodyTexts: [],
        stepTexts:[],expectedTexts:[],
        autoid: autoid === null || isBlank(autoid) ? null : autoid,
        tagged: isTagged(visit.data),
      });
    } else if (role[v] === INNER) {
      const owner = within[v];
      const state = states[stateOf[owner]];
      const parentStep = visit.parent === owner ? -1 : stepOf[visit.parent];
      if (visit.leaf && visit.data.priority === CASE_RULE.preconditionPriority) continue;
      state.bodyTexts.push(visit.text);
      if (parentStep === -1 && !visit.leaf) {
        state.steps += 1;state.stepTexts!.push(visit.text);
        stepOf[v] = state.steps;
      } else if (visit.leaf) {
        state.expectedCount += 1;state.expectedTexts!.push(visit.text);
        if (!isBlank(visit.text)) {
          state.hasExpected = true;
        }
      } else stepOf[v] = parentStep;
    }
  }
  for (const state of states) {
    if (state.selector === '') out.malformed += 1;
    else out.cases.push(state);
  }
  return out;
}

/** Longest item id `<document>:<key>` case-review writes with a node id; a longer one is positional (project.ts maxItemId). */
export const MAX_ITEM_ID = 200;

/**
 * The key of each case (the node part of its case-review item id `<document>:<key>`, W01 R[2], project.ts caseIdentity):
 * data.id when that id is on one case of the document (counted over the cases only, so an expected result copied with its
 * case's id does not change the case's key); the copies of an id several cases share `<id>#1`, `<id>#2`, ... in document
 * order; a case without a usable id (none, or `<document>:<id>` over MAX_ITEM_ID units) `@<node index>`. A numbered or
 * positional key never takes a key already given or the id of any node of the document (it counts on: `#3`, `@7#2`).
 */
export function caseKeys(model: unknown, cases: readonly CaseNode[], documentId: string): string[] {
  const nodes = isRecord(model) && Array.isArray(model.nodes) ? (model.nodes as unknown[]) : [];
  const real = new Set<string>();
  for (const node of nodes) {
    const id = rawIdOf(isRecord(node) ? node.data : undefined);
    if (id !== null) real.add(id);
  }
  const onCases = new Map<string, number>();
  for (const node of cases) if (node.id !== null) onCases.set(node.id, (onCases.get(node.id) ?? 0) + 1);
  const assigned = new Set<string>();
  const free = (key: string): boolean => !assigned.has(key) && !real.has(key);
  const fits = (key: string): boolean => documentId.length + 1 + key.length <= MAX_ITEM_ID;
  const positional = (index: number): string => {
    let key = `@${index}`;
    for (let k = 2; !free(key); k++) key = `@${index}#${k}`;
    assigned.add(key);
    return key;
  };
  const copies = new Map<string, number>();
  return cases.map((node) => {
    const id = node.id;
    if (id === null || !fits(id)) return positional(node.index);
    if (onCases.get(id) === 1) {
      assigned.add(id);
      return id;
    }
    let k = copies.get(id) ?? 0;
    let key: string;
    do {
      k += 1;
      key = `${id}#${k}`;
    } while (!free(key));
    copies.set(id, k);
    if (!fits(key)) return positional(node.index);
    assigned.add(key);
    return key;
  });
}

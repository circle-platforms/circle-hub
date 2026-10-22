// Injects known defects into a copy of a KityMinder export and writes down what was injected, so that the review of the copy
// can be scored against an answer that is independent of the Hub (brief section 6b, review). The source is never changed; the
// copy and the gold hold real content and belong outside Git.
import { createHash } from 'node:crypto';

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
  | { kind: 'move'; node: string; to: string };

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
  /** The node the defect sits on (for a duplicate: the original). */
  node: string;
  /** The copy a duplicate made; both are the defect. */
  copy?: string;
  note: string;
}

const isCase = (node: MindNode): boolean => Array.isArray(node.data.resource) && node.data.resource.length > 0;

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

/** The document up to and including the n-th case: everything after it is cut, groups that start before it stay. */
export function firstCases(tree: MindTree, n: number): MindTree {
  const copy = clone(tree);
  let seen = 0;
  let done = false;
  const cut = (node: MindNode): void => {
    if (isCase(node)) {
      seen += 1;
      if (seen >= n) done = true;
      return;
    }
    const kept: MindNode[] = [];
    for (const child of node.children ?? []) {
      if (done) break;
      kept.push(child);
      cut(child);
    }
    if (node.children !== undefined) node.children = kept;
  };
  cut(copy.root);
  return copy;
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
  if (found === null) throw new Error(`node ${id} is not in the document`);
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

/** Applies the planned defects to a copy of the tree, in order; returns the copy and what was done. */
export function inject(tree: MindTree, plan: readonly Planned[]): { tree: MindTree; gold: GoldEntry[] } {
  const copy = clone(tree);
  const gold: GoldEntry[] = [];
  for (const { label, seen_by, op } of plan) {
    const { node, parent } = locate(copy, op.node);
    if (!isCase(node)) throw new Error(`node ${op.node} is not a case (it carries no tag)`);
    if (op.kind === 'delete_expected') {
      node.children = [];
      gold.push({ label, seen_by, node: op.node, note: '期望结果整个删掉' });
    } else if (op.kind === 'replace_expected') {
      const first = node.children?.[0];
      if (first === undefined) node.children = [{ data: { id: copyId(`${op.node}:expected`), text: op.text }, children: [] }];
      else first.data.text = op.text;
      gold.push({ label, seen_by, node: op.node, note: '期望结果换成另一段文字' });
    } else if (op.kind === 'duplicate') {
      if (parent === null) throw new Error('the root cannot be duplicated');
      const twin = copyOf(node);
      const siblings = parent.children ?? [];
      siblings.splice(siblings.indexOf(node) + 1, 0, twin);
      parent.children = siblings;
      gold.push({ label, seen_by, node: op.node, copy: idOf(twin), note: '同一分组里多了一份完全相同的用例' });
    } else {
      if (parent === null) throw new Error('the root cannot be moved');
      const target = locate(copy, op.to).node;
      if (isCase(target)) throw new Error(`node ${op.to} is a case, not a group`);
      parent.children = (parent.children ?? []).filter((c) => c !== node);
      target.children = [...(target.children ?? []), node];
      gold.push({ label, seen_by, node: op.node, note: `用例挪到了分组 ${op.to} 下` });
    }
  }
  return { tree: copy, gold };
}

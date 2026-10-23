// The metamorphic copies and expectations of the template-gap check (task gold-template-gap step 2), computed purely.
// Copies are made of the ORIGINAL exported mind map; cases follow the independent rule of gold/cases.ts (caseNodesOf,
// the default 'marked', same as the pack's default). The expectation is a single relation: a copy's missing set is
// the intersection of the missing sets of the single-case copies it contains (for a and f of two documents, the
// single-case copies of both count). The 24 categories and the type-label/keyword split come from the pack's table
// file read with JSON.parse for id, label and group only — tags, contains, prefixes, equals and fields are never
// read, so the pack's own deciding cannot leak into the expectation. What the type-name check needs is written here
// (the six names of architecture 6a line 120), not read from the pack.
import { caseNodesOf, parseMindMap, type GoldMap, type GoldNode } from './cases.ts';

export interface TemplateCategory {
  id: string;
  label: string;
  /** 'test_type' marks a type-label category; everything else is a keyword category. */
  group: string;
}

/** The category table read for id, label and group only (never tags/contains/prefixes/equals/fields). */
export function readCategories(tableJson: unknown): TemplateCategory[] {
  const root = tableJson as { categories?: unknown };
  const list = Array.isArray(root?.categories) ? root.categories : [];
  const out: TemplateCategory[] = [];
  for (const entry of list) {
    const record = entry as { id?: unknown; label?: unknown; group?: unknown };
    if (typeof record.id === 'string' && typeof record.label === 'string' && typeof record.group === 'string') {
      out.push({ id: record.id, label: record.label, group: record.group });
    }
  }
  return out;
}

export type MindNode = { data: { id?: string; text?: string; resource?: string[]; priority?: number; [key: string]: unknown }; children?: MindNode[] };
export type MindTree = { root: MindNode; [key: string]: unknown };

const newRootId = (seed: string): string => `gap-${seed}`;

function renewedId(tree: MindTree, seed: string): string {
  const used = new Set<string>(); const stack = [tree.root];
  while (stack.length) { const node = stack.pop()!; used.add(String(node.data.id ?? '')); stack.push(...(node.children ?? [])); }
  const base = newRootId(seed); let value = base; let at = 0;
  while (used.has(value)) value = `${base}-${++at}`;
  return value;
}

const clone = <T>(value: T): T => structuredClone(value);

const idOf = (node: MindNode): string => String(node.data.id ?? '');
const parsedId = (node: GoldNode): string => node.id;

function locate(tree: MindTree, id: string): MindNode | null {
  const walk = (node: MindNode): MindNode | null => {
    if (idOf(node) === id) return node;
    for (const child of node.children ?? []) {
      const hit = walk(child);
      if (hit !== null) return hit;
    }
    return null;
  };
  return walk(tree.root);
}

/** The outermost cases by the independent rule, as parsed nodes: case nodes with no case among their ancestors
 * (caseNodesOf also lists a tagged node below a case as a case of its own; those are not outermost). */
export function outerCaseNodes(tree: MindTree): GoldNode[] {
  const map = mapOf(tree);
  const cases = caseNodesOf(map, { caseRule: 'marked' });
  const caseIndexes = new Set(cases.map((c) => c.index));
  return cases.filter((c) => {
    for (let at = c.parent; at !== null; at = map.nodes[at]!.parent) {
      if (caseIndexes.has(at)) return false;
    }
    return true;
  });
}

/** The ORIGINAL mind nodes of the outermost cases, in document order (the parsed table keeps no references). */
export function outerCases(tree: MindTree): MindNode[] {
  return outerCaseNodes(tree).map((node) => originalNode(tree, node));
}

/** The mind-node a parsed node came from (same tree, by path): re-walked because GoldNode keeps no reference. */
function originalNode(tree: MindTree, wanted: GoldNode): MindNode {
  // The parsed table lists nodes in walk order (children in order, at most 1000 kept each): the n-th node of the
  // table is the n-th node of the same walk over the mind tree, so one walk finds the original node by index.
  let at = -1;
  const walk = (node: MindNode): MindNode | null => {
    at += 1;
    if (at === wanted.index) return node;
    for (const child of node.children ?? []) {
      const hit = walk(child);
      if (hit !== null) return hit;
    }
    return null;
  };
  const found = walk(tree.root);
  if (found === null) throw new Error('the parsed table and the mind tree do not line up');
  return found;
}

const maps = new WeakMap<MindTree, GoldMap>();
const mapOf = (tree: MindTree): GoldMap => {
  let map = maps.get(tree);
  if (map === undefined) {
    map = parseMindMap(tree);
    maps.set(tree, map);
  }
  return map;
};

/** Copies are trees built from the original's nodes; their own maps are cached the same way. */
const buildFrom = (root: MindNode, extra: Record<string, unknown> = {}): MindTree => ({ root, ...extra });

/** b: every level's children reversed, root id renewed; everything else byte-identical. */
export function reversed(tree: MindTree, seed: string): MindTree {
  const copy = clone(tree);
  const flip = (node: MindNode): void => {
    if (node.children !== undefined) {
      node.children = [...node.children].reverse();
      for (const child of node.children) flip(child);
    }
  };
  flip(copy.root);
  copy.root.data.id = renewedId(tree, seed);
  return copy;
}

/** c: the root, the ancestor chain to one outermost case (each ancestor keeps only the child on the path) and the
 * case's whole subtree; the root id is renewed. */
export function singleCase(tree: MindTree, caseId: string, seed: string): MindTree {
  const map = mapOf(tree);
  const caseNode = map.nodes.find((n) => n.id === caseId);
  if (caseNode === undefined) throw new Error(`没有这个用例 ${caseId}`);
  const chain: number[] = [];
  for (let at = caseNode.index; map.nodes[at]!.parent !== null; at = map.nodes[at]!.parent!) chain.unshift(map.nodes[at]!.parent!);
  let kept: MindNode = clone(originalNode(tree, caseNode));
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    const ancestor = clone(originalNode(tree, map.nodes[chain[i]!]!));
    ancestor.children = [kept];
    kept = ancestor;
  }
  kept.data.id = renewedId(tree, seed);
  return buildFrom(kept, metaOf(tree));
}

const metaOf = (tree: MindTree): Record<string, unknown> => {
  const { root: _root, ...rest } = tree;
  void _root;
  return rest;
};

/** The ids of the outermost cases of a copy, in document order. */
export const outerCaseIdsOf = (tree: MindTree): string[] => outerCases(tree).map(idOf);

/** d: remove every outermost case whose single-case copy has X present (with its subtree). */
export function withoutCategory(tree: MindTree, singleCaseMisses: ReadonlyMap<string, ReadonlySet<string>>, category: string, seed: string): MindTree {
  const copy = clone(tree);
  copy.root.data.id = renewedId(tree, seed);
  const drop = new Set(
    outerCaseIdsOf(tree)
      .filter((id) => !(singleCaseMisses.get(id) ?? new Set()).has(category))
      .filter((id) => singleCaseMisses.has(id)),
  );
  prune(copy.root, drop);
  return copy;
}

const prune = (node: MindNode, drop: ReadonlySet<string>): boolean => {
  if (drop.has(idOf(node))) return false; // the whole subtree goes with the case
  if (node.children !== undefined) node.children = node.children.filter((child) => prune(child, drop));
  return true;
};

/** e: on the d copy, put the document-order-first removed case back under its original parent. */
export function withRestored(tree: MindTree, removed: readonly string[], caseId: string, original: MindTree, seed: string): MindTree {
  void removed;
  const copy = clone(tree);
  const map = mapOf(original);
  const caseNode = map.nodes.find((n) => n.id === caseId);
  if (caseNode === undefined) throw new Error(`没有这个用例 ${caseId}`);
  const parent = caseNode.parent === null ? null : map.nodes[caseNode.parent]!;
  const node = clone(originalNode(original, caseNode));
  const parentInCopy = parent === null ? copy.root : locate(copy, parsedId(parent));
  if (parentInCopy === null) throw new Error(`放不回去：找不到父节点 ${parsedId(parent!)}`);
  parentInCopy.children = [...(parentInCopy.children ?? []), node];
  copy.root.data.id = renewedId(original, seed);
  return copy;
}

/** f: hang B's root (a new id, an ordinary node), the ancestor chain and B's first outermost case with X present,
 * under A's root last. */
export function withJoined(a: MindTree, b: MindTree, category: string, singleCaseMissesOfB: ReadonlyMap<string, ReadonlySet<string>>, seed: string): MindTree {
  const copy = clone(a);
  const bMap = mapOf(b);
  const first = outerCaseIdsOf(b).find((id) => !(singleCaseMissesOfB.get(id) ?? new Set()).has(category) && singleCaseMissesOfB.has(id));
  if (first === undefined) throw new Error(`B 里没有单用例副本显示 ${category} 为有的用例`);
  const caseNode = bMap.nodes.find((n) => n.id === first)!;
  const chain: number[] = [];
  for (let at = caseNode.index; bMap.nodes[at]!.parent !== null; at = bMap.nodes[at]!.parent!) chain.unshift(bMap.nodes[at]!.parent!);
  let hung: MindNode = clone(originalNode(b, caseNode));
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    const ancestor = clone(originalNode(b, bMap.nodes[chain[i]!]!));
    ancestor.children = [hung];
    hung = ancestor;
  }
  hung.data = { ...hung.data, resource: undefined, priority: undefined, id: renewedId(b, `joined-${seed}`) };
  copy.root.children = [...(copy.root.children ?? []), hung];
  copy.root.data.id = renewedId(a, seed);
  return copy;
}

/** The one check that needs no Hub answer: when a case-by-the-independent-rule node has a resource entry exactly one
 * of the six type names (case-insensitively), that type-label category must be present. */
export const TYPE_NAMES = ['Functional', 'Configuration', 'Integration', 'Compatibility', 'Negative', 'Stress'] as const;

export function typeNamePresent(tree: MindTree, categories: readonly TemplateCategory[]): Map<string, Set<string>> {
  // The six type names are the tags to look for (lower-cased); the table's type-label category ids are exactly these
  // names (functional, configuration, integration, compatibility, negative, stress), so the match is by id.
  const typeIds = new Set(categories.filter((c) => c.group === 'test_type').map((c) => c.id));
  const out = new Map<string, Set<string>>();
  for (const node of mapOf(tree).nodes) {
    const tags = node.resource.map((tag) => tag.trim().toLowerCase());
    for (const name of TYPE_NAMES) {
      const id = name.toLowerCase();
      if (typeIds.has(id) && tags.includes(id)) {
        const set = out.get(node.id) ?? new Set<string>();
        set.add(id);
        out.set(node.id, set);
      }
    }
  }
  return out;
}

export type SkipReason =
  | { reason: '前提不成立'; detail: string }
  | { reason: 'X 在每个最外层用例上都有'; detail: string }
  | { reason: '没有单用例副本显示 X'; detail: string }
  | { reason: '单用例副本答案未知'; detail: string };

export interface CopyPlan {
  /** The original with its own new root id. */
  a: MindTree;
  /** b: children reversed at every level. */
  b: MindTree;
  /** One single-case copy per outermost case, in document order. */
  c: MindTree[];
  /** One d copy per category present in the original (by its single-case answers), with why some are skipped. */
  d: Array<{ category: string; copy: MindTree; restored?: MindTree } | { category: string; skipped: SkipReason }>;
  /** One f copy per category present in B's single-case answers but absent in A's, with why some are skipped. */
  f: Array<{ category: string; copy: MindTree } | { category: string; skipped: SkipReason }>;
  /** Categories of the original that could not be decided and why (the single-case answers unknown). */
  undecided: SkipReason[];
}

export interface PlanOptions {
  categories: readonly TemplateCategory[];
  /** The single-case copies' missing sets, by outer case id — the only Hub answers the plan is built on. */
  singleMisses: ReadonlyMap<string, ReadonlySet<string>>;
  /** The other document (B) for the join copies: its outer cases' single-case missing sets. */
  other?: { tree: MindTree; singleMisses: ReadonlyMap<string, ReadonlySet<string>> };
}

/** Builds every copy of one document from the original and the single-case answers. */
export function planCopies(tree: MindTree, seed: string, options: PlanOptions): CopyPlan {
  const { categories, singleMisses } = options;
  const ids = outerCaseIdsOf(tree);
  const known = ids.filter((id) => singleMisses.has(id));
  const unknown = ids.filter((id) => !singleMisses.has(id));
  const undecided: SkipReason[] = unknown.map((id) => ({ reason: '单用例副本答案未知', detail: id }));

  const a = clone(tree);
  a.root.data.id = renewedId(tree, `${seed}-a`);
  const b = reversed(tree, `${seed}-b`);
  const c = ids.map((id, i) => singleCase(tree, id, `${seed}-c${i + 1}`));

  const allIds = categories.map((x) => x.id);
  const originalMissing = expectedMissing(known.map(id => singleMisses.get(id)!));
  const originalPresent = allIds.filter((id) => !originalMissing.has(id));

  const d: CopyPlan['d'] = [];
  for (const category of originalPresent) {
    const owners = known.filter((id) => !(singleMisses.get(id) ?? new Set()).has(category));
    if (unknown.length > 0 && unknown.some((id) => (singleMisses.get(id) ?? new Set()).size === 0)) {
      // An unknown case might carry every category: the premise (each copy's case count = the sum of its single-case
      // counts) still holds, but the target set cannot be decided. Recorded, not guessed.
      d.push({ category, skipped: { reason: '单用例副本答案未知', detail: `未知的用例：${unknown.join('、')}` } });
      continue;
    }
    if (owners.length === known.length && known.length > 0) {
      d.push({ category, skipped: { reason: 'X 在每个最外层用例上都有', detail: `每个已知用例都有 ${category}` } });
      continue;
    }
    const copy = withoutCategory(tree, singleMisses, category, `${seed}-d-${category}`);
    const first = owners[0];
    const restored = first === undefined ? undefined : withRestored(copy, owners, first, tree, `${seed}-e-${category}`);
    d.push({ category, copy, ...(restored === undefined ? {} : { restored }) });
  }

  const f: CopyPlan['f'] = [];
  if (options.other !== undefined) {
    const bIds = outerCaseIdsOf(options.other.tree);
    const bKnown = bIds.filter((id) => options.other!.singleMisses.has(id));
    const bMissing = expectedMissing(bKnown.map(id => options.other!.singleMisses.get(id)!));
    const aMissingSet = new Set(originalMissing);
    for (const category of allIds) {
      if (!aMissingSet.has(category)) continue;
      if (bMissing.has(category) || bKnown.length === 0) {
        f.push({ category, skipped: { reason: '没有单用例副本显示 X', detail: `B 的单用例副本都缺 ${category}` } });
        continue;
      }
      try {
        f.push({ category, copy: withJoined(tree, options.other.tree, category, options.other.singleMisses, `${seed}-f-${category}`) });
      } catch (error) {
        f.push({ category, skipped: { reason: '没有单用例副本显示 X', detail: (error as Error).message } });
      }
    }
  }
  return { a, b, c, d, f, undecided };
}

/** The premise check of one copy, run by the independent rule: its case count equals the sum of the single-case
 * counts it contains (outermost cases in document order, named by their original ids). */
export function premiseOf(copy: MindTree, containedOriginalIds: readonly string[]): { ok: boolean; actual: number; expected: number } {
  const actual = outerCases(copy).length;
  const expected = containedOriginalIds.length;
  return { ok: actual === expected, actual, expected };
}

/** The expected missing set of one copy: the intersection of its contained single-case missing sets. */
export function expectedMissing(contained: readonly ReadonlySet<string>[]): Set<string> {
  if (contained.length === 0) return new Set<string>();
  const [first, ...rest] = contained;
  return new Set([...first!].filter((id) => rest.every((set) => set.has(id))));
}

export { newRootId };

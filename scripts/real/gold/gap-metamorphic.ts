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
  const map = mapOf(tree); const path: number[] = [];
  for (let at = wanted.index; map.nodes[at]!.parent !== null; at = map.nodes[at]!.parent!) path.unshift(map.nodes[map.nodes[at]!.parent!]!.children.indexOf(at));
  let current = tree.root;
  for (const slot of path) { const child = current.children?.[slot]; if (!child) throw new Error('解析节点路径不完整'); current = child; }
  return current;
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
  const caseNode = map.nodes[Number(caseId)];
  if (caseNode === undefined) throw new Error('缺少指定用例索引');
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
/** Stable case keys inside one original document; raw node ids may repeat or be absent. */
export const outerCaseKeysOf = (tree: MindTree): string[] => outerCaseNodes(tree).map(node => String(node.index));

/** d: remove every outermost case whose single-case copy has X present (with its subtree). */
export function withoutCategory(tree: MindTree, singleCaseMisses: ReadonlyMap<string, ReadonlySet<string>>, category: string, seed: string): MindTree {
  const copy = clone(tree); const map = mapOf(tree);
  const drop = new Set(outerCaseKeysOf(tree).filter(key => singleCaseMisses.has(key) && !singleCaseMisses.get(key)!.has(category)));
  const prune = (node: MindNode, index: number): boolean => {
    if (drop.has(String(index))) return false;
    if (node.children) node.children = node.children.filter((child, slot) => { const childIndex = map.nodes[index]?.children[slot]; return childIndex === undefined || prune(child, childIndex); });
    return true;
  };
  prune(copy.root, 0); copy.root.data.id = renewedId(tree, seed); return copy;
}

/** e: on the d copy, put the document-order-first removed case back under its original parent. */
export function withRestored(tree: MindTree, removed: readonly string[], caseId: string, original: MindTree, seed: string): MindTree {
  const copy = clone(tree);
  const map = mapOf(original);
  const caseNode = map.nodes[Number(caseId)];
  if (caseNode === undefined) throw new Error('缺少指定用例索引');
  const parent = caseNode.parent === null ? null : map.nodes[caseNode.parent]!;
  const node = clone(originalNode(original, caseNode));
  const path: number[] = [];
  for (let at = parent?.index ?? 0; map.nodes[at]!.parent !== null; at = map.nodes[at]!.parent!) {
    const above = map.nodes[map.nodes[at]!.parent!]!; path.unshift(above.children.indexOf(at));
  }
  let parentInCopy: MindNode = copy.root; let originalParent = original.root;
  const dropped = new Set(removed);
  let originalIndex = 0;
  for (const slot of path) {
    const siblings = originalParent.children ?? [];
    const childIndexes = map.nodes[originalIndex]!.children;
    const keptSlot = childIndexes.slice(0, slot).filter(index => !dropped.has(String(index))).length;
    originalIndex = childIndexes[slot]!;
    const next = parentInCopy.children?.[keptSlot];
    if (!next || !siblings[slot]) throw new Error('放不回去：缺少原始父节点路径');
    parentInCopy = next; originalParent = siblings[slot]!;
  }
  parentInCopy.children = [...(parentInCopy.children ?? []), node];
  copy.root.data.id = renewedId(original, seed);
  return copy;
}

/** f: hang B's root (a new id, an ordinary node), the ancestor chain and B's first outermost case with X present,
 * under A's root last. */
export function withJoined(a: MindTree, b: MindTree, category: string, singleCaseMissesOfB: ReadonlyMap<string, ReadonlySet<string>>, seed: string): MindTree {
  const copy = clone(a);
  const bMap = mapOf(b);
  const first = outerCaseKeysOf(b).find((id) => !(singleCaseMissesOfB.get(id) ?? new Set()).has(category) && singleCaseMissesOfB.has(id));
  if (first === undefined) throw new Error('未找到显示目标类别的单用例副本');
  const caseNode = bMap.nodes[Number(first)]!;
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
  for (const node of caseNodesOf(mapOf(tree), { caseRule: 'marked' })) {
    const tags = node.resource.map((tag) => tag.trim().toLowerCase());
    for (const name of TYPE_NAMES) {
      const id = name.toLowerCase();
      if (typeIds.has(id) && tags.includes(id)) {
        const set = out.get(String(node.index)) ?? new Set<string>();
        set.add(id);
        out.set(String(node.index), set);
      }
    }
  }
  return out;
}

export const caseCountOf = (tree: MindTree): number => caseNodesOf(mapOf(tree), { caseRule: 'marked' }).length;
export function typeNamesInCase(tree: MindTree, key: string, categories: readonly TemplateCategory[]): Set<string> {
  const map = mapOf(tree); const present = typeNamePresent(tree, categories); const out = new Set<string>();
  for (const [nodeKey, types] of present) for (let at: number | null = Number(nodeKey); at !== null; at = map.nodes[at]!.parent) {
    if (String(at) === key) { types.forEach(type => out.add(type)); break; }
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
  /** The single-case copies' missing sets, by original parsed case index — the only Hub answers the plan is built on. */
  singleMisses: ReadonlyMap<string, ReadonlySet<string>>;
  /** The other document (B) for the join copies: its outer cases' single-case missing sets. */
  other?: { tree: MindTree; singleMisses: ReadonlyMap<string, ReadonlySet<string>> };
}

/** Builds every copy of one document from the original and the single-case answers. */
export function planCopies(tree: MindTree, seed: string, options: PlanOptions): CopyPlan {
  const { categories, singleMisses } = options;
  const ids = outerCaseKeysOf(tree);
  const known = ids.filter((id) => singleMisses.has(id));
  const unknown = ids.filter((id) => !singleMisses.has(id));
  const undecided: SkipReason[] = unknown.map((id) => ({ reason: '单用例副本答案未知', detail: `第 ${ids.indexOf(id) + 1} 个用例缺少答案` }));

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
      d.push({ category, skipped: { reason: '单用例副本答案未知', detail: `缺少 ${unknown.length} 个单用例答案` } });
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
    const bIds = outerCaseKeysOf(options.other.tree);
    const bKnown = bIds.filter((id) => options.other!.singleMisses.has(id));
    const bMissing = expectedMissing(bKnown.map(id => options.other!.singleMisses.get(id)!));
    const aMissingSet = new Set(originalMissing);
    for (const category of allIds) {
      if (!aMissingSet.has(category)) continue;
      if (unknown.length > 0) { f.push({ category, skipped: { reason: '单用例副本答案未知', detail: `缺少 ${unknown.length} 个基础单用例答案` } }); continue; }
      if ((bMissing.has(category) || bKnown.length === 0) && bKnown.length < bIds.length) { f.push({ category, skipped: { reason: '单用例副本答案未知', detail: `缺少 ${bIds.length - bKnown.length} 个供体单用例答案` } }); continue; }
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
export function premiseOf(copy: MindTree, containedOriginalIds: readonly string[], counts?: ReadonlyMap<string, number>): { ok: boolean; actual: number; expected: number } {
  const actual = caseCountOf(copy);
  const expected = containedOriginalIds.reduce((sum, id) => sum + (counts?.get(id) ?? 1), 0);
  return { ok: actual === expected, actual, expected };
}

/** The expected missing set of one copy: the intersection of its contained single-case missing sets. */
export function expectedMissing(contained: readonly ReadonlySet<string>[]): Set<string> {
  if (contained.length === 0) return new Set<string>();
  const [first, ...rest] = contained;
  return new Set([...first!].filter((id) => rest.every((set) => set.has(id))));
}

export { newRootId };

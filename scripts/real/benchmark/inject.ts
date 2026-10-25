// Deterministic defect injection into a KityMinder mind map, with the ground truth of what was injected. Used by the real
// acceptance scripts: the Hub's mechanical requirements must flag every injected defect they can see (6b of the architecture
// brief), and the model's findings are scored against the same list. Nothing here knows a product: a case is a node with a
// non-empty `resource` tag list, its expected results are its leaf children (the team convention of the case-review pack).
// The input document is never changed; the mutated copy and the truth come back.

import {declareResourceTags} from '../../../packs/workflow/case-review/api.ts';

export type NodeData = { id?: string; text?: string; priority?: unknown; resource?: unknown; [key: string]: unknown };
export type MapNode = { data: NodeData; children?: MapNode[] };
export type MindMap = { root: MapNode; [key: string]: unknown };

/** Defects the Hub's structure and coverage requirements are able to see by themselves (no model needed). */
export const INJECT_KINDS = ['duplicate_title', 'empty_title', 'bad_priority', 'no_expected', 'two_expected', 'empty_expected', 'remove_negative'] as const;
export type InjectKind = (typeof INJECT_KINDS)[number];

export interface Injected {
  kind: InjectKind;
  /** Item id the defect sits on (`<document>:<data.id>`), or null for a defect of the whole document. */
  item: string | null;
  /** data.id of the node that was changed or added, or null for a document-level defect. */
  node: string | null;
  detail: string;
}

export interface InjectOptions {
  documentId: string;
  seed: number;
  /** How many of each kind; at most one defect per case, so fewer may be placed when the document is small. */
  counts: Partial<Record<InjectKind, number>>;
}

export interface InjectResult {
  map: MindMap;
  truth: Injected[];
  /** Kinds that could not be fully placed, with how many were placed. */
  shortfalls: { kind: InjectKind; wanted: number; placed: number }[];
}

/** mulberry32: a small seeded generator, so a benchmark is repeatable. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const isCase = (n: MapNode): boolean => Array.isArray(n.data?.resource) && (n.data.resource as unknown[]).length > 0;
const isNegative = (n: MapNode): boolean => declareResourceTags(n.data.resource).negative===true;

interface Found {
  node: MapNode;
  parent: MapNode | null;
}

function cases(root: MapNode): Found[] {
  const out: Found[] = [];
  const walk = (node: MapNode, parent: MapNode | null) => {
    if (isCase(node)) out.push({ node, parent });
    for (const child of node.children ?? []) walk(child, node);
  };
  walk(root, null);
  return out;
}

/** Expected results of a case: its leaf children (children without children of their own). */
const expectedOf = (n: MapNode): MapNode[] => (n.children ?? []).filter((c) => (c.children ?? []).length === 0);

function shuffled<T>(items: T[], next: () => number): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function injectDefects(input: MindMap, options: InjectOptions): InjectResult {
  const map = structuredClone(input);
  const next = rng(options.seed);
  const found = cases(map.root);
  const used = new Set<MapNode>();
  const truth: Injected[] = [];
  const shortfalls: InjectResult['shortfalls'] = [];
  let serial = 0;
  const itemId = (n: MapNode): string => `${options.documentId}:${n.data.id ?? ''}`;

  const place = (kind: InjectKind, wanted: number, usable: (f: Found) => boolean, apply: (f: Found) => Injected | null) => {
    let placed = 0;
    for (const f of shuffled(found.filter((c) => !used.has(c.node) && usable(c)), next)) {
      if (placed >= wanted) break;
      const result = apply(f);
      if (result === null) continue;
      used.add(f.node);
      truth.push(result);
      placed++;
    }
    if (placed < wanted) shortfalls.push({ kind, wanted, placed });
  };

  const hasExpected = (f: Found): boolean => expectedOf(f.node).some((e) => typeof e.data?.text === 'string' && e.data.text.trim() !== '');
  const count = (kind: InjectKind): number => options.counts[kind] ?? 0;

  // Whole-document defect first, so that no later defect lands on a case that is about to disappear.
  if (count('remove_negative') > 0) {
    const negatives = found.filter((f) => f.parent !== null && isNegative(f.node));
    for (const f of negatives) {
      const siblings = (f.parent as MapNode).children as MapNode[];
      const at = siblings.indexOf(f.node);
      if (at >= 0) siblings.splice(at, 1);
      found.splice(found.indexOf(f), 1);
    }
    if (negatives.length > 0) truth.push({ kind: 'remove_negative', item: null, node: null, detail: `删掉了全部 ${negatives.length} 个反向用例` });
    else shortfalls.push({ kind: 'remove_negative', wanted: 1, placed: 0 });
  }

  place('duplicate_title', count('duplicate_title'), (f) => f.parent !== null && typeof f.node.data.text === 'string' && f.node.data.text.trim() !== '', (f) => {
    const copy = structuredClone(f.node);
    serial++;
    copy.data.id = `inj${options.seed}x${serial}`;
    const siblings = (f.parent as MapNode).children as MapNode[];
    siblings.splice(siblings.indexOf(f.node) + 1, 0, copy);
    return { kind: 'duplicate_title', item: itemId(copy), node: copy.data.id, detail: `复制了用例“${String(copy.data.text).slice(0, 30)}”，标题与路径都相同` };
  });
  place('empty_title', count('empty_title'), (f) => typeof f.node.data.text === 'string' && f.node.data.text.trim() !== '', (f) => {
    f.node.data.text = '';
    return { kind: 'empty_title', item: itemId(f.node), node: String(f.node.data.id ?? ''), detail: '把用例标题清空' };
  });
  place('bad_priority', count('bad_priority'), (f) => f.node.data.priority !== undefined, (f) => {
    f.node.data.priority = 9;
    return { kind: 'bad_priority', item: itemId(f.node), node: String(f.node.data.id ?? ''), detail: '把优先级改成 9' };
  });
  place('no_expected', count('no_expected'), (f) => hasExpected(f), (f) => {
    const gone = new Set(expectedOf(f.node));
    f.node.children = (f.node.children ?? []).filter((c) => !gone.has(c));
    return { kind: 'no_expected', item: itemId(f.node), node: String(f.node.data.id ?? ''), detail: `删掉了 ${gone.size} 个期望结果` };
  });
  place('two_expected', count('two_expected'), (f) => hasExpected(f), (f) => {
    const first = expectedOf(f.node).find((e) => typeof e.data?.text === 'string' && e.data.text.trim() !== '') as MapNode;
    const copy = structuredClone(first);
    serial++;
    copy.data.id = `inj${options.seed}x${serial}`;
    (f.node.children as MapNode[]).push(copy);
    return { kind: 'two_expected', item: itemId(f.node), node: copy.data.id, detail: '给用例多加了一个期望结果' };
  });
  place('empty_expected', count('empty_expected'), (f) => hasExpected(f), (f) => {
    const first = expectedOf(f.node).find((e) => typeof e.data?.text === 'string' && e.data.text.trim() !== '') as MapNode;
    first.data.text = '';
    return { kind: 'empty_expected', item: itemId(f.node), node: String(first.data.id ?? ''), detail: '把期望结果清空' };
  });

  return { map, truth, shortfalls };
}

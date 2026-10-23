// Gold script: the literal structure answer of the review copy, computed independently of the Hub (task gold-review
// step 2). It re-implements the check from the words of packs/workflow/case-review/tables/structure.json line 4:
// required_empty (empty title, missing priority, missing or empty tag, no expected result or an empty one — a case
// recognized by the marked rule carries no tag and counts as missing one, README 113-114), type_mismatch (a priority
// that is not an integer 1..3), duplicate_key (under one path, title, steps, expected results and preconditions all
// equal — compared NFKC, case-insensitively, white space collapsed; a shared title alone is not a duplicate).
// It imports nothing from hub/ or packs/ — that independence is its whole value; the case reading itself comes from
// gold/cases.ts (parseMindMap and caseNodesOf), which is independent too. Cases without a unique data.id are counted
// apart and take no part in scoring.
import { caseNodesOf, parseMindMap, type GoldMap, type GoldNode } from './cases.ts';

export const CODE_REQUIRED_EMPTY = 'core.structure.required_empty';
export const CODE_TYPE_MISMATCH = 'core.structure.type_mismatch';
export const CODE_DUPLICATE_KEY = 'core.structure.duplicate_key';

/** The raw fields the folded GoldMap loses: a priority that is present but malformed, and blank tags. */
interface RawNode {
  text: unknown;
  priorityPresent: boolean;
  /** The raw priority value, whatever it is. */
  priority: unknown;
  /** The resource array as written, entries not filtered. */
  resource: unknown;
}

/** Walks the document exactly the way parseMindMap does (children in order, at most 1000 kept), so raw[i] lines up
 * with map.nodes[i]. */
function rawWalk(root: unknown, map: GoldMap): RawNode[] {
  const raw: RawNode[] = [];
  const walk = (value: unknown): void => {
    if (value === null || typeof value !== 'object') {
      // parseMindMap throws on non-objects before this walk is used; unreachable here
      return;
    }
    const record = ((value as { data?: unknown }).data ?? {}) as Record<string, unknown>;
    raw.push({ text: record.text, priorityPresent: 'priority' in record && record.priority !== null && record.priority !== undefined, priority: record.priority, resource: record.resource });
    const list = Array.isArray((value as { children?: unknown }).children) ? ((value as { children?: unknown[] }).children as unknown[]) : [];
    for (const child of list.slice(0, 1000)) walk(child);
  };
  walk(root);
  if (raw.length !== map.nodes.length) throw new Error('独立读法与 gold/cases.ts 的读法节点数不一致');
  return raw;
}

/** The comparison form of duplicate cases: NFKC, case-insensitive, white space collapsed to one space, edges trimmed. */
export function duplicateFold(text: string): string {
  return [...text.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ')].join('').trim();
}

interface CaseReading {
  title: string;
  /** Direct expected-result leaves (not under a step), in order. */
  expected: string[];
  /** Steps: each its text and its expected-result leaves, in order. */
  steps: Array<{ text: string; expected: string[] }>;
  /** Precondition-leaf texts (priority 3), in order. */
  preconditions: string[];
}

/** Reads one case the way gold/cases.ts reads it: leaves under the case are expected results unless they carry the
 * precondition priority, a child with children is a step and the leaves below it are its expected results, a nested
 * tagged node is a case of its own and its leaves stay there. */
function readCase(map: GoldMap, caseNode: GoldNode): CaseReading {
  const out: CaseReading = { title: caseNode.text, expected: [], steps: [], preconditions: [] };
  const walkDirect = (index: number): void => {
    for (const child of map.nodes[index]!.children) {
      const node = map.nodes[child]!;
      const isLeaf = node.children.length === 0;
      if (node.resource.length > 0) continue; // a nested case: a separate item
      if (isLeaf && node.priority === 3) {
        out.preconditions.push(node.text);
      } else if (isLeaf) {
        out.expected.push(node.text);
      } else {
        const step: { text: string; expected: string[] } = { text: node.text, expected: [] };
        const walkStep = (at: number): void => {
          for (const leaf of map.nodes[at]!.children) {
            const inner = map.nodes[leaf]!;
            if (inner.resource.length > 0) continue;
            if (inner.children.length === 0 && inner.priority === 3) out.preconditions.push(inner.text);
            else if (inner.children.length === 0) step.expected.push(inner.text);
            else walkStep(leaf);
          }
        };
        walkStep(child);
        out.steps.push(step);
      }
    }
  };
  walkDirect(caseNode.index);
  return out;
}

const signatureOf = (reading: CaseReading): string =>
  JSON.stringify([
    duplicateFold(reading.title),
    reading.steps.map((s) => [duplicateFold(s.text), s.expected.map(duplicateFold)]),
    reading.expected.map(duplicateFold),
    reading.preconditions.map(duplicateFold),
  ]);

export interface LiteralCaseAnswer {
  id: string;
  codes: string[];
}

export interface LiteralAnswer {
  /** The scored cases, each with the structure codes it should be flagged with (unique, sorted). */
  cases: LiteralCaseAnswer[];
  /** Cases without a unique data.id (empty or shared with another node): counted apart, never scored. */
  noUniqueId: { id: string; count: number; reason: string }[];
}

/** The independent literal answer of one document. */
export function literalGold(map: unknown, options: { caseRule?: 'marked' | 'tagged' } = {}): LiteralAnswer {
  const parsed = parseMindMap(map);
  const raw = rawWalk((map as { root?: unknown }).root, parsed);
  // Preserve raw tag-array presence for recognition; validity is checked separately below.
  const recognized: GoldMap = { nodes: parsed.nodes.map((node, i) => ({ ...node, text: typeof raw[i].text === 'string' ? raw[i].text as string : typeof raw[i].text === 'boolean' || typeof raw[i].text === 'number' && Number.isFinite(raw[i].text) ? String(raw[i].text) : '', resource: Array.isArray(raw[i].resource) ? (raw[i].resource as unknown[]).map(tag => typeof tag === 'string' ? tag : '') : [] })) };
  const cases = caseNodesOf(recognized, { caseRule: options.caseRule ?? 'marked' });

  const idsSeen = new Map<string, number>();
  for (const node of parsed.nodes) idsSeen.set(node.id, (idsSeen.get(node.id) ?? 0) + 1);

  const answers = new Map<string, string[]>();
  const noUnique: LiteralAnswer['noUniqueId'] = [];
  const readings = new Map<string, CaseReading>();
  for (const node of cases) {
    const id = node.id;
    const reading = readCase(recognized, node);
    readings.set(`${node.index}`, reading);
    if (id === '' || (idsSeen.get(id) ?? 0) > 1) {
      noUnique.push({ id: id === '' ? `@${node.index}` : id, count: idsSeen.get(id) ?? 0, reason: id === '' ? 'data.id 缺失' : 'data.id 重复' });
      continue;
    }
    const record = raw[node.index]!;
    const codes = new Set<string>();
    // required_empty: empty title, missing priority, missing or empty tags, no expected result or an empty one.
    if (reading.title.trim() === '') codes.add(CODE_REQUIRED_EMPTY);
    if (!record.priorityPresent) codes.add(CODE_REQUIRED_EMPTY);
    const tags = Array.isArray(record.resource) ? record.resource.filter((t): t is string => typeof t === 'string') : [];
    if (tags.length === 0 || tags.some((t) => t.trim() === '')) codes.add(CODE_REQUIRED_EMPTY);
    const allExpected = [...reading.expected, ...reading.steps.flatMap((s) => s.expected)];
    if (allExpected.length === 0 || allExpected.some((t) => t.trim() === '')) codes.add(CODE_REQUIRED_EMPTY);
    // type_mismatch: the priority is present but is not an integer 1..3.
    if (record.priorityPresent) {
      const value = record.priority;
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 3) codes.add(CODE_TYPE_MISMATCH);
    }
    answers.set(id, [...codes]);
  }

  // duplicate_key: the folded ancestor label path, not the parent node identity, everything compared — title, steps, expected, preconditions.
  const byParent = new Map<string, GoldNode[]>();
  for (const node of cases) {
    const parent = JSON.stringify(node.ancestors.map(duplicateFold));
    const list = byParent.get(parent) ?? [];
    list.push(node);
    byParent.set(parent, list);
  }
  for (const group of byParent.values()) {
    const signatures = group.map((node) => signatureOf(readings.get(`${node.index}`)!));
    for (const [i, node] of group.entries()) {
      if (node.id !== '' && (idsSeen.get(node.id) ?? 0) > 1) continue;
      const twin = signatures.some((other, j) => i !== j && other === signatures[i]);
      if (twin) answers.get(node.id)?.push(CODE_DUPLICATE_KEY);
    }
  }

  return {
    cases: [...answers].map(([id, codes]) => ({ id, codes: [...new Set(codes)].sort() })).sort((a, b) => (a.id < b.id ? -1 : 1)),
    noUniqueId: noUnique.sort((a, b) => (a.id < b.id ? -1 : 1)),
  };
}

// Cases from a reviewed case document (a KityMinder mind map, kityminder@1 model): the same taking rule as the
// case-review pack (task page A.1). A node with tags (resource) is a case; a node carrying the case priority (2) and
// no tags is a case under the default marked rule, only counted (marked_only) under tagged. Group nodes (priority 1)
// are walked through. Inside a case: a child with children is a step, its leaves the step's expected results; a
// direct leaf is an expected result of the case.
import { isRecord } from './text.ts';

export type CaseRule = 'tagged' | 'marked';

/** The priorities of the case-review rule: 2 marks a case, 1 marks a group. */
export const CASE_PRIORITY = 2;
export const GROUP_PRIORITY = 1;

export interface CaseStep {
  text: string;
  expected: string[];
}

export interface ExtractedCase {
  expected_nodes?:Array<{text:string;selector:string|null}>;
  /** Node id inside the document; the item id is <documentId>:<id>. */
  id: string;
  title: string;
  tags: string[];
  priority: string | null;
  autoid: string | null;
  auto: string | null;
  negative: boolean;
  steps: CaseStep[];
  expected: string[];
  /** The node's selector in the kityminder@1 model (the item's fragment), null when the parser gave none. */
  selector: string | null;
}

export interface Extraction {
  cases: ExtractedCase[];
  impreciseAutoids: Array<{ node: string; selector: string | null; pointer: string }>;
  /** Cases identified by the mark alone (no tags), counted for the summary. */
  markedOnly: number;
  /** Nodes that are marked but carry no tags, not projected under the tagged rule. */
  candidates: number;
  ruleSummary: string;
}

interface MindNode {
  text: string;
  data: { [key: string]: unknown };
  children: number[];
  selector: string | null;
}

function nodesOf(model: unknown): MindNode[] {
  if (!isRecord(model) || !Array.isArray(model.nodes)) return [];
  return model.nodes.filter(isRecord).map((node) => ({
    text: typeof node.text === 'string' ? node.text : '',
    data: isRecord(node.data) ? node.data : {},
    children: Array.isArray(node.children) ? node.children.filter((c): c is number => typeof c === 'number') : [],
    selector: typeof node.selector === 'string' ? node.selector : null,
  }));
}

function tagsOf(data: { [key: string]: unknown }): string[] {
  const resource = data.resource;
  if (!Array.isArray(resource)) return [];
  return resource.filter((tag): tag is string => typeof tag === 'string' && tag.trim() !== '').map((tag) => tag.trim());
}

function priorityOf(data: { [key: string]: unknown }): number | null {
  const priority = typeof data.priority === 'string' && /^[1-9]$/.test(data.priority) ? Number(data.priority) : data.priority;
  return typeof priority === 'number' && Number.isInteger(priority) && priority >= 1 && priority <= 9 ? priority : null;
}

function textOf(node: MindNode): string { return node.text; }
// Strings are opaque metadata. Safe scalars retain their textual form; imprecise numeric ids cannot be recovered.
function metadata(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean' || typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  return null;
}

/** The document id of a bound mind map: the external id's name, the parser meta id, else the root node's id. */
export function documentIdOf(external: string | null, meta: { [key: string]: unknown } | null, rootId: string | null): string {
  if (external !== null) {
    const match = /^agile:mindmap:([^@]+)/.exec(external);
    if (match !== null) return match[1];
  }
  if (meta !== null && typeof meta.id === 'string' && meta.id !== '') return meta.id;
  return rootId ?? 'document';
}

/** Extracts the cases of one document under the rule; nodes outside any case are ignored. */
export function extractCases(model: unknown, rule: CaseRule, includeExpectedNodes=false): Extraction {
  const nodes = nodesOf(model);
  const cases: ExtractedCase[] = [];
  const impreciseAutoids: Extraction['impreciseAutoids'] = [];
  let markedOnly = 0;
  let candidates = 0;
  const visit = (index: number): void => {
    const node = nodes[index];
    if (node === undefined) return;
    const tags = tagsOf(node.data);
    const priority = priorityOf(node.data);
    const isCase = tags.length > 0 || priority === CASE_PRIORITY;
    if (isCase) {
      if (typeof node.data.autoid === 'number' && !Number.isSafeInteger(node.data.autoid)) impreciseAutoids.push({ pointer: `/nodes/${index}/data/autoid`, node: typeof node.data.id === 'string' ? node.data.id : `n${index}`, selector: node.selector });
      if (tags.length === 0) {
        if (rule === 'tagged') {
          candidates++;
          return;
        }
        markedOnly++;
      }
      const steps: CaseStep[] = [];
      const expected: string[] = [];
      const expectedNodes:Array<{text:string;selector:string|null}>=[];
      for (const childIndex of node.children) {
        const child = nodes[childIndex];
        if (child === undefined) continue;
        if (child.children.length === 0) {
          const line = textOf(child);
          if (line !== '') {expected.push(line);expectedNodes.push({text:line,selector:child.selector});}
        } else {
          const stepExpected: string[] = [];
          for (const leafIndex of child.children) {
            const leaf = nodes[leafIndex];
            if (leaf === undefined) continue;
            const line = textOf(leaf);
            if (line !== '') {stepExpected.push(line);expectedNodes.push({text:line,selector:leaf.selector});}
          }
          steps.push({ text: textOf(child), expected: stepExpected });
        }
      }
      // A case body with only a leaf expectation is one authored operation; no steps are invented or rewritten.
      if (steps.length === 0 && expected.length === 1) {
        steps.push({ text: textOf(node), expected: [...expected] });
        expected.length = 0;
      }
      cases.push({
        ...(includeExpectedNodes?{expected_nodes:expectedNodes}:{}),
        id: typeof node.data.id === 'string' && node.data.id !== '' ? node.data.id : `n${index}`,
        title: textOf(node),
        tags,
        priority: metadata(node.data.priority),
        autoid: metadata(node.data.autoid),
        auto: metadata(node.data.auto),
        negative: node.data.negative === true,
        steps,
        expected,
        selector: node.selector,
      });
      return;
    }
    for (const childIndex of node.children) visit(childIndex);
  };
  if (nodes.length > 0) for (const childIndex of nodes[0].children) visit(childIndex);
  const ruleSummary = `用例规则：${rule === 'marked' ? '标签或标记' : '只认标签'}；其中 ${markedOnly} 个只靠标记识别（没有标签）`;
  return { cases, impreciseAutoids, markedOnly, candidates, ruleSummary };
}

// Gold script: independent location calculator for agile tree documents (architecture 6b, section 8).
// Parses the exported agile platform subtree original (agile:tree:<root>), independently calculates
// version line, release train, and module for each document following the path convention:
//   NNN：<line> -> NNN：<line>-<suffix> -> <module> -> <document>
// Tolerates full-width/half-width colons and extra whitespace.
// Extracts associated story and bug IDs from document titles and parent folder labels.
// Outputs partial locations for every document (layers recognized by convention are provided,
// unrecognized layers are set to null) along with a conforming flag.
// Imports nothing from hub/ or packs/.
//
// Usage:
//   node scripts/real/gold/locations.ts --tree <agile-tree.json> [--root <rootId>] --out <locations.json>
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface DocumentLocationGold {
  document: string;
  title: string;
  line: string | null;
  train: string | null;
  module: string | null;
  stories: string[];
  bugs: string[];
  associatedIds: string[];
  conforming: boolean;
  reason?: string | null;
}

export interface NonconformingDocument {
  document: string;
  title: string;
  ancestors: string[];
  reason: string;
  line: string | null;
  train: string | null;
  module: string | null;
  stories: string[];
  bugs: string[];
  associatedIds: string[];
  conforming: false;
}

export interface LocationsGold {
  root: string;
  documents: DocumentLocationGold[];
  nonconforming: NonconformingDocument[];
  all?: DocumentLocationGold[];
}

interface RawTreeNode {
  id: string;
  label: string;
  cases: string[];
  children: RawTreeNode[];
}

const PREFIX_REGEX = /^((?=[0-9A-Za-z-]*[0-9])[0-9A-Za-z]{3}(?:-[0-9A-Za-z]{3}){0,3})\s*[:：]\s*/u;
const LINE_REGEX = /^v?([0-9]{1,3}(?:\.[0-9]{1,3}){1,3})$/i;
const TRAIN_REGEX = /^v?([0-9]{1,3}(?:\.[0-9]{1,3}){1,3})(?=[-_\s])\S*?[-_\s]+\S/i;
const NOT_MODULE = /测试|回归|用例|需求|缺陷|bug|case|patch|build|story|plm|提测/i;

const STORY_MARKER = /(?<![A-Za-z0-9])(?:stor(?:y|ies)|需求单?)/gi;
const BUG_MARKER = /(?<![A-Za-z0-9])(?:bu(?:gt?|t)[\s_-]*(?:t?o|ro|2)[\s_-]*c[a-z]{0,5}|bugs?|缺陷)/gi;
const GLUE_REGEX = /^[\s#:\-_~.—–]*/;
const SEPARATOR_REGEX = /^(?:\s*(?:[&、,，+;；]|and\b|和|及|与)\s*#?|\s+)(?=[0-9]{2})/i;

/** Strips folder prefix code (e.g. "060：10.6.1" -> "10.6.1", "004: 10.6.1-R2" -> "10.6.1-R2"). */
export function stripPrefix(label: string): { prefix: string | null; text: string } {
  const norm = label.normalize('NFKC').trim();
  const match = PREFIX_REGEX.exec(norm);
  if (match) {
    return { prefix: match[1], text: norm.slice(match[0].length).trim() };
  }
  return { prefix: null, text: norm };
}

/** Normalizes version lines for comparison (e.g. "10.6.0" and "10.6" compare equal). */
export function lineKey(line: string): string {
  const parts = line.replace(/^v/i, '').split('.').map((p) => p.replace(/^0+/, '') || '0');
  while (parts.length > 2 && parts[parts.length - 1] === '0') parts.pop();
  return parts.join('.');
}

/** Checks whether a text label qualifies as a plain module name under a release train. */
export function isModuleName(raw: string): boolean {
  const text = stripPrefix(raw).text;
  if (!text || text.length > 40 || NOT_MODULE.test(text)) return false;
  if (LINE_REGEX.test(text) || TRAIN_REGEX.test(text)) return false;
  if (/[0-9]{4,}/.test(text)) return false;
  return true;
}

/** Extracts an ID list starting at position `at`. */
function extractIdList(text: string, at: number): { ids: string[]; end: number } {
  const ids: string[] = [];
  let pos = at;
  for (let guard = 0; guard < 64; guard++) {
    const digitMatch = /^[0-9]{2,9}/.exec(text.slice(pos));
    if (!digitMatch) break;
    const candidate = digitMatch[0];
    const end = pos + candidate.length;
    const nextChar = text[end] ?? '';
    if (nextChar === '.' && /[0-9]/.test(text[end + 1] ?? '')) break;
    if (candidate.length <= 4 && (nextChar === '/' || nextChar === ':') && /[0-9]/.test(text[end + 1] ?? '')) break;
    ids.push(candidate);
    pos = end;
    const sepMatch = SEPARATOR_REGEX.exec(text.slice(pos));
    if (!sepMatch) break;
    pos += sepMatch[0].length;
  }
  return { ids, end: pos };
}

/** Extracts story, bug, and leading bare numbers from title and ancestors. */
export function extractAssociatedIds(title: string, ancestors: string[]): { stories: string[]; bugs: string[]; associatedIds: string[] } {
  const storiesSet = new Set<string>();
  const bugsSet = new Set<string>();
  const allIdsSet = new Set<string>();

  const scanText = (text: string, isTitle: boolean) => {
    const norm = text.normalize('NFKC');

    for (const match of norm.matchAll(STORY_MARKER)) {
      const start = (match.index ?? 0) + match[0].length;
      const glue = GLUE_REGEX.exec(norm.slice(start));
      const afterGlue = start + (glue ? glue[0].length : 0);
      const { ids } = extractIdList(norm, afterGlue);
      for (const id of ids) {
        storiesSet.add(id);
        allIdsSet.add(id);
      }
    }

    for (const match of norm.matchAll(BUG_MARKER)) {
      const start = (match.index ?? 0) + match[0].length;
      const glue = GLUE_REGEX.exec(norm.slice(start));
      const afterGlue = start + (glue ? glue[0].length : 0);
      const { ids } = extractIdList(norm, afterGlue);
      for (const id of ids) {
        bugsSet.add(id);
        allIdsSet.add(id);
      }
    }

    if (isTitle) {
      const leadMatch = /^[\s\-–—_:.、]*([0-9]{4,7})(?=[^0-9]|$)/.exec(norm);
      if (leadMatch) {
        const num = leadMatch[1];
        const val = Number(num);
        if (!(num.length === 4 && val >= 1900 && val <= 2099)) {
          allIdsSet.add(num);
        }
      }
    }
  };

  scanText(title, true);
  for (const ancestor of ancestors) {
    scanText(ancestor, false);
  }

  return {
    stories: [...storiesSet].sort(),
    bugs: [...bugsSet].sort(),
    associatedIds: [...allIdsSet].sort(),
  };
}

/**
 * Parses raw JSON tree nodes recursively.
 */
function normalizeTreeNodes(raw: unknown): RawTreeNode[] {
  if (!raw || typeof raw !== 'object') return [];
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { data?: unknown }).data)
      ? (raw as { data: unknown[] }).data
      : Array.isArray((raw as { children?: unknown }).children)
        ? (raw as { children: unknown[] }).children
        : [];

  const nodes: RawTreeNode[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const id = obj.id !== undefined ? String(obj.id) : '';
    const label = typeof obj.label === 'string'
      ? obj.label
      : typeof obj.title === 'string'
        ? obj.title
        : typeof obj.name === 'string'
          ? obj.name
          : typeof obj.text === 'string'
            ? obj.text
            : '';
    const cases = Array.isArray(obj.cases) ? obj.cases.map(String) : [];
    const children = normalizeTreeNodes(obj.children);
    nodes.push({ id, label, cases, children });
  }
  return nodes;
}

export interface ScannedDocumentItem {
  document: string;
  title: string;
  ancestors: string[];
}

/** Scans tree nodes to collect all document leaves and their folder ancestors. */
function scanDocuments(nodes: RawTreeNode[], above: string[] = [], rootCases: string[] = []): ScannedDocumentItem[] {
  const own: ScannedDocumentItem[] = [];
  const ownIds = new Set<string>();
  const listed = new Map<string, { ancestors: string[]; depth: number }>();

  if (rootCases.length > 0) {
    const depth = above.length;
    for (const caseId of rootCases) {
      if (caseId && !listed.has(caseId)) {
        listed.set(caseId, { ancestors: [...above], depth });
      }
    }
  }

  const traverse = (nodeList: RawTreeNode[], currentAncestors: string[]) => {
    for (const node of nodeList) {
      const isLeaf = node.children.length === 0 && node.cases.length === 0;
      if (isLeaf) {
        if (node.id && !ownIds.has(node.id)) {
          ownIds.add(node.id);
          own.push({
            document: node.id,
            title: node.label,
            ancestors: currentAncestors,
          });
        }
      } else {
        const nextAncestors = node.label ? [...currentAncestors, node.label] : currentAncestors;
        const depth = nextAncestors.length;
        for (const caseId of node.cases) {
          if (!caseId) continue;
          const known = listed.get(caseId);
          if (known === undefined || depth > known.depth) {
            listed.set(caseId, { ancestors: nextAncestors, depth });
          }
        }
        traverse(node.children, nextAncestors);
      }
    }
  };

  traverse(nodes, above);

  const out: ScannedDocumentItem[] = [...own];
  for (const [id, info] of listed) {
    if (!ownIds.has(id)) {
      out.push({
        document: id,
        title: '',
        ancestors: info.ancestors,
      });
    }
  }

  return out;
}

export type EvaluatedLocation =
  | { location: DocumentLocationGold }
  | { location: DocumentLocationGold; reason: string };

/**
 * Calculates location for one document based on architecture section 8 convention.
 * Outputs partial location for every document (layers recognized by convention are provided,
 * unrecognized layers are set to null) along with a conforming flag.
 */
export function evaluateLocation(doc: ScannedDocumentItem): EvaluatedLocation {
  const strippedAncestors = doc.ancestors.map((a) => stripPrefix(a));

  // 1. Locate version line node
  let lineIdx = -1;
  let lineVal: string | null = null;
  for (let i = 0; i < strippedAncestors.length; i++) {
    const m = LINE_REGEX.exec(strippedAncestors[i].text);
    if (m) {
      lineIdx = i;
      lineVal = m[1];
    }
  }

  // 2. Locate release train node
  let trainIdx = -1;
  let trainVal: string | null = null;
  let trainLine: string | null = null;
  for (let i = 0; i < strippedAncestors.length; i++) {
    const m = TRAIN_REGEX.exec(strippedAncestors[i].text);
    if (m) {
      trainIdx = i;
      trainVal = strippedAncestors[i].text;
      trainLine = m[1];
      break;
    }
  }

  if (lineIdx < 0 && trainLine !== null) {
    lineVal = trainLine;
  }

  // 3. Locate module node (must be directly below release train)
  let moduleVal: string | null = null;
  let nonconReason: string | null = null;

  if (lineVal === null) {
    nonconReason = '缺少版本线节点';
  } else if (trainVal === null || trainIdx < 0) {
    nonconReason = '缺少发布火车节点';
  } else if (trainLine !== null && lineKey(trainLine) !== lineKey(lineVal)) {
    nonconReason = `发布火车版本 ${trainLine} 与版本线 ${lineVal} 不一致`;
  } else {
    const moduleIdx = trainIdx + 1;
    if (moduleIdx >= strippedAncestors.length) {
      nonconReason = '发布火车下面没有模块层';
    } else {
      const moduleRaw = doc.ancestors[moduleIdx];
      if (!isModuleName(moduleRaw)) {
        nonconReason = `发布火车下一层“${strippedAncestors[moduleIdx].text.slice(0, 40)}”不是有效模块名`;
      } else {
        moduleVal = strippedAncestors[moduleIdx].text;
      }
    }
  }

  const { stories, bugs, associatedIds } = extractAssociatedIds(doc.title, doc.ancestors);
  const conforming = nonconReason === null;

  const location: DocumentLocationGold = {
    document: doc.document,
    title: doc.title,
    line: lineVal,
    train: trainVal,
    module: moduleVal,
    stories,
    bugs,
    associatedIds,
    conforming,
    reason: nonconReason,
  };

  if (conforming) {
    return { location };
  }
  return { location, reason: nonconReason ?? '不符合路径约定' };
}

/**
 * Computes independent locations gold from raw subtree input.
 */
export function locationsGold(treeInput: unknown, options?: { root?: string }): LocationsGold {
  let rootId = options?.root ?? '';
  let rootTitle: string | null = null;
  const rootCases: string[] = [];

  if (treeInput && typeof treeInput === 'object') {
    const top = treeInput as Record<string, unknown>;
    if (top.root && typeof top.root === 'object') {
      const r = top.root as Record<string, unknown>;
      if (typeof r.id === 'string' && !rootId) rootId = r.id;
      if (typeof r.title === 'string') rootTitle = r.title;
      if (typeof r.label === 'string' && !rootTitle) rootTitle = r.label;
      if (Array.isArray(r.cases)) rootCases.push(...r.cases.map(String));
      if (Array.isArray(top.cases)) rootCases.push(...top.cases.map(String));
    } else if (Array.isArray(top.children) && (top.id || top.label || top.title)) {
      if (top.id && !rootId) rootId = String(top.id);
      rootTitle = String(top.label ?? top.title ?? '');
      if (Array.isArray(top.cases)) rootCases.push(...top.cases.map(String));
    }
  }

  const nodes = normalizeTreeNodes(treeInput);
  const startAncestors = rootTitle ? [rootTitle] : [];
  const scanned = scanDocuments(nodes, startAncestors, rootCases);

  const documents: DocumentLocationGold[] = [];
  const nonconforming: NonconformingDocument[] = [];
  const all: DocumentLocationGold[] = [];

  for (const item of scanned) {
    const evaluated = evaluateLocation(item);
    all.push(evaluated.location);
    if ('reason' in evaluated) {
      nonconforming.push({
        document: item.document,
        title: item.title,
        ancestors: item.ancestors,
        reason: evaluated.reason,
        line: evaluated.location.line,
        train: evaluated.location.train,
        module: evaluated.location.module,
        stories: evaluated.location.stories,
        bugs: evaluated.location.bugs,
        associatedIds: evaluated.location.associatedIds,
        conforming: false,
      });
    } else {
      documents.push(evaluated.location);
    }
  }

  return {
    root: rootId,
    documents,
    nonconforming,
    all,
  };
}

export async function main(argv: string[]): Promise<number> {
  const value = (name: string): string | undefined => {
    const at = argv.indexOf(`--${name}`);
    return at >= 0 ? argv[at + 1] : undefined;
  };

  const treePath = value('tree');
  const rootArg = value('root');
  const outPath = value('out');

  if (!treePath || !outPath) {
    process.stderr.write('用法：node scripts/real/gold/locations.ts --tree <agile-tree.json> [--root <rootId>] --out <locations.json>\n');
    return 2;
  }

  try {
    const raw = JSON.parse(readFileSync(resolve(treePath), 'utf8')) as unknown;
    const result = locationsGold(raw, { root: rootArg });
    writeFileSync(resolve(outPath), `${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`生成用例定位独立答案失败：${(error as Error).message.split('\n')[0]}\n`);
    return 1;
  }
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('gold/locations.ts')) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}

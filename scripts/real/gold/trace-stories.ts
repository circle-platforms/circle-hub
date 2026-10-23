// Independent raw-input oracle. No runtime imports from Hub or packs.
import type { ProvenanceType } from '../../../contracts/generated/vocabulary.ts';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { caseGold, caseNodesOf, parseMindMap } from './cases.ts';
import { parseDocumentList } from './trace.ts';

const MARKER_REGEX = /(?<![a-z0-9])(?:(bu(?:gt?|t)[\s_-]*(?:t?o|ro|2)[\s_-]*c[a-z]{0,5})|(bugs?)|(stor(?:y|ies))|(plm))|(缺陷)|(需求单?)/gu;
const INNER_REGEX = /(?:(需求单?)|(缺陷)|(stor(?:y|ies))|(bugs?))(?![a-z])/uy;
const GLUE_REGEX = /[\s#:\-_~.—–]*/uy;
const LIST_REGEX = /(?:\s*(?:[&、,，+;；]|and\b|和|及|与)\s*#?|\s+)(?=[0-9]{2})/iuy;
function sticky(pattern: RegExp, text: string, at: number): string | null {
  pattern.lastIndex = at;
  const match = pattern.exec(text);
  return match === null ? null : match[0];
}

function idAt(text: string, at: number, min: number, max: number, bare: boolean): { id: string; end: number } | null {
  let end = at;
  while (end < text.length && text[end] >= '0' && text[end] <= '9') end += 1;
  const id = text.slice(at, end);
  if (id.length < min || id.length > max || /^0+$/.test(id)) return null;
  const before = text[at - 1] ?? '';
  const next = text[end] ?? '';
  const after = text[end + 1] ?? '';
  const short = id.length <= 4;
  if (/[0-9]/.test(before) || (before === '.' && /[0-9]/.test(text[at - 2] ?? ''))) return null;
  if (next === '.' && /[0-9]/.test(after)) return null;
  if (short && (next === '/' || next === ':') && /[0-9]/.test(after)) return null;
  if (id.length === 4 && next === '-' && /^[0-9]{1,2}(?:[^0-9]|$)/.test(text.slice(end + 1, end + 4))) return null;
  if (short && /[a-z]/.test(next)) return null;
  if (id.length === 8) {
    const y = Number(id.slice(0, 4));
    const m = Number(id.slice(4, 6));
    const d = Number(id.slice(6, 8));
    if (y >= 1970 && y <= 2099 && m >= 1 && m <= 12 && d >= 1 && d <= 31) return null;
  }
  if (/^\s*[年月日号]/u.test(text.slice(end, end + 3))) return null;
  if (bare && /^\s*:/.test(text.slice(end, end + 3))) return null;
  return { id, end };
}

/** Extracts an ID list starting at position `at`. */
function idList(text: string, at: number, min: number, max: number, bare = false): { ids: string[]; end: number; ends: number[] } {
  const ids: string[] = [];
  const ends: number[] = [];
  let position = at;
  let end = at;
  for (let guard = 0; guard < 64; guard++) {
    const found = idAt(text, position, min, max, bare);
    if (found === null) break;
    ids.push(found.id);
    ends.push(found.end);
    position = found.end;
    end = found.end;
    const separator = sticky(LIST_REGEX, text, position);
    if (separator === null) break;
    position += separator.length;
  }
  return { ids, end, ends };
}

function scanMarked(text: string): Array<{ id: string; kind: 'story' | 'bug' | null }> {
  const out: Array<{ id: string; kind: 'story' | 'bug' | null }> = [];
  MARKER_REGEX.lastIndex = 0;
  for (let match = MARKER_REGEX.exec(text); match !== null; match = MARKER_REGEX.exec(text)) {
    let kind: 'story' | 'bug' | null = null;
    if (match[1] !== undefined || match[4] !== undefined) {
      kind = null;
    } else if (match[2] !== undefined || match[5] !== undefined) {
      kind = 'bug';
    } else {
      kind = 'story';
    }
    let position = match.index + match[0].length;
    position += (sticky(GLUE_REGEX, text, position) ?? '').length;
    INNER_REGEX.lastIndex = position;
    const inner = INNER_REGEX.exec(text);
    if (inner !== null) {
      kind = (inner[1] !== undefined || inner[3] !== undefined) ? 'story' : 'bug';
      position += inner[0].length;
      position += (sticky(GLUE_REGEX, text, position) ?? '').length;
    }
    const { ids, end } = idList(text, position, 2, 9);
    for (const id of ids) out.push({ kind, id });
    if (ids.length > 0) MARKER_REGEX.lastIndex = Math.max(MARKER_REGEX.lastIndex, end);
  }
  return out;
}

/** Story-only raw-id extraction; no dependency on the case-location leading-zero policy. */
export function storyIdsOf(title: string, ancestors: string[]): string[] {
  return [...new Set([title,...ancestors].flatMap(text => scanMarked(text.normalize('NFKC').toLowerCase()))
    .filter(value => value.kind === 'story').map(value => value.id))].sort();
}

interface RawTreeNode {
  id: string;
  label: string;
  cases: string[];
  children: RawTreeNode[];
}

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

interface ScannedDocumentItem {
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

function treeStories(treeInput: unknown): Map<string,string[]> {
  let rootTitle: string | null = null;
  const rootCases: string[] = [];

  if (treeInput && typeof treeInput === 'object') {
    const top = treeInput as Record<string, unknown>;
    if (top.root && typeof top.root === 'object') {
      const r = top.root as Record<string, unknown>;
      if (typeof r.title === 'string') rootTitle = r.title;
      if (typeof r.label === 'string' && !rootTitle) rootTitle = r.label;
      if (Array.isArray(r.cases)) rootCases.push(...r.cases.map(String));
      if (Array.isArray(top.cases)) rootCases.push(...top.cases.map(String));
    } else if (Array.isArray(top.children) && (top.id || top.label || top.title)) {
      rootTitle = String(top.label ?? top.title ?? '');
      if (Array.isArray(top.cases)) rootCases.push(...top.cases.map(String));
    }
  }

  const nodes = normalizeTreeNodes(treeInput);
  const startAncestors = rootTitle ? [rootTitle] : [];
  const scanned = scanDocuments(nodes, startAncestors, rootCases);

  return new Map(scanned.map(doc => [doc.document,storyIdsOf(doc.title,doc.ancestors).map(norm)]));
}

export type Scalar = string | number | boolean | null;
const scalar = (value: unknown): Scalar => typeof value === 'string' || typeof value === 'number' && Number.isFinite(value) || typeof value === 'boolean' ? value : null;
export type StoryRecord = { id: string | number; status?: unknown; stage?: unknown; title?: unknown };
const absentFields = (row: StoryRecord): string[] => ['status', 'stage'].filter(key => !Object.hasOwn(row, key) || row[key as 'status' | 'stage'] === undefined);
const nonscalarFields = (row: StoryRecord): string[] => ['status', 'stage'].filter(key => {
  const value = row[key as 'status' | 'stage'];
  return value !== undefined && value !== null && typeof value !== 'string' && typeof value !== 'boolean'
    && !(typeof value === 'number' && Number.isFinite(value));
});

export type StoryGoldRow = { story: string; status: Scalar; stage: Scalar; fields_absent?: string[]; fields_nonscalar?: string[]; plm_returned: boolean; cases: Array<{ id: string; title: string }> };
export type StoryGold = { product: string; build: string; stories: StoryGoldRow[]; traced: number; untraced: number; plm_unread: number; status_absent?: number; status_nonscalar: number; stage_nonscalar: number; statuses: Array<{ status: Scalar; count: number }>; documents: number; documents_without_cases: number; missing_documents: string[]; scope: ProvenanceType };
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const norm = (id: string): string => id.replace(/^0+/, '') || '0';
const isId = (id: string): boolean => /^[0-9]{1,15}$/.test(id) && norm(id) !== '0';


export function parseStoryIds(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : record(raw) && Array.isArray(raw.stories) ? raw.stories : null;
  if (!list || list.length === 0 || list.some(id => (typeof id !== 'string' && typeof id !== 'number') || !isId(String(id)))) throw new Error('需求编号列表无效');
  return [...new Set(list.map(id => norm(String(id))))].sort((a, b) => Number(a) - Number(b));
}
export function parseStoryRecords(raw: unknown): StoryRecord[] {
  const list = record(raw) && raw.code === 1000 && Array.isArray(raw.data) ? raw.data : null;
  if (list === null || list.some(r => !record(r) || !isId(String(r.id)))) throw new Error('PLM 原件形状无效');
  return list as StoryRecord[];
}
export function storyGold(options: { ids: string[]; plm: StoryRecord[]; maps: Array<{ document: string; map: unknown }>; tree: unknown; product: string; build: string; caseRule?: 'marked' | 'tagged'; missingDocuments?: string[] }): StoryGold {
  const ids = parseStoryIds(options.ids);
  const parsed = options.maps.map(({ map }) => parseMindMap(map).nodes);
  const folderStories = treeStories(options.tree);
  const cases: Array<{ id: string; title: string; stories: string[] }> = [];
  let documentsWithoutCases = 0;
  for (const [at, { document, map }] of options.maps.entries()) {
    const nodes = parsed[at];
    if (caseNodesOf({nodes}, {caseRule:options.caseRule ?? 'marked'}).length === 0) { documentsWithoutCases++; continue; }
    const counted = caseGold([{document,map}], {caseRule:options.caseRule ?? 'marked'}).documents[0];
    for (const c of counted.items) {
      const node = nodes.find(n => (n.id || `@${n.index}`) === c.id);
      if (!node) throw new Error('用例节点位置缺失');
      const found = storyIdsOf(node.text, node.ancestors).map(norm);
      cases.push({ id: `${document}:${c.id}`, title: c.title, stories: [...found, ...(folderStories.get(document) ?? [])].map(norm) });
    }
  }
  const stories = ids.map((id): StoryGoldRow => {
    const returned = options.plm.filter(r => norm(String(r.id)) === id);
    const first = returned[0];
    if (returned.some(r => JSON.stringify([scalar(r.status), scalar(r.stage), absentFields(r), nonscalarFields(r)]) !== JSON.stringify([scalar(first.status), scalar(first.stage), absentFields(first), nonscalarFields(first)]))) throw new Error('需求原件冲突');
    return { story: id, status: scalar(first?.status), stage: scalar(first?.stage), fields_absent: first ? absentFields(first) : [],
      fields_nonscalar: first ? nonscalarFields(first) : [], plm_returned: returned.length > 0,
      cases: cases.filter(c => c.stories.some(s => s === id)).map(c => ({ id: c.id, title: c.title })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0) };
  });
  const traced = stories.filter(s => s.cases.length > 0).length;
  const states = new Map<Scalar, number>();
  for (const s of stories) if (s.plm_returned && !s.fields_absent?.includes('status') && !s.fields_nonscalar?.includes('status')) states.set(s.status, (states.get(s.status) ?? 0) + 1);
  return { product: options.product, build: options.build, stories, traced, untraced: stories.length - traced, plm_unread: stories.filter(s => !s.plm_returned).length,
    status_nonscalar: stories.filter(s => s.plm_returned && s.fields_nonscalar?.includes('status')).length,
    stage_nonscalar: stories.filter(s => s.plm_returned && s.fields_nonscalar?.includes('stage')).length,
    status_absent: stories.filter(s => s.plm_returned && s.fields_absent?.includes('status')).length, statuses: [...states].sort(([a], [b]) => JSON.stringify([typeof a, a]) < JSON.stringify([typeof b, b]) ? -1 : JSON.stringify([typeof a, a]) > JSON.stringify([typeof b, b]) ? 1 : 0).map(([status, count]) => ({ status, count })), documents: options.maps.length, documents_without_cases: documentsWithoutCases,
    missing_documents: options.missingDocuments ?? [], scope: 'declared' };
}
export function main(argv: string[]): number {
  const value = (name: string) => { const i = argv.indexOf(`--${name}`); return i < 0 ? undefined : argv[i + 1]; };
  const names = ['stories', 'cases-dir', 'tree', 'docs', 'product', 'build', 'out'];
  if (names.some(n => !value(n))) { process.stderr.write('用法：trace-stories.ts --stories <文件> --plm <文件>… --cases-dir <目录> --tree <文件> --docs <文件> --product <产品> --build <构建> --out <文件>\n'); return 2; }
  try {
    const read = (path: string): unknown => JSON.parse(readFileSync(resolve(path), 'utf8'));
    const docs = parseDocumentList(readFileSync(resolve(value('docs')!), 'utf8'));
    if (docs.size === 0) throw new Error('文档清单为空');
    const maps: Array<{ document: string; map: unknown }> = [];
    for (const file of readdirSync(resolve(value('cases-dir')!)).sort()) {
      const document = file.replace(/\.(?:km\.)?json$/i, '');
      if (!/\.json$/i.test(file) || !docs.has(document)) continue;
      maps.push({ document, map: read(resolve(value('cases-dir')!, file)) });
    }
    const missingDocuments = [...docs].filter(d => !maps.some(m => m.document === d)).sort();
    const plm = []; let plmFiles = 0;
    for (let i = 0; i < argv.length; i++) if (argv[i] === '--plm') {
      for (let j = i + 1; j < argv.length && !argv[j].startsWith('--'); j++) { plm.push(...parseStoryRecords(read(argv[j]))); plmFiles++; }
    }
    if (plmFiles === 0) throw new Error('缺少 PLM 原件');
    const caseRule = value('case-rule');
    if (caseRule !== undefined && caseRule !== 'marked' && caseRule !== 'tagged') throw new Error('用例规则无效');
    const gold = storyGold({ ids: parseStoryIds(read(value('stories')!)), plm, maps, tree: read(value('tree')!), product: value('product')!, build: value('build')!, caseRule, missingDocuments });
    const text = JSON.stringify(gold, null, 2) + '\n';
    writeFileSync(resolve(value('out')!), text);
    process.stdout.write(`需求 ${gold.stories.length}；已追溯 ${gold.traced}；未追溯 ${gold.untraced}；PLM 未返回 ${gold.plm_unread}；非单个状态 ${gold.status_nonscalar}；非单个阶段 ${gold.stage_nonscalar}；文档 ${maps.length}；无用例文档 ${gold.documents_without_cases}；缺原件 ${missingDocuments.length}；SHA-256 ${createHash('sha256').update(text).digest('hex').slice(0, 12)}；${missingDocuments.length ? '不通过' : '通过'}\n`);
    return missingDocuments.length ? 1 : 0;
  } catch (error) { process.stderr.write('生成需求独立答案不通过；请核对输入原件和编号清单\n'); return 1; }
}
if (import.meta.main) process.exitCode = main(process.argv.slice(2));

// Gold script: the case counts of exported agile mind maps, computed independently of the Hub. Imports nothing
// from hub/ or packs/ (its independence is its whole value). The case-node rule is re-implemented from the words
// of packs/workflow/case-review/README.md:
// - default `marked`: a case is either a node whose `resource` is a non-empty array (tagged case), or an untagged
//   node outside every case carrying the case priority (default 2), having children and holding no case or candidate
//   (marked case);
// - `--case-rule tagged`: restricts cases to nodes whose `resource` is a non-empty array;
// - a tagged node with the group priority (default 1) holding cases is a group, not a case;
// - inside a case: a leaf is an expected result, unless it carries the precondition priority (default 3); a child
//   with children is an operation step, and the leaves below it are its expected results; a nested case forms a separate item;
// - vague-expected phrase list is copied from the pack's table source (matched whole, folded: NFKC, lower case, no white space, no edge punctuation);
// - negative is a canonical Negative tag;
// - defect ids come from the case title, the ancestor labels and the document's root title (bug markers: bug to case, bug-to-case, bug2case, 缺陷 ...; digits 2..9 long).
//   node scripts/real/gold/cases.ts --map <file>:<documentId> [--map <file>:<documentId> ...] [--case-rule tagged|marked] --out <gold.json>
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { GoldRefusal } from './refusal.ts';
import { rawIdAt } from './id-text.ts';

export interface GoldNode {
  index: number;
  id: string;
  text: string;
  resource: string[];
  /** The raw tag entries as text (blank strings kept, finite numbers and booleans as text) — what the index keeps. */
  rawTags: string[];
  /** The pack's isTagged: a non-empty resource array, whatever the entries are (null and object entries included). */
  tagged: boolean;
  priority: number | null;
  /** The text labels of the ancestors of this node, outermost (the root) first. */
  ancestors: string[];
  children: number[];
  parent: number | null;
}

export interface GoldMap {
  nodes: GoldNode[];
}

export function parseMindMap(value: unknown): GoldMap {
  if (value === null || typeof value !== 'object') throw new Error('不是脑图对象');
  const wrapper = value as { root?: unknown };
  const root = wrapper.root;
  if (root === null || typeof root !== 'object') throw new Error('不是脑图对象：缺少 root');
  const nodes: GoldNode[] = [];
  const walk = (raw: unknown, parent: number | null, ancestors: string[]): number => {
    if (raw === null || typeof raw !== 'object') throw new Error(`第 ${nodes.length + 1} 个节点不是对象`);
    const data = (raw as { data?: unknown }).data;
    const record = (data ?? {}) as Record<string, unknown>;
    if (typeof record !== 'object' || record === null) throw new Error(`第 ${nodes.length + 1} 个节点的 data 不是对象`);
    const text = typeof record.text === 'string' ? record.text : record.text === null ? '' : String(record.text);
    const id = typeof record.id === 'string' ? record.id : typeof record.id === 'number' ? String(record.id) : '';
    const resourceRaw = Array.isArray(record.resource) ? record.resource : [];
    const resourceTags = resourceRaw.map((t) => (typeof t === 'string' ? t : (typeof t === 'number' && Number.isFinite(t)) || typeof t === 'boolean' ? String(t) : null)).filter((t): t is string => t !== null);
    const resource = resourceTags.filter((t) => t.trim() !== '');
    const priority = typeof record.priority === 'number' && Number.isInteger(record.priority) ? record.priority : null;
    const childrenRaw = (raw as { children?: unknown }).children;
    const index = nodes.length;
    nodes.push({ index, id, text, resource, rawTags: resourceTags, tagged: resourceRaw.length > 0, priority, ancestors, children: [], parent });
    const list = Array.isArray(childrenRaw) ? childrenRaw : [];
    for (const child of list.slice(0, 1000)) {
      nodes[index].children.push(walk(child, index, [...ancestors, text]));
    }
    return index;
  };
  walk(root, null, []);
  if (nodes.length > 100_000) throw new Error('节点过多');
  return { nodes };
}

const EDGE = new Set([...'，。；：！？、,.:;!?~～"\'“”‘’()（）[]【】{}《》「』']);
const NOT_MODULE = /测试|回归|用例|需求|bug|case|patch|story|plm|提测/i;

/** The folded form vague phrases compare in: NFKC, lower case, no white space, no punctuation at either end. */
export function foldKey(text: string): string {
  const chars = [...text.normalize('NFKC').toLowerCase().replace(/\s+/gu, '')];
  let start = 0;
  let end = chars.length;
  while (start < end && EDGE.has(chars[start])) start += 1;
  while (end > start && (EDGE.has(chars[end - 1]) || chars[end - 1] === '~' || chars[end - 1] === '～')) end -= 1;
  return chars.slice(start, end).join('');
}

/** The vague-expected phrase list, copied from the pack's table source (cases-rules on the reviewed branch). */
export const VAGUE_EXPECTED: readonly string[] = [
  '正常', '成功', '通过', '正确', '无异常', '没有异常', '符合预期', '与预期一致', '同预期', '结果正确', '结果正常',
  '显示正确', '显示正常', '功能正常', '运行正常', '工作正常', '设备正常', '系统正常', '操作成功', '执行成功', '配置成功',
  '设置成功', '生效', '配置生效', '功能生效', 'ok', 'pass', 'passed', 'success', 'normal', 'as expected',
];
const VAGUE_KEYS = new Set(VAGUE_EXPECTED.map(foldKey));

/** Canonical negative spellings, copied from the pack's tag table source. */
const NEGATIVE_KEYS = new Set(['negative', 'neg', '负向', '负面', '反向', '逆向', '异常', '负面测试'].map(foldKey));

const BUG_MARKERS =
  /(?<![A-Za-z])(?:bu(?:t|gt)[\s_-]*(?:t?o|ro|2)[\s_-]*c[a-z]{0,5}|bugs?(?:[\s_-]*(?:t?o|ro|2)[\s_-]*c[a-z]{0,5})?|缺陷)/gi;
const SEPARATOR = /^(?:\s*(?:&|、|,|\+|\/|\band\b|和|及|与)\s*|\s+)(?=[0-9]{2})/i;


/** A document with no case nodes: caught by type, never by matching the message text. */
export class NoCaseNodes extends GoldRefusal {}

/** Bug ids of one text: after each bug marker, digit runs 2..9 long, separated by , &、and. */
export function bugIdsOf(raw: string): string[] {
  const ids: string[] = [];
  // The pack's ids.ts normalizes once and works on the normalized text: a full-width colon or full-width digits are
  // part of the id form it reads. Slicing the RAW text after matching on the normalized one lost both (closure 1).
  const text = raw.normalize('NFKC');
  for (const match of text.matchAll(BUG_MARKERS)) {
    let at = (match.index ?? 0) + match[0].length;
    at += /^[\s_\-–—:#.]*/.exec(text.slice(at))![0].length;
    for (let guard = 0; guard < 64; guard++) {
      const found = rawIdAt(text, at, 2, 9);
      if (found === null) break;
      ids.push(found.id);
      at = found.end;
      const separator = SEPARATOR.exec(text.slice(at, at + 12));
      if (separator === null) break;
      at += separator[0].length;
    }
  }
  return [...new Set(ids)].sort();
}

export interface GoldStep {
  text: string;
  expected: string[];
}

export interface GoldCase {
  tags: string[];
  id: string;
  title: string;
  expected: string[];
  steps: GoldStep[];
  hasExpected: boolean;
  vagueExpected: boolean;
  negative: boolean;
  group: string;
  defects: string[];
}

export interface GoldDocument {
  document: string;
  cases: number;
  withExpected: number;
  vagueCases: string[];
  negativeCases: string[];
  /** Case ids by the group label (the first ancestor label under the root, '' when none). */
  groupCounts: Record<string, number>;
  defects: string[];
  items: GoldCase[];
}

export interface CasesGold {
  documents: GoldDocument[];
}

const PRECONDITION_PRIORITY = 3;
const CASE_PRIORITY = 2;
const GROUP_PRIORITY = 1;

const OTHER = 0;
const CASE = 1;
const GROUP = 2;
const CANDIDATE = 3;
const INNER = 4;

/** Identifies the case nodes of a parsed mind map following caseRule ('marked' or 'tagged'). */
export function caseNodesOf(
  map: GoldMap,
  options: { caseRule?: 'tagged' | 'marked' } = {},
): GoldNode[] {
  const caseRule = options.caseRule ?? 'marked';
  const nodes = map.nodes;
  const n = nodes.length;

  const holds = new Uint8Array(n);
  for (let v = n - 1; v > 0; v--) {
    const node = nodes[v];
    // The same shared rule as the role pass (closure item 10): never the filtered non-blank list here.
    const isTagged = node.tagged;
    if (holds[v] === 1 || isTagged || node.priority === CASE_PRIORITY) {
      if (node.parent !== null) holds[node.parent] = 1;
    }
  }

  const role = new Uint8Array(n);
  const within = new Int32Array(n).fill(-1);
  for (let v = 0; v < n; v++) {
    const node = nodes[v];
    const parent = node.parent;
    const inside = parent === null ? -1 : role[parent] === CASE || role[parent] === CANDIDATE ? parent : within[parent];
    within[v] = inside;
    if (node.tagged) {
      const isGroup = inside === -1 && node.priority === GROUP_PRIORITY && holds[v] === 1;
      role[v] = isGroup ? GROUP : CASE;
    } else if (inside !== -1) {
      role[v] = INNER;
    } else if (node.priority === CASE_PRIORITY && node.children.length > 0 && holds[v] === 0) {
      role[v] = caseRule === 'marked' ? CASE : CANDIDATE;
    } else if (node.priority !== null) {
      role[v] = GROUP;
    } else {
      role[v] = OTHER;
    }
  }

  const out: GoldNode[] = [];
  for (let v = 0; v < n; v++) {
    if (role[v] === CASE) out.push(nodes[v]);
  }
  return out;
}

export function caseGold(
  maps: ReadonlyArray<{ document: string; map: unknown }>,
  options: { caseRule?: 'tagged' | 'marked' } = {},
): CasesGold {
  const caseRule = options.caseRule ?? 'marked';
  const documents: GoldDocument[] = [];
  for (const { document: documentId, map } of maps) {
    const { nodes } = parseMindMap(map);
    const n = nodes.length;

    // 1. Bottom-up: does a node hold a tagged node or a node with case priority?
    const holds = new Uint8Array(n);
    for (let v = n - 1; v > 0; v--) {
      const node = nodes[v];
      // One shared rule: the pack's isTagged is a non-empty resource array (closure item 10).
      const isTagged = node.tagged;
      if (holds[v] === 1 || isTagged || node.priority === CASE_PRIORITY) {
        if (node.parent !== null) holds[node.parent] = 1;
      }
    }

    // 2. Roles, top down.
    const role = new Uint8Array(n);
    const within = new Int32Array(n).fill(-1);
    for (let v = 0; v < n; v++) {
      const node = nodes[v];
      const parent = node.parent;
      const inside = parent === null ? -1 : role[parent] === CASE || role[parent] === CANDIDATE ? parent : within[parent];
      within[v] = inside;
      if (node.tagged) {
        const isGroup = inside === -1 && node.priority === GROUP_PRIORITY && holds[v] === 1;
        role[v] = isGroup ? GROUP : CASE;
      } else if (inside !== -1) {
        role[v] = INNER;
      } else if (node.priority === CASE_PRIORITY && node.children.length > 0 && holds[v] === 0) {
        role[v] = caseRule === 'marked' ? CASE : CANDIDATE;
      } else if (node.priority !== null) {
        role[v] = GROUP;
      } else {
        role[v] = OTHER;
      }
    }

    // 3. Collect cases and their inner steps / expected / preconditions.
    const cases: GoldCase[] = [];
    const caseIndexMap = new Int32Array(n).fill(-1);
    const stepOf = new Int32Array(n).fill(-1);

    for (let v = 0; v < n; v++) {
      const node = nodes[v];
      if (role[v] === CASE) {
        const negative = node.resource.some((tag) => NEGATIVE_KEYS.has(foldKey(tag)));
        const group = node.ancestors.length > 1 ? node.ancestors[1] : '';
        const c: GoldCase = {
          id: node.id === '' ? `@${node.index}` : node.id,
          title: node.text,
          tags: [...node.rawTags],
          expected: [],
          steps: [],
          hasExpected: false,
          vagueExpected: false,
          negative,
          group,
          // Per text, as the pack does (the case title and each label above it), then unioned.
          defects: [...new Set([node.text, ...node.ancestors].flatMap((label) => bugIdsOf(label)))].sort(),
        };
        caseIndexMap[v] = cases.length;
        cases.push(c);
      } else if (role[v] === INNER) {
        const owner = within[v];
        if (owner === -1 || role[owner] !== CASE) continue;
        const c = cases[caseIndexMap[owner]];
        const parentStep = node.parent === owner ? -1 : (node.parent !== null ? stepOf[node.parent] : -1);
        const isLeaf = node.children.length === 0;

        if (isLeaf && node.priority === PRECONDITION_PRIORITY) {
          // Precondition leaf is not an expected result
        } else if (parentStep === -1 && !isLeaf) {
          // A child with children is a step
          c.steps.push({ text: node.text, expected: [] });
          stepOf[v] = c.steps.length - 1;
        } else if (isLeaf) {
          // Expected result
          c.expected.push(node.text);
          if (parentStep !== -1 && parentStep < c.steps.length) {
            c.steps[parentStep].expected.push(node.text);
          }
        } else {
          stepOf[v] = parentStep;
        }
      }
    }

    // Post-process hasExpected and vagueExpected
    for (const c of cases) {
      const nonBlank = c.expected.filter((t) => t.trim() !== '');
      c.hasExpected = nonBlank.length > 0;
      c.vagueExpected = nonBlank.length > 0 && nonBlank.every((t) => VAGUE_KEYS.has(foldKey(t)));
    }

    if (cases.length === 0) throw new NoCaseNodes(`文档 ${documentId} 里没有带${caseRule === 'tagged' ? '资源标签' : '用例标记或资源标签'}的用例节点`);

    const groupCounts: Record<string, number> = {};
    for (const c of cases) groupCounts[c.group] = (groupCounts[c.group] ?? 0) + 1;
    documents.push({
      document: documentId,
      cases: cases.length,
      withExpected: cases.filter((c) => c.hasExpected).length,
      vagueCases: cases.filter((c) => c.vagueExpected).map((c) => c.id).sort(),
      negativeCases: cases.filter((c) => c.negative).map((c) => c.id),
      groupCounts,
      defects: [...new Set(cases.flatMap((c) => c.defects))].sort(),
      items: cases,
    });
  }
  return { documents };
}

export async function main(argv: string[]): Promise<number> {
  const value = (name: string): string | undefined => {
    const at = argv.indexOf(`--${name}`);
    return at >= 0 ? argv[at + 1] : undefined;
  };
  const outPath = value('out');
  const caseRuleArg = value('case-rule');
  const caseRule = caseRuleArg === 'tagged' ? 'tagged' : 'marked';
  const mapArgs: string[] = [];
  for (let k = 0; k < argv.length; k++) {
    if (argv[k] === '--map' && k + 1 < argv.length) mapArgs.push(argv[k + 1]);
  }
  if (mapArgs.length === 0 || !outPath) {
    process.stderr.write('用法：node scripts/real/gold/cases.ts --map <file>:<documentId> [--map ...] [--case-rule tagged|marked] --out <gold.json>\n');
    return 2;
  }
  const maps: Array<{ document: string; map: unknown }> = [];
  for (const arg of mapArgs) {
    const at = arg.lastIndexOf(':');
    const file = at > 0 ? arg.slice(0, at) : arg;
    const documentId = at > 0 ? arg.slice(at + 1) : '';
    try {
      const text = readFileSync(resolve(file), 'utf8');
      maps.push({ document: documentId, map: JSON.parse(text) as unknown });
    } catch (error) {
      process.stderr.write(`读不了脑图 ${arg}：${(error as Error).message.split('\n')[0]}\n`);
      return 1;
    }
  }
  try {
    writeFileSync(outPath, `${JSON.stringify(caseGold(maps, { caseRule }), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`写不了 ${outPath}：${(error as Error).message.split('\n')[0]}\n`);
    return 1;
  }
  return 0;
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('gold/cases.ts')) {
  void main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}

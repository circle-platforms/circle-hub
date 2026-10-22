// Gold script: the case counts of exported agile mind maps, computed independently of the Hub. Imports nothing
// from hub/ or packs/ (its independence is its whole value). The case-node rule is re-implemented from the words
// of packs/workflow/case-review/README.md: a case is a node whose `resource` is a non-empty array; the children
// of a case are expected results (leaves), steps (children with children, their leaves expected results) and
// preconditions (leaves with the precondition priority, default 3); the vague-expected phrase list is copied
// from the pack's table source (matched whole, folded: NFKC, lower case, no white space, no edge punctuation);
// negative is a canonical Negative tag; defect ids come from the case title, the ancestor labels and the
// document's root title (bug markers: bug to case, bug-to-case, bug2case, 缺陷 ...; digits 2..9 long).
//   node scripts/real/gold/cases.ts --map <file>:<documentId> [--map <file>:<documentId> ...] --out <gold.json>
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface GoldNode {
  index: number;
  id: string;
  text: string;
  resource: string[];
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
    const resource = Array.isArray(record.resource) ? record.resource.filter((t): t is string => typeof t === 'string' && t.trim() !== '') : [];
    const priority = typeof record.priority === 'number' && Number.isInteger(record.priority) ? record.priority : null;
    const childrenRaw = (raw as { children?: unknown }).children;
    const index = nodes.length;
    nodes.push({ index, id, text, resource, priority, ancestors, children: [], parent });
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
const NEGATIVE_KEYS = new Set(['negative', 'neg', '负向', '负面', '反向', '逆向', '异常'].map(foldKey));

const BUG_MARKERS =
  /(?<![A-Za-z])(?:(?:bu(?:t|gt)[\s_-]*(?:t?o|ro|2)[\s_-]*c[a-z]{0,5}|bugs?[\s_-]*(?:t?o|ro|2)?[\s_-]*c[a-z]{0,5}|缺陷))/gi;
const SEPARATOR = /^(?:\s*(?:&|、|,|\+|\/|\band\b|和|及|与)\s*|\s+)(?=[0-9])/i;
const NOT_ID = /^(?:19|20)[0-9]{2}/;

/** Bug ids of one text: after each bug marker, digit runs 2..9 long, separated by , &、and. */
export function bugIdsOf(text: string): string[] {
  const ids: string[] = [];
  for (const match of text.normalize('NFKC').matchAll(BUG_MARKERS)) {
    let at = (match.index ?? 0) + match[0].length;
    at += /^[\s_\-–—:#.]*/.exec(text.slice(at))![0].length;
    for (let guard = 0; guard < 64; guard++) {
      const found = /^\d{2,9}/.exec(text.slice(at));
      if (found === null) break;
      const id = found[0];
      const next = text.slice(at + id.length, at + id.length + 2);
      if (!(NOT_ID.test(id) && id.length === 8 && /^\d{2}$/.test(next)) && !/^\d{4}-\d{1,2}/.test(id + next)) ids.push(id);
      at += id.length;
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

export function caseGold(maps: ReadonlyArray<{ document: string; map: unknown }>): CasesGold {
  const documents: GoldDocument[] = [];
  for (const { document: documentId, map } of maps) {
    const { nodes } = parseMindMap(map);
    const cases: GoldCase[] = [];
    // A case is a node whose resource is a non-empty array.
    for (const node of nodes) {
      if (node.resource.length === 0) continue;
      const expected: string[] = [];
      const steps: GoldStep[] = [];
      for (const childIndex of node.children) {
        const child = nodes[childIndex];
        if (child.children.length > 0) {
          const stepExpected = child.children.map((i) => nodes[i].text).filter((t) => t.trim() !== '');
          steps.push({ text: child.text, expected: stepExpected });
          expected.push(...stepExpected);
        } else if (child.priority === PRECONDITION_PRIORITY) {
          // a precondition leaf is not an expected result
        } else {
          expected.push(child.text);
        }
      }
      const nonBlank = expected.filter((t) => t.trim() !== '');
      const vague = nonBlank.length > 0 && nonBlank.every((t) => VAGUE_KEYS.has(foldKey(t)));
      const negative = node.resource.some((tag) => NEGATIVE_KEYS.has(foldKey(tag)));
      const group = node.ancestors.length > 1 ? node.ancestors[1] : '';
      cases.push({
        id: node.id === '' ? `@${node.index}` : node.id,
        title: node.text,
        expected,
        steps,
        hasExpected: nonBlank.length > 0,
        vagueExpected: vague,
        negative,
        group,
        defects: bugIdsOf([node.text, ...node.ancestors].join(' ')),
      });
    }
    if (cases.length === 0) throw new Error(`文档 ${documentId} 里没有带资源标签的用例节点`);
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
  const mapArgs: string[] = [];
  for (let k = 0; k < argv.length; k++) {
    if (argv[k] === '--map' && k + 1 < argv.length) mapArgs.push(argv[k + 1]);
  }
  if (mapArgs.length === 0 || !outPath) {
    process.stderr.write('用法：node scripts/real/gold/cases.ts --map <file>:<documentId> [--map ...] --out <gold.json>\n');
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
    writeFileSync(outPath, `${JSON.stringify(caseGold(maps), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`写不了 ${outPath}：${(error as Error).message.split('\n')[0]}\n`);
    return 1;
  }
  return 0;
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('gold/cases.ts')) {
  void main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}

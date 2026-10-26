// A synthetic agile test platform for the case index: three configured roots (one per product name and one of another
// product), a versioned tree in the platform's convention (`030：<names>测试项目` -> version line -> release train ->
// module -> document), 300 KityMinder test mind maps, and the truth of every document and case, built while the documents
// are built (never computed by the code under test). Case titles, group labels and document titles come from table.ts, so
// the commands each case must resolve are the table's. Names, commands and addresses (192.0.2.0/24, 2001:db8::/32) are
// invented. The synthetic lines (10.6.142 and the rest) are the synthetic scenario the product pack's default min_line exercises;
// a document is on a build when the release-train month in its train label is not later than that build's, and numeric order is deliberately not used as a lineage claim. The product names are a parameter:
// product packs pass their own, this directory never names a product.
import { CATALOG_A, CATALOG_B, type Command } from './catalog.ts';
import { tableRow } from './table.ts';

export const DEFAULT_NAMES: readonly [string, string] = ['ORBIT', 'COMET'];
/** The synthetic deployment default: no lower release-train bound. */
export const MIN_LINE: string | null = null;
/** Expected-result texts that say nothing checkable; a case whose expected texts are all among them is vague. */
export const VAGUE_TEXTS: readonly string[] = ['设备正常', '显示正确', '操作成功', '符合预期', '正常', '设备正常。'];

export type KmNode = { data: Record<string, unknown>; children: KmNode[] };
export type KmDocument = { root: KmNode; template: string; theme: string; version: string };
export type AgileNode = { label: string; id: string; cases: string[]; children: AgileNode[] };

export type CaseTruth = {
  document: string;
  /** data.id when it is unique among the document's case nodes, else the selector. An id copied onto a non-case leaf stays. */
  node: string;
  /** The kityminder@1 selector of the case node. */
  selector: string;
  title: string;
  path_labels: string[];
  priority: number | string | null;
  tags: string[];
  negative: boolean | null;
  expected_count: number;
  has_expected: boolean;
  vague_expected: boolean;
  steps_count: number;
  /** Command words that must resolve, against catalog a and catalog b, sorted. */
  commands: { a: string[]; b: string[] };
  stories: string[];
  defects: string[];
  autoid: string | null;
};

export type DocumentTruth = {
  id: string;
  /** The agile root it sits under, and whether that root is titled with a product name. */
  root: string;
  product: boolean;
  /** Its label in the agile tree, and the labels of the folders above it from the root title down. */
  title: string;
  ancestors: string[];
  /** Version line (dotted, trailing .0 parts beyond the second dropped), release train and module, or null. */
  line: string | null;
  train: string | null;
  module: string | null;
  /** Why a product document is not listed for any build; null when it is listed by its line. */
  unlisted: 'no_line' | 'before_min_line' | null;
  cases: CaseTruth[];
};

export type Corpus = {
  names: readonly [string, string];
  /** Root ids of the platform's listing (23 roots, 10 per page), the three configured ones among them. */
  listing: { id: string; label: string }[];
  /** The configured roots (resource settings.roots), in order. */
  roots: string[];
  trees: Record<string, AgileNode[]>;
  documents: Record<string, KmDocument>;
  truth: DocumentTruth[];
  /** A tree leaf whose id the agile platform can never serve (white space): no document. */
  badId: string;
  /** A document listed in two folders of the tree (it counts once). */
  repeated: string;
  /** Empty folders: a train and a module with no document. The tree marks them listed: false; the plan does not list them. */
  emptyFolders: readonly string[];
};

// ---------------------------------------------------------------- small helpers

function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
const byNumber = (a: string, b: string): number => (a.length - b.length) || (a < b ? -1 : a > b ? 1 : 0);
const sortedUnique = (values: Iterable<string>, order: (a: string, b: string) => number = (a, b) => (a < b ? -1 : a > b ? 1 : 0)): string[] => [...new Set(values)].sort(order);
const commandWords = (catalog: readonly Command[]): Set<string> => new Set(catalog.map((c) => c.words));
const WORDS_A = commandWords(CATALOG_A);
const WORDS_B = commandWords(CATALOG_B);

/** Dotted line text in the comparable form: trailing `.0` parts beyond the second dropped. */
export function lineForm(line: string): string {
  const parts = line.split('.').map((p) => String(Number(p)));
  while (parts.length > 2 && parts[parts.length - 1] === '0') parts.pop();
  return parts.join('.');
}

/** Numeric comparison of two dotted lines. */
export function compareLine(a: string, b: string): number {
  const x = lineForm(a).split('.').map(Number);
  const y = lineForm(b).split('.').map(Number);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
}

/** Independent corpus reference: release-train dates decide inclusion, including lines out of numeric order. */
export function listedFor(corpus: Corpus, buildLine: string, minLine: string | null = MIN_LINE): string[] {
  const ranks=new Map<string,string>();
  for(const d of corpus.truth){
    if(!d.product||d.line===null||d.train===null)continue;
    const month=/([0-9]{4})\/([0-9]{1,2})(?![0-9])/.exec(d.train);
    if(!month)continue;
    const date=month[1]+'-'+month[2].padStart(2,'0');const key=lineForm(d.line);
    if(!ranks.has(key)||date<ranks.get(key)!)ranks.set(key,date);
  }
  const target=lineForm(buildLine),end=ranks.get(target),floor=minLine===null?undefined:ranks.get(lineForm(minLine));
  return corpus.truth.filter(d=>{
    if(!d.product||d.line===null)return false;
    const key=lineForm(d.line),date=ranks.get(key);
    return (floor===undefined||date===undefined||date>=floor)&&(key===target||date!==undefined&&end!==undefined&&date<=end);
  }).map(d=>d.id).sort(byNumber);
}

// ---------------------------------------------------------------- the mind maps

type Spec = {
  text: string;
  p?: number | string | null;
  r?: string[];
  autoid?: string;
  /** Forced id; null writes no id. */
  id?: string | null;
  /** Table row of the text (its commands count for every case at or below the node). */
  row?: string;
  /** Ids the text carries, by kind (hand-written next to the text). */
  ids?: { defects?: string[]; stories?: string[] };
  /** Set on case nodes: what the corpus put into the case. */
  truth?: { expected: string[]; steps: number; vague: boolean; negative: boolean | null };
  children: Spec[];
};

const NEGATIVE_TAGS = new Set(['Negative', '负向', '[negative]']);

type ExpectedKind = 'specific' | 'vague1' | 'vague2' | 'mixed' | 'none' | 'blank' | 'step' | 'step-vague' | 'precondition-step' | 'punct-vague';
const EXPECTED_KINDS: readonly ExpectedKind[] = ['specific', 'vague1', 'step', 'none', 'vague2', 'mixed', 'precondition-step', 'blank', 'step-vague', 'punct-vague'];

/** The children of a case of this kind and what they mean: expected texts (leaves), steps, all vague. */
function caseChildren(kind: ExpectedKind, k: number): { children: Spec[]; expected: string[]; steps: number; vague: boolean } {
  const leaf = (text: string, extra: Partial<Spec> = {}): Spec => ({ text, ...extra, children: [] });
  switch (kind) {
    case 'specific':
      return { children: [leaf(`返回码为 0，show 显示第 ${k} 项与配置一致`)], expected: [`返回码为 0，show 显示第 ${k} 项与配置一致`], steps: 0, vague: false };
    case 'vague1':
      return { children: [leaf('设备正常')], expected: ['设备正常'], steps: 0, vague: true };
    case 'vague2':
      return { children: [leaf('操作成功'), leaf('显示正确')], expected: ['操作成功', '显示正确'], steps: 0, vague: true };
    case 'punct-vague':
      return { children: [leaf('设备正常。')], expected: ['设备正常。'], steps: 0, vague: true };
    case 'mixed':
      return { children: [leaf('设备正常'), leaf('CPU 占用低于 70%')], expected: ['设备正常', 'CPU 占用低于 70%'], steps: 0, vague: false };
    case 'none':
      return { children: [], expected: [], steps: 0, vague: false };
    case 'blank':
      return { children: [leaf(' ')], expected: [' '], steps: 0, vague: false };
    case 'step':
      return { children: [{ text: '1.执行配置\n2.执行 show 查看', children: [leaf('显示与配置一致')] }], expected: ['显示与配置一致'], steps: 1, vague: false };
    case 'step-vague':
      return { children: [{ text: '执行配置后查看', children: [leaf('正常')] }], expected: ['正常'], steps: 1, vague: true };
    case 'precondition-step':
      return { children: [leaf('已配置 pool1', { p: 3 }), { text: '执行升级', children: [leaf('符合预期')] }], expected: ['符合预期'], steps: 1, vague: true };
  }
}

const TAG_SETS: readonly string[][] = [['Configuration'], ['Function'], ['Negative'], ['功能', 'R2ADD'], ['负向'], ['Stress'], ['[negative]'], ['configuration']];

/** Case titles: every title row of the table; the rows without a command twice, as many real titles name none. */
const POSITIVE_TITLES = [
  'plain-interval', 'plain-pool-add', 'plain-endpoint-v4', 'plain-endpoint-v6', 'plain-beacon', 'plain-show', 'plain-show-detail', 'plain-show-pool',
  'plain-reboot', 'plain-ping', 'plain-no-args', 'sentence-two', 'sentence-weight', 'sentence-colon', 'sentence-glued', 'sentence-backup',
  'sentence-english', 'sentence-two-commands', 'quoted-backticks', 'quoted-curly', 'quoted-single', 'quoted-corner', 'short-off', 'short-on',
  'short-upper', 'short-three-words', 'short-clear', 'abbr-first', 'abbr-inner', 'abbr-system', 'abbr-endpoint', 'abbr-statistics', 'no-own',
  'no-own-sentence', 'no-base', 'negative-range', 'numbered-dot', 'numbered-comma', 'prompt-prefix', 'numbered-paren',
];
const NEGATIVE_TITLES = [
  'not-named-command', 'not-prose-show', 'not-prose-ping', 'not-lone-first', 'not-prefix-only', 'not-unknown-word', 'not-inside-words',
  'not-longer-word', 'not-version', 'not-address', 'not-other-word', 'not-placeholder', 'not-ambiguous', 'not-lone-abbreviation',
  'not-second-word', 'not-argument-word', 'not-capitalised-word', 'not-gerund', 'not-joined-word', 'not-hyphenated', 'not-hyphen-argument',
  'not-lone-abbreviated-first',
];
const TITLE_ROWS = POSITIVE_TITLES.flatMap((key, k) => [key, NEGATIVE_TITLES[k % NEGATIVE_TITLES.length], NEGATIVE_TITLES[(k + 11) % NEGATIVE_TITLES.length]]);
const GROUP_ROWS = [
  'path-retries', 'path-ipv4', 'not-path-plain', 'path-webui', 'not-path-prefix', 'path-errors', 'path-beacon-delete', 'not-path-words',
  'path-story', 'not-path-endpoint', 'path-ipv4', 'path-show-profile', 'path-errors', 'not-path-plain', 'path-weight', 'path-webui',
];
const GROUP_IDS: Record<string, { stories?: string[]; defects?: string[] }> = { 'path-story': { stories: ['18001'] } };
const TITLE_DOCS = ['doc-plain', 'doc-story-command', 'doc-bug', 'doc-bare-id', 'doc-bugs', 'doc-plain', 'doc-regression', 'doc-story-glued', 'doc-bug', 'doc-bare-id', 'doc-story-hash', 'doc-regression'];
const DOC_IDS: Record<string, { stories?: string[]; defects?: string[] }> = {
  'doc-story-command': { stories: ['17206'] },
  'doc-story-glued': { stories: ['7301'] },
  'doc-story-hash': { stories: ['7302'] },
  'doc-bug': { defects: ['61001'] },
  'doc-bugs': { defects: ['70412', '70413'] },
};

/** One case of a document: a tagged case (default), a marked case (no tags, the template's priority 2 with children) or a tagged leaf. */
function caseSpec(d: number, n: number, form: 'tagged' | 'marked' | 'leaf'): Spec {
  const key = TITLE_ROWS[(d * 7 + n * 5) % TITLE_ROWS.length];
  const text = tableRow(key).text;
  if (form === 'leaf') {
    const tags = TAG_SETS[(d + n) % TAG_SETS.length];
    return { text, p: 2, r: tags, row: key, truth: { expected: [], steps: 0, vague: false, negative: tags.some((t) => NEGATIVE_TAGS.has(t)) }, children: [] };
  }
  let kind = EXPECTED_KINDS[(d * 3 + n) % EXPECTED_KINDS.length];
  // A marked case needs children (and its steps carry no case priority).
  if (form === 'marked' && (kind === 'none' || kind === 'blank')) kind = 'precondition-step';
  const built = caseChildren(kind, n);
  const has = built.expected.some((t) => t.trim() !== '');
  const truth = { expected: built.expected, steps: built.steps, vague: has && built.vague, negative: null as boolean | null };
  if (form === 'marked') return { text, p: 2, row: key, truth, children: built.children };
  const tags = TAG_SETS[(d * 5 + n) % TAG_SETS.length];
  truth.negative = tags.some((t) => NEGATIVE_TAGS.has(t));
  const priority = n % 11 === 7 ? 1 : n % 13 === 9 ? undefined : n % 17 === 3 ? '20' : 2;
  const spec: Spec = { text, r: tags, row: key, truth, children: built.children };
  if (priority !== undefined) spec.p = priority;
  if ((d + n) % 9 === 4) spec.autoid = `73000000${String(d).padStart(4, '0')}${String(n).padStart(4, '0')}`;
  return spec;
}

/** The mind map of document number d (1-based) with title text `title`. */
function mindMap(d: number, title: { text: string; row?: string; ids?: Spec['ids'] }): Spec {
  // Every 31st document is an outline without any case.
  if (d % 31 === 0) {
    return { text: title.text, row: title.row, ids: title.ids, children: [{ text: '梳理', children: [{ text: '会话建立', children: [{ text: '同一客户端落到同一后端', children: [] }] }, { text: '待确认问题', children: [] }] }] };
  }
  const groups: Spec[] = [];
  const count = 2 + (d % 3);
  let n = 0;
  for (let g = 0; g < count; g++) {
    const key = GROUP_ROWS[(d * 5 + g * 3) % GROUP_ROWS.length];
    const cases: Spec[] = [];
    const size = 3 + ((d + g) % 5);
    for (let k = 0; k < size; k++) {
      n++;
      const form = (d + n) % 6 === 0 ? 'marked' : (d + n) % 23 === 0 ? 'leaf' : 'tagged';
      cases.push(caseSpec(d, n, form));
    }
    const group: Spec = { text: tableRow(key).text, row: key, ids: GROUP_IDS[key], children: cases };
    // Most groups carry the group priority; some are plain nodes, and every 29th document has a tagged group.
    if (g === 1 && d % 29 === 0) {
      group.p = 1;
      group.r = ['Function'];
    } else if ((d + g) % 4 !== 3) group.p = 1;
    groups.push(group);
  }
  // A nested case: a tagged case below a tagged case.
  if (d % 23 === 0) {
    n++;
    const inner = caseSpec(d, n + 100, 'tagged');
    inner.p = 2;
    n++;
    const outerKey = TITLE_ROWS[(d + 3) % TITLE_ROWS.length];
    groups[0].children.push({
      text: tableRow(outerKey).text,
      p: 2,
      r: ['Function'],
      row: outerKey,
      truth: { expected: ['外层期望'], steps: 0, vague: false, negative: false },
      children: [{ text: '外层期望', children: [] }, inner],
    });
  }
  // An untagged node with the case priority that holds a tagged case: a group, not a case.
  if (d % 13 === 0) groups[groups.length - 1].children.push({ text: '端点批量操作', p: 2, children: [caseSpec(d, ++n, 'tagged')] });
  const root: Spec = { text: title.text, row: title.row, ids: title.ids, children: groups };
  // A precondition at the top level, as real maps have (a priority node outside every case).
  if (d % 5 === 0) root.children.unshift({ text: '拓扑：客户端-网关-两台后端（192.0.2.21、192.0.2.22）', p: 3, children: [] });
  // Every 17th document has a case without id, every 19th two cases sharing one id.
  const allCases: Spec[] = [];
  const collect = (spec: Spec): void => {
    if (spec.truth !== undefined) allCases.push(spec);
    spec.children.forEach(collect);
  };
  collect(root);
  if (d % 17 === 0 && allCases.length > 1) allCases[1].id = null;
  if (d % 19 === 0 && allCases.length > 3) {
    allCases[2].id = `dup${String(d).padStart(9, '0')}`;
    allCases[3].id = `dup${String(d).padStart(9, '0')}`;
  }
  return root;
}

/** KityMinder JSON of a spec tree, with fresh 12-character ids where none is forced. */
function toDocument(spec: Spec, seed: number): KmDocument {
  const next = generator(seed);
  const used = new Set<string>();
  const fresh = (): string => {
    for (;;) {
      let id = '';
      for (let i = 0; i < 12; i++) id += ALPHABET[Math.floor(next() * 36)];
      if (!used.has(id)) {
        used.add(id);
        return id;
      }
    }
  };
  let counter = 0;
  const node = (s: Spec): KmNode => {
    const data: Record<string, unknown> = {};
    const id = s.id === undefined ? fresh() : s.id;
    if (id !== null) data.id = id;
    data.created = 1767225600000 + counter++ * 61_000;
    data.text = s.text;
    if (s.p !== undefined) data.priority = s.p;
    if (s.r !== undefined) data.resource = [...s.r];
    if (s.autoid !== undefined) {
      data.autoid = s.autoid;
      data.auto = 'YES';
    }
    // Remember the id written, for the truth.
    (s as Spec & { written?: string | null }).written = id;
    return { data, children: s.children.map(node) };
  };
  return { root: node(spec), template: 'default', theme: 'fresh-blue', version: '1.4.43' };
}

/** The truth of every case of a built spec tree: positions, labels, identity, commands and ids. */
function casesOf(document: string, root: Spec, extraIds: string[]): CaseTruth[] {
  const written = (s: Spec): string | null => (s as Spec & { written?: string | null }).written ?? null;
  // Selector uniqueness is every node (the parser's rule). The case key counts cases only, and a case with no usable id
  // is `@<flat index>` (case-review), the flat index being the parser's pre-order index. 200 is cases-nodes MAX_ITEM_ID.
  const allCounts = new Map<string, number>();
  const caseCounts = new Map<string, number>();
  const tally = (s: Spec): void => {
    const id = written(s);
    if (id !== null) allCounts.set(id, (allCounts.get(id) ?? 0) + 1);
    if (s.truth !== undefined && id !== null) caseCounts.set(id, (caseCounts.get(id) ?? 0) + 1);
    s.children.forEach(tally);
  };
  tally(root);
  const real = new Set(allCounts.keys());
  const assigned = new Set<string>();
  const copies = new Map<string, number>();
  const fits = (key: string): boolean => document.length + 1 + key.length <= 200;
  const free = (key: string): boolean => !assigned.has(key) && !real.has(key);
  const positional = (index: number): string => {
    let key = `@${index}`;
    for (let k = 2; !free(key); k++) key = `@${index}#${k}`;
    assigned.add(key);
    return key;
  };
  const out: CaseTruth[] = [];
  let flat = 0;
  const walk = (s: Spec, positions: number[], above: Spec[]): void => {
    const index = flat++;
    if (s.truth !== undefined) {
      const id = written(s);
      const addressable = id !== null && allCounts.get(id) === 1;
      const selector = addressable ? `n/${id}` : ['i', ...positions].join('/');
      let node: string;
      if (id === null || !fits(id)) node = positional(index);
      else if (caseCounts.get(id) === 1) {
        assigned.add(id);
        node = id;
      } else {
        let k = copies.get(id) ?? 0;
        let key: string;
        do {
          k += 1;
          key = `${id}#${k}`;
        } while (!free(key));
        copies.set(id, k);
        if (fits(key)) {
          assigned.add(key);
          node = key;
        } else node = positional(index);
      }
      const chain = [...above, s];
      const rows = chain.flatMap((x) => (x.row === undefined ? [] : [x.row]));
      const words = sortedUnique(rows.flatMap((key) => tableRow(key).commands));
      const defects = sortedUnique([...chain.flatMap((x) => x.ids?.defects ?? []), ...extraIds.filter((x) => x.startsWith('d:')).map((x) => x.slice(2))], byNumber);
      const stories = sortedUnique([...chain.flatMap((x) => x.ids?.stories ?? []), ...extraIds.filter((x) => x.startsWith('s:')).map((x) => x.slice(2))], byNumber);
      const has = s.truth.expected.some((t) => t.trim() !== '');
      out.push({
        document,
        node,
        selector,
        title: s.text,
        path_labels: above.map((x) => x.text),
        priority: s.p === undefined ? null : s.p,
        tags: s.r === undefined ? [] : [...s.r],
        negative: s.truth.negative,
        expected_count: s.truth.expected.length,
        has_expected: has,
        vague_expected: s.truth.vague,
        steps_count: s.truth.steps,
        commands: { a: words.filter((w) => WORDS_A.has(w)), b: words.filter((w) => WORDS_B.has(w)) },
        stories,
        defects,
        autoid: s.autoid ?? null,
      });
    }
    s.children.forEach((child, k) => walk(child, [...positions, k], [...above, s]));
  };
  walk(root, [], []);
  return out;
}

// ---------------------------------------------------------------- the agile tree

type Placement = { line: string | null; train: string | null; module: string | null; unlisted: DocumentTruth['unlisted'] };

/** Where the corpus's documents go: folder chains under the configured roots, with the placement each one means. */
type Slot = { root: 'first' | 'second' | 'other'; folders: string[]; count: number; placement: Placement };

function slots(names: readonly [string, string]): Slot[] {
  const project = `030：${names[0]}/${names[1]}测试项目`;
  const line = (label: string, train: string, module: string, count: number, value: string, trainText: string, unlisted: Placement['unlisted'] = null): Slot => ({
    root: 'second',
    folders: [project, label, train, module],
    count,
    placement: { line: value, train: trainText, module, unlisted },
  });
  return [
    { root: 'first', folders: ['产品说明'], count: 2, placement: { line: null, train: null, module: null, unlisted: 'no_line' } },
    { root: 'first', folders: ['常见问题'], count: 2, placement: { line: null, train: null, module: null, unlisted: 'no_line' } },
    { root: 'first', folders: [], count: 1, placement: { line: null, train: null, module: null, unlisted: 'no_line' } },
    line('059：10.6.141', '001：10.6.141-R1-2025/9', '健康检查', 10, '10.6.141', '10.6.141-R1-2025/9'),
    line('059：10.6.141', '001：10.6.141-R1-2025/9', '端点', 10, '10.6.141', '10.6.141-R1-2025/9'),
    line('060：10.6.142', '002：10.6.142-R1-2025/12', '健康检查', 20, '10.6.142', '10.6.142-R1-2025/12'),
    line('060：10.6.142', '002：10.6.142-R1-2025/12', '会话保持', 15, '10.6.142', '10.6.142-R1-2025/12'),
    line('060：10.6.142', '002：10.6.142-R1-2025/12', '池管理', 15, '10.6.142', '10.6.142-R1-2025/12'),
    line('061：10.6.4', '003：10.6.4-R1-2026/11', '健康检查', 25, '10.6.4', '10.6.4-R1-2026/11'),
    line('061：10.6.4', '003：10.6.4-R1-2026/11', 'WebUI', 15, '10.6.4', '10.6.4-R1-2026/11'),
    line('061：10.6.4', '004：10.6.4-R2-2027/2', '日志', 20, '10.6.4', '10.6.4-R2-2027/2'),
    line('061：10.6.4', '004：10.6.4-R2-2027/2', '认证', 20, '10.6.4', '10.6.4-R2-2027/2'),
    line('062：10.6.150', '005：10.6.150-主线-2026/8', '网络', 25, '10.6.150', '10.6.150-主线-2026/8'),
    line('062：10.6.150', '005：10.6.150-主线-2026/8', '系统', 15, '10.6.150', '10.6.150-主线-2026/8'),
    line('063：10.6.1', '006：10.6.1-R1-2026/9', '健康检查', 30, '10.6.1', '10.6.1-R1-2026/9'),
    line('063：10.6.1', '006：10.6.1-R1-2026/9', '端点', 18, '10.6.1', '10.6.1-R1-2026/9'),
    // A document folder under the train (no module), and documents right under the version line (no train).
    { root: 'second', folders: [project, '063：10.6.1', '006：10.6.1-R1-2026/9', 'bug to case 61001'], count: 10, placement: { line: '10.6.1', train: '10.6.1-R1-2026/9', module: null, unlisted: null } },
    { root: 'second', folders: [project, '063：10.6.1'], count: 2, placement: { line: '10.6.1', train: null, module: null, unlisted: null } },
    // A release train without a version line above it: the line is the train's.
    { root: 'second', folders: [project, '007：10.6.2-R1-2026/10', '日志'], count: 20, placement: { line: '10.6.2', train: '10.6.2-R1-2026/10', module: '日志', unlisted: null } },
    line('064：10.7.0', '008：10.7.0-R1-2026/12', '会话保持', 15, '10.7', '10.7.0-R1-2026/12'),
    // Another product's root: versioned in the same convention, never listed.
    { root: 'other', folders: ['030：演示测试项目', '060：10.6.1', '201: 10.6.1-R1-2026/1', '组件'], count: 10, placement: { line: '10.6.1', train: '10.6.1-R1-2026/1', module: '组件', unlisted: null } },
  ];
}

const ROOT_IDS = { first: '7811', second: '7812', other: '7813' } as const;
const OTHER_TITLE = '演示产品';

export function caseCorpus(options: { names?: readonly [string, string] } = {}): Corpus {
  const names = options.names ?? DEFAULT_NAMES;
  const listing = Array.from({ length: 23 }, (_, i) => ({ id: String(7800 + i), label: `合成根 ${i}` }));
  listing[11] = { id: ROOT_IDS.first, label: names[0] };
  listing[12] = { id: ROOT_IDS.second, label: names[1] };
  listing[13] = { id: ROOT_IDS.other, label: OTHER_TITLE };
  const titleOf = { first: names[0], second: names[1], other: OTHER_TITLE } as const;
  const trees: Record<string, AgileNode[]> = { [ROOT_IDS.first]: [], [ROOT_IDS.second]: [], [ROOT_IDS.other]: [] };
  const documents: Record<string, KmDocument> = {};
  const truth: DocumentTruth[] = [];
  const folders = new Set<AgileNode>();
  let folderId = 8800;
  let d = 0;
  const rootDocs: Record<string, string[]> = { [ROOT_IDS.first]: [], [ROOT_IDS.second]: [], [ROOT_IDS.other]: [] };
  // Files a document leaf under a chain of folder labels. Every folder lists every document below it (the platform's
  // lists are cumulative); the root node, wrapped on at the end, lists all of them.
  const file = (rootKey: keyof typeof ROOT_IDS, labels: readonly string[], leaf: AgileNode): void => {
    const rootId = ROOT_IDS[rootKey];
    let level = trees[rootId];
    const chain: AgileNode[] = [];
    for (const label of labels) {
      let found = level.find((x) => x.label === label && folders.has(x));
      if (found === undefined) {
        found = { label, id: String(folderId++), cases: [], children: [] };
        folders.add(found);
        level.push(found);
      }
      chain.push(found);
      level = found.children;
    }
    level.push(leaf);
    for (const folder of chain) folder.cases.push(leaf.id);
    rootDocs[rootId].push(leaf.id);
  };
  for (const slot of slots(names)) {
    for (let k = 0; k < slot.count; k++) {
      d++;
      const id = String(950000 + d);
      const docKey = TITLE_DOCS[d % TITLE_DOCS.length];
      const docRow = tableRow(docKey);
      // Every 37th document's tree label differs from its mind map's root text.
      const agileTitle = d % 37 === 0 ? `bug to case ${60000 + d} 回归` : docRow.text;
      const agileIds = d % 37 === 0 ? [`d:${60000 + d}`] : [...(DOC_IDS[docKey]?.defects ?? []).map((x) => `d:${x}`), ...(DOC_IDS[docKey]?.stories ?? []).map((x) => `s:${x}`)];
      const folderIds = slot.folders.includes('bug to case 61001') ? ['d:61001'] : [];
      const spec = mindMap(d, { text: docRow.text, row: docKey, ids: DOC_IDS[docKey] });
      documents[id] = toDocument(spec, 4242 + d);
      file(slot.root, slot.folders, { label: agileTitle, id, cases: [], children: [] });
      const ancestors = [titleOf[slot.root], ...slot.folders];
      truth.push({
        id,
        root: ROOT_IDS[slot.root],
        product: slot.root !== 'other',
        title: agileTitle,
        ancestors,
        line: slot.placement.line,
        train: slot.placement.train,
        module: slot.placement.module,
        unlisted: slot.root === 'other' ? null : slot.placement.unlisted,
        cases: casesOf(id, spec, [...agileIds, ...folderIds]),
      });
    }
  }
  // A leaf whose id the platform cannot serve, and a document filed in a second folder too (the first place counts).
  const project = `030：${names[0]}/${names[1]}测试项目`;
  const badId = 'bad id';
  file('second', [project, '061：10.6.4', '003：10.6.4-R1-2026/11', '健康检查'], { label: '无法读取的文档', id: badId, cases: [], children: [] });
  const repeated = truth.find((t) => t.line === '10.6.4')?.id as string;
  file('second', [project, '061：10.6.4', '004：10.6.4-R2-2027/2', '日志'], { label: '重复挂载的文档', id: repeated, cases: [], children: [] });
  const findLabel = (nodes: AgileNode[], label: string): AgileNode | null => {
    for (const node of nodes) {
      if (node.label === label) return node;
      const below = findLabel(node.children, label);
      if (below !== null) return below;
    }
    return null;
  };
  // A release train and a module created before any document. Nothing lists them, so they are empty folders, not documents.
  const emptyFolders = ['8999', '8998'] as const;
  const lineFolder = findLabel(trees[ROOT_IDS.second], '061：10.6.4');
  const trainFolder = findLabel(trees[ROOT_IDS.second], '003：10.6.4-R1-2026/11');
  if (lineFolder === null || trainFolder === null) throw new Error('the corpus is missing the 10.6.4 folders');
  lineFolder.children.push({ label: '005：10.6.4-R3-2027/5', id: emptyFolders[0], cases: [], children: [] });
  trainFolder.children.push({ label: 'SSL', id: emptyFolders[1], cases: [], children: [] });
  for (const key of ['first', 'second', 'other'] as const) {
    const id = ROOT_IDS[key];
    trees[id] = [{ label: titleOf[key], id, cases: rootDocs[id], children: trees[id] }];
  }
  return { names, listing, roots: [ROOT_IDS.first, ROOT_IDS.second, ROOT_IDS.other], trees, documents, truth, badId, repeated, emptyFolders };
}

/** The UTF-8 bytes of a document as a KityMinder export. */
export function documentBytes(document: KmDocument): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(document));
}

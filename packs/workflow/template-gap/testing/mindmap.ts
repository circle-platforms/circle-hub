// Synthetic test mind maps for the template-gap tests (not part of the pack). Invented content in the structure of the team's
// documents: a root, groups with priority 1, cases with a tag list and priority 2, expected results as leaves, steps,
// priority-3 preconditions, an untagged node written like a case, a tagged group node holding cases, a nested case and a case
// without priority; tags in several spellings. Every case declares the test types its tags name and the other template
// categories its own texts are written to show, and every group the categories its name shows to the cases below it: the
// gold the tests compare with, written down independently of the pack's matching. Every category of the base document is
// shown by cases of at least two test types and never only together with another category, so removing every case of one
// category leaves every other category shown. Pure and deterministic.

export const TEST_TYPES = ['functional', 'configuration', 'integration', 'compatibility', 'negative', 'stress'] as const;
export type TestType = (typeof TEST_TYPES)[number];

export interface CaseSpec {
  kind: 'case';
  id: string;
  created: number;
  title: string;
  /** Tags as written in the document. */
  tags: string[];
  /** The test types the tags name (gold). */
  types: TestType[];
  /** Other template categories the case's own texts show (gold). */
  shows: string[];
  /** Default 2; null writes no priority. */
  priority?: number | null;
  children: NodeSpec[];
}

export interface GroupSpec {
  kind: 'group';
  id: string;
  created: number;
  text: string;
  /** A tag on a group node that holds cases: the node stays a group (and becomes a case once it holds none). */
  tags?: string[];
  /** Template categories the group's name shows to every case below it (gold). */
  shows: string[];
  children: NodeSpec[];
}

/** Any other node: an expected result (leaf), a step (with children), a precondition (priority 3), an untagged case-like node. */
export interface PlainSpec {
  kind: 'node';
  id: string;
  created: number;
  text: string;
  priority?: number;
  /** Written like a case without tags: the pack counts it as untagged (gold). */
  untagged?: boolean;
  children: NodeSpec[];
}

export type NodeSpec = CaseSpec | GroupSpec | PlainSpec;

export interface DocumentSpec {
  rootId: string;
  title: string;
  children: NodeSpec[];
}

type KmNode = { data: Record<string, unknown>; children: KmNode[] };
export type KmDocument = { root: KmNode; template: string; theme: string; version: string };

/** mulberry32: a small deterministic generator. */
export function generator(seed: number): () => number {
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
const CREATED_BASE = Date.UTC(2026, 6, 1, 2, 0, 0);

/** 12 lowercase base-36 characters, as the real documents' node ids. */
export function idMaker(seed: number): () => string {
  const next = generator(seed);
  const used = new Set<string>();
  return () => {
    for (;;) {
      let id = '';
      for (let i = 0; i < 12; i++) id += ALPHABET[Math.floor(next() * 36)];
      if (!used.has(id)) {
        used.add(id);
        return id;
      }
    }
  };
}

class Builder {
  readonly #id: () => string;
  #counter = 0;
  constructor(seed: number) {
    this.#id = idMaker(seed);
  }
  #stamp(): { id: string; created: number } {
    return { id: this.#id(), created: CREATED_BASE + this.#counter++ * 61_000 };
  }
  node(text: string, options: { priority?: number; untagged?: boolean } = {}, ...children: NodeSpec[]): PlainSpec {
    return { kind: 'node', ...this.#stamp(), text, ...options, children };
  }
  expected(text: string): PlainSpec {
    return this.node(text);
  }
  step(text: string, ...expected: string[]): PlainSpec {
    return this.node(text, {}, ...expected.map((e) => this.expected(e)));
  }
  precondition(text: string): PlainSpec {
    return this.node(text, { priority: 3 });
  }
  case(title: string, tags: string[], types: TestType[], shows: string[], ...children: Array<NodeSpec | string>): CaseSpec {
    return { kind: 'case', ...this.#stamp(), title, tags, types, shows, children: children.map((c) => (typeof c === 'string' ? this.expected(c) : c)) };
  }
  group(text: string, shows: string[], ...children: NodeSpec[]): GroupSpec {
    return { kind: 'group', ...this.#stamp(), text, shows, children };
  }
}

/**
 * The base document: about 150 nodes; every template category shown by at least one case, every test type by several cases
 * written in different tag spellings, one case with two test types.
 */
export function baseDocument(rootId = 'r0base000001', title = '小部件探测测试用例'): DocumentSpec {
  const b = new Builder(20261022);
  const F: TestType[] = ['functional'];
  const C: TestType[] = ['configuration'];
  const I: TestType[] = ['integration'];
  const P: TestType[] = ['compatibility'];
  const N: TestType[] = ['negative'];
  const S: TestType[] = ['stress'];
  const basic = b.group(
    '基本功能',
    [],
    b.case('设置探测间隔为 5 秒', ['Function'], F, [], '探测间隔生效'),
    b.case('设置重试次数为 3', ['功能'], F, [], '重试次数生效', '超过次数后判定失败'),
    b.case('探测类型选择 http', ['Functional'], F, [], b.precondition('已有探测对象 pool1'), b.step('选择 http 类型', '按 http 探测')),
    b.case('widget pool add pool2', ['[Function]'], F, ['command_add'], 'pool2 出现在列表中'),
    b.case('show pool pool2', ['function'], F, ['command_query'], '列出 pool2 的成员'),
    b.case('探测间隔设为 10 秒', ['Function'], F, [], b.precondition('先删除旧的探测对象'), '间隔为 10 秒'),
    b.case('探测结果计数', ['Function'], F, [], '成功次数加一', '失败次数不变'),
    b.node('探测超时默认重试', { priority: 2, untagged: true }, b.expected('超时被记录')),
  );
  const values = b.group(
    '参数取值',
    [],
    b.case('探测间隔取最小值 1', ['Configuration'], C, [], '间隔为 1 秒'),
    b.case('探测间隔取最大值 60', ['configuration'], C, [], '间隔为 60 秒'),
    b.case('重试次数取默认值', ['配置'], C, [], '重试次数为 3'),
    b.case('修改探测端口为 8080', ['Configure'], C, ['command_modify'], '端口为 8080'),
    b.case('删除探测对象 pool3', ['[configuration]'], C, ['command_delete'], 'pool3 不在列表中'),
    b.case('探测对象的端口', ['Configuration'], C, ['command_delete', 'command_add'], b.step('删除 pool6 后再添加', 'pool6 重新出现')),
  );
  const linked = b.group(
    '联动',
    [],
    b.case('探测失败后切换到备用节点', ['Integration'], I, [], '流量走备用节点'),
    b.case('与告警模块联动', ['集成'], I, [], '收到告警'),
    b.case('节点恢复后流量回切', ['integration'], I, [], b.step('恢复主节点', '流量回到主节点')),
    b.case('探测结果上报', ['Integration'], I, ['command_query'], '监控页面显示探测结果'),
    b.case('告警恢复通知', ['Integration'], I, [], '收到恢复通知', '告警消失'),
    { ...b.group('联动场景', [], b.case('双机同时探测', ['Integration'], I, [], '两台都探测'), b.case('联动压力 100 次', ['Stress'], S, [], '联动正常')), tags: ['Function'] },
  );
  const versions = b.group(
    '版本兼容',
    [],
    b.case('老版本->新版本 升级后探测配置保留', ['Compatibility'], P, ['upgrade_old_to_new'], '探测配置不变'),
    b.case('新版本 → 新版本 升级', ['兼容'], P, ['upgrade_new_to_new'], '升级成功'),
    b.case('降级到老版本后探测仍然生效', ['compatibility'], P, ['upgrade_new_to_old'], '探测生效'),
  );
  const invalid = b.group(
    '异常输入',
    [],
    b.case('探测间隔取 61', ['Negative'], N, [], '提示超出范围'),
    b.case('探测间隔取 0', ['negative'], N, [], '提示超出范围'),
    b.case('探测类型写错', ['负向'], N, [], '提示类型不对'),
    b.case('端口取 70000', ['[Negative]', 'Configuration'], ['negative', 'configuration'], [], '提示端口超出范围'),
    b.case('探测类型为空', ['Negative'], N, [], '提示类型不能为空', '设置没有变化'),
    b.case('探测对象名称超长', ['negative'], N, [], '提示名称过长', '设置没有变化'),
    b.case('端口边界', ['Negative'], N, [], '提示端口超出范围', b.case('端口取 -1', ['Negative'], N, [], '提示超出范围')),
  );
  const load = b.group(
    '压力',
    [],
    b.case('1000 个探测对象同时探测', ['Stress'], S, [], '全部正常探测'),
    b.case('探测间隔 1 秒持续 24 小时', ['压力'], S, [], '进程内存稳定'),
    b.case('反复启停探测 500 次', ['stress'], S, [], '没有残留进程'),
    b.case('探测对象反复上下线', ['Stress'], S, [], b.step('每秒上下线一次，持续 1 小时', '状态切换正确')),
  );
  const commands = b.group(
    '命令',
    [],
    b.case('no widget probe pool2', ['Function'], F, ['no_command'], 'pool2 不再探测'),
    b.case('clear widget counters', ['Function'], F, ['clear_command'], '计数归零'),
    b.case('widget probe rename pool2 pool4', ['Configuration'], C, ['command_modify'], '名称为 pool4'),
    b.case('查看探测统计', ['Function'], F, ['command_query'], '统计正确'),
    b.group('no', ['no_command'], b.case('取消 pool5 的探测', ['Function'], F, [], 'pool5 不再探测')),
  );
  const records = b.group(
    '操作日志与审计',
    ['operation_log', 'audit_log'],
    b.case('设置探测间隔后检查记录', ['Function'], F, [], '记录里有这次设置'),
    b.case('非管理员设置探测被拒绝', ['Negative'], N, [], '拒绝并留下记录'),
  );
  const settings = b.group(
    '配置管理',
    [],
    b.case('主备之间配置同步', ['Integration'], I, ['configuration_sync'], '备机配置相同'),
    b.case('保存配置后重启', ['Function'], F, ['configuration_save'], '重启后探测设置还在'),
    b.case('恢复配置文件', ['Function'], F, ['configuration_restore'], '探测设置恢复'),
    b.case('清除配置后探测停止', ['Function'], F, ['configuration_clear'], '探测全部停止'),
  );
  const other = b.group(
    '其他',
    [],
    b.case('伪造探测应答的攻击', ['Negative'], N, ['security'], '不受影响'),
    b.case('探测记录写入数据库', ['Function'], F, ['database'], '记录写入成功'),
    b.case('最大配置下 show 探测列表', ['Stress'], S, ['show_at_maximum', 'command_query'], '列表完整'),
    { ...b.case('探测对象名称含中文', ['Function'], F, [], '名称正确'), priority: null },
  );
  const intervals = b.group('间隔取值', [], ...[2, 3, 4, 5, 6, 7, 8, 9].map((n) => b.case(`探测间隔取 ${n} 秒`, ['Configuration'], C, [], `间隔为 ${n} 秒`, `按 ${n} 秒发出探测`)));
  // Second witnesses, built last so that the ids above stay as they are: with them every category other than the test types
  // is shown by cases of two test types at least, and none is shown only by cases that also show another such category.
  const extra = b.group(
    '补充',
    [],
    b.case('满配时添加探测对象', ['Function'], F, ['show_at_maximum', 'command_add'], '添加成功'),
    b.case('删除不存在的探测对象', ['Negative'], N, ['command_delete'], '提示对象不存在'),
    b.case('反复修改探测间隔 100 次', ['Stress'], S, ['command_modify'], '间隔正确'),
    b.case('no widget probe pool9', ['Negative'], N, ['no_command'], '提示对象不存在'),
    b.case('反复 clear widget counters 1000 次', ['Stress'], S, ['clear_command'], '计数正确'),
    b.case('检查操作日志里的探测设置', ['Function'], F, ['operation_log'], '有这次设置'),
    b.case('审计记录包含探测设置', ['Configuration'], C, ['audit_log'], '记录正确'),
    b.case('配置同步时断开链路', ['Negative'], N, ['configuration_sync'], '恢复后同步完成'),
    b.case('保存配置后主备切换', ['Integration'], I, ['configuration_save'], '备机配置相同'),
    b.case('恢复配置后与备机联动', ['Integration'], I, ['configuration_restore'], '联动正常'),
    b.case('清除配置时输入错误的确认', ['Negative'], N, ['configuration_clear'], '提示确认错误'),
    b.case('新版本之间升级后配置保留', ['Configuration'], C, ['upgrade_new_to_new'], '配置不变'),
    b.case('老->新 升级时并发 100 个探测', ['Stress'], S, ['upgrade_old_to_new'], '探测正常'),
    b.case('降级到旧版本时配置丢失的提示', ['Negative'], N, ['upgrade_new_to_old'], '提示配置会丢失'),
    b.case('探测报文的安全加固', ['Configuration'], C, ['security'], '加固生效'),
    b.case('数据库不可用时探测', ['Negative'], N, ['database'], '探测照常'),
  );
  return { rootId, title, children: [basic, values, linked, versions, invalid, load, commands, records, settings, other, intervals, extra] };
}

/** A case written to show one template category and nothing else besides its test type: what the "add one case" step adds. */
export function witnessCase(category: string, seed = 7): CaseSpec {
  const b = new Builder(seed);
  const titles: Record<string, [string, string[], TestType[]]> = {
    functional: ['探测间隔设为 7 秒', ['Function'], ['functional']],
    configuration: ['探测超时设为 3 秒', ['Configuration'], ['configuration']],
    integration: ['与上报模块联动', ['Integration'], ['integration']],
    compatibility: ['跨版本探测设置保留', ['Compatibility'], ['compatibility']],
    negative: ['探测超时取 -5', ['Negative'], ['negative']],
    stress: ['并发 200 个探测对象', ['Stress'], ['stress']],
    command_add: ['widget pool add pool9', ['Function'], ['functional']],
    command_delete: ['widget pool delete pool9', ['Function'], ['functional']],
    command_modify: ['widget pool edit pool9', ['Function'], ['functional']],
    command_query: ['query widget pool9', ['Function'], ['functional']],
    show_at_maximum: ['满配时的探测列表', ['Function'], ['functional']],
    no_command: ['no widget pool9', ['Function'], ['functional']],
    clear_command: ['clear widget pool9', ['Function'], ['functional']],
    operation_log: ['检查操作日志', ['Function'], ['functional']],
    audit_log: ['检查审计日志', ['Function'], ['functional']],
    configuration_sync: ['同步配置到备机', ['Function'], ['functional']],
    configuration_save: ['配置保存到闪存', ['Function'], ['functional']],
    configuration_restore: ['配置恢复到上一份', ['Function'], ['functional']],
    configuration_clear: ['恢复出厂后探测停止', ['Function'], ['functional']],
    upgrade_new_to_new: ['新版本之间升级', ['Compatibility'], ['compatibility']],
    upgrade_old_to_new: ['低版本升级到高版本', ['Compatibility'], ['compatibility']],
    upgrade_new_to_old: ['downgrade 后探测生效', ['Compatibility'], ['compatibility']],
    security: ['探测报文的漏洞', ['Negative'], ['negative']],
    database: ['数据表里的探测记录', ['Function'], ['functional']],
  };
  const entry = titles[category];
  if (entry === undefined) throw new Error(`no witness case for ${category}`);
  const [title, tags, types] = entry;
  const shows = (TEST_TYPES as readonly string[]).includes(category) ? [] : [category];
  return b.case(title, tags, types, shows, '符合预期');
}

// ---------------------------------------------------------------- transformations

const mapChildren = (children: NodeSpec[], fn: (children: NodeSpec[]) => NodeSpec[]): NodeSpec[] =>
  fn(children).map((child) => ({ ...child, children: mapChildren(child.children, fn) }) as NodeSpec);

/** Every case with the categories it shows (its types, its own and inherited group shows), in document order. */
export function casesWithCategories(doc: DocumentSpec): Array<{ spec: CaseSpec; categories: Set<string> }> {
  const out: Array<{ spec: CaseSpec; categories: Set<string> }> = [];
  const visit = (nodes: NodeSpec[], inherited: string[]): void => {
    for (const node of nodes) {
      if (node.kind === 'case') {
        out.push({ spec: node, categories: new Set([...node.types, ...node.shows, ...inherited]) });
        visit(node.children, inherited);
      } else if (node.kind === 'group') visit(node.children, [...inherited, ...node.shows]);
      else visit(node.children, inherited);
    }
  };
  visit(doc.children, []);
  return out;
}

/** The document without the cases (and their subtrees) for which `drop` is true. */
export function withoutCases(doc: DocumentSpec, drop: (spec: CaseSpec, categories: Set<string>) => boolean): DocumentSpec {
  const dropped = new Set(casesWithCategories(doc).filter((c) => drop(c.spec, c.categories)).map((c) => c.spec.id));
  return { ...doc, children: mapChildren(doc.children, (children) => children.filter((child) => !(child.kind === 'case' && dropped.has(child.id)))) };
}

/** The document without every case that shows `category`. */
export function withoutCategory(doc: DocumentSpec, category: string): DocumentSpec {
  return withoutCases(doc, (_spec, categories) => categories.has(category));
}

/** The document with `spec` appended to the top-level group whose text is `group`. */
export function withCase(doc: DocumentSpec, group: string, spec: CaseSpec): DocumentSpec {
  let found = false;
  const children = doc.children.map((child) => {
    if (child.kind !== 'group' || child.text !== group) return child;
    found = true;
    return { ...child, children: [...child.children, spec] };
  });
  if (!found) throw new Error(`no top-level group ${group}`);
  return { ...doc, children };
}

/** Every children list permuted (Fisher-Yates with a seeded generator): the cases in another order, nothing else changed. */
export function shuffled(doc: DocumentSpec, seed: number): DocumentSpec {
  const next = generator(seed);
  const permute = (children: NodeSpec[]): NodeSpec[] => {
    const out = [...children];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(next() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  };
  return { ...doc, children: mapChildren(doc.children, permute) };
}

/** Another document with the same content: its own root id and title. */
export function renamed(doc: DocumentSpec, rootId: string, title = doc.title): DocumentSpec {
  return { ...doc, rootId, title };
}

// ---------------------------------------------------------------- rendering and gold

/** The KityMinder document (key order id, created, text, ... as the real documents write it). */
export function render(doc: DocumentSpec): KmDocument {
  const ids = new Set<string>([doc.rootId]);
  const declared = new Map(casesWithCategories(doc).map(c => [c.spec.id, [...c.categories]]));
  const toNode = (spec: NodeSpec): KmNode => {
    if (ids.has(spec.id)) throw new Error(`node id ${spec.id} is used twice in the synthetic document`);
    ids.add(spec.id);
    const data: Record<string, unknown> = { id: spec.id, created: spec.created };
    if (spec.kind === 'case') {
      data.text = spec.title;
      if (spec.priority !== null) data.priority = spec.priority ?? 2;
      data.resource = spec.tags;
      data.category_ids = declared.get(spec.id);
    } else if (spec.kind === 'group') {
      data.text = spec.text;
      data.priority = 1;
      if (spec.tags !== undefined) data.resource = spec.tags;
    } else {
      data.text = spec.text;
      if (spec.priority !== undefined) data.priority = spec.priority;
      // This synthetic marked case explicitly declares its category independently of its free text or test-type tags.
      if (spec.untagged) data.category_ids = ['functional'];
    }
    return { data, children: spec.children.map(toNode) };
  };
  return { root: { data: { id: doc.rootId, created: CREATED_BASE - 86_400_000, text: doc.title }, children: doc.children.map(toNode) }, template: 'right', theme: 'classic', version: '1.4.43' };
}

export function bytesOf(doc: DocumentSpec): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(render(doc)));
}

export function nodeCount(doc: DocumentSpec): number {
  const count = (nodes: NodeSpec[]): number => nodes.reduce((sum, node) => sum + 1 + count(node.children), 0);
  return 1 + count(doc.children);
}

export interface Gold {
  caseCount: number;
  untagged: number;
  /** Category id -> sorted ids of the cases that show it. */
  byCategory: Map<string, string[]>;
}

/** What the document is written to show, from the declarations alone. */
export function goldOf(doc: DocumentSpec, documentId: string, options: { caseRule?: 'tagged' | 'marked' } = {}): Gold {
  const rule = options.caseRule ?? 'marked';
  const cases = casesWithCategories(doc);
  const byCategory = new Map<string, string[]>();
  for (const { spec, categories } of cases) {
    for (const category of categories) byCategory.set(category, [...(byCategory.get(category) ?? []), `${documentId}:${spec.id}`]);
  }
  for (const list of byCategory.values()) list.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  let untagged = 0;
  const visit = (nodes: NodeSpec[]): void => {
    for (const node of nodes) {
      if (node.kind === 'node' && node.untagged === true) { untagged += 1; if (rule === 'marked') byCategory.set('functional', [...(byCategory.get('functional') ?? []), `${documentId}:${node.id}`].sort()); }
      if (node.kind === 'group' && node.tags !== undefined && !node.children.some((child) => child.kind === 'case')) {
        throw new Error(`the tagged group ${node.text} holds no case: the synthetic gold does not model it becoming a case`);
      }
      visit(node.children);
    }
  };
  visit(doc.children);
  const caseCount = rule === 'marked' ? cases.length + untagged : cases.length;
  const reportedUntagged = rule === 'marked' ? 0 : untagged;
  return { caseCount, untagged: reportedUntagged, byCategory };
}

/** A document without any case: an outline whose nodes carry no tags (groups and plain nodes only). */
export function outlineDocument(rootId = 'r0outline001'): DocumentSpec {
  const b = new Builder(99);
  return {
    rootId,
    title: '小部件探测设计提纲',
    children: [b.group('背景', [], b.node('探测的用途'), b.node('探测的对象')), b.group('写法', [], b.node('探测间隔怎么取', { priority: 2, untagged: true }, b.node('按秒计')))],
  };
}

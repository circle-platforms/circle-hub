// Synthetic KityMinder test mind maps: invented content in the structure of the team's real documents (case nodes with a
// non-empty resource tag list and priority 2; untagged cases with priority 2, children and often a degree; expected results
// as children; steps, priority-3 preconditions and priority-20 steps; group nodes with priority 1 and no tags, sometimes a
// tag on a group node that holds cases; inconsistent tag spellings; ids of 12 base-36 characters). Pure and deterministic:
// write.ts turns these into the JSON files next to it. Product, commands and addresses are invented (192.0.2.0/24,
// 2001:db8::/32); the commands come from the synthetic command tree of hub/refs/fixtures.

export type NodeData = { [key: string]: unknown };
export type KmNode = { data: NodeData; children: KmNode[] };
export type KmDocument = { root: KmNode; template: string; theme: string; version: string };

type Options = {
  /** priority; null writes `priority: null`; leave out for none. */
  p?: number | null;
  /** degree; a string writes the string (real documents have "null"). */
  d?: number | string | null;
  /** resource tags. */
  r?: string[];
  autoid?: string;
  auto?: string;
  note?: string | null;
  /** Forces data.id (to build duplicates). */
  id?: string;
  expand?: 'expand' | 'collapse';
  layout?: null;
};

type Spec = { text: string; options: Options; children: Spec[] };

const n = (text: string, options: Options = {}, ...children: Spec[]): Spec => ({ text, options, children });
/** A case with its expected results (leaves). */
const c = (text: string, options: Options, ...expected: Array<string | Spec>): Spec => n(text, options, ...expected.map((e) => (typeof e === 'string' ? n(e) : e)));

/** mulberry32: a small deterministic generator for ids. */
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
const CREATED_BASE = Date.UTC(2026, 0, 5, 1, 30, 0);

function build(spec: Spec, seed: number): KmDocument {
  const next = generator(seed);
  const used = new Set<string>();
  const freshId = (): string => {
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
  const toNode = (s: Spec): KmNode => {
    const data: NodeData = { id: s.options.id ?? freshId(), created: CREATED_BASE + counter++ * 61_000, text: s.text };
    const o = s.options;
    if (o.expand !== undefined) data.expandState = o.expand;
    if (o.layout !== undefined) data.layout = o.layout;
    if (o.p !== undefined) data.priority = o.p;
    if (o.d !== undefined) data.degree = o.d;
    if (o.r !== undefined) data.resource = o.r;
    if (o.autoid !== undefined) data.autoid = o.autoid;
    if (o.auto !== undefined) data.auto = o.auto;
    if (o.note !== undefined) data.note = o.note;
    return { data, children: s.children.map(toNode) };
  };
  return { root: toNode(spec), template: 'right', theme: 'classic', version: '1.4.43' };
}

// The review document (about 150 nodes) ---------------------------------------------------------------------------------

/** Ids used twice on purpose: two copied cases share one id. */
export const DUPLICATED_ID = 'k3d9q0xw7m2a';

/**
 * A feature test map with what a reviewer has to find: group nodes, cases in the simple form and with steps and
 * preconditions, negative cases (out of range and wrong type), a case without and one with two expected results, a vague
 * expected result, a copied expected result that contradicts its case, a CLI branch case written for WebUI and a WebUI case
 * with CLI wording, repeated titles under different paths, an exact duplicate among siblings and a reused title whose
 * variants differ in their steps, a nested case, a tag on a group node that holds cases, untagged cases in the simple and
 * the precondition-and-step form (one automated), inconsistent tag spellings, release-specific tags, a priority 20 typo on
 * a case (injected) and priority 20 on a step (as in real documents), a missing priority, degree "null", a group with
 * priority null, automated cases (autoid, auto YES), notes, and two cases sharing one id.
 */
export function reviewDocument(): KmDocument {
  const ipv4 = n(
    'IPv4',
    { expand: 'expand' },
    c('widget health interval pool1 5', { p: 2, d: 1, r: ['Configuration'] }, 'show health 显示 pool1 的探测间隔为 5 秒'),
    c('widget health retries pool1 3', { p: 2, d: 1, r: ['configuration'] }, 'show health 显示 pool1 的重试次数为 3'),
    c('widget health probe pool1 http', { p: 2, d: 1, r: ['[Configuration]'] }, 'show health 显示 pool1 的探测类型为 http'),
    c('widget health probe pool1 tcp', { p: 2, d: 1, r: ['Configure'] }, 'show health 显示 pool1 的探测类型为 http'),
    c('widget health interval pool1 61', { p: 2, d: 2, r: ['Negative'] }, '提示参数超出范围 1-60，探测间隔保持不变'),
    c('widget health retries pool1 0', { p: 2, d: 2, r: ['negative'] }, '提示参数超出范围 1-10'),
    c('使用webui方式配置探测类型为 tcp', { p: 2, d: 1, r: ['配置'] }, 'WebUI 健康检查页面显示探测类型为 tcp'),
    n('修改探测间隔后立即生效', { p: 2, d: 1, r: ['Function'] }, n('已配置 pool1，探测间隔为 10 秒', { p: 3 }), n('widget health interval pool1 2', {}, n('2 秒后按新间隔发出探测'))),
  );
  const ipv6 = n(
    'IPv6',
    { expand: 'expand' },
    c('widget health interval pool1 5', { p: 2, d: 1, r: ['Configuration'] }, 'show health 显示 pool1 的探测间隔为 5 秒'),
    c('widget health retries pool1 3', { p: 2, d: 1, r: ['Configuration'] }, 'show health 显示 pool1 的重试次数为 3'),
    c('widget health probe pool1 http', { p: 2, d: 1, r: ['Configuration'] }, 'show health 显示 pool1 的探测类型为 http'),
    c('widget health interval pool1 61', { p: 2, d: 2, r: ['Negative'] }, '提示参数超出范围 1-60，探测间隔保持不变'),
    c('relay endpoint add 2001:db8::21 80', { p: 2, d: 1, r: ['Configuration'] }, 'show endpoints 显示 2001:db8::21 端口 80'),
  );
  const webui = n(
    'WebUI',
    { p: 1, note: null },
    c('使用WebUI配置探测间隔为 5 秒', { p: 2, d: 1, r: ['Configuration'] }, 'WebUI 健康检查页面显示间隔 5 秒'),
    c('使用WebUI配置重试次数为 3', { p: 2, d: 1, r: ['Configuration'] }, 'WebUI 健康检查页面显示重试次数 3'),
    c('使用WebUI配置探测类型为 tcp', { p: 2, d: 1, r: ['Configuration'] }, 'WebUI 健康检查页面显示探测类型为 tcp'),
    c('WebUI 输入间隔 0 时提示错误', { p: 2, d: 2, r: ['[Negative]'] }, '页面提示取值范围 1-60，无法保存'),
    c('使用WebUI删除健康检查配置', { p: 2, d: 1, r: ['configuration'] }, 'show health 不再显示 pool1'),
  );
  const probe = n(
    '探测结果',
    { p: 1 },
    c('后端 HTTP 返回 200 时判定为健康', { p: 2, d: 1, r: ['Functional'] }, 'show health 显示后端状态为 up'),
    c('后端 HTTP 返回 500 时判定为不健康', { p: 2, d: 1, r: ['[Functional]'] }, 'show health 显示后端状态为 down'),
    c('连续失败达到重试次数后摘除后端', { p: 2, d: 1, r: ['Function'] }, '后端状态变为 down', '新连接不再转发到该后端'),
    c('后端恢复后重新加入调度', { p: 2, d: 1, r: ['function'] }),
    c('探测间隔为 1 秒时每秒探测一次', { p: 2, d: 1, r: ['[Functional'], autoid: '730000000000000101', auto: 'YES' }, '抓包看到每秒一次探测请求'),
    n('探测超时时间内无响应判定失败', { p: 1, d: 1, r: ['功能'] }, n('1.配置后端不响应\n2.等待一个探测周期', {}, n('本次探测记为失败'))),
    c('show health 显示所有池的状态', { p: 2, d: 1, r: ['Functional'] }, '每个池一行，含状态和最近一次探测时间'),
    c('show health 显示所有池的状态', { p: 2, d: 1, r: ['Functional'] }, '每个池一行，含状态和最近一次探测时间'),
    c('show health pool1 显示单个池的状态', { p: 2, d: 1, r: ['Functional'] }, '显示内容正确'),
    c('探测请求携带配置的 Host 头', { p: 2, d: 1, r: ['Functional'], note: '需要抓包确认 Host 头的取值' }, '抓包看到 Host 头为配置的取值'),
    c('http 探测路径可配置', { p: 2, d: 1, r: ['Functional'], id: DUPLICATED_ID, autoid: '730000000000000102', auto: 'YES' }, '按配置的路径发出探测'),
    c('http 探测路径可配置为根路径', { p: 2, d: 'null', r: ['Functional'], id: DUPLICATED_ID }, '按根路径发出探测'),
  );
  const weights = n(
    '权重联动',
    { p: 1 },
    c('relay endpoint weight 192.0.2.21 50 后按权重分配', { p: 2, d: 1, r: ['Integration'] }, '两台后端收到的请求数之比与权重一致'),
    c('relay endpoint weight 192.0.2.21 101', { p: 2, d: 2, r: ['Negative'] }, '提示参数超出范围 1-100'),
    c('健康检查摘除后端后按剩余后端的权重分配', { p: 2, d: 1, r: ['Integration', '20260301ADD'] }, '流量只分配到健康的后端'),
    n('后端全部不健康', { p: 2, d: 1, r: ['Function'] }, n('新连接返回 503'), c('恢复一台后端后', { p: 2, d: 1, r: ['Function'] }, '流量全部转发到恢复的后端')),
    c('relay endpoint weight 192.0.2.22 abc', { p: 2, d: 2, r: ['negative'] }, '提示参数类型错误'),
  );
  const logs = n(
    '日志',
    { p: 1 },
    c('修改健康检查配置写入操作日志', { p: 2, d: 1, r: ['Function'] }, '操作日志里有修改前后的取值'),
    c('relay log level debug 后记录每次探测', { p: 2, d: 1, r: ['Configuration', 'R2ADD'] }, '日志里每次探测一行，含后端地址和结果'),
    c('后端状态变化写入审计日志', { p: 2, d: 1, r: ['Function'] }, '审计日志记录状态变化和时间'),
  );
  const errors = n(
    '异常处理',
    { p: 1 },
    n('后端端口不可达时探测超时', { p: 2, d: 2, r: ['Negative'] }, n('无', { p: 3 }), n('1.relay endpoint add 192.0.2.23 81\n2.后端不监听 81 端口', {}, n('探测失败，后端状态为 down'))),
    c('探测类型输入 udp 被拒绝', { p: 2, d: 3, r: ['负向'] }, '提示探测类型只能是 tcp 或 http'),
    c('删除不存在的池', { p: 3, d: 2, r: ['negative'] }, 'widget pool delete pool9 提示池不存在'),
    c('池名称超过 32 个字符', { p: 2, d: 2, r: ['Negative'] }, 'widget pool add 名称超过 32 个字符时提示名称过长'),
    n('删除池后健康检查配置一并删除', { p: 2, d: 1, r: ['Function'] }, n('1.widget pool delete pool1\n2.show health', { p: 20 }, n('不再显示 pool1 的健康检查配置'))),
  );
  // A short title reused for variants that differ in their steps: not duplicates.
  const endpoints = n(
    '端点操作',
    { p: 1 },
    n('添加 - 端点', { p: 2, d: 1, r: ['Function'] }, n('relay endpoint add 192.0.2.31 80', {}, n('show endpoints 显示 192.0.2.31 端口 80'))),
    n('添加 - 端点', { p: 2, d: 1, r: ['Function'] }, n('relay endpoint add 192.0.2.32 8080', {}, n('show endpoints 显示 192.0.2.32 端口 8080'))),
  );
  // A tag on a group node that holds cases: the node is a group, its cases are not nested.
  const persistence = n(
    '会话保持',
    { p: 1, r: ['Function'] },
    c('开启会话保持后同一客户端落到同一后端', { p: 2, d: 1, r: ['Function'] }, '同一客户端的连接都转发到同一台后端'),
    c('会话保持超时后重新调度', { p: 2, d: 2, r: ['Function'] }, '超时后的新连接按权重重新选择后端'),
  );
  // Cases without tags, as about half of the real cases are written: priority 2, children, a degree.
  const untagged = n(
    '端点批量操作',
    { p: 1 },
    n('relay endpoint add 192.0.2.41 80 后 show endpoints', { p: 2, d: 1 }, n('show endpoints 显示 192.0.2.41 端口 80')),
    n('删除端点后会话迁移到其他端点', { p: 2, d: 2 }, n('已有两个端点并建立会话', { p: 3 }), n('relay endpoint delete 192.0.2.41', {}, n('会话迁移到 192.0.2.42'))),
    n('批量添加 16 个端点', { p: 2, d: 1, autoid: '730000000000000103', auto: 'YES' }, n('show endpoints 显示 16 个端点')),
  );
  const compatibility = n(
    '兼容性',
    { p: 1 },
    n('老版本->新版本 升级后健康检查配置保留', { p: 2, d: 1, r: ['Compatibility'] }, n('老版本已配置探测间隔 10 秒、重试 3 次', { p: 3 }), n('升级到新版本后执行 show health', {}, n('配置保留，取值不变'))),
    n('新版本->老版本 降级后 http 探测改为 tcp', { p: 2, d: 3, r: ['compatibility'] }, n('新版本已配置 http 探测', { p: 3 }), n('降级到老版本后执行 show health', {}, n('探测类型显示为 tcp，设备无异常'))),
    c('新版本 → 新版本 升级过程中探测不中断', { p: 2, d: 2, r: ['Compatibility'] }, '升级过程中探测记录连续'),
  );
  const stress = n(
    '压力',
    { p: 1 },
    c('200 个池同时开启 1 秒探测', { p: 2, d: 1, r: ['Stress'] }, 'CPU 占用低于 70%，设备正常'),
    c('探测过程中反复执行 show health', { p: 2, d: 1, r: ['stress'] }, '设备正常'),
    c('压力过程中反复增删池', { p: 2, d: 1, r: ['压力'] }, '无内存泄漏，设备正常'),
  );
  const saving = n(
    '配置保存与恢复',
    { p: 1 },
    c('保存配置后重启，健康检查配置保留', { p: 2, d: 1, r: ['Configuration'] }, '重启后 show health 取值不变'),
    c('清除配置后健康检查恢复默认', { p: 2, d: 1, r: ['Configuration'] }, 'show health 显示默认间隔 5 秒和重试 3 次'),
    c('配置同步到对端设备后健康检查一致', { p: 2, d: 1, r: ['Integration'] }, '对端设备 show health 与本机一致'),
    c('恢复配置文件后健康检查生效', { p: 2, d: 1, r: ['Configuration'] }, '探测按恢复的配置执行'),
  );
  const noClear = n(
    'no 与 clear',
    { p: 1 },
    c('no widget health probe pool1', { p: 2, d: 1, r: ['Configuration'] }, '探测类型恢复默认 tcp'),
    c('widget session clear pool1 后探测不受影响', { d: 1, r: ['Function'] }, '会话清空，探测照常进行'),
  );
  return build(
    n(
      '31057-示例网关支持HTTP探活与权重联动',
      {},
      n('拓扑：客户端-网关-两台后端（192.0.2.21、192.0.2.22）', { p: 3 }),
      n('配置', { expand: 'expand' }, n('CLI', { p: 1, layout: null }, ipv4, ipv6), webui),
      n('基本功能', { p: 1 }, probe, weights, logs),
      errors,
      endpoints,
      persistence,
      untagged,
      compatibility,
      stress,
      saving,
      noClear,
      n('最大配置', { p: 1 }, c('最大配置下执行 show health', { p: 2, d: 2, r: ['Configuration'] }, '4096 个池全部显示，无卡顿')),
      n('安全', { p: 1 }, c('非管理员账号不能修改健康检查', { p: 20, d: 1, r: ['Function'] }, '提示权限不足')),
      n(
        '数据库',
        { p: 1 },
        c('健康检查状态写入数据表', { p: 2, d: 1, r: ['Function'] }, '数据表里每个后端一条记录'),
        c('数据表记录超过上限后滚动删除', { p: 2, d: 2, r: ['Function'] }, '只保留最近的记录'),
      ),
      n('待补充', { p: null, expand: 'collapse' }, n('探测报文格式（待评审）')),
    ),
    20260105,
  );
}

// Small documents -----------------------------------------------------------------------------------------------------------

export function tinyDocument(): KmDocument {
  return build(n('需求 4100-示例池管理', {}, n('基本功能', { p: 1 }, c('widget pool add pool1', { p: 2, d: 1, r: ['Functional'] }, 'show pools 显示 pool1'))), 4100);
}

/** A test map written without tags, as 11 of the 48 sampled real maps are: every case has priority 2, children and a degree. */
export function untaggedDocument(): KmDocument {
  return build(
    n(
      '回归测试-31200-示例网关端点管理',
      {},
      n(
        '配置',
        { p: 1 },
        n('relay endpoint add 192.0.2.51 80', { p: 2, d: 1 }, n('show endpoints 显示 192.0.2.51 端口 80')),
        n('relay endpoint weight 192.0.2.51 0', { p: 2, d: 2 }, n('提示参数超出范围 1-100')),
      ),
      n(
        '异常处理',
        { p: 1 },
        n('端点不可达时自动摘除', { p: 2, d: 2 }, n('无', { p: 3 }), n('1.relay endpoint add 192.0.2.52 81\n2.后端不监听 81 端口', { p: 20 }, n('端点状态为 down'))),
      ),
    ),
    31200,
  );
}

/** An outline without any tag: not a test document for the projection (no case node). */
export function outlineDocument(): KmDocument {
  return build(
    n(
      '示例网关会话功能梳理',
      {},
      n('会话建立', {}, n('启用会话保持', {}, n('同一客户端落到同一后端')), n('关闭会话保持')),
      n('会话查询', { p: 1 }, n('show sessions 显示会话数')),
      n('待确认问题', {}, n('超时取值上限')),
    ),
    77,
  );
}

/**
 * A template map in the structure of the team template (categories as groups, placeholder cases with tags, upgrade cases
 * with a precondition and a step). Author-written; every category of tables/template-v3.json is shown by some case.
 */
export function templateDocument(): KmDocument {
  const command = n(
    '命令 A',
    { p: 1 },
    c('添加一条配置', { p: 2, r: ['Configuration'] }, '添加成功'),
    c('删除一条配置', { p: 2, r: ['Configuration'] }, '删除成功'),
    c('修改一条配置', { p: 2, r: ['Configuration'] }, '修改成功'),
    c('查看配置', { p: 2, r: ['Configuration'] }, '显示与配置一致'),
    c('最大配置下执行 show', { p: 2, r: ['Configuration'] }, '全部显示，无卡顿'),
    c('修改配置写入操作日志', { p: 2, r: ['Functional'] }, '操作日志有记录'),
    c('修改配置写入审计日志', { p: 2, r: ['Functional'] }, '审计日志有记录'),
  );
  const upgrade = (title: string, degree: number, precondition: string, step: string, expected: string): Spec =>
    n(title, { p: 2, d: degree, r: ['Compatibility'] }, n(precondition, { p: 3 }), n(step, { d: null }, n(expected)));
  return build(
    n(
      '测试用例模板（示例）',
      {},
      n(
        'CLI 命令',
        {},
        n('增删改查', {}, command, n('no', { p: 1 }, c('用 no 命令去掉配置', { p: 2, r: ['Configuration'] }, '配置被去掉')), n('clear', { p: 1 }, c('用 clear 命令清空统计', { p: 2, r: ['Configuration'] }, '统计清零'))),
        n('配置同步', { p: 1 }, c('配置同步到对端设备', { p: 2, r: ['Integration'] }, '备机配置一致')),
        n('配置保存', { p: 1 }, c('保存配置后重启', { p: 2, r: ['Configuration'] }, '配置保留')),
        n('配置恢复', { p: 1 }, c('从文件恢复配置', { p: 2, r: ['Configuration'] }, '配置生效')),
        n('配置清除', { p: 1 }, c('清除配置后回到默认值', { p: 2, r: ['Configuration'] }, '取值为默认值')),
        n(
          '升级',
          { p: 1 },
          upgrade('新版本之间升级', 1, '新版本已用满新功能的配置', '执行升级', '升级成功，配置不丢失'),
          upgrade('旧版本升级到新版本', 2, '无', '执行升级', '升级成功，命令改动后的配置自动转换'),
          upgrade('新版本降级到旧版本', 3, '新版本已用满新功能的配置', '执行降级', '新功能的配置丢失，其他配置不受影响'),
        ),
        n('安全测试', { p: 1 }, c('非法输入不导致异常', { p: 2, r: ['Negative'] }, '提示输入非法')),
        n('数据库', { p: 1 }, c('数据表记录与配置一致', { p: 2, r: ['Configuration'] }, '字段内容与配置一致')),
      ),
      n(
        '类别 A',
        {},
        n(
          '子类别 A-1',
          { p: 1 },
          c('功能用例 1', { p: 2, r: ['Functional'] }, '结果符合规格'),
          c('反向用例 1', { p: 2, r: ['Negative'] }, '给出明确的错误提示'),
          c('压力用例 1', { p: 2, r: ['Stress'] }, '设备正常'),
        ),
      ),
      n('与功能 X 联合使用', { p: 1 }, c('功能 X 与本功能同时开启', { p: 2, r: ['Integration'] }, '两个功能都正常')),
    ),
    303,
  );
}

// The large document (about 3,000 nodes) --------------------------------------------------------------------------------

const MODULES = ['健康检查', '会话保持', '池管理', '端点', '日志', '系统', '网络', '认证', 'WebUI', '升级', '压力', '安全'];
const CHANNELS = ['CLI-IPv4', 'CLI-IPv6', 'WebUI'];
const GROUPS = ['增删改查', '参数边界', '异常', '集成'];
const TAG_SPELLINGS = [
  ['Functional', 'Function', 'function', '功能', '[Function]', '[Functional', 'Functional'],
  ['Configuration', 'configuration', '[Configuration]', '配置', 'Configure'],
  ['Integration', '[Integration]', 'Integration'],
  ['Negative', 'negative', '[Negative]', '负向'],
  ['Stress', 'stress', '[Stress]', '压力'],
  ['Compatibility', 'Compatibility'],
];
const VERBS = ['添加', '删除', '修改', '查看', '启用', '关闭', '导出', '清空', '重命名', '刷新'];

/**
 * A deterministic document of about `target` nodes with the same features as the review document, spread out. Not stored
 * as a file (it would be about 400 KB): tests build it, and compactText(largeDocument()) gives its bytes.
 */
export function largeDocument(target = 3000): KmDocument {
  const next = generator(9001);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)];
  // Nodes per case average 2.4 with the shapes below; solve the tree size for the cases per group.
  const perGroup = (((target - 1) / MODULES.length - 1) / CHANNELS.length - 1) / GROUPS.length - 1;
  const casesPerGroup = Math.max(1, Math.round(perGroup / 2.4));
  const modules = MODULES.map((module, m) =>
    n(
      `${String(m + 1).padStart(2, '0')} ${module}`,
      { p: 1 },
      ...CHANNELS.map((channel) =>
        n(
          channel,
          channel === 'WebUI' ? { p: 1 } : {},
          ...GROUPS.map((group, g) => {
            const cases: Spec[] = [];
            for (let k = 0; k < casesPerGroup; k++) {
              const negative = g === 2 || next() < 0.08;
              const category = negative ? 3 : g === 3 ? 2 : module === '压力' ? 4 : module === '升级' ? 5 : next() < 0.5 ? 0 : 1;
              const tags = [pick(TAG_SPELLINGS[category])];
              if (next() < 0.04) tags.push(next() < 0.5 ? '20260301ADD' : 'R2ADD');
              const roll = next();
              const priority = roll < 0.004 ? 2 : roll < 0.008 ? undefined : roll < 0.05 ? 1 : roll < 0.07 ? 3 : 2;
              const options: Options = { d: pick([1, 1, 2, 2, 3, null, 'null']), r: tags };
              if (priority !== undefined) options.p = priority;
              if (next() < 0.06) {
                options.autoid = `7300000000${String(m).padStart(2, '0')}${String(g).padStart(2, '0')}${String(k).padStart(4, '0')}`;
                options.auto = 'YES';
              }
              // Titles repeat across channels on purpose (same case in the IPv4 and IPv6 branches).
              const title = `${pick(VERBS)}${module}对象 ${(k % 5) + 1}${negative ? '（取值越界）' : ''}`;
              const shape = next();
              if (shape < 0.04) cases.push(c(title, options));
              else if (shape < 0.12) cases.push(c(title, options, '操作成功', 'show 命令显示与配置一致'));
              // Priority 20 sits on some steps, as in real documents.
              else if (shape < 0.3) cases.push(n(title, options, n('无', { p: 3 }), n(`1.执行${module}配置命令\n2.执行 show 查看`, (k + g) % 25 === 0 ? { p: 20 } : {}, n(negative ? '提示参数超出范围' : '显示与配置一致'))));
              else cases.push(c(title, options, negative ? '提示参数超出范围，配置不变' : '操作成功，show 显示与配置一致'));
            }
            return n(group, { p: 1 }, ...cases);
          }),
        ),
      ),
    ),
  );
  return build(n('回归测试-31100-示例网关全量回归', {}, ...modules), 31100);
}

// Encodings -------------------------------------------------------------------------------------------------------------

function asciiString(text: string): string {
  let out = '"';
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0x22) out += '\\"';
    else if (code === 0x5c) out += '\\\\';
    else if (code === 0x0a) out += '\\n';
    else if (code === 0x0d) out += '\\r';
    else if (code === 0x09) out += '\\t';
    else if (code === 0x08) out += '\\b';
    else if (code === 0x0c) out += '\\f';
    else if (code < 0x20 || code > 0x7e) out += `\\u${code.toString(16).padStart(4, '0')}`;
    else out += text[i];
  }
  return `${out}"`;
}

/** JSON the way the agile platform writes the inner document: ", " and ": " separators, non-ASCII as \u escapes. */
export function asciiJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value);
  if (typeof value === 'string') return asciiString(value);
  if (Array.isArray(value)) return `[${value.map(asciiJson).join(', ')}]`;
  return `{${Object.entries(value as object)
    .map(([key, member]) => `${asciiString(key)}: ${asciiJson(member)}`)
    .join(', ')}}`;
}

/** Plain KityMinder export. */
export function plainText(document: KmDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

/** Compact KityMinder export (for the large document). */
export function compactText(document: KmDocument): string {
  return `${JSON.stringify(document)}\n`;
}

/** The double-encoded form: one JSON string whose content is the document (what get_case_data puts in `data`). */
export function doubleEncodedText(document: KmDocument): string {
  return `${JSON.stringify(asciiJson(document))}\n`;
}

/** A get_case_data answer of the agile platform: envelope {code, msg, data} with the document double-encoded in data. */
export function agileResponseText(document: KmDocument): string {
  return `${JSON.stringify({ code: 1000, msg: '成功', data: asciiJson(document) })}\n`;
}

/** Every fixture file of this directory and its content (the large document is built, not stored). */
export function fixtureFiles(): Record<string, string> {
  const review = reviewDocument();
  return {
    'review-150.km.json': plainText(review),
    'review-150.double.json': doubleEncodedText(review),
    'review-150.agile-response.json': agileResponseText(review),
    'tiny.km.json': plainText(tinyDocument()),
    'untagged.km.json': plainText(untaggedDocument()),
    'outline.km.json': plainText(outlineDocument()),
    'template.km.json': plainText(templateDocument()),
  };
}

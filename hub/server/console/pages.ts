// The console pages (read-only): runs, one run, knowledge, task packs and admin data. Every enumeration value is shown
// through labelOf, every claim in DISPLAY_ORDER, unknown with its own symbol and colour; absent and forbidden are the same
// neutral page. The run page is the authoritative view (display rule 17): the partition list in the three groups of display
// rule 13, each item's two cells by the conjunction of hub/runs (V03 R[3]), and every submission as received, marked
// unverified, next to its receipt (display rule 3).
import { DISPLAY_ORDER } from '../../../contracts/generated/protocol.ts';
import { LAYER, PARTITION, axisLabel, isEnvironment, labelOf, type Partition } from '../../../contracts/generated/vocabulary.ts';
import type { Claim } from '../../../contracts/src/claim.ts';
import type { ProtocolError } from '../../../contracts/src/common.ts';
import type { RunRecord } from '../../../contracts/src/run.ts';
import type { ItemResult, LayerResult, RequirementResult, ValidationResult } from '../../../contracts/src/validation.ts';
import type { RunDetail } from '../../ports.ts';
import type { CallLogLine, Principal } from '../../records/api.ts';
import { UNAVAILABLE_MESSAGE } from '../../refs/api.ts';
import { itemCell } from '../../runs/api.ts';
import type { ServerDeps } from '../api.ts';
import { NOT_APPLICABLE, cellText, claimFields, coverageText, terminalKind, terminalText, type LayerTerminal } from '../claims.ts';
import { countsLine } from '../text.ts';
import { code, definitions, html, link, page, pre, section, table, type Html, type PageChrome } from './html.ts';

export interface PageContext {
  deps: ServerDeps;
  principal: Principal;
  admin: boolean;
  url: URL;
  chrome: (title: string) => PageChrome;
  /** Display name of a user id, cached for the request. */
  userName: (userId: string | null | undefined) => Promise<string>;
}

export interface PageResult {
  status: number;
  body: Html;
}

/** The neutral answer for absent and forbidden alike (D05 R[3]). */
const NEUTRAL = UNAVAILABLE_MESSAGE;

export function neutralPage(ctx: PageContext): PageResult {
  return { status: 404, body: page(ctx.chrome(NEUTRAL), html`<p>${NEUTRAL}</p>`) };
}

const param = (ctx: PageContext, name: string): string | undefined => {
  const value = ctx.url.searchParams.get(name);
  return value === null || value === '' ? undefined : value;
};

const SHA256 = /^[0-9a-f]{64}$/;
const RUN_ID = /^run_[0-9a-z]{26}$/;
const yesNo = (value: boolean): string => (value ? '是' : '否');

function errorsTable(errors: readonly ProtocolError[]): Html {
  return table(
    ['码', '说明', '修正', '位置', '条目', '要求项', '剩余修复轮数'],
    errors.map((e) => [code(e.code), e.message, e.fix ?? '', e.path === undefined ? '' : code(e.path || '（整份）'), e.item ?? '', e.requirement ?? '', e.rounds_left ?? '']),
    '没有错误',
  );
}

export function claimBlock(claim: Claim): Html {
  return html`<div class="claim">${definitions(claimFields(claim))}</div>`;
}

// ---------------------------------------------------------------- runs

export async function runsPage(ctx: PageContext): Promise<PageResult> {
  const pack = param(ctx, 'pack');
  const cursor = param(ctx, 'cursor');
  const listing = await ctx.deps.runs.listRuns(ctx.principal, { pack, limit: 50, cursor: cursor ?? null });
  const rows = [];
  for (const run of listing.items) {
    rows.push([
      link(`/console/runs/${run.run}`, run.run),
      run.pack,
      [run.product, run.version, run.build].filter(Boolean).join(' / '),
      run.started_at,
      run.runner === undefined ? labelOf('execution_host', run.host) : await ctx.userName(run.runner),
      run.items.length,
      run.session ?? '',
    ]);
  }
  const filter = html`<form class="filters" method="get" action="/console/runs"><label>任务包 <input name="pack" value="${pack ?? ''}"></label><button type="submit">筛选</button></form>`;
  const next = listing.next === null ? html`` : html`<p>${link('/console/runs', '下一页', { pack, cursor: listing.next })}</p>`;
  return {
    status: 200,
    body: page(ctx.chrome('运行'), html`${filter}${table(['运行', '任务包', '产品 / 版本 / 构建', '开始时间', '运行者', '条目', '会话'], rows, '没有运行')}${next}`),
  };
}

/** A terminal in its own colour (display rule 5: unknown is never shown as success or failure). */
function terminalHtml(layer: LayerTerminal, text: string): Html {
  return html`<span class="t-${terminalKind(layer)}">${text}</span>`;
}

/** The item's two cells (V03 R[3], display rule 4): one per layer by the conjunction of hub/runs; an undeclared layer is not applicable. */
function itemCells(requirements: readonly RequirementResult[]): Html {
  const cell = itemCell(requirements);
  return html`${LAYER.map((layer) => {
    const found = cell[layer];
    if (found === undefined) return html`<div>${labelOf('layer', layer)}：${NOT_APPLICABLE}</div>`;
    return html`<div>${terminalHtml({ layer, terminal: found.terminal } as LayerTerminal, cellText(layer, found))}</div>`;
  })}`;
}

function itemTable(items: readonly ItemResult[], names: ReadonlyMap<string, string>): Html {
  const rows: unknown[][] = [];
  for (const item of items) {
    const why = 'code' in item ? code(item.code) : 'reason' in item ? labelOf('reason', item.reason) : '';
    const head = [
      html`${code(item.item)}<br>${item.label}`,
      html`${code(item.location)}${item.carried_over ? html`<br>沿用 ${code(item.carried_over)}` : ''}`,
      why,
      itemCells(item.requirements),
    ];
    if (item.requirements.length === 0) rows.push([...head, '', '', '', '']);
    for (const [index, r] of item.requirements.entries()) {
      const layers = LAYER.map((layer) => {
        const found: LayerResult | undefined = r.layers.find((l) => l.layer === layer);
        return found === undefined ? html`${labelOf('layer', layer)}：${NOT_APPLICABLE}` : terminalHtml(found, terminalText(found));
      });
      rows.push([
        ...(index === 0 ? head : ['', '', '', '']),
        html`${r.requirement} ${names.get(r.requirement) ?? ''}`,
        html`${layers.map((text) => html`<div>${text}</div>`)}`,
        `${labelOf('requirement_status', r.status)}${r.unsatisfied_reason ? `（${labelOf('unsatisfied_reason', r.unsatisfied_reason)}）` : ''}`,
        html`${r.claims.map(claimBlock)}`,
      ]);
    }
  }
  return table(['条目', '位置', '原因', '条目终态（每层一格）', '要求项', '判定层终态', axisLabel('requirement_status'), `主张（${DISPLAY_ORDER.join('、')}）`], rows, '没有条目');
}

/**
 * Display rule 13: the run page derives three groups from the partition list: what was adopted (delivered), what is still
 * to be handled (rejected, quarantined, incomplete) and the requests for the viewer to decide (milestone 1 has none).
 */
const GROUP_OF = { delivered: 'adopted', rejected: 'open', quarantined: 'open', incomplete: 'open' } as const satisfies Record<Partition, 'adopted' | 'open'>;
const GROUP_TITLE = { adopted: '已采用的成果', open: '仍需处理的事项' } as const;

function partitionGroups(result: ValidationResult, run: RunRecord): Html {
  const names = new Map(run.requirements.map((r) => [r.key, r.name]));
  const groups: Html[] = [];
  for (const group of ['adopted', 'open'] as const) {
    const members = PARTITION.filter((p) => GROUP_OF[p] === group);
    const total = members.reduce((sum, p) => sum + result.partitions[p].length, 0);
    // Display rule 6: every partition shows its count and lists its items, an empty one included.
    const parts = members.map((p) => section(`${labelOf('partition', p)}（${result.partitions[p].length}）`, itemTable(result.partitions[p], names)));
    groups.push(section(`${GROUP_TITLE[group]}（${members.map((p) => labelOf('partition', p)).join('、')}，${total}）`, html`${parts}`));
  }
  groups.push(section('需要你决定的请求', html`<p class="empty">没有待你决定的请求</p>`));
  return html`${groups}`;
}

/** Longest submission text the run page shows; the rest stays in the record. */
const SHOWN_SUBMISSION_CHARS = 256 * 1024;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * A submission as the Hub received and stored it (display rule 3), marked unverified: the arguments of the record, or the
 * JSON text runs kept as an object when the arguments were not canonical JSON (`{received: {object, ...}}`).
 */
async function submissionContent(ctx: PageContext, digest: string, runId: string): Promise<Html> {
  const record = await ctx.deps.records.store.get(digest);
  if (record === null) return html`<p class="empty">提交记录不在</p>`;
  const body = record.body;
  let text: string;
  let note = record.integrity_note ?? '';
  const received = isObject(body) && Object.keys(body).length === 1 && isObject(body.received) ? body.received : null;
  if (received !== null && received.run === runId && typeof received.object === 'string' && SHA256.test(received.object)) {
    const bytes = await ctx.deps.records.objects.get(received.object);
    text = bytes === null ? '' : new TextDecoder().decode(bytes);
    note = [note,bytes === null ? '保存原文的对象不在' : '收到的参数不是规范 JSON，按收到的 JSON 文本保存'].filter(Boolean).join('；');
  } else {
    text = JSON.stringify(body, null, 2) ?? '';
  }
  let shown = text;
  if (text.length > SHOWN_SUBMISSION_CHARS) {
    let end = SHOWN_SUBMISSION_CHARS;
    const last = text.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end -= 1;
    shown = text.slice(0, end);
    note = [note, `只显示前 ${end} 个字符，共 ${text.length} 个，全文在记录 ${digest}`].filter(Boolean).join('；');
  }
  return html`<details class="unverified"><summary>提交内容（未经平台验证）</summary>${note ? html`<p class="notice">${note}</p>` : ''}${pre(shown)}</details>`;
}

export async function runPage(ctx: PageContext, runId: string): Promise<PageResult> {
  if (!RUN_ID.test(runId)) return neutralPage(ctx);
  const detail: RunDetail | null = await ctx.deps.runs.getRun(ctx.principal, runId);
  if (detail === null) return neutralPage(ctx);
  const run = detail.run;
  const summary = definitions([
    ['运行', code(run.run)],
    ['任务包', html`${run.pack} ${code(run.pack_digest)}`],
    ['产品 / 版本 / 构建', [run.product, run.version, run.build].filter(Boolean).join(' / ') || '—'],
    ['锁定的知识根', run.root === undefined ? '—' : link('/console/knowledge/tree', run.root, { root: run.root, path: '/' })],
    ['运行者', run.runner === undefined ? '—' : await ctx.userName(run.runner)],
    [axisLabel('execution_host'), labelOf('execution_host', run.host)],
    [axisLabel('trigger'), labelOf('trigger', run.trigger)],
    ['配置者', run.configurer === undefined ? '—' : await ctx.userName(run.configurer)],
    ['前驱运行', run.predecessor === undefined ? '—' : link(`/console/runs/${run.predecessor}`, run.predecessor)],
    ['会话', run.session ?? '—'],
    ['开始时间', run.started_at],
    ['边界政策', run.policy ?? '—'],
    ['规程摘要', code(run.instructions_digest)],
  ]);
  const basis = run.target_basis.length === 0 ? html`<p class="empty">没有</p>` : html`${run.target_basis.map(claimBlock)}`;
  const sources = table(
    [axisLabel('source_role'), '引用', '输入', '外部对象', '媒体类型', '名称'],
    run.sources.map((s) => [labelOf('source_role', s.role), code(s.reference), s.slot ?? '', s.external ? code(s.external) : '', s.media_type ?? '', s.label ?? '']),
  );
  const requirements = table(
    ['键', '名称', '说明', axisLabel('layer'), axisLabel('done_rule'), axisLabel('accepted_producer'), '修复轮数'],
    run.requirements.map((r) => [
      code(r.key),
      r.name,
      r.description,
      LAYER.map((layer) => `${labelOf('layer', layer)}：${r.layers.includes(layer) ? '适用' : NOT_APPLICABLE}`).join('；'),
      labelOf('done_rule', r.done_rule),
      labelOf('accepted_producer', r.accepted_producer),
      r.repair_rounds,
    ]),
  );
  const latest = detail.latest;
  let results: Html;
  if (latest === null) {
    results = html`<p class="empty">还没有校验结果</p>`;
  } else {
    const result = latest.result;
    results = html`<p><strong>${countsLine(result.acceptance, result.acceptance === 'accepted' ? result.partitions : undefined)}</strong></p>
${definitions([
  ['校验结果记录', code(latest.record)],
  ['提交摘要', code(result.submission)],
  ['修复轮数', `已用 ${result.rounds.used}，最多 ${result.rounds.max}`],
  ['覆盖', coverageText(result.coverage) ?? '—'],
  ['锁定', html`任务包 ${result.locks.pack} ${code(result.locks.pack_digest)}${result.locks.root ? html`，知识根 ${code(result.locks.root)}` : ''}${result.locks.policy ? `，政策 ${result.locks.policy}` : ''}`],
  ['追踪', code(result.trace)],
])}
${partitionGroups(result, run)}
${section('跨条目主张（不计入分区）', result.cross_item.length === 0 ? html`<p class="empty">没有</p>` : html`${result.cross_item.map(claimBlock)}`)}
${section('错误与修正', errorsTable(result.errors))}`;
  }
  // Display rule 3: what was submitted, unverified, side by side with the platform's receipt and result.
  const submissionRows: unknown[][] = [];
  for (const s of detail.submissions) {
    submissionRows.push([
      code(s.record),
      s.received_at,
      labelOf('acceptance', s.acceptance),
      s.errors.length === 0 ? '' : html`${s.errors.map((e) => html`<div>${code(e.code)} ${e.message}${e.fix ? `；修正：${e.fix}` : ''}${e.rounds_left !== undefined ? `；剩余修复轮数 ${e.rounds_left}` : ''}</div>`)}`,
      s.result ?? '—',
      await submissionContent(ctx, s.record, run.run),
    ]);
  }
  const submissions = table(['提交记录', '收到时间', axisLabel('acceptance'), '错误', '校验结果', '提交内容（未经平台验证）'], submissionRows, '没有提交');
  const calls = await ctx.deps.records.callLog.query(ctx.principal, { runId: run.run, limit: 200, newestFirst: false });
  const items = table(
    ['条目', '名称', '位置', '指纹', '可沿用'],
    run.items.map((item) => [code(item.id), item.label, code(item.location), item.digest ? code(item.digest) : '', item.reuse ? code(item.reuse) : '']),
    '没有条目',
  );
  return {
    status: 200,
    body: page(
      ctx.chrome(`运行 ${run.run}`),
      html`${summary}
${section('版本依据', basis)}
${section('来源', sources)}
${section('要求项', requirements)}
${section(`条目（${run.items.length}）`, items)}
${section('分区清单', results)}
${section('提交与回执', submissions)}
${section('调用日志', callTable(calls.items, ctx.admin, await names(ctx, calls.items)))}`,
    ),
  };
}

async function names(ctx: PageContext, lines: readonly CallLogLine[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const line of lines) if (line.user !== null && !out.has(line.user)) out.set(line.user, await ctx.userName(line.user));
  return out;
}

function callTable(lines: readonly CallLogLine[], admin: boolean, users: ReadonlyMap<string, string>): Html {
  const headers = ['时间', '用户', '工具', axisLabel('call_result'), axisLabel('acceptance'), '错误码', '耗时（毫秒）', '运行', '追踪', '会话', '参数摘要（字节）'];
  if (admin) headers.push('管理员备注');
  return table(
    headers,
    lines.map((line) => {
      const row: unknown[] = [
        line.at,
        line.user === null ? '—' : (users.get(line.user) ?? line.user),
        line.tool,
        labelOf('call_result', line.call_result),
        line.acceptance === null ? '' : labelOf('acceptance', line.acceptance),
        line.error_code ?? '',
        line.duration_ms,
        line.run === null ? '' : link(`/console/runs/${line.run}`, line.run),
        code(line.trace_id),
        line.session ?? '',
        html`${code(line.args_digest.slice(0, 16))}（${line.args_size}）`,
      ];
      if (admin) row.push(line.admin_note ?? '');
      return row;
    }),
    '没有调用',
  );
}

// ---------------------------------------------------------------- knowledge

interface ProductLine {
  id: string;
  title: string;
  names: string[];
}

async function readableLines(ctx: PageContext): Promise<ProductLine[]> {
  const products = ctx.deps.products;
  if (products !== undefined) {
    const all = await products.products();
    const readable = ctx.admin ? null : await products.readableProducts(ctx.principal);
    const seen = new Map<string, ProductLine>();
    for (const handle of all) {
      const product = handle.product;
      if (readable !== null && !readable.has(product.id)) continue;
      if (!seen.has(product.id)) seen.set(product.id, { id: product.id, title: product.title, names: [...product.names] });
    }
    return [...seen.values()];
  }
  if (!ctx.admin) return [];
  const listing = await ctx.deps.packs.list(ctx.principal);
  return listing.filter((p) => p.kind === 'product' && !p.withdrawn).map((p) => ({ id: p.id, title: p.title, names: [] }));
}

async function productReadable(ctx: PageContext, product: string): Promise<ProductLine | null> {
  return (await readableLines(ctx)).find((line) => line.id === product) ?? null;
}

/** A root is readable when one of its compositions belongs to a product line the reader may read. */
async function rootReadable(ctx: PageContext, root: string): Promise<boolean> {
  if (!SHA256.test(root)) return false;
  const infos = await ctx.deps.knowledge.rootInfo(root);
  if (infos.length === 0) return false;
  const lines = new Set((await readableLines(ctx)).map((line) => line.id));
  return infos.some((info) => lines.has(info.product));
}

export async function knowledgePage(ctx: PageContext): Promise<PageResult> {
  const lines = await readableLines(ctx);
  const blocks: Html[] = [];
  for (const line of lines) {
    const builds = await ctx.deps.knowledge.builds(line.id);
    const byLine = new Map<string, { total: number; released: number; produced: number; families: Set<string> }>();
    for (const build of builds) {
      const entry = byLine.get(build.line) ?? { total: 0, released: 0, produced: 0, families: new Set<string>() };
      entry.total += 1;
      if (build.released_at !== null) entry.released += 1;
      if (build.root !== null) entry.produced += 1;
      entry.families.add(build.family);
      byLine.set(build.line, entry);
    }
    const rows = [];
    for (const [version, entry] of byLine) {
      const current = await ctx.deps.knowledge.currentRoot(line.id, version);
      rows.push([
        link('/console/knowledge/product', version, { id: line.id, line: version }),
        [...entry.families].join('、'),
        entry.total,
        entry.released,
        entry.produced,
        current === null ? '—' : html`${link('/console/knowledge/tree', current.root.slice(0, 16), { root: current.root, path: '/' })}（${current.build.name}）`,
      ]);
    }
    blocks.push(
      section(
        `${line.title}（${line.id}）`,
        html`<p>名称：${line.names.length > 0 ? line.names.join('、') : '—'}；${link('/console/knowledge/product', '全部构建', { id: line.id })}</p>
${table(['版本线', '名称族', '构建', '已发布', '已产出根', '当前根'], rows, '还没有构建')}`,
      ),
    );
  }
  const diffForm = html`<form class="filters" method="get" action="/console/knowledge/diff"><label>从根 <input name="from" size="66"></label><label>到根 <input name="to" size="66"></label><button type="submit">比较</button></form>`;
  return {
    status: 200,
    body: page(ctx.chrome('知识'), html`${blocks.length === 0 ? html`<p class="empty">没有你可读的产品线</p>` : blocks}${section('版本比较', diffForm)}`),
  };
}

export async function productPage(ctx: PageContext): Promise<PageResult> {
  const id = param(ctx, 'id');
  const versionLine = param(ctx, 'line');
  const line = id === undefined ? null : await productReadable(ctx, id);
  if (line === null) return neutralPage(ctx);
  const builds = await ctx.deps.knowledge.builds(line.id, versionLine === undefined ? undefined : { line: versionLine });
  const shown = builds.slice(0, 500);
  const rows = shown.map((b) => [
    b.name,
    b.family,
    b.line,
    b.base === b.name ? '—' : `别名，基于 ${b.base}`,
    b.platform ?? '主平台',
    b.built_at ?? '—',
    b.released_at ?? '未发布',
    b.root === null ? '—' : link('/console/knowledge/root', b.root.slice(0, 16), { root: b.root }),
  ]);
  const more = builds.length > shown.length ? html`<p>只列出前 ${shown.length} 个，共 ${builds.length} 个</p>` : html``;
  return {
    status: 200,
    body: page(
      ctx.chrome(`${line.title}${versionLine ? ` ${versionLine}` : ''}`),
      html`<p>名称：${line.names.join('、') || '—'}</p>${table(['构建', '名称族', '版本线', '别名', '平台', '构建时间', '发布时间', '根'], rows, '没有构建')}${more}`,
    ),
  };
}

export async function rootPage(ctx: PageContext): Promise<PageResult> {
  const root = param(ctx, 'root') ?? '';
  if (!(await rootReadable(ctx, root))) return neutralPage(ctx);
  const infos = await ctx.deps.knowledge.rootInfo(root);
  return {
    status: 200,
    body: page(
      ctx.chrome('知识根'),
      html`<p>${code(root)} ${link('/console/knowledge/tree', '浏览树', { root, path: '/' })}</p>
${table(
  ['组成记录', '产品线', '构建', '名称族', '版本线', '产出时间'],
  infos.map((info) => [code(info.composition), info.product, info.build.name, info.build.family, info.build.line, info.produced_at]),
)}`,
    ),
  };
}

export async function treePage(ctx: PageContext): Promise<PageResult> {
  const root = param(ctx, 'root') ?? '';
  const path = param(ctx, 'path') ?? '/';
  const cursor = param(ctx, 'cursor');
  if (!SHA256.test(root)) return neutralPage(ctx);
  const nodes = await ctx.deps.knowledge.getNodes({ root, paths: [path], depth: 1, cursor: cursor ?? null }, ctx.principal);
  if (nodes === null) return neutralPage(ctx);
  const parts = nodes.nodes.map((node) =>
    section(
      `${node.path}（${node.level}）`,
      html`${definitions([
        ['名称', node.name],
        ['引用', code(node.reference)],
        ['摘要', code(node.digest)],
      ])}
${table(['子节点', '路径'], node.children.map((child) => [link('/console/knowledge/tree', child.name, { root, path: child.path }), code(child.path)]), '没有子节点')}
${table(
  ['种类', '陈述', '适用', '引用', '数据'],
  node.entries.map((entry) => [entry.kind, entry.statement, entry.applicability, code(entry.reference), entry.data === undefined ? '' : pre(JSON.stringify(entry.data, null, 2))]),
  '没有条目',
)}`,
    ),
  );
  const parent = path === '/' ? null : path.slice(0, path.lastIndexOf('/')) || '/';
  const next = nodes.next === null ? html`` : html`<p>${link('/console/knowledge/tree', '下一页', { root, path, cursor: nodes.next })}</p>`;
  return {
    status: 200,
    body: page(
      ctx.chrome('知识树'),
      html`<p>根 ${code(root)}${parent === null ? '' : html` · ${link('/console/knowledge/tree', '上一级', { root, path: parent })}`}</p>
<p>覆盖：${coverageText(nodes.coverage) ?? '—'}</p>${parts}${next}`,
    ),
  };
}

export async function diffPage(ctx: PageContext): Promise<PageResult> {
  const from = param(ctx, 'from') ?? '';
  const to = param(ctx, 'to') ?? '';
  if (!(await rootReadable(ctx, from)) || !(await rootReadable(ctx, to))) return neutralPage(ctx);
  const diff = await ctx.deps.knowledge.diffRoots(from, to);
  if (diff === null) return neutralPage(ctx);
  const listOf = (paths: readonly string[], root: string) =>
    table(['路径'], paths.slice(0, 1000).map((p) => [link('/console/knowledge/tree', p, { root, path: p })]), '没有');
  return {
    status: 200,
    body: page(
      ctx.chrome('版本比较'),
      html`<p>从 ${code(from)} 到 ${code(to)}</p>
${section(`只在新根里（${diff.added.length}）`, listOf(diff.added, to))}
${section(`只在旧根里（${diff.removed.length}）`, listOf(diff.removed, from))}
${section(`内容变了（${diff.modified.length}）`, listOf(diff.modified, to))}`,
    ),
  };
}

// ---------------------------------------------------------------- packs

export async function packsPage(ctx: PageContext): Promise<PageResult> {
  const packs = await ctx.deps.packs.list(ctx.principal);
  const rows = [];
  for (const p of packs) {
    const assigned = p.assigned_to === undefined ? null : await Promise.all(p.assigned_to.map((user) => ctx.userName(user)));
    const row: unknown[] = [
      `${p.id}@${p.version}`,
      labelOf('pack_kind', p.kind),
      p.title,
      await ctx.userName(p.owner),
      code(p.digest.slice(0, 16)),
      p.published_at,
      yesNo(p.withdrawn),
      p.kind === 'product' ? yesNo(p.active) : '—',
      Object.entries(p.samples).map(([source, count]) => `${source} ${count}`).join('，'),
    ];
    if (ctx.admin) row.push(assigned === null ? '' : assigned.join('、'));
    rows.push(row);
  }
  const headers = ['任务包', axisLabel('pack_kind'), '标题', '所有者', '摘要', '发布时间', '已下架', '全 Hub 启用', '样例'];
  if (ctx.admin) headers.push('分配给');
  return { status: 200, body: page(ctx.chrome('任务包'), table(headers, rows, '没有你可用的任务包')) };
}

// ---------------------------------------------------------------- admin

export async function adminPage(ctx: PageContext): Promise<PageResult> {
  if (!ctx.admin) return neutralPage(ctx);
  const { principals, authorizations } = ctx.deps.records;
  const users = await principals.list();
  const userRows = [];
  const tokenRows = [];
  for (const user of users) {
    const packs = await authorizations.packsFor(user.id);
    userRows.push([
      code(user.id),
      user.name,
      labelOf('permission_role', user.role),
      user.disabled ? '停用' : '启用',
      yesNo(await authorizations.canPublish(user.id)),
      packs.join('、'),
      user.created_at,
    ]);
    for (const token of await principals.tokens(user.id)) {
      tokenRows.push([code(token.id), user.name, token.label, token.created_at, token.last_used_at ?? '—', token.revoked_at ?? '有效']);
    }
  }
  const history = await authorizations.history({ permission: 'assign', limit: 50, newestFirst: true });
  const assignmentRows = [];
  for (const record of history.items) {
    const body = record.body;
    assignmentRows.push([body.decided_at, await ctx.userName(body.subject), body.object, body.revoked ? '撤销分配' : '分配', await ctx.userName(body.decided_by), body.expires_at ?? '—', body.note ?? '']);
  }
  const resources = await ctx.deps.resources.list(ctx.principal);
  const resourceRows = resources.map((r) => [
    code(r.id),
    r.system_pack,
    r.name,
    isEnvironment(r.environment) ? labelOf('environment', r.environment) : r.environment,
    yesNo(r.enabled),
    r.origins === undefined ? '' : html`${Object.entries(r.origins).map(([role, origin]) => html`<div>${role}：${code(origin)}</div>`)}`,
    (r.allow_plaintext ?? []).join('、'),
  ]);
  return {
    status: 200,
    body: page(
      ctx.chrome('管理'),
      html`<p>${link('/console/admin/calls', '调用日志')}</p>
${section('用户', table(['用户', '名称', axisLabel('permission_role'), '状态', '发布权', '分配的任务包', '建立时间'], userRows))}
${section('令牌（不显示令牌值）', table(['令牌', '用户', '标签', '签发时间', '最近使用', '撤销时间'], tokenRows, '没有令牌'))}
${section('任务包分配记录', table(['决定时间', '用户', '任务包', '决定', '决定人', '到期', '备注'], assignmentRows, '没有分配记录'))}
${section('资源', table(['资源', '系统包', '名称', axisLabel('environment'), '启用', '地址', '允许明文凭据的地址'], resourceRows, '没有资源'))}`,
    ),
  };
}

function isoOrUndefined(value: string | undefined): string | undefined | null {
  if (value === undefined) return undefined;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

export async function callsPage(ctx: PageContext): Promise<PageResult> {
  if (!ctx.admin) return neutralPage(ctx);
  const user = param(ctx, 'user');
  const tool = param(ctx, 'tool');
  const run = param(ctx, 'run');
  const from = isoOrUndefined(param(ctx, 'from'));
  const to = isoOrUndefined(param(ctx, 'to'));
  const cursor = param(ctx, 'cursor');
  const problems: string[] = [];
  if (from === null) problems.push('“从”不是时间');
  if (to === null) problems.push('“到”不是时间');
  let userId: string | undefined;
  if (user !== undefined) {
    userId = /^usr_[0-9a-z]{26}$/.test(user) ? user : ((await ctx.deps.records.principals.findByName(user))?.id ?? '');
  }
  const filters = html`<form class="filters" method="get" action="/console/admin/calls">
<label>用户 <input name="user" value="${user ?? ''}"></label><label>工具 <input name="tool" value="${tool ?? ''}"></label>
<label>运行 <input name="run" value="${run ?? ''}"></label><label>从 <input name="from" value="${param(ctx, 'from') ?? ''}"></label>
<label>到 <input name="to" value="${param(ctx, 'to') ?? ''}"></label><button type="submit">筛选</button></form>`;
  if (problems.length > 0 || from === null || to === null) {
    return { status: 400, body: page(ctx.chrome('调用日志'), html`${filters}<p class="error">${problems.join('；')}</p>`) };
  }
  const lines =
    userId === ''
      ? { items: [], next: null }
      : await ctx.deps.records.callLog.query(ctx.principal, {
          ...(userId === undefined ? {} : { userId }),
          ...(tool === undefined ? {} : { tool }),
          ...(run === undefined ? {} : { runId: run }),
          ...(from === undefined ? {} : { from }),
          ...(to === undefined ? {} : { to }),
          limit: 100,
          cursor: cursor ?? null,
        });
  const next = lines.next === null ? html`` : html`<p>${link('/console/admin/calls', '下一页', { user, tool, run, from: param(ctx, 'from'), to: param(ctx, 'to'), cursor: lines.next })}</p>`;
  return { status: 200, body: page(ctx.chrome('调用日志'), html`${filters}${callTable(lines.items, true, await names(ctx, lines.items))}${next}`) };
}

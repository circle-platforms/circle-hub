import { digestOf } from '../../records/api.ts';
// The console pages that read: tasks, one task, knowledge and task packs. Every enumeration value is shown through its
// interface term (uiLabelOf, display rule 20), every claim in DISPLAY_ORDER, unknown with its own symbol and colour; absent
// and forbidden are the same neutral page. The task page keeps the run's authoritative view (display rule 17) under the
// waterfall: the partition list in the three groups of display rule 13, each item's two cells by the conjunction of hub/runs
// (V03 R[3]), and every submission as received, marked unverified, next to its receipt (display rule 3).
import { DISPLAY_ORDER } from '../../../contracts/generated/protocol.ts';
import { LAYER, PARTITION, TASK_RESULT, axisUiLabel, isItemHandling, isNodeLevel, isTaskResult, uiLabelOf, type Partition, type TaskResult } from '../../../contracts/generated/vocabulary.ts';
import type { Claim } from '../../../contracts/src/claim.ts';
import type { ProtocolError } from '../../../contracts/src/common.ts';
import type { RunRecord } from '../../../contracts/src/run.ts';
import { partitionCountsOf, type ItemResult, type LayerResult, type RequirementResult, type ValidationResult } from '../../../contracts/src/validation.ts';
import type { RunDetail } from '../../ports.ts';
import type { CallLogLine, Principal } from '../../records/api.ts';
import { canSeeRun } from '../../runs/engine/api.ts';
import { productionShareKey } from '../../records/api.ts';
import { itemCell, isAbandonedResult } from '../../runs/api.ts';
import type { ServerDeps } from '../api.ts';
import type { HubFacts } from './settings.ts';
import { INTERFACE_LABELS, NOT_APPLICABLE, cellText, statusText, claimFields, coverageText, terminalKind, terminalText, type LayerTerminal } from '../claims.ts';
import { countsLine, countsText } from '../text.ts';
import { code, definitions, html, icon, link, liveModule, page, pre, section, table, type Html, type PageChrome } from './html.ts';
import { loadTasks, packIdOf, packTitles, resultCell, runLink, taskHead, taskTitle, taskWaterfall, toolCell } from './tasks.ts';
import { button, callout, card, pills, planned, sectionHead, when } from './ui.ts';
import { citationsLine, countText, nodeCitations } from './citations.ts';
import { awaitingRequests } from './requests.ts';

export interface PageContext {
  deps: ServerDeps;
  principal: Principal;
  admin: boolean;
  url: URL;
  /** The chrome of a page: its title, and the place of the navigation, a line and buttons when the page has them. */
  chrome: (title: string, extra?: Pick<PageChrome, 'active' | 'sub' | 'hint' | 'actions'>) => PageChrome;
  /** The session's CSRF token, for the management forms (only the console's own requests carry one). */
  csrf?: string;
  /** The request came over HTTPS (the built-in listener or the configured proxy). */
  secure?: boolean;
  /** The origin the browser reached (scheme and the Host the app accepted), for the Circle entry of this Hub. */
  origin?: string;
  /** The process serving the console, for the Hub's state. */
  hub?: HubFacts;
  /** Display name of a user id, cached for the request. */
  userName: (userId: string | null | undefined) => Promise<string>;
}

export interface PageResult {
  status: number;
  body: Html;
}

/**
 * The neutral answer for absent and forbidden alike (D05 R[3]): the same words whatever the path, so neither the object's
 * name nor its id shows. The MCP tools keep their own neutral text (UNAVAILABLE_MESSAGE).
 */
export const NEUTRAL = '该内容不存在或无权查看';

export function neutralPage(ctx: PageContext): PageResult {
  return { status: 404, body: page(ctx.chrome(NEUTRAL), html`${callout('info', '对象可能已删除，或当前账号没有查看权限；两种情况显示相同的结果。')}<p class="mt16">${link('/console/overview', '返回总览')}</p>`) };
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

/** Current rule status is a view qualifier, never a replacement for the immutable receipt. */
export function ruleWithdrawalNotice(detail:Pick<RunDetail,'rule_withdrawn'>):Html{
  return detail.rule_withdrawn?html`<p class="notice"><strong>${uiLabelOf('validity_status','rule_withdrawn')}（版本已下架）</strong>；下列回执展示生成时的状态；原摘要、分区和要求项终态保持原样，这是当前读取时的限定。</p>`:html``;
}

export function claimBlock(claim: Claim): Html {
  return html`<div class="claim">${definitions(claimFields(claim, false, INTERFACE_LABELS))}</div>`;
}

// ---------------------------------------------------------------- runs

/** Bind the live condition only to result claims; the claim and its receipt remain original evidence. */
export function claimBlockAtRead(ruleWithdrawn:boolean):typeof claimBlock{
  return ruleWithdrawn?claim=>html`<div class="claim">${definitions(claimFields(claim,true,INTERFACE_LABELS))}</div>`:claimBlock;
}

/** Tasks per page: each one's result needs its run read, so a page stays small. */
const TASKS_PER_PAGE = 30;

export async function runsPage(ctx: PageContext): Promise<PageResult> {
  const pack = param(ctx, 'pack');
  const cursor = param(ctx, 'cursor');
  const wanted = param(ctx, 'result');
  const filtering = pack !== undefined || wanted !== undefined;
  if (wanted !== undefined && !isTaskResult(wanted)) return { status: 400, body: page(ctx.chrome('请求有误', { active: 'tasks' }), html`<p class="error">筛选的任务结果不对</p>`) };
  const listing = await ctx.deps.runs.listRuns(ctx.principal, { pack, limit: TASKS_PER_PAGE, cursor: cursor ?? null });
  const [tasks, titles] = await Promise.all([loadTasks(ctx, listing.items), packTitles(ctx)]);
  const counts = new Map<TaskResult, number>();
  for (const task of tasks) if (task.result !== null) counts.set(task.result, (counts.get(task.result) ?? 0) + 1);
  const shown = wanted === undefined ? tasks : tasks.filter((task) => task.result === wanted);
  const rows = [];
  for (const task of shown) {
    const run = task.run;
    rows.push([
      html`${runLink(run, html`<b>${taskTitle(run, titles)}</b>`)}<div class="digest">${run.run}</div>`,
      run.pack,
      [run.product, run.version, run.build].filter(Boolean).join(' / ') || '—',
      run.runner === undefined ? uiLabelOf('execution_host', run.host) : await ctx.userName(run.runner),
      when(run.started_at),
      run.items.length,
      run.session ?? '',
      resultCell(task),
    ]);
  }
  // The dispatch-unconfirmed filter, like every other, appears only while such a task is on the page.
  const filters = pills([
    { label: '全部', count: tasks.length, path: '/console/runs', params: { pack, cursor }, on: wanted === undefined },
    ...TASK_RESULT.filter((result) => (counts.get(result) ?? 0) > 0 || result === wanted).map((result) => ({ label: uiLabelOf('task_result', result), count: counts.get(result) ?? 0, path: '/console/runs', params: { pack, cursor, result }, on: result === wanted })),
  ], '按任务结果筛选');
  const filter = html`<form class="filters" method="get" action="/console/runs"><label>任务包 <input name="pack" value="${pack ?? ''}"></label>${wanted === undefined ? '' : html`<input type="hidden" name="result" value="${wanted}">`}<button type="submit">筛选</button></form>`;
  const next = listing.next === null ? html`` : html`<p class="mt12">${link('/console/runs', '下一页', { pack, result: wanted, cursor: listing.next })}</p>`;
  const requests=(await ctx.deps.runs.listRequests?.(ctx.principal)??[]).filter(r=>r.answered_by===null);
  const empty = tasks.length === 0 && !filtering;
  const list = empty
    ? card({ title: '尚无任务' }, html`<p class="sub">Circle 启动任务后在此列出。</p>`)
    : card({ title: '任务', meta: `本页 ${tasks.length} 个任务${filtering ? `，筛选后 ${shown.length} 个` : ''}`, hint: '按开始时间排列' }, html`${filter}${table(['任务', '任务包版本', '产品 / 版本 / 构建', '执行人', '开始时间', '条目', '会话', '结果'], rows, '本页没有符合筛选的任务')}${next}`);
  return {
    status: 200,
    body: page(ctx.chrome('任务', { active: 'tasks', hint: 'Circle 提交的每个结果都经过 Hub 校验：引用溯源、原文比对、沙箱复验' }), html`${empty ? '' : filters}<div class="mt16">${liveModule('tasks', ['task.updated'], list)}</div>
${liveModule('task-requests', ['request.updated'], await awaitingRequests(ctx, requests, listing.overdue_requests, true))}`),
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
    if (found === undefined) return html`<div>${uiLabelOf('layer', layer)}：${NOT_APPLICABLE}</div>`;
    return html`<div>${terminalHtml({ layer, terminal: found.terminal } as LayerTerminal, cellText(layer, found, INTERFACE_LABELS))}</div>`;
  })}`;
}

function itemTable(items: readonly ItemResult[], names: ReadonlyMap<string, string>, renderClaim:typeof claimBlock = claimBlock): Html {
  const rows: unknown[][] = [];
  for (const item of items) {
    const why = 'code' in item ? code(item.code) : 'reason' in item ? uiLabelOf('reason', item.reason) : '';
    const head = [
      html`${code(item.item)}<br>${item.label}`,
      html`${code(item.location)}${item.replaced_criteria?.map(change=>html`<details><summary>被取代的判据</summary>${definitions([['位置',code(change.criterion)],['旧值',pre(change.old)],['新值',pre(change.new)],['声明',code(change.declaration)],['复核结果',code(change.review)],['复核人',code(change.reviewer)]])}</details>`)??''}${item.carried_over ? html`<br>沿用 ${code(item.carried_over)}` : ''}`,
      why,
      itemCells(item.requirements),
    ];
    if (item.requirements.length === 0) rows.push([...head, '', '', '', '']);
    for (const [index, r] of item.requirements.entries()) {
      const layers = LAYER.map((layer) => {
        const found: LayerResult | undefined = r.layers.find((l) => l.layer === layer);
        return found === undefined ? html`${uiLabelOf('layer', layer)}：${NOT_APPLICABLE}` : html`${terminalHtml(found, terminalText(found, INTERFACE_LABELS))}${found.reason?html`<div>${found.missing??'缺失事实未写'}；${found.exit?`${found.exit.due} 前，${'user'in found.exit.audience?found.exit.audience.user:uiLabelOf('execution_host','hub')}：${uiLabelOf('exit_action',found.exit.action)}`:'出口未写'}</div>`:''}${found.gaps?.map(g=>html`<div>未决未知：${g.missing}；${g.exit.due} 前：${uiLabelOf('exit_action',g.exit.action)}</div>`)??''}`;
      });
      rows.push([
        ...(index === 0 ? head : ['', '', '', '']),
        html`${r.requirement} ${names.get(r.requirement) ?? ''}`,
        html`${layers.map((text) => html`<div>${text}</div>`)}`,
        statusText(r, INTERFACE_LABELS),
        html`${r.claims.map(renderClaim)}`,
      ]);
    }
  }
  return table(['条目', '位置', '原因', `条目结果（每种${axisUiLabel('layer')}一格）`, '要求项', `各${axisUiLabel('layer')}的结果`, axisUiLabel('requirement_status'), `结论（${DISPLAY_ORDER.join('、')}）`], rows, '没有条目');
}

/**
 * Display rule 13: the run page derives three groups from the partition list: what was adopted (delivered), what is still
 * to be handled (rejected, quarantined, incomplete) and the requests for the viewer to decide (milestone 1 has none).
 */
const GROUP_OF = { delivered: 'adopted', rejected: 'open', quarantined: 'open', incomplete: 'open' } as const satisfies Record<Partition, 'adopted' | 'open'>;
const GROUP_TITLE = { adopted: '已采用的成果', open: '仍需处理的事项' } as const;

function partitionGroups(result: ValidationResult, run: RunRecord, renderClaim:typeof claimBlock = claimBlock): Html {
  const names = new Map(run.requirements.map((r) => [r.key, r.name]));
  const groups: Html[] = [];
  for (const group of ['adopted', 'open'] as const) {
    const members = PARTITION.filter((p) => GROUP_OF[p] === group);
    const total = members.reduce((sum, p) => sum + result.partitions[p].length, 0);
    // Display rule 6: every partition shows its count and lists its items, an empty one included.
    const parts = members.map((p) => section(`${uiLabelOf('partition', p)}（${result.partitions[p].length}）`, itemTable(result.partitions[p], names,renderClaim)));
    groups.push(section(`${GROUP_TITLE[group]}（${members.map((p) => uiLabelOf('partition', p)).join('、')}，${total}）`, html`${parts}`));
  }

  return html`${groups}`;
}

/** Commentary has judgments, not another authoritative partition report. */
function commentaryJudgments(result: ValidationResult,renderClaim:typeof claimBlock = claimBlock): Html {
  return table(['条目', '名称', '模型逐条判断（未采用）'], PARTITION.flatMap(partition => result.partitions[partition]).map(item => [code(item.item), item.label,
    html`${item.requirements.flatMap(requirement => requirement.claims).filter(claim => claim.qualifier.nature === 'judgment').map(renderClaim)}`]), '没有逐条模型判断');
}

async function commentaryHandling(ctx: PageContext, detail: RunDetail, result: NonNullable<RunDetail['latest']>): Promise<Html> {
  const submission = detail.submissions.find(entry => entry.result === result.record);
  const record = submission === undefined ? null : await ctx.deps.records.store.get(submission.record);
  const body = record?.body;
  if (record?.kind !== 'submission' || !isObject(body) || body.run !== detail.run.run || !Array.isArray(body.items)) return html`<p class="notice">缺少对应的模型提交原件；请刷新本页重读，仍缺请管理员按评论结果记录核对原提交。</p>`;
  return table(['条目', '模型处理声明（未经平台验证）', '声明理由'], body.items.filter(isObject).map(item => [code(String(item.item ?? '')),
    isItemHandling(item.handling) ? `模型声明${uiLabelOf('item_handling', item.handling)} ${String(item.item ?? '')}` : '没有可识别的模型处理声明',
    typeof item.reason === 'string' ? item.reason : '—']), '没有模型处理声明');
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

/** A visible run may precede its stored production result; ask for a reread before a new run. */
export function missingProductionResult(detail:RunDetail):Html {
  return html`<p class="notice">没有找到 start_run 留下的校验结果记录（缺：submission 等于运行记录摘要的 validation_result）。这次运行开始于 ${detail.run.started_at}；如果运行刚开始，请刷新本页再看。刷新后仍缺，再用同样的输入重新开始一次新运行，使用新的 client_key，避免返回这次旧运行。</p>
${detail.latest===null?'':html`<p class="notice">已有后续受理的模型评论，结果记录 ${code(detail.latest.record)}；运行页在“模型评论（判断）”中单列。这份评论不能补作生产结果。</p>`}`;
}

/** The query already authorized this run; this marker never grants access itself. */
export function sharedRunNotice(ctx: PageContext, run: RunRecord): Html {
  return canSeeRun(ctx.principal,run) ? html`` : html`<p class="notice">经管理员分享（只读）</p>`;
}

async function runSharing(ctx: PageContext, run: RunRecord): Promise<Html> {
  if (!ctx.admin) return html``;
  const direct = await ctx.deps.records.authorizations.shares(ctx.principal,run.run);
  const pack = run.pack.slice(0,run.pack.lastIndexOf('@'));
  const policies = run.requirements.length && run.requirements.every(row=>row.accepted_producer==='fact')
    ? await ctx.deps.records.authorizations.shares(ctx.principal,productionShareKey(pack)) : [];
  return section('当前分享',table(['对象','受众','主体','决定时刻','理由'],[...direct,...policies].map(share=>[
    code(share.body.object),uiLabelOf('share_audience',share.body.share_audience ?? 'user'),code(share.body.subject),share.body.decided_at,share.body.note ?? '—',
  ]),'没有有效分享'));
}

export async function runPage(ctx: PageContext, runId: string): Promise<PageResult> {
  if (!RUN_ID.test(runId)) return neutralPage(ctx);
  const detail: RunDetail | null = await ctx.deps.runs.getRun(ctx.principal, runId);
  if (detail === null) return neutralPage(ctx);
  const run = detail.run;
  const renderClaim=claimBlockAtRead(detail.rule_withdrawn===true);
  const summary = definitions([
    ['运行', code(run.run)],
    ['任务包', html`${run.pack} ${code(run.pack_digest)}`],
    ['产品 / 版本 / 构建', [run.product, run.version, run.build].filter(Boolean).join(' / ') || '—'],
    ['锁定的知识版本', run.root === undefined ? '—' : link('/console/knowledge/tree', run.root, { root: run.root, path: '/' })],
    ['执行人', run.runner === undefined ? '—' : await ctx.userName(run.runner)],
    [axisUiLabel('execution_host'), uiLabelOf('execution_host', run.host)],
    [axisUiLabel('trigger'), uiLabelOf('trigger', run.trigger)],
    ['配置者', run.configurer === undefined ? '—' : await ctx.userName(run.configurer)],
    ['前驱运行', run.predecessor === undefined ? '—' : link(`/console/runs/${run.predecessor}`, run.predecessor)],
    ['会话', run.session ?? '—'],
    ['开始时间', run.started_at],
    ['提交期限', run.submission_due ?? '旧运行没有记录期限，请以它为前驱开新修订'],
    ['交付', detail.latest === null ? '尚未交付' : '已有交付结果'],
    ['边界政策', run.policy ?? '—'],
    ['规程内容哈希', code(run.instructions_digest)],
  ]);
  const basis = run.target_basis.length === 0 ? html`<p class="empty">没有</p>` : html`${run.target_basis.map(claimBlock)}`;
  const sources = table(
    [axisUiLabel('source_role'), '引用', '输入', '外部对象', '媒体类型', '名称'],
    run.sources.map((s) => [uiLabelOf('source_role', s.role), code(s.reference), s.slot ?? '', s.external ? code(s.external) : '', s.media_type ?? '', s.label ?? '']),
  );
  const requirements = table(
    ['键', '名称', '说明', axisUiLabel('layer'), axisUiLabel('done_rule'), axisUiLabel('accepted_producer'), '修复轮数'],
    run.requirements.map((r) => [
      code(r.key),
      r.name,
      r.description,
      LAYER.map((layer) => `${uiLabelOf('layer', layer)}：${r.layers.includes(layer) ? '适用' : NOT_APPLICABLE}`).join('；'),
      uiLabelOf('done_rule', r.done_rule),
      uiLabelOf('accepted_producer', r.accepted_producer),
      r.repair_rounds,
    ]),
  );
  const factOnly=run.requirements.length>0&&run.requirements.every(requirement=>requirement.accepted_producer==='fact');
  const primary=detail.latest?.result.system_input?detail.latest:factOnly?detail.production:detail.latest;
  const renderResult=(latest:NonNullable<RunDetail['latest']>,recordLabel:string,commentary=false):Html=>{
    const result = latest.result;
    const management=isAbandonedResult(result);
    const unwritten=management?result.cross_item.find(c=>c.warrant.id==='runs.engine@1'&&c.statement.data?.run_disposition==='abandon')?.statement.data?.legacy_unwritten_fields:undefined;
    return html`<p><strong>${management?'管理放弃（不是目标通过）；':commentary ? '模型声明的分区（判断，未采用）：' : ''}${result.system_input?'系统交付；'+countsText(partitionCountsOf(result.partitions),result.partitions,INTERFACE_LABELS):countsLine(result.acceptance, result.acceptance === 'accepted' ? result.partitions : undefined, INTERFACE_LABELS)}</strong></p>
${management?html`<p>技术层未重新核验；原记录 ${typeof unwritten==='number'?unwritten:0} 处技术字段未写，原件仍显示“出口未写”；本投影出口仅引用本次真实处置请求。</p>`:''}
${definitions([
  [recordLabel, code(latest.record)],
  [result.system_input?'系统交付输入内容哈希':'提交内容哈希',code(result.submission)],
  ['修复轮数', `已用 ${result.rounds.used}，最多 ${result.rounds.max}`],
  ['覆盖', coverageText(result.coverage) ?? '—'],
  ['锁定', html`任务包 ${result.locks.pack} ${code(result.locks.pack_digest)}${result.locks.root ? html`，知识版本 ${code(result.locks.root)}` : ''}${result.locks.policy ? `，政策 ${result.locks.policy}` : ''}`],
  ['追踪', code(result.trace)],
])}
${commentary ? section('逐条模型判断（未采用）', commentaryJudgments(result,renderClaim)) : partitionGroups(result, run,renderClaim)}
${section('跨条目主张（不计入分区）', result.cross_item.length === 0 ? html`<p class="empty">没有</p>` : html`${result.cross_item.map(renderClaim)}`)}
${section('错误与修正', errorsTable(result.errors))}`;
  };
  const results=primary===null?(factOnly?missingProductionResult(detail):html`<p class="empty">还没有校验结果</p>`):renderResult(primary,factOnly?'生产结果记录（start_run 计算）':'校验结果记录');
  const commentary=factOnly&&detail.latest!==null&&detail.latest.record!==primary?.record
    ? section('模型评论（判断）',html`<p class="notice">后续受理的模型评论，以下判断不替代 start_run 计算的生产结果。</p>${renderResult(detail.latest,'模型评论结果记录',true)}${section('模型处理声明（未经平台验证）', await commentaryHandling(ctx, detail, detail.latest))}`):'';
  // Display rule 3: what was submitted, unverified, side by side with the platform's receipt and result.
  const submissionRows: unknown[][] = [];
  for (const s of detail.submissions) {
    submissionRows.push([
      code(s.record),
      s.received_at,
      s.acceptance === null ? '未校验（Hub 中断）' : uiLabelOf('acceptance', s.acceptance),
      s.errors.length === 0 ? '' : html`${s.errors.map((e) => html`<div>${code(e.code)} ${e.message}${e.fix ? `；修正：${e.fix}` : ''}${e.rounds_left !== undefined ? `；剩余修复轮数 ${e.rounds_left}` : ''}</div>`)}`,
      s.result ?? '—',
      await submissionContent(ctx, s.record, run.run),
    ]);
  }
  const submissions = table(['提交记录', '收到时间', axisUiLabel('acceptance'), '错误', '校验结果', '提交内容（未经平台验证）'], submissionRows, '没有提交');
  const calls = await ctx.deps.records.callLog.query(ctx.principal, { runId: run.run, limit: 200, newestFirst: false, cursor:param(ctx,'call_cursor')??null });
  const items = table(
    ['条目', '名称', '位置', '指纹', '可沿用'],
    run.items.map((item) => [code(item.id), item.label, code(item.location), item.digest ? code(item.digest) : '', item.reuse ? code(item.reuse) : '']),
    '没有条目',
  );
  const stringFields=run.items.flatMap(item=>Object.entries(item.fields).flatMap(([key,value])=>
    typeof value==='string'?[[code(item.id),code(key),pre(value)]]:[]));
  const projectedFields=stringFields.length===0?'':section('投影字符串字段（只读）',
    html`<details><summary>查看原文（全文，不截断）</summary>${table(['条目','字段','原文'],stringFields)}</details>`);
  const titles = await packTitles(ctx);
  const head = await taskHead(ctx, detail, titles);
  // The first page of the call log is the waterfall's too; a later page is not.
  const process = await taskWaterfall(ctx, detail, param(ctx, 'call_cursor') === undefined ? calls.items : undefined);
  return {
    status: 200,
    body: page(
      ctx.chrome('任务', { active: 'tasks', sub: html`${link('/console/runs', '全部任务')} · ${taskTitle(run, titles)}` }),
      html`${liveModule('task', ['task.updated', 'request.updated'], html`${head}<div class="mt16">${process}</div>`, { run: run.run })}
${liveModule('task-record', ['task.updated', 'request.updated'], html`<div class="record"><h2>完整记录</h2><p class="sub">结果分类清单、各条目的检查结果、提交原文与回执；任务的结果以本节为准。</p>
${sharedRunNotice(ctx,run)}${ruleWithdrawalNotice(detail)}${summary}
${await runSharing(ctx,run)}
${detail.management?section('管理处置',html`<p>目标已放弃；来源 ${link('/console/runs/'+run.run,'运行',{})} ${code(detail.management.record)}。${detail.management.result?'下列为管理交付，技术终态沿用原记录，未重新核验；未知计数保留，旧缺字段只引用此次真实处置请求。':'管理交付投影尚未形成，Hub 将自动重试；旧技术结果仍在原记录中。'}</p>`):''}
${section('版本依据', basis)}
${section('来源', sources)}
${section('要求项', requirements)}
${section(`条目（${run.items.length}）`, items)}
${projectedFields}
${run.criterion_changes?.length?section('判据变更声明',table(['声明 / 请求','条目 / 判据','原断言','旧值 / 新值','状态 / 复核人 / 理由','接收人 / 期限','下一步'],run.criterion_changes.map(change=>[html`${code(change.declaration)}<br>${code(change.request)}`,html`${code(change.item)}<br>${code(change.criterion)}`,change.assertion,html`${pre(change.old)}${pre(change.new)}`,change.superseded_by?`由后一份提交的同名声明取代：${change.superseded_by}`:change.accepted===true?`已接受；复核人 ${change.reviewer??'未写'}；理由 ${change.reason??'未写'}`:change.accepted===false?`未接受；复核人 ${change.reviewer??'未写'}；理由 ${change.reason??'未写'}`:change.expired?'请求已过期，仍在等待作者以外的账号复核；新修订不带这条声明':'等待作者以外的账号复核中',html`${code(change.audience)}<br>${change.due}`,change.next_action]),'没有判据变更声明')):''}
${section(axisUiLabel('partition'), results)}
${commentary}
${await awaitingRequests(ctx, detail.requests ?? [])}
${section('提交与回执', submissions)}
${section('调用日志',html`${callTable(calls.items, ctx.admin, await names(ctx, calls.items))}<p>分页：本页 ${calls.items.length} 条${typeof calls.next==='string'?html`；${link(`/console/runs/${run.run}`,'下一页',{call_cursor:calls.next})}`:''}</p>`)}
</div>`, { run: run.run })}`,
    ),
  };
}

export async function names(ctx: PageContext, lines: readonly CallLogLine[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const line of lines) if (line.user !== null && !out.has(line.user)) out.set(line.user, await ctx.userName(line.user));
  return out;
}

export function callTable(lines: readonly CallLogLine[], admin: boolean, users: ReadonlyMap<string, string>): Html {
  const headers = ['时间', '用户', '工具', axisUiLabel('call_result'), axisUiLabel('acceptance'), '错误码', '耗时（毫秒）', '运行', '追踪', '会话', '参数摘要（字节）'];
  if (admin) headers.push('管理员备注');
  return table(
    headers,
    lines.map((line) => {
      const row: unknown[] = [
        html`<time datetime="${line.at}" title="${line.at}">${when(line.at)}</time>`,
        line.user === null ? '—' : (users.get(line.user) ?? line.user),
        toolCell(line.tool),
        uiLabelOf('call_result', line.call_result),
        line.acceptance === null ? '' : uiLabelOf('acceptance', line.acceptance),
        line.error_code ?? '',
        line.duration_ms,
        line.run === null ? '' : link(`/console/runs/${line.run}`, line.run),
        code(line.trace_id),
        line.session ?? '',
        html`${code(line.args_digest.slice(0, 16))}（${line.args_size}）`,
      ];
      if (admin) row.push(line.admin_reasons?.length?html`${line.admin_note??''}<details><summary>完整理由（${line.admin_reasons.length} 条）</summary><ol>${line.admin_reasons.map(reason=>html`<li><pre>${reason}</pre></li>`)}</ol></details>`:line.admin_note??'');
      return row;
    }),
    '没有调用',
    'calls',
  );
}

// ---------------------------------------------------------------- knowledge

export interface ProductLine {
  id: string;
  title: string;
  names: string[];
}

export async function readableLines(ctx: PageContext): Promise<ProductLine[]> {
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
export async function rootReadable(ctx: PageContext, root: string): Promise<boolean> {
  if (!SHA256.test(root)) return false;
  const infos = await ctx.deps.knowledge.rootInfo(root);
  if (infos.length === 0) return false;
  const lines = new Set((await readableLines(ctx)).map((line) => line.id));
  return infos.some((info) => lines.has(info.product));
}

export async function knowledgePage(ctx: PageContext): Promise<PageResult> {
  const lines = await readableLines(ctx);
  const todos = await ctx.deps.knowledge.feeding?.todos(ctx.principal) ?? [];
  const pending = todos.length === 0 ? html`` : section('知识入库待处理', table(['来源', '待补充内容', '后续处理', '检查脚本出错详情'], todos.map(row => [code(JSON.stringify(row.source)), row.missing, row.next_action, row.detail ? code(JSON.stringify(row.detail)) : '—'])));
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
    const unversioned = await ctx.deps.knowledge.unversionedRoot?.(line.id) ?? null;
    rows.push(['不分版本', '—', '构建未声明', '—', unversioned === null ? '—' : `1（来源 ${unversioned.source_count} 个）`,
      unversioned === null ? '—' : link('/console/knowledge/root', unversioned.root.slice(0,16), {root:unversioned.root})]);
    blocks.push(
      card(
        { title: `${line.title}（${line.id}）`, meta: html`名称：${line.names.length > 0 ? line.names.join('、') : '—'}` },
        html`${table(['版本', '名称族', '构建', '已发布', '已产出版本', '当前版本'], rows, '还没有构建')}<div class="card-f"><span class="sub">当前版本为该版本线最新产出的知识；内容变化后内容哈希随之改变。</span>${link('/console/knowledge/product', '全部构建', { id: line.id })}</div>`,
      ),
    );
  }
  const diffForm = html`<form class="filters" method="get" action="/console/knowledge/diff"><label>从版本（内容哈希） <input name="from" size="66"></label><label>到版本（内容哈希） <input name="to" size="66"></label><button type="submit">比较</button></form>`;
  const flow = card({ title: '知识入库流程', hint: '共享知识须经 Hub 出处校验' }, html`<div class="stages">
<div class="stage planned-stage"><span class="host"><span class="dot idle"></span>仅本人可见</span><b>原文归档</b><span class="sub">Circle 读取的网页、文件、系统数据连同出处归档</span>${planned()}</div>
<div class="stage circle"><span class="host"><span class="dot unknown"></span>本机 Circle</span><b>模型归纳</b><span class="sub">模型生成的归纳保留在本机，不上传 Hub</span></div>
<div class="stage circle"><span class="host"><span class="dot unknown"></span>本机 Circle</span><b>提交共享</b><span class="sub">确认为事实后，连同出处提交</span></div>
<div class="stage on-hub"><span class="host"><span class="dot info"></span>Hub</span><b>出处校验</b><span class="sub">可追溯至原文且引文一致方可入库</span></div>
<div class="stage"><span class="host"><span class="dot ok"></span>所有人可见</span><b>共享知识</b><span class="sub">按产品线与版本组织，所有 Circle 可读取、可引用</span></div>
</div><p class="note">从业务系统与文档导入的知识同样经 Hub 校验；个人账号读取的内容不会自动成为共享知识。</p>`);
  const actions = ctx.admin ? button('/console/operations/knowledge', '导入知识', { primary: true, icon: 'upload' }) : undefined;
  return {
    status: 200,
    body: page(ctx.chrome('知识库', { active: 'knowledge', hint: '统一的知识库：每条知识均附出处，按产品线与版本组织', ...(actions === undefined ? {} : { actions }) }), html`${flow}${pending}
${sectionHead('按产品线浏览', undefined, undefined, undefined, '可读的产品线及其版本')}
${liveModule('lines', ['knowledge.published'], blocks.length === 0 ? html`<article class="card"><p class="empty">没有可读的产品线</p><p class="sub mt4">产品线随产品包发布；成员可读分配给自己的任务包所绑定的产品线。</p></article>` : html`<div class="stack">${blocks}</div>`)}
<div class="mt16">${card({ title: '版本差异', meta: '两个版本之间新增、删除与修改的条目' }, diffForm)}</div>`),
  };
}

function pagedArray<T>(ctx:PageContext,values:readonly T[],size:number,key:string,scope:string):{items:readonly T[];next:string|null;start:number}|null {
  const hash=digestOf({scope,values});
  const cursor=param(ctx,key);
  let start=0;
  if(cursor!==undefined){
    if(cursor.length>128)return null;
    const decoded=Buffer.from(cursor,'base64url').toString('utf8');
    const match=/^([0-9a-f]{64}):([0-9]+)$/.exec(decoded);
    if(!match||match[1]!==hash||Buffer.from(decoded).toString('base64url')!==cursor)return null;
    start=Number(match[2]);
    if(!Number.isSafeInteger(start)||start<0||start>values.length||start%size!==0)return null;
  }
  return {items:values.slice(start,start+size),start,next:start+size<values.length?Buffer.from(`${hash}:${start+size}`).toString('base64url'):null};
}
function invalidArrayCursor(ctx:PageContext):PageResult{return{status:400,body:page(ctx.chrome('分页参数无效'),html`<p>列表已变化或游标无效，请从第一页重新打开。</p>`) };}

export async function productPage(ctx: PageContext): Promise<PageResult> {
  const id = param(ctx, 'id');
  const versionLine = param(ctx, 'line');
  const line = id === undefined ? null : await productReadable(ctx, id);
  if (line === null) return neutralPage(ctx);
  const builds = await ctx.deps.knowledge.builds(line.id, versionLine === undefined ? undefined : { line: versionLine });
  const listing=pagedArray(ctx,builds,500,'cursor',`builds:${line.id}:${versionLine??''}`);
  if(listing===null)return invalidArrayCursor(ctx);
  const shown = listing.items;
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
  const more = html`<p>分页：本页 ${shown.length?listing.start+1:0} 至 ${listing.start+shown.length}，共 ${builds.length} 个${listing.next?html`；${link('/console/knowledge/product','下一页',{id:line.id,line:versionLine,cursor:listing.next})}`:''}</p>`;
  return {
    status: 200,
    body: page(
      ctx.chrome(`${line.title}${versionLine ? ` ${versionLine}` : ''}`, { active: 'knowledge', sub: html`${link('/console/knowledge', '知识库')} · 构建` }),
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
      ctx.chrome('知识版本', { active: 'knowledge', sub: html`${link('/console/knowledge', '知识库')} · 内容哈希 ${code(root.slice(0, 16))}` }),
      html`<p>${code(root)} ${link('/console/knowledge/tree', '浏览条目', { root, path: '/' })}</p>
${table(
  ['组成记录', '产品线', '构建', '名称族', '版本线', '产出时间'],
  infos.map((info) => [code(info.composition), info.product, info.build?.name ?? '构建未声明', info.build?.family ?? '—', info.build?.line ?? '不分版本', info.produced_at]),
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
  // The node asked for gets its citations and its entries' provenance; the nodes below it are listed as before.
  const main = nodes.nodes.find((node) => node.path === path);
  const citations = main === undefined ? null : await nodeCitations(ctx, root, main);
  const parts = nodes.nodes.map((node) => {
    const cited = node === main ? citations : null;
    const byEntry = new Map((cited?.entries ?? []).map((entry) => [entry.entry, entry]));
    const grounds = (entry: string) => {
      const found = byEntry.get(entry);
      if (found === undefined || found.grounds === null) return '—';
      if (found.grounds.length === 0) return '未记录出处';
      return html`${found.grounds.map((ground) => html`<div>${code(ground)}</div>`)}${found.grounds_truncated ? html`<div class="sub">仅列出前 ${found.grounds.length} 条</div>` : ''}`;
    };
    return section(
      `${node.path}（${isNodeLevel(node.level) ? uiLabelOf('node_level', node.level) : node.level}）`,
      html`${definitions([
        ['名称', node.name],
        ['引用', code(node.reference)],
        ['内容哈希', code(node.digest)],
        ...(cited === null ? [] : [['被引用', citationsLine(cited)] as [string, string]]),
      ])}
${table(['下级', '路径'], node.children.map((child) => [link('/console/knowledge/tree', child.name, { root, path: child.path }), code(child.path)]), '没有下级')}
${cited === null
  ? table(
    ['种类', '陈述', '适用', '引用', '数据'],
    node.entries.map((entry) => [entry.kind, entry.statement, entry.applicability, code(entry.reference), entry.data === undefined ? '' : pre(JSON.stringify(entry.data, null, 2))]),
    '没有条目',
  )
  : table(
    ['种类', '陈述', '适用', '引用', '出处', `近 ${cited.days} 天被引用`, '数据'],
    node.entries.map((entry) => {
      const counted = byEntry.get(entry.entry);
      return [entry.kind, entry.statement, entry.applicability, code(entry.reference), grounds(entry.entry), counted === undefined ? '—' : countText(cited, counted.count, counted.capped), entry.data === undefined ? '' : pre(JSON.stringify(entry.data, null, 2))];
    }),
    '没有条目',
  )}${cited?.entries_truncated ? html`<p class="sub">条目较多，仅前 ${cited.entries.length} 条给出出处与被引用次数。</p>` : ''}`,
    );
  });
  const parent = path === '/' ? null : path.slice(0, path.lastIndexOf('/')) || '/';
  const next = nodes.next === null ? html`` : html`<p>${link('/console/knowledge/tree', '下一页', { root, path, cursor: nodes.next })}</p>`;
  return {
    status: 200,
    body: page(
      ctx.chrome('知识条目', { active: 'knowledge', sub: html`${link('/console/knowledge', '知识库')} · ${path}` }),
      html`<p class="sub">版本 ${code(root)}${parent === null ? '' : html` · ${link('/console/knowledge/tree', '上一级', { root, path: parent })}`}</p>
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
  const lists=[['added',diff.added,to],['removed',diff.removed,from],['modified',diff.modified,to]] as const;
  const pages=lists.map(([key,paths])=>pagedArray(ctx,paths,1000,`${key}_cursor`,`${from}:${to}:${key}`));
  if(pages.some(p=>p===null))return invalidArrayCursor(ctx);
  const listOf = (index:number) => {
    const [key,paths,root]=lists[index], listing=pages[index]!;
    const parameters:Record<string,string>={from,to};
    for(const [name] of lists){const value=param(ctx,`${name}_cursor`);if(value!==undefined)parameters[`${name}_cursor`]=value;}
    if(listing.next)parameters[`${key}_cursor`]=listing.next;
    return html`${table(['路径'],listing.items.map(p=>[link('/console/knowledge/tree',p,{root,path:p})]),'没有')}<p>分页：本页 ${listing.items.length} 条，共 ${paths.length} 条${listing.next?html`；${link('/console/knowledge/diff','下一页',parameters)}`:''}</p>`;
  };
  return {
    status: 200,
    body: page(
      ctx.chrome('版本差异', { active: 'knowledge', sub: html`${link('/console/knowledge', '知识库')}` }),
      html`<p>从 ${code(from)} 到 ${code(to)}</p>
${section(`只在新根里（${diff.added.length}）`, listOf(0))}
${section(`只在旧根里（${diff.removed.length}）`, listOf(1))}
${section(`内容变了（${diff.modified.length}）`, listOf(2))}`,
    ),
  };
}

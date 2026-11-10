import {tooltip,panel as knowledgePanel,facts as knowledgeFacts,section as knowledgeSection,areaPage as knowledgeShell,technicalCode,technical,stat,sourceBlock} from './presentation.ts';
import { digestOf } from '../../records/api.ts';
// The console pages that read: tasks, one task, knowledge and task packs. Every enumeration value is shown through its
// interface term (uiLabelOf, display rule 20), every claim in DISPLAY_ORDER, unknown with its own symbol and colour; absent
// and forbidden are the same neutral page. The task page keeps the run's authoritative view (display rule 17) under the
// waterfall: the partition list in the three groups of display rule 13, each item's two cells by the conjunction of hub/runs
// (V03 R[3]), and every submission as received, marked unverified, next to its receipt (display rule 3).
import { LAYER, PARTITION, TASK_RESULT, axisUiLabel, isEntryKind, isItemHandling, isNodeLevel, isTaskResult, uiLabelOf, type Partition, type TaskResult, type ValidityStatus } from '../../../contracts/generated/vocabulary.ts';
import { acceptedProducerHead, doneRuleHead, packPurpose } from './pack-display.ts';
import { knowledgeTabs, spaceLayout } from './space-layout.ts';
import type { Claim } from '../../../contracts/src/claim.ts';
import { PROTOCOL_CODES } from '../../../contracts/generated/protocol.ts';
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
import { code, definitions, html, href, icon, link, liveModule, page, pageLayout, pre, section, table, type Html, type PageChrome } from './html.ts';
import { pendingCount, taskResultOf } from './status.ts';
import { loadTasks, packIdOf, packTitles, resultCell, runLink, taskHead, taskTitle, taskWaterfall, toolCell, waitingRequests } from './tasks.ts';
import { box, button, callout, card, pills, planned, sectionHead, when } from './ui.ts';
import { citationsLine, countText, nodeCitations } from './citations.ts';
import { awaitingRequests, groupRequests } from './requests.ts';
import { packSources } from './pack-sources.ts';
import {knowledgeHome} from './knowledge-home.ts';
import {sourceArchivePage} from './source-archive.ts';
import {memoryPage} from './memory.ts';
import { spaceOverview } from './spaces.ts';

export interface PageContext {
  deps: ServerDeps;
  principal: Principal;
  admin: boolean;
  url: URL;
  /** The chrome of a page: its title, and the place of the navigation, a line and buttons when the page has them. */
  chrome: (title: string, extra?: Pick<PageChrome, 'active' | 'sub' | 'hint' | 'actions' | 'crumbs'>) => PageChrome;
  /** The session's CSRF token, for the management forms (only the console's own requests carry one). */
  csrf?: string;
  /** The personal epoch read when rendering a write form. */
  personalEpoch?: string;
  /** What a knowledge action did, set by the action itself when only it knows (for example how many shares were merged). */
  feedback?: string;
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
  return { status: 404, body: page(ctx.chrome(NEUTRAL, {hint:'内容可能已删除，或当前账号没有查看权限，两种情况的显示相同。请返回总览或列表重新进入；仍需要时联系内容所有者或管理员确认。'}), html`<p>${link('/console/overview', '返回总览')}</p>`) };
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
export function ruleWithdrawalNotice(detail:Pick<RunDetail,Extract<ValidityStatus,'rule_withdrawn'|'grounds_withdrawn'|'grounds_purged'>> & Pick<RunDetail,'grounds_withdrawn_hidden_count'>):Html{
  // Owner ruling 3 (issue 141): name the unavailable grounds and the registered reason.
  const purged=detail.grounds_purged?.length?html`<p class="notice" data-grounds-purged><strong>${uiLabelOf('validity_status','grounds_purged')}</strong>；${PROTOCOL_CODES.GROUNDS_PURGED.when}（${detail.grounds_purged.length} 项来源）。${PROTOCOL_CODES.GROUNDS_PURGED.fix}。</p>${detail.grounds_purged.map(row=>technical(code(row.reference),'查看不可用的引用'))}`:html``;
  const grounds=detail.grounds_withdrawn?.length||detail.grounds_withdrawn_hidden_count?html`<p class="notice"><strong>${uiLabelOf('validity_status','grounds_withdrawn')}</strong>；来源当前已撤回，原有回执保留。${detail.grounds_withdrawn_hidden_count?`另有 ${detail.grounds_withdrawn_hidden_count} 项来源不可读取。`:''}</p>`:html``;
  return html`${grounds}${purged}${detail.rule_withdrawn?html`<p class="notice"><strong>${uiLabelOf('validity_status','rule_withdrawn')}（版本已下架）</strong>；下列回执展示生成时的状态；原摘要、分区和要求项终态保持原样，这是当前读取时的限定。</p>`:html``}`;
}

export function claimBlock(claim: Claim): Html {
  return technical(html`<div class="ch-source" data-evidence>${definitions(claimFields(claim, false, INTERFACE_LABELS).map(([label,value])=>[label,/[a-f0-9]{32,}|(?:src|tree|rec):/.test(value)?technicalCode(value):value]))}</div>`,'查看主张');
}

// ---------------------------------------------------------------- runs

/** Bind the live condition only to result claims; the claim and its receipt remain original evidence. */
export function claimBlockAtRead(ruleWithdrawn:boolean):typeof claimBlock{
  return ruleWithdrawn?claim=>technical(html`<div class="ch-source" data-evidence>${definitions(claimFields(claim,true,INTERFACE_LABELS).map(([label,value])=>[label,/[a-f0-9]{32,}|(?:src|tree|rec):/.test(value)?technicalCode(value):value]))}</div>`,'查看主张'):claimBlock;
}

/** The tabs of a task's page (decision 151); the first is the page without a tab named. */
const TASK_TABS = ['requirements', 'items', 'requests', 'process', 'sources', 'record'] as const;
type TaskTab = typeof TASK_TABS[number];
const TASK_TAB_LABEL: Record<TaskTab, string> = { requirements: '验收要求', items: '条目', requests: '请求', process: '过程', sources: '来源', record: '技术信息' };

/** Tasks per page: each one's result needs its run read, so a page stays small. */
const TASKS_PER_PAGE = 30;

export async function runsPage(ctx: PageContext): Promise<PageResult> {
  const pack = param(ctx, 'pack');
  const cursor = param(ctx, 'cursor');
  const wanted = param(ctx, 'result');
  const filtering = pack !== undefined || wanted !== undefined;
  if (wanted !== undefined && !isTaskResult(wanted)) return { status: 400, body: page(ctx.chrome('请求有误', { active: 'tasks' }), html`<p class="error">筛选的任务结果不对</p>`) };
  const listing = await ctx.deps.runs.listRuns(ctx.principal, { pack, limit: TASKS_PER_PAGE, cursor: cursor ?? null, requests: false });
  const [tasks, titles] = await Promise.all([loadTasks(ctx, listing.items), packTitles(ctx)]);
  const counts = new Map<TaskResult, number>();
  for (const task of tasks) if (task.result !== null) counts.set(task.result, (counts.get(task.result) ?? 0) + 1);
  const shown = wanted === undefined ? tasks : tasks.filter((task) => task.result === wanted);
  const requests=await waitingRequests(ctx,tasks);
  const waitingOf = new Map<string, number>();
  for (const request of requests) if (request.run) waitingOf.set(request.run, (waitingOf.get(request.run) ?? 0) + 1);
  const view = param(ctx, 'view') === 'requests' ? 'requests' : 'tasks';
  const rows = [];
  for (const task of shown) {
    const run = task.run, waiting = waitingOf.get(run.run) ?? 0;
    rows.push([
      runLink(run, html`<b>${taskTitle(run, titles)}</b>`),
      [run.product, run.version, run.build].filter(Boolean).join(' / ') || '—',
      run.runner === undefined ? uiLabelOf('execution_host', run.host) : await ctx.userName(run.runner),
      when(run.started_at),
      run.items.length,
      html`${resultCell(task)}${waiting > 0 ? html`<p class="ch-meta">${waiting.toLocaleString('en-US')} 条请求${uiLabelOf('request_status', 'waiting')}</p>` : ''}`,
    ]);
  }
  // The dispatch-unconfirmed filter, like every other, appears only while such a task is on the page.
  const filters = pills([
    { label: '全部', count: tasks.length, path: '/console/runs', params: { pack, cursor }, on: wanted === undefined },
    ...TASK_RESULT.filter((result) => (counts.get(result) ?? 0) > 0 || result === wanted).map((result) => ({ label: uiLabelOf('task_result', result), count: counts.get(result) ?? 0, path: '/console/runs', params: { pack, cursor, result }, on: result === wanted })),
  ], '按任务结果筛选');
  // The workflows of the tasks on this page by name, instead of a field to type a pack identifier into.
  const used = new Map<string, string>();
  for (const task of tasks) used.set(packIdOf(task.run.pack), taskTitle(task.run, titles));
  if (pack !== undefined && !used.has(pack)) used.set(pack, pack);
  const filter = used.size < 2 && !filtering ? html`` : html`<form class="ch-actions" data-filters method="get" action="/console/runs"><label>按${uiLabelOf('pack_kind','workflow')}筛选 <select name="pack"><option value="">全部${uiLabelOf('pack_kind','workflow')}</option>${[...used].map(([id, title]) => html`<option value="${id}"${id === pack ? html` selected` : ''}>${title}</option>`)}</select></label>${wanted === undefined ? '' : html`<input type="hidden" name="result" value="${wanted}">`}<button class="ch-btn ch-btn--secondary" type="submit">筛选</button></form>`;
  const next = listing.next === null ? html`` : html`<p>${link('/console/runs', '下一页', { pack, result: wanted, cursor: listing.next })}</p>`;
  const empty = tasks.length === 0 && !filtering;
  const list = empty
    ? box(null, html`<div class="ch-empty"><p class="ch-empty-title">尚无任务</p><p class="ch-empty-text">客户端启动任务后在此列出。</p></div>`)
    : box(null, html`${table(['任务', '产品 / 版本 / 构建', '执行人', '开始时间', '条目', '结果'], rows, '本页没有符合筛选的任务','tasks',{hrefs:shown.map(task=>'/console/runs/'+task.run.run)})}`, { flush: true, ...(listing.next === null ? {} : { foot: next }) });
  // One page, one list (decision 151): the tasks, or the requests that wait on them, never both stacked.
  const tabs = html`<nav class="ch-seg" aria-label="任务页内容"><a href="${href('/console/runs', { pack, result: wanted, cursor })}"${view === 'tasks' ? html` aria-current="page"` : ''}>任务 <span class="ch-count">${tasks.length.toLocaleString('en-US')}</span></a><a href="${href('/console/runs', { pack, cursor, view: 'requests' })}"${view === 'requests' ? html` aria-current="page"` : ''}>${uiLabelOf('request_status', 'waiting')}的请求 <span class="ch-count">${requests.length.toLocaleString('en-US')}</span></a></nav>`;
  const waitingList = requests.length === 0 ? box(null, html`<div class="ch-empty"><p class="ch-empty-title">没有${uiLabelOf('request_status', 'waiting')}的请求</p><p class="ch-empty-text">本页任务下发的请求都已回应或已作废。</p></div>`) : await awaitingRequests(ctx, requests, true);
  // A Hub without a task shows the one fact, with no tabs, filters or zero counts around it.
  const content = empty ? html`<div>${liveModule('tasks', ['task.updated', 'request.updated'], list)}</div>` : view === 'requests'
    ? html`${tabs}${liveModule('task-requests', ['request.updated'], waitingList)}`
    : html`${tabs}<div class="ch-toolbar">${filters}${filter}</div><p class="ch-meta" data-list-facts>本页 ${tasks.length.toLocaleString('en-US')} 个任务${filtering ? `，筛选后 ${shown.length.toLocaleString('en-US')} 个` : ''} · 按开始时间排列</p><div>${liveModule('tasks', ['task.updated', 'request.updated'], list)}</div>`;
  return {
    status: 200,
    body: page(ctx.chrome('任务', { active: 'tasks', hint: 'Hub 按工作流要求检查提交结果；适用的检查可能包括引用溯源、原文比对和沙箱复验。每项是否执行及其结果，请查看检查明细。' }), pageLayout(content,{inspector:null})),
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
      html`${technicalCode(item.item)}<br>${item.label}`,
      html`${technicalCode(item.location)}${item.replaced_criteria?.map(change=>html`<details><summary>被取代的判据</summary>${definitions([['位置',code(change.criterion)],['旧值',pre(change.old)],['新值',pre(change.new)],['声明',code(change.declaration)],['复核结果',code(change.review)],['复核人',code(change.reviewer)]])}</details>`)??''}${item.carried_over ? html`<br>沿用 ${technicalCode(item.carried_over)}` : ''}`,
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
        html`${names.get(r.requirement)??'要求项'}${technicalCode(r.requirement)}`,
        html`${layers.map((text) => html`<div>${text}</div>`)}`,
        statusText(r, INTERFACE_LABELS),
        html`${r.claims.map(renderClaim)}`,
      ]);
    }
  }
  return table(['条目', '位置', '原因', `条目结果（每种${axisUiLabel('layer')}一格）`, '要求项', `各${axisUiLabel('layer')}的结果`, axisUiLabel('requirement_status'), '结论'], rows, '没有条目');
}

/**
 * Display rule 13: the run page derives three groups from the partition list: what was adopted (delivered), what is still
 * to be handled (rejected, quarantined, incomplete) and the requests for the viewer to decide (milestone 1 has none).
 */
const GROUP_OF = { delivered: 'adopted', rejected: 'open', quarantined: 'open', incomplete: 'open' } as const satisfies Record<Partition, 'adopted' | 'open'>;
const GROUP_TITLE = { adopted: '已交付的结果', open: '仍需处理的事项' } as const;

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
  return table(['条目', '名称', '模型逐条判断（未采用）'], PARTITION.flatMap(partition => result.partitions[partition]).map(item => [technicalCode(item.item), item.label,
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
/**
 * How much of each submission the list of the 过程 tab shows. A page lists up to 50 submissions: at 256 KB each a task with
 * 56 submissions answered with 7.6 MB. Each row shows its beginning and the one asked for by `submission` shows the rest.
 */
const PREVIEW_SUBMISSION_CHARS = 4 * 1024;
/** How many of a submission's errors its row of the list shows; the row asked for shows them all. */
const SHOWN_SUBMISSION_ERRORS = 3;
/** The anchor of one submission's content on the 过程 tab. */
const submissionAnchor = (digest: string): string => `submission-${digest.slice(0, 12)}`;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * A submission as the Hub received and stored it (display rule 3), marked unverified: the arguments of the record, or the
 * JSON text runs kept as an object when the arguments were not canonical JSON (`{received: {object, ...}}`).
 */
async function submissionContent(ctx: PageContext, digest: string, runId: string, whole?: { full: boolean; href: string }): Promise<Html> {
  const full = whole === undefined || whole.full, limit = full ? SHOWN_SUBMISSION_CHARS : PREVIEW_SUBMISSION_CHARS;
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
  let shown = text, more: Html | string = '';
  if (text.length > limit) {
    let end = limit;
    const last = text.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end -= 1;
    shown = text.slice(0, end);
    const cut = `只显示前 ${end.toLocaleString('en-US')} 个字符，共 ${text.length.toLocaleString('en-US')} 个`;
    // A row of the list: the rest is one link away, on the same row. The one asked for: what even that leaves out is in the record.
    if (full) note = [note, `${cut}，全文在记录 ${digest}`].filter(Boolean).join('；');
    else { note = [note, cut].filter(Boolean).join('；'); more = html` <a href="${whole!.href}">查看全文</a>`; }
  }
  return html`<details class="unverified" id="${submissionAnchor(digest)}"${whole?.full ? html` open` : ''}><summary>提交内容（未经平台验证）</summary>${note || more ? html`<p class="notice">${note}${more}</p>` : ''}${pre(shown)}</details>`;
}

/** A visible run may precede its stored production result; ask for a reread before a new run. */
export function missingProductionResult(detail:RunDetail):Html {
  return html`<p class="notice">没有找到 start_run 留下的校验结果记录（缺：submission 等于运行记录摘要的 validation_result）。这次运行开始于 ${detail.run.started_at}；如果运行刚开始，请刷新本页再看。刷新后仍缺，再用同样的输入重新开始一次新运行，使用新的 client_key，避免返回这次旧运行。</p>
${detail.latest===null?'':html`<p class="notice">已有后续受理的模型评论，结果记录 ${technicalCode(detail.latest.record)}；运行页在“模型评论（判断）”中单列。这份评论不能补作生产结果。</p>`}`;
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
    technicalCode(share.body.object),uiLabelOf('share_audience',share.body.share_audience ?? 'user'),technicalCode(share.body.subject),share.body.decided_at,share.body.note ?? '—',
  ]),'没有有效分享'));
}

/** What a validation result says in one line: its management disposition or commentary status, then the counts by classification. */
function resultHeadline(result: ValidationResult, commentary = false): string {
  return `${isAbandonedResult(result)?'管理放弃（不是目标通过）；':commentary ? '模型声明的分区（判断，未采用）：' : ''}${result.system_input?'系统交付；'+countsText(partitionCountsOf(result.partitions),result.partitions,INTERFACE_LABELS):countsLine(result.acceptance, result.acceptance === 'accepted' ? result.partitions : undefined, INTERFACE_LABELS)}`;
}
/** The tab of the task page the address asks for; `?view=record` is the old address of the last one. */
function taskTabOf(ctx: PageContext): TaskTab {
  const asked = param(ctx, 'tab') ?? (ctx.url.searchParams.get('view') === 'record' ? 'record' : undefined);
  return (TASK_TABS as readonly string[]).includes(asked ?? '') ? asked as TaskTab : 'requirements';
}
/** How many of a task's newest submissions its page lists at once (the rest by "older" links). */
export const RUN_HISTORY_LIMIT = 50;

export async function runPage(ctx: PageContext, runId: string): Promise<PageResult> {
  if (!RUN_ID.test(runId)) return neutralPage(ctx);
  // Issue 200: the page asks for a window of the newest submissions; older ones are reached by cursor, never read all at once.
  // Only the 过程 tab lists submissions. Every other tab shows the current result and the production result, which the read
  // gives beside the window, so it asks for a window of one: a task with 56 submissions answered each of its tabs after
  // reading 50 results, most of which no tab but one shows.
  const tab = taskTabOf(ctx);
  const olderParam = param(ctx, 'older'), before = tab === 'process' && olderParam !== undefined && olderParam.length <= 512 ? olderParam : null;
  const detail: RunDetail | null = await ctx.deps.runs.getRun(ctx.principal, runId, { history: { limit: tab === 'process' ? RUN_HISTORY_LIMIT : 1, before } });
  if (detail === null) return neutralPage(ctx);
  const run = detail.run;
  const renderClaim=claimBlockAtRead(detail.rule_withdrawn===true);
  const summary = definitions([
    ['运行', technicalCode(run.run)],
    [uiLabelOf('pack_kind', 'workflow'), html`${run.pack} ${technicalCode(run.pack_digest)}`],
    ['产品 / 版本 / 构建', [run.product, run.version, run.build].filter(Boolean).join(' / ') || '—'],
    ['锁定的知识版本', run.root === undefined ? '—' : link('/console/knowledge/tree', '查看', { root: run.root, path: '/' })],
    ['执行人', run.runner === undefined ? '—' : await ctx.userName(run.runner)],
    [axisUiLabel('execution_host'), uiLabelOf('execution_host', run.host)],
    [axisUiLabel('trigger'), uiLabelOf('trigger', run.trigger)],
    ['配置者', run.configurer === undefined ? '—' : await ctx.userName(run.configurer)],
    ['前驱运行', run.predecessor === undefined ? '—' : link(`/console/runs/${run.predecessor}`, '查看前驱任务')],
    ['会话', run.session ?? '—'],
    ['开始时间', run.started_at],
    ['提交期限', run.submission_due ?? '这次任务未记录提交期限。请从此任务创建新的修订后继续。'],
    ['交付', detail.latest === null ? '尚未交付' : '已有交付结果'],
    ['边界政策', run.policy ?? '—'],
    ['规程内容哈希', technicalCode(run.instructions_digest)],
  ]);
  const basis = run.target_basis.length === 0 ? html`<p class="empty">没有</p>` : html`${run.target_basis.map(claimBlock)}`;
  const sources = table(
    [axisUiLabel('source_role'), '引用', '输入', '外部对象', '媒体类型', '名称'],
    run.sources.map((s) => [uiLabelOf('source_role', s.role), technicalCode(s.reference), s.slot ?? '', s.external ? technicalCode(s.external) : '', s.media_type ?? '', html`${s.label??''}${s.upload_declaration?html`<p>${tooltip('本次任务可读','绑定原文为输入只对本次任务的读者开放，不改变全局读取权限。')}</p>`:''}`]),
  );
  const factOnly=run.requirements.length>0&&run.requirements.every(requirement=>requirement.accepted_producer==='fact');
  const primary=detail.latest?.result.system_input?detail.latest:factOnly?detail.production:detail.latest;
  const renderResult=(latest:NonNullable<RunDetail['latest']>,recordLabel:string,commentary=false):Html=>{
    const result = latest.result;
    const management=isAbandonedResult(result);
    const unwritten=management?result.cross_item.find(c=>c.warrant.id==='runs.engine@1'&&c.statement.data?.run_disposition==='abandon')?.statement.data?.legacy_unwritten_fields:undefined;
    return html`<p><strong>${resultHeadline(result,commentary)}</strong></p>
${management?html`<p>技术层未重新验证；原记录 ${typeof unwritten==='number'?unwritten:0} 处技术字段未写，原件仍显示“出口未写”；本投影出口仅引用本次真实处置请求。</p>`:''}
${definitions([
  [recordLabel, technicalCode(latest.record)],
  [result.system_input?'系统交付输入内容哈希':'提交内容哈希',technicalCode(result.submission)],
  ['修复轮数', `已用 ${result.rounds.used}，最多 ${result.rounds.max}`],
  ['覆盖', coverageText(result.coverage) ?? '—'],
  ['锁定', html`工作流 ${result.locks.pack} ${technicalCode(result.locks.pack_digest)}${result.locks.root ? html`，知识版本 ${technicalCode(result.locks.root)}` : ''}${result.locks.policy ? `，政策 ${result.locks.policy}` : ''}`],
  ['追踪', technicalCode(result.trace)],
])}
${commentary ? section('逐条模型判断（未采用）', commentaryJudgments(result,renderClaim)) : partitionGroups(result, run,renderClaim)}
${section('跨条目主张（不计入分区）', result.cross_item.length === 0 ? html`<p class="empty">没有</p>` : html`${result.cross_item.map(renderClaim)}`)}
${section('错误与修正', errorsTable(result.errors))}`;
  };
  const titles = await packTitles(ctx);
  const title = taskTitle(run, titles);
  const requests = (detail.requests ?? []).filter((request) => request.answered_by === null);
  // Decision 151: the page opens with what the task came to and what still waits for someone; everything else is one of six
  // tabs, and a tab works out only what it shows (issue 200: one page used to read the calls, every submission and source).
  const base = `/console/runs/${run.run}`;
  const groups = groupRequests(requests, (ctx.deps.now?.() ?? new Date()).getTime());
  const owing = groups.length === 0
    ? html`<p class="ch-meta">没有${uiLabelOf('request_status', 'waiting')}的请求。</p>`
    : html`<ul class="ch-todo">${groups.slice(0, 3).map((group) => html`<li><span class="ch-todo-count">${group.rows.length.toLocaleString('en-US')}</span> <span><b>${group.missing}</b></span></li>`)}</ul>
<p class="ch-meta">${groups.length > 3 ? `另有 ${(groups.length - 3).toLocaleString('en-US')} 类；` : ''}${link(base, '查看全部请求', { tab: 'requests' })}</p>`;
  const outcome = html`<section class="ch-card ch-result" data-task-outcome><div><h2 class="ch-card-title">任务结果</h2>
<div class="ch-actions">${resultCell({ result: taskResultOf(detail), pending: pendingCount(detail) })}</div>
${primary === null ? html`<p class="ch-meta">${factOnly ? '没有找到生产结果记录，原因见“条目”页签。' : '还没有校验结果。'}</p>` : html`<p><strong>${resultHeadline(primary.result)}</strong></p>`}</div>
<div><h2 class="ch-card-title">还需处理${requests.length > 0 ? ` · ${requests.length.toLocaleString('en-US')} 条请求${uiLabelOf('request_status', 'waiting')}` : ''}</h2>${owing}</div></section>`;
  const notices = html`${sharedRunNotice(ctx,run)}${ruleWithdrawalNotice(detail)}
${detail.management?section('管理处置',html`<p>目标已放弃；来源 ${link('/console/runs/'+run.run,'运行',{})} ${technicalCode(detail.management.record)}。${detail.management.result?'下列为管理交付，技术终态沿用原记录，未重新验证；未知计数保留，旧缺字段只引用此次真实处置请求。':'管理交付投影尚未形成，Hub 将自动重试；旧技术结果仍在原记录中。'}</p>`):''}`;
  const counts: Partial<Record<TaskTab, number>> = { requirements: run.requirements.length, items: run.items.length, requests: requests.length, sources: run.sources.length };
  const tabs = html`<nav class="ch-seg" aria-label="任务内容" data-task-tabs>${TASK_TABS.map((key) => html`<a href="${href(base, key === 'requirements' ? {} : { tab: key })}"${key === tab ? html` aria-current="page"` : ''}>${TASK_TAB_LABEL[key]}${counts[key] === undefined ? '' : html` <span class="ch-count">${counts[key]!.toLocaleString('en-US')}</span>`}</a>`)}</nav>`;
  let body: Html;
  if (tab === 'requirements') {
    // What each requirement came to across the items of the result that counts, in the words the item table uses.
    const tally = new Map<string, Map<string, number>>();
    if (primary !== null) for (const item of PARTITION.flatMap((partition) => primary.result.partitions[partition])) for (const r of item.requirements) {
      const row = tally.get(r.requirement) ?? new Map<string, number>(), label = statusText(r, INTERFACE_LABELS);
      row.set(label, (row.get(label) ?? 0) + 1); tally.set(r.requirement, row);
    }
    const outcomeOf = (key: string) => { const row = tally.get(key); return row === undefined ? '—' : [...row].map(([label, n]) => `${label} ${n.toLocaleString('en-US')}`).join(' · '); };
    body = box(null, table(
      // What it came to stands beside its name: the wide description must not push it out of sight.
      ['要求项', '各条目的结果', '说明', axisUiLabel('layer'), doneRuleHead(), acceptedProducerHead(), '修复轮数'],
      run.requirements.map((r) => [
        html`<b>${r.name}</b>`,
        outcomeOf(r.key),
        r.description,
        LAYER.map((layer) => `${uiLabelOf('layer', layer)}：${r.layers.includes(layer) ? '适用' : NOT_APPLICABLE}`).join('；'),
        uiLabelOf('done_rule', r.done_rule),
        uiLabelOf('accepted_producer', r.accepted_producer),
        r.repair_rounds,
      ]), '没有要求项', 'requirements'), { flush: true });
  } else if (tab === 'items') {
    const results=primary===null?(factOnly?missingProductionResult(detail):html`<p class="empty">还没有校验结果</p>`):renderResult(primary,factOnly?'生产结果记录（start_run 计算）':'校验结果记录');
    const commentary=factOnly&&detail.latest!==null&&detail.latest.record!==primary?.record
      ? section('模型评论（判断）',html`<p class="notice">后续受理的模型评论，以下判断不替代 start_run 计算的生产结果。</p>${renderResult(detail.latest,'模型评论结果记录',true)}${section('模型处理声明（未经平台验证）', await commentaryHandling(ctx, detail, detail.latest))}`):'';
    body = html`<div class="ch-section" id="task-evidence">${section(axisUiLabel('partition'), results)}
${commentary}</div>`;
  } else if (tab === 'requests') {
    body = html`${requests.length === 0 ? box(null, html`<div class="ch-empty"><p class="ch-empty-title">没有${uiLabelOf('request_status', 'waiting')}的请求</p><p class="ch-empty-text">这个任务下发的请求都已回应或已作废。</p></div>`) : await awaitingRequests(ctx, requests)}
${run.criterion_changes?.length?section('判据变更声明',table(['声明 / 请求','条目 / 判据','原断言','旧值 / 新值','状态 / 复核人 / 理由','接收人 / 期限','下一步'],run.criterion_changes.map(change=>[html`${code(change.declaration)}<br>${code(change.request)}`,html`${code(change.item)}<br>${code(change.criterion)}`,change.assertion,html`${pre(change.old)}${pre(change.new)}`,change.superseded_by?`由后一份提交的同名声明取代：${change.superseded_by}`:change.accepted===true?`已接受；复核人 ${change.reviewer??'未写'}；理由 ${change.reason??'未写'}`:change.accepted===false?`未接受；复核人 ${change.reviewer??'未写'}；理由 ${change.reason??'未写'}`:change.expired?'请求已过期，仍在等待作者以外的账号复核；新修订不带这条声明':'等待作者以外的账号复核中',html`${code(change.audience)}<br>${change.due}`,change.next_action]),'没有判据变更声明')):''}`;
  } else if (tab === 'process') {
    // Display rule 3: what was submitted, unverified, side by side with the platform's receipt and result.
    const submissionRows: unknown[][] = [];
    // The list shows the beginning of each submission; `submission` names the one shown whole, opened on its own row.
    const wanted = param(ctx, 'submission');
    for (const s of detail.submissions) {
      const full = s.record === wanted, whole = `${href(`/console/runs/${run.run}`, { tab: 'process', ...(before === null ? {} : { older: before }), submission: s.record })}#${submissionAnchor(s.record)}`;
      // A submission of the long task carried 70 errors, 28 KB a row: the list shows the first few and how many more there are.
      const errors = full ? s.errors : s.errors.slice(0, SHOWN_SUBMISSION_ERRORS);
      submissionRows.push([
        technicalCode(s.record),
        s.received_at,
        s.acceptance === null ? '未校验（Hub 中断）' : uiLabelOf('acceptance', s.acceptance),
        s.errors.length === 0 ? '' : html`${errors.map((e) => html`<div>${code(e.code)} ${e.message}${e.fix ? `；修正：${e.fix}` : ''}${e.rounds_left !== undefined ? `；剩余修复轮数 ${e.rounds_left}` : ''}</div>`)}${errors.length < s.errors.length ? html`<p class="ch-meta" data-more-errors>另有 ${(s.errors.length - errors.length).toLocaleString('en-US')} 条 · <a href="${whole}">查看全部</a></p>` : ''}`,
        s.result ? technicalCode(s.result) : '—',
        await submissionContent(ctx, s.record, run.run, { full, href: whole }),
      ]);
    }
    const submissions = table(['提交记录', '收到时间', axisUiLabel('acceptance'), '错误', '校验结果', '提交内容（未经平台验证）'], submissionRows, '没有提交');
    const paging = detail.history === undefined ? html`` : html`<p class="ch-meta">本页列出 ${detail.submissions.length} 次提交，每页最多 ${detail.history.limit} 次，较早的在上${detail.history.pinned === undefined ? '' : '；第一行是当前结果对应的提交'}；撤回提示按本页列出的结果、当前结果和生产结果判断。${detail.history.next === null ? '' : html` ${link(`/console/runs/${run.run}`, '查看更早的提交', { tab: 'process', older: detail.history.next })}`}${before === null ? '' : html` ${link(`/console/runs/${run.run}`, '回到最近的提交', { tab: 'process' })}`}</p>`;
    const calls = await ctx.deps.records.callLog.query(ctx.principal, { runId: run.run, limit: 200, newestFirst: false, cursor:param(ctx,'call_cursor')??null });
    // The first page of the call log is the waterfall's too; a later page is not.
    const process = await taskWaterfall(ctx, detail, param(ctx, 'call_cursor') === undefined ? calls.items : undefined);
    body = html`${process}
${section('提交与回执', html`${paging}${submissions}`)}
${section('调用日志',html`${callTable(calls.items, ctx.admin, await names(ctx, calls.items))}<p>分页：本页 ${calls.items.length} 条${typeof calls.next==='string'?html`；${link(`/console/runs/${run.run}`,'下一页',{tab:'process',call_cursor:calls.next})}`:''}</p>`)}`;
  } else if (tab === 'sources') {
    const sourcePanels=[];for(const source of run.sources)sourcePanels.push(await sourceBlock(ctx,source.reference));
    body = html`${box({title:'来源',meta:`${run.sources.length} 个`},sourcePanels.length?html`<div class="ch-stack">${sourcePanels}</div>`:html`<p class="ch-meta">没有来源。</p>`)}
${section('版本来源', basis)}`;
  } else {
    const items = table(
      ['条目', '名称', '位置', '指纹', '可沿用'],
      run.items.map((item) => [technicalCode(item.id), item.label, technicalCode(item.location), item.digest ? technicalCode(item.digest) : '', item.reuse ? technicalCode(item.reuse) : '']),
      '没有条目',
    );
    const stringFields=run.items.flatMap(item=>Object.entries(item.fields).flatMap(([key,value])=>
      typeof value==='string'?[[technicalCode(item.id),code(key),pre(value)]]:[]));
    const projectedFields=stringFields.length===0?'':section('投影字符串字段（只读）',
      html`<details><summary>查看原文（全文，不截断）</summary>${table(['条目','字段','原文'],stringFields)}</details>`);
    body = html`<div class="ch-section" data-task-record>${box({title:'技术信息',meta:'供排查和对账使用'},html`<div data-technical>${summary}</div>`)}
${await runSharing(ctx,run)}
${section('来源', sources)}
${section(`条目（${run.items.length}）`, items)}
${projectedFields}</div>`;
  }
  const who = run.runner === undefined ? uiLabelOf('execution_host', run.host) : await ctx.userName(run.runner);
  return {
    status: 200,
    body: page(
      ctx.chrome(title, { active: 'tasks', crumbs: link('/console/runs', '任务'), sub: html`${[run.product, run.version, run.build].filter(Boolean).join(' / ') || '—'} · 执行人 ${who} · 开始于 ${when(run.started_at)}` }),
      pageLayout(html`${liveModule('task', ['task.updated', 'request.updated'], html`${outcome}${notices}`, { run: run.run })}
${tabs}
${liveModule('task-record', ['task.updated', 'request.updated'], html`<div class="ch-section" data-task-tab="${tab}">${body}</div>`, { run: run.run })}`,{inspector:null}),
    ),
  };
}

export async function names(ctx: PageContext, lines: readonly CallLogLine[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const line of lines) if (line.user !== null && !out.has(line.user)) out.set(line.user, await ctx.userName(line.user));
  return out;
}

/**
 * The lines of the call log. `compact` is the list of the records page, where a line opens in the pane beside it: the trace,
 * the session and the digest of the arguments are read there, not in three more columns of every row.
 */
export function callTable(lines: readonly CallLogLine[], admin: boolean, users: ReadonlyMap<string, string>,selection?:{path:string;params:Record<string,string>;selected?:string;compact?:boolean}): Html {
  const compact = selection?.compact === true;
  const headers = ['时间', '成员', '工具', axisUiLabel('call_result'), axisUiLabel('acceptance'), '错误码', '耗时（毫秒）', '运行', ...(compact ? [] : ['追踪', '会话', '参数摘要（字节）'])];
  if (admin) headers.push('管理员备注');
  return table(
    headers,
    lines.map((line) => {
      const row: unknown[] = [
        selection?link(selection.path,when(line.at),{...selection.params,call:line.digest}):when(line.at),
        line.user === null ? '—' : (users.get(line.user) ?? line.user),
        toolCell(line.tool),
        uiLabelOf('call_result', line.call_result),
        line.acceptance === null ? '' : uiLabelOf('acceptance', line.acceptance),
        line.error_code ?? '',
        line.duration_ms,
        line.run === null ? '' : link(`/console/runs/${line.run}`, '查看任务'),
        ...(compact ? [] : [technicalCode(line.trace_id), line.session ?? '', html`${technicalCode(line.args_digest.slice(0, 16))}（${line.args_size}）`]),
      ];
      if (admin) row.push(line.admin_reasons?.length?html`${line.admin_note??''}<details><summary>完整理由（${line.admin_reasons.length} 条）</summary><ol>${line.admin_reasons.map(reason=>html`<li><pre>${reason}</pre></li>`)}</ol></details>`:line.admin_note??'');
      return row;
    }),
    '没有调用',
    'calls',selection?{selected:lines.findIndex(line=>line.digest===selection.selected),hrefs:lines.map(line=>selection.path+'?'+new URLSearchParams({...selection.params,call:line.digest}))}:undefined,
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

/** The pending intake of the knowledge feeding for this reader; empty when there is none. */
async function intakePending(ctx: PageContext): Promise<Html> {
  const todos = await ctx.deps.knowledge.feeding?.todos(ctx.principal) ?? [];
  return todos.length === 0 ? html`` : knowledgeSection('知识入库待处理', table(['来源', '待补充内容', '后续处理', '检查脚本出错详情'], todos.map(row => [technicalCode(JSON.stringify(row.source)), row.missing, row.next_action, row.detail ? technicalCode(JSON.stringify(row.detail)) : '—'])));
}

/** The fourth tab of the knowledge place: the product knowledge sources the reader may see, and what waits for intake. */
export async function productSourcesPage(ctx: PageContext): Promise<PageResult> {
  const content = html`${knowledgeTabs(ctx)}${await packSources(ctx, 'product', [], { bare: true })}${await intakePending(ctx)}`;
  return { status: 200, body: page(ctx.chrome('知识库', { active: 'knowledge', hint: packPurpose('product') }), await spaceLayout(ctx, pageLayout(content, { inspector: null }))) };
}

export async function knowledgePage(ctx: PageContext): Promise<PageResult> {
  if(ctx.url.searchParams.get('view')==='sources')return sourceArchivePage(ctx);
  if(ctx.url.searchParams.get('view')==='memory')return memoryPage(ctx);
  // Decision 151: the home is the list of entries; the product knowledge sources and what waits for intake are the fourth tab.
  if(ctx.deps.knowledge.spaces)return {status:200,body:knowledgeShell(ctx.chrome('知识库',{active:'knowledge',hint:'同步到 Hub 的私人内容保存在 Hub 数据库和服务器备份中，仅本人及当前获分享权限者可读；记忆仅作会话偏好，不作为运行来源'}),await knowledgeHome(ctx))};
  const spaces = await spaceOverview(ctx);
  const sources = await packSources(ctx, 'product');
  const lines = await readableLines(ctx);
  const pending = await intakePending(ctx);
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
        current === null ? '—' : html`${link('/console/knowledge/tree', current.build.name, { root: current.root, path: '/' })}`,
      ]);
    }
    const unversioned = await ctx.deps.knowledge.unversionedRoot?.(line.id) ?? null;
    rows.push(['不分版本', '—', '构建未声明', '—', unversioned === null ? '—' : `1（来源 ${unversioned.source_count} 个）`,
      unversioned === null ? '—' : link('/console/knowledge/root', '查看', {root:unversioned.root})]);
    const versions = builds.filter(build => build.root !== null).map(build => ({root: build.root!, label: `${build.line} / ${build.name}`}));
    if (unversioned !== null) versions.push({root: unversioned.root, label: '不分版本'});
    const options = versions;
    const diff = options.length === 0 ? html`` : html`<form class="ch-actions" data-filters method="get" action="/console/knowledge/diff" aria-label="${line.title}版本差异"><h3 title="两个版本之间新增、删除与修改的条目">${ctx.deps.knowledge.spaces?'产品版本差异':'版本差异'}</h3><label>从 <select name="from">${options.map((version, i) => html`<option value="${version.root}"${i === Math.min(1, options.length - 1) ? html` selected` : ''}>${version.label}</option>`)}</select></label><label>到 <select name="to">${options.map((version, i) => html`<option value="${version.root}"${i === 0 ? html` selected` : ''}>${version.label}</option>`)}</select></label><button class="ch-btn ch-btn--secondary" type="submit">比较</button></form>`;
    blocks.push(
      knowledgePanel(
        { title: line.title, meta: html`名称：${line.names.length > 0 ? line.names.join('、') : '—'}`, hint: '当前版本为该版本线最新产出的知识；内容变化后内容哈希随之改变。' },
        html`${table([ctx.deps.knowledge.spaces?'产品版本':'版本', '名称族', '构建', '已发布', '已产出版本', ctx.deps.knowledge.spaces?'当前知识版本':'当前版本'], rows, '还没有构建')}<div class="ch-actions">${link('/console/knowledge/product', '全部构建', { id: line.id })}</div>${diff}`,
      ),
    );
  }
  const flow = html``;
  const actions = ctx.admin ? html`${button('/console/operations/pack',`发布${uiLabelOf('pack_kind','product')}`,{params:{kind:'product'},icon:'upload'})}${button('/console/operations/knowledge', '导入团队知识', { primary: true, icon: 'upload', hint: '从产品知识来源声明的来源导入到团队知识库；产品文件夹沿用产品线读权，仅管理员可用' })}` : undefined;
  return {
    status: 200,
    body: knowledgeShell(ctx.chrome('知识库', { active: 'knowledge', hint: ctx.deps.knowledge.spaces?'我的、团队与与本账户共享的知识；已验证与待验证内容分别标示':'统一的知识库：每条知识均附来源，按产品线与版本组织', ...(actions === undefined ? {} : { actions }) }), html`${ctx.deps.knowledge.spaces?spaces:flow}${sources}${pending}
${liveModule('lines', ['knowledge.published'], lines.length === 0 ? knowledgePanel({ title: ctx.deps.knowledge.spaces?'产品文件夹':'团队知识' }, html`<p class="empty">${ctx.deps.knowledge.spaces?'没有可读的产品文件夹':ctx.admin ? '还没有团队知识；团队知识按产品线组织，发布产品知识来源后可在此浏览和导入' : '没有可读的团队知识；成员可读分配给自己的工作流所绑定的产品线'}</p>`) : html`${sectionHead('按产品线浏览', undefined, undefined, undefined, '可读的产品线及其版本')}<div class="ch-section">${blocks}</div>`)}`,html`<section class="ch-section"><h2 class="ch-panel-title">团队知识</h2></section>${stat('可读产品线',lines.length)}${lines.length?knowledgePanel({title:'产品线'},html`<ul class="ch-feed">${lines.map(line=>html`<li>${link('/console/knowledge/product',line.title,{id:line.id})}</li>`)}</ul>`):''}`),  };
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
function invalidArrayCursor(ctx:PageContext):PageResult{return{status:400,body:knowledgeShell(ctx.chrome('分页参数无效'),html`<p>列表已变化或游标无效，请从第一页重新打开。</p>`) };}

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
    b.root === null ? '—' : link('/console/knowledge/root', '查看', { root: b.root }),
  ]);
  const more = html`<p>分页：本页 ${shown.length?listing.start+1:0} 至 ${listing.start+shown.length}，共 ${builds.length} 个${listing.next?html`；${link('/console/knowledge/product','下一页',{id:line.id,line:versionLine,cursor:listing.next})}`:''}</p>`;
  return {
    status: 200,
    body: knowledgeShell(
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
    body: knowledgeShell(
      ctx.chrome('知识版本', { active: 'knowledge', crumbs: link('/console/knowledge','知识库') }),
      html`<p>${link('/console/knowledge/tree', '浏览条目', { root, path: '/' })}</p>${technicalCode(root)}
${table(
  ['组成记录', '产品线', '构建', '名称族', '版本线', '产出时间'],
  infos.map((info) => [technicalCode(info.composition), info.product, info.build?.name ?? '构建未声明', info.build?.family ?? '—', info.build?.line ?? '不分版本', info.produced_at]),
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
      if (found.grounds.length === 0) return '未记录来源';
      return html`${found.grounds.map((ground) => html`<div>${technicalCode(ground)}</div>`)}${found.grounds_truncated ? html`<div class="ch-meta">仅列出前 ${found.grounds.length} 条</div>` : ''}`;
    };
    return knowledgeSection(
      `${node.path}（${isNodeLevel(node.level) ? uiLabelOf('node_level', node.level) : node.level}）`,
      html`${knowledgeFacts([
        ['名称', node.name],
        ['引用', technicalCode(node.reference)],
        ['内容哈希', technicalCode(node.digest)],
        ...(cited === null ? [] : [['被引用', citationsLine(cited)] as [string, string]]),
      ])}
${table(['下级', '路径'], node.children.map((child) => [link('/console/knowledge/tree', child.name, { root, path: child.path }), technicalCode(child.path)]), '没有下级')}
${cited === null
  ? table(
    ['类型', '陈述', '适用', '引用', '数据'],
    node.entries.map((entry) => [isEntryKind(entry.kind)?uiLabelOf('entry_kind',entry.kind):entry.kind, entry.statement, entry.applicability, technicalCode(entry.reference), entry.data === undefined ? '' : pre(JSON.stringify(entry.data, null, 2))]),
    '没有条目',
  )
  : table(
    ['类型', '陈述', '适用', '引用', '来源', `近 ${cited.days} 天被引用`, '数据'],
    node.entries.map((entry) => {
      const counted = byEntry.get(entry.entry);
      return [isEntryKind(entry.kind)?uiLabelOf('entry_kind',entry.kind):entry.kind, entry.statement, entry.applicability, technicalCode(entry.reference), grounds(entry.entry), counted === undefined ? '—' : countText(cited, counted.count, counted.capped), entry.data === undefined ? '' : pre(JSON.stringify(entry.data, null, 2))];
    }),
    '没有条目',
  )}${cited?.entries_truncated ? html`<p class="ch-meta">条目较多，仅前 ${cited.entries.length} 条给出来源与被引用次数。</p>` : ''}`,
    );
  });
  const parent = path === '/' ? null : path.slice(0, path.lastIndexOf('/')) || '/';
  const next = nodes.next === null ? html`` : html`<p>${link('/console/knowledge/tree', '下一页', { root, path, cursor: nodes.next })}</p>`;
  return {
    status: 200,
    body: knowledgeShell(
      ctx.chrome('知识条目', { active: 'knowledge', sub: html`${link('/console/knowledge', '知识库')} · ${path}` }),
      html`<div class="ch-actions">版本 ${technicalCode(root)}${parent === null ? '' : html` · ${link('/console/knowledge/tree', '上一级', { root, path: parent })}`}</div>
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
    body: knowledgeShell(
      ctx.chrome('版本差异', { active: 'knowledge', sub: html`${link('/console/knowledge', '知识库')}` }),
      html`<div class="ch-actions">从 ${technicalCode(from)} 到 ${technicalCode(to)}</div>
${knowledgeSection(`只在新根里（${diff.added.length}）`, listOf(0))}
${knowledgeSection(`只在旧根里（${diff.removed.length}）`, listOf(1))}
${knowledgeSection(`内容变了（${diff.modified.length}）`, listOf(2))}`,
    ),
  };
}

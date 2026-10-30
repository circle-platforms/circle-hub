import { digestOf } from '../../records/api.ts';
// The console pages: runs, one run, knowledge, task packs and admin data (the admin page also carries the user and token
// forms of manage.ts; everything else here only reads). Every enumeration value is shown
// through labelOf, every claim in DISPLAY_ORDER, unknown with its own symbol and colour; absent and forbidden are the same
// neutral page. The run page is the authoritative view (display rule 17): the partition list in the three groups of display
// rule 13, each item's two cells by the conjunction of hub/runs (V03 R[3]), and every submission as received, marked
// unverified, next to its receipt (display rule 3).
import { DISPLAY_ORDER } from '../../../contracts/generated/protocol.ts';
import { LAYER, PARTITION, axisLabel, isEnvironment, isItemHandling, labelOf, type Partition } from '../../../contracts/generated/vocabulary.ts';
import type { Claim } from '../../../contracts/src/claim.ts';
import type { ProtocolError } from '../../../contracts/src/common.ts';
import type { RunRecord } from '../../../contracts/src/run.ts';
import { partitionCountsOf, type ItemResult, type LayerResult, type RequirementResult, type ValidationResult } from '../../../contracts/src/validation.ts';
import type { RunDetail } from '../../ports.ts';
import type { CallLogLine, Principal } from '../../records/api.ts';
import { UNAVAILABLE_MESSAGE } from '../../refs/api.ts';
import { canSeeRun } from '../../runs/engine/api.ts';
import { productionShareKey } from '../../records/api.ts';
import { itemCell, isAbandonedResult } from '../../runs/api.ts';
import type { ServerDeps } from '../api.ts';
import { NOT_APPLICABLE, cellText, statusText, claimFields, coverageText, terminalKind, terminalText, type LayerTerminal } from '../claims.ts';
import { countsLine, countsText } from '../text.ts';
import { code, definitions, html, link, page, pre, section, table, type Html, type PageChrome } from './html.ts';
import { actionForm, manageNav, roleOptions } from './manage.ts';

export interface PageContext {
  deps: ServerDeps;
  principal: Principal;
  admin: boolean;
  url: URL;
  chrome: (title: string) => PageChrome;
  /** The session's CSRF token, for the management forms (only the console's own requests carry one). */
  csrf?: string;
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

/** Current rule status is a view qualifier, never a replacement for the immutable receipt. */
export function ruleWithdrawalNotice(detail:Pick<RunDetail,'rule_withdrawn'>):Html{
  return detail.rule_withdrawn?html`<p class="notice"><strong>${labelOf('validity_status','rule_withdrawn')}（版本已下架）</strong>；下列回执展示生成时的状态；原摘要、分区和要求项终态保持原样，这是当前读取时的限定。</p>`:html``;
}

export function claimBlock(claim: Claim): Html {
  return html`<div class="claim">${definitions(claimFields(claim))}</div>`;
}

// ---------------------------------------------------------------- runs

/** Bind the live condition only to result claims; the claim and its receipt remain original evidence. */
export function claimBlockAtRead(ruleWithdrawn:boolean):typeof claimBlock{
  return ruleWithdrawn?claim=>html`<div class="claim">${definitions(claimFields(claim,true))}</div>`:claimBlock;
}

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
  const feedingTodos=await ctx.deps.knowledge.feeding?.todos(ctx.principal)??[];
  const requests=(await ctx.deps.runs.listRequests?.(ctx.principal)??[]).filter(r=>r.answered_by===null);
  return {
    status: 200,
    body: page(ctx.chrome('运行'), html`${section('知识喂入待办',table(['来源','缺什么','下一步','函数失败详情'],feedingTodos.map(row=>[code(JSON.stringify(row.source)),row.missing,row.next_action,row.detail?code(JSON.stringify(row.detail)): '—']),'没有待办'))}${filter}${table(['运行', '任务包', '产品 / 版本 / 构建', '开始时间', '运行者', '条目', '会话'], rows, '没有运行')}${next}${section('已到期未回答的请求',table(['请求','运行 / 包摘要','受众','原期限','缺什么','下一步'],(listing.overdue_requests??[]).map(r=>[code(r.record),code(r.run??r.pack_digest??''),code(r.audience),r.due,r.missing,r.next_action]),'没有已到期未回答的请求'))}${section('未回答的请求',table(['请求','运行 / 包摘要','种类','受众','期限','缺什么','下一步'],requests.map(r=>[code(r.record),code(r.run??r.pack_digest??''),labelOf('request_kind',r.kind),code(r.audience),r.due,r.missing,r.next_action]),'没有未回答的请求'))}`),
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

function itemTable(items: readonly ItemResult[], names: ReadonlyMap<string, string>, renderClaim:typeof claimBlock = claimBlock): Html {
  const rows: unknown[][] = [];
  for (const item of items) {
    const why = 'code' in item ? code(item.code) : 'reason' in item ? labelOf('reason', item.reason) : '';
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
        return found === undefined ? html`${labelOf('layer', layer)}：${NOT_APPLICABLE}` : html`${terminalHtml(found, terminalText(found))}${found.reason?html`<div>${found.missing??'缺失事实未写'}；${found.exit?`${found.exit.due} 前，${'user'in found.exit.audience?found.exit.audience.user:labelOf('execution_host','hub')}：${labelOf('exit_action',found.exit.action)}`:'出口未写'}</div>`:''}${found.gaps?.map(g=>html`<div>未决未知：${g.missing}；${g.exit.due} 前：${labelOf('exit_action',g.exit.action)}</div>`)??''}`;
      });
      rows.push([
        ...(index === 0 ? head : ['', '', '', '']),
        html`${r.requirement} ${names.get(r.requirement) ?? ''}`,
        html`${layers.map((text) => html`<div>${text}</div>`)}`,
        statusText(r),
        html`${r.claims.map(renderClaim)}`,
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

function partitionGroups(result: ValidationResult, run: RunRecord, renderClaim:typeof claimBlock = claimBlock): Html {
  const names = new Map(run.requirements.map((r) => [r.key, r.name]));
  const groups: Html[] = [];
  for (const group of ['adopted', 'open'] as const) {
    const members = PARTITION.filter((p) => GROUP_OF[p] === group);
    const total = members.reduce((sum, p) => sum + result.partitions[p].length, 0);
    // Display rule 6: every partition shows its count and lists its items, an empty one included.
    const parts = members.map((p) => section(`${labelOf('partition', p)}（${result.partitions[p].length}）`, itemTable(result.partitions[p], names,renderClaim)));
    groups.push(section(`${GROUP_TITLE[group]}（${members.map((p) => labelOf('partition', p)).join('、')}，${total}）`, html`${parts}`));
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
    isItemHandling(item.handling) ? `模型声明${labelOf('item_handling', item.handling)} ${String(item.item ?? '')}` : '没有可识别的模型处理声明',
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
    code(share.body.object),labelOf('share_audience',share.body.share_audience ?? 'user'),code(share.body.subject),share.body.decided_at,share.body.note ?? '—',
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
    ['锁定的知识根', run.root === undefined ? '—' : link('/console/knowledge/tree', run.root, { root: run.root, path: '/' })],
    ['运行者', run.runner === undefined ? '—' : await ctx.userName(run.runner)],
    [axisLabel('execution_host'), labelOf('execution_host', run.host)],
    [axisLabel('trigger'), labelOf('trigger', run.trigger)],
    ['配置者', run.configurer === undefined ? '—' : await ctx.userName(run.configurer)],
    ['前驱运行', run.predecessor === undefined ? '—' : link(`/console/runs/${run.predecessor}`, run.predecessor)],
    ['会话', run.session ?? '—'],
    ['开始时间', run.started_at],
    ['提交期限', run.submission_due ?? '旧运行没有记录期限，请以它为前驱开新修订'],
    ['交付', detail.latest === null ? '尚未交付' : '已有交付结果'],
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
  const factOnly=run.requirements.length>0&&run.requirements.every(requirement=>requirement.accepted_producer==='fact');
  const primary=detail.latest?.result.system_input?detail.latest:factOnly?detail.production:detail.latest;
  const renderResult=(latest:NonNullable<RunDetail['latest']>,recordLabel:string,commentary=false):Html=>{
    const result = latest.result;
    const management=isAbandonedResult(result);
    const unwritten=management?result.cross_item.find(c=>c.warrant.id==='runs.engine@1'&&c.statement.data?.run_disposition==='abandon')?.statement.data?.legacy_unwritten_fields:undefined;
    return html`<p><strong>${management?'管理放弃（不是目标通过）；':commentary ? '模型声明的分区（判断，未采用）：' : ''}${result.system_input?'系统交付；'+countsText(partitionCountsOf(result.partitions),result.partitions):countsLine(result.acceptance, result.acceptance === 'accepted' ? result.partitions : undefined)}</strong></p>
${management?html`<p>技术层未重新核验；原记录 ${typeof unwritten==='number'?unwritten:0} 处技术字段未写，原件仍显示“出口未写”；本投影出口仅引用本次真实处置请求。</p>`:''}
${definitions([
  [recordLabel, code(latest.record)],
  [result.system_input?'系统交付输入摘要':'提交摘要',code(result.submission)],
  ['修复轮数', `已用 ${result.rounds.used}，最多 ${result.rounds.max}`],
  ['覆盖', coverageText(result.coverage) ?? '—'],
  ['锁定', html`任务包 ${result.locks.pack} ${code(result.locks.pack_digest)}${result.locks.root ? html`，知识根 ${code(result.locks.root)}` : ''}${result.locks.policy ? `，政策 ${result.locks.policy}` : ''}`],
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
      s.acceptance === null ? '未校验（Hub 中断）' : labelOf('acceptance', s.acceptance),
      s.errors.length === 0 ? '' : html`${s.errors.map((e) => html`<div>${code(e.code)} ${e.message}${e.fix ? `；修正：${e.fix}` : ''}${e.rounds_left !== undefined ? `；剩余修复轮数 ${e.rounds_left}` : ''}</div>`)}`,
      s.result ?? '—',
      await submissionContent(ctx, s.record, run.run),
    ]);
  }
  const submissions = table(['提交记录', '收到时间', axisLabel('acceptance'), '错误', '校验结果', '提交内容（未经平台验证）'], submissionRows, '没有提交');
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
  return {
    status: 200,
    body: page(
      ctx.chrome(`运行 ${run.run}`),
      html`${sharedRunNotice(ctx,run)}${ruleWithdrawalNotice(detail)}${summary}
${await runSharing(ctx,run)}
${detail.management?section('管理处置',html`<p>目标已放弃；来源 ${link('/console/runs/'+run.run,'运行',{})} ${code(detail.management.record)}。${detail.management.result?'下列为管理交付，技术终态沿用原记录，未重新核验；未知计数保留，旧缺字段只引用此次真实处置请求。':'管理交付投影尚未形成，Hub 将自动重试；旧技术结果仍在原记录中。'}</p>`):''}
${section('版本依据', basis)}
${section('来源', sources)}
${section('要求项', requirements)}
${section(`条目（${run.items.length}）`, items)}
${projectedFields}
${run.criterion_changes?.length?section('判据变更声明',table(['声明 / 请求','条目 / 判据','原断言','旧值 / 新值','状态 / 复核人 / 理由','受众 / 期限','下一步'],run.criterion_changes.map(change=>[html`${code(change.declaration)}<br>${code(change.request)}`,html`${code(change.item)}<br>${code(change.criterion)}`,change.assertion,html`${pre(change.old)}${pre(change.new)}`,change.superseded_by?`由后一份提交的同名声明取代：${change.superseded_by}`:change.accepted===true?`已接受；复核人 ${change.reviewer??'未写'}；理由 ${change.reason??'未写'}`:change.accepted===false?`未接受；复核人 ${change.reviewer??'未写'}；理由 ${change.reason??'未写'}`:change.expired?'请求已过期，仍等作者以外的账号复核；新修订不带这条声明':'请求还没有回答；等作者以外的账号复核',html`${code(change.audience)}<br>${change.due}`,change.next_action]),'没有判据变更声明')):''}
${section('分区清单', results)}
${commentary}
${section('未回答的请求', table(['请求','种类','受众','期限','缺什么','下一步'], (detail.requests??[]).filter(r=>r.answered_by===null).map(r=>[code(r.record),labelOf('request_kind',r.kind),code(r.audience),r.due,r.missing,r.next_action]),'没有未回答的请求'))}
${section('提交与回执', submissions)}
${section('调用日志',html`${callTable(calls.items, ctx.admin, await names(ctx, calls.items))}<p>分页：本页 ${calls.items.length} 条${typeof calls.next==='string'?html`；${link(`/console/runs/${run.run}`,'下一页',{call_cursor:calls.next})}`:''}</p>`)}`,
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
      if (admin) row.push(line.admin_reasons?.length?html`${line.admin_note??''}<details><summary>完整理由（${line.admin_reasons.length} 条）</summary><ol>${line.admin_reasons.map(reason=>html`<li><pre>${reason}</pre></li>`)}</ol></details>`:line.admin_note??'');
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
    const unversioned = await ctx.deps.knowledge.unversionedRoot?.(line.id) ?? null;
    rows.push(['不分版本', '—', '构建未声明', '—', unversioned === null ? '—' : `1（来源 ${unversioned.source_count} 个）`,
      unversioned === null ? '—' : link('/console/knowledge/root', unversioned.root.slice(0,16), {root:unversioned.root})]);
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
      ctx.chrome('版本比较'),
      html`<p>从 ${code(from)} 到 ${code(to)}</p>
${section(`只在新根里（${diff.added.length}）`, listOf(0))}
${section(`只在旧根里（${diff.removed.length}）`, listOf(1))}
${section(`内容变了（${diff.modified.length}）`, listOf(2))}`,
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
    const id = html`<input type="hidden" name="user" value="${user.id}">`;
    userRows.push([
      code(user.id),
      user.name,
      labelOf('permission_role', user.role),
      user.disabled ? '停用' : '启用',
      yesNo(await authorizations.canPublish(user.id)),
      packs.join('、'),
      user.created_at,
      actionForm(user.disabled ? 'user-enable' : 'user-disable', ctx.csrf ?? '', id, user.disabled ? '恢复' : '停用', { inline: true }),
    ]);
    for (const token of await principals.tokens(user.id)) {
      tokenRows.push([
        code(token.id), user.name, token.label, token.created_at, token.last_used_at ?? '—', token.revoked_at ?? '有效',
        token.revoked_at === null ? actionForm('token-revoke', ctx.csrf ?? '', html`<input type="hidden" name="token" value="${token.id}">`, '撤销', { inline: true }) : '',
      ]);
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
      html`${manageNav()}
${section('用户', table(['用户', '名称', axisLabel('permission_role'), '状态', '发布权', '分配的任务包', '建立时间', '操作'], userRows))}
${actionForm('user-create', ctx.csrf ?? '', html`<label>新用户 <input name="name" required size="20"></label> <label>角色 <select name="role">${roleOptions()}</select></label>`, '新建用户')}
${section('令牌（不显示令牌值）', table(['令牌', '用户', '标签', '签发时间', '最近使用', '撤销时间', '操作'], tokenRows, '没有令牌'))}
${actionForm('token-issue', ctx.csrf ?? '', html`<label>给用户 <select name="user" required>${users.filter((user) => !user.disabled).map((user) => html`<option value="${user.id}">${user.name}</option>`)}</select></label> <label>标签（可空） <input name="label" size="20"></label>`, '签发令牌')}
<p>新令牌只在签发结果页显示一次；用户在 Circle 的 MCP 服务器设置里以 Authorization: Bearer 带上它，也用它登录控制台。</p>
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

import {chart,comparisons,parts} from './charts.ts';
import {technicalCode,stat,facts} from './presentation.ts';
// 记录 (the design canvas's Audit board): the append-only call log with its filters, the calls per day and tool, per member
// and per result over the last 14 days, and the lines themselves. Administrators see every call with the admin notes; a
// member sees their own calls only (the call log answers so itself). /console/admin/calls is the administrators' path of
// the same page (decision 122).
import { CALL_RESULT, uiLabelOf, type CallResult } from '../../../contracts/generated/vocabulary.ts';
import { TOOLS } from '../../../contracts/src/tools.ts';
import { TRIAL_REPORT_SCHEMA, TrialRecord } from '../../connectors/api.ts';
import type { CallLogLine, Page } from '../../records/api.ts';
import { href, html, link, page, pageLayout, table, type Html } from './html.ts';
import { callTable, names, neutralPage, type PageContext, type PageResult } from './pages.ts';
import { TOOL_LABELS, toolName } from './tasks.ts';
import { box, card, count, duration, kpi, when } from './ui.ts';
import { spaceRecords } from './space-records.ts';
import {credentialReviewRequests} from '../../knowledge/api.ts';

async function sourceReviews(ctx:PageContext,path:string):Promise<Html>{
 if(!ctx.admin)return html``;
 const reviews=await credentialReviewRequests(ctx.deps.records,ctx.principal,{cursor:param(ctx,'review_cursor')??null,now:ctx.deps.now?.()??new Date()});
 const rows=await Promise.all(reviews.items.map(async row=>[when(row.created_at),row.external??'对象标识未显示',await ctx.userName(row.audience),when(row.deadline),row.resolved?'已有解决记录':row.superseded?'已到期并生成后续请求':row.expired?'已到期，尚无解决记录':'等待管理员核看',technicalCode(row.reference),technicalCode(row.source)]));
 const next=reviews.next?link(path,'下一页来源核看请求',{...Object.fromEntries(ctx.url.searchParams),review_cursor:reviews.next,call:null}):'';
 return card({title:'来源核看请求',meta:'独立于调用筛选 · 仅显示当前有权访问的来源 · 本页 '+reviews.items.length+' 项'},html`<p class="ch-meta">这些请求已写入记录，不代表管理员已收到外部通知。到期不算接受；请具名接收人核对来源和当前受理决定，已有解决记录也不等于原文当前可读。</p>${table(['创建时间','来源对象','接收管理员','期限','请求进展','请求引用','原文引用'],rows,'本页没有可显示的来源核看请求')}${next}<p class="ch-meta">在 Hub 主机运行 ${technicalCode('circle-hub source held')} 查看被保留来源，按原文引用的摘要核对扫描与受理；本页不显示原文或凭据命中值。</p>`);
}

/** Trial actions are administrator-only and separate from the MCP call log and the real reads' statistics. */
async function trials(ctx: PageContext, path: string, user: string | undefined, from: string | undefined, to: string | undefined): Promise<Html> {
  if (!ctx.admin) return html``;
  const found = user === '' ? { items: [], next: null } : await ctx.deps.records.store.find({
    kind: 'action', key: user === undefined ? 'action.kind' : 'action.user', value: user ?? 'trial',
    newestFirst: true, limit: 100, cursor: param(ctx, 'trial_cursor') ?? null,
  });
  const rows = [];
  for (const record of found.items) {
    if (record.schema !== TRIAL_REPORT_SCHEMA || (from !== undefined && record.created_at < from) || (to !== undefined && record.created_at > to)) continue;
    const parsed = TrialRecord.safeParse(record.body);
    if (!parsed.success) {
      rows.push([when(record.created_at), uiLabelOf('action_kind', 'trial'), '记录格式不可读', '', '', '', '']);
      continue;
    }
    const body = parsed.data;
    const outcome = (ok: boolean | null) => uiLabelOf('action_result', ok === null ? 'unknown' : ok ? 'completed' : 'error');
    const routes = body.routes.map((r) => [r.route, r.tried ? outcome(r.ok) : '未尝试读取', r.status === null ? '—' : `HTTP ${r.status}`, r.code ?? '—', r.ms === null ? '—' : duration(r.ms)]);
    rows.push([when(body.started_at), uiLabelOf('action_kind', body.action), await ctx.userName(body.principal), technicalCode(`${body.system_pack.id}@${body.system_pack.version}`),
      uiLabelOf('environment', body.environment), body.auth.sent ? `${outcome(body.auth.ok)}${body.auth.code === null ? '' : ` · ${body.auth.code}`}` : '未发送登录',
      html`<details><summary>${body.routes.length} 个接口</summary>${table(['接口', '结果', '状态码', '错误码', '耗时'], routes, '没有接口')}<p class="ch-meta">结束于 ${body.ended_at}</p></details>`,
    ]);
  }
  const next = found.next === null ? html`` : link(path, '下一页尝试读取记录', {...Object.fromEntries(ctx.url.searchParams),trial_cursor:found.next,call:null});
  return card({ title: `${uiLabelOf('action_kind', 'trial')}记录`, meta: '仅管理员可见 · 新的在前' },
    html`${table(['开始时间', '操作', '成员', uiLabelOf('pack_kind', 'system'), '环境', '登录', '接口结果'], rows, '本页没有尝试读取记录')}${next}`);
}

const param = (ctx: PageContext, name: string): string | undefined => {
  const value = ctx.url.searchParams.get(name);
  return value === null || value === '' ? undefined : value;
};

function isoOrUndefined(value: string | undefined): string | undefined | null {
  if (value === undefined) return undefined;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

const STATS_LIMIT = 500;
const RESULT_FILL: Readonly<Record<CallResult, string>> = { ok: 'fill-pass', error: 'fill-fail', transport_failure: 'fill-incomplete' };

/** The figures of the period and its charts, from one read of the call log: the figures head two tabs, the charts are one. */
async function statistics(ctx:PageContext,now:number,daysCount:number,query:Parameters<PageContext['deps']['records']['callLog']['query']>[1]):Promise<{figures:Html;charts:Html}>{
 let found:Page<CallLogLine>;try{found=query?.userId===''?{items:[],next:null}:await ctx.deps.records.callLog.query(ctx.principal,{...query,limit:STATS_LIMIT,cursor:null});}catch{return {figures:card({title:'统计'},html`<p class="error">统计暂不可用</p>`),charts:html``};}
 const items=found.items,scope=found.next?`所选时段最近 ${STATS_LIMIT} 次调用`:'所选时段',errors=items.filter(line=>line.call_result!=='ok').length,refused=items.filter(line=>line.acceptance==='not_accepted').length;
 const kpis=html`<section class="ch-stats">${kpi('工具调用',items.length,{note:scope})}${kpi('提交结果',items.filter(line=>line.tool==='submit_result').length,{note:'其中未受理 '+refused+' 次'})}${kpi('调用出错',errors)}${kpi(ctx.admin?'成员':'本人',new Set(items.map(line=>line.user).filter(Boolean)).size)}</section>`;
 const end=query?.to?Date.parse(query.to):now,start=query?.from?Date.parse(query.from):end-daysCount*86400000;
 const first=new Date(start);first.setHours(0,0,0,0);const dayCount=Math.max(1,Math.ceil((end-first.getTime())/86400000)),long=dayCount>31,n=long?31:dayCount;
 const tools=TOOLS.map(tool=>tool.name),groups=[...tools.slice(0,3).map(tool=>[tool]),tools.slice(3)];
 const series=groups.map((group,index)=>({label:index===3?'其他':toolName(group[0]),className:'s'+(index+1)}));
 const points=Array.from({length:n},(_,i)=>{const date=new Date(first);date.setDate(date.getDate()+i);const next=new Date(date);next.setDate(next.getDate()+1);const at=long?start+i*(end-start)/n:date.getTime(),until=long?start+(i+1)*(end-start)/n:next.getTime();return {label:long?new Date(at).toISOString()+' 至 '+new Date(until).toISOString():date.getFullYear()+'-'+String(date.getMonth()+1).padStart(2,'0')+'-'+String(date.getDate()).padStart(2,'0'),values:groups.map((group,index)=>items.filter(line=>(index===3?!tools.slice(0,3).includes(line.tool):group.includes(line.tool))&&Date.parse(line.at)>=at&&Date.parse(line.at)<until).length)};});
 const distribution=chart('工具调用趋势',points,series,'line',scope+'；其他：'+groups[3].map(toolName).join('、')+'及协议调用',long?'时段':'日期');
 const totals=new Map<string,number>();for(const line of items)if(line.user)totals.set(line.user,(totals.get(line.user)??0)+1);
 const top=await Promise.all([...totals].sort((a,b)=>b[1]-a[1]).slice(0,6).map(async([user,value])=>({label:await ctx.userName(user),value})));
 const statuses=CALL_RESULT.map(result=>({label:uiLabelOf('call_result',result),value:items.filter(line=>line.call_result===result).length,className:RESULT_FILL[result]}));
 return {figures:kpis,charts:html`<section data-columns="2">${distribution}<div class="ch-section">${ctx.admin&&top.length?comparisons('按成员',top,scope+'；最多显示调用次数前 6 名'):''}${parts(statuses,'调用状态')}</div></section>`};
}

/** The tabs of the records page (decision 151), in the order shown; the last two are the administrators'. */
const RECORD_TABS = ['calls', 'stats', 'sharing', 'trials', 'reviews'] as const;
type RecordTab = typeof RECORD_TABS[number];
const RECORD_TAB_LABEL: Record<RecordTab, string> = { calls: '调用记录', stats: '统计', sharing: '分享记录', trials: `${uiLabelOf('action_kind', 'trial')}记录`, reviews: '来源核看请求' };
const ADMIN_TABS: readonly RecordTab[] = ['trials', 'reviews'];

/** The records page at `path` (/console/records, or /console/admin/calls for administrators only). */
export async function recordsPage(ctx: PageContext, path: '/console/records' | '/console/admin/calls'): Promise<PageResult> {
  if (path === '/console/admin/calls' && !ctx.admin) return neutralPage(ctx);
  const user = ctx.admin ? param(ctx, 'user') : undefined;
  const tool = param(ctx, 'tool');
  const run = param(ctx, 'run');
  const rawDays=Number(param(ctx,'days')??'14'),days=[7,14,30].includes(rawDays)?rawDays:14;
  const now=(ctx.deps.now?.()??new Date()).getTime();
  const from = isoOrUndefined(param(ctx, 'from'));
  const to = isoOrUndefined(param(ctx, 'to'));
  const beginning=new Date(now);beginning.setDate(beginning.getDate()-(days-1));beginning.setHours(0,0,0,0);
  const rangeFrom=from??beginning.toISOString(),rangeTo=to??new Date(now+1).toISOString();
  const cursor = param(ctx, 'cursor');
  const problems: string[] = [];
  if (from === null) problems.push('“从”不是时间');
  if (to === null) problems.push('“到”不是时间');
  if(Date.parse(rangeFrom)>=Date.parse(rangeTo))problems.push('结束时间须晚于开始时间');
  let userId: string | undefined;
  if (user !== undefined) {
    userId = /^usr_[0-9a-z]{26}$/.test(user) ? user : ((await ctx.deps.records.principals.findByName(user))?.id ?? '');
  }
  // Decision 151, step 7: one list a tab. A selected call opens the call list; the filters a tab does not use are not shown on it.
  const selectedDigest=param(ctx,'call');
  const tabsOf = RECORD_TABS.filter((key) => ctx.admin || !ADMIN_TABS.includes(key));
  const tab: RecordTab = selectedDigest ? 'calls' : tabsOf.find((key) => key === param(ctx, 'tab')) ?? 'calls';
  const byCall = tab === 'calls' || tab === 'stats', filtered = tab !== 'reviews';
  const kept = { ...(ctx.admin ? { user } : {}), ...(byCall ? { tool, run } : {}), from: param(ctx, 'from'), to: param(ctx, 'to') };
  const toolOptions = html`<option value="">全部工具</option>${TOOLS.map((t) => html`<option value="${t.name}"${t.name === tool ? html` selected` : ''}>${t.label}</option>`)}${tool !== undefined && !TOOL_LABELS.has(tool) ? html`<option value="${tool}" selected>${tool}</option>` : ''}`;
  const filters = html`<form class="ch-actions" data-filters method="get" action="${path}"><input type="hidden" name="days" value="${days}">${tab === 'calls' ? '' : html`<input type="hidden" name="tab" value="${tab}">`}
${ctx.admin ? html`<label>成员 <input name="user" value="${user ?? ''}"></label>` : ''}${byCall ? html`<label>工具 <select name="tool">${toolOptions}</select></label>
<label>运行 <input name="run" value="${run ?? ''}"></label>` : ''}<label>从 <input name="from" value="${param(ctx, 'from') ?? ''}" placeholder="2026-11-01"></label>
<label>到 <input name="to" value="${param(ctx, 'to') ?? ''}"></label><button class="ch-btn ch-btn--secondary" type="submit">筛选</button></form>`;
  const chrome = ctx.chrome('记录', { active: 'records', hint: ctx.admin ? '操作与校验记录仅追加、不可修改，可按成员、工具、运行与时间筛选' : '仅显示与本人相关的调用；记录仅追加、不可修改' });
  if (problems.length > 0 || from === null || to === null) {
    return { status: 400, body: page(chrome, html`${card(null, html`${filters}<p class="error">${problems.join('；')}</p>`)}`) };
  }
  const lines =
    userId === '' || tab !== 'calls'
      ? { items: [], next: null }
      : await ctx.deps.records.callLog.query(ctx.principal, {
          ...(userId === undefined ? {} : { userId }),
          ...(tool === undefined ? {} : { tool }),
          ...(run === undefined ? {} : { runId: run }),
          ...(rangeFrom?{from:rangeFrom}:{}),
          ...(rangeTo?{to:rangeTo}:{}),
          limit: 100,
          cursor: cursor ?? null,
        });
  const next = lines.next === null ? html`` : html`<p>${link(path, '下一页', { ...kept, days, cursor: lines.next })}</p>`;
  const selected=selectedDigest?lines.items.find(line=>line.digest===selectedDigest):undefined;
  if(selectedDigest&&!selected)return neutralPage(ctx);
  const inspector=selected?html`<div data-inspector-content><span class="ch-tag">调用记录</span><h2 class="ch-panel-title">${toolName(selected.tool)}</h2>${facts([['时间',when(selected.at)],['成员',await ctx.userName(selected.user)],['调用结果',uiLabelOf('call_result',selected.call_result)],['受理结果',selected.acceptance?uiLabelOf('acceptance',selected.acceptance):'—'],['错误码',selected.error_code??'—'],['耗时',duration(selected.duration_ms)],['任务',selected.run?link('/console/runs/'+selected.run,'查看任务'):'—']])}${ctx.admin&&selected.admin_note?card({title:'管理员备注'},html`<p>${selected.admin_note}</p>`):''}${technicalCode(JSON.stringify(selected,null,2))}</div>`:null;
  const tabs = html`<nav class="ch-seg" aria-label="记录内容" data-record-tabs>${tabsOf.map((key) => html`<a href="${href(path, { ...kept, ...(key === 'calls' || key === 'stats' ? {} : { tool: undefined, run: undefined }), ...(days === 14 ? {} : { days }), ...(key === 'calls' ? {} : { tab: key }) })}"${key === tab ? html` aria-current="page"` : ''}>${RECORD_TAB_LABEL[key]}</a>`)}</nav>`;
  const period = html`<nav class="ch-seg" aria-label="时间范围">${[7,14,30].map(value=>html`<a href="${href(path,{...(ctx.admin?{user}:{}),...(byCall?{tool,run}:{}),days:value,...(tab==='calls'?{}:{tab})})}"${value===days&&!from&&!to?html` aria-current="page"`:''}>近 ${value} 天</a>`)}</nav>`;
  const stats = byCall ? await statistics(ctx,now,days,{userId,tool,runId:run,from:rangeFrom,to:rangeTo}) : null;
  const content = tab === 'calls' ? html`${stats!.figures}<p class="ch-meta" data-tab-facts>本页 ${lines.items.length.toLocaleString('en-US')} 条 · 新的在前</p>${box(null, html`${callTable(lines.items, ctx.admin, await names(ctx, lines.items),{path,params:Object.fromEntries(ctx.url.searchParams),selected:selected?.digest,compact:true})}${next}`, { flush: true })}`
    : tab === 'stats' ? html`${stats!.figures}${stats!.charts}`
    : tab === 'sharing' ? await spaceRecords(ctx,path,userId,rangeFrom,rangeTo)
    : tab === 'trials' ? await trials(ctx,path,userId,rangeFrom,rangeTo)
    : await sourceReviews(ctx,path);
  return {
    status: 200,
    body: page(chrome,pageLayout(html`<div class="ch-stack" data-records>${tabs}${filtered ? html`<div class="ch-toolbar">${period}${filters}</div>` : ''}<div class="ch-stack" data-record-tab="${tab}">${content}</div></div>`,{inspector,detail:!!selected,back:link(path,'返回记录',Object.fromEntries([...ctx.url.searchParams].filter(([key])=>key!=='call')))})),
  };
}

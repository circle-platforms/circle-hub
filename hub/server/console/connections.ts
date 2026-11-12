import {dot} from './ui.ts';
import {technical,technicalCode,stat,facts,actionLink,evidence,tooltip} from './presentation.ts';
// 连接 (the design canvas's Connections board): the Circles connected with a token, the business systems the Hub reads
// (resources, administrators only: the catalog gives others none) and the runtime environments dispatch jobs go to (the
// registered executors, administrators only). The Hub only reads business systems; a write route is never opened here.
// Enabling, disabling and re-authenticating a system or an environment are commands for the administrator's Circle
// (proposal decision 6 of 2026-10-31); connecting a business system is one of the console's four operations.
import { ENVIRONMENT_STATE, axisUiLabel, isEnvironment, uiLabelOf, type EnvironmentState } from '../../../contracts/generated/vocabulary.ts';
import type { TokenInfo } from '../../records/api.ts';
import type { ExecutorView } from '../api.ts';
import type { ResourceListing } from '../../ports.ts';
import { commands } from './commands.ts';
import { connectedClients, connectionText, clientLabel, nameOrigin, type ConnectedClient } from './circles.ts';
import {tokensForMembers} from './member-reads.ts';
import { code, emptyAction, html, icon, link, liveModule, page, pageLayout, table, href, type Html } from './html.ts';
import { neutralPage, type PageContext, type PageResult } from './pages.ts';
import { readsText, systemReads } from './trial.ts';
import { packSources } from './pack-sources.ts';
import { box, button, callout, chip, commandLink, commandModal, duration, when, type CommandDialog, type DotState, type Tone } from './ui.ts';
import { byId, shownVersion } from './packs.ts';

export type Circle = ConnectedClient;

/** The tabs of the connections page, in the order shown. */
const CONNECTION_TABS = ['systems', 'packs', 'clients', 'environments'] as const;
type ConnectionTab = typeof CONNECTION_TABS[number];
const CONNECTION_TAB_LABEL: Record<ConnectionTab, string> = { systems: '业务系统', packs: uiLabelOf('pack_kind', 'system'), clients: '客户端', environments: '运行环境' };

const DAY = 86_400_000;

export async function circlesOf(ctx: PageContext): Promise<Circle[]> {
  const users = ctx.admin ? await ctx.deps.records.principals.list() : [{ id: ctx.principal.id, name: ctx.principal.name, disabled: false }];
  const enabled=users.filter(user=>!user.disabled),principals=ctx.deps.records.principals;
  const tokens=await tokensForMembers(principals,enabled.map(user=>user.id));
  const rows: { token: TokenInfo; owner: string }[] = [];
  for (const user of users) {
    if (user.disabled) continue;
    for (const token of tokens.get(user.id)??[]) if (token.revoked_at === null) rows.push({ owner: user.name, token });
  }
  const out = await connectedClients(ctx.deps.records, rows);
  return out.sort((a, b) => (b.token.last_used_at ?? '').localeCompare(a.token.last_used_at ?? ''));
}

/** The columns of a connected-client list, shared by 连接 and 团队. */
export const CLIENT_COLUMNS = ['客户端', '成员', '连接方式', '最近凭据使用'] as const;
export const noClients = (admin: boolean) => ({ title: '尚无已登记的客户端', text: '有效客户端凭据列在这里；名称取最近报告、登记名称或令牌标签，不表示当前在线。', action: admin ? emptyAction('/console/team', '打开团队') : emptyAction('/console/settings#mine', '查看连接配置') });
export function clientRow(item: ConnectedClient, name: Html): unknown[] {
  return [name, item.owner, connectionText(item), item.token.last_used_at===null?'未记录':when(item.token.last_used_at)];
}
/** One connection in the Inspector: what it reported and how it connected; where the name came from only in the details. */
export function clientInspector(item: ConnectedClient): Html {
  return html`<span class="ch-tag">客户端</span><h2 class="ch-panel-title">${evidence(item.name)}</h2>${facts([['客户端版本', item.version ? evidence(item.version) : '未报告'], ['成员', item.owner], ['连接方式', connectionText(item)], ['最近凭据使用', item.token.last_used_at===null?'未记录':when(item.token.last_used_at)], ['最近报告名称', item.reported ? when(item.reported.at) : '未报告']])}<p class="ch-meta">此项来自有效凭据和客户端声明，不代表实时在线；未记录不表示离线。</p>${technical(facts([['名称来源', nameOrigin(item)], ['令牌', code(item.token.id)], ...(item.connection.kind === 'oauth' ? [['已登记的客户端', code(item.connection.client)] as [string, unknown]] : [])]))}`;
}

const shortJob = (job: string): string => job.slice(0, 12);


/**
 * A runtime environment's state on the page, from the facts the dispatch journal establishes (ExecutorView.state):
 * 已停用 when disabled; 未知 when its occupancy could not be read; 已冻结 when a job holding it waits for a disposition of
 * an unconfirmed result, or a job left it unrestored (an open bed hold); 使用中 when a job holds it; 可用 otherwise.
 * `detail` says why, one line each.
 */
export function environmentState(view: ExecutorView): { code: EnvironmentState; text: string; tone: Tone; dot: DotState; detail: string[] } {
  const as = (code: EnvironmentState, tone: Tone, dot: DotState, detail: string[]) => ({ code, text: uiLabelOf('environment_state', code), tone, dot, detail });
  const state = view.state;
  if (!view.enabled) {
    const waiting = state?.holding?.filter((job) => job.frozen).length ?? 0;
    return as('deactivated', 'unchecked', 'idle', waiting > 0 ? [`仍有 ${waiting} 个作业的派发结果未确认，等待处置中`] : []);
  }
  if (state === undefined || !state.known.occupancy || state.holding === null) {
    return as('unknown', 'unknown', 'unknown', state !== undefined && state.missing.length > 0 ? [...state.missing] : ['占用与冻结状态暂不可读']);
  }
  const frozen = state.holding.filter((job) => job.frozen);
  const detail: string[] = [];
  for (const job of frozen) detail.push(`作业 ${shortJob(job.job)} 的派发结果未确认，等待处置中`);
  if (state.bed_hold !== null) detail.push(`作业 ${shortJob(state.bed_hold.job)} 结束后运行环境未恢复（${state.bed_hold.bed}），等待管理员确认中`);
  if (frozen.length > 0 || state.bed_hold !== null) return as('frozen', 'fail', 'down', detail);
  if (state.holding.length > 0) return as('in_use', 'judgment', 'info', state.holding.map((job) => `作业 ${shortJob(job.job)}（${axisUiLabel('effect_outcome')}：${uiLabelOf('effect_outcome', job.outcome)}）`));
  return as('available', 'pass', 'ok', []);
}

/** The note under the environments count: how many are in use, frozen, disabled or unknown. */
function environmentNote(executors: readonly ExecutorView[]): string {
  const counts = new Map<EnvironmentState, number>();
  for (const e of executors) {
    const code = environmentState(e).code;
    counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  const head = `${uiLabelOf('environment_state', 'available')} ${(counts.get('available') ?? 0).toLocaleString('en-US')} 个，共 ${executors.length.toLocaleString('en-US')} 个`;
  const parts = ENVIRONMENT_STATE.filter((code) => code !== 'available' && (counts.get(code) ?? 0) > 0).map((code) => `${uiLabelOf('environment_state', code)} ${counts.get(code)}`);
  return parts.length > 0 ? `${head}；${parts.join('，')}` : head;
}

/** Addresses allowed in plaintext that are not among the system's own addresses, where each is already marked. */
const plaintextElsewhere=(resource:ResourceListing):string[]=>(resource.allow_plaintext??[]).filter(origin=>!Object.values(resource.origins??{}).includes(origin));

function systemState(resource: ResourceListing): { text: string; tone: Tone; dot: DotState } {
  if (resource.binding_error !== undefined) return { text: '配置有误', tone: 'fail', dot: 'down' };
  return resource.enabled ? { text: '启用', tone: 'pass', dot: 'ok' } : { text: '已停用', tone: 'unchecked', dot: 'idle' };
}

/** Read-only lists and a single authorized selection share one inspector. */
export async function connectionsPage(ctx:PageContext):Promise<PageResult>{
 const now=(ctx.deps.now?.()??new Date()).getTime(),circles=await circlesOf(ctx),resources=ctx.admin?await ctx.deps.resources.list(ctx.principal):[];
 let executors:ExecutorView[]|null=null,executorsFailed=false;
 if(ctx.admin&&ctx.deps.dispatch){try{executors=await ctx.deps.dispatch.executors(ctx.principal);}catch{executorsFailed=true;}}
 const systemId=ctx.url.searchParams.get('system'),circleId=ctx.url.searchParams.get('circle'),environmentId=ctx.url.searchParams.get('environment');
 const chosen=resources.find(resource=>resource.id===systemId),circle=circles.find(circle=>circle.token.id===circleId),environment=executors?.find(executor=>executor.id===environmentId);
 if([systemId,circleId,environmentId].filter(Boolean).length>1||systemId&&!chosen||circleId&&!circle||environmentId&&!environment)return neutralPage(ctx);
 const recent=circles.filter(circle=>circle.token.last_used_at!==null&&now-Date.parse(circle.token.last_used_at)<DAY).length;
 // Decision 151, step 7: one list a tab instead of four lists down one page. A selected system, client or environment opens
 // its own tab; members see their clients only, the other three lists being the administrator's.
 const asked=ctx.url.searchParams.get('tab');
 const tab:ConnectionTab=!ctx.admin?'clients':chosen?'systems':circle?'clients':environment?'environments':CONNECTION_TABS.find(key=>key===asked)??'systems';
 const listings=ctx.admin?await ctx.deps.packs.list(ctx.principal):[];
 const systemPacks=new Map([...byId(listings).values()].map(shownVersion).filter(pack=>pack.kind==='system').map(pack=>[pack.id,pack]));
 // A system names the access it was configured from by that access's title; its identifier stays in the pane's technical details.
 const systemPackTitle=(resource:ResourceListing)=>{const pack=systemPacks.get(resource.system_pack.split('@')[0]);return pack?link('/console/packs/'+pack.id,pack.title):'未找到';};
 const counts:Partial<Record<ConnectionTab,number>>={systems:resources.length,packs:systemPacks.size,clients:circles.length,...(executors?{environments:executors.length}:{})};
 const tabs=ctx.admin?liveModule('connections',['member.connected','system.added','system.status','environment.status'],html`<nav class="ch-seg" aria-label="连接内容" data-connection-tabs>${CONNECTION_TABS.map(key=>html`<a href="${href('/console/connections',key==='systems'?{}:{tab:key})}"${key===tab?html` aria-current="page"`:''}>${CONNECTION_TAB_LABEL[key]}${counts[key]===undefined?'':html` <span class="ch-count">${counts[key]!.toLocaleString('en-US')}</span>`}</a>`)}</nav>`):html``;
 // The reads of the last day are worked out only where they show: the list of systems, or the pane of a selected one.
 const reads=tab==='systems'?await systemReads(ctx,resources.map(resource=>resource.id)):new Map<string,never>();
 const systems=ctx.admin?table(['系统',uiLabelOf('pack_kind','system'),'环境','访问地址','访问方式','状态',tooltip('近 24 小时读取','读取次数取自读取清单，耗时为已完成读取从开始到结束的时间中位数。')],resources.map(resource=>{const state=systemState(resource);return [link('/console/connections',resource.name,{system:resource.id}),systemPackTitle(resource),isEnvironment(resource.environment)?uiLabelOf('environment',resource.environment):resource.environment,resource.origins?html`${Object.entries(resource.origins).map(([role,origin])=>html`<div>${role}：${origin}${resource.allow_plaintext?.includes(origin)?html` <span class="ch-meta">明文 http</span>`:''}</div>`)}`:'未配置',html`${chip('只读','judgment')}${plaintextElsewhere(resource).length?html`<p class="ch-meta">明文 http：${plaintextElsewhere(resource).join('、')}</p>`:''}`,html`${chip(state.text,state.tone)}${resource.binding_error?html`<p class="error">${resource.binding_error.message}</p>`:''}`,reads===null?'暂不可用':readsText(reads.get(resource.id))];}),'尚无业务系统',undefined,{selected:resources.findIndex(resource=>resource.id===systemId),hrefs:resources.map(resource=>href('/console/connections',{system:resource.id}))}):html`<p class="ch-meta">业务系统的配置仅管理员可见；任务中的读取显示在各任务的执行过程中。</p>`;
 const period=reads===null?undefined:[...reads.values()][0];
 const systemFacts=html`<p class="ch-meta" data-tab-facts>已启用 ${resources.filter(resource=>resource.enabled).length.toLocaleString('en-US')} 个，共 ${resources.length.toLocaleString('en-US')} 个${period?html` · 统计时段 ${when(period.since)} 至 ${when(period.until)}`:''}</p>`;
 const environmentRows=(executors??[]).map(executor=>{const state=environmentState(executor),latest=executor.state?.latest,calls=executor.calls_24h;let gateway=executor.endpoint;try{gateway=new URL(gateway).origin;}catch{/* Preserve the recorded endpoint. */}return [link('/console/connections',executor.target,{environment:executor.id}),technicalCode(executor.id),executor.state?.known.version?executor.state.reported_version?technicalCode(executor.state.reported_version):'未上报':'未知',gateway,executor.resources.length,executor.state?.known.latest?latest?html`${latest.run?link('/console/runs/'+latest.run,when(latest.at)):when(latest.at)}<div class="ch-meta">${uiLabelOf('effect_outcome',latest.outcome)}${latest.frozen?' · 派发结果未确认':''}</div>`:'尚无派发':'未知',calls?calls.calls===0&&!calls.partial?'近 24 小时无调用':html`${calls.partial?'至少 ':''}${calls.calls} 次<div class="ch-meta">中位 ${calls.median_ms===null?'未知':duration(calls.median_ms)} · 最慢 ${calls.slowest_ms===null?'未知':duration(calls.slowest_ms)}</div>`:'暂不可用',html`${chip(state.text,state.tone)}${state.detail.map(line=>html`<p class="ch-meta">${line}</p>`)}`];});
 const environments=!ctx.admin?html`<p class="ch-meta">运行环境仅管理员可见。</p>`:executors===null?html`<p class="ch-meta">${executorsFailed?'运行环境列表暂不可用。':'这个 Hub 进程未接入派发；运行环境在运行 Hub 的服务器上以 circle-hub executor 登记。'}</p>`:table(['运行环境','执行器','执行器版本','网关','资源','最近派发','响应时间','状态'],environmentRows,{title:'尚无运行环境',text:'在运行 Hub 的服务器上以 circle-hub executor 登记后列在这里。'},undefined,{selected:executors.findIndex(executor=>executor.id===environmentId),hrefs:executors.map(executor=>href('/console/connections',{environment:executor.id}))});
 const dialogs:CommandDialog[]=[];let inspector:Html;
 if(chosen){const toggle=commands.resourceToggle(chosen),relogin=commands.resourceResetLogin(chosen);dialogs.push(toggle,relogin);inspector=html`<div data-inspector-content><div class="ch-actions"><span class="ch-tag">业务系统</span>${chip(systemState(chosen).text,systemState(chosen).tone)}</div><h2 class="ch-panel-title">${chosen.name}</h2>${facts([['环境',isEnvironment(chosen.environment)?uiLabelOf('environment',chosen.environment):chosen.environment],['访问方式','只读'],['访问地址',html`${Object.values(chosen.origins??{}).map(origin=>html`<p>${origin}</p>`)}`],['近 24 小时读取',reads===null?'暂不可用':readsText(reads.get(chosen.id))]])}${technical(html`${code(chosen.id)} ${code(chosen.system_pack)}`)}<footer class="ch-inspector-actions">${commandLink(toggle,chosen.enabled?'停用…':'启用…',chosen.enabled?'ch-btn ch-btn--danger':'ch-btn ch-btn--secondary')}${commandLink(relogin,'重新认证…')}</footer></div>`;
 }else if(circle){const revoke=commands.tokenRevoke(circle.token,circle.owner);if(ctx.admin)dialogs.push(revoke);inspector=html`<div data-inspector-content>${clientInspector(circle)}<footer class="ch-inspector-actions">${ctx.admin?commandLink(revoke,'断开…','ch-btn ch-btn--danger'):'由管理员断开'}</footer></div>`;
 }else if(environment){const state=environmentState(environment),actions:Html[]=[];
  if(environment.enabled){const disable=commands.executorDisable(environment);dialogs.push(disable);actions.push(commandLink(disable,'停用…','ch-btn ch-btn--danger'));}
  if(environment.state?.bed_hold){const clear=commands.bedHoldClear(environment);dialogs.push(clear);actions.push(commandLink(clear,'确认已恢复…'));}
  const frozen=environment.state?.holding?.find(job=>job.frozen);if(frozen){const dispose=commands.jobDispose(frozen.job);dialogs.push(dispose);actions.push(commandLink(dispose,'处置派发结果…','ch-btn ch-btn--danger'));if(frozen.run)actions.push(link('/console/runs/'+frozen.run,'查看任务'));}
  inspector=html`<div data-inspector-content><div class="ch-actions"><span class="ch-tag">运行环境</span>${chip(state.text,state.tone)}</div><h2 class="ch-panel-title">${environment.target}</h2>${state.detail.map(line=>html`<p>${line}</p>`)}${facts([['资源',environment.resources.length],['网关',environment.endpoint]])}${technicalCode(environment.id)}<footer class="ch-inspector-actions">${actions}</footer></div>`;
 }else inspector=html``;
 // Decision 151: with nothing selected there is no pane. The figures it repeated stand in the row at the top of the page.
 const selected=!!(chosen||circle||environment);
 const clients=liveModule('circles',['member.connected'],html`<p class="ch-meta" data-tab-facts>${tooltip(`24 小时内使用过 ${recent.toLocaleString('en-US')} 个`,'每行对应有效凭据；名称优先取最近报告，其次登记名称或令牌标签。最近凭据使用不是在线状态，未记录不表示离线。')}</p>${box(null,table(CLIENT_COLUMNS,circles.map(item=>clientRow(item,link('/console/connections',clientLabel(item),{circle:item.token.id}))),noClients(ctx.admin),undefined,{selected:circles.findIndex(item=>item.token.id===circleId),hrefs:circles.map(item=>href('/console/connections',{circle:item.token.id}))}),{flush:true})}${ctx.admin?'':html`<p class="ch-meta">业务系统和运行环境的配置仅管理员可见；任务中的读取显示在各任务的执行过程中。</p>`}`);
 const content=tab==='clients'?clients
  :tab==='systems'?liveModule('systems',['system.added','system.status'],html`${systemFacts}${box(null,systems,{flush:true})}`)
  :tab==='packs'?await packSources(ctx,'system',resources,{listings,bare:true})
  :liveModule('environments',['environment.status'],html`${executors?.length?html`<p class="ch-meta" data-tab-facts>${environmentNote(executors)}</p>`:''}${box(null,environments,{flush:true})}`);
 const body=html`<div class="ch-stack" data-connections>${tabs}<div data-connection-tab="${tab}">${content}</div></div>`;
 return {status:200,body:page(ctx.chrome('连接',{active:'connections',hint:'业务系统只读访问，写操作尚未开放；运行环境的占用与冻结取派发记录；读取与响应时间接口仅提供近 24 小时，未推断更长时段。',actions:ctx.admin?html`${button('/console/operations/pack',`发布${uiLabelOf('pack_kind','system')}`,{params:{kind:'system'},icon:'upload'})}${button('/console/operations/system','接入业务系统',{primary:true,icon:'plus'})}`:html``}),pageLayout(body,{inspector:selected?liveModule('connection-inspector',['member.connected','system.added','system.status','environment.status'],html`${inspector}${dialogs.map(commandModal)}`):null,detail:selected,back:link('/console/connections','返回连接')}))};
}

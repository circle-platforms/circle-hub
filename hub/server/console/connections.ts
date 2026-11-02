import {dot} from './ui.ts';
import {technical,technicalCode,stat,facts,actionLink} from './presentation.ts';
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
import { circleName } from './circles.ts';
import { code, html, icon, link, liveModule, logo, page, pageLayout, table, href, type Html } from './html.ts';
import { neutralPage, type PageContext, type PageResult } from './pages.ts';
import { readsText, systemReads } from './trial.ts';
import { packSources } from './pack-sources.ts';
import { button, callout, card, chip, commandLink, commandModal, duration, kpi, plannedCard, sectionHead, seg, when, type CommandDialog, type DotState, type Tone } from './ui.ts';

export interface Circle {
  name: string;
  owner: string;
  token: TokenInfo;
}

const DAY = 86_400_000;

export async function circlesOf(ctx: PageContext): Promise<Circle[]> {
  const users = ctx.admin ? await ctx.deps.records.principals.list() : [{ id: ctx.principal.id, name: ctx.principal.name, disabled: false }];
  const out: Circle[] = [];
  for (const user of users) {
    if (user.disabled) continue;
    for (const token of await ctx.deps.records.principals.tokens(user.id)) if (token.revoked_at === null) out.push({ name: await circleName(ctx.deps.records.principals,token), owner: user.name, token });
  }
  return out.sort((a, b) => (b.token.last_used_at ?? '').localeCompare(a.token.last_used_at ?? ''));
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
  const head = `${uiLabelOf('environment_state', 'available')} / 全部`;
  const parts = ENVIRONMENT_STATE.filter((code) => code !== 'available' && (counts.get(code) ?? 0) > 0).map((code) => `${uiLabelOf('environment_state', code)} ${counts.get(code)}`);
  return parts.length > 0 ? `${head}；${parts.join('，')}` : head;
}

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
 const kpis=html`<section class="ch-stats">${kpi('已连接的 Circle',circles.length,{note:`24 小时内使用过 ${recent} 个`})}${kpi('业务系统',ctx.admin?resources.filter(resource=>resource.enabled).length:'—',{note:ctx.admin?`启用 / 全部 ${resources.length}`:'仅管理员可见'})}${kpi('运行环境',ctx.admin&&executors?executors.filter(executor=>environmentState(executor).code==='available').length:'—',{note:ctx.admin?executors?environmentNote(executors):executorsFailed?'暂不可用':'派发未接入':'仅管理员可见'})}${kpi('业务系统写操作','未开放')}</section>`;
 const topology=card({title:'连接拓扑',hint:'Circle 经 MCP 连接 Hub；Hub 只读访问业务系统，未记录的单项连线不推断'},html`<div class="ch-connection-map"><section class="ch-section"><h3 class="ch-section-label">已连接的 Circle</h3>${circles.length?html`<ul class="ch-list">${circles.slice(0,5).map(item=>html`<li class="ch-row">${link('/console/connections',item.name,{circle:item.token.id})}</li>`)}</ul>`:'尚无已连接的 Circle'}</section><section class="ch-section"><div class="ch-actions">${logo()}<b>circle-hub</b></div><span class="ch-meta">MCP 服务</span></section><section class="ch-section"><h3 class="ch-section-label">业务系统</h3>${ctx.admin?resources.length?html`<ul class="ch-list">${resources.slice(0,5).map(item=>html`<li class="ch-row">${link('/console/connections',item.name,{system:item.id})}</li>`)}</ul>`:'尚无业务系统':'业务系统仅管理员可见'}</section></div>`);
 const reads=await systemReads(ctx,resources.map(resource=>resource.id));
 const systems=ctx.admin?table(['系统',uiLabelOf('pack_kind','system'),'环境','访问地址','访问方式','状态','近 24 小时读取'],resources.map(resource=>{const state=systemState(resource);return [link('/console/connections',resource.name,{system:resource.id}),technicalCode(resource.system_pack),isEnvironment(resource.environment)?uiLabelOf('environment',resource.environment):resource.environment,resource.origins?html`${Object.entries(resource.origins).map(([role,origin])=>html`<div>${role}：${origin}</div>`)}`:'—',html`${chip('只读','judgment')}${resource.allow_plaintext?.length?html`<span class="ch-meta"> 明文 http：${resource.allow_plaintext.join('、')}</span>`:''}`,html`${chip(state.text,state.tone)}${resource.binding_error?html`<p class="error">${resource.binding_error.message}</p>`:''}`,reads===null?'暂不可用':readsText(reads.get(resource.id))];}),'尚无业务系统',undefined,{selected:resources.findIndex(resource=>resource.id===systemId),hrefs:resources.map(resource=>href('/console/connections',{system:resource.id}))}):html`<p class="ch-meta">业务系统的配置仅管理员可见；任务中的读取显示在各任务的执行过程中。</p>`;
 const period=reads===null?undefined:[...reads.values()][0];
 const systemPeriod=ctx.admin?html`<p class="ch-meta">${period?html`统计时段 ${when(period.since)} 至 ${when(period.until)}；`:''}读取次数与耗时取自每次读取的读取清单，耗时是已完成读取从开始到结束的时间的中位数。</p>`:'';
 const environmentRows=(executors??[]).map(executor=>{const state=environmentState(executor),latest=executor.state?.latest,calls=executor.calls_24h;let gateway=executor.endpoint;try{gateway=new URL(gateway).origin;}catch{/* Preserve the recorded endpoint. */}return [link('/console/connections',executor.target,{environment:executor.id}),technicalCode(executor.id),executor.state?.known.version?executor.state.reported_version?technicalCode(executor.state.reported_version):'未上报':'未知',gateway,executor.resources.length,executor.state?.known.latest?latest?html`${latest.run?link('/console/runs/'+latest.run,when(latest.at)):when(latest.at)}<div class="ch-meta">${uiLabelOf('effect_outcome',latest.outcome)}${latest.frozen?' · 派发结果未确认':''}</div>`:'尚无派发':'未知',calls?calls.calls===0&&!calls.partial?'近 24 小时无调用':html`${calls.partial?'至少 ':''}${calls.calls} 次<div class="ch-meta">中位 ${calls.median_ms===null?'未知':duration(calls.median_ms)} · 最慢 ${calls.slowest_ms===null?'未知':duration(calls.slowest_ms)}</div>`:'暂不可用',html`${chip(state.text,state.tone)}${state.detail.map(line=>html`<p class="ch-meta">${line}</p>`)}`];});
 const environments=!ctx.admin?html`<p class="ch-meta">运行环境仅管理员可见。</p>`:executors===null?html`<p class="ch-meta">${executorsFailed?'运行环境列表暂不可用。':'这个 Hub 进程未接入派发；运行环境在 Hub 所在主机上以 circle-hub executor 登记。'}</p>`:table(['运行环境','执行器','执行器版本','网关','资源','最近派发','响应时间','状态'],environmentRows,'尚无运行环境',undefined,{selected:executors.findIndex(executor=>executor.id===environmentId),hrefs:executors.map(executor=>href('/console/connections',{environment:executor.id}))});
 const dialogs:CommandDialog[]=[];let inspector:Html;
 if(chosen){const toggle=commands.resourceToggle(chosen),relogin=commands.resourceResetLogin(chosen);dialogs.push(toggle,relogin);inspector=html`<div data-inspector-content><div class="ch-actions"><span class="ch-tag">业务系统</span>${chip(systemState(chosen).text,systemState(chosen).tone)}</div><h2 class="ch-panel-title">${chosen.name}</h2>${facts([['环境',isEnvironment(chosen.environment)?uiLabelOf('environment',chosen.environment):chosen.environment],['访问方式','只读'],['访问地址',html`${Object.values(chosen.origins??{}).map(origin=>html`<p>${origin}</p>`)}`],['近 24 小时读取',reads===null?'暂不可用':readsText(reads.get(chosen.id))]])}${technical(html`${code(chosen.id)} ${code(chosen.system_pack)}`)}<footer class="ch-inspector-actions">${commandLink(toggle,chosen.enabled?'停用…':'启用…',chosen.enabled?'ch-btn ch-btn--danger':'ch-btn ch-btn--secondary')}${commandLink(relogin,'重新认证…')}</footer></div>`;
 }else if(circle){const revoke=commands.tokenRevoke(circle.token,circle.owner);if(ctx.admin)dialogs.push(revoke);inspector=html`<div data-inspector-content><span class="ch-tag">Circle</span><h2 class="ch-panel-title">${circle.name}</h2>${facts([['成员',circle.owner],['最近使用时间',when(circle.token.last_used_at)]])}<footer class="ch-inspector-actions">${ctx.admin?commandLink(revoke,'断开…','ch-btn ch-btn--danger'):'由管理员断开'}</footer></div>`;
 }else if(environment){const state=environmentState(environment),actions:Html[]=[];
  if(environment.enabled){const disable=commands.executorDisable(environment);dialogs.push(disable);actions.push(commandLink(disable,'停用…','ch-btn ch-btn--danger'));}
  if(environment.state?.bed_hold){const clear=commands.bedHoldClear(environment);dialogs.push(clear);actions.push(commandLink(clear,'确认已恢复…'));}
  const frozen=environment.state?.holding?.find(job=>job.frozen);if(frozen){const dispose=commands.jobDispose(frozen.job);dialogs.push(dispose);actions.push(commandLink(dispose,'处置派发结果…','ch-btn ch-btn--danger'));if(frozen.run)actions.push(link('/console/runs/'+frozen.run,'查看任务'));}
  inspector=html`<div data-inspector-content><div class="ch-actions"><span class="ch-tag">运行环境</span>${chip(state.text,state.tone)}</div><h2 class="ch-panel-title">${environment.target}</h2>${state.detail.map(line=>html`<p>${line}</p>`)}${facts([['资源',environment.resources.length],['网关',environment.endpoint]])}${technicalCode(environment.id)}<footer class="ch-inspector-actions">${actions}</footer></div>`;
 }else inspector=html`<h2 class="ch-panel-title">连接</h2>${stat('已连接的 Circle',circles.length)}${stat('24 小时内使用过',recent)}${ctx.admin?html`${stat('业务系统',resources.length)}${stat('运行环境',executors?.length??'—')}`:''}${card({title:'最近使用'},html`<ul class="ch-feed">${circles.slice(0,3).map(item=>html`<li>${item.name}<span class="ch-meta">${when(item.token.last_used_at)}</span></li>`)}</ul>`)}`;
 const body=html`${seg([['circles','已连接的 Circle'],['systems','业务系统'],['envs','运行环境'],['more','多终端与通知']],'连接分区')}${await packSources(ctx,'system',resources)}${liveModule('connections',['member.connected','system.added','system.status','environment.status'],html`${kpis}${topology}`)}${sectionHead('已连接的 Circle',undefined,undefined,'circles')}${liveModule('circles',['member.connected'],table(['设备名','成员','最近使用时间'],circles.map(item=>[link('/console/connections',item.name,{circle:item.token.id}),item.owner,when(item.token.last_used_at)]),'尚无已连接的 Circle',undefined,{selected:circles.findIndex(item=>item.token.id===circleId),hrefs:circles.map(item=>href('/console/connections',{circle:item.token.id}))}))}${sectionHead('业务系统',undefined,undefined,'systems')}${liveModule('systems',['system.added','system.status'],html`${systems}${systemPeriod}`)}${sectionHead('运行环境',undefined,undefined,'envs')}${liveModule('environments',['environment.status'],environments)}${sectionHead('多终端协同与消息通知',undefined,undefined,'more')}<section data-columns="2">${plannedCard('多终端协同','各终端 Circle 的工作状态同步至 Hub，可在任一终端查看并继续任务。','terminal')}${plannedCard('消息通知','经 Hub 收发消息、转交任务；尚未开放。','chat')}</section>`;
 return {status:200,body:page(ctx.chrome('连接',{active:'connections',hint:'业务系统只读访问，运行环境的占用与冻结取派发记录；读取与响应时间接口仅提供近24小时，未推断更长时段。',actions:ctx.admin?html`${button('/console/operations/pack',`发布${uiLabelOf('pack_kind','system')}`,{params:{kind:'system'},icon:'upload'})}${button('/console/operations/system','接入业务系统',{primary:true,icon:'plus'})}`:html``}),pageLayout(body,{inspector:liveModule('connection-inspector',['member.connected','system.added','system.status','environment.status'],html`${inspector}${dialogs.map(commandModal)}`),detail:!!(chosen||circle||environment),back:link('/console/connections','返回连接')}))};
}

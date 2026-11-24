import {technical,technicalCode,facts,evidence,tooltip} from './presentation.ts';
// 连接 (the design canvas's Connections board): the Circles connected with a token, the business systems the Hub reads
import { ENVIRONMENT_STATE, axisUiLabel, isEnvironment, uiLabelOf, type EnvironmentState } from '../../../contracts/generated/vocabulary.ts';
import type { TokenInfo } from '../../records/api.ts';
import type { ExecutorView } from '../api.ts';
import type { ResourceListing } from '../../ports.ts';
import { commands } from './commands.ts';
import { connectedClients, connectionText, clientLabel, nameOrigin, type ConnectedClient } from './circles.ts';
import {tokensForMembers} from './member-reads.ts';
import { code, emptyAction, html, link, liveModule, page, pageLayout, table, href, type Html } from './html.ts';
import { neutralPage, type PageContext, type PageResult } from './context.ts';
import { readsText, systemReads } from './trial.ts';
import { packSources } from './pack-sources.ts';
import { loadReadinessReports, readinessUnknownNotice } from './environment-readiness.ts';
import { box, button, card, chip, commandLink, commandModal, duration, when, type CommandDialog, type DotState, type Tone } from './ui.ts';
import { count, errorLine, segments, postForm } from './components.ts';
import { field } from './presentation.ts';
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

export type HeldOccupancy = {
  key: string;
  environment: string;
  since: string;
  holderId: string;
  holderName: string;
};

export async function heldOccupancyForEnvironment(
  ctx: PageContext,
  view: ExecutorView,
  holderIds: ReadonlySet<string>,
): Promise<HeldOccupancy[] | null> {
  const leases = ctx.deps.leases;
  if (leases === undefined) return null;
  const declared = new Set(view.resources);
  if (declared.size === 0 || holderIds.size === 0) return [];
  try {
    const { entries } = await leases.view('', true);
    const matched = entries.filter(
      (entry) => declared.has(entry.key) && entry.user !== undefined && holderIds.has(entry.user),
    );
    const out: HeldOccupancy[] = [];
    for (const entry of matched) {
      const holderId = entry.user!;
      const name = await ctx.userName(holderId);
      out.push({
        key: entry.key,
        environment: view.target,
        since: entry.since,
        holderId,
        holderName: name !== '' && name !== holderId ? name : '账户',
      });
    }
    return out.sort(
      (a, b) => a.since.localeCompare(b.since) || a.holderName.localeCompare(b.holderName, 'zh-CN') || a.key.localeCompare(b.key),
    );
  } catch {
    return null;
  }
}

export function unassignOccupancyFields(occupancy: HeldOccupancy[] | null): Html {
  if (occupancy === null) {
    return html`<p class="ch-meta" data-unassign-occupancy="unknown">当前占用暂不可读；撤回后预订仍留在持有人名下，可稍后用 circle-hub lease release 强制释放。</p>`;
  }
  if (occupancy.length === 0) {
    return html`<p class="ch-meta" data-unassign-occupancy="none">当前没有读到该账户或团队成员在此测试环境上的预订。</p>`;
  }
  return html`<div data-unassign-occupancy="held"><p>下列测试环境仍被占用；勾选后将在撤回分配时一并强制释放（本地释放不证明远端已停）。</p><div data-fields>${occupancy.map((row) => html`<label class="check" data-wide-field><input type="checkbox" name="force_release" value="${row.key}"> 测试环境「${row.environment}」· ${row.holderName} · 自 ${when(row.since)}</label>`)}</div></div>`;
}

export type EnvironmentLastCheck = {
  at: string;
  items: Array<{ name: string; ok: boolean | null; detail?: string; next_action?: string }>;
};

export function environmentLastCheck(view: ExecutorView): EnvironmentLastCheck | null | undefined {
  const state = view.state as (NonNullable<ExecutorView['state']> & { last_check?: EnvironmentLastCheck | null }) | undefined;
  if (state === undefined || !('last_check' in state)) return undefined;
  return state.last_check ?? null;
}

function checkPresentation(check: EnvironmentLastCheck): { text: string; tone: Tone } {
  if (check.items.some(item => item.ok === false)) return { text: '错误', tone: 'fail' };
  if (check.items.some(item => item.ok === null)) return { text: '未知', tone: 'unknown' };
  return { text: '已确认', tone: 'pass' };
}

export function environmentCheckCell(view: ExecutorView): Html {
  const check = environmentLastCheck(view);
  if (check === undefined) return html`<span class="ch-meta">尚无核对</span>`;
  if (check === null) return html`<span class="t-unknown">未知</span>`;
  const { text, tone } = checkPresentation(check);
  const failed = check.items.filter((item) => item.ok === false).length;
  const note = failed > 0 ? `${failed} 项错误` : check.items.some((item) => item.ok === null) ? '含未知项' : '各项正确';
  return html`${when(check.at)}<div class="ch-meta">${chip(text, tone)} · ${note}</div>`;
}

export function environmentCheckFacts(view: ExecutorView): Array<[string, unknown]> {
  const check = environmentLastCheck(view);
  if (check === undefined) return [['最近核对', '尚无核对']];
  if (check === null) return [['最近核对', html`<span class="t-unknown">未知</span>`]];
  const { text, tone } = checkPresentation(check);
  const rows: Array<[string, unknown]> = [
    ['最近核对', html`${when(check.at)} ${chip(text, tone)}`],
  ];
  for (const item of check.items) {
    const status = item.ok === true ? '已确认' : item.ok === false ? '错误' : '未知';
    const detail = [item.detail, item.next_action].filter(Boolean).join('；');
    rows.push([item.name, detail ? html`${status}<div class="ch-meta">${detail}</div>` : status]);
  }
  return rows;
}

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
    return as('deactivated', 'unchecked', 'idle', waiting > 0 ? [`仍有 ${waiting} 次执行的结果未确认，等待处置中`] : []);
  }
  if (state === undefined || !state.known.occupancy || state.holding === null) {
    return as('unknown', 'unknown', 'unknown', state !== undefined && state.missing.length > 0 ? [...state.missing] : ['占用与冻结状态暂不可读']);
  }
  const frozen = state.holding.filter((job) => job.frozen);
  const detail: string[] = [];
  for (const job of frozen) detail.push(`执行 ${shortJob(job.job)} 的结果未确认，等待处置中`);
  if (state.bed_hold !== null) detail.push(`执行 ${shortJob(state.bed_hold.job)} 结束后运行环境未恢复（${state.bed_hold.bed}），等待管理员确认中`);
  if (frozen.length > 0 || state.bed_hold !== null) return as('frozen', 'fail', 'down', detail);
  if (state.holding.length > 0) return as('in_use', 'judgment', 'info', state.holding.map((job) => `执行 ${shortJob(job.job)}（${axisUiLabel('effect_outcome')}：${uiLabelOf('effect_outcome', job.outcome)}）`));
  return as('available', 'pass', 'ok', []);
}

/** The note under the environments count: how many are in use, frozen, disabled or unknown. */
function environmentNote(executors: readonly ExecutorView[]): string {
  const counts = new Map<EnvironmentState, number>();
  for (const e of executors) {
    const code = environmentState(e).code;
    counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  const head = `${uiLabelOf('environment_state', 'available')} ${count(counts.get('available') ?? 0)} 个，共 ${count(executors.length)} 个`;
  const parts = ENVIRONMENT_STATE.filter((code) => code !== 'available' && (counts.get(code) ?? 0) > 0).map((code) => `${uiLabelOf('environment_state', code)} ${counts.get(code)}`);
  return parts.length > 0 ? `${head}；${parts.join('，')}` : head;
}

/** Addresses allowed in plaintext that are not among the system's own addresses, where each is already marked. */
const plaintextElsewhere=(resource:ResourceListing):string[]=>(resource.allow_plaintext??[]).filter(origin=>!Object.values(resource.origins??{}).includes(origin));

function systemState(resource: ResourceListing): { text: string; tone: Tone; dot: DotState } {
  if (resource.binding_error !== undefined) return { text: '配置有误', tone: 'fail', dot: 'down' };
  return resource.enabled ? { text: '启用', tone: 'pass', dot: 'ok' } : { text: '已停用', tone: 'unchecked', dot: 'idle' };
}

function executorsByTarget(executors: readonly ExecutorView[]): Array<{ target: string; rows: ExecutorView[] }> {
  const order: string[] = [];
  const map = new Map<string, ExecutorView[]>();
  for (const row of executors) {
    const list = map.get(row.target);
    if (list === undefined) {
      order.push(row.target);
      map.set(row.target, [row]);
    } else {
      list.push(row);
    }
  }
  return order.map((target) => ({ target, rows: map.get(target)! }));
}

function targetAssignForm(
  csrf: string,
  target: string,
  rows: readonly ExecutorView[],
  teamChoices: Array<{ value: string; label: string }>,
  userChoices: Array<{ value: string; label: string }>,
): Html {
  if (teamChoices.length === 0 && userChoices.length === 0) {
    return html`<p class="ch-meta">尚无团队或启用账户，无法分配。</p>`;
  }
  const boxes = rows.map((row) => html`<label class="check" data-wide-field><input type="checkbox" name="executors" value="${row.id}" checked> ${technicalCode(row.id)}${row.enabled ? '' : html` <span class="ch-meta">已停用</span>`}</label>`);
  const teamField = teamChoices.length === 0
    ? html``
    : field('团队', html`<select name="team"><option value="">（不填）</option>${teamChoices.map((row) => html`<option value="${row.value}">${row.label}</option>`)}</select>`, '与账户互斥');
  const userField = userChoices.length === 0
    ? html``
    : field('账户', html`<select name="user"><option value="">（不填）</option>${userChoices.map((row) => html`<option value="${row.value}">${row.label}</option>`)}</select>`, '与团队互斥');
  return postForm({
    action: '/console/admin/do/executor-assign',
    csrf,
    fields: html`<p class="ch-meta">目标 ${target}：勾选要一起分配的执行器，再选团队或账户之一。</p>${boxes}${teamField}${userField}`,
    submit: '分配所选',
    primary: true,
  });
}

async function environmentAdminForms(ctx: PageContext, executors: readonly ExecutorView[] | null): Promise<Html> {
  const csrf = ctx.csrf ?? '';
  const teamsApi = (ctx.deps.records as { teams?: { list(by: PageContext['principal']): Promise<Array<{ id: string; name: string; deleted_at: string | null }>> } }).teams;
  const teams = teamsApi === undefined ? [] : (await teamsApi.list(ctx.principal)).filter((row) => row.id !== 'team' && row.deleted_at === null);
  const teamChoices = teams.map((row) => ({ value: row.id, label: row.name }));
  const users = (await ctx.deps.records.principals.list()).filter((row) => !row.disabled && !row.deleted_at);
  const userChoices = users.map((row) => ({ value: row.id, label: row.name }));
  const docPut = card({ title: '登记或更新环境清单', hint: '上传 bed-topology JSON；经已有上传得到原件引用后交给命令，不在服务器落临时文件，也不要求填写主机路径。' },
    postForm({
      action: '/console/admin/do/doc-put',
      csrf,
      multipart: true,
      fields: html`${field('文档名', html`<input name="name" value="bed-topology" required>`)}${field('清单文件', html`<input type="file" name="archive" accept=".json,application/json" required>`)}`,
      submit: '登记清单',
      primary: true,
    }));
  const executorAdd = card({
    title: '登记测试环境执行器',
    hint: '上传执行器 JSON 定义；经上传原件引用登记。密钥另用密钥库设置。同一目标若已有执行器，请用下方「更新」；再登记一次会新增多条（后端同名策略见执行器命名定稿）。',
  },
    postForm({
      action: '/console/admin/do/executor-add',
      csrf,
      multipart: true,
      fields: html`${field('定义文件', html`<input type="file" name="archive" accept=".json,application/json" required>`)}`,
      submit: '登记执行器',
      primary: true,
    }));
  const groups = executorsByTarget(executors ?? []);
  const grouped = groups.length === 0
    ? html`<p class="ch-meta">尚无已登记的执行器。</p>`
    : html`${groups.map(({ target, rows }) => card(
      { title: `测试环境 ${target}`, hint: '按执行器目标归组，一次可把同组多个执行器分给同一团队或账户。测试环境的分配只决定成员的「我能做的事」列出哪些测试环境；谁能预订和上机按工作流的分配和预订规则判断。' },
      html`${table(
        ['执行器', '网关', '资源', '状态', ''],
        rows.map((row) => {
          const state = environmentState(row);
          let gateway = row.endpoint;
          try { gateway = new URL(gateway).origin; } catch { }
          const update = postForm({
            action: '/console/admin/do/executor-update',
            csrf,
            multipart: true,
            fields: html`<input type="hidden" name="executor" value="${row.id}">${field('定义文件', html`<input type="file" name="archive" accept=".json,application/json" required>`)}`,
            submit: '更新',
          });
          const disable = row.enabled
            ? postForm({
              action: '/console/admin/do/executor-disable',
              csrf,
              fields: html`<input type="hidden" name="executor" value="${row.id}">`,
              submit: '停用',
              danger: true,
            })
            : html`<span class="ch-meta">已停用</span>`;
          return [technicalCode(row.id), gateway, row.resources.length, chip(state.text, state.tone), html`<div class="ch-stack" data-executor-ops>${update}${disable}</div>`];
        }),
      )}${targetAssignForm(csrf, target, rows, teamChoices, userChoices)}`,
    ))}`;
  return html`<div class="ch-stack" data-environment-admin>${docPut}${executorAdd}${grouped}</div>`;
}

export async function resourceAudienceText(ctx: PageContext, resourceId: string): Promise<string> {
  if (!ctx.admin) return '未知';
  const of = await ctx.deps.records.authorizations.teamsOf(ctx.principal, 'resource', resourceId);
  const parts: string[] = [];
  if (of.all) parts.push('全体');
  for (const team of of.teams) parts.push(`团队 ${team.name}`);
  return parts.length > 0 ? parts.join('、') : '尚未分配';
}

/** Read-only lists and a single authorized selection share one inspector. */
export async function connectionsPage(ctx:PageContext):Promise<PageResult>{
 const now=(ctx.deps.now?.()??new Date()).getTime(),circles=await circlesOf(ctx),resources=ctx.admin?await ctx.deps.resources.list(ctx.principal):[];
 let executors:ExecutorView[]|null=null,executorsFailed=false;
 if(ctx.admin&&ctx.deps.dispatch){try{executors=await ctx.deps.dispatch.executors(ctx.principal);}catch{executorsFailed=true;}}
 let memberTargets:string[]=[];
 if(!ctx.admin){
  try{
   const capabilities=await ctx.deps.memberCapabilities(ctx.principal);
   memberTargets=[...new Set(capabilities.environments.map(item=>item.name))].sort((a,b)=>a.localeCompare(b,'zh-CN'));
  }catch{memberTargets=[];}
 }
 const readinessTargets=ctx.admin
  ?[...new Set((executors??[]).map(executor=>executor.target))].sort((a,b)=>a.localeCompare(b,'zh-CN'))
  :memberTargets;
 const readinessCards=await loadReadinessReports(ctx.deps.dispatch?.readiness,ctx.principal,readinessTargets);
 const systemId=ctx.url.searchParams.get('system'),circleId=ctx.url.searchParams.get('circle'),environmentId=ctx.url.searchParams.get('environment');
 const chosen=resources.find(resource=>resource.id===systemId),circle=circles.find(circle=>circle.token.id===circleId),environment=executors?.find(executor=>executor.id===environmentId);
 if([systemId,circleId,environmentId].filter(Boolean).length>1||systemId&&!chosen||circleId&&!circle||environmentId&&!environment)return neutralPage(ctx);
 const recent=circles.filter(circle=>circle.token.last_used_at!==null&&now-Date.parse(circle.token.last_used_at)<DAY).length;
 // Decision 151, step 7: one list a tab instead of four lists down one page. A selected system, client or environment opens
 const asked=ctx.url.searchParams.get('tab');
 const tab:ConnectionTab=!ctx.admin
  ?(asked==='environments'||environment?'environments':'clients')
  :chosen?'systems':circle?'clients':environment?'environments':CONNECTION_TABS.find(key=>key===asked)??'systems';
 const listings=ctx.admin?await ctx.deps.packs.list(ctx.principal):[];
 const systemPacks=new Map([...byId(listings).values()].map(shownVersion).filter(pack=>pack.kind==='system').map(pack=>[pack.id,pack]));
 // A system names the access it was configured from by that access's title; its identifier stays in the pane's technical details.
 const systemPackTitle=(resource:ResourceListing)=>{const pack=systemPacks.get(resource.system_pack.split('@')[0]);return pack?pack.title:'未找到';};
 const counts:Partial<Record<ConnectionTab,number>>={systems:resources.length,packs:systemPacks.size,clients:circles.length,environments:ctx.admin?(executors?.length??readinessTargets.length):readinessTargets.length};
 const memberTabs=([{href:href('/console/connections'),label:CONNECTION_TAB_LABEL.clients,count:counts.clients,current:tab==='clients'},{href:href('/console/connections',{tab:'environments'}),label:CONNECTION_TAB_LABEL.environments,count:counts.environments,current:tab==='environments'}] as const);
 const tabs=ctx.admin
  ?liveModule('connections',['member.connected','system.added','system.status','environment.status'],segments('连接内容',CONNECTION_TABS.map(key=>({href:href('/console/connections',key==='systems'?{}:{tab:key}),label:CONNECTION_TAB_LABEL[key],count:counts[key],current:key===tab})),'data-connection-tabs'))
  :liveModule('connections',['member.connected','environment.status'],segments('连接内容',[...memberTabs],'data-connection-tabs'));
 // The reads of the last day are worked out only where they show: the list of systems, or the pane of a selected one.
 const reads=tab==='systems'?await systemReads(ctx,resources.map(resource=>resource.id)):new Map<string,never>();
 const audienceById=new Map<string,string>();
 if(ctx.admin)for(const resource of resources)audienceById.set(resource.id,await resourceAudienceText(ctx,resource.id));
 const systems=ctx.admin?table(['系统',uiLabelOf('pack_kind','system'),'环境','使用范围','访问地址','访问方式','状态',tooltip('近 24 小时读取','读取次数取自读取清单，耗时为已完成读取从开始到结束的时间中位数。')],resources.map(resource=>{const state=systemState(resource);return [link('/console/connections',resource.name,{system:resource.id}),systemPackTitle(resource),isEnvironment(resource.environment)?uiLabelOf('environment',resource.environment):resource.environment,audienceById.get(resource.id)??'未知',resource.origins?html`${Object.entries(resource.origins).map(([role,origin])=>html`<div>${role}：${origin}${resource.allow_plaintext?.includes(origin)?html` <span class="ch-meta">明文 http</span>`:''}</div>`)}`:'未配置',html`${chip('只读','judgment')}${plaintextElsewhere(resource).length?html`<p class="ch-meta">明文 http：${plaintextElsewhere(resource).join('、')}</p>`:''}`,html`${chip(state.text,state.tone)}${resource.binding_error?errorLine(resource.binding_error.message):''}`,reads===null?'暂不可用':readsText(reads.get(resource.id))];}),'尚无业务系统',undefined,{selected:resources.findIndex(resource=>resource.id===systemId),hrefs:resources.map(resource=>href('/console/connections',{system:resource.id}))}):html`<p class="ch-meta">业务系统的配置仅管理员可见；任务中的读取显示在各任务的执行过程中。</p>`;
 const period=reads===null?undefined:[...reads.values()][0];
 const systemFacts=html`<p class="ch-meta" data-tab-facts>已启用 ${count(resources.filter(resource=>resource.enabled).length)} 个，共 ${count(resources.length)} 个${period?html` · 统计时段 ${when(period.since)} 至 ${when(period.until)}`:''}</p>`;
 const orderedExecutors=executors===null?null:executorsByTarget(executors).flatMap((group)=>group.rows);
 const environmentRows=(orderedExecutors??[]).map(executor=>{const state=environmentState(executor),latest=executor.state?.latest,calls=executor.calls_24h;let gateway=executor.endpoint;try{gateway=new URL(gateway).origin;}catch{}return [link('/console/connections',executor.target,{environment:executor.id}),technicalCode(executor.id),executor.state?.known.version?executor.state.reported_version?technicalCode(executor.state.reported_version):'未上报':'未知',gateway,executor.resources.length,environmentCheckCell(executor),executor.state?.known.latest?latest?html`${latest.run?link('/console/runs/'+latest.run,when(latest.at)):when(latest.at)}<div class="ch-meta">${uiLabelOf('effect_outcome',latest.outcome)}${latest.frozen?' · 执行结果未确认':''}</div>`:'尚无执行':'未知',calls?calls.calls===0&&!calls.partial?'近 24 小时无调用':html`${calls.partial?'至少 ':''}${calls.calls} 次<div class="ch-meta">中位 ${calls.median_ms===null?'未知':duration(calls.median_ms)} · 最慢 ${calls.slowest_ms===null?'未知':duration(calls.slowest_ms)}</div>`:'暂不可用',html`${chip(state.text,state.tone)}${state.detail.map(line=>html`<p class="ch-meta">${line}</p>`)}`];});
 const environmentTable=!ctx.admin?html`<p class="ch-meta">运行环境仅管理员可见；已分配的测试环境在「我能做的事」。${link('/console/me','打开')}</p>`:executors===null?html`<p class="ch-meta">${executorsFailed?'运行环境列表暂不可用。':'这个 Hub 进程未接入在运行环境上执行；运行环境在运行 Hub 的服务器上以 circle-hub executor 登记。'}</p>`:table(['测试环境（按目标）','执行器','执行器版本','网关','资源','最近核对','最近执行','响应时间','状态'],environmentRows,{title:'尚无运行环境',text:'在运行 Hub 的服务器上以 circle-hub executor 登记后列在这里。'},undefined,{selected:orderedExecutors!.findIndex(executor=>executor.id===environmentId),hrefs:orderedExecutors!.map(executor=>href('/console/connections',{environment:executor.id}))});
 const readinessSection=html`<div class="ch-stack" data-environment-readiness>${readinessTargets.length?readinessCards.map(card=>card.body):ctx.deps.dispatch?.readiness?html`<p class="ch-meta">${ctx.admin?'尚无运行环境目标。':'尚无已分配的运行环境；请管理员分配后重读。'}</p>`:readinessUnknownNotice()}${!ctx.deps.dispatch?.readiness&&readinessTargets.length?html`<p class="ch-meta">上列目标的只读报告尚未接线；页面不作许可判断。</p>`:''}</div>`;
 const dialogs:CommandDialog[]=[];let inspector:Html;
 if(chosen){const toggle=commands.resourceToggle(chosen),relogin=commands.resourceResetLogin(chosen);dialogs.push(toggle,relogin);inspector=html`<div data-inspector-content><div class="ch-actions"><span class="ch-tag">业务系统</span>${chip(systemState(chosen).text,systemState(chosen).tone)}</div><h2 class="ch-panel-title">${chosen.name}</h2>${facts([['环境',isEnvironment(chosen.environment)?uiLabelOf('environment',chosen.environment):chosen.environment],['使用范围',audienceById.get(chosen.id)??'未知'],['访问方式','只读'],['访问地址',html`${Object.values(chosen.origins??{}).map(origin=>html`<p>${origin}</p>`)}`],['近 24 小时读取',reads===null?'暂不可用':readsText(reads.get(chosen.id))]])}${technical(html`${code(chosen.id)} ${code(chosen.system_pack)}`)}<footer class="ch-inspector-actions">${commandLink(toggle,chosen.enabled?'停用…':'启用…',chosen.enabled?'ch-btn ch-btn--danger':'ch-btn ch-btn--secondary')}${commandLink(relogin,'重新认证…')}</footer></div>`;
 }else if(circle){const revoke=commands.tokenRevoke(circle.token,circle.owner);if(ctx.admin)dialogs.push(revoke);inspector=html`<div data-inspector-content>${clientInspector(circle)}<footer class="ch-inspector-actions">${ctx.admin?commandLink(revoke,'断开…','ch-btn ch-btn--danger'):'由管理员断开'}</footer></div>`;
 }else if(environment){const state=environmentState(environment),actions:Html[]=[];
  const csrf=ctx.csrf??'';
  actions.push(postForm({
    action:'/console/admin/do/executor-update',
    csrf,
    multipart:true,
    fields:html`<input type="hidden" name="executor" value="${environment.id}">${field('定义文件',html`<input type="file" name="archive" accept=".json,application/json" required>`)}`,
    submit:'更新',
  }));
  if(environment.enabled){
    actions.push(postForm({
      action:'/console/admin/do/executor-disable',
      csrf,
      fields:html`<input type="hidden" name="executor" value="${environment.id}">`,
      submit:'停用',
      danger:true,
    }));
  }
  if(environment.state?.bed_hold){const clear=commands.bedHoldClear(environment);dialogs.push(clear);actions.push(commandLink(clear,'确认已恢复…'));}
  const frozen=environment.state?.holding?.find(job=>job.frozen);if(frozen){const dispose=commands.jobDispose(frozen.job);dialogs.push(dispose);actions.push(commandLink(dispose,'处置执行结果…','ch-btn ch-btn--danger'));if(frozen.run)actions.push(link('/console/runs/'+frozen.run,'查看任务'));}
  inspector=html`<div data-inspector-content><div class="ch-actions"><span class="ch-tag">运行环境</span>${chip(state.text,state.tone)}</div><h2 class="ch-panel-title">${environment.target}</h2>${state.detail.map(line=>html`<p>${line}</p>`)}${facts([...environmentCheckFacts(environment),['资源',environment.resources.length],['网关',environment.endpoint]])}${technicalCode(environment.id)}<footer class="ch-inspector-actions">${actions}</footer></div>`;
 }else inspector=html``;
 // Decision 151: with nothing selected there is no pane. The figures it repeated stand in the row at the top of the page.
 const selected=!!(chosen||circle||environment);
 const clients=liveModule('circles',['member.connected'],html`<p class="ch-meta" data-tab-facts>${tooltip(`24 小时内使用过 ${count(recent)} 个`,'每行对应有效凭据；名称优先取最近报告，其次登记名称或令牌标签。最近凭据使用不是在线状态，未记录不表示离线。')}</p>${box(null,table(CLIENT_COLUMNS,circles.map(item=>clientRow(item,link('/console/connections',clientLabel(item),{circle:item.token.id}))),noClients(ctx.admin),undefined,{selected:circles.findIndex(item=>item.token.id===circleId),hrefs:circles.map(item=>href('/console/connections',{circle:item.token.id}))}),{flush:true})}${ctx.admin?'':html`<p class="ch-meta">业务系统的配置仅管理员可见。测试环境与占用见 ${link("/console/me","我能做的事")}；只读就绪报告在「运行环境」页签，任务中的读取显示在各任务的执行过程中。</p>`}`);
 const content=tab==='clients'?clients
  :tab==='systems'?liveModule('systems',['system.added','system.status'],html`${systemFacts}${box(null,systems,{flush:true})}`)
  :tab==='packs'?await packSources(ctx,'system',resources,{listings,bare:true})
  :liveModule('environments',['environment.status'],html`${executors?.length?html`<p class="ch-meta" data-tab-facts>${environmentNote(executors)}</p>`:''}${readinessSection}${box(null,environmentTable,{flush:true})}${ctx.admin?await environmentAdminForms(ctx,executors):''}`);
 const body=html`<div class="ch-stack" data-connections>${tabs}<div data-connection-tab="${tab}">${content}</div></div>`;
 return {status:200,body:page(ctx.chrome('连接',{active:'connections',hint:'业务系统只读访问，写操作尚未开放；运行环境就绪为本地只读观察；占用与冻结取执行记录；读取与响应时间接口仅提供近 24 小时，未推断更长时段。',actions:ctx.admin?html`${button('/console/operations/pack',`发布${uiLabelOf('pack_kind','system')}`,{params:{kind:'system'},icon:'upload'})}${button('/console/operations/system','接入业务系统',{primary:true,icon:'plus'})}`:html``}),pageLayout(body,{inspector:selected?liveModule('connection-inspector',['member.connected','system.added','system.status','environment.status'],html`${inspector}${dialogs.map(commandModal)}`):null,detail:selected,back:link('/console/connections','返回连接')}))};
}

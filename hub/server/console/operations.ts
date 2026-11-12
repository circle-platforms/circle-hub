import {field as sharedField,technicalCode} from './presentation.ts';
// The four management operations the console runs (proposal decision 6 of 2026-10-31), as step-by-step pages in the design
// canvas's Operations board: adding a member, connecting a business system, publishing a task pack and importing knowledge.
// Each form posts to /console/admin/do/<action>, which runs the same `circle-hub` commands as the command line (decision
// 75). Adding a member issues an invitation code for the standard authorization, or a token for a client without it;
// publishing a task pack is a check of the upload and then its 发布 step (manage.ts). Connecting a business system may be
// tried first (尝试连接, trial.ts): a read-only trial that records its outcomes without saving the typed configuration.
import { publication, publishingKind, packHome, packPurpose } from './pack-display.ts';
import { isPackKind, uiLabelOf } from '../../../contracts/generated/vocabulary.ts';
import { TRIAL_LOGIN_STOPPED } from '../../connectors/api.ts';
import { code, href, html, link, liveModule, page, table, type Html } from './html.ts';
import { actionForm, environmentOptions, jobsSection, roleOptions, stageForms, type Form, type JobStore } from './manage.ts';
import { neutralPage, type PageContext, type PageResult } from './pages.ts';
import type { PackStaging } from './staging.ts';
import { forgetTrialMessage, trialCard, type ForgetOutcome, type TrialOutcome } from './trial.ts';
import { card, chip, stepper as steps, when } from './ui.ts';

const OPERATIONS = ['member', 'system', 'pack', 'knowledge'] as const;
type Operation = (typeof OPERATIONS)[number];

export const isOperation = (value: string): value is Operation => (OPERATIONS as readonly string[]).includes(value);

const field=(label:string,control:Html,options:{hint?:string;full?:boolean}={}):Html=>html`<div${options.full?html` data-wide-field`:''}>${sharedField(label,control,options.hint)}</div>`;

function memberPage(ctx: PageContext): Html {
  const form = actionForm('member-add', ctx.csrf ?? '', html`<div data-fields>
${field('用户名', html`<input name="name" required autocomplete="off" maxlength="200">`, { hint: '在控制台、记录与客户端中显示' })}
${field('角色', html`<select name="role">${roleOptions()}</select>`, { hint: '管理员可管理团队、接入和发布，并查看其有权访问的管理与审计记录。私人内容仍按分享权限控制。' })}
${field('连接方式', html`<select name="connect"><option value="invitation" selected>邀请码（MCP 标准连接确认）</option><option value="token">访问令牌</option></select>`, { hint: '客户端不支持 MCP 标准连接确认时选访问令牌' })}
${field('令牌标签', html`<input name="label" autocomplete="off" maxlength="200" placeholder="办公电脑上的客户端">`, { hint: '选访问令牌时区分同一成员的多个客户端，可留空' })}
</div>`, '添加成员', { primary: true });
  return html`${steps(['填写成员', '生成初始密码', '成员确认连接', '等待连接中'], 0)}
<section class="ch-section" data-columns="2">
${card({ title: '成员信息',hint:'创建成员后签发邀请码或访问令牌，初始密码、邀请码与令牌只在结果页显示一次，首次密码登录必须修改。' }, html`${form}`)}
${card({ title: '成员如何连接', meta: 'MCP 标准连接确认', hint:'把结果页的配置写入成员的客户端；首次连接时在浏览器连接确认页输入邀请码并确认。邀请码过期后在团队页重新签发。' }, html`<p class="ch-meta">邀请码 24 小时内有效，仅可使用一次。</p>`)}
</section>`;
}

/** A field's value as the form last had it (the trial brings the form back); credential contents never come back. */
const prefilled = (prefill: Form | undefined, name: string): string => prefill?.get(name) ?? '';

async function systemPage(ctx: PageContext, prefill?: Form, aside?: Html, canForget = false): Promise<Html> {
  const systems = [...new Set((await ctx.deps.packs.list(ctx.principal)).filter((pack) => pack.kind === 'system' && !pack.withdrawn).map((pack) => pack.id))];
  const chosen = prefilled(prefill, 'system_pack');
  const secretRows = [1, 2, 3].map((slot) => html`${field(`凭据名称 ${slot}`, html`<input name="secret_name_${slot}" autocomplete="off" placeholder="DEMO_TOKEN" pattern="[A-Z][A-Z0-9_]{0,63}" value="${prefilled(prefill, `secret_name_${slot}`)}">`)}${field(`凭据内容 ${slot}`, html`<input type="password" name="value_${slot}" autocomplete="off">`)}`);
  const form = actionForm('system-add', ctx.csrf ?? '', html`<div data-fields>
${field(uiLabelOf('pack_kind', 'system'), systems.length === 0 ? html`<select name="system_pack" required disabled><option>尚无业务系统接入</option></select>` : html`<select name="system_pack" required>${systems.map((id) => html`<option value="${id}"${id === chosen ? html` selected` : ''}>${id}</option>`)}</select>`, { hint: '业务系统接入声明访问方式与只读接口' })}
${field('名称', html`<input name="name" required maxlength="200" value="${prefilled(prefill, 'name')}">`)}
${field('环境', html`<select name="environment" required>${environmentOptions(prefilled(prefill, 'environment'))}</select>`)}
${field('允许明文 http 的角色', html`<input name="plaintext" placeholder="逗号分隔，可留空" value="${prefilled(prefill, 'plaintext')}">`)}
${field('访问地址', html`<textarea name="origins" rows="3" required placeholder="api=https://192.0.2.20">${prefilled(prefill, 'origins')}</textarea>`, { hint: '每行 角色=地址；业务系统接入声明的每个角色一行', full: true })}
${field('设置', html`<textarea name="settings" rows="2" placeholder="tenant=demo">${prefilled(prefill, 'settings')}</textarea>`, { hint: '每行 键=值，可留空', full: true })}
${field('凭据项', html`<textarea name="credentials" rows="2" placeholder="token=DEMO_TOKEN">${prefilled(prefill, 'credentials')}</textarea>`, { hint: '每行 凭据项=凭据名称；内容在下面填写，或之后在运行 Hub 的服务器上设置', full: true })}
${secretRows}
<div data-wide-field><button type="submit" class="ch-btn ch-btn--secondary" formaction="/console/admin/do/system-test" formnovalidate title="只尝试读取接口并记录结果，不保存配置与凭据内容">尝试连接</button> </div>
${canForget ? html`<div data-wide-field><button type="submit" class="ch-btn ch-btn--secondary" formaction="/console/admin/do/system-test-forget" formnovalidate title="确认业务系统账户已解锁后，重新填写同一组凭据再清除，不会发送登录或自动重试。">清除这组凭据的失败记录</button></div>` : ''}
</div>`, '接入', { primary: true });
  const trialStep = aside === undefined ? 1 : 2;
  return html`${steps(['选择业务系统接入', '访问地址与凭据', '尝试连接', '完成'], trialStep)}
<section class="ch-section" data-columns="2">
${card({ title: '业务系统', hint: '只读访问，不修改业务数据；凭据内容仅写入密钥库，之后不再显示，尝试连接后需重新填写。' }, html`${form}`)}
${aside ?? card({ title: '尝试连接', meta: '可选', hint: '接入前以只读方式尝试读取业务系统接入声明的接口：登录（若业务系统接入声明）至多一次，只尝试读取不需要参数的接口，显示认证结果、各接口结果与响应时间。每次尝试连接记一条尝试读取记录，不保存配置、凭据内容或来源原文；登录失败时加密保存防止重复登录的摘要。' }, html``)}
</section>`;
}

/** The system operation's page after a trial: the form as it was (without credential contents) and the trial's result. */
export async function systemTrialPage(ctx: PageContext, form: Form, outcome: TrialOutcome): Promise<PageResult> {
  if ('status' in outcome && outcome.status === 404) return neutralPage(ctx);
  const aside = 'report' in outcome ? trialCard(outcome.report) : card({ title: '尝试连接结果' }, html`<p class="error">${outcome.message}</p>`);
  const meta = TITLES.system;
  const canForget = 'report' in outcome && outcome.report.auth.reason === TRIAL_LOGIN_STOPPED;
  return { status: 'report' in outcome ? 200 : outcome.status, body: page(ctx.chrome(meta.title, { active: meta.active, hint: meta.hint }), await systemPage(ctx, form, aside, canForget)) };
}

/** Keep the typed names and addresses, never the credential contents, after a targeted reset. */
export async function systemForgetPage(ctx: PageContext, form: Form, outcome: ForgetOutcome): Promise<PageResult> {
  if ('status' in outcome && outcome.status === 404) return neutralPage(ctx);
  const message = 'forgotten' in outcome ? forgetTrialMessage(outcome.forgotten) : outcome.message;
  const aside = card({ title: '登录失败记录' }, html`<p>${message}</p>`);
  const meta = TITLES.system;
  const canForget = !('forgotten' in outcome) || (outcome.forgotten.found && !outcome.forgotten.cleared);
  return { status: 'forgotten' in outcome ? 200 : outcome.status, body: page(ctx.chrome(meta.title, { active: meta.active, hint: meta.hint }), await systemPage(ctx, form, aside, canForget)) };
}

function packPage(ctx: PageContext, staging: PackStaging): Html {
  const kind=publishingKind(ctx), label=uiLabelOf('pack_kind',kind);
  const form = actionForm('pack-stage', ctx.csrf ?? '', html`<div data-fields>${field(`${label} zip 文件`, html`<input type="file" name="archive" accept=".zip,application/zip" required>`, { hint: '发布文件夹压缩成的 zip，文件夹中要有 pack.json', full: true })}</div>`, '上传并校验', { multipart: true, primary: true, kind });
  const staged = staging.list(ctx.principal.id).filter(stage=>!stage.space&&(stage.kind??'workflow')===kind);
  const waiting = staged.length === 0 ? '' : html`<div>${card({ title: `暂存的${label}`, tail: chip('等待发布中', 'judgment'), hint: '仅暂存人可见，30 分钟内有效' }, html`<div class="ch-section">${staged.map((stage) => html`<div><p>${technicalCode(`${stage.pack}@${stage.version} · ${stage.digest}`)} <span class="ch-meta">暂存至 ${when(new Date(stage.expires).toISOString())}</span></p>${stageForms(stage, ctx.csrf ?? '')}</div>`)}</div>`)}</div>`;
  return html`<section class="ch-section" aria-label="选择发布用途"><p>${packPurpose(kind)}</p><nav class="ch-seg" aria-label="发布用途">${([['workflow','完成有验收要求的任务'],['skill','提供通用做法'],...(ctx.admin?[['system','接入业务系统'],['product','提供产品知识来源']]:[])] as const).map(([value,text])=>html`<a href="${href('/console/operations/pack',{kind:value})}"${value===kind?html` aria-current="page"`:''}>${text}</a>`)}</nav><p class="ch-meta">选择的是发布入口；上传内容的类型仍由 pack.json 声明并按原规则校验。</p></section>${steps(['上传', '发布校验', '发布', '完成'], 0)}
<section class="ch-section" data-columns="2">
${card({ title: `上传${label}`, hint: '上传人需为维护人；先检查结构、样例和来源，通过后暂存 30 分钟，确认发布时重新检查，相同内容不重复发布。' }, html`${form}`)}
${card({ title: '在运行 Hub 的服务器上发布',hint:'维护人在运行 Hub 的服务器上先检查再发布，检查与记录和控制台相同。' }, html`<pre class="ch-quote"><code>${'circle-hub pack publish <文件夹> --dry-run\ncircle-hub pack publish <文件夹>'}</code></pre><p>${link(packHome(kind).path,'查看已发布版本')}</p>`)}
</section>${waiting}`;
}

async function knowledgePage(ctx: PageContext, jobs: JobStore): Promise<Html> {
  const products = [...new Set((await ctx.deps.packs.list(ctx.principal)).filter((pack) => isPackKind(pack.kind) && pack.kind === 'product' && pack.active && !pack.withdrawn).map((pack) => pack.id))];
  const form = actionForm('knowledge-sync', ctx.csrf ?? '', html`<div data-fields>
${field('产品', html`<input name="product" list="products" required>`, { hint: '已启用的产品知识来源；每个产品导入哪些内容由它的产品包声明，列在下面' })}
${field('版本线', html`<input name="line" placeholder="可留空">`, { hint: '留空时导入全部版本线' })}
<label class="check" data-wide-field><input type="checkbox" name="dry_run" value="1"> 试运行：只读取并预览新增、修改、删除的条目，不写入</label>
<datalist id="products">${products.map((id) => html`<option value="${id}">`)}</datalist>
</div>`, '开始导入', { primary: true });
  // What each enabled product's source imports, by the titles its own producers declare (issue 238): the page says it per
  // product, beside the choice, instead of assuming builds, manuals or command trees of every import.
  const declared = (await ctx.deps.products?.products?.() ?? []).filter((handle) => products.includes(handle.product.id));
  const materials = declared.length === 0 ? '' : html`<div data-product-materials><p class="ch-meta">各产品来源导入的内容，由产品包自己声明：</p>${table(['产品', '导入的内容'], declared.map((handle) => [html`<b>${handle.product.title}</b> ${code(handle.product.id)}`, handle.product.producers.length === 0 ? '未声明' : html`<ul class="ch-plain-list">${handle.product.producers.map((producer) => html`<li>${producer.title}</li>`)}</ul>`]))}</div>`;
  return html`${steps(['选择来源', '试运行', '导入', '发布新版本'], 0)}
<section class="ch-section" data-columns="2">
${card({ title: '按产品来源导入', hint: '从所选产品已配置的知识来源，在后台只读导入团队知识，每条附来源；Hub 重启时需重新发起，已导入的内容保留。' }, html`${form}${materials}`)}
${ctx.deps.knowledge?.spaces ? card({title:'按团队读取原文导入',hint:'无须产品包；管理员填写陈述、文件夹与团队连接读取原文的引用，引文逐条核对'},html`${link('/console/knowledge/space','导入团队知识条目',{space:'team'})}`) : ''}
</section>
<div>${liveModule('imports', ['import.progress', 'knowledge.published'], card(null, jobsSection(jobs.list())))}</div>
`;
}

const TITLES: Readonly<Record<Operation, { title: string; hint: string; active: 'team' | 'settings' | 'connections' | 'packs' | 'knowledge' }>> = {
  member: { title: '添加成员', hint: '创建密码账户，初始密码仅显示一次且首次登录须修改；客户端连接绑定该成员账户', active: 'team' },
  system: { title: '接入业务系统', hint: 'Hub 以只读方式访问业务系统；凭据加密保存，页面与模型只可见名称', active: 'connections' },
  pack: { title: `发布${uiLabelOf('pack_kind','workflow')}`, hint: '上传发布内容，发布校验通过后确认发布，成为新版本', active: 'packs' },
  knowledge: { title: '导入团队知识', hint: '从所选产品已配置的知识来源导入团队知识，每条附来源；导入完成后成为该版本线的当前版本', active: 'knowledge' },
};

/** One operation's page, or the four of them; administrators only, like the actions they post to. */
export async function operationsPage(ctx: PageContext, operation: string | undefined, jobs: JobStore, staging: PackStaging): Promise<PageResult> {
  if (!ctx.admin) return neutralPage(ctx);
  if (operation === undefined) {
    const cards = OPERATIONS.map((name) => card({ title: link(`/console/operations/${name}`, TITLES[name].title), hint:TITLES[name].hint }, html``));
    return { status: 200, body: page(ctx.chrome('管理操作', { active: 'settings', hint: '控制台只执行这四种管理操作；其余操作在相关页面生成命令，在运行 Hub 的服务器上执行' }), html`<section class="ch-section" data-columns="2">${cards}</section>`) };
  }
  if (!isOperation(operation)) return neutralPage(ctx);
  const body = operation === 'member' ? memberPage(ctx) : operation === 'system' ? await systemPage(ctx) : operation === 'pack' ? packPage(ctx, staging) : await knowledgePage(ctx, jobs);
  const meta = operation==='pack' ? {...TITLES.pack,...publication(ctx)} : TITLES[operation];
  return { status: 200, body: page(ctx.chrome(meta.title, { active: meta.active, hint: meta.hint }), body) };
}

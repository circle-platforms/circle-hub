// The four management operations the console runs (proposal decision 6 of 2026-10-31), as step-by-step pages in the design
// canvas's Operations board: adding a member, connecting a business system, publishing a task pack and importing knowledge.
// Each form posts to /console/admin/do/<action>, which runs the same `circle-hub` commands as the command line (decision
// 75). Adding a member issues an invitation code for the standard authorization, or a token for a client without it;
// publishing a task pack is a check of the upload and then its 发布 step (manage.ts). The step the backend does not have
// yet (a read-only connection test) is marked as planned.
import { isPackKind, uiLabelOf } from '../../../contracts/generated/vocabulary.ts';
import { code, html, link, liveModule, page, type Html } from './html.ts';
import { actionForm, environmentOptions, jobsSection, roleOptions, stageForms, type JobStore } from './manage.ts';
import { neutralPage, type PageContext, type PageResult } from './pages.ts';
import type { PackStaging } from './staging.ts';
import { card, chip, plannedCard, stepper as steps, when } from './ui.ts';

const OPERATIONS = ['member', 'system', 'pack', 'knowledge'] as const;
type Operation = (typeof OPERATIONS)[number];

export const isOperation = (value: string): value is Operation => (OPERATIONS as readonly string[]).includes(value);

const field = (label: string, control: Html, options: { hint?: string; full?: boolean } = {}): Html =>
  html`<label${options.full ? html` class="full"` : ''}>${label}${control}${options.hint === undefined ? '' : html`<span class="hint">${options.hint}</span>`}</label>`;

function memberPage(ctx: PageContext): Html {
  const form = actionForm('member-add', ctx.csrf ?? '', html`<div class="fields">
${field('姓名', html`<input name="name" required autocomplete="off" maxlength="200">`, { hint: '在控制台、记录与 Circle 中显示' })}
${field('角色', html`<select name="role">${roleOptions()}</select>`, { hint: '管理员可执行四种管理操作并查看全部记录' })}
${field('连接方式', html`<select name="connect"><option value="invitation" selected>邀请码（MCP 标准授权）</option><option value="token">访问令牌</option></select>`, { hint: '客户端不支持 MCP 标准授权时选访问令牌' })}
${field('令牌标签', html`<input name="label" autocomplete="off" maxlength="200" placeholder="MacBook 上的 Circle">`, { hint: '选访问令牌时区分同一成员的多个 Circle，可留空' })}
</div>`, '添加成员', { primary: true });
  return html`${steps(['填写成员', '签发邀请码', '成员授权', '等待连接'], 0)}
<section class="grid g-2-1 section">
${card({ title: '成员信息' }, html`${form}<p class="note">执行 ${code('circle-hub user create')}，再执行 ${code('circle-hub user invite')}（选访问令牌时为 ${code('circle-hub token issue')}）；邀请码与令牌只在结果页显示一次。</p>`)}
${card({ title: '成员如何连接', meta: 'MCP 标准授权' }, html`<ol class="small"><li>把结果页给出的配置写入该成员的 Circle。</li><li>Circle 首次连接时在浏览器中打开授权页。</li><li>成员输入邀请码并确认授权，Circle 即完成连接。</li></ol><p class="sub">邀请码 24 小时内有效，仅可使用一次；过期后在设置中重新签发。</p>`)}
</section>`;
}

async function systemPage(ctx: PageContext): Promise<Html> {
  const systems = [...new Set((await ctx.deps.packs.list(ctx.principal)).filter((pack) => pack.kind === 'system' && !pack.withdrawn).map((pack) => pack.id))];
  const secretRows = [1, 2, 3].map((slot) => html`${field(`凭据名称 ${slot}`, html`<input name="secret_name_${slot}" autocomplete="off" placeholder="DEMO_TOKEN" pattern="[A-Z][A-Z0-9_]{0,63}">`)}${field(`凭据内容 ${slot}`, html`<input type="password" name="value_${slot}" autocomplete="off">`)}`);
  const form = actionForm('system-add', ctx.csrf ?? '', html`<div class="fields">
${field(uiLabelOf('pack_kind', 'system'), systems.length === 0 ? html`<select name="system_pack" required disabled><option>尚无系统包</option></select>` : html`<select name="system_pack" required>${systems.map((id) => html`<option value="${id}">${id}</option>`)}</select>`, { hint: '系统包声明访问方式与只读接口' })}
${field('名称', html`<input name="name" required maxlength="200">`)}
${field('环境', html`<select name="environment" required>${environmentOptions()}</select>`)}
${field('允许明文 http 的角色', html`<input name="plaintext" placeholder="逗号分隔，可留空">`)}
${field('访问地址', html`<textarea name="origins" rows="3" required placeholder="api=https://192.0.2.20"></textarea>`, { hint: '每行 角色=地址；系统包声明的每个角色一行', full: true })}
${field('设置', html`<textarea name="settings" rows="2" placeholder="tenant=demo"></textarea>`, { hint: '每行 键=值，可留空', full: true })}
${field('凭据项', html`<textarea name="credentials" rows="2" placeholder="token=DEMO_TOKEN"></textarea>`, { hint: '每行 凭据项=凭据名称；内容在下面填写，或之后在 Circle 中设置', full: true })}
${secretRows}
</div>`, '接入', { primary: true });
  return html`${steps(['选择系统包', '访问地址与凭据', ['测试连接', true], '完成'], 1)}
<section class="grid g-2-1 section">
${card({ title: '业务系统', meta: '只读访问，不修改业务数据' }, html`${form}<p class="note">先执行 ${code('circle-hub resource add')}，再以 ${code('circle-hub secret set')} 写入凭据；凭据内容只写入密钥库，之后不再显示，建议通过 HTTPS 打开本页。</p>`)}
${plannedCard('测试连接', '保存前以只读方式试读系统包声明的接口，显示认证结果与响应时间，不保存任何内容。', 'sys')}
</section>`;
}

function packPage(ctx: PageContext, staging: PackStaging): Html {
  const form = actionForm('pack-stage', ctx.csrf ?? '', html`<div class="fields">${field('任务包 zip 文件', html`<input type="file" name="archive" accept=".zip,application/zip" required>`, { hint: '任务包目录压缩成的 zip，目录中要有 pack.json', full: true })}</div>`, '上传并校验', { multipart: true, primary: true });
  const staged = staging.list(ctx.principal.id);
  const waiting = staged.length === 0 ? '' : html`<div class="mt16">${card({ title: '暂存的任务包', tail: chip('等待发布中', 'judgment'), meta: '仅暂存人可见，30 分钟内有效' }, html`<div class="stack">${staged.map((stage) => html`<div><p>${code(`${stage.pack}@${stage.version}`)} <span class="sub">摘要 ${stage.digest.slice(0, 12)}… · 暂存至 ${when(new Date(stage.expires).toISOString())}</span></p>${stageForms(stage, ctx.csrf ?? '')}</div>`)}</div>`)}</div>`;
  return html`${steps(['上传', '发布校验', '发布', '完成'], 0)}
<section class="grid g-2-1 section">
${card({ title: '上传任务包', meta: '上传人需为维护人' }, html`${form}<p class="note">先执行 ${code('circle-hub pack publish <目录> --stage --dry-run')}：检查结构、在沙箱中运行检查脚本与样例、核对引用，并与当前版本逐个文件比较，不写入任何内容。通过后暂存 30 分钟，确认发布时执行 ${code('circle-hub pack publish <目录> --stage')}；相同内容不会重复发布。</p>`)}
${card({ title: '在 Circle 中发布' }, html`<p class="sub">维护人也可在 Hub 所在主机上的 Circle 中执行 ${code('circle-hub pack publish <目录> --dry-run')} 校验，再执行 ${code('circle-hub pack publish <目录>')} 发布，检查与记录相同。发布后的版本见${link('/console/packs', '任务包')}。</p>`)}
</section>${waiting}`;
}

async function knowledgePage(ctx: PageContext, jobs: JobStore): Promise<Html> {
  const products = [...new Set((await ctx.deps.packs.list(ctx.principal)).filter((pack) => isPackKind(pack.kind) && pack.kind === 'product' && pack.active && !pack.withdrawn).map((pack) => pack.id))];
  const form = actionForm('knowledge-sync', ctx.csrf ?? '', html`<div class="fields">
${field('产品', html`<input name="product" list="products" required>`, { hint: '已启用的产品包' })}
${field('版本线', html`<input name="line" placeholder="可留空">`, { hint: '留空时导入全部版本线' })}
<label class="check full"><input type="checkbox" name="dry_run" value="1"> 试运行：只读取并预览新增、修改、删除的条目，不写入</label>
<datalist id="products">${products.map((id) => html`<option value="${id}">`)}</datalist>
</div>`, '开始导入', { primary: true });
  return html`${steps(['选择来源', '试运行', '导入', '发布新版本'], 0)}
<section class="grid g-2-1 section">
${card({ title: '导入知识', meta: '后台执行' }, html`${form}<p class="note">执行 ${code('circle-hub knowledge sync')}：从产品包声明的来源以只读方式读取构建、手册与命令树，更新知识库；每条知识均附出处。可能需要几分钟。</p>`)}
${plannedCard('上传文档导入', '从上传的文档与业务系统按条目导入，导入前预览差异；上线后在此选择来源。', 'book')}
</section>
<div class="mt16">${liveModule('imports', ['import.progress', 'knowledge.published'], card(null, jobsSection(jobs.list())))}</div>
<p class="note">Hub 重启时，进行中的导入需重新发起；已导入的内容不受影响。</p>`;
}

const TITLES: Readonly<Record<Operation, { title: string; sub: string; active: 'settings' | 'connections' | 'packs' | 'knowledge' }>> = {
  member: { title: '添加成员', sub: '为成员签发邀请码（MCP 标准授权）或访问令牌，用于连接 Circle。', active: 'settings' },
  system: { title: '接入业务系统', sub: 'Hub 以只读方式访问业务系统；凭据加密保存，页面与模型只可见名称。', active: 'connections' },
  pack: { title: '发布任务包', sub: '上传任务包，发布校验通过后确认发布，成为新版本。', active: 'packs' },
  knowledge: { title: '导入知识', sub: '从产品包声明的来源导入知识，每条附出处；导入完成后为该版本线的当前版本。', active: 'knowledge' },
};

/** One operation's page, or the four of them; administrators only, like the actions they post to. */
export async function operationsPage(ctx: PageContext, operation: string | undefined, jobs: JobStore, staging: PackStaging): Promise<PageResult> {
  if (!ctx.admin) return neutralPage(ctx);
  if (operation === undefined) {
    const cards = OPERATIONS.map((name) => card({ title: link(`/console/operations/${name}`, TITLES[name].title) }, html`<p class="sub">${TITLES[name].sub}</p>`));
    return { status: 200, body: page(ctx.chrome('管理操作', { active: 'settings', sub: '控制台只执行这四种管理操作；其余操作在相关页面生成命令，在管理员的 Circle 中执行。' }), html`<section class="grid g2 section">${cards}</section>`) };
  }
  if (!isOperation(operation)) return neutralPage(ctx);
  const body = operation === 'member' ? memberPage(ctx) : operation === 'system' ? await systemPage(ctx) : operation === 'pack' ? packPage(ctx, staging) : await knowledgePage(ctx, jobs);
  const meta = TITLES[operation];
  return { status: 200, body: page(ctx.chrome(meta.title, { active: meta.active, sub: meta.sub }), body) };
}

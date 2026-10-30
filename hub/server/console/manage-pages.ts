// The management pages of the console (administrators only): task packs, resources, secrets and knowledge sync, each
// with the forms of manage.ts. Users and tokens are on the admin page itself (pages.ts). Every list comes from the same
// ports the read-only pages use; only the secrets list comes from `secret list`, run through the command bridge, since
// the vault's metadata has no port of its own.
import { isEnvironment, labelOf } from '../../../contracts/generated/vocabulary.ts';
import type { CommandRun } from '../command-bridge.ts';
import { code, html, page, pre, section, table, type Html } from './html.ts';
import { actionForm, environmentOptions, jobsSection, manageNav, type JobStore } from './manage.ts';
import { neutralPage, type PageContext, type PageResult } from './pages.ts';

async function userOptions(ctx: PageContext): Promise<Html> {
  const users = (await ctx.deps.records.principals.list()).filter((user) => !user.disabled);
  return html`${users.map((user) => html`<option value="${user.id}">${user.name}（${labelOf('permission_role', user.role)}）</option>`)}`;
}

export async function packsAdminPage(ctx: PageContext): Promise<PageResult> {
  if (!ctx.admin) return neutralPage(ctx);
  const listings = await ctx.deps.packs.list(ctx.principal);
  const users = await userOptions(ctx);
  const rows = [];
  for (const pack of listings) {
    const state = pack.withdrawn ? '已下架' : pack.kind === 'product' ? (pack.active ? '已启用' : '未启用') : '已发布';
    const actions: Html[] = [];
    if (!pack.withdrawn) actions.push(actionForm('pack-retire', ctx.csrf ?? '', html`<input type="hidden" name="ref" value="${`${pack.id}@${pack.version}`}">`, '下架这一版', { inline: true }));
    if (pack.kind === 'product' && !pack.withdrawn) {
      actions.push(actionForm(pack.active ? 'pack-deactivate' : 'pack-activate', ctx.csrf ?? '', html`<input type="hidden" name="pack" value="${pack.id}">`, pack.active ? '停用' : '启用', { inline: true }));
    }
    const assigned = [];
    for (const id of pack.assigned_to ?? []) assigned.push(await ctx.userName(id));
    rows.push([code(`${pack.id}@${pack.version}`), labelOf('pack_kind', pack.kind), pack.title, state, await ctx.userName(pack.owner), assigned.join('、') || '—', actions]);
  }
  const workflows = [...new Set(listings.filter((pack) => pack.kind === 'workflow' && !pack.withdrawn).map((pack) => pack.id))];
  return {
    status: 200,
    body: page(ctx.chrome('任务包管理'), html`${manageNav()}
${section('上传并发布', html`<p>上传任务包目录压缩成的 zip（目录里要有 pack.json）；按 pack.json 列出的文件发布，同样内容不会重复发布。上传的人要有发布权。</p>
${actionForm('pack-publish', ctx.csrf ?? '', html`<p><input type="file" name="archive" accept=".zip,application/zip" required></p>`, '上传并发布', { multipart: true })}`)}
${section('任务包', table(['任务包', '种类', '标题', '状态', '所有者', '分配给', '操作'], rows, '还没有发布任何任务包'))}
${section('分配工作流包', actionForm('pack-assign', ctx.csrf ?? '', html`<label>用户 <select name="user" required>${users}</select></label>
<label>工作流包 <select name="pack" required>${workflows.map((id) => html`<option value="${id}">${id}</option>`)}</select></label>`, '分配'))}
${actionForm('pack-unassign', ctx.csrf ?? '', html`<label>用户 <select name="user" required>${users}</select></label>
<label>工作流包 <select name="pack" required>${workflows.map((id) => html`<option value="${id}">${id}</option>`)}</select></label>`, '取消分配')}
${section('发布权', html`${actionForm('pack-grant', ctx.csrf ?? '', html`<label>用户 <select name="user" required>${users}</select></label>`, '授予发布权')}
${actionForm('pack-revoke', ctx.csrf ?? '', html`<label>用户 <select name="user" required>${users}</select></label>`, '撤销发布权')}`)}`),
  };
}

export async function resourcesAdminPage(ctx: PageContext): Promise<PageResult> {
  if (!ctx.admin) return neutralPage(ctx);
  const resources = await ctx.deps.resources.list(ctx.principal);
  const systems = [...new Set((await ctx.deps.packs.list(ctx.principal)).filter((pack) => pack.kind === 'system' && !pack.withdrawn).map((pack) => pack.id))];
  const rows = resources.map((r) => {
    const id = html`<input type="hidden" name="resource" value="${r.id}">`;
    return [
      code(r.id),
      r.system_pack,
      r.name,
      isEnvironment(r.environment) ? labelOf('environment', r.environment) : r.environment,
      r.enabled ? '启用' : '停用',
      r.origins === undefined ? '' : html`${Object.entries(r.origins).map(([role, origin]) => html`<div>${role}：${code(origin)}</div>`)}`,
      r.binding_error ? html`<span class="error">${r.binding_error.message}</span>` : '',
      html`${actionForm(r.enabled ? 'resource-disable' : 'resource-enable', ctx.csrf ?? '', id, r.enabled ? '停用' : '启用', { inline: true })}${actionForm('resource-reset-login', ctx.csrf ?? '', id, '重置登录', { inline: true })}`,
    ];
  });
  return {
    status: 200,
    body: page(ctx.chrome('资源管理'), html`${manageNav()}
${section('资源', table(['资源', '系统包', '名称', '环境', '状态', '地址', '问题', '操作'], rows, '还没有资源'))}
${section('添加资源', html`<p>资源是系统包的一个实例：系统包声明的每个角色给一个地址。凭据写成 凭据项=密钥名，密钥的值在“密钥”页设置。修改已有资源暂时用命令 circle-hub resource update。</p>
${actionForm('resource-add', ctx.csrf ?? '', html`<p><label>系统包 <select name="system_pack" required>${systems.map((id) => html`<option value="${id}">${id}</option>`)}</select></label>
<label>名称 <input name="name" required size="24"></label>
<label>环境 <select name="environment" required>${environmentOptions()}</select></label></p>
<p><label>地址（每行 角色=URL）<br><textarea name="origins" rows="3" cols="70" required></textarea></label></p>
<p><label>允许明文 http 的角色（逗号分隔，可空） <input name="plaintext" size="30"></label></p>
<p><label>设置（每行 键=值，可空）<br><textarea name="settings" rows="3" cols="70"></textarea></label></p>
<p><label>凭据（每行 凭据项=密钥名，可空）<br><textarea name="credentials" rows="2" cols="70"></textarea></label></p>`, '添加')}`)}`),
  };
}

export async function secretsAdminPage(ctx: PageContext, run: ((argv: string[]) => Promise<CommandRun>) | null): Promise<PageResult> {
  if (!ctx.admin) return neutralPage(ctx);
  const listing = run === null ? null : await run(['secret', 'list']);
  return {
    status: 200,
    body: page(ctx.chrome('密钥管理'), html`${manageNav()}
${section('已登记的密钥（不显示值）', listing === null ? html`<p class="error">网页管理不可用</p>` : listing.code === 0 ? (listing.stdout.length > 0 ? pre(listing.stdout.join('\n')) : html`<p class="empty">还没有密钥</p>`) : html`<pre class="error">${[...listing.stdout, ...listing.stderr].join('\n')}</pre>`)}
${section('设置密钥', html`<p>名字要先在资源或执行器的定义里以 \${secret:名字} 引用。值只写进密钥库，之后不再显示；最好通过 HTTPS 打开本页。</p>
${actionForm('secret-set', ctx.csrf ?? '', html`<p><label>名字 <input name="name" required size="24"></label>
<label>值 <input type="password" name="value" required size="40" autocomplete="off"></label></p>
<p><label>理由 <input name="reason" required size="50"></label></p>`, '设置')}`)}
${section('撤回密钥', actionForm('secret-unset', ctx.csrf ?? '', html`<p><label>名字 <input name="name" required size="24"></label>
<label>理由 <input name="reason" required size="50"></label></p>`, '撤回'))}`),
  };
}

export async function knowledgeAdminPage(ctx: PageContext, jobs: JobStore): Promise<PageResult> {
  if (!ctx.admin) return neutralPage(ctx);
  const products = (await ctx.deps.packs.list(ctx.principal)).filter((pack) => pack.kind === 'product' && pack.active && !pack.withdrawn).map((pack) => pack.id);
  return {
    status: 200,
    body: page(ctx.chrome('知识同步'), html`${manageNav()}
${section('同步', html`<p>从产品包声明的来源读取构建、手册和命令树，更新知识树。可能要几分钟，会在后台运行；先试运行（只读不写）可以看会读到什么。</p>
${actionForm('knowledge-sync', ctx.csrf ?? '', html`<p><label>产品 <input name="product" list="products" required size="24"></label>
<datalist id="products">${[...new Set(products)].map((id) => html`<option value="${id}">`)}</datalist>
<label>版本线（可空） <input name="line" size="16"></label>
<label><input type="checkbox" name="dry_run" value="1"> 试运行</label></p>`, '开始同步')}`)}
${jobsSection(jobs.list())}`),
  };
}

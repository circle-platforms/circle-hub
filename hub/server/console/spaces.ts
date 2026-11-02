// Space pages and owner actions. Services enforce the same boundaries for browser forms and MCP calls.
import { z } from 'zod';
import { ENTRY_KIND, KNOWLEDGE_SEARCH_SCOPE, KNOWLEDGE_GRANTEE, KnowledgeGranteeSchema, isKnowledgeGrantAction, isKnowledgeSearchScope, uiLabelOf } from '../../../contracts/generated/vocabulary.ts';
import { Sha256 } from '../../../contracts/src/common.ts';
import { KnowledgeError, type SpaceEntryView } from '../../knowledge/api.ts';
import { RecordsError } from '../../records/api.ts';
import { code, html, link, page, pre, table, type Html } from './html.ts';
import { neutralPage, treePage, type PageContext, type PageResult } from './pages.ts';
import { button, card, chip, kv, sectionHead, when } from './ui.ts';
const field = (name: string, control: Html, hint?: string) => html `<label${hint ? html ` title="${hint}"` : ''}>${name}${control}</label>`;
function form(ctx: PageContext, action: string, fields: Html, label: string, multipart = false): Html {
  return html `<form method="post" action="/console/knowledge/do/${action}"${multipart ? html ` enctype="multipart/form-data"` : ''}><input type="hidden" name="csrf" value="${ctx.csrf ?? ''}"><div class="fields">${fields}</div><button type="submit" class="btn primary mt12">${label}</button></form>`;
}
const spaceContent = (content: Html) => html `<div class="knowledge-space">${content}</div>`;
const spaceLink = (space: string, root?: string, path = '/') => ({ space, ...(root ? { root } : {}), path });
const bytes = (value: number) => `${value.toLocaleString('zh-CN')} 字节`;
export async function spaceOverview(ctx: PageContext): Promise<Html> {
  const spaces = ctx.deps.knowledge.spaces;
  if (!spaces)
    return html ``;
  const visible = await spaces.visible(ctx.principal);
  const own = visible.find(s => s.space === ctx.principal.id)!;
  const team = visible.find(s => s.space === 'team')!;
  const shared = visible.filter(s => s.space !== 'team' && s.space !== ctx.principal.id);
  const sharedRows = await Promise.all(shared.map(async (s) => [await ctx.userName(s.space), html `${s.paths.map(path => html `<div>${link('/console/knowledge/space', path, spaceLink(s.space, undefined, path))}</div>`)}`]));
  return html `<div class="knowledge-spaces grid g3 section">
${card({ title: uiLabelOf('knowledge_search_scope', 'personal'), hint: '默认仅本人可读；可按空间或目录授权。内容保存在 Hub 的服务器数据库中，并包含在服务器备份中。' }, html `${kv([['知识版本', code(own.version.root.slice(0, 16))], ['已用容量（含历史）', bytes(own.version.body.used_bytes)], ['容量上限', bytes(await spaces.capacity(ctx.principal.id))]])}<div class="actions mt12">${button('/console/knowledge/space', '浏览目录', { params: spaceLink(own.space) })}${button('/console/knowledge/space', '添加条目', { params: { space: own.space, edit: '1' } })}${button('/console/knowledge/space', '导入个人知识', { params: { space: own.space, import: '1' }, hint: '上传本人文件到个人空间，原文仅本人及获授权者可读；条目由 Circle 起草，Hub 不生成内容' })}</div>`)}
${card({ title: uiLabelOf('knowledge_search_scope', 'team'), hint: '团队条目全体成员可读；产品目录沿用产品线读取权限。由管理员导入或产品知识来源同步写入。' }, html `${kv([['知识版本', code(team.version.root.slice(0, 16))]])}<div class="actions mt12">${button('/console/knowledge/space', '浏览目录', { params: spaceLink('team') })}${ctx.admin ? button('/console/operations/knowledge', '导入团队知识', { hint: '从产品知识来源导入团队知识；也可在团队目录导入有团队读取原文的条目' }) : ''}</div>`)}
${card({ title: uiLabelOf('knowledge_search_scope', 'shared'), hint: '只列出当前授权给本账户或全体管理员的个人目录。收回授权后不能继续读取；已读或已引用的内容无法追回。' }, shared.length ? table(['来自', '可读目录'], sharedRows) : html `<p class="empty">没有获授权的个人目录</p>`)}
</div>`;
}
function editor(ctx: PageContext, space: string, path: string, draft?: SpaceEntryView): Html {
  const content = draft?.body.content, grounds = draft?.body.grounds ?? [];
  const title = draft ? (space === 'team' ? '修改团队条目' : '修改个人条目') : (space === 'team' ? '导入团队知识条目' : '添加个人条目');
  const hint = space === 'team' ? '仅管理员可导入；条目及依据原文对全体成员可读。必须引用经团队凭据读取的业务系统原文，当前不接受上传文件作为团队依据。' : '没有依据的笔记记为未核验；提供依据时逐字核对引文与路径，核验不代表陈述内容已被判为事实。修改会创建新条目并取代旧条目。';
  return card({ title, hint }, form(ctx, 'entry', html `
<input type="hidden" name="space" value="${space}">
${draft ? html `<input type="hidden" name="replaces" value="${draft.row.entry}"><input type="hidden" name="expected_version" value="${draft.root}">` : ''}
${field('目录路径', html `<input name="path" value="${path}" required maxlength="2000">`)}
${field('种类', html `<select name="kind">${ENTRY_KIND.map(kind => html `<option value="${kind}"${kind === (content?.kind ?? 'observation') ? html ` selected` : ''}>${uiLabelOf('entry_kind', kind)}</option>`)}</select>`)}
${field('陈述', html `<textarea name="statement" required maxlength="262144" rows="4">${content?.statement ?? ''}</textarea>`)}
${field('结构化数据（可选 JSON）', html `<textarea name="data" rows="2" placeholder="{}">${content ? JSON.stringify(content.data, null, 2) : ''}</textarea>`)}
${field('适用条件（可选 JSON）', html `<textarea name="applicability" rows="2" placeholder="null">${content?.applicability ? JSON.stringify(content.applicability, null, 2) : ''}</textarea>`, '产品线、版本和运行环境等条件；留空表示未声明，不要求产品包')}
${Array.from({ length: Math.min(100, Math.max(3, grounds.length + 1)) }, (_, i) => html `<div class="full fields">${field(`依据引用 ${i + 1}`, html `<input name="ground_${i}" value="${grounds[i]?.reference ?? ''}"${space === 'team' && i === 0 ? html ` required` : ''}>`)}${field(`逐字引文 ${i + 1}`, html `<textarea name="quotation_${i}" rows="2"${space === 'team' && i === 0 ? html ` required` : ''}>${grounds[i]?.quotation ?? ''}</textarea>`)}</div>`)}
${field('修改原因', html `<input name="reason" maxlength="1000" value="${draft ? '修订知识条目' : space === 'team' ? '团队知识导入' : '个人条目写入'}" required>`)}
`, draft ? '保存修改' : space === 'team' ? '导入条目' : '保存条目'));
}
export async function spacePage(ctx: PageContext): Promise<PageResult> {
  const spaces = ctx.deps.knowledge.spaces;
  if (!spaces)
    return neutralPage(ctx);
  const space = ctx.url.searchParams.get('space') ?? ctx.principal.id;
  const paths = await spaces.paths(ctx.principal, space);
  if (!paths.length)
    return neutralPage(ctx);
  const own = space === ctx.principal.id;
  const selected = ctx.url.searchParams.get('root');
  if (selected && !Sha256.safeParse(selected).success)
    return neutralPage(ctx);
  const version = selected ? await spaces.version(selected) : own || space === 'team' ? await spaces.ensure(ctx.principal, space) : await spaces.current(space);
  if (!version || version.body.space !== space)
    return neutralPage(ctx);
  const path = ctx.url.searchParams.get('path') ?? paths[0];
  if (!(await spaces.mayRead(ctx.principal, space, path)))
    return neutralPage(ctx);
  const label = space === 'team' ? uiLabelOf('knowledge_space_kind', 'team') : own ? uiLabelOf('knowledge_space_kind', 'personal') : `${await ctx.userName(space)}的${uiLabelOf('knowledge_space_kind', 'personal')}`;
  const title = space === 'team' ? uiLabelOf('knowledge_space_kind', 'team') : own ? uiLabelOf('knowledge_space_kind', 'personal') : uiLabelOf('knowledge_search_scope', 'shared');
  const chrome = ctx.chrome(title + '知识', { active: 'knowledge', sub: html `${link('/console/knowledge', '知识库')} › <span class="space-owner">${label}</span> › ${path}` });
  const digest = ctx.url.searchParams.get('entry');
  if (digest) {
    const entry = await spaces.entry(ctx.principal, version.root, path, digest);
    if (!entry) {
      const mount = version.body.products.find(p => path === p.path || path.startsWith(p.path + '/'));
      if (mount) {
        const visible = await ctx.deps.knowledge.getNodes({ root: version.root, paths: [path], depth: 0 }, ctx.principal);
        if (visible?.nodes.some(n => n.entries.some(e => e.entry === digest))) {
          const url = new URL('/console/knowledge/tree', ctx.url);
          url.searchParams.set('root', mount.root);
          url.searchParams.set('path', path.slice(mount.path.length) || '/');
          return treePage({ ...ctx, url });
        }
      }
      return neutralPage(ctx);
    }
    const canEdit = (own || space === 'team' && ctx.admin) && (entry.row.status === 'verified' || entry.row.status === 'unverified');
    const body = html `${card({ title: entry.body.content.statement, tail: chip(uiLabelOf('knowledge_entry_status', entry.row.status)), hint: '核验结果说明引文与路径是否一致，不把作者的陈述或判断变成已证实事实' }, html `${kv([['种类', uiLabelOf('entry_kind', entry.body.content.kind)], ['引用', code(entry.reference)], ['作者', await ctx.userName(entry.body.by)], ['记录时间', when(entry.body.at)], ['被引用次数', entry.cited_count ?? '—'], ['适用条件', entry.body.content.applicability ? JSON.stringify(entry.body.content.applicability) : '未声明']])}${pre(JSON.stringify(entry.body.content.data, null, 2))}${sectionHead('依据与核验结果')}${table(['引用', '逐字引文'], entry.body.grounds.map(g => [code(g.reference), g.quotation]), '未提供依据，内容未核验')}${canEdit ? button('/console/knowledge/space', '修改条目', { params: { ...spaceLink(space, version.root, path), entry: digest, edit: '1' } }) : ''}${canEdit ? form(ctx, 'withdraw', html `<input type="hidden" name="entry" value="${digest}"><input type="hidden" name="space" value="${space}"><input type="hidden" name="path" value="${path}">`, '撤回条目') : ''}`)}${canEdit && ctx.url.searchParams.get('edit') === '1' ? editor(ctx, space, path, entry) : ''}<p class="mt12">${link('/console/knowledge/space', '返回目录', spaceLink(space, version.root, path))}</p>`;
    return { status: 200, body: page(chrome, html `<div class="knowledge-space">${body}</div>`) };
  }
  const nodes = await ctx.deps.knowledge.getNodes({ root: version.root, paths: [path], depth: 1, cursor: ctx.url.searchParams.get('node_cursor') }, ctx.principal);
  if (!nodes)
    return neutralPage(ctx);
  const directory = card({ title: '目录与条目', meta: code(version.root), hint: '知识版本固定目录和条目内容；状态与授权按当前记录重新检查。被引用次数是条目的累计受理提交统计，个人统计仅本人可见。' }, html `${nodes.nodes.map(node => html `${sectionHead(node.path)}${table(['下级目录'], node.children.map(child => [link('/console/knowledge/space', child.name, spaceLink(space, version.root, child.path))]), '没有下级目录')}${table(['种类', '陈述', '状态', '被引用'], node.entries.map(entry => [uiLabelOf('entry_kind', entry.kind), link('/console/knowledge/space', entry.statement, { ...spaceLink(space, version.root, node.path), entry: entry.entry }), entry.status ? uiLabelOf('knowledge_entry_status', entry.status) : '—', entry.cited_count ?? '—']), '没有条目')}`)}${nodes.next ? html `<p>${link('/console/knowledge/space', '下一页', { ...spaceLink(space, version.root, path), node_cursor: nodes.next })}</p>` : ''}`);
  const history = await spaces.history(ctx.principal, space, ctx.url.searchParams.get('history_cursor'));
  const comparison = !own&&space!=='team'?card({title:'知识版本历史'},html`<p class="note">个人空间的版本历史仅本人可见；目录授权不包含历史记录、时间和原因。</p>`):card({ title: '知识版本历史', hint: '知识版本是空间的历史快照；产品版本是条目的适用条件，两者分别选择' }, html `${table(['时间', '记录人', '原因', '知识版本'], await Promise.all(history.items.map(async (item) => [when(item.body.at), item.body.by===null?uiLabelOf('execution_host','hub'):await ctx.userName(item.body.by), item.body.reason, link('/console/knowledge/space', item.root.slice(0, 16), spaceLink(space, item.root, path))])), '没有历史版本')}${history.next ? link('/console/knowledge/space', '更早的版本', { ...spaceLink(space, undefined, path), history_cursor: history.next }) : ''}
<form class="filters" method="get" action="/console/knowledge/space-diff"><input type="hidden" name="space" value="${space}"><label>从<select name="from">${history.items.map((item, index) => html `<option value="${item.root}"${index === Math.min(1, history.items.length - 1) ? html ` selected` : ''}>${item.body.at} · ${item.root.slice(0, 12)}</option>`)}</select></label><label>到<select name="to">${history.items.map(item => html `<option value="${item.root}">${item.body.at} · ${item.root.slice(0, 12)}</option>`)}</select></label><button type="submit">比较知识版本</button></form>`);
  let controls: Html = html ``;
  if (own || space === 'team' && ctx.admin) {
    controls = html `${form(ctx, 'directory', html `<input type="hidden" name="space" value="${space}">${field('新目录路径', html `<input name="path" required value="${path === '/' ? '/notes' : path + '/notes'}">`)}`, '建立目录')}${editor(ctx, space, path)}`;
  }
  let authorization: Html = html ``;
  if (own) {
    const grants = await spaces.grants(ctx.principal);
    authorization = card({ title: '只读授权', hint: '本人可授权整个空间或指定目录。收回后对方不能继续读取，但无法追回已读过或已引用的内容；个人凭据读取的来源不能授权。' }, html `${form(ctx, 'grant', html `${field('授权目录', html `<input name="path" value="${path}" required>`)}${field('授权对象', html `<select name="audience">${KNOWLEDGE_GRANTEE.map(a => html `<option value="${a}">${uiLabelOf('knowledge_grantee', a)}</option>`)}</select>`)}${field('成员用户名', html `<input name="member">`, '授权对象为指定成员时填写')}`, '授权')}${table(['目录', '授权对象', '成员', '操作'], await Promise.all(grants.map(async (grant) => [grant.path, uiLabelOf('knowledge_grantee', grant.audience), grant.member ? await ctx.userName(grant.member) : '—', form(ctx, 'revoke', html `<input type="hidden" name="path" value="${grant.path}"><input type="hidden" name="audience" value="${grant.audience}"><input type="hidden" name="member_id" value="${grant.member ?? ''}">`, '收回授权')])), '尚无授权')}`);
  }
  const sources = await spaces.sources(ctx.principal, space);
  const originals = card({ title: '空间原文', hint: space === 'team' ? '经管理员导入、供团队条目引用的业务系统原文，全体成员可读' : '上传的原文保存在所属个人空间，不自动生成条目；可在 Circle 中按引用读取后起草，或手动添加带逐字引文的条目' }, html `${table(['目录', '大小', '引用'], sources.map(s => [s.path, bytes(s.size), link('/console/knowledge/source', 'src:' + s.sha256, { sha256: s.sha256 })]), '没有可读的原文')}${own ? form(ctx, 'import', html `${field('原文文件', html `<input name="archive" type="file" required>`)}${field('所在目录', html `<input name="path" value="${path}" required>`)}`, '导入个人知识', true) : ''}`);
  return { status: 200, body: page(chrome, html `<div class="knowledge-space stack">${directory}${controls}${originals}${authorization}${comparison}</div>`) };
}
export async function spaceDiffPage(ctx: PageContext): Promise<PageResult> {
  const spaces = ctx.deps.knowledge.spaces;
  if (!spaces)
    return neutralPage(ctx);
  const from = ctx.url.searchParams.get('from') ?? '', to = ctx.url.searchParams.get('to') ?? '';
  if (!Sha256.safeParse(from).success || !Sha256.safeParse(to).success)
    return neutralPage(ctx);
  const diff = await spaces.diff(ctx.principal, from, to);
  if (!diff)
    return neutralPage(ctx);
  const rows = [...diff.added.map(path => [uiLabelOf('change_kind', 'added'), path]), ...diff.modified.map(path => [uiLabelOf('change_kind', 'modified'), path]), ...diff.removed.map(path => [uiLabelOf('change_kind', 'removed'), path])];
  return { status: 200, body: page(ctx.chrome('知识版本差异', { active: 'knowledge' }), spaceContent(card({ title: '条目与路径变化', meta: `${from.slice(0, 12)} → ${to.slice(0, 12)}` }, table(['变化', '路径'], rows, '没有条目变化')))) };
}
export async function spaceSourcePage(ctx: PageContext): Promise<PageResult> {
  const sha = ctx.url.searchParams.get('sha256') ?? '';
  if (!Sha256.safeParse(sha).success)
    return neutralPage(ctx);
  const source = await ctx.deps.knowledge.spaces?.source(ctx.principal, sha);
  if (!source)
    return neutralPage(ctx);
  let text: string | null = null;
  if (source.bytes) {
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(source.bytes.subarray(0, 1024 * 1024), { stream: source.bytes.length > 1024 * 1024 });
    }
    catch { }
  }
  return { status: 200, body: page(ctx.chrome('知识原文', { active: 'knowledge' }), spaceContent(card({ title: 'src:' + sha, meta: bytes(source.size) }, html `${text === null ? html `<p>原文暂不可读</p>` : pre(text)}${source.size > 1024 * 1024 ? html `<p>仅显示前 1 MiB；完整原文可在 Circle 中按引用分页读取。</p>` : ''}`))) };
}
export async function spaceSearch(ctx: PageContext): Promise<Html> {
  const spaces = ctx.deps.knowledge.spaces;
  if (!spaces)
    return html ``;
  const text = ctx.url.searchParams.get('q') ?? '', requested = ctx.url.searchParams.get('scope') ?? 'all';
  if (!isKnowledgeSearchScope(requested))
    throw new KnowledgeError('搜索范围不正确', { code: 'SPACE_ENTRY_INVALID' });
  const form = html `<form class="filters" method="get" action="/console/search"><label>关键词<input name="q" value="${text}" required maxlength="200"></label><label>知识范围<select name="scope">${KNOWLEDGE_SEARCH_SCOPE.map(scope => html `<option value="${scope}"${requested === scope ? html ` selected` : ''}>${uiLabelOf('knowledge_search_scope', scope)}</option>`)}</select></label><button type="submit">搜索</button></form>`;
  if (!text.trim())
    return card({ title: '知识全文搜索', hint: '搜索陈述、结构化数据与已记录的引文；范围按当前授权过滤，结果只作为线索' }, form);
  let found:Awaited<ReturnType<typeof spaces.search>>;
  try{found=await spaces.search(ctx.principal, text, requested, ctx.url.searchParams.get('knowledge_cursor'));}
  catch(error){
    if(!(error instanceof KnowledgeError||error instanceof RecordsError)||error.code!=='SPACE_INDEX_LIMIT')throw error;
    return card({title:'知识全文搜索'},html`${form}<p class="notice">${error.code}：${error.message}；${error.fix}</p><p>当前知识范围未检索，请调整限额后从第一页重试。</p>`);
  }
  return card({ title: '知识全文搜索', hint: '先按当前空间权限过滤，再进行分页；搜索结果只是线索，不进入任务判定' }, html `${form}${found.warnings?.map(warning=>html`<p class="notice">${warning.code}：${warning.message}；${warning.fix}</p>`)??''}${table(['范围', '种类', '陈述', '状态'], await Promise.all(found.matches.map(async (hit) => [hit.space === 'team' ? uiLabelOf('knowledge_space_kind', 'team') : hit.space === ctx.principal.id ? uiLabelOf('knowledge_space_kind', 'personal') : `${uiLabelOf('knowledge_search_scope', 'shared')}：${await ctx.userName(hit.space)}`, uiLabelOf('entry_kind', hit.kind), link('/console/knowledge/space', [...hit.statement].length > 240 ? [...hit.statement].slice(0, 240).join('') + '…' : hit.statement, { ...spaceLink(hit.space, hit.root, hit.path), entry: hit.entry }), uiLabelOf('knowledge_entry_status', hit.status)])), '没有可读的匹配条目')}${found.next ? link('/console/search', '更多知识', { q: text, scope: requested, knowledge_cursor: found.next }) : ''}`);
}
/** A successful owner/admin operation returns a local URL for post/redirect/get. */
export async function performSpaceAction(ctx: PageContext, action: string, values: URLSearchParams | Map<string, string>, upload?: {
  bytes: Buffer;
  name: string;
  mediaType: string;
}): Promise<string> {
  const spaces = ctx.deps.knowledge.spaces;
  if (!spaces)
    throw new KnowledgeError('对象不存在或无权读取', { code: 'SOURCE_UNAVAILABLE' });
  const get = (name: string) => values.get(name) ?? '', space = get('space') || ctx.principal.id, path = get('path') || '/';
  if (action === 'entry') {
    const grounds: Array<{
      reference: string;
      quotation: string;
    }> = [];
    const addGround = (reference: string, quotation: string) => { reference = reference.trim(); if (!!reference !== !!quotation)
      throw new KnowledgeError('依据引用和逐字引文须同时填写', { code: 'SPACE_ENTRY_INVALID' }); if (reference)
      grounds.push({ reference, quotation }); };
    for (let i = 0; i < 100; i++)
      addGround(get('ground_' + i), get('quotation_' + i));
    if (!values.has('ground_0'))
      addGround(get('ground'), get('quotation'));
    await spaces.write(ctx.principal, { path, kind: get('kind'), statement: get('statement'), data: get('data') ? JSON.parse(get('data')) : {}, applicability: get('applicability') ? JSON.parse(get('applicability')) : null, grounds, ...(get('expected_version') ? { expected_version: get('expected_version') } : {}), ...(get('replaces') ? { replaces: get('replaces') } : {}), reason: get('reason') || '个人条目写入' }, null, space);
  }
  else if (action === 'directory')
    await spaces.directory(ctx.principal, path, space);
  else if (isKnowledgeGrantAction(action)) {
    const audience = KnowledgeGranteeSchema.parse(get('audience'));
    const member = get('member_id') || (get('member') ? (await ctx.deps.records.principals.findByName(get('member')))?.id : null);
    await spaces.grant(ctx.principal, { path, audience, member: member ?? null, revoke: action === 'revoke' });
  }
  else if (action === 'withdraw')
    await spaces.withdraw(ctx.principal, get('entry'), space);
  else if (action === 'import') {
    if (!upload)
      throw new KnowledgeError('请选择原文文件', { code: 'SPACE_ENTRY_INVALID' });
    await spaces.importFile(ctx.principal, upload.bytes, upload.mediaType, upload.name, path);
  }
  else if (action === 'quota') {
    if (!ctx.admin)
      throw new KnowledgeError('对象不存在或无权读取', { code: 'SOURCE_UNAVAILABLE' });
    if (!/^[0-9]+$/.test(get('bytes')))
      throw new KnowledgeError('容量须为非负整数', { code: 'SPACE_ENTRY_INVALID' });
    await spaces.setCapacity(ctx.principal, get('space'), Number(get('bytes')));
    return '/console/team/' + encodeURIComponent(get('space'));
  }
  else
    throw new KnowledgeError('对象不存在或无权读取', { code: 'SOURCE_UNAVAILABLE' });
  return '/console/knowledge/space?' + new URLSearchParams({ space: isKnowledgeGrantAction(action) || action === 'import' ? ctx.principal.id : space, path });
}
export function spaceActionFailure(ctx: PageContext, error: unknown): PageResult {
  if (error instanceof KnowledgeError && error.code === 'SOURCE_UNAVAILABLE')
    return neutralPage(ctx);
  const message = error instanceof KnowledgeError ? error.message : error instanceof z.ZodError || error instanceof SyntaxError ? '条目或表单格式不正确' : null;
  if (message === null)
    throw error;
  return { status: 400, body: page(ctx.chrome('知识操作未完成', { active: 'knowledge' }), html `<p class="error">${message}</p><p>${link('/console/knowledge', '返回知识库')}</p>`) };
}

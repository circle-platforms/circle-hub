// Space pages and owner actions. Services enforce the same boundaries for browser forms and MCP calls.
import {grantDialog,checkTable,grantPreviewLocation} from './grant-dialog.ts';
import {spaceLayout,currentAudience,knowledgeTabs} from './space-layout.ts';
import {directoryName} from './audience.ts';
import {knowledgeDirectory,batchSharePage,shareBatch,existingTeamLink} from './knowledge-directory.ts';
export {batchSharePage};
import { z } from 'zod';
import { ENTRY_KIND, KNOWLEDGE_SEARCH_SCOPE, KNOWLEDGE_GRANTEE, KnowledgeGranteeSchema, isKnowledgeGrantAction, isKnowledgeSearchScope, uiLabelOf } from '../../../contracts/generated/vocabulary.ts';
import { Sha256 } from '../../../contracts/src/common.ts';
import { KnowledgeError, type SpaceEntryView } from '../../knowledge/api.ts';
import { RecordsError } from '../../records/api.ts';
import { code, html, link, page, pageLayout, pre, table, type Html } from './html.ts';
import { neutralPage, treePage, type PageContext, type PageResult } from './pages.ts';
import {button,sectionHead} from './ui.ts';
import {panel as card,badge as chip,facts as kv,technical,sourceBlock,stat,field as inputField,dialog,actionLink} from './presentation.ts';
import {knowledgeState,number,size,timestamp,versionName,versionLabel} from './knowledge-display.ts';
import {sharingRows} from './sharing-history.ts';
const field = inputField;
function form(ctx: PageContext, action: string, fields: Html, label: string, multipart = false, disabled=false): Html {
  return html `<form method="post" action="/console/knowledge/do/${action}"${multipart ? html ` enctype="multipart/form-data"` : ''}><input type="hidden" name="csrf" value="${ctx.csrf ?? ''}"><div data-fields>${fields}</div><button type="submit" class="ch-btn ${action==='revoke'||action==='withdraw'?'ch-btn--danger':'ch-btn--primary'}"${disabled?html` disabled`:html``}>${label}</button></form>`;
}
const spaceContent = (content: Html) => html `<div class="ch-section" data-area-content>${content}</div>`;
const spaceLink = (space: string, root?: string, path = '/') => ({ space, ...(root ? { root } : {}), path });
const bytes = size;
export async function spaceOverview(ctx: PageContext): Promise<Html> {
  const spaces = ctx.deps.knowledge.spaces;
  if (!spaces)
    return html ``;
  const visible = await spaces.visible(ctx.principal);
  const own = visible.find(s => s.space === ctx.principal.id)!;
  const team = visible.find(s => s.space === 'team')!;
  const shared = visible.filter(s => s.space !== 'team' && s.space !== ctx.principal.id);
  const sharedRows = await Promise.all(shared.map(async (s) => [await ctx.userName(s.space), html `${s.paths.map(path => html `<div>${link('/console/knowledge/space', path, spaceLink(s.space, undefined, path))}</div>`)}`]));
  return html `<div class="knowledge-spaces ch-section" data-columns="3">
${card({ title: uiLabelOf('knowledge_search_scope', 'personal'), hint: '默认仅本人可读；可按空间或目录授权。内容保存在 Hub 的服务器数据库中，并包含在服务器备份中。' }, html `${kv([['知识版本', technical(code(own.version.root),'查看')], ['已用容量（含历史）', bytes(own.version.body.used_bytes)], ['容量上限', bytes(await spaces.capacity(ctx.principal.id))]])}<div class="ch-actions">${button('/console/knowledge/space', '浏览目录', { params: spaceLink(own.space) })}${button('/console/knowledge/submissions', '我的提交共享')}${button('/console/knowledge/space', '添加条目', { params: { space: own.space, edit: '1' } })}${button('/console/knowledge/space', '导入个人知识', { params: { space: own.space, import: '1' }, hint: '上传本人文件到个人空间，原文仅本人及获授权者可读；条目由 Circle 起草，Hub 不生成内容' })}</div>`)}
${card({ title: uiLabelOf('knowledge_search_scope', 'team'), hint: '团队条目全体成员可读；产品目录沿用产品线读取权限。由管理员导入或产品知识来源同步写入。' }, html `${kv([['知识版本', technical(code(team.version.root),'查看')]])}<div class="ch-actions">${button('/console/knowledge/space', '浏览目录', { params: spaceLink('team') })}${ctx.admin ? button('/console/operations/knowledge', '导入团队知识', { hint: '从产品知识来源导入团队知识；也可在团队目录导入有团队读取原文的条目' }) : ''}</div>`)}
${card({ title: uiLabelOf('knowledge_search_scope', 'shared'), hint: '只列出当前授权给本账户或全体管理员的个人目录。收回授权后不能继续读取；已读或已引用的内容无法追回。' }, shared.length ? table(['来自', '可读目录'], sharedRows) : html `<p class="empty">没有获授权的个人目录</p>`)}
</div>`;
}
function editor(ctx: PageContext, space: string, path: string, draft?: SpaceEntryView): Html {
  const content = draft?.body.content, grounds = draft?.body.grounds ?? [];
  const title = draft ? (space === 'team' ? '修改团队条目' : '修改个人条目') : (space === 'team' ? '导入团队知识条目' : '添加个人条目');
  const hint = space === 'team' ? '仅管理员可导入；条目及依据原文对全体成员可读。可用团队读取的来源，或管理员本人的普通上传；本次导入记录上传声明。个人空间原文及个人凭据来源仍受原有共享限制。' : '没有依据的笔记记为未核验；提供依据时逐字核对引文与路径，核验不代表陈述内容已被判为事实。修改会创建新条目并取代旧条目。';
  return card({ title, hint }, form(ctx, 'entry', html `
<input type="hidden" name="space" value="${space}">
${draft ? html `<input type="hidden" name="replaces" value="${draft.row.entry}"><input type="hidden" name="expected_version" value="${draft.root}">` : ''}
${field('目录路径', html `<input name="path" value="${path}" required maxlength="2000">`)}
${field('种类', html `<select name="kind">${ENTRY_KIND.map(kind => html `<option value="${kind}"${kind === (content?.kind ?? 'observation') ? html ` selected` : ''}>${uiLabelOf('entry_kind', kind)}</option>`)}</select>`)}
${field('陈述', html `<textarea name="statement" required maxlength="262144" rows="4">${content?.statement ?? ''}</textarea>`)}
${field('结构化数据（可选 JSON）', html `<textarea name="data" rows="2" placeholder="{}">${content ? JSON.stringify(content.data, null, 2) : ''}</textarea>`)}
${field('适用条件（可选 JSON）', html `<textarea name="applicability" rows="2" placeholder="null">${content?.applicability ? JSON.stringify(content.applicability, null, 2) : ''}</textarea>`, '产品线、版本和运行环境等条件；留空表示未声明，不要求产品包')}
${Array.from({ length: Math.min(100, Math.max(3, grounds.length + 1)) }, (_, i) => html `<div data-wide-field data-fields>${field(`依据引用 ${i + 1}`, html `<input name="ground_${i}" value="${grounds[i]?.reference ?? ''}"${space === 'team' && i === 0 ? html ` required` : ''}>`)}${field(`逐字引文 ${i + 1}`, html `<textarea name="quotation_${i}" rows="2"${space === 'team' && i === 0 ? html ` required` : ''}>${grounds[i]?.quotation ?? ''}</textarea>`)}</div>`)}
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
  const showCitations=own||space==='team';
  const title = space === 'team' ? uiLabelOf('knowledge_space_kind', 'team') : own ? uiLabelOf('knowledge_space_kind', 'personal') : uiLabelOf('knowledge_search_scope', 'shared');
  const parts=path.split('/').filter(Boolean),parentParts=parts.slice(0,-1);
  const chrome = ctx.chrome(parts.at(-1)??'知识库', { active: 'knowledge', crumbs: html`${link('/console/knowledge','知识库')} › ${link('/console/knowledge/space',title,{space,path:'/'})}${parentParts.map((name,index)=>html` › ${link('/console/knowledge/space',name,{space,path:'/'+parentParts.slice(0,index+1).join('/')})}`)}` });
  const audience=await currentAudience(ctx,space,path,version.body.products.some(p=>path===p.path||path.startsWith(p.path+'/')));
  const audienceLine=html`<p>可见范围：${audience.text}${own&&audience.members.length?'（'+audience.members.join('、')+'）':''}${audience.inherited.map(parent=>html`<span title="目录授权包含全部下级目录"> · 继承自 ${directoryName(parent)} 的授权</span>`)}</p>`;
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
    const canWithdraw=canEdit||space==='team'&&entry.body.by===ctx.principal.id&&entry.body.shared_from!==undefined;
    const shared=entry.body.shared_from;
    const provenance=shared?kv([['提交人',await ctx.userName(entry.body.by)],['提交时间',timestamp(entry.body.at)],['来源',technical(code('tree:'+shared.root+shared.path+'@'+shared.entry),'查看')]]):html``;
    const withdrawNotice=entry.grounds_withdrawn.length||entry.grounds_withdrawn_hidden_count?html`<p class="notice">${uiLabelOf('validity_status','grounds_withdrawn')}${entry.grounds_withdrawn_hidden_count?`；另有 ${entry.grounds_withdrawn_hidden_count} 项依据不可读取`:''}</p>`:html``;
    let share=html``;
    if(own&&entry.row.status==='verified'){
      const target=ctx.url.searchParams.get('team_path')??path;
      const preview=ctx.url.searchParams.get('share')==='1'?await spaces.precheckShare(ctx.principal,{root:entry.root,path,entry:digest,team_path:target}):null;
      const destination=preview?preview.target_path??'':target;
      share=preview?card({title:'提交共享预检',hint:'个人原条目与授权保留；团队条目由提交人署名，本人和管理员可撤回，撤回不能追回已读内容。确认时重新执行全部检查。'},html`<p>个人：保留不变 · ${audience.text}</p><p>团队：新写入一条 · ${uiLabelOf('audience_scope','team')}</p><form method="get" action="/console/knowledge/space"><input type="hidden" name="space" value="${space}"><input type="hidden" name="root" value="${entry.root}"><input type="hidden" name="path" value="${path}"><input type="hidden" name="entry" value="${digest}"><input type="hidden" name="share" value="1"><label>团队目录<input name="team_path" value="${destination}"></label><button class="ch-btn ch-btn--secondary" type="submit">重新预检</button></form>${checkTable(preview.checks)}${preview.duplicate?existingTeamLink(preview.duplicate):''}${form(ctx,'share',html`<input type="hidden" name="root" value="${entry.root}"><input type="hidden" name="path" value="${path}"><input type="hidden" name="entry" value="${digest}"><input type="hidden" name="team_path" value="${destination}">`,'确认提交共享',false,!preview.ok)}`):html``;
    }
    const sources:Html[]=[];for(const ground of entry.body.grounds)sources.push(await sourceBlock(ctx,ground.reference,ground.quotation));
    const details=html`<div class="ch-section" data-area-content data-inspector-content><div class="ch-actions"><span class="ch-tag">${uiLabelOf('entry_kind',entry.body.content.kind)}</span>${knowledgeState(entry.row.status)}</div><h2 class="ch-panel-title">${entry.body.content.statement}</h2><p class="ch-meta">${directoryName(path)} · ${timestamp(entry.body.at)}</p>${withdrawNotice}
${card({title:'来源',meta:entry.body.grounds.length},sources.length?html`${sources}`:html`<p class="ch-meta">未提供来源</p>`)}
${card({title:'分享'},html`${audienceLine}${provenance}`)}
${showCitations?stat('被引用次数',entry.cited_count??'—'):''}
${technical(html`${kv([['引用',code(entry.reference)],['作者',await ctx.userName(entry.body.by)]])}${pre(JSON.stringify(entry.body.content.data,null,2))}${pre(JSON.stringify(entry.body.content.applicability??null,null,2))}`)}
${share}${canEdit&&ctx.url.searchParams.get('edit')==='1'?editor(ctx,space,path,entry):''}
<footer class="ch-inspector-actions">${own||space==='team'&&ctx.admin?actionLink('/console/knowledge/space?'+new URLSearchParams({...spaceLink(space,version.root,path),history:'1'})+'#knowledge-history','版本记录','ghost'):''}${canWithdraw?actionLink('#withdraw-entry','撤回…','danger'):''}${own&&entry.row.status==='verified'?actionLink('/console/knowledge/space?'+new URLSearchParams({...spaceLink(space,entry.root,path),entry:digest,share:'1'}),'分享到团队…'):''}${canEdit?actionLink('/console/knowledge/space?'+new URLSearchParams({...spaceLink(space,version.root,path),entry:digest,edit:'1'}),'编辑','primary'):''}</footer>
${canWithdraw?dialog('withdraw-entry','撤回条目',html`<p>撤回后不能再作为新结果的来源；已读内容无法追回。</p>`,form(ctx,'withdraw',html`<input type="hidden" name="entry" value="${digest}"><input type="hidden" name="space" value="${space}"><input type="hidden" name="path" value="${path}">`,'撤回条目')):''}</div>`;
    const nodes=await ctx.deps.knowledge.getNodes({root:version.root,paths:[path],depth:1,cursor:ctx.url.searchParams.get('node_cursor')},ctx.principal);
    if(!nodes)return neutralPage(ctx);
    const listing=await knowledgeDirectory(ctx,nodes,version,space,own,showCitations);
    return {status:200,body:page(chrome,await spaceLayout(ctx,pageLayout(html`${knowledgeTabs(ctx)}${listing}`,{inspector:details,detail:true,back:link('/console/knowledge/space','返回列表',{...spaceLink(space,version.root,path),scope:ctx.url.searchParams.get('scope'),node_cursor:ctx.url.searchParams.get('node_cursor')})})))};
  }
  const nodes = await ctx.deps.knowledge.getNodes({ root: version.root, paths: [path], depth: 1, cursor: ctx.url.searchParams.get('node_cursor') }, ctx.principal);
  if (!nodes)
    return neutralPage(ctx);
  const history = await spaces.history(ctx.principal, space, ctx.url.searchParams.get('history_cursor'));
  const names=new Map(history.items.map((item,index)=>[item.root,versionName(item.body.at,item.body.reason,history.next?undefined:history.items.length-index)]));
  const comparison = !own&&space!=='team'?html`<p class="ch-meta">个人空间的版本历史仅本人可见；目录授权不包含历史记录、时间和原因。</p>`:html`${table(['版本','记录人'],await Promise.all(history.items.map(async (item,index)=>[link('/console/knowledge/space',versionLabel(item.body.at,item.body.reason,history.next?undefined:history.items.length-index),spaceLink(space,item.root,path)),item.body.by===null?uiLabelOf('execution_host','hub'):await ctx.userName(item.body.by)])),'没有历史版本')}${history.next?link('/console/knowledge/space','更早的版本',{...spaceLink(space,undefined,path),history_cursor:history.next}):''}
<form class="ch-actions" data-filters method="get" action="/console/knowledge/space-diff"><input type="hidden" name="space" value="${space}"><label>从<select name="from">${history.items.map((item,index)=>html`<option value="${item.root}"${index===Math.min(1,history.items.length-1)?html` selected`:''}>${names.get(item.root)}</option>`)}</select></label><label>到<select name="to">${history.items.map(item=>html`<option value="${item.root}">${names.get(item.root)}</option>`)}</select></label><button class="ch-btn ch-btn--secondary" type="submit">比较知识版本</button></form>`;
  const collapsedHistory=html`<details class="ch-section" id="knowledge-history"${ctx.url.searchParams.get('history')==='1'?html` open`:''}><summary title="知识版本是空间的历史快照；产品版本是条目的适用条件，两者分别选择">知识版本历史</summary>${comparison}</details>`;
  let controls:Html=html``,editors:Html=html``;
  if(own||space==='team'&&ctx.admin){
    controls=html`<div class="ch-actions">${own?button('/console/knowledge/space','导入个人知识',{params:{space,path,import:'1'},hint:'上传本人原文到个人空间，条目单独写入'}):''}${own?html`<a class="ch-btn ch-btn--secondary" href="#grant-knowledge">分享…</a>`:''}${button('/console/knowledge/space','新建文件夹…',{params:{space,path,directory:'1'}})}${own?button('/console/knowledge/space','新建',{primary:true,params:{space,path,edit:'1'}}):button('/console/operations/knowledge','导入团队知识',{primary:true})}</div>`;
    editors=html`${ctx.url.searchParams.get('directory')==='1'?form(ctx,'directory',html`<input type="hidden" name="space" value="${space}">${field('新目录路径',html`<input name="path" required value="${path==='/'?'/notes':path+'/notes'}">`)}`,'建立目录'):''}${ctx.url.searchParams.get('edit')==='1'?editor(ctx,space,path):''}`;
  }
  const directory=await knowledgeDirectory(ctx,nodes,version,space,own,showCitations);
  let authorization:Html=html``;
  if(own){
    const grants=await spaces.grants(ctx.principal);
    authorization=await grantDialog(ctx,{id:'grant-knowledge',trigger:false,content:directoryName(path)+'（含全部下级目录）· 只读',current:audience.text,checks:await spaces.precheckGrant(ctx.principal,path),grants:grants.filter(grant=>grant.path===path),fields:html`<input type="hidden" name="path" value="${path}">`,form:(action,fields,label,disabled)=>form(ctx,action,fields,label,false,disabled)});
  }
  const sources = await spaces.sources(ctx.principal, space);
  const personalHistory=own?(await ctx.deps.knowledge.memory?.usage(ctx.principal))?.history??0:0;
  const originals = card({ title: '原文', hint: space === 'team' ? '经管理员导入、供团队条目引用的业务系统原文，全体成员可读' : '上传的原文保存在所属个人空间，不自动生成条目；可在 Circle 中按引用读取后起草，或手动添加带逐字引文的条目' }, html `${table(['文件名', '大小', '被引用', '原文'], await Promise.all(sources.filter(s=>s.path===path).map(async s => {const source=await spaces.source(ctx.principal,s.sha256);const origin=source?.artifact.body.origin;const name=source?.artifact.body.name??'原文';const refs=version.body.entries.filter(row=>row.path===s.path);let count=0;for(const row of refs){const entry=await spaces.entry(ctx.principal,version.root,row.path,row.entry);if(entry?.body.grounds.some(g=>g.reference==='src:'+s.sha256))count++;}return [name,bytes(s.size),'被 '+count+' 条条目引用',link('/console/knowledge/source','查看',{sha256:s.sha256})];})), '没有可读的原文')}${own&&ctx.url.searchParams.get('import')==='1' ? form(ctx, 'import', html `${field('原文文件', html `<input name="archive" type="file" required>`)}${field('所在目录', html `<input name="path" value="${path}" required>`)}`, '导入个人知识', true) : ''}`);
  const content=html`${knowledgeTabs(ctx)}<div class="ch-section">${audienceLine}${own?html`<p>个人空间已用 ${size(version.body.used_bytes+personalHistory)} / ${size(await spaces.capacity(space))} · 本目录条目 ${number(version.body.entries.filter(r=>r.path===path).length)} · 已核验 ${number(version.body.entries.filter(r=>r.path===path&&r.status==='verified').length)} · 授权 ${number((await spaces.grants(ctx.principal)).length)}</p>`:''}${directory}${editors}${originals}${authorization}${collapsedHistory}</div>`;
  const overview=html`<section class="ch-section"><h2 class="ch-panel-title">${parts.at(-1)??'知识库'}</h2><p class="ch-meta">${audience.text}</p></section><div class="ch-stats">${stat('本页知识',nodes.nodes.reduce((sum,node)=>sum+node.entries.length,0))}</div>${history.items.length?card({title:'最近变化'},html`<ul class="ch-feed">${history.items.slice(0,3).map(item=>html`<li>${link('/console/knowledge/space',item.body.reason||'更新知识',spaceLink(space,item.root,path))}${timestamp(item.body.at)}</li>`)}</ul>`):''}`;
  return {status:200,body:page(chrome,await spaceLayout(ctx,pageLayout(content,{inspector:overview,actions:controls})))};
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
  const rows = [...diff.added.map(path => [uiLabelOf('change_kind', 'added'), directoryName(path)]), ...diff.modified.map(path => [uiLabelOf('change_kind', 'modified'), directoryName(path)]), ...diff.removed.map(path => [uiLabelOf('change_kind', 'removed'), directoryName(path)])];
  return { status: 200, body: page(ctx.chrome('知识版本差异', { active: 'knowledge' }), spaceContent(html`${technical(html`从 ${code(from)} 到 ${code(to)}`)}${card({title:'条目与路径变化'},table(['变化','路径'],rows,'没有条目变化'))}`)) };
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
  return { status: 200, body: page(ctx.chrome('知识原文', { active: 'knowledge' }), spaceContent(card({ title: source.artifact.body.name || '原文', meta: bytes(source.size) }, html `${text === null ? html `<p>原文暂不可读</p>` : pre(text)}${source.size > 1024 * 1024 ? html `<p>仅显示前 1 MiB；完整原文可在 Circle 中按引用分页读取。</p>` : ''}`))) };
}
export async function spaceSearch(ctx: PageContext): Promise<Html> {
  const spaces = ctx.deps.knowledge.spaces;
  if (!spaces)
    return html ``;
  const text = ctx.url.searchParams.get('q') ?? '', requested = ctx.url.searchParams.get('scope') ?? 'all';
  if (!isKnowledgeSearchScope(requested))
    throw new KnowledgeError('搜索范围不正确', { code: 'SPACE_ENTRY_INVALID' });
  const form = html `<form class="ch-actions" data-filters method="get" action="/console/search"><label>关键词<input name="q" value="${text}" required maxlength="200"></label><label>知识范围<select name="scope">${KNOWLEDGE_SEARCH_SCOPE.map(scope => html `<option value="${scope}"${requested === scope ? html ` selected` : ''}>${uiLabelOf('knowledge_search_scope', scope)}</option>`)}</select></label><button class="ch-btn ch-btn--secondary" type="submit">搜索</button></form>`;
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
  if(action==='share-batch')return shareBatch(ctx,values);
  const get = (name: string) => values.get(name) ?? '', space = get('space') || ctx.principal.id, path = get('path') || '/';
  if(action==='grant'&&get('preview_grant')==='1')return grantPreviewLocation('/console/knowledge/space',{space:ctx.principal.id,path},'grant-knowledge',values);
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
  else if(action==='share'){await spaces.share(ctx.principal,{root:get('root'),path,entry:get('entry'),...(get('team_path')?{team_path:get('team_path')}:{})},null);return '/console/knowledge/submissions';}
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

export async function shareHistoryPage(ctx:PageContext):Promise<PageResult>{
 const spaces=ctx.deps.knowledge.spaces;if(!spaces)return neutralPage(ctx);const history=await spaces.shareHistory(ctx.principal,ctx.url.searchParams.get('cursor'));
 return {status:200,body:page(ctx.chrome('我的提交共享',{active:'knowledge',hint:'按提交时核验的结果列出；拒收后个人原条目保留，可修订后再次提交'}),card({title:'我的提交共享'},html`${table(['条目','提交时间','结果','团队目录或原因'],await sharingRows(ctx,history.items),'没有提交共享记录')}${history.next?link('/console/knowledge/submissions','更早的记录',{cursor:history.next}):''}`))};
}

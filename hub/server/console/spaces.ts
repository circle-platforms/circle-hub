import {randomUUID} from 'node:crypto';
import {personalLocal,personalSyncNotice,checkPersonalFormEpoch} from './personal-sync.ts';
import {personalOriginCleared,clearedPersonalFolder} from './personal-origin.ts';
import {capacitySummary,capacityError} from './capacity.ts';
import {parseCapacity} from '../capacity.ts';
// Space pages and owner actions. Services enforce the same boundaries for browser forms and MCP calls.
import {grantDialog,checkTable,grantPreviewLocation} from './grant-dialog.ts';
import {spaceLayout,currentAudience,knowledgeTabs} from './space-layout.ts';
import {directoryName} from './audience.ts';
import {knowledgeDirectory,batchSharePage,shareBatch,existingTeamLink} from './knowledge-directory.ts';
export {batchSharePage};
import { z } from 'zod';
import { SyncModeSchema, ENTRY_KIND, KNOWLEDGE_SEARCH_SCOPE, KNOWLEDGE_GRANTEE, KnowledgeGranteeSchema, isKnowledgeGrantAction, isKnowledgeSearchScope, uiLabelOf } from '../../../contracts/generated/vocabulary.ts';
import { Sha256 } from '../../../contracts/src/common.ts';
import { KnowledgeError, type SpaceEntryView } from '../../knowledge/api.ts';
import { RecordsError } from '../../records/api.ts';
import { PROTOCOL_CODES } from '../../../contracts/generated/protocol.ts';
import { code, html, link, page, pageLayout, pre, table, type Html } from './html.ts';
import { neutralPage, treePage, type PageContext, type PageResult } from './pages.ts';
import {button,sectionHead} from './ui.ts';
import {evidence,panel as card,badge as chip,facts as kv,technical,sourceBlock,stat,field as inputField,dialog,actionLink,tooltip} from './presentation.ts';
import {VERIFIED_SCOPE,knowledgeState,number,size,timestamp,versionName,versionLabel} from './knowledge-display.ts';
import {sharingRows} from './sharing-history.ts';
import {entryProvenance,entryClientName} from './client-provenance.ts';
import {shareFeedback,NO_TEAM_SHARES} from './feedback.ts';
const field = inputField;
function form(ctx: PageContext, action: string, fields: Html, label: string, multipart = false, disabled=false, back?:string): Html {
  const submit=html`<button type="submit" class="ch-btn ${action==='revoke'||action==='withdraw'?'ch-btn--danger':'ch-btn--primary'}"${disabled?html` disabled`:html``}>${label}</button>`;
  return html `<form method="post" action="/console/knowledge/do/${action}"${back?html` data-entry-editor`:''}${multipart ? html ` enctype="multipart/form-data"` : ''}><input type="hidden" name="csrf" value="${ctx.csrf ?? ''}">${ctx.personalEpoch?html`<input type="hidden" name="personal_epoch" value="${ctx.personalEpoch}">`:html``}<div data-fields>${fields}</div>${back?html`<div class="ch-editor-actions ch-actions">${submit}${actionLink(back,'取消并返回')}</div>`:submit}</form>`;
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
${card({ title: uiLabelOf('knowledge_search_scope', 'personal'), hint: '默认仅本人可读；可按空间或文件夹分享。内容保存在 Hub 的服务器数据库中，并包含在服务器备份中。' }, html `${kv([['知识版本', technical(code(own.version.root),'查看')], ['私人空间容量', capacitySummary(await spaces.usage(ctx.principal))]])}<div class="ch-actions">${button('/console/knowledge/space', '浏览文件夹', { params: spaceLink(own.space) })}${button('/console/knowledge/submissions', '分享到团队记录')}${button('/console/knowledge/space', '新建', { params: { space: own.space, edit: '1' } })}${button('/console/knowledge/space', '导入我的知识', { params: { space: own.space, import: '1' }, hint: '上传本人文件到私人空间，原文仅本人及获分享权限者可读；条目由客户端起草，Hub 不生成内容' })}</div>`)}
${card({ title: uiLabelOf('knowledge_search_scope', 'team'), hint: '团队条目全体成员可读；产品文件夹沿用产品线读取权限。由管理员导入或产品知识来源同步写入。' }, html `${kv([['知识版本', technical(code(team.version.root),'查看')]])}<div class="ch-actions">${button('/console/knowledge/space', '浏览文件夹', { params: spaceLink('team') })}${ctx.admin ? button('/console/operations/knowledge', '导入团队知识', { hint: '从产品知识来源导入团队知识；也可在团队文件夹导入有团队读取原文的条目' }) : ''}</div>`)}
${card({ title: uiLabelOf('knowledge_search_scope', 'shared'), hint: '只列出当前分享给本账户或全体管理员的私人文件夹。收回分享后不能继续读取；已读或已引用的内容无法追回。' }, shared.length ? table(['来自', '可读文件夹'], sharedRows) : html `<p class="empty">没有获分享权限的私人文件夹</p>`)}
</div>`;
}
function editor(ctx: PageContext, space: string, path: string, draft?: SpaceEntryView): Html {
  const content = draft?.body.content, grounds = draft?.body.grounds ?? [];
  const title = draft ? (space === 'team' ? '修改团队条目' : '修改我的条目') : (space === 'team' ? '导入团队知识条目' : '新建条目');
  const hint = space === 'team' ? '仅管理员可导入；条目及来源原文对全体成员可读。可用团队读取的来源，或管理员本人的普通上传；本次导入记录上传声明。私人空间原文及私人凭据来源仍受原有共享限制。' : '没有来源的笔记记为待验证；提供来源时逐字核对引文与路径，验证不代表陈述内容已被判为事实。修改会创建新条目并取代旧条目。';
  const back='/console/knowledge/space?'+new URLSearchParams({...spaceLink(space,draft?.root,path),...(draft?{entry:draft.row.entry}:{}),scope:ctx.url.searchParams.get('scope')??(space==='team'?'team':'personal')});
  const ground=(i:number)=>html`<div data-wide-field data-fields>${field(`来源引用 ${i+1}`,html`<input name="ground_${i}" value="${grounds[i]?.reference??''}"${space==='team'&&i===0?html` required`:''}>`)}${field(`逐字引文 ${i+1}`,html`<textarea name="quotation_${i}" rows="2"${space==='team'&&i===0?html` required`:''}>${grounds[i]?.quotation??''}</textarea>`)}</div>`;
  return html`<section class="ch-section" data-editor-foreground>${card({ title, hint }, form(ctx, 'entry', html `
<input type="hidden" name="space" value="${space}">
${draft ? html `<input type="hidden" name="replaces" value="${draft.row.entry}"><input type="hidden" name="expected_version" value="${draft.root}">` : ''}
${field('陈述', html `<textarea name="statement" required maxlength="262144" rows="4">${content?.statement ?? ''}</textarea>`)}
${field('类型', html `<select name="kind">${ENTRY_KIND.map(kind => html `<option value="${kind}"${kind === (content?.kind ?? 'observation') ? html ` selected` : ''}>${uiLabelOf('entry_kind', kind)}</option>`)}</select>`)}
${field('文件夹路径', html `<input name="path" value="${path}" required maxlength="2000">`)}
<details data-editor-advanced data-wide-field${content&&(Object.keys(content.data).length||content.applicability)?html` open`:''}><summary>结构化数据与适用条件</summary><div data-fields>${field('结构化数据（可选 JSON）', html `<textarea name="data" rows="2" placeholder="{}">${content ? JSON.stringify(content.data, null, 2) : ''}</textarea>`, '留空表示没有；填写须是 JSON 对象，例如 {"字段":"值"}')}
${field('适用条件（可选 JSON）', html `<textarea name="applicability" rows="2" placeholder="留空表示未声明">${content?.applicability ? JSON.stringify(content.applicability, null, 2) : ''}</textarea>`, '产品线、版本和运行环境等条件，须是 JSON 对象；留空表示未声明，不要求产品包')}
</div></details>
${ground(0)}
<details data-editor-sources data-wide-field${grounds.length>1?html` open`:''}><summary>更多来源与逐字引文</summary><div data-fields>${Array.from({length:Math.min(100,Math.max(3,grounds.length+1))-1},(_,i)=>ground(i+1))}</div></details>
${field('修改原因', html `<input name="reason" maxlength="1000" value="${draft ? '修订知识条目' : space === 'team' ? '团队知识导入' : '我的条目写入'}" required>`)}
`, draft ? '保存修改' : space === 'team' ? '导入条目' : '保存条目',false,false,back))}</section>`;
}
export async function spacePage(ctx: PageContext): Promise<PageResult> {
  ctx.personalEpoch=(await ctx.deps.records.personalSync?.state(ctx.principal))?.epoch;
  const spaces = ctx.deps.knowledge.spaces;
  if (!spaces)
    return neutralPage(ctx);
  const space = ctx.url.searchParams.get('space') ?? ctx.principal.id;
  if(space===ctx.principal.id&&!ctx.url.searchParams.has('root')&&await personalLocal(ctx))return {status:200,body:page(ctx.chrome('知识库',{active:'knowledge'}),await spaceLayout(ctx,await personalSyncNotice(ctx)))};
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
  const showCitations=own||space==='team';
  const title = space === 'team' ? uiLabelOf('knowledge_space_kind', 'team') : own ? uiLabelOf('knowledge_space_kind', 'personal') : uiLabelOf('knowledge_search_scope', 'shared');
  const parts=path.split('/').filter(Boolean),parentParts=parts.slice(0,-1);
  const chrome = ctx.chrome(parts.at(-1)??'知识库', { active: 'knowledge', crumbs: html`${link('/console/knowledge','知识库')} › ${link('/console/knowledge/space',title,{space,path:'/'})}${parentParts.map((name,index)=>html` › ${link('/console/knowledge/space',name,{space,path:'/'+parentParts.slice(0,index+1).join('/')})}`)}` });
  const audience=await currentAudience(ctx,space,path,version.body.products.some(p=>path===p.path||path.startsWith(p.path+'/')));
  const audienceLine=html`<p>分享范围：${audience.text}${own&&audience.members.length?'（'+audience.members.join('、')+'）':''}${audience.inherited.map(parent=>html`<span title="文件夹分享包含全部子文件夹"> · 同文件夹设置 · ${directoryName(parent)}</span>`)}</p>`;
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
    if(canEdit&&ctx.url.searchParams.get('edit')==='1')return {status:200,body:page({...chrome,title:'编辑知识条目'},await spaceLayout(ctx,pageLayout(editor(ctx,space,path,entry),{inspector:null})))};
    const canWithdraw=canEdit||space==='team'&&entry.body.by===ctx.principal.id&&entry.body.shared_from!==undefined;
    const shared=entry.body.shared_from;
    const provenance=shared?kv([['提交人',await ctx.userName(entry.body.by)],['提交时间',timestamp(entry.body.at)],['来源',await personalOriginCleared(ctx,shared.root)?clearedPersonalFolder():technical(code('tree:'+shared.root+shared.path+'@'+shared.entry),'查看')]]):html``;
    const withdrawNotice=entry.grounds_withdrawn.length||entry.grounds_withdrawn_hidden_count?html`<p class="notice">${uiLabelOf('validity_status','grounds_withdrawn')}${entry.grounds_withdrawn_hidden_count?`；另有 ${entry.grounds_withdrawn_hidden_count} 项来源不可读取`:''}</p>`:html``;
    let share=html``;
    if(own&&entry.row.status==='verified'){
      const target=ctx.url.searchParams.get('team_path')??path;
      const preview=ctx.url.searchParams.get('share')==='1'?await spaces.precheckShare(ctx.principal,{root:entry.root,path,entry:digest,team_path:target}):null;
      const destination=preview?preview.target_path??'':target;
      share=preview?card({title:'分享到团队预检',hint:'我的原条目与分享保留；团队条目由提交人署名，本人和管理员可撤回，撤回不能追回已读内容。确认时重新执行全部检查。'},html`<p>我的：保留不变 · ${audience.text}</p><p>团队：新写入一条 · ${uiLabelOf('audience_scope','team')}</p><form method="get" action="/console/knowledge/space"><input type="hidden" name="space" value="${space}"><input type="hidden" name="root" value="${entry.root}"><input type="hidden" name="path" value="${path}"><input type="hidden" name="entry" value="${digest}"><input type="hidden" name="share" value="1"><label>团队文件夹<input name="team_path" value="${destination}"></label><button class="ch-btn ch-btn--secondary" type="submit">重新预检</button></form>${checkTable(preview.checks)}${preview.duplicate?existingTeamLink(preview.duplicate):''}${form(ctx,'share',html`<input type="hidden" name="root" value="${entry.root}"><input type="hidden" name="path" value="${path}"><input type="hidden" name="entry" value="${digest}"><input type="hidden" name="team_path" value="${destination}">`,'确认分享到团队',false,!preview.ok)}`):html``;
    }
    const attributions=await spaces.entryAttributions(ctx.principal,entry.root,path,digest);
    const sources:Html[]=[];for(const [groundIndex,ground] of entry.body.grounds.entries()){const pinned=attributions.find(row=>ground.reference==='src:'+row.sha256);sources.push(await sourceBlock(ctx,ground.reference,ground.quotation,pinned?.artifact,{root:entry.root,path,entry:digest,ground:groundIndex}));}
    // Provenance the Hub already recorded, for the author and administrators only.
    const origin=entry.body.by===ctx.principal.id||ctx.admin?await entryProvenance(ctx,entry.body):null;
    // Like the space's own version records, a shared reader does not see the history of the owner's entries.
    const versionLines=own||space==='team'?await entryVersionLines(ctx,spaces,entry):[];
    const replacement=entry.row.status==='superseded'?await replacementOf(ctx,spaces,version,digest):null;
    const supersededNotice=entry.row.status==='superseded'?html`<p class="notice">${uiLabelOf('knowledge_entry_status','superseded')} · ${replacement?link('/console/knowledge/space','查看取代它的条目',{...spaceLink(space,version.root,replacement.path),entry:replacement.entry,scope:ctx.url.searchParams.get('scope')}):'取代它的条目暂不可读'}</p>`:html``;
    const versionCard=versionLines.length?card({title:'版本记录',meta:versionLines.length},html`<ul class="ch-feed" data-entry-versions>${versionLines.map(line=>html`<li>${line}</li>`)}</ul>`):'';
    const provenanceCard=origin?card({title:'写入来源'},html`${kv(origin.rows.map(([k,v])=>[k,k==='写入时间'?timestamp(String(v)):v]))}${technical(kv(origin.technical))}`):'';
    const signatures=attributions.length?card({title:'来源署名',meta:attributions.length},html`<ul class="ch-feed">${await Promise.all(attributions.map(async row=>html`<li><span>${uiLabelOf('provenance_type','declared')} · 署名人 ${evidence(await ctx.userName(row.by))}${(await ctx.deps.records.principals.get(row.by))?.disabled&&!(await ctx.deps.records.principals.get(row.by))?.deleted_at?html` · ${chip(uiLabelOf('account_status','disabled'),'plain')}`:''}</span>${timestamp(row.at)}</li>`))}</ul>`):'';
    const details=html`<div class="ch-section" data-area-content data-inspector-content><div class="ch-actions"><span class="ch-tag">${uiLabelOf('entry_kind',entry.body.content.kind)}</span>${knowledgeState(entry.row.status)}</div><h2 class="ch-panel-title">${evidence(entry.body.content.statement)}</h2><p class="ch-meta">${directoryName(path)} · ${timestamp(entry.body.at)}</p>${entry.row.status==='verified'?html`<p class="ch-meta" data-verified-scope>${VERIFIED_SCOPE}</p>`:''}${supersededNotice}${withdrawNotice}
${card({title:'来源',meta:entry.body.grounds.length},sources.length?html`${sources}`:html`<p class="ch-meta">未提供来源</p>`)}
${signatures}${card({title:'分享'},html`${audienceLine}${provenance}`)}
${versionCard}${provenanceCard}
${showCitations?stat('被引用次数',entry.cited_count??'—'):''}
${technical(html`${kv([['引用',code(entry.reference)],['作者',await ctx.userName(entry.body.by)]])}${pre(JSON.stringify(entry.body.content.data,null,2))}${pre(JSON.stringify(entry.body.content.applicability??null,null,2))}`)}
${share}${canEdit&&ctx.url.searchParams.get('edit')==='1'?editor(ctx,space,path,entry):''}
<footer class="ch-inspector-actions">${own||space==='team'&&ctx.admin?actionLink('/console/knowledge/space?'+new URLSearchParams({...spaceLink(space,version.root,path),history:'1'})+'#knowledge-history','知识版本记录','ghost'):''}${canWithdraw?actionLink('#withdraw-entry','撤回…','danger'):''}${own&&entry.row.status==='verified'?actionLink('/console/knowledge/space?'+new URLSearchParams({...spaceLink(space,entry.root,path),entry:digest,share:'1'}),'分享到团队…'):''}${canEdit?actionLink('/console/knowledge/space?'+new URLSearchParams({...spaceLink(space,version.root,path),entry:digest,edit:'1'}),'编辑','primary'):''}</footer>
${canWithdraw?dialog('withdraw-entry','撤回条目',html`<p>撤回后不能再作为新结果的来源；已读内容无法追回。</p>`,form(ctx,'withdraw',html`<input type="hidden" name="entry" value="${digest}"><input type="hidden" name="space" value="${space}"><input type="hidden" name="path" value="${path}">`,'撤回条目')):''}</div>`;
    const nodes=await ctx.deps.knowledge.getNodes({root:version.root,paths:[path],depth:1,cursor:ctx.url.searchParams.get('node_cursor')},ctx.principal);
    if(!nodes)return neutralPage(ctx);
    const listing=await knowledgeDirectory(ctx,nodes,version,space,own,showCitations);
    return {status:200,body:page(chrome,await spaceLayout(ctx,pageLayout(html`${knowledgeTabs(ctx)}${listing}`,{inspector:details,detail:true,back:link('/console/knowledge/space','返回列表',{...spaceLink(space,version.root,path),scope:ctx.url.searchParams.get('scope'),node_cursor:ctx.url.searchParams.get('node_cursor')})})))};
  }
  if((own||space==='team'&&ctx.admin)&&ctx.url.searchParams.get('edit')==='1')return {status:200,body:page({...chrome,title:'新建知识条目'},await spaceLayout(ctx,pageLayout(editor(ctx,space,path),{inspector:null})))};
  const nodes = await ctx.deps.knowledge.getNodes({ root: version.root, paths: [path], depth: 1, cursor: ctx.url.searchParams.get('node_cursor') }, ctx.principal);
  if (!nodes)
    return neutralPage(ctx);
  const history = await spaces.history(ctx.principal, space, ctx.url.searchParams.get('history_cursor'));
  const names=new Map(history.items.map((item,index)=>[item.root,versionName(item.body.at,item.body.reason,history.next?undefined:history.items.length-index)]));
  const comparison = !own&&space!=='team'?html`<p class="ch-meta">版本记录仅本人可见</p>`:html`${table(['版本','记录人'],await Promise.all(history.items.map(async (item,index)=>[link('/console/knowledge/space',versionLabel(item.body.at,item.body.reason,history.next?undefined:history.items.length-index),spaceLink(space,item.root,path)),item.body.by===null?uiLabelOf('execution_host','hub'):await ctx.userName(item.body.by)])),'没有更早的版本')}${history.next?link('/console/knowledge/space','更早的版本',{...spaceLink(space,undefined,path),history_cursor:history.next}):''}
<form class="ch-actions" data-filters method="get" action="/console/knowledge/space-diff"><input type="hidden" name="space" value="${space}"><label>从<select name="from">${history.items.map((item,index)=>html`<option value="${item.root}"${index===Math.min(1,history.items.length-1)?html` selected`:''}>${names.get(item.root)}</option>`)}</select></label><label>到<select name="to">${history.items.map(item=>html`<option value="${item.root}">${names.get(item.root)}</option>`)}</select></label><button class="ch-btn ch-btn--secondary" type="submit">比较知识版本</button></form>`;
  const collapsedHistory=html`<details class="ch-section" id="knowledge-history"${ctx.url.searchParams.get('history')==='1'?html` open`:''}><summary title="知识版本是空间的版本快照；产品版本是条目的适用条件，两者分别选择">知识版本记录</summary>${comparison}</details>`;
  let controls:Html=html``,editors:Html=html``;
  if(own||space==='team'&&ctx.admin){
    controls=html`<div class="ch-actions">${own?button('/console/knowledge/space','导入我的知识',{params:{space,path,import:'1'},hint:'上传本人原文到私人空间，条目单独写入'}):''}${own?html`<a class="ch-btn ch-btn--secondary" href="#grant-knowledge">分享…</a>`:''}${button('/console/knowledge/space','新建文件夹…',{params:{space,path,directory:'1'}})}${own?button('/console/knowledge/space','新建',{primary:true,params:{space,path,edit:'1'}}):button('/console/operations/knowledge','导入团队知识',{primary:true})}</div>`;
    editors=html`${ctx.url.searchParams.get('directory')==='1'?form(ctx,'directory',html`<input type="hidden" name="space" value="${space}">${field('新文件夹路径',html`<input name="path" required value="${path==='/'?'/notes':path+'/notes'}">`)}`,'建立文件夹'):''}${ctx.url.searchParams.get('edit')==='1'?editor(ctx,space,path):''}`;
  }
  const directory=await knowledgeDirectory(ctx,nodes,version,space,own,showCitations);
  let authorization:Html=html``;
  if(own){
    const grants=await spaces.grants(ctx.principal);
    authorization=await grantDialog(ctx,{id:'grant-knowledge',trigger:false,content:directoryName(path)+'（含全部子文件夹）· 只读',current:audience.text,checks:await spaces.precheckGrant(ctx.principal,path),grants:grants.filter(grant=>grant.path===path),fields:html`<input type="hidden" name="path" value="${path}">`,form:(action,fields,label,disabled)=>form(ctx,action,fields,label,false,disabled)});
  }
  const sources = await spaces.sources(ctx.principal, space);
  const capacity=own?await spaces.usage(ctx.principal):null;
  const folderEntries=await spaces.entries(ctx.principal,version.root,version.body.entries.filter(row=>row.path===path));
  const originals = card({ title: '原文', hint: space === 'team' ? '供团队知识引用的原文，全体成员可读；上传原文须由上传人署名' : '上传的原文保存在所属私人空间，不自动生成条目；可在客户端中按引用读取后起草，或手动添加带逐字引文的条目' }, html `${table(['文件名', '大小', '被引用', '原文'], await Promise.all(sources.filter(s=>s.path===path).map(async s => {const source=await spaces.source(ctx.principal,s.sha256,undefined,'model',s.artifact);const origin=source?.artifact.body.origin;const name=source?.artifact.body.name??'原文';const count=folderEntries.filter(entry=>entry?.body.grounds.some(g=>g.reference==='src:'+s.sha256)).length;return [name,bytes(s.size),'被 '+count+' 条条目引用',link('/console/knowledge/source','查看',{sha256:s.sha256,artifact:s.artifact})];})), {title:'这个文件夹还没有原文',text:'导入的文件保存在这里，供条目逐字引用。'})}${own&&ctx.url.searchParams.get('import')==='1' ? form(ctx, 'import', html `${field('原文文件', html `<input name="archive" type="file" required>`)}${field('所在文件夹', html `<input name="path" value="${path}" required>`)}`, '导入我的知识', true) : ''}`);
  const context=html`<p class="ch-meta" data-knowledge-context>范围：${title} · 内容：${uiLabelOf('knowledge_view','knowledge')} · 位置：${directoryName(path)}</p>`;
  const listed=nodes.nodes.reduce((sum,node)=>sum+node.entries.length,0);
  const readable=html`<p class="ch-meta" data-folder-count>${tooltip(`本页当前可读条目 ${number(listed)}`,'只统计本页已加载的当前可读条目；条目记录包含所选版本保留的早期版本及撤回记录，不含子文件夹。')}</p>`;
  const content=html`${knowledgeTabs(ctx)}<div class="ch-section">${context}${audienceLine}${readable}${own?html`<p>私人空间 ${capacitySummary(capacity!)} · 本文件夹条目记录（含早期版本及撤回）${number(version.body.entries.filter(r=>r.path===path).length)} · 已验证 ${number(version.body.entries.filter(r=>r.path===path&&r.status==='verified').length)} · 已分享 ${number((await spaces.grants(ctx.principal)).length)}</p>`:''}${directory}${editors}${originals}${authorization}${collapsedHistory}</div>`;
  // Decision 151: no side pane repeats the folder. Its one own fact, how many entries the page lists, stands with the other
  // counts; the recent changes are the version record below.
  return {status:200,body:page(chrome,await spaceLayout(ctx,pageLayout(content,{inspector:null,actions:controls})))};
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
export {originalPage as spaceSourcePage} from './source-archive.ts';
export async function spaceSearch(ctx: PageContext): Promise<Html> {
  const spaces = ctx.deps.knowledge.spaces;
  if (!spaces)
    return html ``;
  const text = ctx.url.searchParams.get('q') ?? '', requested = ctx.url.searchParams.get('scope') ?? 'all';
  if (!isKnowledgeSearchScope(requested))
    throw new KnowledgeError('搜索范围不正确', { code: 'SPACE_ENTRY_INVALID' });
  const form = html `<form class="ch-actions" data-filters method="get" action="/console/search"><label>关键词<input name="q" value="${text}" required maxlength="200"></label><label>知识范围<select name="scope">${KNOWLEDGE_SEARCH_SCOPE.map(scope => html `<option value="${scope}"${requested === scope ? html ` selected` : ''}>${uiLabelOf('knowledge_search_scope', scope)}</option>`)}</select></label><button class="ch-btn ch-btn--secondary" type="submit">搜索</button></form>`;
  if (!text.trim())
    return card({ title: '知识全文搜索', hint: '搜索陈述、结构化数据与已记录的引文；范围按当前分享权限过滤，结果只作为线索' }, form);
  let found:Awaited<ReturnType<typeof spaces.search>>;
  try{found=await spaces.search(ctx.principal, text, requested, ctx.url.searchParams.get('knowledge_cursor'));}
  catch(error){
    if(!(error instanceof KnowledgeError||error instanceof RecordsError)||error.code!=='SPACE_INDEX_LIMIT')throw error;
    return card({title:'知识全文搜索'},html`${form}<p class="notice">${error.code}：${error.message}；${error.fix}</p><p>当前知识范围未检索，请调整限额后从第一页重试。</p>`);
  }
  return card({ title: '知识全文搜索', hint: '先按当前空间权限过滤，再进行分页；搜索结果只是线索，不进入任务判定' }, html `${form}${found.warnings?.map(warning=>html`<p class="notice">${warning.code}：${warning.message}；${warning.fix}</p>`)??''}${table(['范围', '类型', '陈述', '状态'], await Promise.all(found.matches.map(async (hit) => [hit.space === 'team' ? uiLabelOf('knowledge_space_kind', 'team') : hit.space === ctx.principal.id ? uiLabelOf('knowledge_space_kind', 'personal') : `${uiLabelOf('knowledge_search_scope', 'shared')}：${await ctx.userName(hit.space)}`, uiLabelOf('entry_kind', hit.kind), link('/console/knowledge/space', [...hit.statement].length > 240 ? [...hit.statement].slice(0, 240).join('') + '…' : hit.statement, { ...spaceLink(hit.space, hit.root, hit.path), entry: hit.entry }), uiLabelOf('knowledge_entry_status', hit.status)])), '没有可读的匹配条目')}${found.next ? link('/console/search', '更多知识', { q: text, scope: requested, knowledge_cursor: found.next }) : ''}`);
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
  if(action==='sync-confirm-purge'){
    const api=ctx.deps.records.personalSync;if(!api)throw new KnowledgeError('对象不存在或无权读取',{code:'SOURCE_UNAVAILABLE'});
    if(values.get('confirm_purge')!=='true')throw new KnowledgeError(PROTOCOL_CODES.SYNC_PURGE_CONFIRMATION_REQUIRED.when,{code:'SYNC_PURGE_CONFIRMATION_REQUIRED'});
    await checkPersonalFormEpoch(ctx,values.get('epoch'));
    try{await api.confirmPurge(ctx.principal,values.get('record')??'');}
    catch(error){if(error instanceof RecordsError&&error.code)throw new KnowledgeError(error.message,{code:error.code});throw error;}
    return '/console/knowledge?scope=personal&sync=settings';
  }
  if(action==='sync-resume'||action==='sync-mode'){
    const api=ctx.deps.knowledge.personalSync;if(!api)throw new KnowledgeError('对象不存在或无权读取',{code:'SOURCE_UNAVAILABLE'});
    try{await api.changeMode(ctx.principal,{epoch:values.get('epoch')??'',expected_state:values.get('expected_state')??'',mode:action==='sync-resume'?SyncModeSchema.enum.hub:values.get('mode'),operation_id:values.get('operation_id')||randomUUID(),check:values.get('check')||null,confirm_purge:values.get('confirm_purge')==='true'});}
    catch(error){if(error instanceof RecordsError&&error.code)throw new KnowledgeError(error.message,{code:error.code});throw error;}
    return '/console/knowledge?scope=personal&sync=settings';
  }
  if((values.get('space')||ctx.principal.id)!=='team')await checkPersonalFormEpoch(ctx,values.get('personal_epoch'));
  if(action==='share-batch')return shareBatch(ctx,values);
  const get = (name: string) => values.get(name) ?? '', space = get('space') || ctx.principal.id, path = get('path') || '/';
  if(action==='grant'&&get('preview_grant')==='1')return grantPreviewLocation('/console/knowledge/space',{space:ctx.principal.id,path},'grant-knowledge',values);
  if (action === 'entry') {
    const grounds: Array<{
      reference: string;
      quotation: string;
    }> = [];
    const addGround = (reference: string, quotation: string) => { reference = reference.trim(); if (!!reference !== !!quotation)
      throw new KnowledgeError('来源引用和逐字引文须同时填写', { code: 'SPACE_ENTRY_INVALID' }); if (reference)
      grounds.push({ reference, quotation }); };
    for (let i = 0; i < 100; i++)
      addGround(get('ground_' + i), get('quotation_' + i));
    if (!values.has('ground_0'))
      addGround(get('ground'), get('quotation'));
    await spaces.write(ctx.principal, { path, kind: get('kind'), statement: get('statement'), data: get('data') ? JSON.parse(get('data')) : {}, applicability: get('applicability') ? JSON.parse(get('applicability')) : null, grounds, ...(get('expected_version') ? { expected_version: get('expected_version') } : {}), ...(get('replaces') ? { replaces: get('replaces') } : {}), reason: get('reason') || '我的条目写入' }, null, space);
  }
  else if(action==='import-source'){if(!upload)throw new TypeError('original required');const artifact=await spaces.importFile(ctx.principal,upload.bytes,upload.mediaType,upload.name,get('path')||'/');const originals=await spaces.archive(ctx.principal,{scope:'personal',path:get('path')||'/'});const selected=originals.items.find(row=>row.body.artifact===artifact.digest);return '/console/knowledge?'+new URLSearchParams({view:'sources',scope:'personal',space:ctx.principal.id,path:get('path')||'/',...(selected?{source:selected.record}:{})});}
  else if(action==='save-source'){const saved=await spaces.archiveSource(ctx.principal,{artifact:get('artifact'),space:get('space'),path:get('path')||'/',message:get('message')});return '/console/knowledge?'+new URLSearchParams({view:'sources',scope:saved.space==='team'?'team':'personal',space:saved.space,path:saved.path,source:saved.record});}
  else if(action==='attribute-source'){const result=await spaces.attributeSource(ctx.principal,get('source'),get('artifact'));return '/console/knowledge/source?'+new URLSearchParams({sha256:result.sha256,artifact:result.artifact});}
  else if(action==='share'){ctx.feedback=shareFeedback([await spaces.share(ctx.principal,{root:get('root'),path,entry:get('entry'),...(get('team_path')?{team_path:get('team_path')}:{})},null)]);return '/console/knowledge/submissions';}
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
    let bytes:number;try{bytes=parseCapacity(get('amount'),get('unit'));}catch(error){throw new KnowledgeError(error instanceof Error?error.message:'容量格式不正确',{code:'SPACE_ENTRY_INVALID'});}
    await spaces.setCapacity(ctx.principal, get('space'), bytes);
    return get('space')==='team'?'/console/team':'/console/team/' + encodeURIComponent(get('space'));
  }
  else
    throw new KnowledgeError('对象不存在或无权读取', { code: 'SOURCE_UNAVAILABLE' });
  return '/console/knowledge/space?' + new URLSearchParams({ space: isKnowledgeGrantAction(action) || action === 'import' ? ctx.principal.id : space, path });
}
/** What changed from one entry version to the next, in the design system's words. */
function changeText(body:SpaceEntryView['body'],previous:SpaceEntryView['body']|null):string{
  if(!previous)return body.shared_from?'分享到团队':'新建了条目';
  const changed=[...(body.content.statement!==previous.content.statement||body.content.kind!==previous.content.kind?['内容']:[]),...(JSON.stringify(body.grounds)!==JSON.stringify(previous.grounds)?['来源']:[]),...(JSON.stringify(body.content.data)!==JSON.stringify(previous.content.data)||JSON.stringify(body.content.applicability)!==JSON.stringify(previous.content.applicability)?['适用条件']:[])];
  return changed.length?'更新了'+changed.join('和'):'重新保存了条目';
}
const VERSION_LINES=20;
/**
 * One line per version of an entry, newest first, following `replaces` back through the same snapshot: who, which client
 * (as recorded, shown to the writer and administrators like the provenance card), when, and what changed.
 */
async function entryVersionLines(ctx:PageContext,spaces:NonNullable<PageContext['deps']['knowledge']['spaces']>,entry:SpaceEntryView):Promise<Html[]>{
  const chain:SpaceEntryView['body'][]=[entry.body];
  const rows=(await spaces.version(entry.root))?.body.entries??[];
  for(let replaced=entry.body.replaces;replaced&&chain.length<VERSION_LINES;){
    const row=rows.find(candidate=>candidate.entry===replaced);if(!row)break;
    const older=await spaces.entry(ctx.principal,entry.root,row.path,row.entry);if(!older)break;
    chain.push(older.body);replaced=older.body.replaces;
  }
  return Promise.all(chain.map(async(body,index)=>{
    const client=body.by===ctx.principal.id||ctx.admin?html` · ${evidence(await entryClientName(ctx,body))}`:html``;
    return html`<span>${evidence(await ctx.userName(body.by))}${client} · ${timestamp(body.at)} ${changeText(body,chain[index+1]??null)}</span>`;
  }));
}
const REPLACEMENT_SCAN=1000;
/** The entry that replaced `digest`: the one whose `replaces` names it, looked for in its folder first. */
async function replacementOf(ctx:PageContext,spaces:NonNullable<PageContext['deps']['knowledge']['spaces']>,version:{root:string;body:{entries:readonly {path:string;entry:string}[]}},digest:string):Promise<{path:string;entry:string}|null>{
  const others=version.body.entries.filter(row=>row.entry!==digest);
  const own=others.filter(row=>(version.body.entries.find(r=>r.entry===digest)?.path??'')===row.path);
  for(const rows of [own,others.filter(row=>!own.includes(row)).slice(0,REPLACEMENT_SCAN)]){
    const views=await spaces.entries(ctx.principal,version.root,rows.map(row=>({path:row.path,entry:row.entry})));
    const found=views.find(view=>view?.body.replaces===digest);
    if(found)return {path:found.row.path,entry:found.row.entry};
  }
  return null;
}
export function spaceActionFailure(ctx: PageContext, error: unknown): PageResult {
  if (error instanceof KnowledgeError && error.code === 'SOURCE_UNAVAILABLE')
    return neutralPage(ctx);
  const message = error instanceof KnowledgeError || error instanceof RecordsError&&(error.code==='SYNC_MODE_LOCAL'||error.code==='SYNC_EPOCH_CHANGED'||error.code==='SYNC_VERSION_CONFLICT') ? error.message : error instanceof z.ZodError || error instanceof SyntaxError ? '条目或表单格式不正确' : null;
  if (message === null)
    throw error;
  return { status: 400, body: page(ctx.chrome('知识操作未完成', { active: 'knowledge' }), html `${capacityError(error)??html`<p class="error">${message}</p>`}<p>${link('/console/knowledge', '返回知识库')}</p>`) };
}

export async function shareHistoryPage(ctx:PageContext):Promise<PageResult>{
 const spaces=ctx.deps.knowledge.spaces;if(!spaces)return neutralPage(ctx);const history=await spaces.shareHistory(ctx.principal,ctx.url.searchParams.get('cursor'));
 return {status:200,body:page(ctx.chrome('分享到团队记录',{active:'knowledge',hint:'按提交时验证的结果列出；拒收后我的原条目保留，可修订后再次提交'}),card({title:'分享到团队记录'},html`${table(['条目','提交时间','结果','团队文件夹或原因'],await sharingRows(ctx,history.items),NO_TEAM_SHARES)}${history.next?link('/console/knowledge/submissions','更早的记录',{cursor:history.next}):''}`))};
}

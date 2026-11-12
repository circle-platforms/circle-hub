import {personalOriginCleared,clearedPersonalFolder} from './personal-origin.ts';
// Directory selection keeps immutable source addresses; every confirmation uses the normal sharing writer again.
import {z} from 'zod';
import {Sha256} from '../../../contracts/src/common.ts';
import {TreePath} from '../../../contracts/src/reference.ts';
import {ENTRY_KIND,uiLabelOf} from '../../../contracts/generated/vocabulary.ts';
import type {SpaceVersion} from '../../knowledge/api.ts';
import type {NodesPage} from '../../ports.ts';
import {KnowledgeError} from '../../knowledge/api.ts';
import {parseReference} from '../../refs/api.ts';
import {html,href,link,page,table,emptyAction,type Html} from './html.ts';
import {shareFeedback} from './feedback.ts';
import {sectionHead} from './ui.ts';
import {evidence,panel as card} from './presentation.ts';
import {knowledgeState,number,timestamp} from './knowledge-display.ts';
import {containsDirectory,directoryName} from './audience.ts';
import {currentAudience,spaceLayout} from './space-layout.ts';
import {checkTable} from './grant-dialog.ts';
import {type PageContext,type PageResult,neutralPage} from './pages.ts';

// A cell that names its column for the narrow layout, where the table becomes a list of rows and the header row is hidden.
const labelled=(label:string,value:unknown):Html=>html`<span data-label="${label}">${value}</span>`;

export function existingTeamLink(reference:string):Html{
 const ref=parseReference(reference);
 return ref.scheme==='tree'?link('/console/knowledge/space','已有团队条目',{space:'team',root:ref.root,path:ref.path,entry:ref.entry}):html``;
}

export async function knowledgeDirectory(ctx:PageContext,nodes:NodesPage,version:SpaceVersion,space:string,own:boolean,showCitations:boolean,actions:Html=html``):Promise<Html>{
 const blocks:Html[]=[];
 for(const node of nodes.nodes){
  const current=node.path===(ctx.url.searchParams.get('path')??'/'),location={space,root:version.root,path:node.path,scope:ctx.url.searchParams.get('scope')},folder=directoryName(node.path);
  if(!current&&node.entries.length===0){blocks.push(html`<section class="ch-section" data-empty-child><p>${link('/console/knowledge/space',folder,location)} · 此子文件夹暂无知识</p><p class="ch-meta">进入文件夹查看其子目录${own?'或新建知识':''}。</p></section>`);continue;}
  const headers:Array<string|Html>=[...(own?['选择']:[]),'陈述',html`<span title="${ENTRY_KIND.map(kind=>uiLabelOf('entry_kind',kind)).join('、')}">类型</span>`,'分享范围','状态',...(showCitations?['被引用']:[]),...(space==='team'?['提交人','来源','合并时间']:[])];
  const rows=[],rowLinks:string[]=[];
  for(const entry of node.entries){
   const product=version.body.products.some(mount=>containsDirectory(mount.path,node.path));
   const view=space==='team'?await ctx.deps.knowledge.spaces!.entry(ctx.principal,version.root,node.path,entry.entry):null;
   const shared=view?.body.shared_from;
   const source=shared?await personalOriginCleared(ctx,shared.root)?clearedPersonalFolder():await ctx.deps.knowledge.spaces!.mayRead(ctx.principal,shared.space,shared.path)?link('/console/knowledge/space',uiLabelOf('knowledge_origin','personal_entry'),{space:shared.space,root:shared.root,path:shared.path,entry:shared.entry}):uiLabelOf('knowledge_origin','personal_entry'):view?uiLabelOf('knowledge_origin','team_import'):product?uiLabelOf('knowledge_origin','product_source'):'未记录';
   const location={space,path:node.path,root:version.root,entry:entry.entry,scope:ctx.url.searchParams.get('scope'),node_cursor:ctx.url.searchParams.get('node_cursor')};
   rowLinks.push(href('/console/knowledge/space',location));
   rows.push([...(own?[entry.status==='verified'?html`<input type="checkbox" name="selected_entry" value="${entry.entry}" aria-label="选择条目">`:html`<input type="checkbox" disabled aria-label="无法选择条目" title="只有本人的已验证条目可以分享到团队">`]:[]),html`<span data-statement>${link('/console/knowledge/space',evidence(entry.statement),location)}</span>`,labelled('类型',uiLabelOf('entry_kind',entry.kind)),labelled('分享范围',(await currentAudience(ctx,space,node.path,product)).text),labelled('状态',entry.status?knowledgeState(entry.status):'未记录'),...(showCitations?[labelled('被引用',entry.cited_count==null?'暂无数据':number(entry.cited_count))]:[]),...(space==='team'?[labelled('提交人',view?await ctx.userName(view.body.by):'未记录'),labelled('来源',source),labelled('合并时间',view?timestamp(view.body.at):'未记录')]:[])]);
  }
  const selectedIndex=node.entries.findIndex(entry=>entry.entry===ctx.url.searchParams.get('entry'));
  const listing=table(headers,rows,{title:`${folder} 中还没有知识`,text:own?'可以在此新建笔记；提供来源时需附逐字引文，没有来源的笔记记为待验证。':'此处显示当前账户可读的知识；没有条目不代表其他文件夹也为空。',...(own?{action:emptyAction('/console/knowledge/space','在此新建知识',{...location,edit:'1'})}:{})},'knowledge-entries',{selected:selectedIndex,hrefs:rowLinks});
  const selected=own?html`<form data-knowledge-selection method="get" action="/console/knowledge/share-batch"><input type="hidden" name="root" value="${version.root}"><input type="hidden" name="path" value="${node.path}"><div class="ch-bulkbar"><span data-bulk-count>已选条目</span><button class="ch-btn ch-btn--primary" type="submit">分享到团队…</button></div>${listing}</form>`:listing;
  blocks.push(html`${current?'':sectionHead(folder)}${node.children.length?table(['子文件夹'],node.children.map(child=>[link('/console/knowledge/space',child.name,{space,root:version.root,path:child.path})])):''}${selected}`);
 }
 return card({title:'知识',tail:actions,hint:own?'只有本人的已验证条目可以选择；每条独立预检并在确认时重新检查':'按当前权限显示文件夹、条目和合并来源'},html`${blocks}${nodes.next?link('/console/knowledge/space','下一页',{space,root:version.root,path:ctx.url.searchParams.get('path')??'/',node_cursor:nodes.next}):''}`,'knowledge-directory');
}

const Batch=z.strictObject({root:Sha256,path:TreePath,entries:z.array(Sha256).min(1).max(100),team_path:TreePath.optional()});
export function batchInput(values:URLSearchParams|Map<string,string>){
 const entries=values instanceof URLSearchParams?values.getAll('selected_entry'):[values.get('selected_entry')??''];
 return Batch.parse({root:values.get('root'),path:values.get('path')??'/',entries:[...new Set(entries)],...(values.get('team_path')?{team_path:values.get('team_path')}:{})});
}
export async function batchSharePage(ctx:PageContext):Promise<PageResult>{
 const spaces=ctx.deps.knowledge.spaces;if(!spaces)return neutralPage(ctx);
 let input:ReturnType<typeof batchInput>;try{input=batchInput(ctx.url.searchParams);}catch(error){if(error instanceof z.ZodError)return neutralPage(ctx);throw error;}
 const plans=[];
 for(const entry of input.entries){
  const view=await spaces.entry(ctx.principal,input.root,input.path,entry);if(!view||view.body.space!==ctx.principal.id)return neutralPage(ctx);
  const result=await spaces.precheckShare(ctx.principal,{root:input.root,path:input.path,entry,team_path:input.team_path});
  plans.push({entry,title:view.body.content.statement,result});
 }
 const fields=html`<input type="hidden" name="root" value="${input.root}"><input type="hidden" name="path" value="${input.path}">${input.entries.map(entry=>html`<input type="hidden" name="selected_entry" value="${entry}">`)}`;
 const safe=plans.every(plan=>plan.result.ok),target=plans[0]?.result.target_path??'';
 const body=html`<p>我的：保留不变 · ${uiLabelOf('knowledge_space_kind','personal')}</p><p>团队：${uiLabelOf('audience_scope','team')}</p><form method="get" action="/console/knowledge/share-batch">${fields}<label>团队文件夹<input name="team_path" value="${target}" maxlength="2000"></label><button class="ch-btn ch-btn--secondary" type="submit">重新预检</button></form>${plans.map(plan=>card({title:plan.title,hint:'检查停止后，其余项目保持未检查；确认时逐条重查并分别记录实际结果'},html`${checkTable(plan.result.checks)}${plan.result.duplicate?existingTeamLink(plan.result.duplicate):''}`))}<form method="post" action="/console/knowledge/do/share-batch"><input type="hidden" name="csrf" value="${ctx.csrf??''}">${fields}<input type="hidden" name="team_path" value="${target}"><button class="ch-btn ch-btn--primary" type="submit"${safe?'':html` disabled`}>确认分享到团队</button></form>`;
 return {status:200,body:page(ctx.chrome('分享到团队预检',{active:'knowledge',hint:'预检不写入知识或回执；我的原条目保留，确认结果逐条进入分享到团队记录'}),await spaceLayout(ctx,body))};
}
export async function shareBatch(ctx:PageContext,values:URLSearchParams|Map<string,string>):Promise<string>{
 const spaces=ctx.deps.knowledge.spaces;if(!spaces)throw new KnowledgeError('对象不存在或无权读取',{code:'SOURCE_UNAVAILABLE'});
 const input=batchInput(values);
 const receipts=[];for(const entry of input.entries)receipts.push(await spaces.share(ctx.principal,{root:input.root,path:input.path,entry,team_path:input.team_path}));
 ctx.feedback=shareFeedback(receipts);
 return '/console/knowledge/submissions';
}

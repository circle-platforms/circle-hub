import {personalLocal,personalSyncNotice,syncSelected} from './personal-sync.ts';
import {uiLabelOf} from '../../../contracts/generated/vocabulary.ts';
import {capacitySummary} from './capacity.ts';
import {html,link,table,pageLayout,type Html} from './html.ts';
import {evidence,stat} from './presentation.ts';
import {button} from './ui.ts';
import {panel as card} from './presentation.ts';
import {knowledgeState,timestamp} from './knowledge-display.ts';
import {sharingRows} from './sharing-history.ts';
import type {PageContext} from './pages.ts';
import {currentAudience,inScope,knowledgeTabs,selectedScope,spaceLayout} from './space-layout.ts';
import {containsDirectory,directoryName} from './audience.ts';
/** The knowledge home; `team` is the team-side content kept beside the spaces (product sources, pending intake), shown on the all and team scopes. */
export async function knowledgeHome(ctx:PageContext,team:Html=html``):Promise<Html>{
 const spaces=ctx.deps.knowledge.spaces!; const scope=selectedScope(ctx);
 const local=await personalLocal(ctx),selectedSync=syncSelected(ctx)&&(scope==='personal'||scope==='all');
 const syncPanel=scope==='personal'||scope==='all'?await personalSyncNotice(ctx):html``;
 const rows:Array<{cells:unknown[];at:string}>=[];
 const recent=await spaces.recent(ctx.principal,scope,100);
 for(const entry of recent.items){
   const space=entry.body.space,path=entry.row.path;
   const audience=await currentAudience(ctx,space,path);
   const group=space===ctx.principal.id?'personal':space==='team'?'team':'shared';
   const location=[uiLabelOf('knowledge_search_scope',group),...(group==='shared'?[await ctx.userName(space)]:[]),...(path==='/'?[]:[directoryName(path)])].join(' › ');
   rows.push({at:entry.body.at,cells:[link('/console/knowledge/space',evidence(entry.body.content.statement),{space,path,entry:entry.row.entry,scope}),location,audience.text,knowledgeState(entry.row.status),timestamp(entry.body.at)]});
 }
 const history=await spaces.shareHistory(ctx.principal);
 const search=html`<form class="ch-actions" data-filters method="get" action="/console/search"><input type="hidden" name="scope" value="${scope}"><label>关键词<input name="q" required maxlength="200"></label><button class="ch-btn ch-btn--secondary" type="submit">搜索</button></form>`;
 const capacity=scope==='personal'?await spaces.usage(ctx.principal):null;
 const controls=scope==='personal'&&!local?html`<div class="ch-actions">${button('/console/knowledge/space','导入我的知识',{params:{space:ctx.principal.id,path:'/',import:'1',scope},hint:'上传本人原文进入私人空间'})}<a class="ch-btn ch-btn--secondary" href="${'/console/knowledge/space?'+new URLSearchParams({space:ctx.principal.id,path:'/',scope})+'#grant-knowledge'}">分享…</a>${button('/console/knowledge/space','新建',{primary:true,params:{space:ctx.principal.id,path:'/',edit:'1',scope}})}</div>`:scope==='team'&&ctx.admin?button('/console/operations/knowledge','导入团队知识',{primary:true}):html``;
 const submissions=card({title:'分享到团队记录',hint:'显示本人提交的检查结果；我的原条目与分享保留'},table(['条目','提交时间','结果','团队位置或原因'],await sharingRows(ctx,history.items),'没有分享到团队记录'));
 const content=html`${knowledgeTabs(ctx)}${selectedSync?'':syncPanel}${search}${capacity?html`<p class="ch-meta">${capacitySummary(capacity)}</p>`:''}${card({title:scope==='all'?'最近变化':uiLabelOf('knowledge_search_scope',scope),hint:'按当前分享权限列出可读条目；时间为条目自身的写入时间'},table(['条目','位置','分享范围','状态','更新'],rows.map(row=>row.cells),'没有可读条目'))}${scope==='all'?submissions:''}${scope==='all'||scope==='team'?team:''}`;
 const overview=html`<section class="ch-section"><h2 class="ch-panel-title">知识库</h2><p class="ch-meta">${uiLabelOf('knowledge_search_scope',scope)}</p></section><div class="ch-stats">${stat('知识',recent.total)}</div>${rows.length?card({title:'最近变化'},html`<ul class="ch-feed">${rows.slice(0,5).map(row=>html`<li>${row.cells[0]}${timestamp(row.at)}</li>`)}</ul>`):''}`;
 return spaceLayout(ctx,pageLayout(content,{inspector:selectedSync?syncPanel:overview,actions:controls,detail:selectedSync,back:link('/console/knowledge','返回知识库',{scope})}));
}

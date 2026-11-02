import {uiLabelOf} from '../../../contracts/generated/vocabulary.ts';
import {html,link,table,type Html} from './html.ts';
import {button,card} from './ui.ts';
import {knowledgeState,size,timestamp} from './knowledge-display.ts';
import {sharingRows} from './sharing-history.ts';
import type {PageContext} from './pages.ts';
import {currentAudience,inScope,knowledgeTabs,selectedScope,spaceLayout} from './space-layout.ts';
import {containsDirectory,directoryName} from './audience.ts';
/** The knowledge home; `team` is the team-side content kept beside the spaces (product sources, pending intake), shown on the all and team scopes. */
export async function knowledgeHome(ctx:PageContext,team:Html=html``):Promise<Html>{
 const spaces=ctx.deps.knowledge.spaces!; const scope=selectedScope(ctx);
 const visible=await spaces.visible(ctx.principal,'all',undefined,{initialize:false});
 const rows:Array<{cells:unknown[];at:string}>=[];
 for(const s of visible.filter(s=>inScope(scope,s.space,ctx.principal.id))){
  for(const row of s.version.body.entries){
   if(!s.paths.some(path=>containsDirectory(path,row.path)))continue;
   const entry=await spaces.entry(ctx.principal,s.version.root,row.path,row.entry);if(!entry)continue;
   const audience=await currentAudience(ctx,s.space,row.path);
   const group=s.space===ctx.principal.id?'personal':s.space==='team'?'team':'shared';
   const location=[uiLabelOf('knowledge_search_scope',group),...(group==='shared'?[await ctx.userName(s.space)]:[]),...(row.path==='/'?[]:[directoryName(row.path)])].join(' › ');
   rows.push({at:entry.body.at,cells:[link('/console/knowledge/space',entry.body.content.statement,{space:s.space,path:row.path,entry:row.entry,scope}),location,audience.text,knowledgeState(entry.row.status),timestamp(entry.body.at)]});
  }
 }
 rows.sort((a,b)=>b.at.localeCompare(a.at));
 const history=await spaces.shareHistory(ctx.principal);
 const search=html`<form class="filters" method="get" action="/console/search"><input type="hidden" name="scope" value="${scope}"><label>关键词<input name="q" required maxlength="200"></label><button type="submit">搜索</button></form>`;
 const own=visible.find(v=>v.space===ctx.principal.id);
 const personalHistory=scope==='personal'?(await ctx.deps.knowledge.memory?.usage(ctx.principal))?.history??0:0;
 const controls=scope==='personal'?html`<div class="actions">${button('/console/knowledge/space','添加条目',{params:{space:ctx.principal.id,path:'/',edit:'1',scope}})}${button('/console/knowledge/space','导入个人知识',{params:{space:ctx.principal.id,path:'/',import:'1',scope},hint:'上传本人原文进入个人空间'})}<a class="btn" href="${'/console/knowledge/space?'+new URLSearchParams({space:ctx.principal.id,path:'/',scope})+'#grant-knowledge'}">授权…</a></div><p>已用 ${size((own?.version.body.used_bytes??0)+personalHistory)} / ${size(await spaces.capacity(ctx.principal.id))}</p>`:scope==='team'&&ctx.admin?button('/console/operations/knowledge','导入团队知识'):html``;
 const submissions=card({title:'我的提交共享',hint:'显示本人提交的检查结果；个人原条目与授权保留'},table(['条目','提交时间','结果','团队位置或原因'],await sharingRows(ctx,history.items),'没有提交共享记录'));
 const content=html`${knowledgeTabs(ctx)}${search}${controls}${card({title:scope==='all'?'最近变化':uiLabelOf('knowledge_search_scope',scope),hint:'按当前授权列出可读条目；时间为条目自身的写入时间'},table(['条目','位置','可见范围','状态','更新'],rows.slice(0,100).map(row=>row.cells),'没有可读条目'))}${scope==='all'?submissions:''}${scope==='all'||scope==='team'?team:''}`;
 return spaceLayout(ctx,content);
}

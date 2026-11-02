// Directory selection keeps immutable source addresses; every confirmation uses the normal sharing writer again.
import {z} from 'zod';
import {Sha256} from '../../../contracts/src/common.ts';
import {TreePath} from '../../../contracts/src/reference.ts';
import {ENTRY_KIND,uiLabelOf} from '../../../contracts/generated/vocabulary.ts';
import type {SpaceVersion} from '../../knowledge/api.ts';
import type {NodesPage} from '../../ports.ts';
import {KnowledgeError} from '../../knowledge/api.ts';
import {parseReference} from '../../refs/api.ts';
import {html,link,page,table,type Html} from './html.ts';
import {card,sectionHead} from './ui.ts';
import {knowledgeState,number,timestamp} from './knowledge-display.ts';
import {containsDirectory,directoryName} from './audience.ts';
import {currentAudience,spaceLayout} from './space-layout.ts';
import {checkTable} from './grant-dialog.ts';
import {type PageContext,type PageResult,neutralPage} from './pages.ts';

export function existingTeamLink(reference:string):Html{
 const ref=parseReference(reference);
 return ref.scheme==='tree'?link('/console/knowledge/space','已有团队条目',{space:'team',root:ref.root,path:ref.path,entry:ref.entry}):html``;
}

export async function knowledgeDirectory(ctx:PageContext,nodes:NodesPage,version:SpaceVersion,space:string,own:boolean,showCitations:boolean,actions:Html=html``):Promise<Html>{
 const blocks:Html[]=[];
 for(const node of nodes.nodes){
  const headers:Array<string|Html>=[...(own?['选择']:[]),'陈述',html`<span title="${ENTRY_KIND.map(kind=>uiLabelOf('entry_kind',kind)).join('、')}">种类</span>`,'可见范围','状态',...(showCitations?['被引用']:[]),...(space==='team'?['提交人','来源','合并时间']:[])];
  const rows=[];
  for(const entry of node.entries){
   const product=version.body.products.some(mount=>containsDirectory(mount.path,node.path));
   const view=space==='team'?await ctx.deps.knowledge.spaces!.entry(ctx.principal,version.root,node.path,entry.entry):null;
   const shared=view?.body.shared_from;
   const source=shared?await ctx.deps.knowledge.spaces!.mayRead(ctx.principal,shared.space,shared.path)?link('/console/knowledge/space',uiLabelOf('knowledge_origin','personal_entry'),{space:shared.space,root:shared.root,path:shared.path,entry:shared.entry}):uiLabelOf('knowledge_origin','personal_entry'):view?uiLabelOf('knowledge_origin','team_import'):product?uiLabelOf('knowledge_origin','product_source'):'—';
   rows.push([...(own?[entry.status==='verified'?html`<input type="checkbox" name="selected_entry" value="${entry.entry}" aria-label="选择 ${entry.statement}">`:'—']:[]),link('/console/knowledge/space',entry.statement,{space,path:node.path,root:version.root,entry:entry.entry}),uiLabelOf('entry_kind',entry.kind),(await currentAudience(ctx,space,node.path,product)).text,entry.status?knowledgeState(entry.status):'—',...(showCitations?[entry.cited_count==null?'—':number(entry.cited_count)]:[]),...(space==='team'?[view?await ctx.userName(view.body.by):'—',source,view?timestamp(view.body.at):'—']:[])]);
  }
  const listing=table(headers,rows,'没有条目');
  const selected=own?html`<form class="knowledge-selection" method="get" action="/console/knowledge/share-batch"><input type="hidden" name="root" value="${version.root}"><input type="hidden" name="path" value="${node.path}">${listing}<button class="btn primary batch-submit" type="submit">提交共享…</button></form>`:listing;
  blocks.push(html`${node.path===(ctx.url.searchParams.get('path')??'/')?'':sectionHead(directoryName(node.path))}${node.children.length?table(['下级目录'],node.children.map(child=>[link('/console/knowledge/space',child.name,{space,root:version.root,path:child.path})])):''}${selected}`);
 }
 return card({title:directoryName(ctx.url.searchParams.get('path')??'/'),tail:actions,hint:own?'只有本人的已核验条目可以选择；每条独立预检并在确认时重新检查':'按当前权限显示目录、条目和合并来源'},html`${blocks}${nodes.next?link('/console/knowledge/space','下一页',{space,root:version.root,path:ctx.url.searchParams.get('path')??'/',node_cursor:nodes.next}):''}`,'knowledge-directory');
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
 const body=html`<p>个人：保留不变 · ${uiLabelOf('knowledge_space_kind','personal')}</p><p>团队：${uiLabelOf('audience_scope','team')}</p><form method="get" action="/console/knowledge/share-batch">${fields}<label>团队目录<input name="team_path" value="${target}" maxlength="2000"></label><button type="submit">重新预检</button></form>${plans.map(plan=>card({title:plan.title,hint:'检查停止后，其余项目保持未检查；确认时逐条重查并分别记录实际结果'},html`${checkTable(plan.result.checks)}${plan.result.duplicate?existingTeamLink(plan.result.duplicate):''}`))}<form method="post" action="/console/knowledge/do/share-batch"><input type="hidden" name="csrf" value="${ctx.csrf??''}">${fields}<input type="hidden" name="team_path" value="${target}"><button class="btn primary" type="submit"${safe?'':html` disabled`}>确认提交共享</button></form>`;
 return {status:200,body:page(ctx.chrome('提交共享预检',{active:'knowledge',hint:'预检不写入知识或回执；个人原条目保留，确认结果逐条进入我的提交共享'}),await spaceLayout(ctx,body))};
}
export async function shareBatch(ctx:PageContext,values:URLSearchParams|Map<string,string>):Promise<string>{
 const spaces=ctx.deps.knowledge.spaces;if(!spaces)throw new KnowledgeError('对象不存在或无权读取',{code:'SOURCE_UNAVAILABLE'});
 const input=batchInput(values);
 for(const entry of input.entries)await spaces.share(ctx.principal,{root:input.root,path:input.path,entry,team_path:input.team_path});
 return '/console/knowledge/submissions';
}

import { KnowledgeSearchScopeSchema, isKnowledgeSearchScope, uiLabelOf, type KnowledgeSearchScope } from '../../../contracts/generated/vocabulary.ts';
import type { PackListing } from '../../ports.ts';
import type { PageContext } from './pages.ts';
import { html, link, type Html } from './html.ts';
import { containsDirectory, directoryName, describeAudience } from './audience.ts';

export function selectedScope(ctx: PageContext): KnowledgeSearchScope {
 const scope=ctx.url.searchParams.get('scope');
 if(isKnowledgeSearchScope(scope))return scope;
 const space=ctx.url.searchParams.get('space');
 return space ? space==='team'?'team':space===ctx.principal.id?'personal':'shared' : 'all';
}
export const inScope=(scope:KnowledgeSearchScope,space:string,viewer:string)=>scope==='all'||(scope==='team'?space==='team':scope==='personal'?space===viewer:space!=='team'&&space!==viewer);
export async function currentAudience(ctx:PageContext,space:string,path='/',product=false,pack?:string,memory=false){
 const own=space===ctx.principal.id;
 const grants=own?(memory?await ctx.deps.knowledge.memory?.grants(ctx.principal)??[]:pack?await ctx.deps.registry?.personal?.grants(ctx.principal,pack)??[]:await ctx.deps.knowledge.spaces?.grants(ctx.principal)??[]):[];
 return describeAudience({owner:space,viewer:ctx.principal.id,ownerName:await ctx.userName(space),path,product,grants,users:own?await ctx.deps.records.principals.list():[]});
}
export function directoryTree(directories:readonly string[],url:(path:string)=>string,path='/'):Html{
 const depth=path.split('/').filter(Boolean).length;
 const children=directories.filter(p=>p!==path&&containsDirectory(path,p)&&p.split('/').filter(Boolean).length===depth+1);
 return html`${children.map(child=>html`<details open><summary><a href="${url(child)}">${directoryName(child).split(' › ').at(-1)}</a></summary>${directoryTree(directories,url,child)}</details>`)}`;
}
export async function spaceLayout(ctx:PageContext,content:Html,packs?:readonly PackListing[]):Promise<Html>{
 const scope=selectedScope(ctx),view=ctx.url.searchParams.get('view'),memory=view==='memory';
 const base=packs?'/console/packs':'/console/knowledge';
 const memories=memory?await ctx.deps.knowledge.memory?.items(ctx.principal)??[]:[];
 const visible=packs||memory?[]:await ctx.deps.knowledge.spaces?.visible(ctx.principal,'all',undefined,{initialize:false})??[];
 const names=new Map(await Promise.all([...new Set([...visible.map(v=>v.space),...memories.map(v=>v.space)])].map(async space=>[space,await ctx.userName(space)] as const)));
 const readable=await ctx.deps.products?.readableProducts(ctx.principal)??new Set<string>();
 const shared=packs?packs.some(p=>p.space&&p.space!=='team'&&p.space!==ctx.principal.id):memory?memories.some(v=>v.space!=='team'&&v.space!==ctx.principal.id):visible.some(v=>v.space!=='team'&&v.space!==ctx.principal.id);
 const rootLink=(s:KnowledgeSearchScope)=>({scope:s,...(memory?{view:'memory'}:{})});
 const scopes=KnowledgeSearchScopeSchema.extract(['all','personal','shared','team']).options;
 const nav=html`<aside class="space-panel" aria-label="空间">${scopes.filter(s=>s!=='shared'||shared||scope==='shared').map(s=>{
  const subset=packs?.filter(p=>inScope(s,p.space??'team',ctx.principal.id));
  const count=(kind:PackListing['kind'])=>new Set(subset?.filter(p=>p.kind===kind).map(p=>(p.space??'team')+':'+p.id)).size;
  const groups=visible.filter(v=>inScope(s,v.space,ctx.principal.id));
  const memoryOwners=[...new Set(memories.filter(v=>inScope(s,v.space,ctx.principal.id)).map(v=>v.space))];
  return html`<section>${link(base,uiLabelOf('knowledge_search_scope',s),rootLink(s))}${subset?html`<div class="sub">${uiLabelOf('pack_kind','workflow')} ${count('workflow')} · ${uiLabelOf('pack_kind','skill')} ${count('skill')}</div>`:''}${memory&&s!=='all'?memoryOwners.map(owner=>html`<details open><summary>${owner===ctx.principal.id||owner==='team'?uiLabelOf('knowledge_search_scope',owner==='team'?'team':'personal'):awaitName(owner)}</summary>${[...new Set(memories.filter(v=>v.space===owner).map(v=>v.path))].map(path=>html`<div>${link(base,directoryName(path),{view:'memory',scope:s,space:owner,path})}</div>`)}</details>`):''}${packs||s==='all'||memory?'':groups.map(v=>{
   const allowed=v.version.body.directories.filter(p=>{const related=v.version.body.products.filter(m=>containsDirectory(m.path,p)||containsDirectory(p,m.path));return v.paths.some(parent=>containsDirectory(parent,p))&&(!related.length||related.some(m=>readable.has(m.product)));});
   const href=(path:string)=>'/console/knowledge/space?'+new URLSearchParams({space:v.space,path,scope:s});
   return html`<details open><summary>${link('/console/knowledge/space',s==='shared'?awaitName(v.space):uiLabelOf('knowledge_search_scope',s),{space:v.space,path:v.paths[0],scope:s})}</summary>${directoryTree(allowed,href)}</details>`;
  })}</section>`;
 })}</aside>`;
 // Names are resolved before rendering; only currently visible owners are queried.
 function awaitName(id:string){return names.get(id)??'—';}
 return html`<div class="space-layout">${nav}<div class="space-main stack">${content}</div></div>`;
}

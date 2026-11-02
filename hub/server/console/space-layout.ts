// Both knowledge views and workflows derive navigation solely from currently readable content.
import {KnowledgeSearchScopeSchema,KnowledgeViewSchema,isKnowledgeSearchScope,uiLabelOf,type KnowledgeSearchScope} from '../../../contracts/generated/vocabulary.ts';
import type {PackListing} from '../../ports.ts';
import type {PageContext} from './pages.ts';
import {html,link,pageLayout,type Html} from './html.ts';
import {containsDirectory,directoryName,describeAudience} from './audience.ts';

export function selectedScope(ctx:PageContext):KnowledgeSearchScope{
 const scope=ctx.url.searchParams.get('scope');if(isKnowledgeSearchScope(scope))return scope;
 const space=ctx.url.searchParams.get('space');return space?space==='team'?'team':space===ctx.principal.id?'personal':'shared':'all';
}
export const inScope=(scope:KnowledgeSearchScope,space:string,viewer:string)=>scope==='all'||(scope==='team'?space==='team':scope==='personal'?space===viewer:space!=='team'&&space!==viewer);
export function knowledgeTabs(ctx:PageContext):Html{
 const scope=selectedScope(ctx),current=ctx.url.searchParams.get('view')==='memory'?'memory':'knowledge';
 return html`<nav class="ch-seg" aria-label="知识库内容">${KnowledgeViewSchema.options.map(view=>html`<a href="${'/console/knowledge?'+new URLSearchParams({scope,...(view==='memory'?{view}:{})})}"${current===view?html` aria-current="page"`:''}>${uiLabelOf('knowledge_view',view)}</a>`)}</nav>`;
}
export async function currentAudience(ctx:PageContext,space:string,path='/',product=false,pack?:string,memory=false){
 const own=space===ctx.principal.id;
 const grants=own?(memory?await ctx.deps.knowledge.memory?.grants(ctx.principal)??[]:pack?await ctx.deps.registry?.personal?.grants(ctx.principal,pack)??[]:await ctx.deps.knowledge.spaces?.grants(ctx.principal)??[]):[];
 return describeAudience({owner:space,viewer:ctx.principal.id,ownerName:await ctx.userName(space),path,product,grants,users:own?await ctx.deps.records.principals.list():[]});
}
export function directoryTree(directories:readonly string[],url:(path:string)=>string,path='/',label=(path:string)=>directoryName(path).split(' › ').at(-1)!,levels=3,selected?:string):Html{
 if(levels<=0)return html``;
 const depth=path.split('/').filter(Boolean).length;
 const children=directories.filter(p=>p!==path&&containsDirectory(path,p)&&p.split('/').filter(Boolean).length===depth+1);
 return html`${children.map(child=>html`<details open><summary><a href="${url(child)}" title="${label(child)}"${child===selected?html` aria-current="page"`:''}>${label(child)}</a></summary>${directoryTree(directories,url,child,label,levels-1,selected)}</details>`)}`;
}
function ancestors(paths:readonly string[]):string[]{
 const directories=new Set<string>(['/']);for(const path of paths){const parts=path.split('/').filter(Boolean);for(let n=1;n<=parts.length;n++)directories.add('/'+parts.slice(0,n).join('/'));}return [...directories].sort();
}
export async function spaceLayout(ctx:PageContext,content:Html,packs?:readonly PackListing[]):Promise<Html>{
 const scope=selectedScope(ctx),memory=ctx.url.searchParams.get('view')==='memory',base=packs?'/console/packs':'/console/knowledge';
 const memories=memory?await ctx.deps.knowledge.memory?.items(ctx.principal)??[]:[];
 const visible=packs||memory?[]:await ctx.deps.knowledge.spaces?.visible(ctx.principal,'all',undefined,{initialize:false})??[];
 const names=new Map(await Promise.all([...new Set([...visible.map(v=>v.space),...memories.map(v=>v.space)])].map(async space=>[space,await ctx.userName(space)] as const)));
 const readable=await ctx.deps.products?.readableProducts(ctx.principal)??new Set<string>();
 const products=await ctx.deps.products?.products?.()??[];
 const productNames=new Map(products.filter(value=>readable.has(value.product.id)).map(value=>[value.product.id,value.product.title]));
 const shared=packs?packs.some(p=>p.space&&p.space!=='team'&&p.space!==ctx.principal.id):memory?memories.some(v=>v.space!=='team'&&v.space!==ctx.principal.id):visible.some(v=>v.space!=='team'&&v.space!==ctx.principal.id);
 const values=KnowledgeSearchScopeSchema.enum,scopes=[values.all,values.personal,values.shared,values.team];
 const nav=html`<div class="ch-nav-sub" aria-label="空间">${scopes.filter(s=>s!=='shared'||shared).map(s=>{
  const subset=packs?.filter(p=>inScope(s,p.space??'team',ctx.principal.id));
  const count=(kind:PackListing['kind'])=>new Set(subset?.filter(p=>p.kind===kind).map(p=>(p.space??'team')+':'+p.id)).size;
  const memoryOwners=[...new Set(memories.filter(v=>inScope(s,v.space,ctx.principal.id)).map(v=>v.space))];
  const memoryGroups=memory&&s!=='all'?memoryOwners.map(owner=>{
   const paths=ancestors(memories.filter(v=>v.space===owner).map(v=>v.path));
   const url=(path:string)=>base+'?'+new URLSearchParams({view:'memory',scope:s,space:owner,path});
   const tree=directoryTree(paths,url,'/',undefined,3,ctx.url.searchParams.get('space')===owner?ctx.url.searchParams.get('path')??'/':undefined);
   return owner===ctx.principal.id||owner==='team'?tree:html`<details open><summary>${names.get(owner)}</summary>${tree}</details>`;
  }):[];
  const knowledgeGroups=packs||s==='all'||memory?[]:visible.filter(v=>inScope(s,v.space,ctx.principal.id)).map(v=>{
   const mounts=v.version.body.products;
   const allowed=v.version.body.directories.filter(path=>{const related=mounts.filter(m=>containsDirectory(m.path,path)||containsDirectory(path,m.path));return v.paths.some(parent=>containsDirectory(parent,path))&&(!related.length||related.some(m=>readable.has(m.product)));});
   const labels=new Map<string,string>();
   for(const mount of mounts.filter(m=>readable.has(m.product))){const parts=mount.path.split('/').filter(Boolean);labels.set('/'+parts[0],uiLabelOf('knowledge_directory','products'));labels.set('/'+parts.slice(0,-1).join('/'),productNames.get(mount.product)??mount.product);labels.set(mount.path,mount.line??'不分版本');}
   const url=(path:string)=>'/console/knowledge/space?'+new URLSearchParams({space:v.space,path,scope:s});
   const label=(path:string)=>labels.get(path)??directoryName(path).split(' › ').at(-1)!;
   const roots=allowed.filter(path=>!allowed.some(parent=>parent!==path&&containsDirectory(parent,path)));
   const selected=ctx.url.searchParams.get('space')===v.space?ctx.url.searchParams.get('path')??'/':undefined;
   const tree=allowed.includes('/')?directoryTree(allowed,url,'/',label,3,selected):html`${roots.map(root=>html`<details open><summary><a href="${url(root)}" title="${label(root)}"${root===selected?html` aria-current="page"`:''}>${label(root)}</a></summary>${directoryTree(allowed,url,root,label,2,selected)}</details>`)}`;
   return v.space===ctx.principal.id||v.space==='team'?tree:html`<details open><summary>${link('/console/knowledge/space',names.get(v.space),{space:v.space,path:v.paths[0],scope:s})}</summary>${tree}</details>`;
  });
  const total=memory?memories.filter(item=>inScope(s,item.space,ctx.principal.id)).length:visible.filter(v=>inScope(s,v.space,ctx.principal.id)).reduce((count,v)=>count+v.version.body.entries.filter(row=>v.paths.some(path=>containsDirectory(path,row.path))).length,0);
  const href=base+'?'+new URLSearchParams({scope:s,...(memory?{view:'memory'}:{})});
  return html`<section><a href="${href}"${scope===s?html` aria-current="page"`:''}>${uiLabelOf('knowledge_search_scope',s)}<span class="ch-count">${(subset?count('workflow')+count('skill'):total).toLocaleString('en-US')}</span></a>${scope===s?html`<div class="ch-nav-tree">${memoryGroups}${knowledgeGroups}</div>`:''}</section>`;
 })}</div>`;
 const recentPacks=packs?.filter(p=>(p.kind==='workflow'||p.kind==='skill')&&inScope(scope,p.space??'team',ctx.principal.id));
 const count= recentPacks?new Set(recentPacks.filter(p=>inScope(scope,p.space??'team',ctx.principal.id)).map(p=>(p.space??'team')+':'+p.id)).size:
  memory?memories.filter(item=>inScope(scope,item.space,ctx.principal.id)).length:
  visible.filter(v=>inScope(scope,v.space,ctx.principal.id)).reduce((n,v)=>n+v.version.body.entries.filter(row=>v.paths.some(path=>containsDirectory(path,row.path))).length,0);
 const overview=html`<section class="ch-section"><h2 class="ch-panel-title">${packs?uiLabelOf('pack_kind','workflow'):memory?uiLabelOf('knowledge_view','memory'):'知识库'}</h2><p class="ch-meta">${uiLabelOf('knowledge_search_scope',scope)}</p></section><div class="ch-stat"><span class="ch-stat-label">${packs?'工作流与通用技能':memory?'记忆':'知识'}</span><span class="ch-stat-value">${count.toLocaleString('en-US')}</span></div>${recentPacks?.length?html`<section class="ch-section"><h2 class="ch-section-label">最近发布</h2><ul class="ch-feed">${[...recentPacks].sort((a,b)=>b.published_at.localeCompare(a.published_at)).slice(0,5).map(pack=>html`<li>${link('/console/packs/'+pack.id,pack.title,{space:pack.space,scope})}<span class="ch-meta">${pack.published_at.slice(0,10)}</span></li>`)}</ul></section>`:''}`;
 return pageLayout(html`<div class="ch-section" data-page-content data-area-content>${content}</div>`,{...content.layout,sidebar:nav,inspector:content.layout.inspector===undefined?overview:content.layout.inspector});
}

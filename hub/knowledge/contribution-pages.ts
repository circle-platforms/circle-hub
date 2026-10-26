import {applyApplicabilityJudgments} from './applicability-fields.ts';
// A node page's cursor interleaves immutable tree entries with bounded, permission-filtered contribution pages.
import type { NodesPage, NodesQuery } from '../ports.ts';
import { digestOf, type Principal } from '../records/api.ts';
import type { KnowledgeContext } from './context.ts';
import type { ContributionLayer } from './contributions.ts';
import { canonicalSize } from './digest.ts';
import { KnowledgeError } from './errors.ts';
import { continuesNodeEntries, type TreeReading } from './read.ts';

interface Position {q:string;b:string|null;n:number;r:string|null;l:boolean}
const PREFIX='kc1.';
export async function contributionNodes(context:KnowledgeContext,reading:TreeReading,layer:ContributionLayer,query:NodesQuery,reader:Principal):Promise<NodesPage|null>{
  if(!/^[0-9a-f]{64}$/.test(query.root))return null;
  const q=digestOf({root:query.root,paths:query.paths??['/'],depth:query.depth??1});
  let state:Position={q,b:query.cursor??null,n:0,r:null,l:false};
  if(query.cursor?.startsWith(PREFIX)){
    try{
      const value=JSON.parse(Buffer.from(query.cursor.slice(PREFIX.length),'base64url').toString());
      if(value.q!==q||!(value.b===null||typeof value.b==='string')||!Number.isSafeInteger(value.n)||value.n<0||!(value.r===null||typeof value.r==='string')||typeof value.l!=='boolean')throw new Error();
      state=value;
    }catch{throw new KnowledgeError('回注分页游标不属于本次查询；保持原 root、paths、depth 从第一页重读',{code:'REFERENCE_UNRESOLVED'});}
  }else if(!(await layer.has(query.root,reader)))return reading.getNodes(query,reader);
  const budget=context.limits.pageBytes;
  const base=await reading.getNodes({...query,cursor:state.b},reader,Math.max(1024,Math.floor(budget/2)));
  if(base===null)return null;
  if(state.n>=base.nodes.length&&base.nodes.length>0)throw new KnowledgeError('回注分页位置已失效；按原查询从第一页重读',{code:'REFERENCE_UNRESOLVED'});
  const nodes:NodesPage['nodes']=state.l?[]:base.nodes.map(node=>({...node}));
  let next:string|null=base.next;
  let continued=false;
  for(let i=state.n;i<base.nodes.length;i++){
    // The first slice of a split tree node already emitted its contribution pages.
    if(!state.l&&i===0&&continuesNodeEntries(state.b))continue;
    let node=state.l?{...base.nodes[i],entries:[],children:[]}:nodes[i];
    if(state.l)nodes.push(node);
    const remaining=Math.max(0,budget-16384-canonicalSize(nodes));
    const page=await layer.page(query.root,node.path,reader,{cursor:i===state.n?state.r:null,bytes:remaining});
    if(page.items.length>0)node.contributions=page.items;
    for(const entry of node.entries)applyApplicabilityJudgments(entry,page.items,page.next===null);
    if(page.next!==null){
      next=PREFIX+Buffer.from(JSON.stringify({q,b:state.b,n:i,r:page.next,l:true} satisfies Position)).toString('base64url');
      continued=true;break;
    }
    if(state.l&&i+1<base.nodes.length&&canonicalSize(nodes)>budget-2048){
      next=PREFIX+Buffer.from(JSON.stringify({q,b:state.b,n:i+1,r:null,l:true} satisfies Position)).toString('base64url');
      continued=true;break;
    }
  }
  const deferred=nodes.some(node=>node.contributions?.some(view=>view.contribution===undefined));
  const notes=[base.coverage.note,...(state.l?['本页续列回注；树条目与子节点已在前页给出']:[]),...(continued?['回注尚未读完（可见性过滤、条数或字节上限）；保持查询不变，用 next 自动续读']:[]),...(deferred?['较大回注正文只给引用，缺少正文时用所列 rec: 引用游标分段读取']:[])].filter(Boolean).join('；');
  return {nodes,next,coverage:{...base.coverage,complete:base.coverage.complete&&next===null&&!deferred,...(notes?{note:notes}:{})}};
}

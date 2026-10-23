// Declarative literal relations over immutable tree content, with interpretation pinned to a composition.
import { LINK_MATCH } from '../../contracts/generated/vocabulary.ts';
import { LinkDeclaration, type LinkDeclaration as Rule } from '../../contracts/src/product.ts';
import type { Backlinks, LinkEdge, LinkDrift, LinksView } from '../../contracts/src/views.ts';
import { RunRecord } from '../../contracts/src/run.ts';
import { RunId, Sha256 } from '../../contracts/src/common.ts';
import { canonicalBytes, canonicalize, sha256Hex, type Principal } from '../records/api.ts';
import { pathOf, pathSegments, treeReference } from '../refs/api.ts';
import { CompositionView } from './composition.ts';
import { compareText, cutText, type EntryContent } from './digest.ts';
import type { KnowledgeContext } from './context.ts';
import type { Builds } from './builds.ts';
import { Lru } from './store.ts';

export interface LiteralSource { path: string; entry: string; content: EntryContent; unplaced?: boolean }
export type RelationNodes = ReadonlyMap<string, ReadonlySet<string>>;
export interface RelationFacts { links: LinkEdge[]; drift: LinkDrift[]; entries: number; literals: number }
export interface LinkRequest { prefix?: string; target?: string | null; rule?: string | null; cursor?: string | null; limit?: number }
const summaryOf=(text:string)=>cutText(text.replace(/\s+/gu,' ').trim(),160);
const beneath=(path:string,prefix:string)=>prefix==='/'||path===prefix||path.startsWith(prefix+'/');
const rulesOf=(value:unknown):Rule[]=>{
  const rules=LinkDeclaration.array().max(32).parse(value);
  if(new Set(rules.map(r=>r.id)).size!==rules.length)throw new Error('链接声明编号重复');
  return rules;
};
export function resolveLiteral(rule:Rule,literal:string,nodes:RelationNodes):{target:string|null;attempted_path:string|null;stopped_at:string;remainder:string[]} {
  let text=literal;
  if(rule.normalize?.strip_nul)text=text.replaceAll('\0','');
  const original=text.trim()?text.trim().split(/\s+/u):[];
  const words=original.map(word=>{
    let value=rule.normalize?.nfkc?word.normalize('NFKC'):rule.normalize?.nfc?word.normalize('NFC'):word;
    if(rule.normalize?.lowercase)value=value.toLowerCase();return value;
  });
  const base=pathSegments(rule.namespace),segments:string[]=[];
  let stopped='/',best:string|null=null,bestWords=0,attempted:string|null=null;
  try{attempted=pathOf([...base,...words]);}catch{}
  for(const part of base){segments.push(part);const path=pathOf(segments);if(!nodes.has(path))return {target:null,attempted_path:attempted,stopped_at:stopped,remainder:original};stopped=path;}
  for(let i=0;i<words.length;i++){
    segments.push(words[i]);let path:string;try{path=pathOf(segments);}catch{break;}
    const kinds=nodes.get(path);if(kinds===undefined)break;stopped=path;
    if(rule.entry_kind===undefined||kinds.has(rule.entry_kind)){best=path;bestWords=i+1;}
  }
  if(words.length===0||rule.match===LINK_MATCH[0]&&(best!==attempted||bestWords!==words.length))best=null;
  return {target:best,attempted_path:attempted,stopped_at:stopped,remainder:best===null?original:original.slice(bestWords)};
}
/** The very same evaluator is used by production diagnostics and by read-time views. */
export function relationFacts(root:string,declarations:readonly Rule[],nodes:RelationNodes,sources:readonly LiteralSource[]):RelationFacts {
  const rules=rulesOf(declarations),links:LinkEdge[]=[],groups=new Map<string,LinkDrift>(),entries=new Set<string>();let literals=0;
  for(const source of new Map(sources.map(s=>[s.path+'\0'+s.entry,s])).values())for(const rule of rules){
    if(!Object.hasOwn(source.content.data,rule.field))continue;
    const raw=source.content.data[rule.field];if(raw===null||raw===undefined)continue;
    const values=typeof raw==='string'?[raw]:Array.isArray(raw)&&raw.every(v=>typeof v==='string')?raw:null;
    if(values===null)throw new Error(`链接声明 ${rule.id} 的字面字段必须是文字或文字列表`);
    const reference=source.unplaced?`entry:${source.entry}`:treeReference(root,source.path,source.entry),occurrence={reference,path:source.path,summary:summaryOf(source.content.statement)};
    for(const literal of new Set(values)){
      literals++;entries.add(reference);const match=resolveLiteral(rule,literal,nodes);
      if(match.target!==null)links.push({...occurrence,rule:rule.id,literal,target:match.target,remainder:match.remainder});
      else {const key=canonicalize([rule.id,literal]),group=groups.get(key)??{rule:rule.id,literal,attempted_path:match.attempted_path,stopped_at:match.stopped_at,total:0,occurrences:[]};group.total++;group.occurrences.push(occurrence);groups.set(key,group);}
    }
  }
  links.sort((a,b)=>compareText(a.rule,b.rule)||compareText(a.literal,b.literal)||compareText(a.reference,b.reference));
  const drift=[...groups.values()].sort((a,b)=>compareText(a.rule,b.rule)||compareText(a.literal,b.literal));
  for(const group of drift)group.occurrences.sort((a,b)=>compareText(a.reference,b.reference));
  return {links,drift,entries:entries.size,literals};
}

export class LinkReading {
  readonly #context:KnowledgeContext;readonly #builds:Builds;
  readonly #cache=new Lru<string,RelationFacts>(4,64*1024*1024);
  constructor(context:KnowledgeContext,builds:Builds){this.#context=context;this.#builds=builds;}
  async compositionFor(root:string,reader:Principal,composition?:string|null):Promise<CompositionView|null>{
    if(composition){const body=await this.#context.store.composition(composition);return body?.root===root&&await this.#allowed(body.product,reader)?new CompositionView(this.#context.store,composition,body):null;}
    const productions=await this.#context.store.productionsOfRoot(root),selected=new Map<string,CompositionView>();
    const seen=new Set<string>();
    for(const p of productions){const key=p.detail.product+'/'+p.detail.build.line;if(seen.has(key)||!await this.#allowed(p.detail.product,reader))continue;seen.add(key);const info=await this.#builds.currentRoot(p.detail.product,p.detail.build.line);if(info?.root!==root)continue;const body=await this.#context.store.composition(info.composition);if(body)selected.set(info.composition,new CompositionView(this.#context.store,info.composition,body));}
    if(selected.size!==1)return null;return [...selected.values()][0];
  }
  async #allowed(product:string,reader:Principal):Promise<boolean>{
    const user=await this.#context.records.principals.get(reader.id);if(!user||user.disabled)return false;
    return user.role==='admin'||(await this.#context.packs.readableProducts(reader)).has(product);
  }
  async runLock(run:string,reader:Principal):Promise<{found:boolean;root:string|null;composition:string|null}>{
    if(!RunId.safeParse(run).success)throw new Error('运行编号写法不对');
    // Record ids are storage ids; the run writer publishes its logical ids through this index.
    const page=await this.#context.records.store.find({key:'runs.id',value:run,kind:'run',limit:1});
    const record=page.items[0];if(!record)return {found:false,root:null,composition:null};
    const user=await this.#context.records.principals.get(reader.id),parsed=RunRecord.safeParse(record.body);
    if(record.schema!=='run@1'||!parsed.success||parsed.data.run!==run||!user||user.disabled||user.role!=='admin'&&parsed.data.runner!==user.id&&parsed.data.configurer!==user.id)throw new Error('运行记录不存在或不可读');
    const body=parsed.data,candidates=body.target_basis.flatMap(claim=>{
      const data=claim.statement.data;
      return data?.field==='build'&&data.root===body.root&&Sha256.safeParse(data.composition).success&&claim.validity.bound.includes(String(data.composition))?[String(data.composition)]:[];
    });
    return {found:true,root:body.root??null,composition:new Set(candidates).size===1?candidates[0]:null};
  }
  async facts(composition:CompositionView):Promise<RelationFacts>{
    const cached=this.#cache.get(composition.record);if(cached)return cached;
    if(composition.body.links===undefined)throw new Error('这份组成没有链接声明；下一步是重新生产这条线');
    const nodes=new Map<string,Set<string>>(),sources:LiteralSource[]=[],contents=new Map<string,EntryContent>();
    for await(const row of composition.contentRows(undefined))contents.set(row.entry,row.content);
    // Reachability comes from the node graph; a row alone never invents a target.
    const visit=async(digest:string,names:string[]):Promise<void>=>{
      const node=await this.#context.store.node(digest);if(!node)throw new Error('组成引用的树节点缺失，需要修复存储后重读');
      const kinds=new Set<string>();
      for(const id of node.entries){const entry=contents.get(id)??await this.#context.store.entry(id);if(!entry)throw new Error('树条目缺失，需要修复存储后重读');kinds.add(entry.kind);sources.push({path:pathOf(names),entry:id,content:entry});}
      nodes.set(pathOf(names),kinds);
      for(const child of node.children)await visit(child.digest,[...names,child.name]);
    };
    await visit(composition.body.root,[]);
    for await(const row of composition.unplacedRows()){const content=contents.get(row.entry)??await this.#context.store.entry(row.entry);if(!content)throw new Error('未归位条目缺失，需要修复存储后重读');sources.push({path:'/',entry:row.entry,content,unplaced:true});}
    const result=relationFacts(composition.body.root,composition.body.links,nodes,sources);
    this.#cache.set(composition.record,result,canonicalBytes(result).byteLength);return result;
  }
  async page(composition:CompositionView,request:LinkRequest={}):Promise<LinksView>{
    const prefix=request.prefix??'/',target=request.target??null,rule=request.rule??null;
    pathSegments(prefix);if(target!==null)pathSegments(target);
    const common={schema:'links-view@1' as const,product:composition.body.product,build:{build:composition.body.version.build,root:composition.body.root},composition:composition.record,prefix,target,rule};
    if(composition.body.links===undefined)return {...common,configured:false,links:[],drift:[],totals:null,next:null,truncated:false,notes:['这份组成没有链接声明；下一步是重新生产这条线']};
    if(rule!==null&&!composition.body.links.some(declaration=>declaration.id===rule))throw new Error('这份组成没有请求的链接声明，请按声明编号重读');
    const facts=await this.facts(composition),links=facts.links.filter(edge=>beneath(edge.path,prefix)&&(target===null||edge.target===target)&&(rule===null||edge.rule===rule));
    const drift=facts.drift.filter(g=>(target===null||g.attempted_path===target)&&(rule===null||g.rule===rule)).map(g=>({...g,occurrences:g.occurrences.filter(o=>beneath(o.path,prefix))})).filter(g=>g.occurrences.length).map(g=>({...g,total:g.occurrences.length}));
    const references=new Set([...links.map(l=>l.reference),...drift.flatMap(g=>g.occurrences.map(o=>o.reference))]);
    const totals={entries:references.size,literals:links.length+drift.reduce((n,g)=>n+g.total,0),links:links.length,drift_literals:drift.length,drift_occurrences:drift.reduce((n,g)=>n+g.total,0)};
    const key=sha256Hex(canonicalBytes([composition.record,prefix,target,rule])),limit=request.limit??100;
    if(!Number.isInteger(limit)||limit<1||limit>200)throw new Error('链接视图每页要取 1 到 200 项');
    let offset=0;
    if(request.cursor){try{const c=JSON.parse(Buffer.from(request.cursor,'base64url').toString('utf8'));if(c.q!==key||!Number.isSafeInteger(c.o)||c.o<0)throw new Error();offset=c.o;}catch{throw new Error('链接视图游标不属于这份组成和请求，请重读首页');}}
    const flat=[...links.map(edge=>({edge,group:null,occurrence:null})),...drift.flatMap(group=>group.occurrences.map(occurrence=>({edge:null,group,occurrence})))];
    if(offset>0&&offset>=flat.length)throw new Error('链接视图游标超出这份组成的结果');
    const output:LinksView={...common,configured:true,links:[],drift:[],totals,next:null,truncated:offset>0,notes:[]};
    const picked=new Map<string,LinkDrift>();let at=offset;
    for(;at<flat.length&&at-offset<limit;at++){
      const item=flat[at];
      if(item.edge)output.links.push(item.edge);
      else if(item.group&&item.occurrence){const key=canonicalize([item.group.rule,item.group.literal]),g=picked.get(key)??{...item.group,occurrences:[]};g.occurrences.push(item.occurrence);picked.set(key,g);output.drift=[...picked.values()];}
      if(canonicalBytes(output).byteLength>this.#context.limits.maxViewBytes-4096){
        if(at===offset)throw new Error('单条链接视图记录超过字节上限，请提高读取上限后重读');
        if(item.edge)output.links.pop();else if(item.group){const g=picked.get(canonicalize([item.group.rule,item.group.literal]))!;g.occurrences.pop();output.drift=[...picked.values()].filter(g=>g.occurrences.length);}
        break;
      }
    }
    if(at<flat.length){output.next=Buffer.from(JSON.stringify({q:key,o:at,c:composition.record})).toString('base64url');output.truncated=true;}
    return output;
  }
  async backlinks(root:string,path:string,reader:Principal,composition?:string|null):Promise<Backlinks|undefined>{
    const view=composition===null?null:await this.compositionFor(root,reader,composition);
    if(!view){const records=await this.#context.store.productionsOfRoot(root);for(const record of records){const body=await this.#context.store.composition(record.detail.composition as string);if(body?.links!==undefined&&await this.#allowed(body.product,reader))return {composition:null,configured:false,total:null,entries:[],truncated:false,notes:['这次读没有选定唯一组成；请给出运行，或先生成并移动这条线的指针']};}return undefined;}
    if(view.body.links===undefined)return composition?{composition:view.record,configured:false,total:null,entries:[],truncated:false,notes:['这份组成没有链接声明；下一步是重新生产这条线']}:undefined;
    const facts=await this.facts(view),unique=new Map<string,LinkEdge>();
    for(const edge of facts.links)if(edge.target===path)unique.set(edge.reference,edge);
    const all=[...unique.values()].sort((a,b)=>compareText(a.reference,b.reference));
    return {composition:view.record,configured:true,total:all.length,entries:all.slice(0,20).map(({reference,path,summary})=>({reference,path,summary})),truncated:all.length>20,notes:all.length>20?['还有未列出的反向引用；按此组成读取反向视图继续翻页']:[]};
  }
}

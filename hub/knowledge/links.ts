// Declarative literal relations over immutable tree content, with interpretation pinned to a composition.
import { LINK_MATCH,REASON } from '../../contracts/generated/vocabulary.ts';
import { LinkDeclaration, type LinkDeclaration as Rule } from '../../contracts/src/product.ts';
import type { Backlinks, LinkEdge, LinkDrift, LinksView,LinkDiagnostic } from '../../contracts/src/views.ts';
import { RunRecord } from '../../contracts/src/run.ts';
import { RunId, Sha256 } from '../../contracts/src/common.ts';
import { canonicalBytes, canonicalize, sha256Hex, type Principal } from '../records/api.ts';
import { pathOf, pathSegments, treeReference } from '../refs/api.ts';
import { CompositionView } from './composition.ts';
import { compareText, cutText, type EntryContent } from './digest.ts';
import type { KnowledgeContext } from './context.ts';
import type { Builds } from './builds.ts';
import { Lru } from './store.ts';

export interface LiteralSource { path: string; entry: string; content: EntryContent; unplaced?: boolean;producers?:readonly string[] }
export type RelationNode=ReadonlySet<string>&{producersByKind?:ReadonlyMap<string,ReadonlySet<string>>};
export type RelationNodes=ReadonlyMap<string,RelationNode>;
export function relationNode(entries:readonly {kind:string;producers:readonly string[]}[]):RelationNode {
  const producersByKind=new Map<string,Set<string>>();
  for(const entry of entries){const ids=producersByKind.get(entry.kind)??new Set<string>();for(const id of entry.producers)ids.add(id);producersByKind.set(entry.kind,ids);}
  return Object.assign(new Set(entries.map(entry=>entry.kind)),{producersByKind});
}

export interface RelationFacts { links: LinkEdge[]; drift: LinkDrift[]; entries: number; literals: number;diagnostics:LinkDiagnostic[] }
export interface LinkRequest { prefix?: string; target?: string | null; rule?: string | null; cursor?: string | null; limit?: number }
const summaryOf=(text:string)=>cutText(text.replace(/\s+/gu,' ').trim(),160);
const beneath=(path:string,prefix:string)=>prefix==='/'||path===prefix||path.startsWith(prefix+'/');
const rulesOf=(value:unknown):Rule[]=>{
  const rules=LinkDeclaration.array().max(32).parse(value);
  if(new Set(rules.map(r=>r.id)).size!==rules.length)throw new Error('链接声明编号重复');
  return rules;
};
function normalizedWord(rule:Rule,value:string):string {
  if(rule.normalize?.strip_nul)value=value.replaceAll('\0','');
  if(rule.normalize?.nfkc)value=value.normalize('NFKC');else if(rule.normalize?.nfc)value=value.normalize('NFC');
  return rule.normalize?.lowercase?value.toLowerCase():value;
}
function wordsOf(rule:Rule,literal:string):{original:string[];words:string[]}{
  const text=rule.normalize?.strip_nul?literal.replaceAll('\0',''):literal;
  const original=text.trim()?text.trim().split(/\s+/u):[];
  return {original,words:original.map(word=>normalizedWord(rule,word))};
}
function resolverOf(rule:Rule,nodes:RelationNodes){
  const index=new Map<string,Array<{path:string;kinds:RelationNode}>>();
  for(const [path,kinds] of [...nodes].sort(([a],[b])=>compareText(a,b))){
    const folded=pathOf(pathSegments(path).map(word=>normalizedWord(rule,word))),choices=index.get(folded)??[];
    choices.push({path,kinds});index.set(folded,choices);
  }
  return (literal:string):{target:string|null;attempted_path:string|null;stopped_at:string;remainder:string[]}=>{
    const {original,words}=wordsOf(rule,literal),base=pathSegments(rule.namespace).map(word=>normalizedWord(rule,word)),segments:string[]=[];
    let stopped='/',best:string|null=null,bestWords=0,attempted:string|null=null;
    try{attempted=pathOf([...base,...words]);}catch{}
    for(const part of base){segments.push(part);const choices=index.get(pathOf(segments));if(!choices)return {target:null,attempted_path:attempted,stopped_at:stopped,remainder:original};stopped=choices[0].path;}
    for(let i=0;i<words.length;i++){
      segments.push(words[i]);let path:string;try{path=pathOf(segments);}catch{break;}
      const choices=index.get(path);if(!choices)break;stopped=choices[0].path;
      const eligible=choices.find(node=>{
        if(rule.entry_kind!==undefined&&!node.kinds.has(rule.entry_kind))return false;
        return rule.target_producers===undefined||[...node.kinds].some(kind=>(rule.entry_kind===undefined||kind===rule.entry_kind)&&rule.target_producers!.some(producer=>node.kinds.producersByKind?.get(kind)?.has(producer)));
      });
      if(eligible){best=eligible.path;bestWords=i+1;}
    }
    if(words.length===0||rule.match===LINK_MATCH[0]&&bestWords!==words.length)best=null;
    return {target:best,attempted_path:attempted,stopped_at:stopped,remainder:best===null?original:original.slice(bestWords)};
  };
}
export function resolveLiteral(rule:Rule,literal:string,nodes:RelationNodes){return resolverOf(rule,nodes)(literal);}
/** The very same evaluator is used by production diagnostics and by read-time views. */
export function relationFacts(root:string,declarations:readonly Rule[],nodes:RelationNodes,sources:readonly LiteralSource[]):RelationFacts {
  const rules=rulesOf(declarations),links:LinkEdge[]=[],groups=new Map<string,LinkDrift>(),entries=new Set<string>(),diagnostics:LinkDiagnostic[]=[];let literals=0;
  const resolvers=new Map(rules.map(rule=>[rule.id,resolverOf(rule,nodes)]));
  for(const source of new Map(sources.map(s=>[s.path+'\0'+s.entry,s])).values())for(const rule of rules){
    if(rule.source_producers!==undefined&&!rule.source_producers.some(producer=>source.producers?.includes(producer)))continue;
    if(!Object.hasOwn(source.content.data,rule.field))continue;
    const raw=source.content.data[rule.field];
    const reference=source.unplaced?'entry:'+source.entry:treeReference(root,source.path,source.entry),occurrence={reference,path:source.path,summary:summaryOf(source.content.statement)};
    const values=typeof raw==='string'?[raw]:Array.isArray(raw)&&raw.every(value=>typeof value==='string')?raw:null;
    if(values===null){
      entries.add(reference);
      diagnostics.push({...occurrence,rule:rule.id,reason:REASON.find(reason=>reason==='no_check')!,message:'字面字段 '+rule.field+' 不符合声明的文字或文字列表形状',next_action:'修正生产器的 '+rule.field+' 输出，重新生产这条线后重读'});
      continue;
    }
    for(const literal of new Set(values)){
      literals++;entries.add(reference);const match=resolvers.get(rule.id)!(literal);
      if(match.target!==null)links.push({...occurrence,rule:rule.id,literal,target:match.target,remainder:match.remainder});
      else {
        const normalized=wordsOf(rule,literal).words.join(' '),key=canonicalize([rule.id,normalized]);
        const group=groups.get(key)??{rule:rule.id,literal:normalized,spellings:[],attempted_path:match.attempted_path,stopped_at:match.stopped_at,total:0,occurrences:[]};
        group.spellings=[...new Set([...(group.spellings??[]),literal])].sort(compareText);
        group.total++;group.occurrences.push(occurrence);groups.set(key,group);
      }
    }
  }
  links.sort((a,b)=>compareText(a.rule,b.rule)||compareText(a.literal,b.literal)||compareText(a.reference,b.reference));
  const drift=[...groups.values()].sort((a,b)=>compareText(a.rule,b.rule)||compareText(a.literal,b.literal));
  for(const group of drift)group.occurrences.sort((a,b)=>compareText(a.reference,b.reference));
  diagnostics.sort((a,b)=>compareText(a.rule,b.rule)||compareText(a.reference,b.reference));
  return {links,drift,entries:entries.size,literals,diagnostics};
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
    if(composition.body.links===undefined)throw new Error('这份组成没有链接声明快照；下一步：重新生产这条线，并用新组成读取');
    if(composition.body.links.length===0)return {links:[],drift:[],diagnostics:[],entries:0,literals:0};
    const nodes=new Map<string,RelationNode>(),sources:LiteralSource[]=[],contents=new Map<string,EntryContent>(),owners=new Map<string,readonly string[]>();
    for await(const row of composition.contentRows(undefined)){contents.set(row.entry,row.content);owners.set(row.path+"\0"+row.entry,row.producers);}
    // Reachability comes from the node graph; a row alone never invents a target.
    const visit=async(digest:string,names:string[]):Promise<void>=>{
      const node=await this.#context.store.node(digest);if(!node)throw new Error('组成引用的树节点缺失，需要修复存储后重读');
      const kinds:Array<{kind:string;producers:readonly string[]}>=[];
      for(const id of node.entries){const entry=contents.get(id)??await this.#context.store.entry(id);if(!entry)throw new Error('树条目缺失，需要修复存储后重读');const producers=owners.get(pathOf(names)+"\0"+id)??[];kinds.push({kind:entry.kind,producers});sources.push({path:pathOf(names),entry:id,content:entry,producers});}
      nodes.set(pathOf(names),relationNode(kinds));
      for(const child of node.children)await visit(child.digest,[...names,child.name]);
    };
    await visit(composition.body.root,[]);
    for await(const row of composition.unplacedRows()){const content=contents.get(row.entry)??await this.#context.store.entry(row.entry);if(!content)throw new Error('未归位条目缺失，需要修复存储后重读');sources.push({path:'/',entry:row.entry,content,unplaced:true,producers:row.producers});}
    const result=relationFacts(composition.body.root,composition.body.links,nodes,sources);
    this.#cache.set(composition.record,result,canonicalBytes(result).byteLength);return result;
  }
  async page(composition:CompositionView,request:LinkRequest={}):Promise<LinksView>{
    const prefix=request.prefix??'/',target=request.target??null,rule=request.rule??null;
    pathSegments(prefix);if(target!==null)pathSegments(target);
    const common={schema:'links-view@1' as const,product:composition.body.product,build:{build:composition.body.version.build,root:composition.body.root},composition:composition.record,prefix,target,rule};
    if(composition.body.links===undefined)return {...common,configured:false,links:[],drift:[],totals:null,next:null,truncated:false,notes:['这份组成没有链接声明快照；下一步：重新生产这条线，并用新组成读取']};
    if(rule!==null&&!composition.body.links.some(declaration=>declaration.id===rule))throw new Error('这份组成没有请求的链接声明，请按声明编号重读');
    const facts=await this.facts(composition),links=facts.links.filter(edge=>beneath(edge.path,prefix)&&(target===null||edge.target===target)&&(rule===null||edge.rule===rule));
    const drift=facts.drift.filter(g=>(target===null||g.attempted_path===target)&&(rule===null||g.rule===rule)).map(g=>({...g,occurrences:g.occurrences.filter(o=>beneath(o.path,prefix))})).filter(g=>g.occurrences.length).map(g=>({...g,total:g.occurrences.length}));
    const diagnostics=facts.diagnostics.filter(diagnostic=>beneath(diagnostic.path,prefix)&&(rule===null||diagnostic.rule===rule));
    const references=new Set([...links.map(l=>l.reference),...drift.flatMap(g=>g.occurrences.map(o=>o.reference)),...diagnostics.map(d=>d.reference)]);
    const totals={entries:references.size,literals:links.length+drift.reduce((n,g)=>n+g.total,0),links:links.length,drift_literals:drift.length,drift_occurrences:drift.reduce((n,g)=>n+g.total,0),...(diagnostics.length?{diagnosed_entries:new Set(diagnostics.map(d=>d.reference)).size}:{})};
    const key=sha256Hex(canonicalBytes([composition.record,prefix,target,rule])),limit=request.limit??100;
    if(!Number.isInteger(limit)||limit<1||limit>200)throw new Error('链接视图每页要取 1 到 200 项');
    let offset=0;
    if(request.cursor){try{const c=JSON.parse(Buffer.from(request.cursor,'base64url').toString('utf8'));if(c.q!==key||!Number.isSafeInteger(c.o)||c.o<0)throw new Error();offset=c.o;}catch{throw new Error('链接视图游标不属于这份组成和请求，请重读首页');}}
    const flat=[...links.map(edge=>({edge,group:null,occurrence:null,diagnostic:null})),...drift.flatMap(group=>group.occurrences.map(occurrence=>({edge:null,group,occurrence,diagnostic:null}))),...diagnostics.map(diagnostic=>({edge:null,group:null,occurrence:null,diagnostic}))];
    if(offset>0&&offset>=flat.length)throw new Error('链接视图游标超出这份组成的结果');
    const output:LinksView={...common,configured:true,links:[],drift:[],totals,next:null,truncated:offset>0,notes:diagnostics.length?["有 "+diagnostics.length+" 条字面字段不合形状；关联计数只覆盖可解析字面，请修正生产器并重新生产后重读"]:[],...(diagnostics.length?{diagnostics:[]}:{} )};
    const picked=new Map<string,LinkDrift>();let at=offset;
    for(;at<flat.length&&at-offset<limit;at++){
      const item=flat[at];
      if(item.diagnostic)output.diagnostics!.push(item.diagnostic);
      else if(item.edge)output.links.push(item.edge);
      else if(item.group&&item.occurrence){const key=canonicalize([item.group.rule,item.group.literal]),g=picked.get(key)??{...item.group,occurrences:[]};g.occurrences.push(item.occurrence);picked.set(key,g);output.drift=[...picked.values()];}
      if(canonicalBytes(output).byteLength>this.#context.limits.maxViewBytes-4096){
        if(at===offset)throw new Error('单条链接视图记录超过字节上限，请提高读取上限后重读');
        if(item.diagnostic)output.diagnostics!.pop();else if(item.edge)output.links.pop();else if(item.group){const g=picked.get(canonicalize([item.group.rule,item.group.literal]))!;g.occurrences.pop();output.drift=[...picked.values()].filter(g=>g.occurrences.length);}
        break;
      }
    }
    if(at<flat.length){output.next=Buffer.from(JSON.stringify({q:key,o:at,c:composition.record})).toString('base64url');output.truncated=true;}
    return output;
  }
  async backlinks(root:string,path:string,reader:Principal,composition?:string|null):Promise<Backlinks|undefined>{
    const absent=(record:string|null,note:string):Backlinks=>({composition:record,configured:false,total:null,entries:[],truncated:false,notes:[note]});
    if(composition===null)return absent(null,'这个运行没有锁定组成快照；下一步：以同样的输入新开运行，锁定组成后再读关联');
    const view=await this.compositionFor(root,reader,composition);
    if(!view){
      const candidates:CompositionView[]=[];
      for(const production of await this.#context.store.productionsOfRoot(root)){
        const record=String(production.detail.composition),body=await this.#context.store.composition(record);
        if(body&&body.links?.length!==0&&await this.#allowed(body.product,reader))candidates.push(new CompositionView(this.#context.store,record,body));
      }
      candidates.sort((a,b)=>compareText(a.record,b.record));
      const candidate=candidates[0];if(!candidate)return undefined;
      const id='knowledge:links:'+encodeURIComponent(candidate.body.product)+':'+encodeURIComponent(candidate.body.version.line)+'?target='+encodeURIComponent(path)+'&composition='+candidate.record;
      return absent(null,'这个历史根没有选定唯一组成；下一步：按明确的组成读取关联视图 '+id);
    }
    if(view.body.links===undefined)return absent(view.record,'这份组成没有链接声明快照；下一步：重新生产这条线，并用新组成读取');
    if(view.body.links.length===0||!view.body.links.some(rule=>beneath(pathOf(pathSegments(path).map(word=>normalizedWord(rule,word))),pathOf(pathSegments(rule.namespace).map(word=>normalizedWord(rule,word))))))return undefined;
    const facts=await this.facts(view),unique=new Map<string,LinkEdge>();
    for(const edge of facts.links)if(edge.target===path)unique.set(edge.reference,edge);
    const all=[...unique.values()].sort((a,b)=>compareText(a.reference,b.reference));
    return {composition:view.record,configured:true,total:all.length,entries:all.slice(0,20).map(({reference,path,summary})=>({reference,path,summary})),truncated:all.length>20,notes:all.length>20?['还有未列出的反向引用；按此组成读取反向视图继续翻页']:[]};
  }
}

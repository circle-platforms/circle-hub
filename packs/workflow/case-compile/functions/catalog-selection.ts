// The Hub's selection of the command catalog, over the locked tree a run download holds (knowledge/nodes.jsonl).
// The Hub reads the catalog of a check by asking the check's catalog_select function for {base, lines} and following exact edges of
// the locked tree from the words of each line (hub/knowledge/catalog-selection.ts, called from builderInput of
// hub/runs/engine/evaluate.ts); the check receives the definitions at the nodes the walk passed, never the whole tree. This is the
// same walk over the saved nodes, with the same limits and the same words, so a plan is judged here on the catalog it is judged on
// there. functions/catalog-selection.test.ts runs it beside the Hub's own function on the same trees.
import {commandTokens} from './generated/skills/command-tools/command-check/grammar.ts';
import {isRecord} from './text.ts';

type Row={[key:string]:any};
/** The locked tree of one run as the Hub's run export writes it: nodes by path, each with its children and its entries. */
export interface LockedTree {root:string;complete:boolean;nodes:ReadonlyMap<string,Row>}
/** What the checks receive for a catalog: the view's entries, or why the selection could not be read. */
export type SelectedCatalog={entries:Row[]}|{missing:string};

/** The words of the Hub for a selection it cannot read (builderInput of evaluate.ts, hub/knowledge/catalog-selection.ts). */
export const SELECTION_LIMIT='目录选择必须声明路径和至多 128 条完整命令，每条至多 8192 字节；拆分计划后重核';
export const UNREADABLE_PATH='缺锁定目录的所选路径；管理员修复目录读取后原样重交，不用整棵目录代替';
const TOO_MANY_WORDS='单条命令超过 128 个语法令牌；拆分计划后重核';
const TOO_MANY_NODES='目录路径超过 4096 个节点；拆分计划后重核';
const TOO_MANY_ENTRIES='所选路径超过 512 个目录条目；拆分计划后重核';
const TOO_MANY_BYTES='所选目录超过 1 MiB；拆分计划后重核';

/**
 * The tree of a run download, from the parsed lines of its knowledge/nodes.jsonl. The head names the run and the root and counts the
 * nodes; a download of another run or root, or one that lost nodes, is no tree of this run and comes back as the problem.
 */
export function lockedTree(rows:readonly unknown[],run:{run:unknown;root:string}):LockedTree|string{
 const [head,...nodes]=rows;
 if(!isRecord(head)||head.schema!=='run-knowledge@1'||head.run!==run.run||head.root!==run.root||head.nodes!==nodes.length)return '命令树下载与冻结运行或节点计数不一致';
 const byPath=new Map<string,Row>();
 for(const node of nodes){
  if(!isRecord(node)||typeof node.path!=='string'||!Array.isArray(node.children)||!Array.isArray(node.entries))return '命令树下载里有不合式的节点';
  byPath.set(node.path,node);
 }
 // The download carries no declaration of whether the product's catalog is complete: the Hub's own answer is not known here.
 return {root:run.root,complete:false,nodes:byPath};
}

/**
 * Whether a definition is a member of the product's command catalog. The Hub takes the members from the producer the product
 * names; a download carries no producer, and a definition written from the manual has the words but no overload list, so the
 * list is what tells the command tree's definitions apart.
 */
const member=(row:Row):boolean=>row.kind==='definition'&&isRecord(row.data)&&Array.isArray(row.data.signatures);
/** The catalog entry of a member: the head words, the overloads and the reference to cite; null when it is not catalog data. */
function catalogEntry(row:Row):{words:string[];signatures:Row[];reference:string}|null{
 const {words,signatures}=row.data;
 if(typeof row.reference!=='string'||!Array.isArray(words)||words.length===0||words.some(word=>typeof word!=='string'||word.length===0))return null;
 return {words,signatures,reference:row.reference};
}

/**
 * The entries the Hub hands a check whose catalog_select answered `selection`: the walk of hub/knowledge/catalog-selection.ts over
 * the saved nodes. Only exact edges are followed from the complete words of each line (a quoted word ends the walk), only the
 * definitions at the nodes passed are taken, and a selection over a limit is refused with the Hub's words, never trimmed:
 * 128 lines of at most 8192 bytes, 128 words in a line, 4096 nodes, 512 entries and 1 MiB of entries. The view merges the
 * overloads of one head into one entry and lists the heads in order.
 */
export function selectedCatalog(tree:LockedTree,selection:unknown):SelectedCatalog{
 if(!isRecord(selection)||typeof selection.base!=='string'||!Array.isArray(selection.lines)||selection.lines.length>128||selection.lines.some(line=>typeof line!=='string'||Buffer.byteLength(line)>8192))return {missing:SELECTION_LIMIT};
 const start=tree.nodes.get(selection.base),visited=new Set<string>(),passed=new Set<string>();
 for(const line of new Set(selection.lines as string[])){
  const tokens=commandTokens(line);if(!tokens)continue;
  if(tokens.length>128)return {missing:TOO_MANY_WORDS};
  let current=start;
  for(const token of tokens){
   if(!current||token.quoted)break;
   const edge=(current.children as Row[]).find(child=>child.name===token.value);if(!edge)break;
   const identity=typeof edge.digest==='string'?edge.digest:String(edge.path);
   if(!visited.has(identity)){
    if(visited.size>=4096)return {missing:TOO_MANY_NODES};
    visited.add(identity);
   }
   const next=tree.nodes.get(edge.path);if(next===undefined)return {missing:UNREADABLE_PATH};
   current=next;
   if((next.entries as Row[]).length)passed.add(next.path);
  }
 }
 const selected=new Map<string,NonNullable<ReturnType<typeof catalogEntry>>>();
 let bytes=0;
 for(const path of passed){
  const kept=(tree.nodes.get(path)!.entries as Row[]).filter(member);
  if(selected.size+kept.length>512)return {missing:TOO_MANY_ENTRIES};
  for(const row of kept){
   const entry=catalogEntry(row);if(entry===null)continue;
   bytes+=Buffer.byteLength(JSON.stringify(entry));if(bytes>1024*1024)return {missing:TOO_MANY_BYTES};
   selected.set(path+'@'+row.entry,entry);
  }
 }
 const merged=new Map<string,Row>();
 for(const entry of selected.values()){
  const words=entry.words.map(word=>word.normalize('NFC')),key=words.join('\0'),same=merged.get(key);
  if(same)same.signatures.push(...entry.signatures);
  else merged.set(key,{...entry,words,signatures:[...entry.signatures]});
 }
 const head=(entry:Row)=>(entry.words as string[]).join(' ');
 return {entries:[...merged.values()].sort((a,b)=>head(a)<head(b)?-1:head(a)>head(b)?1:0)};
}

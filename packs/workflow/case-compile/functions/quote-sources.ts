import {quoteMatches} from './quote.ts';
import {ENTRY_HEADING,nodeLines,type EntryText} from './knowledge-text.ts';
import type {LockedTree} from './catalog-selection.ts';
import {LISTED_LIMIT,PLAN_DATA,refusalText} from './refusal-form.ts';
import {isRecord,type Outcome} from './text.ts';
import type {QuotePlace} from './subject.ts';
import type {FragmentRead} from '../../../../contracts/generated/vocabulary.ts';

type Row={[key:string]:any};
export const QUOTE_MISMATCH='QUOTE_MISMATCH';
export const QUOTE_MISMATCH_WHEN='原文与引用对不上（T03 整份不受理之一）';
const MAX_FRAGMENT_BYTES=1024*1024;

const MAX_REFERENCE_LENGTH=8192;
const MAX_SEGMENTS=256;
const NEVER_RAW_BMP='\\u0000-\\u0020\\u007F-\\u00A0\\u00AD\\u0600-\\u0605\\u061C\\u06DD\\u070F\\u0890-\\u0891\\u08E2\\u1680\\u180E\\u2000-\\u200F\\u2028-\\u202F\\u205F-\\u2064\\u2066-\\u206F\\u3000\\uFEFF\\uFFF9-\\uFFFB';
const NEVER_RAW=/[\p{Cc}\p{Cf}\p{Z}\uD800-\uDFFF]/u;
const charOf=(structural:string):string=>`(?:[^%${structural}${NEVER_RAW_BMP}]|%[0-9A-F]{2})`;
const HEX64='[0-9a-f]{64}';
const DIGEST=new RegExp(`^${HEX64}$`);
const SELECTOR=`${charOf('/:')}+(?:/${charOf('/:')}+)*`;
const PATH=`/(?:${charOf('/@')}+(?:/${charOf('/@')}+)*)?`;
const POINTER=`(?:/(?:[^%~/#${NEVER_RAW_BMP}]|%[0-9A-F]{2}|~[01])*)+`;
const PARSER='[a-z][a-z0-9_.-]{0,63}@(?:0|[1-9][0-9]{0,8})',DECIMAL='(?:0|[1-9][0-9]{0,15})';
const URI=new RegExp(`^(?:src:${HEX64}(?:/${PARSER}/${SELECTOR}(?::${DECIMAL}-${DECIMAL})?)?|tree:${HEX64}${PATH}(?:@${HEX64})?|entry:${HEX64}|rec:${HEX64}(?:#${POINTER})?)$`);
export function isReferenceUri(value:unknown):value is string{
 if(typeof value!=='string'||value.length>MAX_REFERENCE_LENGTH||!URI.test(value)||NEVER_RAW.test(value))return false;
 const range=/^src:[0-9a-f]{64}\/[^:]*:([0-9]{1,16})-([0-9]{1,16})$/.exec(value);
 return !range||BigInt(range[1]!)<BigInt(range[2]!);
}
const ENCODER=new TextEncoder(),STRICT_UTF8=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});
const mustEscape=(character:string):boolean=>/^[%\p{Cc}\p{Cf}\p{Z}]$/u.test(character)||character==='/'||character==='@';
function segmentOf(text:string):string|null{
 let out='';
 for(let at=0;at<text.length;){
  if(text.charCodeAt(at)!==0x25){const character=String.fromCodePoint(text.codePointAt(at)!);out+=character;at+=character.length;continue;}
  const bytes:number[]=[];
  while(at<text.length&&text.charCodeAt(at)===0x25){const pair=text.slice(at+1,at+3);if(!/^[0-9A-F]{2}$/.test(pair))return null;bytes.push(Number.parseInt(pair,16));at+=3;}
  try{out+=STRICT_UTF8.decode(Uint8Array.from(bytes));}catch{return null;}
 }
 return out;
}
function escaped(value:string):string|null{
 let out='';
 for(const character of value){
  const code=character.codePointAt(0)!;
  if(code>=0xd800&&code<=0xdfff)return null;
  if(mustEscape(character))for(const byte of ENCODER.encode(character))out+='%'+byte.toString(16).toUpperCase().padStart(2,'0');else out+=character;
 }
 return out;
}
export interface TreeAddress {root:string;path:string;entry:string|null}
export function treeAddress(reference:string):TreeAddress|null{
 if(!reference.startsWith('tree:')||reference.length>MAX_REFERENCE_LENGTH)return null;
 const root=reference.slice(5,69),tail=reference.slice(69);
 if(!DIGEST.test(root)||!tail.startsWith('/'))return null;
 const at=tail.indexOf('@'),path=at<0?tail:tail.slice(0,at);
 if(path!=='/'){
  if(path.endsWith('/'))return null;
  const parts=path.slice(1).split('/');
  if(parts.length>MAX_SEGMENTS)return null;
  for(const part of parts){const decoded=part===''?null:segmentOf(part);if(decoded===null||escaped(decoded)!==part)return null;}
 }
 if(at<0)return {root,path,entry:null};
 const entry=tail.slice(at+1);
 return DIGEST.test(entry)?{root,path,entry}:null;
}

export function frozenSourceTexts(run:Record<string,unknown>):Map<string,string>{
 const texts=new Map<string,string>();
 for(const item of Array.isArray(run.items)?run.items:[]){
  const fields=isRecord(item)&&isRecord(item.fields)?item.fields:{};
  for(const node of Array.isArray(fields.expected_nodes)?fields.expected_nodes:[])if(isRecord(node)&&typeof node.reference==='string'){
   if(typeof node.text==='string')texts.set(node.reference,node.text);
   if(node.declaration!==undefined)texts.set(node.reference+'/@assertion',JSON.stringify(node.declaration));
  }
  for(const atom of Array.isArray(fields.source_atoms)?fields.source_atoms:[])if(isRecord(atom)&&typeof atom.reference==='string'&&typeof atom.text==='string')texts.set(atom.reference,atom.text);
 }
 return texts;
}
export interface QuoteView {root:string|null;unversionedRoot:string|null;tree?:LockedTree;texts:ReadonlyMap<string,string>}
export function frozenQuoteView(run:Record<string,unknown>,tree?:LockedTree):QuoteView{
 return {root:typeof run.root==='string'?run.root:null,unversionedRoot:typeof run.unversioned_root==='string'?run.unversioned_root:null,...(tree!==undefined?{tree}:{}),texts:frozenSourceTexts(run)};
}
type Read={text:string}|{refusal:Refusal}|{unread:string};
function read(reference:string,view:QuoteView):Read{
 if(!isReferenceUri(reference))return {refusal:'malformed'};
 if(reference.startsWith('entry:'))return {refusal:'entry_unaddressed'};
 if(!reference.startsWith('tree:')){
  const text=view.texts.get(reference);
  return text!==undefined?{text}:{unread:'原件里这个片段（或这条记录）的原文不在冻结运行里，本地读不到'};
 }
 const address=treeAddress(reference);
 if(address===null)return {refusal:'malformed'};
 if(address.root!==view.root&&address.root!==view.unversionedRoot)return {refusal:'not_bound'};
 const tree=view.tree;
 if(tree===undefined)return {unread:'缺本次冻结根的命令树 knowledge/nodes.jsonl'};
 if(address.root!==tree.root)return {unread:'下载目录里只有本次运行锁定的根，没有这个根的树'};
 const node=tree.nodes.get(address.path);
 if(node===undefined)return {refusal:'no_fragment'};
 const entries=node.entries as Row[];
 let text:string;
 if(address.entry!==null){
  const found=entries.find(row=>row.entry===address.entry);
  if(found===undefined)return address.path==='/'?{unread:'根节点上未放置的条目不在下载里'}:{refusal:'no_fragment'};
  if(typeof found.statement!=='string')return {unread:'下载里这个条目没有原文'};
  text=found.statement;
 }else text=entries.length>0?entries.map(row=>String(row.statement)).join('\n\n'):(node.children as Row[]).map(child=>String(child.name)).join('\n');
 return Buffer.byteLength(text,'utf8')>MAX_FRAGMENT_BYTES?{refusal:'too_large'}:{text};
}

export interface EntrySpan {file:string;from:number;to:number}
function spanOf(tree:LockedTree,node:Row,entry:Row):EntrySpan|null{
 const at=tree.blocks?.().get(String(node.path));
 if(at===undefined)return null;
 const elements=nodeLines(String(node.path),(node.children as Row[]).map(child=>String(child.name)),node.entries as EntryText[]),heading=`${ENTRY_HEADING}${entry.reference}`;
 let line=at.line;
 for(const [index,element] of elements.entries()){
  const size=element.split('\n').length;
  if(element.startsWith(heading))return {file:at.file,from:line,to:line+size-1+(index+1<elements.length?elements[index+1]!.split('\n').length:0)};
  line+=size;
 }
 return null;
}
const named=(reference:string,span:EntrySpan|null):string=>span===null?reference:`${reference}（knowledge/${span.file} 第 ${span.from}${span.to>span.from?`-${span.to}`:''} 行）`;
const blank=(text:string):boolean=>!/[^\p{White_Space}]/u.test(text);

interface Holders {total:number;names:string[]}
function holders(text:string,view:QuoteView,citedPath:string|null):Holders{
 if(blank(text))return {total:0,names:[]};
 const tree=view.tree,found:Array<{reference:string;path:string}>=[];
 if(tree!==undefined)for(const [path,node] of tree.nodes)for(const entry of node.entries as Row[])if(typeof entry.statement==='string'&&typeof entry.reference==='string'&&quoteMatches(entry.statement,text))found.push({reference:entry.reference,path});
 found.sort((a,b)=>Number(b.path===citedPath)-Number(a.path===citedPath));
 const names=found.map((row,index)=>{
  if(index>=LISTED_LIMIT||tree===undefined)return row.reference;
  const node=tree.nodes.get(row.path)!,entry=(node.entries as Row[]).find(value=>value.reference===row.reference);
  return named(row.reference,entry===undefined?null:spanOf(tree,node,entry));
 });
 for(const [reference,held] of view.texts)if(!reference.endsWith('/@assertion')&&quoteMatches(held,text))names.push(reference);
 return {total:names.length,names};
}

const quoted=(value:string):string=>{const characters=[...value];return `“${characters.length>80?`${characters.slice(0,80).join('')}…`:value}”`;};
const hubWords=(detail:string):string=>`${QUOTE_MISMATCH_WHEN}：${detail}`;
const REFUSAL_WORDS={
 malformed:()=>'引用写法不对，请使用 src:<摘要>、tree:<根>/<路径>@<条目> 或 rec:<记录>#/<字段>',
 not_bound:reference=>`引用 ${reference} 的源文件不是这次运行的输入，请改引本运行已绑定的输入（src:<摘要> 或 tree:<锁定根>/<路径>@<条目>）`,
 entry_unaddressed:()=>'知识条目不能单独作根据（B01 R[5]），请改写为 tree:<根>/<路径>@<条目>',
 no_fragment:reference=>`引用 ${reference} 的片段不存在`,
 too_large:reference=>`引用 ${reference} 的片段超过大小上限，请改引更小的片段`,
} as const satisfies Partial<Record<FragmentRead,(reference:string)=>string>>;
export type Refusal=keyof typeof REFUSAL_WORDS;
const COPY_REFERENCE='reference 照抄 knowledge/manual.txt 或 commands.txt 里条目标题行「· 引用 」后面的那一串，不自己拼写，路径里的空格写成 %20';
const NOWHERE='这份下载里没有一处逐字含这句话（知识树的条目和冻结条目的原文都找过）；引文必须逐字取自冻结知识（knowledge/manual.txt、commands.txt）里的原文，照抄那一句，不改写、不拼接、不加省略号；这句话找不到出处，就换一句找得到的原文作引文';
function nextStep(kind:Refusal|'mismatch',text:string,held:Holders,view:QuoteView):string{
 const there=held.total===1?`这句原文在 ${held.names[0]}；把 reference 改成它`:held.total>1?`这句原文在上面允许的 ${held.total} 处；把 reference 改成其中一处（引用同一节点的排在前面）`:null;
 switch(kind){
  case 'mismatch':return blank(text)?'引文不能为空或只有空白：逐字复制知识里的一句原文，不改写、不拼接':there??NOWHERE;
  case 'malformed':return `${COPY_REFERENCE}；${there??NOWHERE}`;
  case 'not_bound':return `reference 要用本运行锁定的根${view.root!==null?` ${view.root}`:''}下的引用；${there??NOWHERE}`;
  case 'entry_unaddressed':return `entry: 引用不能单独作根据，写成 tree:<根>/<路径>@<条目>；${there??NOWHERE}`;
  case 'no_fragment':return `这个引用在冻结知识里没有对应的片段；${there??NOWHERE}`;
  case 'too_large':return `改引更小的片段；${there??NOWHERE}`;
 }
}

export interface QuoteVerdicts {outcomes:Outcome[];unread:Array<{place:string;reference:string;why:string;frozen?:true}>}
export function quoteVerdicts(item:string,places:readonly QuotePlace[],view:QuoteView):QuoteVerdicts{
 const outcomes:Outcome[]=[],unread:QuoteVerdicts['unread']=[],memo=new Map<string,Holders>();
 for(const {quote:{reference,text},place,frozen} of places){
  if(frozen===true){unread.push({place,reference,why:'冻结条目自己声明的期望节点，不是计划写的，本地没有原件解析它',frozen:true});continue;}
  const got=read(reference,view);
  if('unread' in got){unread.push({place,reference,why:got.unread});continue;}
  const base={grounds:[reference],tier:'blocking' as const,item};
  if('text' in got&&quoteMatches(got.text,text)){
   outcomes.push({verdict:'support',statement:`引文 ${quoted(text)} 与所引片段逐字一致`,...base,pointer:`/data${place}/text`,data:{quote:text,reference}});
   continue;
  }
  const kind:Refusal|'mismatch'='refusal' in got?got.refusal:'mismatch';
  const cited=treeAddress(reference),citedPath=cited!==null&&cited.root===view.root?cited.path:null,key=`${citedPath??''}\0${text}`;
  let held=memo.get(key);if(held===undefined){held=holders(text,view,citedPath);memo.set(key,held);}
  const field=kind!=='mismatch'||held.total>0?'reference':'text';
  const detail='refusal' in got?REFUSAL_WORDS[got.refusal](reference):blank(text)?'引文为空':`所引片段里没有 ${quoted(text)}`;
  outcomes.push({verdict:'refute',code:QUOTE_MISMATCH,statement:refusalText({
   what:hubWords(detail),place:`${PLAN_DATA}${place}/${field}`,
   seen:'text' in got?`引用 ${reference} 读到的是 ${quoted(got.text)}`:`reference ${reference}`,
   ...(held.total>1?{allowed:held.names}:{}),
   next:nextStep(kind,text,held,view),
  }),...base,pointer:`/data${place}/${field}`,data:{quote:text,reference,why:kind}});
 }
 return {outcomes,unread};
}

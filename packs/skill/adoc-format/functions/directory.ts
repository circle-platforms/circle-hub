// Fixed-revision SVN directory walk for AsciiDoc books, shared by the Hub core (knowledge seed) and, through a generated
// package-local copy, by product packs inside their sandbox (sync source plans and manual producers).
// Each book group is the directory that holds that book's main file. The module is self-contained: it imports nothing,
// so its generated copy runs in any pack. It knows no product: the version-line directory spelling comes from the
// product pack's declared layout, never from a product naming rule.

/** Bounds of one book group; the walk refuses instead of cutting a group. */
export const DIRECTORY_LIMITS={depth:5,directories:32,files:128,entries:512} as const;
/** Every refusal this module raises carries a code under this pack's name. */
export const ERROR_PREFIX='adoc-format.';
const DEFAULT_NEXT='核对本族 ROOT、MAIN 和同修订号 SVN 原件后重跑同步';

/** A structured refusal: `code` names the rule, `next_action` the concrete correction. The message never quotes content. */
export class DirectorySourceError extends Error{
 readonly code:string;readonly next_action:string;
 constructor(code:string,message:string,next_action:string){super(`${message}；下一步：${next_action}`);this.code=code;this.next_action=next_action;}
}
const stop=(code:string,message:string,next=DEFAULT_NEXT):never=>{throw new DirectorySourceError(ERROR_PREFIX+code,message,next);};
const isRecord=(value:unknown):value is Record<string,unknown>=>typeof value==='object'&&value!==null&&!Array.isArray(value);

export function safePath(path:string):boolean{return path.length>0&&path.length<=2000&&!/[\\\p{Cc}\p{Cf}?#;]/u.test(path)&&path.split('/').every(p=>p!==''&&p!=='.'&&p!=='..'&&p.length<=255);}

/**
 * The product pack's declared directory layout. `line_dir` spells the `{line}` placeholder's directory form: the version
 * line's decimal components without leading zeroes, padded with zero components to `components`, joined by `separator`.
 * A root that uses `{line_dir}` without this declaration is refused; nothing is guessed.
 */
export interface DirectoryLayout {line_dir?:{components:number;separator:string}}
/** The version line's syntax: one to three decimal components, at most nine digits each. */
const LINE_COMPONENTS=3;

/** A declared layout, or null when none is declared. A malformed declaration is refused. */
export function layoutOf(value:unknown):DirectoryLayout|null{
 if(value===undefined||value===null)return null;
 const bad=():never=>stop('invalid_layout','产品包声明的目录布局无效：line_dir 需要 components（1 到 3 的整数）和 separator（1 到 4 个字母、数字、点、下划线或连字符）','产品包作者改正 layout 声明并发布新版本后重跑');
 if(!isRecord(value)||Object.keys(value).some(key=>key!=='line_dir'))return bad();
 if(value.line_dir===undefined)return {};
 const dir=value.line_dir;
 if(!isRecord(dir)||Object.keys(dir).some(key=>key!=='components'&&key!=='separator'))return bad();
 if(typeof dir.components!=='number'||!Number.isInteger(dir.components)||dir.components<1||dir.components>LINE_COMPONENTS)return bad();
 if(typeof dir.separator!=='string'||!/^[A-Za-z0-9._-]{1,4}$/.test(dir.separator))return bad();
 return {line_dir:{components:dir.components,separator:dir.separator}};
}

/**
 * The relative SVN directory of a root template for a version line, or null for an explicit null root. `{line}` is the
 * line as given; `{line_dir}` is the declared layout's spelling of it.
 */
export function directoryOf(root:unknown,line:string,layout?:unknown):string|null{
 if(root===null)return null;
 if(typeof root!=='string'||!root.includes('{line}')&&!root.includes('{line_dir}'))return stop('invalid_root','ROOT 需要包含 {line} 或 {line_dir} 的相对 SVN 目录模板，或显式 null');
 const parts=line.split('.');if(parts.length<1||parts.length>LINE_COMPONENTS||parts.some(part=>!part.length||part.length>9||![...part].every(ch=>ch>='0'&&ch<='9')))return stop('invalid_line','版本线不符合点分十进制语法，不能猜目录名');
 const declared=layoutOf(layout);
 let path=root;
 if(root.includes('{line_dir}')){
  const spelling=declared?.line_dir;
  if(spelling===undefined)return stop('invalid_layout','ROOT 用了 {line_dir}，但产品包没有声明 line_dir 目录布局，不能猜目录名','产品包作者在 layout 里声明 line_dir 后发布新版本，或改用 {line}');
  if(parts.length>spelling.components)return stop('invalid_line','版本线的段数超过目录布局声明的段数，不能猜目录名');
  const canonical=parts.map(part=>part.replace(/^0+(?=\d)/,''));while(canonical.length<spelling.components)canonical.push('0');
  path=path.replaceAll('{line_dir}',canonical.join(spelling.separator));
 }
 path=path.replaceAll('{line}',line);
 if(/[{}]/.test(path)||!safePath(path))return stop('invalid_root','ROOT 展开后的目录无效，不允许绝对路径或跳出目录');
 return path;
}
export const rootId=(path:string)=>'svn:directory:'+encodeURIComponent(path);
const childId=(revision:string,path:string)=>'svn:directory-at:'+revision+'/'+encodeURIComponent(path);
const fileId=(revision:string,path:string)=>'svn:file:'+revision+'/'+encodeURIComponent(path);
export interface Member {name:string;directory:boolean;external:string|null;revision:string;size:number|null}
export interface Directory {directory:string;revision:string;members:Member[]}
function directory(value:unknown,path:string,revision?:string):Directory{
 if(!isRecord(value)||value.directory!==path||typeof value.revision!=='string'||!/^\d+$/.test(value.revision)||revision!==undefined&&value.revision!==revision||!Array.isArray(value.members))return stop('directory_identity','目录原件缺少本目录身份、固定修订号或完整成员表');
 if(value.members.length>DIRECTORY_LIMITS.entries)return stop('group_budget','目录成员超过整组条目上限，不截断');
 const seen=new Set<string>();
 for(const member of value.members){
  if(!isRecord(member)||typeof member.name!=='string'||!safePath(member.name)||member.name.includes('/')||seen.has(member.name)||typeof member.directory!=='boolean'||typeof member.revision!=='string'||!/^\d+$/.test(member.revision)||BigInt(member.revision)>BigInt(value.revision))return stop('directory_member','目录成员身份或修订号无效');
  seen.add(member.name);
  if(!member.directory&&(member.external!==fileId(value.revision,path+'/'+member.name)||!Number.isSafeInteger(member.size)||Number(member.size)<0))return stop('directory_member','文件成员缺少本批次修订号外部号或字节长度');
 }
 return value as unknown as Directory;
}
export interface DirectoryTree {root:string;revision:string;directories:Map<string,Directory>;files:Map<string,Member>;pending:string[]}
/** Traverse only explicit fixed revision metadata. No absent directory or member is silently skipped. */
export function treeOf(root:string,read:(id:string)=>unknown|undefined,pinned?:string):DirectoryTree{
 const start=pinned===undefined?rootId(root):childId(pinned,root);
 const first=read(start);
 if(first===undefined)return {root,revision:'',directories:new Map(),files:new Map(),pending:[start]};
 const firstDir=directory(first,root,pinned);
 const out:DirectoryTree={root,revision:firstDir.revision,directories:new Map(),files:new Map(),pending:[]};
 const queue=[{path:root,depth:0}];let entries=0;
 for(let at=0;at<queue.length;at++){
  const next=queue[at];if(next.depth>DIRECTORY_LIMITS.depth||queue.length>DIRECTORY_LIMITS.directories)return stop('group_budget','整组目录深度或目录数超过上限，不截断');
  const id=next.depth===0?start:childId(out.revision,next.path);
  const raw=next.depth===0?first:read(id);
  if(raw===undefined){out.pending.push(id);continue;}
  const doc=directory(raw,next.path,out.revision);out.directories.set(id,doc);
  for(const member of doc.members){
   if(++entries>DIRECTORY_LIMITS.entries)return stop('group_budget','整组条目数超过上限，不截断');
   const path=next.path+'/'+member.name;
   if(member.directory)queue.push({path,depth:next.depth+1});
   else if(member.name.endsWith('.adoc')){
    out.files.set(path.slice(root.length+1),member);
    if(out.files.size>DIRECTORY_LIMITS.files)return stop('group_budget','整组 adoc 文件数超过上限，不截断');
   }
  }
 }
 return out;
}
/** Child directory listings, then every file external, in walk order. The root listing itself is not in the file list. */
export function listedSources(root:string,tree:DirectoryTree):string[]{
 return [...tree.directories.keys()].filter(id=>id!==rootId(root)).concat([...tree.files.values()].map(member=>member.external!));
}

export interface BookMain {book:'cli'|'app';file:string}
export interface BookGroup {directory:string;relative:string;mains:BookMain[];tree:DirectoryTree}
export interface BookWalk {revision:string;groups:BookGroup[];unread:string[];pending:string[]}

/** Both main paths, or null when the caller has not named them. A named path is a relative adoc file. */
export function mainsOf(cli:unknown,app:unknown):{cli:string;app:string}|null{
 if(typeof cli!=='string'||typeof app!=='string')return null;
 if(!safePath(cli)||!cli.endsWith('.adoc')||!safePath(app)||!app.endsWith('.adoc'))return stop('missing_main','MAIN 需要是主文件所在目录下的相对 adoc 路径');
 return {cli,app};
}
const locate=(main:string):{dir:string;file:string}=>{const slash=main.lastIndexOf('/');return slash<0?{dir:'',file:main}:{dir:main.slice(0,slash),file:main.slice(slash+1)};};
const remember=(pending:string[],id:string):void=>{if(!pending.includes(id))pending.push(id);};

/**
 * One group per distinct directory that contains a main file. A main file with no parent directory makes the family
 * root that group. Sibling directories of a book are named and not opened. Each opened book uses DIRECTORY_LIMITS on its own.
 */
export function booksOf(root:string,mains:{cli:string;app:string}|null,read:(id:string)=>unknown|undefined):BookWalk{
 const parsed=mains===null?null:(['cli','app'] as const).map(book=>({book,...locate(mains[book])}));
 if(parsed===null||parsed.some(item=>item.dir==='')){
  const tree=treeOf(root,read);
  const groupMains=parsed===null?[]:parsed.map(item=>({book:item.book,file:item.dir===''?item.file:`${item.dir}/${item.file}`}));
  return {revision:tree.revision,groups:[{directory:root,relative:'',mains:groupMains,tree}],unread:[],pending:[...tree.pending]};
 }
 const first=read(rootId(root));
 if(first===undefined)return {revision:'',groups:[],unread:[],pending:[rootId(root)]};
 const rootDoc=directory(first,root);
 const revision=rootDoc.revision;
 const order:string[]=[];
 for(const item of parsed)if(!order.includes(item.dir))order.push(item.dir);
 const must=new Set<string>();
 for(const rel of order){let acc='';for(const part of rel.split('/')){acc=acc?`${acc}/${part}`:part;must.add(acc);}}
 const unread:string[]=[];const pending:string[]=[];const groups:BookGroup[]=[];
 const classify=(doc:Directory,rel:string):void=>{
  for(const member of doc.members){
   if(!member.directory)continue;
   const child=rel?`${rel}/${member.name}`:member.name;
   if(!must.has(child))unread.push(member.name);
  }
 };
 classify(rootDoc,'');
 for(const rel of order){
  const parts=rel.split('/');
  let parent=rootDoc;let blocked=false;
  for(let i=0;i<parts.length;i++){
   const name=parts[i];
   const member=parent.members.find(item=>item.name===name);
   if(!member||!member.directory)return stop('missing_main',`${name} 不是 ${parent.directory} 里的目录，主文件不在这份清单里`);
   const acc=parts.slice(0,i+1).join('/');
   if(acc===rel)break;
   const full=`${root}/${acc}`;
   const raw=read(childId(revision,full));
   if(raw===undefined){remember(pending,childId(revision,full));blocked=true;break;}
   parent=directory(raw,full,revision);
   classify(parent,acc);
  }
  if(blocked)continue;
  const full=`${root}/${rel}`;
  const tree=treeOf(full,read,revision);
  for(const id of tree.pending)remember(pending,id);
  groups.push({directory:full,relative:rel,mains:parsed.filter(item=>item.dir===rel).map(item=>({book:item.book,file:item.file})),tree});
 }
 return {revision,groups,unread,pending};
}

// Fixed-revision SVN directory walk shared by sync's source plan and knowledge seed.
import {lineKey} from '../naming.ts';
import {isRecord} from '../util.ts';

export const ADOC_LIMITS={depth:5,directories:32,files:128,entries:512} as const;
export class ManualSourceError extends Error{
 readonly code:string;readonly next_action:string;
 constructor(code:string,message:string,next_action:string){super(`${message}；下一步：${next_action}`);this.code=code;this.next_action=next_action;}
}
export const stop=(code:string,message:string,next='核对本族 ROOT、MAIN 和同修订号 SVN 原件后重跑同步'):never=>{throw new ManualSourceError('apv.adoc.'+code,message,next);};
export function safePath(path:string):boolean{return path.length>0&&path.length<=2000&&!/[\\\p{Cc}\p{Cf}?#;]/u.test(path)&&path.split('/').every(p=>p!==''&&p!=='.'&&p!=='..'&&p.length<=255);}
export function directoryOf(root:unknown,line:string):string|null{
 if(root===null)return null;
 if(typeof root!=='string'||!root.includes('{line}')&&!root.includes('{line_dir}'))return stop('invalid_root','ROOT 需要包含 {line} 或 {line_dir} 的相对 SVN 目录模板，或显式 null');
 const parts=line.split('.');if(![1,2,3].includes(parts.length)||parts.some(part=>!part.length||part.length>9||![...part].every(ch=>ch>='0'&&ch<='9')))return stop('invalid_line','版本线不符合点分十进制语法，不能猜目录名');
 const canonical=lineKey(line).split('.');while(canonical.length<3)canonical.push('0');
 const path=root.replaceAll('{line_dir}',canonical.join('_')).replaceAll('{line}',line);
 if(/[{}]/.test(path)||!safePath(path))return stop('invalid_root','ROOT 展开后的目录无效，不允许绝对路径或跳出目录');
 return path;
}
export const rootId=(path:string)=>'svn:directory:'+encodeURIComponent(path);
const childId=(revision:string,path:string)=>'svn:directory-at:'+revision+'/'+encodeURIComponent(path);
const fileId=(revision:string,path:string)=>'svn:file:'+revision+'/'+encodeURIComponent(path);
interface Member {name:string;directory:boolean;external:string|null;revision:string;size:number|null}
interface Directory {directory:string;revision:string;members:Member[]}
function directory(value:unknown,path:string,revision?:string):Directory{
 if(!isRecord(value)||value.directory!==path||typeof value.revision!=='string'||!/^\d+$/.test(value.revision)||revision!==undefined&&value.revision!==revision||!Array.isArray(value.members))return stop('directory_identity','目录原件缺少本目录身份、固定修订号或完整成员表');
 if(value.members.length>ADOC_LIMITS.entries)return stop('group_budget','目录成员超过整组条目上限，不截断');
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
export function treeOf(root:string,read:(id:string)=>unknown|undefined):DirectoryTree{
 const first=read(rootId(root));
 if(first===undefined)return {root,revision:'',directories:new Map(),files:new Map(),pending:[rootId(root)]};
 const firstDir=directory(first,root);
 const out:DirectoryTree={root,revision:firstDir.revision,directories:new Map(),files:new Map(),pending:[]};
 const queue=[{path:root,depth:0}];let entries=0;
 for(let at=0;at<queue.length;at++){
  const next=queue[at];if(next.depth>ADOC_LIMITS.depth||queue.length>ADOC_LIMITS.directories)return stop('group_budget','整组目录深度或目录数超过上限，不截断');
  const id=next.depth===0?rootId(root):childId(out.revision,next.path);
  const raw=next.depth===0?first:read(id);
  if(raw===undefined){out.pending.push(id);continue;}
  const doc=directory(raw,next.path,out.revision);out.directories.set(id,doc);
  for(const member of doc.members){
   if(++entries>ADOC_LIMITS.entries)return stop('group_budget','整组条目数超过上限，不截断');
   const path=next.path+'/'+member.name;
   if(member.directory)queue.push({path,depth:next.depth+1});
   else if(member.name.endsWith('.adoc')){
    out.files.set(path.slice(root.length+1),member);
    if(out.files.size>ADOC_LIMITS.files)return stop('group_budget','整组 adoc 文件数超过上限，不截断');
   }
  }
 }
 return out;
}
/** Child directory listings, then every file external, in walk order. The root listing itself is not in the file list. */
export function listedSources(root:string,tree:DirectoryTree):string[]{
 return [...tree.directories.keys()].filter(id=>id!==rootId(root)).concat([...tree.files.values()].map(member=>member.external!));
}

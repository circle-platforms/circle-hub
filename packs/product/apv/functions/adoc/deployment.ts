// Product-owned SVN traversal and one independently memoized manual production per name family.
import type {ProducerInput,ProducerOutput,BuildInfo} from '../../../../../contracts/src/product.ts';
import {PRODUCT_LINE} from '../naming.ts';
import {manual} from '../producers.ts';
import {commandCatalog} from '../cases-commands.ts';
import {isRecord} from '../util.ts';
import {compileFamilies,familyManualName} from './families.ts';
import {toK1Model} from './k1-model.ts';
import {produceAdocEntries,catalogOnAdocLine,catalogRefusal} from './entries.ts';
import {sha256} from './input.ts';

export const ADOC_LIMITS={depth:5,directories:32,files:128,entries:512} as const;
export const adocRole=(family:string,kind:'meta'|'files')=>'adoc_'+family.toLowerCase()+'_'+kind;
export class ManualSourceError extends Error{
 readonly code:string;readonly next_action:string;
 constructor(code:string,message:string,next_action:string){super(`${message}；下一步：${next_action}`);this.code=code;this.next_action=next_action;}
}
const stop=(code:string,message:string,next='核对本族 ROOT、MAIN 和同修订号 SVN 原件后重跑同步'):never=>{throw new ManualSourceError('apv.adoc.'+code,message,next);};
function safePath(path:string):boolean{return path.length>0&&path.length<=2000&&!/[\\\p{Cc}\p{Cf}?#;]/u.test(path)&&path.split('/').every(p=>p!==''&&p!=='.'&&p!=='..'&&p.length<=255);}
export function directoryOf(root:unknown,line:string):string|null{
 if(root===null)return null;
 if(typeof root!=='string'||!root.includes('{line}'))return stop('invalid_root','ROOT 需要包含 {line} 的相对 SVN 目录模板，或显式 null');
 const path=root.replaceAll('{line}',line);
 if(/[{}]/.test(path)||!safePath(path))return stop('invalid_root','ROOT 展开后的目录无效，不允许绝对路径或跳出目录');
 return path;
}
const rootId=(path:string)=>'svn:directory:'+encodeURIComponent(path);
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
interface Tree {root:string;revision:string;directories:Map<string,Directory>;files:Map<string,Member>;pending:string[]}
/** Traverse only explicit fixed revision metadata. No absent directory or member is silently skipped. */
function treeOf(root:string,read:(id:string)=>unknown|undefined):Tree{
 const first=read(rootId(root));
 if(first===undefined)return {root,revision:'',directories:new Map(),files:new Map(),pending:[rootId(root)]};
 const firstDir=directory(first,root);
 const out:Tree={root,revision:firstDir.revision,directories:new Map(),files:new Map(),pending:[]};
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

/** Add directory metadata and a complete file list to each own-tree build; failed reads remain required production inputs. */
export function addAdocSources(build:BuildInfo,options:Record<string,unknown>,read:Record<string,{ok?:unknown;parser?:unknown;model?:unknown}>,want:(id:string)=>void,notes:string[]):void{
 if(build.base!==build.name||!build.sources.tree)return;
 const settings=isRecord(options.adoc)?options.adoc:{};
 for(const family of PRODUCT_LINE.names){
  const config=isRecord(settings[family])?settings[family]:{};
  try{
   const root=directoryOf(config.root??null,build.line);if(root===null)continue;
   build.sources[adocRole(family,'meta')]=rootId(root);build.sources[adocRole(family,'files')]=[];
   const tree=treeOf(root,id=>{
    const page=read[id];if(page===undefined)return undefined;
    if(!page.ok||page.parser!=='json@1')return stop('directory_unreadable',`名称族 ${family} 的目录清单读不出`,`请管理员核对 SVN 资源和 ${family}_ADOC_ROOT，保留旧根，重跑同步`);
    return page.model;
   });
   tree.pending.forEach(want);
   build.sources[adocRole(family,'files')]=[...tree.directories.keys()].filter(id=>id!==rootId(root)).concat([...tree.files.values()].map(m=>m.external!));
  }catch(error){if(!(error instanceof ManualSourceError))throw error;notes.push(`${family}_ADOC_ROOT / ${family}_ADOC_MAIN：${error.message}，旧根不动`);}
 }
}

/** Entry point shared by separate family declarations; the payload never contains the other family's variables. */
export async function familyManual(input:ProducerInput):Promise<ProducerOutput>{
 const family=input.params.family;
 if(typeof family!=='string'||!(PRODUCT_LINE.names as readonly string[]).includes(family))return stop('family_not_a_name','生产器需要 product.json names 中的一个名称族');
 if(input.params.root===null)return manual(input);
 const root=directoryOf(input.params.root,input.build.line)!;
 const meta=input.slots.meta;
 if(!meta||meta.parser!=='json@1')return stop('directory_unreadable',`名称族 ${family} 缺少固定修订号的目录清单`,`请管理员核对 SVN 资源和 ${family}_ADOC_ROOT 后重跑同步，旧根不动`);
 const given=input.lists?.files??[];
 const byId=new Map(given.map(slot=>[slot.external,slot]));
 if(byId.size!==given.length)return stop('duplicate_file','文件组重复绑定同一个来源');
 const tree=treeOf(root,id=>id===rootId(root)?meta.model:byId.get(id)?.model);
 if(tree.pending.length)return stop('incomplete_group','缺少固定修订号的子目录清单，不读取不完整文件组');
 const expected=new Set([...tree.files.values()].map(m=>m.external!));
 const metadataIds=[...tree.directories.keys()].filter(id=>id!==rootId(root));metadataIds.forEach(id=>expected.add(id));
 if(expected.size!==given.length||given.some(slot=>!slot.external||!expected.has(slot.external)))return stop('incomplete_group','需要完整目录树中的全部 adoc 和子目录清单，不能拆批、漏文件或混入额外文件');
 const main=input.params.main;
 if(typeof main!=='string'||!safePath(main)||!main.endsWith('.adoc')||!tree.files.has(main))return stop('missing_main','MAIN 指定的主文件不在本修订号的完整文件组里');
 const files:Record<string,{text:string;revision:string;sha256:string}>=Object.create(null);
 for(const [name,member] of tree.files){
  const slot=byId.get(member.external!);
  if(!slot||slot.parser!=='text@1'||!isRecord(slot.model)||typeof slot.model.raw_utf8!=='string')return stop('non_utf8','adoc 需要可往返为原件字节的 UTF-8 文本，不拼接规范化后的行');
  const text=slot.model.raw_utf8;
  if(sha256(text)!==slot.sha256||Buffer.byteLength(text)!==member.size)return stop('source_digest','文件的原件字节摘要或长度不合目录清单与绑定槽位');
  files[name]={text,revision:tree.revision,sha256:slot.sha256};
 }
 for(const name of ['cli','app'])if(catalogOnAdocLine(input.slots[name])){const refusal=catalogRefusal(family);throw new ManualSourceError(refusal.code,refusal.message,refusal.next_action);}
 const attributes=isRecord(input.params.attributes)?input.params.attributes:{};
 const compiled=await compileFamilies({main,revision:tree.revision,families:files,familyAttributes:attributes},[family]);
 if(!compiled.ok)throw new ManualSourceError(compiled.error.code,compiled.error.message,compiled.error.next_action);
 const one=compiled.families[family];
 const mapped=toK1Model(one.model,one.composition,familyManualName(family,'cli'));
 const treeSlot=input.slots.tree;
 const catalog=treeSlot?.parser==='xml@1'?commandCatalog(treeSlot.model as Parameters<typeof commandCatalog>[0]).catalog:null;
 const placed=produceAdocEntries(mapped,{name:familyManualName(family,'cli'),slot:'files',catalog});
 if(!placed.ok)throw new ManualSourceError(placed.error.code,placed.error.message,placed.error.next_action);
 return {entries:placed.entries,unplaced:placed.unplaced,warnings:[...placed.warnings,one.attributes.note,`名称族 ${family}：同修订号原件 ${Object.keys(files).length} 份；条件分支 ${one.report.conditions.length} 处；未能核对原文 ${one.report.unverified_count} 处` ]};
}
export default familyManual;

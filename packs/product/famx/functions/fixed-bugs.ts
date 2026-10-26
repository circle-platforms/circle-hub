// A parsed tracker URL supplies an opaque defect identity, never a release status. Prose is not an identity grammar.
import type {ProducerOutput} from '../../../../contracts/src/product.ts';
import {isRecord} from './util.ts';
import {undeclaredReleaseEntry,STATUS_NEXT} from './release-notes.ts';
function identity(href:unknown):{bug:string;system:string}|null{
 if(typeof href!=='string')return null;
 let url:URL;try{url=new URL(href,'https://release.example.invalid/');}catch{return null;}
 if(url.protocol!=='http:'&&url.protocol!=='https:')return null;
 if(url.searchParams.getAll('id').length!==1)return null;const bug=url.searchParams.get('id');if(!bug||bug.length>200)return null;
 if(url.searchParams.getAll('m').length===1&&url.searchParams.get('m')==='bug'&&url.searchParams.getAll('f').length===1&&url.searchParams.get('f')==='view')return {bug,system:'plm'};
 if(url.pathname.split('/').at(-1)==='show_bug.cgi')return {bug,system:'bugzilla'};
 return null;
}
export function fixedBugEntries(model:unknown,build:string|null):ProducerOutput{
 if(!isRecord(model))return {entries:[],warnings:['发布页缺 html@1 结构；下一步：'+STATUS_NEXT]};
 const entries:ProducerOutput['entries']=[],warnings:string[]=[],seen=new Set<string>();
 for(const [i,link]of (Array.isArray(model.links)?model.links:[]).entries()){
  if(!isRecord(link))continue;const id=identity(link.href);if(!id)continue;const key=JSON.stringify([id.system,id.bug]);if(seen.has(key))continue;seen.add(key);
  entries.push(undeclaredReleaseEntry(build,'html@1','a/'+i,typeof link.text==='string'?link.text:'',id.bug,id.system));
 }
 if(!entries.length&&Array.isArray(model.blocks)&&model.blocks.length){const block=model.blocks[0];entries.push(undeclaredReleaseEntry(build,'html@1','b/0',isRecord(block)&&typeof block.text==='string'?block.text:'',null,undefined,'缺发布页的结构化缺陷身份和状态；正文数字、标题及文件名都不是声明'));}
 warnings.push('发布页没有原始结构化状态，已保留未声明条目；下一步：'+STATUS_NEXT);
 return {entries,warnings};
}

/** Closed original PLM fields for feeding; absent declarations stay null/empty, never inferred from prose. */
export function structuredDefect(model:unknown):{id:string;status:string|null;affected_lines:string[];resolved_lines:string[];fix_builds:string[]}|null{
 if(!isRecord(model)||model.kind!=='bug')return null;
 const fields=isRecord(model.fields)?model.fields:model;
 const id=typeof model.id==='string'?model.id:typeof fields.id==='string'?fields.id:null;if(id===null)throw Error('PLM 原件缺结构编号；补 id 后重新读取');
 const strings=(key:string):string[]=>{const value=fields[key];if(value===undefined||value===null)return [];if(!Array.isArray(value)||value.some(v=>typeof v!=='string'))throw Error(key+' 必须是原始字符串数组；修正原件后重读');return value as string[];};
 if(fields.status!==undefined&&fields.status!==null&&typeof fields.status!=='string')throw Error('status 必须是原始字符串或 null；修正原件后重读');
 return {id,status:typeof fields.status==='string'?fields.status:null,affected_lines:strings('affected_lines'),resolved_lines:strings('resolved_lines'),fix_builds:strings('fix_builds')};
}

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

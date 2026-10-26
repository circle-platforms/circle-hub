import type { IdsResult } from './types.ts';
/** famx-id-fields@1: entire field 'bug:<decimal>' or 'story:<decimal>'; comma-separated decimal lists. Origin: owner R6, 2026-10-24. */
function fields(text:string): Array<{kind:'bug'|'story'|null;id:string}> {
  const match=/^(bug|story):([1-9][0-9]{0,11}(?:,[1-9][0-9]{0,11})*)$/.exec(text);
  return match ? match[2].split(',').map(id=>({kind:match[1] as 'bug'|'story',id})) : [];
}

export type TitleIds = IdsResult & {spellings?:Array<{kind:'story'|'bug'|'plm'|null;id:string;raw:string}>};
export function normalizeId(raw:string):string|null { return /^[1-9][0-9]{0,11}$/.test(raw)?raw:null; }
export function idsFromTitle(title:string):TitleIds {
 const found=typeof title==='string'?fields(title):[];
 return {stories:found.filter(f=>f.kind==='story').map(f=>f.id),bugs:found.filter(f=>f.kind==='bug').map(f=>f.id),plm:[],unclassified:typeof title==='string'&&/^[1-9][0-9]{0,11}(?:,[1-9][0-9]{0,11})*$/.test(title)?title.split(','):[],warnings:found.length?[]:['缺少显式编号字段或经核验的模型编号主张；下一步由作者补 bug/story 编号字段或提交逐字引文后重产']};
}
export default function ids(input:unknown):TitleIds {return idsFromTitle(typeof input==='string'?input:input&&typeof input==='object'&&'title' in input?String(input.title):'');}

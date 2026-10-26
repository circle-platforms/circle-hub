import type {FoundId} from './types.ts';
/** famx-id-fields@1: entire field 'bug:<decimal>' or 'story:<decimal>'; comma-separated decimal lists. Origin: owner R6, 2026-10-24. */
function fields(text:string): Array<{kind:'bug'|'story'|null;id:string}> {
  const match=/^(bug|story):([1-9][0-9]{0,11}(?:,[1-9][0-9]{0,11})*)$/.exec(text);
  return match ? match[2].split(',').map(id=>({kind:match[1] as 'bug'|'story',id})) : [];
}

export function normalizeId(raw:string):string|null{return /^[1-9][0-9]{0,11}$/.test(raw)?raw:null;}
export function markedIds(text:string,_fromBugToCase?:(id:string)=>void):FoundId[]{return fields(text);}
export function leadingIds(text:string):FoundId[]{return /^[1-9][0-9]{0,11}(?:,[1-9][0-9]{0,11})*$/.test(text)?text.split(',').map(id=>({kind:null,id})):[];}
export function extractIds(text:string,_options:{leading?:boolean}={}):FoundId[]{return [...fields(text),...(_options.leading===false?[]:leadingIds(text))];}
export function hasIds(text:string):boolean{return fields(text).length>0;}
export function bugToCaseIds(_text:string):string[]{return [];}

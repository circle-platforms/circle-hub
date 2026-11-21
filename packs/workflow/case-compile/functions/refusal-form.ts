export const PLAN_DATA='/slots/plan/0/data';

export const LISTED_LIMIT=12;
export const SHOWN_LIMIT=120;

export interface RefusalForm {
 what:string;
 place?:string;
 seen?:string;
 allowed?:readonly string[];
 also?:readonly string[];
 next:string;
}

export function listed(values:readonly string[],limit:number=LISTED_LIMIT):string{
 if(!values.length)return '无';
 return values.slice(0,limit).join('、')+(values.length>limit?`…（共 ${values.length} 个）`:'');
}

export function shownValue(value:unknown):string{
 if(value===undefined)return '没有';
 const text=JSON.stringify(value)??String(value);
 return [...text].length>SHOWN_LIMIT?[...text].slice(0,SHOWN_LIMIT-1).join('')+'…':text;
}

export function refusalText(form:RefusalForm):string{
 return [
  form.what,
  ...(form.place!==undefined?[`位置：${form.place}`]:[]),
  ...(form.seen!==undefined?[`看到：${form.seen}`]:[]),
  ...(form.allowed!==undefined?[`允许：${listed(form.allowed)}`]:[]),
  ...(form.also??[]),
  `下一步：${form.next}`,
 ].join('；');
}

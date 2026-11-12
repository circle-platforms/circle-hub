import type {PlanStep} from './slots.ts';

export interface CellSelection {
 table:{format:string;separator:string;columns:number;header:boolean};
 column:number;
 select:{row:number;where?:never}|{where:Array<{column:number;value:string}>;row?:never};
}
export const cellInput=(step:PlanStep):boolean=>step.cell_input===true&&typeof step.input_register==='string';

/** The runner formats only its first positional argument. */
export function cellTemplate(value:string):boolean{
 let automatic=0,indexed=0;
 for(let at=0;at<value.length;at++){
  if(value[at]==='{'){
   if(value.slice(at,at+2)==='{}'){automatic++;at++;}
   else if(value.slice(at,at+3)==='{0}'){indexed++;at+=2;}
   else return false;
  }else if(value[at]==='}')return false;
 }
 return automatic===1&&indexed===0||automatic===0&&indexed>0;
}
export const cellSyntax=(value:string):string=>value.replaceAll('{0}','_').replaceAll('{}','_');
export function literalFormatParameter(value:string):boolean{
 for(let at=0;at<value.length;at++)if(value[at]==='{'||value[at]==='}'){
  if(value[at+1]!==value[at])return false;
  at++;
 }
 return true;
}
export function cellArguments(selection:CellSelection):Pick<PlanStep,'args'|'keywords'>{
 return {
  args:['{}',...('where'in selection.select?selection.select.where!.map(condition=>`where ${condition.column}=${condition.value}`):[])],
  keywords:{separator:selection.table.separator,columns:selection.table.columns,column:selection.column,format:selection.table.format,header:selection.table.header?1:0,row:'row'in selection.select?selection.select.row!:0}
 };
}

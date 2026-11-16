import TABLE from '../tables/blocks-format.json' with {type:'json'};
import {pythonTrim} from './generated/skills/runner-workbook/workbook-writer/g-syntax.ts';
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

// ---- The cell-selection rules. A SELECT_CELL block writes its table and selector fields as keywords and where-conditions of
// one method call (cellArguments); those values are judged here, by what the runner does with them, and not by the single-line
// policy of ordinary command values (no leading =, no {} placeholder: neither applies to a keyword or to a later argument).

/** The keywords cellArguments writes, in the order the block declares them. */
export const CELL_SELECTION_KEYWORDS=['separator','columns','column','format','header','row'] as const;
export type CellSelectionKeyword=typeof CELL_SELECTION_KEYWORDS[number];
export type CellSelectionPosition={keyword:CellSelectionKeyword}|{where:number};

const CELL_TEXT_CONTROL=/[\r\n\v\f\u0085\u2028\u2029\u0000-\u0008\u000e-\u001f\uFFFE\uFFFF]/;
/** Text a workbook cell carries as written: well-formed, no line break or control character, no Excel _xHHHH_ escape. */
export const cellSafeText=(value:unknown):value is string=>typeof value==='string'&&value.isWellFormed()&&!CELL_TEXT_CONTROL.test(value)&&!/_x[0-9a-fA-F]{4}_/.test(value);
const unsafeReason=(value:string):string=>!value.isWellFormed()?'含不成对的代理字符':/[\r\n\v\f\u0085\u2028\u2029]/.test(value)?'含换行':CELL_TEXT_CONTROL.test(value)?'含控制字符':'含 Excel 转义写法 _xHHHH_';
const shown=(value:unknown):string=>{const text=JSON.stringify(value)??String(value);return typeof value==='string'&&value!==''&&pythonTrim(value)===''?`${text}（全是空白，${[...value].length} 个字符）`:text;};

/** Where a lowered SELECT_CELL argument sits in the block's own declaration; null for the input template and for any other step. */
export function cellSelectionPosition(step:PlanStep,pointer:string,at:string):CellSelectionPosition|null{
 if(step.block_kind!=='SELECT_CELL'||!pointer.startsWith(at+'/'))return null;
 const parts=pointer.slice(at.length+1).split('/');
 if(parts.length!==2)return null;
 if(parts[0]==='keywords'&&(CELL_SELECTION_KEYWORDS as readonly string[]).includes(parts[1]))return {keyword:parts[1] as CellSelectionKeyword};
 if(parts[0]==='args'&&/^[1-9][0-9]*$/.test(parts[1]))return {where:Number(parts[1])-1};
 return null;
}
const WHERE=/^where ([0-9]+)=([\s\S]*)$/;
const UNMET='这条期望在 obligations 里写 unmet 并在 missing 写明缺这项取格能力，不自造写法';
/**
 * The one rule a value of a selection position breaks, with what was seen and the next step; null when the runner receives it as written.
 * Whitespace at the end of a keyword value or of a later argument is cut when the runner reads G, so such a value is refused
 * here with that consequence instead of reaching the workbook as a different value.
 */
export function cellSelectionValueProblem(position:CellSelectionPosition,value:string|number):string|null{
 if('where' in position){
  const parsed=typeof value==='string'?WHERE.exec(value):null;
  if(!parsed)return `看到选行条件 ${shown(value)}；条件要写成 where <列号>=<常量>`;
  const constant=parsed[2];
  if(!cellSafeText(constant))return `看到条件常量 ${shown(constant)}：${unsafeReason(constant)}；常量要原样写进 G 单元格，不能含换行、控制字符和 Excel 转义写法 _xHHHH_；下一步：去掉这些字符`;
  if(pythonTrim(value as string)!==value)return `看到条件常量 ${shown(constant)}：末尾带空白；运行器读 G 里的位置参数时会去掉首尾空白，实际比较的是 ${JSON.stringify(pythonTrim(constant))}，不是你写的整格文字；下一步：改用不依赖末尾空白的列做条件；没有这样的列时，${UNMET}`;
  return null;
 }
 const name=position.keyword;
 if(name==='separator'){
  if(typeof value!=='string')return `看到分隔符 ${shown(value)}；取格分隔符必须是文字`;
  if(!cellSafeText(value))return `看到分隔符 ${shown(value)}：${unsafeReason(value)}；分隔符要原样写进 G 单元格，不能含换行、控制字符和 Excel 转义写法 _xHHHH_；下一步：改用设备输出里实际出现、不含这些字符的分隔符`;
  if(pythonTrim(value)!==value)return `看到分隔符 ${shown(value)}：首尾带空白；运行器读 G 里的关键字值时会去掉首尾空白，传给取格方法的会是 ${JSON.stringify(pythonTrim(value))}，不是你写的分隔符；下一步：改用设备输出里实际出现、首尾不带空白的分隔符；输出只靠空白分列时当前取格方法表达不了，${UNMET}`;
  if(/^\p{Number}+$/u.test(value))return `看到分隔符 ${shown(value)}：全是数字；运行器会把全数字的关键字值读成整数，取格分隔符必须是文字；下一步：改用含非数字字符的分隔符，或按设备输出的真实写法换一种取格方式`;
  return null;
 }
 if(name==='format')return typeof value==='string'&&(TABLE.cell_formats as readonly string[]).includes(value)?null:`看到表格形状 ${shown(value)}；只能是 ${TABLE.cell_formats.join(' 或 ')}`;
 const integer=typeof value==='number'&&Number.isSafeInteger(value);
 const seen=`看到 ${name}=${shown(value)}`;
 if(name==='columns')return integer&&(value as number)>=1?null:`${seen}；列数必须是不小于 1 的整数`;
 if(name==='column')return integer&&(value as number)>=1?null:`${seen}；取值列号必须是不小于 1 的整数`;
 if(name==='header')return value===0||value===1?null:`${seen}；header 只能是 0（没有表头）或 1（第一行是表头）`;
 return integer&&(value as number)>=0?null:`${seen}；row 必须是非负整数（0 表示改用 where 条件选行，1 起是数据行序号）`;
}

export interface CellShapeProblem {path:string;message:string;fix:string}
/**
 * The relations a block's table and selector declare between themselves, after the schema has fixed their types; each problem is
 * located at the one field to change, relative to the block, and says the value seen. The values themselves are judged by
 * cellSelectionValueProblem once the block is lowered to a call.
 */
export function cellSelectionShapeProblems(selection:CellSelection):CellShapeProblem[]{
 const problems:CellShapeProblem[]=[],{table}=selection,add=(path:string,message:string,fix:string)=>problems.push({path,message,fix});
 const conditions=selection.select.where??[];
 const braces='取格的花括号必须成对写成 {{ 或 }}（运行器按 Python 格式规则读 G，单个花括号读不成原样）';
 if(!literalFormatParameter(table.separator))add('/table/separator',`看到分隔符 ${shown(table.separator)}；${braces}`,'把单个花括号写成 {{ 或 }}，或改用不含花括号的分隔符');
 for(const [index,condition]of conditions.entries())if(!literalFormatParameter(condition.value))add(`/select/where/${index}/value`,`看到条件常量 ${shown(condition.value)}；${braces}`,'把单个花括号写成 {{ 或 }}');
 if(table.format==='key_value'){
  if(table.separator==='')add('/table/separator',`看到分隔符 ${shown(table.separator)}；键值行（key_value）需要非空分隔符，每行在第一个分隔符处切成键和值`,'写出设备输出里分开键和值的分隔符');
  if(table.columns!==2)add('/table/columns',`看到列数 ${table.columns}；键值行（key_value）固定是两列（键、值）`,'列数写 2；表格有更多列时改用 delimited');
 }else if(table.separator===''&&table.columns!==1)add('/table/separator',`看到分隔符 ${shown(table.separator)} 和列数 ${table.columns}；没有分隔符时一整行就是一列，列数只能是 1`,'要分列就写出分隔符；整行当一列就把列数写 1');
 if(selection.column>table.columns)add('/column',`看到取值列 ${selection.column}，表格声明只有 ${table.columns} 列`,'取值列写 1 到列数之间的列号，或改大表格声明的列数');
 for(const [index,condition]of conditions.entries())if(condition.column>table.columns)add(`/select/where/${index}/column`,`看到选行列 ${condition.column}，表格声明只有 ${table.columns} 列`,'选行列写 1 到列数之间的列号');
 return problems;
}

// Run exactly the same workbook verifier at compilation and immediately before dispatch.
import checkWorkbook from './workbook.ts';
import {isRecord,type Outcome} from './text.ts';
const at=(value:unknown,path:string):unknown=>path.split('/').slice(1).reduce<unknown>((node,key)=>isRecord(node)?node[key]:undefined,value);
export default function check(input:unknown):Outcome[]{
 const original=checkWorkbook(input);if(original.some(outcome=>outcome.verdict!=='support'))return original;
 const table=isRecord(input)&&isRecord(input.table)?input.table:{};
 return original.map(outcome=>{
   const bindings=isRecord(table.parameters)?table.parameters:{};const parameters:Record<string,unknown>={};
   for(const [key,path] of Object.entries(bindings))if(typeof path==='string'&&path.startsWith('/'))parameters[key]=at(outcome.data,path);
   const strings=['target','manifest_sha256','build','sha256','generator'];
   if(table.schema!=='case-compile.dispatch-policy@1'||Object.keys(parameters).length!==6||strings.some(key=>typeof parameters[key]!=='string'||!parameters[key])||!Array.isArray(parameters.items)||!parameters.items.length||typeof table.max_items!=='number'||parameters.items.length>table.max_items||new Set(parameters.items).size!==parameters.items.length||parameters.items.some(item=>typeof item!=='string'||!item))return {...outcome,verdict:'refute',code:'case-compile.workbook_invalid',statement:'派发政策没有把工作簿身份和其中全部用例完整绑定到通用作业参数；请包负责人修正政策表并开新修订',data:undefined};
   return {...outcome,data:{...outcome.data,parameters}};
 });
}

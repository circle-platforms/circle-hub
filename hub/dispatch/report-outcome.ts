// Resolve only the executor-declared complete/list/item/outcome pointers and exact closed scalar map.
import {at,mapped,type ExecutorDefinition} from './definition.ts';
import {releaseDigest} from './release-diagnostics.ts';
import {labelOf,type DynamicTerminal} from '../../contracts/generated/vocabulary.ts';
export interface ReportCheck {
 condition:string;pointer:string;declared_pointer:string;resolved:boolean;present:boolean;
 actual_sha256:string;result_definition_sha256:string;mapped_terminal?:DynamicTerminal;
 missing_fact?:string;next_action?:string;
}
export function reportOutcome(value:unknown,d:ExecutorDefinition,id:string):{row:unknown;matches:number;reported:DynamicTerminal|null;check:ReportCheck}{
 const definition=releaseDigest(d.result),rows=at(value,d.result.items),complete=at(value,d.result.complete)===true;
 const found=Array.isArray(rows)?rows.map((row,index)=>({row,index})).filter(entry=>at(entry.row,d.result.item_id)===id):[];
 const row=found.length===1?found[0].row:null,index=found.length===1?found[0].index:undefined;
 const pointer=index===undefined?d.result.items+'/*'+d.result.item_outcome:d.result.items+'/'+index+d.result.item_outcome;
 const raw=row?at(row,d.result.item_outcome):undefined;
 const reported=complete&&found.length===1?mapped(d.result.map,raw)??null:null;
 const make=(condition:string,path:string,declared:string,actual:unknown,message?:string):ReportCheck=>({condition,pointer:path,declared_pointer:declared,resolved:!message,present:actual!==undefined,actual_sha256:releaseDigest(actual),result_definition_sha256:definition,...(reported!==null?{mapped_terminal:reported}:{}),...(message?{missing_fact:message,next_action:'按该指针对照已保存原件：原件未齐时稍后 job resume；原件已齐时修正执行器 result 相对指针或完全相等映射后 job resume；不重交'}:{})});
 let check:ReportCheck;
 if(!complete)check=make('result.complete',d.result.complete,d.result.complete,at(value,d.result.complete),`结果完整字段 ${d.result.complete} 尚不为 true，缺完整报告`);
 else if(!Array.isArray(rows))check=make('result.items',d.result.items,d.result.items,rows,`结果条目字段 ${d.result.items} 缺失或不是数组`);
 else if(found.length!==1)check=make('result.item_id',d.result.items+'/*'+d.result.item_id,d.result.item_id,rows.map(row=>at(row,d.result.item_id)),`条目标识 ${d.result.items}/*${d.result.item_id} 未唯一匹配冻结条目，匹配数 ${found.length}`);
 else if(raw===undefined||raw===null)check=make('result.item_outcome',pointer,d.result.item_outcome,raw,`结果值字段 ${pointer} ${raw===undefined?'缺失':'为 null'}；result.item_outcome 相对于单个条目，不能写响应根路径`);
 else if(typeof raw!=='string'&&typeof raw!=='number'&&typeof raw!=='boolean')check=make('result.item_outcome.scalar',pointer,d.result.item_outcome,raw,`结果字段 ${pointer} 不是可映射的标量；核对 result.item_outcome 的相对位置`);
 else if(reported===null)check=make('result.map',pointer,d.result.item_outcome,raw,`结果字段 ${pointer} 的标量值没有可用的 result.map 完全相等声明（值摘要 ${releaseDigest(raw)}），缺设备结果映射事实`);
 else if(reported!=='pass'&&reported!=='fail')check=make('result.map.terminal',pointer,d.result.item_outcome,raw,`结果字段 ${pointer} 经 result.map 映射为${labelOf('dynamic_terminal',reported)}，没有产生通过或不通过判定`);
 else check=make('result.resolved',pointer,d.result.item_outcome,raw);
 return {row,matches:found.length,reported,check};
}

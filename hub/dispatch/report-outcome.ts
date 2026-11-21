// Resolve only the executor-declared complete/list/item/outcome pointers and exact closed scalar map.
import {at,mapped,type ExecutorDefinition} from './definition.ts';
import {releaseDigest} from './release-diagnostics.ts';
import {labelOf,type DynamicTerminal} from '../../contracts/generated/vocabulary.ts';
export interface ReportCheck {
 condition:string;pointer:string;declared_pointer:string;resolved:boolean;present:boolean;
 actual_sha256:string;result_definition_sha256:string;mapped_terminal?:DynamicTerminal;
 missing_fact?:string;next_action?:string;
}
export interface RunStop {last:string;closed:boolean|null;unreached:string[]}
const filled=(value:unknown):boolean=>typeof value==='string'&&value.trim()!=='';
function reached(row:unknown,d:ExecutorDefinition):boolean{
 const outcome=at(row,d.result.item_outcome);
 if(outcome!==undefined&&outcome!==null&&(typeof outcome!=='string'||outcome.trim()!==''))return true;
 if(d.result.log&&filled(at(row,d.result.log)))return true;
 const sessions=d.result.sessions?at(row,d.result.sessions):undefined;
 return sessions!==null&&typeof sessions==='object'&&!Array.isArray(sessions)&&Object.values(sessions).some(filled);
}
export function runStop(value:unknown,d:ExecutorDefinition,items:readonly string[]):RunStop|null{
 const rows=at(value,d.result.items);
 if(!Array.isArray(rows)||items.length<2)return null;
 const byId=new Map<unknown,unknown[]>();
 for(const row of rows){const key=at(row,d.result.item_id),same=byId.get(key);if(same)same.push(row);else byId.set(key,[row]);}
 const placed:unknown[]=[];
 for(const id of items){const found=byId.get(id);if(found?.length!==1)return null;placed.push(found[0]);}
 const held=placed.map(row=>reached(row,d)),last=held.lastIndexOf(true);
 if(last<0||last===items.length-1||held.slice(0,last).includes(false))return null;
 const log=d.result.log?at(placed[last],d.result.log):undefined;
 return {last:items[last],closed:d.result.closing_marker&&filled(log)?(log as string).includes(d.result.closing_marker):null,unreached:items.slice(last+1)};
}
const RESUME='按该指针对照已保存原件：原件未齐时稍后 job resume；原件已齐时修正执行器 result 相对指针或完全相等映射后 job resume；不重交';
function stopWords(stop:RunStop,d:ExecutorDefinition,id:string):{missing_fact:string;next_action:string}{
 const held=[d.result.log?'日志':null,d.result.sessions?'会话':null,'结果'].filter((word):word is string=>word!==null);
 const lacks=held.length>1?`${held.slice(0,-1).join('、')}和${held.at(-1)}`:held[0];
 const count=stop.unreached.length,shown=stop.unreached.slice(0,5).join('、')+(count>5?' 等':'');
 const where=id===stop.last?`执行在本条处结束${stop.closed===false?'，本条日志没有收尾标记':''}，其后 ${count} 条（${shown}）没有${lacks}`
  :stop.unreached.includes(id)?`本条没有${lacks}，执行在条目 ${stop.last} 处结束，没有到达本条`
  :`执行在条目 ${stop.last} 处结束，其后 ${count} 条没有到达，整份报告因此不完整，本条没有判定`;
 return {missing_fact:`结果完整字段 ${d.result.complete} 尚不为 true，缺完整报告：${where}`,next_action:`执行已结束，缺的条目补读不到，job resume 只会再读到同一份不完整的报告，不必等也不必 resume：读条目 ${stop.last} 的日志，找出执行在那里结束的原因，处理后另开一次上机验证；不重新提交这次上机验证`};
}
export function reportOutcome(value:unknown,d:ExecutorDefinition,id:string,stop?:RunStop|null):{row:unknown;matches:number;reported:DynamicTerminal|null;check:ReportCheck}{
 const definition=releaseDigest(d.result),rows=at(value,d.result.items),complete=at(value,d.result.complete)===true;
 const found=Array.isArray(rows)?rows.map((row,index)=>({row,index})).filter(entry=>at(entry.row,d.result.item_id)===id):[];
 const row=found.length===1?found[0].row:null,index=found.length===1?found[0].index:undefined;
 const pointer=index===undefined?d.result.items+'/*'+d.result.item_outcome:d.result.items+'/'+index+d.result.item_outcome;
 const raw=row?at(row,d.result.item_outcome):undefined;
 const reported=complete&&found.length===1?mapped(d.result.map,raw)??null:null;
 const make=(condition:string,path:string,declared:string,actual:unknown,message?:string,next?:string):ReportCheck=>({condition,pointer:path,declared_pointer:declared,resolved:!message,present:actual!==undefined,actual_sha256:releaseDigest(actual),result_definition_sha256:definition,...(reported!==null?{mapped_terminal:reported}:{}),...(message?{missing_fact:message,next_action:next??RESUME}:{})});
 let check:ReportCheck;
 if(!complete){
  const said=stop?stopWords(stop,d,id):null;
  check=make('result.complete',d.result.complete,d.result.complete,at(value,d.result.complete),said?.missing_fact??`结果完整字段 ${d.result.complete} 尚不为 true，缺完整报告`,said?.next_action);
 }
 else if(!Array.isArray(rows))check=make('result.items',d.result.items,d.result.items,rows,`结果条目字段 ${d.result.items} 缺失或不是数组`);
 else if(found.length!==1)check=make('result.item_id',d.result.items+'/*'+d.result.item_id,d.result.item_id,rows.map(row=>at(row,d.result.item_id)),`条目标识 ${d.result.items}/*${d.result.item_id} 未唯一匹配冻结条目，匹配数 ${found.length}`);
 else if(raw===undefined||raw===null)check=make('result.item_outcome',pointer,d.result.item_outcome,raw,`结果值字段 ${pointer} ${raw===undefined?'缺失':'为 null'}；result.item_outcome 相对于单个条目，不能写响应根路径`);
 else if(typeof raw!=='string'&&typeof raw!=='number'&&typeof raw!=='boolean')check=make('result.item_outcome.scalar',pointer,d.result.item_outcome,raw,`结果字段 ${pointer} 不是可映射的标量；核对 result.item_outcome 的相对位置`);
 else if(reported===null)check=make('result.map',pointer,d.result.item_outcome,raw,`结果字段 ${pointer} 的标量值没有可用的 result.map 完全相等声明（值摘要 ${releaseDigest(raw)}），缺设备结果映射事实`);
 else if(reported!=='pass'&&reported!=='fail')check=make('result.map.terminal',pointer,d.result.item_outcome,raw,`结果字段 ${pointer} 经 result.map 映射为${labelOf('dynamic_terminal',reported)}，没有产生通过或不通过判定`);
 else check=make('result.resolved',pointer,d.result.item_outcome,raw);
 return {row,matches:found.length,reported,check};
}

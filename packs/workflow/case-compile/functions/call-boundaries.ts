import {blockMeta,blockPointer} from './blocks.ts';
import {runtimeMethod,type RuntimeContract} from './runtime-contract.ts';
import type {RuntimeProfile} from './profile.ts';
import type {PlanSlots} from './slots.ts';
export interface CallBoundaryGap {
 document:string;pointer:string;message:string;verdict:'refute';
 requested:{object:string;method:string;responder?:string;output?:string};
 allowed_calls?:Array<{object:string;method:string}>;
 allowed_seats?:string[];
 step_pointer?:string;
}
function distance(a:string,b:string):number{
 let row=Array.from({length:b.length+1},(_,i)=>i);
 for(let i=0;i<a.length;i++){const next=[i+1];for(let j=0;j<b.length;j++)next.push(Math.min(next[j]+1,row[j+1]+1,row[j]+(a[i]===b[j]?0:1)));row=next;}
 return row[b.length];
}
function listed(request:string,names:string[]):string{
 const shown=[...names].sort((a,b)=>distance(request,a)-distance(request,b)||a.localeCompare(b,'en')).slice(0,8);
 return `${shown.length?shown.join('、'):'空集'}（共 ${names.length} 项${names.length>shown.length?'，完整集合见结构化结果':''}）`;
}
export function callBoundaryGaps(contract:RuntimeContract,profile:RuntimeProfile,slots:PlanSlots):CallBoundaryGap[]{
 const allowed=profile.allowed.filter(call=>runtimeMethod(contract,call.object,call.method));
 const calls=allowed.map(({object,method})=>({object,method}));
 const seats=[...new Set(profile.seats.map(seat=>seat.device))];
 const gaps:CallBoundaryGap[]=[];
 for(const [index,step]of slots.steps.entries()){
  const pointer=blockPointer(slots,`/steps/${index}`),requested={object:step.object,method:step.method};
  const call=allowed.find(row=>row.object===step.object&&row.method===step.method);
  if(!call)gaps.push({document:'contract',pointer,verdict:'refute',requested,allowed_calls:calls,message:`${pointer} 写的是 ${step.object}.${step.method}；方法不在合约与发布配置的共同允许集合；共同允许：${listed(`${step.object}.${step.method}`,calls.map(row=>`${row.object}.${row.method}`))}`});
  const declared=profile.allowed.find(row=>row.object===step.object&&row.method===step.method);
  if(!blockMeta(slots)||!step.output||!Object.values(declared?.parameters??{}).includes('host_shell'))continue;
  const rows=slots.block_context?.responders;
  if(!Array.isArray(rows))continue;
  const matches=rows.filter((row:any)=>row.output===step.id);
  if(matches.length!==1)continue;
  const row=matches[0];
  if(row.kind==='device'&&!seats.includes(row.ref)){
   const at='/block_context/responders/'+rows.indexOf(row);
   gaps.push({document:'blocks',pointer:at,step_pointer:pointer,verdict:'refute',requested:{...requested,responder:row.ref,output:step.id},allowed_seats:seats,message:`${at}（调用 ${pointer}，${step.object}.${step.method}，输出 ${step.id}）写的是设备应答者 ${row.ref}；设备应答者不在冻结设备座位中；冻结座位：${listed(row.ref,seats)}`});
  }
 }
 return gaps;
}

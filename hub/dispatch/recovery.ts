import {at,mapped,type ExecutorDefinition} from './definition.ts';
import {requestIdentity,sameRequestIdentity} from './request-identity.ts';
import type {Event,JobBinding} from './journal.ts';

/** Each recovery decision concerns the latest dispatch intent, never a previous round's terminal. */
export function currentDispatch(events:readonly Event[]):{intent:Event|undefined;tail:readonly Event[];finished:boolean}{
  const index=events.findLastIndex(event=>event.body.detail.phase==='intent');
  const tail=index<0?events:events.slice(index+1);
  const complete=tail.findLast(event=>event.body.detail.phase==='complete');
  const result=tail.findLast(event=>event.body.detail.phase==='result');
  const end=complete?.body.detail;
  const terminal=end?.outcome==='effective'||end?.outcome==='proven_not_executed'||end?.outcome==='target_rejected'||
    end?.outcome==='read_back_consistent'||end?.outcome==='not_dispatched'&&(index<0||end.submit_invoked===false);
  const disposed=tail.some(event=>event.body.detail.phase==='dispose'&&event.body.detail.unfreeze===true&&
    (event.body.detail.disposition==='abandon'||event.body.detail.disposition==='mark_failed'&&event.body.detail.risk_confirmed===true));
  const finished=disposed||complete?.body.detail.done===true&&terminal&&complete.body.detail.report_pending!==true&&result?.body.detail.report_pending!==true&&
    !tail.slice(tail.indexOf(complete)+1).some(event=>event.body.detail.uncertain===true);
  return {intent:index<0?undefined:events[index],tail,finished};
}

export function recoveryQuery(binding:JobBinding,intent:Event,d:ExecutorDefinition,value:unknown):{
  pending:boolean;remoteId?:string|number;notExecuted:boolean;rejected:boolean;missing:string[];
}{
  const r=d.reconciliation,detail=intent.body.detail,missing:string[]=[];
  const answer={pending:false,notExecuted:false,rejected:false,missing};
  if(!r||!d.calls.query){missing.push('原执行器没有原请求查账声明');return answer;}
  const before=detail.request_identity,current=requestIdentity(value,r.identity,r.time_scale_ms);
  if(!sameRequestIdentity(before,current))missing.push('原日志身份、起点或完整调用主体不符或缺失');
  if(typeof detail.request_id!=='string'||at(value,r.request_id)!==detail.request_id)missing.push('没有匹配原请求标识');
  if(!binding.input||at(value,r.sha256)!==binding.input.sha256)missing.push('没有匹配原产物摘要');
  if(at(value,r.found)!==true)missing.push('查空或缺少原请求记录不证明没有执行');
  if(detail.request_protocol_verified!==true||typeof detail.request_protocol_version!=='string')missing.push('缺少投递前冻结的请求协议证明');
  if(missing.length)return answer;
  const state=at(value,r.state),outcome=mapped(r.map,state);
  if(r.pending_states.some(word=>word===state))return {...answer,pending:true};
  if(outcome==='issued'){
    const id=at(value,r.id);
    if(at(value,r.reached_device)!==true)missing.push('原请求缺少明确的开始事实');
    if(!(typeof id==='string'&&id.length>0||typeof id==='number'&&Number.isSafeInteger(id)))missing.push('原请求缺少有效任务身份');
    return missing.length?answer:{...answer,remoteId:id as string|number};
  }
  if(outcome==='proven_not_executed'||outcome==='target_rejected'){
    if(at(value,r.reached_device)!==false)missing.push('原请求未明确证明没有触达设备');
    if(outcome==='target_rejected'&&mapped(d.receipt.stages,at(value,r.stage))!=='target_rejected')missing.push('拒收阶段没有明确映射');
    return missing.length?answer:{...answer,notExecuted:true,rejected:outcome==='target_rejected'};
  }
  missing.push('原请求状态没有可信映射');return answer;
}

/** Production timers are cancelled on shutdown; injected sleeps are only awaited while the worker remains active. */
export async function recoveryWait(ms:number,signal:AbortSignal,sleep?:((ms:number)=>Promise<void>)):Promise<void>{
  if(signal.aborted)return;
  await new Promise<void>((resolve,reject)=>{
    let timer:ReturnType<typeof setTimeout>|undefined;
    const done=()=>{if(timer!==undefined)clearTimeout(timer);signal.removeEventListener('abort',done);resolve();};
    signal.addEventListener('abort',done,{once:true});
    if(sleep)void sleep(ms).then(done,error=>{signal.removeEventListener('abort',done);reject(error);});
    else timer=setTimeout(done,ms);
  });
}

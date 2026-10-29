import type { z } from 'zod';
import { argumentDigest, isSha256, type Principal } from '../records/api.ts';
import { runById } from '../runs/api.ts';
import type { GetNodesOutput } from '../../contracts/src/tools.ts';
import { RunId } from '../../contracts/src/common.ts';
import type { ServerDeps } from './api.ts';
import { observedCalls } from './inflight-calls.ts';

type Status=NonNullable<z.infer<typeof GetNodesOutput>['call_status']>;
const LOG_WINDOW=500, RETURNED=20;

/** Only the caller's own matching arguments are observed; no arguments or source text are retained here. */
export async function callStatus(deps:ServerDeps,user:Principal,tool:'start_run'|'get_nodes',args:Record<string,unknown>,trace?:string):Promise<Status> {
  const digest=argumentDigest(args).digest;
  let logUnavailable=false;
  const logs=await deps.records.callLog.query(user,{userId:user.id,tool,limit:LOG_WINDOW,newestFirst:true}).catch(()=>{logUnavailable=true;return {items:[],next:null};});
  const matches=logs.items.filter(row=>row.args_digest===digest&&(trace===undefined||row.trace_id===trace));
  const recoveries=new Map<string,Promise<{run:string;runRecord?:string;resultRecord?:string;productionMissing:boolean}|null>>();
  let recoveryUnavailable=false,productionMissing=false;
  const recover=(id:string)=>{
    let pending=recoveries.get(id);
    if(!pending){pending=(async()=>{
      const detail=await deps.runs.getRun(user,id);if(!detail)return null;
      const stored=await runById(deps.records.store,id);
      const validResult=detail.production&&isSha256(detail.production.record);
      return {run:id,productionMissing:Array.isArray(detail.run.requirements)&&detail.run.requirements.every(row=>row.accepted_producer==='fact')&&!validResult,...(stored&&isSha256(stored.digest)?{runRecord:`rec:${stored.digest}`} : {}),...(validResult?{resultRecord:`rec:${detail.production!.record}`} : {})};
    })().catch(()=>{recoveryUnavailable=true;return null;});recoveries.set(id,pending);}
    return pending;
  };
  const completed=await Promise.all(matches.slice(0,RETURNED).map(async row=>{
    let run:string|null=null,runRecord:string|undefined,resultRecord:string|undefined;
    if(tool==='start_run'&&row.call_result==='ok'&&row.run&&RunId.safeParse(row.run).success){
      const found=await recover(row.run);
      if(found){run=found.run;runRecord=found.runRecord;resultRecord=found.resultRecord;productionMissing ||= found.productionMissing;}
    }
    return {trace:row.trace_id,at:row.at,call_result:row.call_result,error_code:row.error_code,duration_ms:row.duration_ms,run,...(runRecord?{run_record:runRecord}:{}),...(resultRecord?{result_record:resultRecord}:{})};
  }));
  // Capture after the log read: a call finishing between snapshots can be temporarily unknown, never falsely finished.
  const running=observedCalls(deps,user.id,tool,args).filter(row=>trace===undefined||row.trace===trace),active=running.slice(0,RETURNED);
  const truncated=logs.next!==null||matches.length>RETURNED||running.length>RETURNED;
  const newest=completed[0];
  let missing:string|undefined,next_action:string;
  if(running.length){missing='仍在处理的调用缺少完成结果';next_action='稍后用相同 call_query 查询，不重复发起原调用；已结束条目是独立的调用记录';}
  else if(logUnavailable){missing='调用日志当前不可读，无法确认是否已有完成记录';next_action='请管理员恢复调用日志后用相同参数重查；不要据此推定失败或重发';}
  else if(!newest){missing=logs.next?'最近 500 条调用日志没有匹配记录，更早记录未查询':'当前进程没有匹配的在途调用，也没有匹配的完成日志；可能尚未到达、仍在其他进程或日志缺失';next_action=logs.next?'请管理员按原参数摘要检索更早的调用日志；不要据此推定失败':'稍后用相同 call_query 重查；仍缺时请管理员核对调用日志，不要据此推定失败或重发';}
  else if(tool==='get_nodes'&&newest.call_result==='ok'){missing='已完成读取的原回答正文未存档或短时缓存不可用';next_action='核对追踪号；如仍需内容，按当前权限重读原引用或路径';}
  else if(tool==='start_run'&&newest.run_record){next_action=`确认追踪号对应本次调用后，用 get_nodes 读取 ${newest.run_record}${newest.result_record?` 和 ${newest.result_record}`:''}；确认后无需重新开始运行`;}
  else {missing=newest.call_result==='ok'?'缺少当前可读的原运行记录':'原错误详情没有保存在普通调用日志中';next_action='核对追踪号和错误码，请管理员查看该调用的原因；不要把没有运行记录当成未发起';}
  if((running.length+completed.length>0 && trace===undefined)||running.length+completed.length>1){
    missing=[missing,'仅凭参数或重复追踪号不能确认哪一条是本次调用'].filter(Boolean).join('；');
    next_action='记下或核对原调用的追踪号，按该追踪号查询；仍有多条时请管理员对照调用记录；'+next_action;
  }
  if(logUnavailable&&running.length){missing=[missing,'调用日志当前不可读'].filter(Boolean).join('；');next_action='请管理员恢复调用日志后用相同参数重查；'+next_action;}
  if(recoveryUnavailable){missing=[missing,'匹配运行的记录读取未完成'].filter(Boolean).join('；');next_action='请管理员恢复运行记录读取后重查；'+next_action;}
  if(productionMissing){missing=[missing,'事实运行的生产结果记录当前不可读或未存'].filter(Boolean).join('；');next_action='请管理员核对生产结果记录，恢复后重查；'+next_action;}
  if(truncated){missing=[missing,'匹配日志或在途列表未列全'].filter(Boolean).join('；');next_action+='；只查询最近 500 条日志，或只显示前 20 条匹配，请管理员核对其余记录';}
  return {tool,active_total:running.length,active,completed,truncated,...(missing?{missing}:{}),next_action};
}

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { argumentDigest } from '../records/api.ts';
import type { ServerDeps } from './api.ts';
import { callStatus } from './call-status.ts';
import { beginObservedCall } from './inflight-calls.ts';

const alice={id:'usr_01hzzzzzzzzzzzzzzzzzzzza',name:'synthetic-a',role:'user' as const};
const bob={id:'usr_01hzzzzzzzzzzzzzzzzzzzzzzb',name:'synthetic-b',role:'user' as const};
const args={pack:'synthetic',inputs:{subject:{reference:'src:'+'a'.repeat(64)}},parameters:{private_text:'synthetic input'}};
const run='run_'+'1'.repeat(26),digest='b'.repeat(64),trace='1'.repeat(32),at='2035-06-07T08:09:10.000Z';
function fixture(){
  const logs:any[]=[];let next:string|null=null;
  const deps={now:()=>new Date(at),records:{callLog:{query:async(_user:unknown,q:{userId:string;tool:string})=>({items:logs.filter(row=>row.user===q.userId&&row.tool===q.tool),next})},store:{find:async()=>({items:[{digest}],next:null})}},runs:{getRun:async()=>({run:{run},production:{record:'c'.repeat(64)}})}} as unknown as ServerDeps;
  return {deps,logs,setNext:(value:string|null)=>{next=value;}};
}
test('identical concurrent calls stay distinct, other users and other exact arguments cannot see them',async()=>{
  const {deps}=fixture(),end1=beginObservedCall(deps,alice.id,'start_run',args,trace),end2=beginObservedCall(deps,alice.id,'start_run',args,'2'.repeat(32));
  try{
    const current=await callStatus(deps,alice,'start_run',args);assert.equal(current.active_total,2);assert.equal(current.active.length,2);assert.match(current.missing!,/完成结果/);assert.match(current.next_action,/不重复/);
    assert.equal((await callStatus(deps,bob,'start_run',args)).active_total,0);
    assert.equal((await callStatus(deps,alice,'start_run',{...args,pack:'other'})).active_total,0);
    const restarted={...deps} as ServerDeps;
    const unknown=await callStatus(restarted,alice,'start_run',args);assert.equal(unknown.active_total,0);assert.match(unknown.missing!,/可能/);assert.match(unknown.next_action,/不要据此推定失败/);
    end1();assert.equal((await callStatus(deps,alice,'start_run',args)).active_total,1);
    assert.ok(!JSON.stringify(current).includes('synthetic input'));
  }finally{end1();end2();}
});
test('completed starts recover visible record references and incomplete history stays unknown',async()=>{
  const {deps,logs,setNext}=fixture();
  logs.push({user:alice.id,tool:'start_run',args_digest:argumentDigest(args).digest,trace_id:trace,at,call_result:'ok',error_code:null,duration_ms:19,run});
  const result=await callStatus(deps,alice,'start_run',args);assert.equal(result.active_total,0);assert.equal(result.completed.length,1);
  assert.equal(result.completed[0].run,run);assert.equal(result.completed[0].run_record,`rec:${digest}`);assert.equal(result.completed[0].result_record,`rec:${'c'.repeat(64)}`);assert.match(result.next_action,/无需重新开始/);
  assert.match(result.missing!,/不能确认/);
  const exact=await callStatus(deps,alice,'start_run',args,trace);assert.equal(exact.missing,undefined);assert.equal(exact.completed.length,1);
  const wrong=await callStatus(deps,alice,'start_run',args,'2'.repeat(32));assert.equal(wrong.completed.length,0);assert.match(wrong.missing!,/没有匹配/);
  const unreadable={...deps,runs:{getRun:async()=>null}} as unknown as ServerDeps;
  const hidden=await callStatus(unreadable,alice,'start_run',args);assert.equal(hidden.completed[0].run,null);assert.equal(hidden.completed[0].run_record,undefined);
  const absent=await callStatus(deps,bob,'start_run',args);assert.match(absent.missing!,/没有匹配/);assert.match(absent.next_action,/不要据此推定失败/);
  setNext('more');const partial=await callStatus(deps,bob,'start_run',args);assert.equal(partial.truncated,true);assert.match(partial.next_action,/更早/);
});
test('a completed read never pretends its lost response body was stored',async()=>{
  const {deps,logs}=fixture(),read={root:'d'.repeat(64),paths:['/synthetic']};
  logs.push({user:alice.id,tool:'get_nodes',args_digest:argumentDigest(read).digest,trace_id:trace,at,call_result:'ok',error_code:null,duration_ms:20,run:null});
  const status=await callStatus(deps,alice,'get_nodes',read);assert.match(status.missing!,/原回答正文未存档/);assert.match(status.next_action,/当前权限重读/);
});
test('a reused trace does not collapse distinct calls into one',async()=>{
  const {deps}=fixture(),end1=beginObservedCall(deps,alice.id,'start_run',args,trace),end2=beginObservedCall(deps,alice.id,'start_run',args,trace);
  try{const status=await callStatus(deps,alice,'start_run',args,trace);assert.equal(status.active_total,2);assert.equal(status.active.length,2);assert.match(status.missing!,/不能确认哪一条/);assert.match(status.next_action,/多条/);}
  finally{end1();end2();}
});
test('completion diagnostics expose only the code, never private admin reasons or arguments',async()=>{
  const {deps,logs}=fixture();
  logs.push({user:alice.id,tool:'start_run',args_digest:argumentDigest(args).digest,trace_id:trace,at,call_result:'error',error_code:'SOURCE_RETRYABLE',duration_ms:18,run:null,admin_reasons:['synthetic private admin reason']});
  const status=await callStatus(deps,alice,'start_run',args,trace);assert.equal(status.completed[0].error_code,'SOURCE_RETRYABLE');
  assert.match(status.missing!,/错误详情/);assert.match(status.next_action,/管理员/);
  assert.ok(!JSON.stringify(status).includes('synthetic private admin reason'));assert.ok(!JSON.stringify(status).includes('synthetic input'));
});
test('repeated completed calls to the same run share one current permission lookup',async()=>{
  const {deps,logs}=fixture();let reads=0;
  deps.runs.getRun=async()=>{reads++;return {run:{run},production:null} as any;};
  for(let i=1;i<=3;i++)logs.push({user:alice.id,tool:'start_run',args_digest:argumentDigest(args).digest,trace_id:String(i).repeat(32),at,call_result:'ok',error_code:null,duration_ms:1,run});
  const status=await callStatus(deps,alice,'start_run',args);assert.equal(status.completed.length,3);assert.equal(reads,1);assert.match(status.missing!,/不能确认/);
});
test('a failed log read is an explicit missing fact, while an observed in-flight call stays visible',async()=>{
  const {deps}=fixture(),end=beginObservedCall(deps,alice.id,'start_run',args,trace);
  deps.records.callLog.query=async()=>{throw new Error('synthetic internal detail');};
  try{const status=await callStatus(deps,alice,'start_run',args,trace);assert.equal(status.active_total,1);assert.match(status.missing!,/调用日志当前不可读/);assert.match(status.next_action,/管理员恢复调用日志/);assert.ok(!JSON.stringify(status).includes('synthetic internal detail'));}
  finally{end();}
});
test('a failed run lookup stays unknown and does not reveal internal errors',async()=>{
  const {deps,logs}=fixture();
  logs.push({user:alice.id,tool:'start_run',args_digest:argumentDigest(args).digest,trace_id:trace,at,call_result:'ok',error_code:null,duration_ms:18,run});
  deps.runs.getRun=async()=>{throw new Error('synthetic private storage error');};
  const status=await callStatus(deps,alice,'start_run',args,trace);
  assert.equal(status.completed[0].run,null);assert.match(status.missing!,/记录读取未完成/);assert.match(status.next_action,/恢复运行记录读取/);assert.ok(!JSON.stringify(status).includes('synthetic private storage error'));
});
test('a fact-only run without its production record reports the missing result',async()=>{
  const {deps,logs}=fixture();
  logs.push({user:alice.id,tool:'start_run',args_digest:argumentDigest(args).digest,trace_id:trace,at,call_result:'ok',error_code:null,duration_ms:18,run});
  deps.runs.getRun=async()=>({run:{run,requirements:[{accepted_producer:'fact'}]},production:null}) as any;
  const status=await callStatus(deps,alice,'start_run',args,trace);
  assert.equal(status.completed[0].run_record,`rec:${digest}`);assert.equal(status.completed[0].result_record,undefined);
  assert.match(status.missing!,/生产结果记录/);assert.match(status.next_action,/恢复后重查/);
});

import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setup} from './testing/context.ts';
import {DispatchService} from './service.ts';
import {probes} from './testing/probes.ts';
import {canonicalBytes} from '../records/api.ts';
const marker='#######   end case: ';
const ITEMS=['synthetic-1','synthetic-2','synthetic-3'];
const closed=(id:string)=>`step lines of ${id}\n${marker}${id}`;
const unclosed=(id:string)=>`step lines of ${id}\nthe runner's report of an uncaught exception\n######      FAIL      ######`;
const OLD_NEXT='按该指针对照已保存原件：原件未齐时稍后 job resume；原件已齐时修正执行器 result 相对指针或完全相等映射后 job resume；不重交';
async function fixture(cases:()=>unknown[],items:string[]=ITEMS){
 const c=await setup({items,extraTools:['inspect_seat'],alter:(name,value)=>{
  const args=c.endpoint.calls.filter(call=>call.params.name===name).at(-1)?.params.arguments as Record<string,unknown>;
  if(name==='inspect_seat')return {output:args.command==='inspect version'?'version: synthetic-build':`address: 192.0.2.${Number(args.seat)+1}/24`};
  if(name==='read_blob')return {ok:true,complete:false,channel:'missing_after_done',rc:1,ownership:'staging_directory',task_id:value.key,request_id:value.request,xlsx_sha256:value.digest,submitted_at:value.submitted,cases:cases()};
  return value;
 }});
 const manifest=await c.kit.artifacts.ingest({bytes:canonicalBytes({id:'synthetic-bed',devices:[1,2].map(n=>({interfaces:[{address:`192.0.2.${n}/24`}]}))}),mediaType:'application/json',origin:{upload:{session:'synthetic'}},author:{user:c.owner.id},provenanceType:'declared',visibility:{readers:[c.owner.id],admins:true,packs:[],shareable:false}});
 c.detail.run.sources=c.detail.run.sources.map(source=>source.slot==='synthetic-manifest'?{...source,reference:'src:'+manifest.body.sha256}:source);(c.detail.latest!.result.partitions.delivered[0].requirements[0].claims[0].statement.data as any).bed.manifest_sha256=manifest.body.sha256;c.effectDocument.effects[0].parameters.values.manifest_sha256=[manifest.body.sha256];
 const proof=await c.kit.artifacts.ingest({bytes:Buffer.from('synthetic result ownership certification'),mediaType:'text/plain',origin:{upload:{session:'synthetic'}},author:{user:c.admin.id},provenanceType:'declared',visibility:{readers:[c.admin.id],admins:true,packs:[],shareable:false}});
 const result={...c.executor.definition.result,ownership:{pointer:'/ownership',value:'staging_directory',reason:'/ownership_reason'},request_id:'/request_id',id:'/task_id',sha256:'/xlsx_sha256',submitted_at:'/submitted_at',items:'/cases',item_id:'/case_id',item_outcome:'/result',map:{PASS:'pass' as const,FAIL:'fail' as const},log:'/log',sessions:'/sessions',log_stale:'/log_stale',closing_marker:marker};
 await c.registry.update(c.admin,c.executor.id,{...c.executor.definition,manifest_sha256:manifest.body.sha256,allowed_tools:[...c.executor.definition.allowed_tools,'inspect_seat'],probes,premises:{result_ownership:{version:'1',evidence:['src:'+proof.body.sha256]}},result});await c.freezeExecutor();
 return {...c,service:new DispatchService({...c.service.options,sleep:async()=>{}})};
}
async function report(c:Awaited<ReturnType<typeof fixture>>,reference:string){const source=await c.kit.artifacts.source(c.admin,reference.slice(4));assert.ok(source?.bytes);return JSON.parse(Buffer.from(source.bytes).toString());}
const sessions={'device-a':'session text'};

test('a workbook whose execution ended inside an item is told so in the checks, the rows and the complete record, without advice to wait',async t=>{
 const c=await fixture(()=>[
  {case_id:ITEMS[0],result:'FAIL',log_stale:false,log:closed(ITEMS[0]),sessions},
  {case_id:ITEMS[1],result:'FAIL',log_stale:false,log:unclosed(ITEMS[1]),sessions},
  {case_id:ITEMS[2],result:null,log_stale:false,log:''},
 ]);t.after(()=>c.close());
 const state=await c.service.dispatch(c.admin,c.run,c.executor.id),value=await report(c,state.result!);
 assert.deepEqual(value.rows.map((row:{item:string})=>row.item),ITEMS);
 assert.deepEqual(value.rows.map((row:{dynamic_terminal:string})=>row.dynamic_terminal),['no_verdict','no_verdict','no_verdict']);
 assert.deepEqual(value.rows.map((row:{missing_facts:string[]})=>row.missing_facts),[['complete','report'],['complete','closed','report'],['complete','closed','report']]);
 assert.equal(value.report_pending,true);assert.equal(state.report_pending,true);
 for(const row of value.rows){
  assert.equal(row.report_check.condition,'result.complete');assert.equal(row.report_check.resolved,false);assert.equal(row.report_check.pointer,'/complete');
  assert.equal(row.missing_fact,row.report_check.missing_fact);assert.equal(row.next_action,row.report_check.next_action);
  assert.ok(row.missing_fact.startsWith('结果完整字段 /complete 尚不为 true，缺完整报告'));
  assert.doesNotMatch(row.next_action,/稍后 job resume/);assert.match(row.next_action,/synthetic-2 的日志/);
 }
 assert.match(value.rows[0].missing_fact,/执行在条目 synthetic-2 处结束，其后 1 条没有到达，整份报告因此不完整，本条没有判定/);
 assert.match(value.rows[1].missing_fact,/执行在本条处结束，本条日志没有收尾标记，其后 1 条（synthetic-3）没有日志、会话和结果/);
 assert.match(value.rows[2].missing_fact,/本条没有日志、会话和结果，执行在条目 synthetic-2 处结束，没有到达本条/);
 const complete=(await c.service.journal.events(state.job)).filter(event=>event.body.detail.phase==='complete').at(-1)!.body.detail;
 assert.equal(complete.report_pending,true);assert.equal(complete.next_action,value.rows[0].next_action);
 assert.doesNotMatch(String(complete.next_action),/稍后 job resume/);assert.ok(String(complete.missing_fact).includes('执行在本条处结束，本条日志没有收尾标记'));
 assert.equal(state.next_action,value.rows[0].next_action);
 assert.equal(c.calls.filter(call=>call==='send_blob').length,1);
});

test('the complete record says a missing fact once however many items share it',async t=>{
 const items=[...ITEMS,'synthetic-4'];
 const c=await fixture(()=>[
  {case_id:items[0],result:'FAIL',log_stale:false,log:closed(items[0]),sessions},
  {case_id:items[1],result:'FAIL',log_stale:false,log:unclosed(items[1]),sessions},
  {case_id:items[2],result:null,log_stale:false,log:''},
  {case_id:items[3],result:null,log_stale:false,log:''},
 ],items);t.after(()=>c.close());
 const state=await c.service.dispatch(c.admin,c.run,c.executor.id),value=await report(c,state.result!);
 assert.deepEqual(value.rows.map((row:{item:string})=>row.item),items);
 assert.equal(value.rows[2].missing_fact,value.rows[3].missing_fact,'the two items after the stop say the same');
 const complete=(await c.service.journal.events(state.job)).filter(event=>event.body.detail.phase==='complete').at(-1)!.body.detail;
 const said=String(complete.missing_fact).replace('原请求已执行结束，判定仍缺事实：','').split('；');
 assert.equal(said.length,3,'the item before the stop, the item it stopped in and the items after it, one sentence each');
 assert.equal(new Set(said).size,3);
});

test('a report that is incomplete while every item was reached keeps the advice to read it again later, in the rows and the complete record',async t=>{
 const c=await fixture(()=>ITEMS.map(id=>({case_id:id,result:'PASS',log_stale:false,log:closed(id)})));t.after(()=>c.close());
 const state=await c.service.dispatch(c.admin,c.run,c.executor.id),value=await report(c,state.result!);
 assert.equal(value.report_pending,true);
 for(const row of value.rows){assert.equal(row.missing_fact,'结果完整字段 /complete 尚不为 true，缺完整报告');assert.equal(row.next_action,OLD_NEXT);assert.deepEqual(row.missing_facts,['complete','report']);}
 const complete=(await c.service.journal.events(state.job)).filter(event=>event.body.detail.phase==='complete').at(-1)!.body.detail;
 assert.equal(complete.next_action,OLD_NEXT);assert.equal(state.next_action,OLD_NEXT);
});

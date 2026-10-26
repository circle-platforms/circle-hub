import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setup} from './testing/context.ts';
import {DispatchService} from './service.ts';
import {probes} from './testing/probes.ts';
import {canonicalBytes} from '../records/api.ts';
const marker='#######   end case: ';
async function fixture(kind:'correct'|'pointer'|'map'='correct'){
 const c=await setup({extraTools:['inspect_seat'],alter:(name,value)=>{
  const args=c.endpoint.calls.filter(call=>call.params.name===name).at(-1)?.params.arguments as Record<string,unknown>;
  if(name==='inspect_seat')return {output:args.command==='inspect version'?'version: synthetic-build':`address: 192.0.2.${Number(args.seat)+1}/24`};
  // Synthetic identity echoes preserve the original request; the result shape is cases[].result=pass,
  // complete=true, owned staging directory, exact closing marker, and no sessions on success.
  if(name==='read_blob')return {ok:true,complete:true,channel:'ready',rc:0,ownership:'staging_directory',task_id:value.key,request_id:value.request,xlsx_sha256:value.digest,submitted_at:value.submitted,cases:[{case_id:'synthetic-case',result:'pass',log_stale:false,log:'check one successed to find\ncheck two successed to find\n'+marker+'synthetic-case'}]};
  return value;
 }});
 const manifest=await c.kit.artifacts.ingest({bytes:canonicalBytes({id:'synthetic-bed',devices:[1,2].map(n=>({interfaces:[{address:`192.0.2.${n}/24`}]}))}),mediaType:'application/json',origin:{upload:{session:'synthetic'}},author:{user:c.owner.id},provenanceType:'declared',visibility:{readers:[c.owner.id],admins:true,packs:[],shareable:false}});
 c.detail.run.sources=c.detail.run.sources.map(source=>source.slot==='synthetic-manifest'?{...source,reference:'src:'+manifest.body.sha256}:source);(c.detail.latest!.result.partitions.delivered[0].requirements[0].claims[0].statement.data as any).bed.manifest_sha256=manifest.body.sha256;c.effectDocument.effects[0].parameters.values.manifest_sha256=[manifest.body.sha256];
 const proof=await c.kit.artifacts.ingest({bytes:Buffer.from('synthetic result ownership certification'),mediaType:'text/plain',origin:{upload:{session:'synthetic'}},author:{user:c.admin.id},provenanceType:'declared',visibility:{readers:[c.admin.id],admins:true,packs:[],shareable:false}});
 const result={...c.executor.definition.result,ownership:{pointer:'/ownership',value:'staging_directory',reason:'/ownership_reason'},request_id:'/request_id',id:'/task_id',sha256:'/xlsx_sha256',submitted_at:'/submitted_at',items:'/cases',item_id:'/case_id',item_outcome:kind==='pointer'?'/outcome':'/result',map:kind==='map'?{good:'pass' as const,bad:'fail' as const}:{pass:'pass' as const,fail:'fail' as const},log:'/log',sessions:'/sessions',log_stale:'/log_stale',closing_marker:marker};
 await c.registry.update(c.admin,c.executor.id,{...c.executor.definition,manifest_sha256:manifest.body.sha256,allowed_tools:[...c.executor.definition.allowed_tools,'inspect_seat'],probes,premises:{result_ownership:{version:'1',evidence:['src:'+proof.body.sha256]}},result,limitations:['合成声明：仅未通过用例提供 sessions']});await c.freezeExecutor();
 const logs:unknown[]=[];const service=new DispatchService({...c.service.options,sleep:async()=>{},adminLog:entry=>logs.push(entry)});
 return {...c,service,logs};
}
async function report(c:Awaited<ReturnType<typeof fixture>>,reference:string){const source=await c.kit.artifacts.source(c.admin,reference.slice(4));assert.ok(source?.bytes);return JSON.parse(Buffer.from(source.bytes).toString());}
test('same-shaped pass result without optional sessions is a qualified PASS with the exact declared map',async t=>{
 const c=await fixture();t.after(()=>c.close());const state=await c.service.dispatch(c.admin,c.run,c.executor.id),value=await report(c,state.result!);
 assert.equal(value.rows[0].dynamic_terminal,'pass');assert.deepEqual(value.rows[0].missing_facts,[]);assert.equal(value.rows[0].report_check.resolved,true);assert.equal(value.rows[0].report_check.pointer,'/cases/0/result');
 assert.equal(c.calls.filter(call=>call==='send_blob').length,1);assert.equal(value.rows[0].accepted_as_fact,false);
});
for(const kind of ['pointer','map'] as const)test('report gap names '+kind+' and a read-only definition repair resolves it without another submit',async t=>{
 const c=await fixture(kind);t.after(()=>c.close());const initial=await c.service.dispatch(c.admin,c.run,c.executor.id),old=await report(c,initial.result!);const row=old.rows[0];
 assert.equal(row.dynamic_terminal,'no_verdict');assert.deepEqual(row.missing_facts,['report']);assert.equal(row.report_check.condition,kind==='pointer'?'result.item_outcome':'result.map');assert.equal(row.report_check.pointer,kind==='pointer'?'/cases/0/outcome':'/cases/0/result');
 assert.ok(row.missing_fact.includes(row.report_check.pointer));assert.ok(initial.missing_fact?.includes(row.report_check.pointer));assert.ok(c.logs.some(log=>JSON.stringify(log).includes(row.report_check.condition)));assert.ok(!JSON.stringify(row.report_check).includes('successed'));
 const definition=(await c.registry.get(c.executor.id))!.definition;await c.registry.update(c.admin,c.executor.id,{...definition,result:{...definition.result,item_outcome:'/result',map:{pass:'pass',fail:'fail'}}});const before=c.calls.length;
 const refreshed=await c.service.resume(c.admin,initial.job),next=await report(c,refreshed.result!);assert.equal(next.rows[0].dynamic_terminal,'pass');assert.notEqual(refreshed.result,initial.result);assert.ok(c.calls.slice(before).every(call=>call==='inspect_blob'||call==='read_blob'));assert.equal(c.calls.filter(call=>call==='send_blob').length,1);
});

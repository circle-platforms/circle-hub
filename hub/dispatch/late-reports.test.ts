import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setup} from './testing/context.ts';
import {DispatchService} from './service.ts';
import {probes} from './testing/probes.ts';
import {canonicalBytes} from '../records/api.ts';
import {REPORT_READ_ATTEMPTS} from './report-read.ts';
async function fixture(initiallyReady=false,readyAfter?:number,legacyReportOnly=false){
 let ready=initiallyReady,reads=0,closed=false;
 const c=await setup({extraTools:['inspect_seat'],alter:(name,value)=>{
  const args=c.endpoint.calls.filter(call=>call.params.name===name).at(-1)?.params.arguments as Record<string,unknown>;
  if(name==='inspect_seat')return {output:args.command==='inspect version'?'version: synthetic-build':`address: 192.0.2.${Number(args.seat)+1}/24`};
  if(name==='close_slot')closed=true;
  if(name==='touch_slot'&&closed)return {...value,ok:false};
  if(name==='read_blob'){
   reads++;const complete=ready||(readyAfter!==undefined&&reads>=readyAfter);
   return {...value,ownership:'staging_directory',complete:legacyReportOnly?true:complete,rows:complete||legacyReportOnly?[{id:'synthetic-case',outcome:complete?'good':'unreported',log:'CHECK_ONE_PASS\nCHECK_TWO_PASS\nSYNTHETIC_END',stale:false}]:[]};
  }
  return value;
 }});
 const manifest=await c.kit.artifacts.ingest({bytes:canonicalBytes({id:'synthetic-bed',devices:[1,2].map(n=>({interfaces:[{address:`192.0.2.${n}/24`}]}))}),mediaType:'application/json',origin:{upload:{session:'synthetic'}},author:{user:c.owner.id},provenanceType:'declared',visibility:{readers:[c.owner.id],admins:true,packs:[],shareable:false}});
 c.detail.run.sources=c.detail.run.sources.map(source=>source.slot==='synthetic-manifest'?{...source,reference:'src:'+manifest.body.sha256}:source);
 (c.detail.latest!.result.partitions.delivered[0].requirements[0].claims[0].statement.data as any).bed.manifest_sha256=manifest.body.sha256;c.effectDocument.effects[0].parameters.values.manifest_sha256=[manifest.body.sha256];
 const certification=await c.kit.artifacts.ingest({bytes:Buffer.from('synthetic ownership certification'),mediaType:'text/plain',origin:{upload:{session:'synthetic'}},author:{user:c.admin.id},provenanceType:'declared',visibility:{readers:[c.admin.id],admins:true,packs:[],shareable:false}});
 await c.registry.update(c.admin,c.executor.id,{...c.executor.definition,manifest_sha256:manifest.body.sha256,allowed_tools:[...c.executor.definition.allowed_tools,'inspect_seat'],probes,premises:{result_ownership:{version:'1',evidence:['src:'+certification.body.sha256]}},result:{...c.executor.definition.result,ownership:{pointer:'/ownership',value:'staging_directory',reason:'/ownership_reason'},request_id:'/request',log:'/log',log_stale:'/stale',closing_marker:'SYNTHETIC_END'}});await c.freezeExecutor();
 return {...c,service:new DispatchService({...c.service.options,sleep:async()=>{}}),setReady(){ready=true;},get reportReads(){return reads;}};
}
async function report(c:Awaited<ReturnType<typeof fixture>>,reference:string){const source=await c.kit.artifacts.source(c.admin,reference.slice(4));assert.ok(source?.bytes);return JSON.parse(Buffer.from(source.bytes).toString());}
test('an ended gateway with a late report is polled until the second complete case_results, with one submit',async t=>{
 const c=await fixture(false,2);t.after(()=>c.close());const state=await c.service.dispatch(c.admin,c.run,c.executor.id);
 assert.equal(c.reportReads,2);assert.equal(c.calls.filter(call=>call==='send_blob').length,1);
 const value=await report(c,state.result!);assert.equal(value.rows[0].dynamic_terminal,'pass');assert.equal(state.report_pending,undefined);
 const events=await c.service.journal.events(state.job);assert.equal(events.filter(event=>event.body.detail.phase==='intent').length,1);assert.ok(events.some(event=>event.body.detail.phase==='report_wait'));
});
test('a bounded report wait can resume read-only after lease release and append a usable result',async t=>{
 const c=await fixture();t.after(()=>c.close());
 const pending=await c.service.dispatch(c.admin,c.run,c.executor.id);assert.equal(c.reportReads,REPORT_READ_ATTEMPTS);assert.equal(pending.report_pending,true);assert.equal((await report(c,pending.result!)).rows[0].dynamic_terminal,'no_verdict');
 const previous=await c.service.journal.events(pending.job),old=Buffer.from((await c.kit.objects.get(pending.result!.slice(4)))!);const before=c.calls.length;c.setReady();
 const refreshed=await c.service.resume(c.admin,pending.job),value=await report(c,refreshed.result!);
 assert.equal(value.rows[0].dynamic_terminal,'pass');assert.equal(value.lease_interrupted,false);assert.equal(value.lease_drift,false);assert.notEqual(refreshed.result,pending.result);assert.ok(refreshed.events>pending.events);
 assert.ok(c.calls.slice(before).includes('inspect_blob'));assert.ok(c.calls.slice(before).includes('read_blob'));assert.ok(c.calls.slice(before).every(call=>call==='inspect_blob'||call==='read_blob'));
 assert.equal(c.calls.filter(call=>call==='send_blob').length,1);assert.deepEqual(Buffer.from((await c.kit.objects.get(pending.result!.slice(4)))!),old);
 const after=await c.service.journal.events(pending.job);assert.deepEqual(after.slice(0,previous.length).map(event=>event.digest),previous.map(event=>event.digest));
});
test('legacy done=true no_verdict snapshots are refreshed from their saved declared raw report fields',async t=>{
 const c=await fixture();t.after(()=>c.close());(c.effectDocument.effects[0] as {repetition?:number}).repetition=2;
 const pending=await c.service.dispatch(c.admin,c.run,c.executor.id),binding=await c.service.journal.binding(pending.job);const value=await report(c,pending.result!);delete value.report_pending;
 const source=await c.kit.artifacts.ingest({bytes:canonicalBytes(value),mediaType:'application/json',origin:{generated:{generator:'dispatch@1',inputs:[pending.result!]}},author:{user:null},provenanceType:'projected',visibility:{readers:[c.owner.id],admins:true,packs:[],shareable:false}});
 await c.service.journal.append(binding,'result','read_back','completed',{reference:'src:'+source.body.sha256,no_verdict:1,items:1});
 await c.service.journal.append(binding,'complete','read_back','completed',{done:true,outcome:'effective',missing_fact:'合成旧报告尚未生成'});
 const legacy=await c.service.status(c.admin,pending.job);c.setReady();const before=c.calls.length;
 const refreshed=await c.service.resume(c.admin,pending.job);assert.equal((await report(c,refreshed.result!)).rows[0].dynamic_terminal,'pass');assert.notEqual(refreshed.result,legacy.result);assert.ok(refreshed.events>legacy.events);assert.deepEqual(refreshed.rounds?.map(round=>[round.round,round.terminal]),[[1,'pass']]);
 assert.ok(c.calls.slice(before).every(call=>call==='inspect_blob'||call==='read_blob'));assert.equal(c.calls.filter(call=>call==='send_blob').length,1);
});
test('late report refresh preserves a real execution-window integrity gap instead of repairing it retroactively',async t=>{
 const c=await fixture();t.after(()=>c.close());
 const holder=c.service.options.leases.holderSnapshot.bind(c.service.options.leases);let broken=false;
 c.service.options.leases.holderSnapshot=async keys=>{const rows=await holder(keys);return broken?rows.map(row=>({...row,released:true})):rows;};
 const original=c.service.journal.append.bind(c.service.journal);c.service.journal.append=async(...args)=>{if(args[1]==='terminal')broken=true;return original(...args);};
 const pending=await c.service.dispatch(c.admin,c.run,c.executor.id);assert.equal((await report(c,pending.result!)).lease_drift,true);broken=false;c.setReady();
 const refreshed=await c.service.resume(c.admin,pending.job),value=await report(c,refreshed.result!);assert.equal(value.rows[0].dynamic_terminal,'no_verdict');assert.ok(value.rows[0].missing_facts.includes('continuity'));assert.equal(c.calls.filter(call=>call==='send_blob').length,1);
});

test('pre-fix complete=true report-only unknown archives resume even when the old raw value is nonempty',async t=>{
 const c=await fixture(false,undefined,true);t.after(()=>c.close());
 const first=await c.service.dispatch(c.admin,c.run,c.executor.id),binding=await c.service.journal.binding(first.job),current=await report(c,first.result!);
 assert.equal(current.rows[0].dynamic_terminal,'no_verdict');assert.equal(current.rows[0].reason,'integrity_unproven');assert.deepEqual(current.rows[0].missing_facts,['report']);assert.equal(c.reportReads,1);
 // Exact pre-8cb0de91 projection shape, not a report_pending=true fixture: complete=true and a present
 // unreported outcome are what made the old result unusable despite all other integrity facts being present.
 const legacy={job:first.job,sha256:binding.input!.sha256,rows:current.rows,ownership:current.ownership,side_effects:current.side_effects,executor_declarations:current.executor_declarations,lease_drift:false,lease_interrupted:false,qualifier_marks:current.qualifier_marks,limits:current.limits};
 const source=await c.kit.artifacts.ingest({bytes:canonicalBytes(legacy),mediaType:'application/json',origin:{generated:{generator:'dispatch@1',inputs:[first.result!]}},author:{user:null},provenanceType:'projected',visibility:{readers:[c.owner.id],admins:true,packs:[],shareable:false}});
 await c.service.journal.append(binding,'result','read_back','completed',{reference:'src:'+source.body.sha256,items:1,no_verdict:1});
 await c.service.journal.append(binding,'complete','read_back','completed',{done:true,outcome:'effective',missing_fact:'动态完整性事实尚不齐全；见 missing_facts 和下一步'});
 const archived=await c.service.status(c.admin,first.job),history=await c.service.journal.events(first.job),before=c.calls.length;c.setReady();
 const next=await c.service.resume(c.admin,first.job);
 assert.ok(c.calls.length>before,'resume must reach the gateway instead of the completed-cache branch');
 assert.ok(c.calls.slice(before).includes('inspect_blob'));assert.ok(c.calls.slice(before).includes('read_blob'));assert.ok(c.calls.slice(before).every(call=>call==='inspect_blob'||call==='read_blob'));
 assert.equal(c.calls.filter(call=>call==='send_blob').length,1);assert.equal((await report(c,next.result!)).rows[0].dynamic_terminal,'pass');assert.notEqual(next.result,archived.result);assert.ok(next.events>archived.events);
 assert.deepEqual((await c.service.journal.events(first.job)).slice(0,history.length).map(event=>event.digest),history.map(event=>event.digest));
});

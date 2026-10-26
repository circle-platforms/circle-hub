import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setup} from './testing/context.ts';
import {probes} from './testing/probes.ts';
import {canonicalBytes,sha256Hex} from '../records/api.ts';
import {judgmentClaim} from '../runs/engine/claims.ts';
import {verifyInput} from './proof.ts';
import {dynamicDisposition} from './dynamic.ts';
function premise(submission:string){const pointer='/items/0/slots/plan/0/data/expects/0';return judgmentClaim({item:'synthetic-item',requirement:'workbook_verified',pointer,text:'service enabled',data:{basis:'model_judgment',rationale:'模型选择合成设备可观察状态行，不断言判断正确',quote:{reference:'src:'+'a'.repeat(64),text:'[check1]合成配置添加成功'},after:1,model:'synthetic-choice-model',judgment_source:{submission,pointer}},model:'synthetic-choice-model',marks:['conditional_on_judgment'],sourceRole:'artifact_under_verification',grounds:[],resolutions:[],bound:[submission],premises:[pointer]});}
test('released device pass and fail remain conditional on the frozen model choice with rationale and identity',async t=>{
 for(const outcome of ['good','bad']){
  const c=await setup({extraTools:['inspect_seat'],alter:(name,value)=>{
    const args=c.endpoint.calls.filter(call=>call.params.name===name).at(-1)?.params.arguments as Record<string,unknown>;
    if(name==='inspect_seat')return {output:args.command==='inspect version'?'version: synthetic-build':`address: 192.0.2.${Number(args.seat)+1}/24`};
    if(name==='read_blob')return {...value,ownership:'staging_directory',rows:[{id:'synthetic-case',outcome,log:'SYNTHETIC_END',stale:false}]};return value;
  }});t.after(()=>c.close());
  const submission=sha256Hex('synthetic model-selected checks');c.detail.latest!.result.submission=submission;
  c.detail.latest!.result.partitions.delivered[0].requirements[0].claims.push(premise(submission));
  const manifest=await c.kit.artifacts.ingest({bytes:canonicalBytes({id:'synthetic-bed',devices:[1,2].map(n=>({interfaces:[{address:`192.0.2.${n}/24`}]}))}),mediaType:'application/json',origin:{upload:{session:'synthetic'}},author:{user:c.owner.id},provenanceType:'declared',visibility:{readers:[c.owner.id],admins:true,packs:[],shareable:false}});
  c.detail.run.sources=c.detail.run.sources.map(source=>source.slot==='synthetic-manifest'?{...source,reference:'src:'+manifest.body.sha256}:source);
  (c.detail.latest!.result.partitions.delivered[0].requirements[0].claims[0].statement.data as any).bed.manifest_sha256=manifest.body.sha256;c.effectDocument.effects[0].parameters.values.manifest_sha256=[manifest.body.sha256];
  const certification=await c.kit.artifacts.ingest({bytes:Buffer.from('synthetic ownership certification'),mediaType:'text/plain',origin:{upload:{session:'synthetic'}},author:{user:c.admin.id},provenanceType:'declared',visibility:{readers:[c.admin.id],admins:true,packs:[],shareable:false}});
  await c.registry.update(c.admin,c.executor.id,{...c.executor.definition,manifest_sha256:manifest.body.sha256,allowed_tools:[...c.executor.definition.allowed_tools,'inspect_seat'],probes,premises:{result_ownership:{version:'1',evidence:['src:'+certification.body.sha256]}},result:{...c.executor.definition.result,ownership:{pointer:'/ownership',value:'staging_directory',reason:'/ownership_reason'},request_id:'/request',log:'/log',log_stale:'/stale',closing_marker:'SYNTHETIC_END'}});await c.freezeExecutor();
  const state=await c.service.dispatch(c.admin,c.run,c.executor.id);assert.equal(state.outcome,'effective');assert.ok(state.qualifier_marks?.includes('conditional_on_judgment'));
  const source=await c.kit.artifacts.source(c.admin,state.result!.slice(4));assert.ok(source?.bytes);const report=JSON.parse(Buffer.from(source.bytes).toString());
  assert.equal(report.rows[0].dynamic_terminal,outcome==='good'?'pass':'fail');assert.equal(report.rows[0].accepted_as_fact,false);assert.ok(report.rows[0].qualifier.marks.includes('conditional_on_judgment'));assert.ok(report.rows[0].limits.includes('以判断为前提'));
  assert.equal(report.judgment_premises[0].statement.data.basis,'model_judgment');assert.equal(report.judgment_premises[0].warrant.id,'synthetic-choice-model');assert.ok(report.judgment_premises[0].statement.data.rationale);
 }
});
test('a stale or invalid model premise cannot be silently discarded to produce an unqualified release',async t=>{
 const c=await setup();t.after(()=>c.close());c.detail.latest!.result.submission=sha256Hex('current synthetic submission');c.detail.latest!.result.partitions.delivered[0].requirements[0].claims.push(premise(sha256Hex('old synthetic submission')));
 await assert.rejects(verifyInput(c.admin,c.run,c.executor.definition,c.kit,c.runs,c.workflows,c.now()));
});
test('default device judgment qualifications stay unchanged without an explicit model choice',()=>{
 const facts={owned:true,request:true,remote:true,digest:true,complete:true,unique:true,closed:true,device:true,continuity:true};assert.ok(!dynamicDisposition('pass',facts).qualifier.marks.includes('conditional_on_judgment'));
});

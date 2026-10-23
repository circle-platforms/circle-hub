// Coverage is an observation of the read, never inferred from the bytes of a partial source.
import assert from 'node:assert/strict';
import {toolText} from '../../server/text.ts';
import type {Coverage} from '../../../contracts/src/common.ts';
import {sourceCoverage,factClaim} from './claims.ts';
import {after,before,test} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {startPostgres,type TemporaryPostgres} from '../../testing/postgres.ts';
import {openHarness,sandboxSkip,type Harness} from './testing/harness.ts';
import {locatePack,writePack} from './testing/packs.ts';
let postgres:TemporaryPostgres,h:Harness,dir:string;const skip=await sandboxSkip();
const coverage={complete:false,examined:1,total:2,note:'合成：还有一个根待读；重读失败根后重新开始运行'};
let currentCoverage:Coverage=coverage;let firstRun:string;
before(async()=>{
  postgres=await startPostgres();if(skip)return;h=await openHarness(postgres);dir=await mkdtemp(join(tmpdir(),'read-coverage-'));
  h.external.put('toy:mindmap:partial',{bytes:new TextEncoder().encode(JSON.stringify({cases:[{id:'one'},{id:'two'}]})),mediaType:'application/json'});
  const read=h.external.read.bind(h.external);h.external.read=async(...args)=>{const value=await read(...args);return value.ok?{...value,coverage:args[0]==='toy:manual:coverage'?coverage:currentCoverage}:value;};
});after(async()=>{await h?.close();if(dir)await rm(dir,{recursive:true,force:true});await postgres?.stop();});
async function pack(expected=false){
  const spec=locatePack();spec.id='synthetic-read-coverage';
  spec.files['functions/project.ts']=`export default function(input){const s=input.inputs.find(s=>s.slot==='map');return {items:s.model.cases.map((n,i)=>({id:n.id,label:n.id,location:{parser:'json@1',selector:'p/cases/'+i},fields:{document:'docq7',path:['root'],expected:['state']}})),groups:[{nature:'fact',verdict:'support',message:'已读范围的合成说明',grounds:['src:'+s.sha256+'/json@1/p/cases']}],warnings:[]};}`;
  if(expected){
    h.external.put('toy:manual:coverage',{bytes:new TextEncoder().encode('合成 10.6 预期来源'),mediaType:'text/plain'});
    const flow=spec.files['workflow.json'] as {json:Record<string,unknown>};flow.json.expected_sources={module:'functions/expected.ts'};
    spec.files['functions/expected.ts']="export default function(){return {sources:[{external:'toy:manual:coverage',role:'expected',reason:'合成预期'}],warnings:[]}}";
    const checks=spec.files['checks.json'] as {json:{checks:Array<Record<string,unknown>>}};checks.json.checks.find(c=>c.id==='overview')!.reads={roles:['expected'],types:['toy:manual'],max_bytes:1024};
  }
  await h.workflows.add(await writePack(dir,spec));h.workflows.assign(h.alice.id,spec.id);return spec.id;
}
test('external input coverage is frozen and passed to item, run and projection fact qualifiers',{skip},async()=>{
  const id=await pack();const detail=await h.service.startRunDetailed(h.alice,{pack:id,inputs:{map:{external:'toy:mindmap:partial'}}},h.call());
  assert.equal(detail.answer.call_result,'ok',JSON.stringify(detail.answer.errors));
  assert.ok(detail.answer.run!.items.length>0);
  firstRun=detail.answer.run!.run;
  const binding=detail.answer.run!.sources.find(s=>s.slot==='map')!;assert.deepEqual(binding.coverage,coverage);
  const stored=await h.service.getRun(h.alice,detail.answer.run!.run);assert.deepEqual(stored!.run.sources.find(s=>s.slot==='map')!.coverage,coverage);
  const result=detail.production!.result;
  assert.match(toolText('start_run',{...detail.answer,trace:result.trace},{production:result}),/读取覆盖.*不完整/);
  const facts=[...Object.values(result.partitions).flat().flatMap(i=>i.requirements.flatMap(r=>r.claims)),...result.cross_item].filter(c=>c.warrant.producer==='function');
  assert.ok(facts.length>1);assert.ok(result.cross_item.some(c=>c.pointer==='/groups/0'));
  for(const fact of facts){assert.ok(fact.qualifier.marks.includes('partial'),fact.warrant.id);assert.deepEqual(fact.qualifier.coverage,coverage);}
});

 test('a later complete read does not upgrade the coverage frozen in an older run',{skip},async()=>{
   currentCoverage={complete:true,examined:1,total:1};const id=await pack();
   const detail=await h.service.startRunDetailed(h.alice,{pack:id,inputs:{map:{external:'toy:mindmap:partial'}}},h.call());
   assert.equal(detail.answer.call_result,'ok');
   for(const fact of Object.values(detail.production!.result.partitions).flat().flatMap(i=>i.requirements.flatMap(r=>r.claims)))assert.ok(!fact.qualifier.marks.includes('partial'));
   assert.deepEqual((await h.service.getRun(h.alice,firstRun))!.run.sources.find(s=>s.slot==='map')!.coverage,coverage);
 });
 test('coverage follows addressed sources without tainting an unrelated complete source',()=>{
   const partial='src:'+'a'.repeat(64),full='src:'+'b'.repeat(64);
   const sources=[{reference:partial,role:'subject' as const,coverage},{reference:full,role:'expected' as const,coverage:{complete:true,examined:2,total:2}}];
   const selected=sourceCoverage(sources,[full]);assert.deepEqual(selected,{complete:true,examined:2,total:2});
   const claim=factClaim({outcome:{verdict:'support',statement:'合成',grounds:[full]},coverage:selected,rule:'synthetic.rule@1.0.0',judges:'subject',overClaims:false,discrimination:false,bound:[]});
   assert.ok(!claim.qualifier.marks.includes('partial'));assert.equal(sourceCoverage(sources,['src:'+'c'.repeat(64)]),undefined);
   assert.deepEqual(sourceCoverage(sources,[partial]),coverage);
   assert.deepEqual(sourceCoverage(sources,[partial.slice(4)]),coverage);
   const unknown=[sources[0],{reference:full,role:'expected' as const,external:'toy:manual:legacy'}];
   const combined=sourceCoverage(unknown,[partial,full])!;assert.equal(combined.complete,false);assert.equal(combined.total,undefined);assert.match(combined.note!,/未声明覆盖/);
 });

 test('expected-source coverage is bound and limits only the check that declares those reads',{skip},async()=>{
   currentCoverage={complete:true,examined:1,total:1};const id=await pack(true);
   const detail=await h.service.startRunDetailed(h.alice,{pack:id,inputs:{map:{external:'toy:mindmap:partial'}}},h.call());
   assert.equal(detail.answer.call_result,'ok',JSON.stringify(detail.answer.errors));
   const expected=detail.answer.run!.sources.find(s=>s.external?.startsWith('toy:manual:coverage'))!;assert.deepEqual(expected.coverage,coverage);
   const result=detail.production!.result;const overview=result.cross_item.find(c=>c.requirement==='overview')!;
   assert.ok(overview.qualifier.marks.includes('partial'));assert.ok(overview.validity.bound.includes(expected.reference.slice(4)));
   const tidy=Object.values(result.partitions).flat().flatMap(i=>i.requirements).filter(r=>r.requirement==='tidy').flatMap(r=>r.claims);
   assert.ok(tidy.length);assert.ok(tidy.every(c=>!c.qualifier.marks.includes('partial')));
 });

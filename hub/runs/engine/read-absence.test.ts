import assert from 'node:assert/strict';
import {after,before,test} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {startPostgres,type TemporaryPostgres} from '../../testing/postgres.ts';
import {openHarness,sandboxSkip,type Harness} from './testing/harness.ts';
import {locatePack,writePack} from './testing/packs.ts';
let postgres:TemporaryPostgres,h:Harness,dir:string;
const skip=await sandboxSkip();
let retryMissing=false;
const absent={code:'SOURCE_ABSENT' as const,system:'toy',object:'toy:manual:absent',observed_at:'2026-10-24T00:00:00.000Z'};
before(async()=>{
 postgres=await startPostgres();if(skip)return;h=await openHarness(postgres);dir=await mkdtemp(join(tmpdir(),'read-absence-'));
 h.external.put('toy:mindmap:map',{bytes:Buffer.from('{"cases":[{"id":"one"}]}'),mediaType:'application/json'});
 for(const id of ['toy:manual:absent','toy:mindmap:absent'])h.external.put(id,{bytes:Buffer.from(JSON.stringify({...absent,object:id})),mediaType:'application/json'});
 const read=h.external.read.bind(h.external);h.external.read=async(...args)=>{if(retryMissing && args[0].endsWith(':absent'))return {ok:false,id:args[0],reason:'synthetic transport outage',retry:{code:'SOURCE_TIMEOUT',attempts:3,at:'2026-10-24T00:01:00.000Z'}};const value=await read(...args);return value.ok&&args[0].endsWith(':absent')?{...value,absent:{...absent,object:args[0]},revision:null}:value;};
});
after(async()=>{await h?.close();if(dir)await rm(dir,{recursive:true,force:true});await postgres?.stop();});
async function pack(){
 const spec=locatePack();spec.id='synthetic-absence';
 spec.files['functions/project.ts']="export default function(i){return {items:i.inputs.find(s=>s.slot==='map').model.cases.map((n,k)=>({id:n.id,label:n.id,location:{parser:'json@1',selector:'p/cases/'+k},fields:{document:'synthetic',path:['root'],expected:['state']}})),warnings:[]};}";
 const flow=spec.files['workflow.json'] as {json:Record<string,unknown>};flow.json.expected_sources={module:'functions/expected.ts'};
 spec.files['functions/expected.ts']="export default function(){return {sources:[{external:'toy:manual:absent',role:'expected',reason:'合成预期'}],warnings:[]}}";
 const req=spec.files['requirements.json'] as {json:{requirements:Array<{key:string}>}};req.json.requirements=req.json.requirements.filter(r=>r.key==='overview');
 const checks=spec.files['checks.json'] as {json:{checks:Array<Record<string,unknown>>}};checks.json.checks=checks.json.checks.filter(c=>c.id==='overview');checks.json.checks.find(c=>c.id==='overview')!.reads={roles:['expected'],types:['toy:manual'],max_bytes:4096};
 spec.files['functions/overview.ts']="export default function(i){const pair=Object.entries(i.sources).find(([r,t])=>{try{return JSON.parse(t).code==='SOURCE_ABSENT'}catch{return false}});return [{tier:'advisory',verdict:pair?'support':'refute',statement:pair?'已读到确定缺席观察':'未读到缺席观察',grounds:pair?[pair[0]]:[],data:{observation:pair?JSON.parse(pair[1]):null}}];}";
 await h.workflows.add(await writePack(dir,spec));h.workflows.assign(h.alice.id,spec.id);return spec.id;
}
test('expected absence binds a readable determined observation and reaches the check',{skip},async()=>{
 const id=await pack();const detail=await h.service.startRunDetailed(h.alice,{pack:id,inputs:{map:{external:'toy:mindmap:map'}}},h.call());
 assert.equal(detail.answer.call_result,'ok',JSON.stringify(detail.answer.errors));
 const source=detail.answer.run!.sources.find(s=>s.role==='expected')!;assert.ok(source);assert.match(source.label!,/系统 toy 里没有.*读于/);
 const fact=detail.production!.result.cross_item.find(c=>c.requirement==='overview')!;assert.equal(fact.statement.verdict,'support',JSON.stringify(fact));assert.equal((fact.statement.data?.observation as {code:string}).code,'SOURCE_ABSENT');
 assert.equal(fact.statement.data?.unread_sources,undefined);
});
test('a required absent input is refused with system object and observation time',{skip},async()=>{
 const id=await pack();const answer=await h.service.startRun(h.alice,{pack:id,inputs:{map:{external:'toy:mindmap:absent'}}},h.call());
 assert.equal(answer.call_result,'error');assert.equal(answer.errors[0].code,'SOURCE_ABSENT');assert.equal(answer.errors[0].path,'/inputs/map');assert.match(answer.errors[0].message,/不在 toy 里.*2026-10-24/);
});

test('exhausted expected and required reads disclose the missing observation and next retry time',{skip},async()=>{
 retryMissing=true;
 const id=await pack();const detail=await h.service.startRunDetailed(h.alice,{pack:id,inputs:{map:{external:'toy:mindmap:map'}}},h.call());
 assert.equal(detail.answer.call_result,'ok');
 const gap=detail.gaps?.find(g=>g.code==='SOURCE_RETRYABLE');assert.ok(gap);assert.match(gap.message,/toy:manual:absent.*2026-10-24T00:01.*重读/);
 const refused=await h.service.startRun(h.alice,{pack:id,inputs:{map:{external:'toy:mindmap:absent'}}},h.call());assert.equal(refused.errors[0].code,'SOURCE_RETRYABLE');assert.match(refused.errors[0].message,/2026-10-24T00:01/);
});

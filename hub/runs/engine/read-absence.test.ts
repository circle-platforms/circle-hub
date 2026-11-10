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
const asked=new Map<string,boolean|undefined>();
const absent={code:'SOURCE_ABSENT' as const,system:'toy',object:'toy:manual:absent',observed_at:'2026-10-24T00:00:00.000Z'};
before(async()=>{
 postgres=await startPostgres();if(skip)return;h=await openHarness(postgres);dir=await mkdtemp(join(tmpdir(),'read-absence-'));
 h.external.put('toy:mindmap:map',{bytes:Buffer.from('{"cases":[{"id":"one"}]}'),mediaType:'application/json'});
 h.external.put('toy:mindmap:pending',{bytes:Buffer.from('{"code":"SOURCE_PENDING_REVIEW","message":"synthetic observation"}'),mediaType:'application/json'});
 h.external.put('toy:manual:pending',{bytes:Buffer.from('{"code":"SOURCE_PENDING_REVIEW","message":"synthetic observation"}'),mediaType:'application/json'});
 for(const id of ['toy:manual:absent','toy:mindmap:absent'])h.external.put(id,{bytes:Buffer.from(JSON.stringify({...absent,object:id})),mediaType:'application/json'});
 const read=h.external.read.bind(h.external);h.external.read=async(...args)=>{if(retryMissing && args[0].endsWith(':absent'))return {ok:false,id:args[0],reason:'synthetic transport outage',retry:{code:'SOURCE_TIMEOUT',attempts:3,at:'2026-10-24T00:01:00.000Z'}};const value=await read(...args);asked.set(args[0],args[1].bindPending);if(args[0].endsWith(':pending')){const held={code:'SOURCE_PENDING_REVIEW' as const,system:'toy',object:args[0],observed_at:absent.observed_at};return args[1].bindPending&&value.ok?{...value,pending:held,revision:null}:{ok:false,id:args[0],reason:'synthetic held',inputError:{code:'SOURCE_PENDING_REVIEW',message:`系统 toy 里有 ${args[0]}，内容待核看（读于 ${held.observed_at}）`,fix:'到来源系统看原文；管理员核看内容后按原对象重读'}};}return value.ok&&args[0].endsWith(':absent')?{...value,absent:{...absent,object:args[0]},revision:null}:value;};
});
after(async()=>{await h?.close();if(dir)await rm(dir,{recursive:true,force:true});await postgres?.stop();});
async function pack(change:(spec:ReturnType<typeof locatePack>)=>void=()=>{},last:typeof change=()=>{}){
 const spec=locatePack();spec.id='synthetic-absence';change(spec);
 spec.files['functions/project.ts']="export default function(i){return {items:i.inputs.find(s=>s.slot==='map').model.cases.map((n,k)=>({id:n.id,label:n.id,location:{parser:'json@1',selector:'p/cases/'+k},fields:{document:'synthetic',path:['root'],expected:['state']}})),warnings:[]};}";
 const flow=spec.files['workflow.json'] as {json:Record<string,unknown>};flow.json.expected_sources={module:'functions/expected.ts'};
 spec.files['functions/expected.ts']="export default function(){return {sources:[{external:'toy:manual:absent',role:'expected',reason:'合成预期'}],warnings:[]}}";
 const req=spec.files['requirements.json'] as {json:{requirements:Array<{key:string}>}};req.json.requirements=req.json.requirements.filter(r=>r.key==='overview');
 const checks=spec.files['checks.json'] as {json:{checks:Array<Record<string,unknown>>}};checks.json.checks=checks.json.checks.filter(c=>c.id==='overview');checks.json.checks.find(c=>c.id==='overview')!.reads={roles:['expected'],types:['toy:manual'],max_bytes:4096};
 spec.files['functions/overview.ts']="export default function(i){const pair=Object.entries(i.sources).find(([r,t])=>{try{return JSON.parse(t).code==='SOURCE_ABSENT'}catch{return false}});return [{tier:'advisory',verdict:pair?'support':'refute',statement:pair?'已读到确定缺席观察':'未读到缺席观察',grounds:pair?[pair[0]]:[],data:{observation:pair?JSON.parse(pair[1]):null}}];}";
 last(spec);await h.workflows.add(await writePack(dir,spec));h.workflows.assign(h.alice.id,spec.id);return spec.id;
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

test('an absent object says what else this workflow reads in that system: the same number can name another kind of object',{skip},async()=>{
 const id=await pack(spec=>{spec.id='synthetic-absence-other';((spec.files['workflow.json'] as {json:{inputs:unknown[]}}).json.inputs).push({slot:'other',role:'subject',description:'合成的另一类对象',accepts:['toy:other'],required:false,many:false});});
 const answer=await h.service.startRun(h.alice,{pack:id,inputs:{map:{external:'toy:mindmap:absent'}}},h.call());
 assert.equal(answer.errors[0].code,'SOURCE_ABSENT');assert.match(answer.errors[0].fix??'',/toy:other/);
});

test('a run that only reads binds an absent optional input as its observation and says the next step',{skip},async()=>{
 const id=await pack(()=>{},spec=>{spec.id='synthetic-absence-read';
  const flow=(spec.files['workflow.json'] as {json:{inputs:Array<Record<string,unknown>>;expected_sources?:unknown}}).json;for(const input of flow.inputs)input.required=false;flow.inputs.push({slot:'other',role:'subject',description:'合成的另一类对象',accepts:['toy:other'],required:false,many:false});
  (spec.files['requirements.json'] as {json:{requirements:unknown[]}}).json.requirements=[];(spec.files['checks.json'] as {json:{checks:unknown[]}}).json.checks=[];delete spec.files['functions/overview.ts'];
  delete flow.expected_sources;delete spec.files['functions/expected.ts'];
  spec.files['functions/project.ts']="export default function(){return {items:[],warnings:[]}}";
 });
 const detail=await h.service.startRunDetailed(h.alice,{pack:id,inputs:{map:{external:'toy:mindmap:absent'}}},h.call());
 assert.equal(detail.answer.call_result,'ok',JSON.stringify(detail.answer.errors));
 const source=detail.answer.run!.sources.find(s=>s.slot==='map')!;assert.match(source.label!,/系统 toy 里没有 toy:mindmap:absent（读于/);
 const gap=detail.gaps?.find(g=>g.code==='SOURCE_ABSENT');assert.ok(gap);assert.match(gap.message,/系统 toy 里没有.*toy:other/);
 const again=await h.service.startRunDetailed(h.alice,{pack:id,inputs:{map:{external:'toy:mindmap:map'}}},h.call());assert.equal(again.gaps?.find(g=>g.code==='SOURCE_ABSENT'),undefined);
});

test('a run that only reads binds an object held for review as its observation, and the answer stays ok',{skip},async()=>{
 const id=await pack(()=>{},spec=>{spec.id='synthetic-pending-read';
  const flow=(spec.files['workflow.json'] as {json:{inputs:Array<Record<string,unknown>>;expected_sources?:unknown}}).json;for(const input of flow.inputs)input.required=false;
  (spec.files['requirements.json'] as {json:{requirements:unknown[]}}).json.requirements=[];(spec.files['checks.json'] as {json:{checks:unknown[]}}).json.checks=[];delete spec.files['functions/overview.ts'];
  delete flow.expected_sources;delete spec.files['functions/expected.ts'];
  spec.files['functions/project.ts']="export default function(){return {items:[],warnings:[]}}";
 });
 const detail=await h.service.startRunDetailed(h.alice,{pack:id,inputs:{map:{external:'toy:mindmap:pending'}}},h.call());
 assert.equal(detail.answer.call_result,'ok',JSON.stringify(detail.answer.errors));assert.equal(asked.get('toy:mindmap:pending'),true);
 const source=detail.answer.run!.sources.find(s=>s.slot==='map')!;assert.match(source.label!,/系统 toy 里有 toy:mindmap:pending，内容待核看（读于/);
 const gap=detail.gaps?.find(g=>g.code==='SOURCE_PENDING_REVIEW');assert.ok(gap);assert.match(gap.message,/内容待核看.*来源系统看原文/);
});

test('an expected source held for review is a warning that says so, and is never bound',{skip},async()=>{
 const id=await pack(()=>{},spec=>{spec.files['functions/expected.ts']="export default function(){return {sources:[{external:'toy:manual:pending',role:'expected',reason:'合成预期'}],warnings:[]}}";});
 const detail=await h.service.startRunDetailed(h.alice,{pack:id,inputs:{map:{external:'toy:mindmap:map'}}},h.call());
 assert.equal(detail.answer.call_result,'ok',JSON.stringify(detail.answer.errors));assert.equal(asked.get('toy:manual:pending'),undefined,'an expected source is not offered the observation');
 assert.equal(detail.answer.run!.sources.find(s=>s.role==='expected'),undefined);
 const gap=detail.gaps?.find(g=>g.code==='SOURCE_PENDING_REVIEW');assert.ok(gap,JSON.stringify(detail.gaps));assert.match(gap.message,/系统 toy 里有 toy:manual:pending，内容待核看.*来源系统看原文/);
});

test('an input a run needs, or a run with requirements, is refused with the same fact instead of binding it',{skip},async()=>{
 const id=await pack();const answer=await h.service.startRun(h.alice,{pack:id,inputs:{map:{external:'toy:mindmap:pending'}}},h.call());
 assert.equal(asked.get('toy:mindmap:pending'),false,'it is only offered to a run that only reads');
 assert.equal(answer.call_result,'error');assert.equal(answer.errors[0].code,'SOURCE_PENDING_REVIEW');assert.equal(answer.errors[0].path,'/inputs/map');assert.match(answer.errors[0].message,/内容待核看/);assert.match(answer.errors[0].fix??'',/来源系统看原文/);
});

test('exhausted expected and required reads disclose the missing observation and next retry time',{skip},async()=>{
 retryMissing=true;
 const id=await pack();const detail=await h.service.startRunDetailed(h.alice,{pack:id,inputs:{map:{external:'toy:mindmap:map'}}},h.call());
 assert.equal(detail.answer.call_result,'ok');
 const gap=detail.gaps?.find(g=>g.code==='SOURCE_RETRYABLE');assert.ok(gap);assert.match(gap.message,/toy:manual:absent.*2026-10-24T00:01.*重读/);
 const refused=await h.service.startRun(h.alice,{pack:id,inputs:{map:{external:'toy:mindmap:absent'}}},h.call());assert.equal(refused.errors[0].code,'SOURCE_RETRYABLE');assert.match(refused.errors[0].message,/2026-10-24T00:01/);
});

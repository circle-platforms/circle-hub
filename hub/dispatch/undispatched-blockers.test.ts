import assert from 'node:assert/strict';
import {test} from 'node:test';
import {newId,sha256Hex,type RecordsKit} from '../records/api.ts';
import {Journal,type Event} from './journal.ts';
import {setup} from './testing/context.ts';

test('a clause-six refusal without an intent does not block a new verification run on the same physical target',async t=>{
 const c=await setup();t.after(()=>c.close());const policy=c.detail.run.policy,executors=c.detail.run.executors;
 c.detail.run.executors='f'.repeat(64);
 const refused=await c.service.dispatch(c.admin,c.run,c.executor.id);
 assert.equal(refused.phase,'boundary_refused');assert.equal(refused.outcome,'not_dispatched');assert.equal(refused.frozen,false);
 const history=await c.service.journal.events(refused.job);assert.ok(!history.some(event=>event.body.detail.phase==='intent'));
 assert.equal(history.at(-1)!.body.detail.boundary_clause,6);
 const next=structuredClone(c.detail),run=newId('run');next.run.run=run;next.run.policy=policy;next.run.executors=executors;next.run.predecessor=c.run;
 next.latest!.result.run=run;next.latest!.record=sha256Hex('synthetic next validation');
 (next.latest!.result.partitions.delivered[0].requirements[0].claims[0].statement.data as any).plan_run=c.run;
 const read=c.runs.getRun;c.runs.getRun=async(by,id)=>id===run?next:read(by,id);
 const result=await c.service.dispatch(c.admin,run,c.executor.id);
 assert.equal(result.outcome,'effective');assert.equal(c.calls.filter(name=>name==='send_blob').length,1);
 assert.equal((await c.service.status(c.admin,refused.job)).outcome,'not_dispatched');
});
const binding=(job:string)=>({job,executor:'synthetic_executor',resources:['synthetic/seat'],scope:{target:'synthetic_target',origin:'https://executor.invalid'}});
const event=(job:string,detail:Record<string,unknown>,index=0)=>({digest:String(index).padStart(64,'0'),body:{detail:{job,...detail}}}) as unknown as Event;
const scenarios:Array<[string,Record<string,unknown>[],boolean]>=[
 ['boundary refusal',[{phase:'boundary_refused',done:true,outcome:'not_dispatched',submit_invoked:false}],false],
 ['any terminal proving no invocation',[{phase:'synthetic_terminal',done:true,outcome:'not_dispatched',submit_invoked:false}],false],
 ['completed delivery',[{phase:'intent'},{phase:'complete',done:true,outcome:'effective'}],false],
 ['intent stored but proven not invoked',[{phase:'intent'},{phase:'complete',done:true,outcome:'not_dispatched',submit_invoked:false}],false],
 ['active reservation',[],true],
 ['issued intent',[{phase:'intent'}],true],
 ['unknown despite done flag',[{phase:'intent'},{phase:'complete',done:true,outcome:'unknown'}],true],
 ['frozen despite a no-send terminal',[{phase:'unknown',uncertain:true},{phase:'boundary_refused',done:true,outcome:'not_dispatched',submit_invoked:false}],true],
 ['later explicit unknown without a freeze marker',[{phase:'complete',done:true,outcome:'effective'},{phase:'unknown',outcome:'unknown'}],true],
 ['new intent after old terminal',[{phase:'complete',done:true,outcome:'effective'},{phase:'intent'}],true],
 ['missing proof after intent',[{phase:'intent'},{phase:'complete',done:true,outcome:'not_dispatched'}],true],
];
for(const [name,details,expected]of scenarios)test('physical occupancy: '+name,async()=>{
 const job='a'.repeat(64),history=[event(job,{phase:'reservation',binding:binding(job)}),...details.map((detail,index)=>event(job,detail,index+1))];
 const records={store:{findMany:async(query:{key:string;values:string[]})=>history.filter(record=>query.key==='dispatch.job'?query.values.includes(String(record.body.detail.job)):query.values.includes(String(record.body.detail.phase)))},objects:{get:async()=>{throw new Error('a scoped reservation must not read executor bytes');}}} as unknown as RecordsKit;
 const result=await new Journal(records,()=>new Date()).blockers('synthetic_executor','synthetic_target','https://executor.invalid',['synthetic/seat']);
 assert.equal(result.includes(job),expected);
});
test('target histories are read in bounded batches and terminal phases are not enumerated',async()=>{
 const history:Event[]=[];
 for(let index=0;index<300;index++){
  const job=index.toString(16).padStart(64,'0');history.push(event(job,{phase:'reservation',binding:binding(job)}),event(job,{phase:'synthetic_terminal',done:true,outcome:index===299?'unknown':'not_dispatched',submit_invoked:index===299?undefined:false},1));
 }
 const sizes:number[]=[];
 const records={store:{findMany:async(query:{key:string;values:string[]})=>{
  if(query.key==='dispatch.phase')return history.filter(record=>record.body.detail.phase==='reservation');
  sizes.push(query.values.length);assert.ok(query.values.length<=128);return history.filter(record=>query.values.includes(String(record.body.detail.job)));
 }}} as unknown as RecordsKit;
 const result=await new Journal(records,()=>new Date()).blockers('synthetic_executor','synthetic_target','https://executor.invalid',['synthetic/seat']);
 assert.deepEqual(sizes,[128,128,44]);assert.deepEqual(result,[(299).toString(16).padStart(64,'0')]);
});

// Ordinary deployment snapshots stay local to one start_run, while frozen input bytes remain immutable.
import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {startPostgres,type TemporaryPostgres} from '../../testing/postgres.ts';
import {openHarness,sandboxSkip} from './testing/harness.ts';
let pg:TemporaryPostgres;const skip=await sandboxSkip();
before(async()=>{pg=await startPostgres();});after(()=>pg?.stop());
test('one start_run shares a single variable snapshot across inputs and expected sources', {skip},async t=>{
 const h=await openHarness(pg);t.after(()=>h.close());
 const initial=await h.kit.variables.setVariable(h.admin,'DEMO_CHOICE','old-value','DEMO_REASON');
 const old=initial.value.decision.digest;let snapshots=0;
 const snapshot=h.kit.variables.snapshot.bind(h.kit.variables);h.kit.variables.snapshot=async()=>{snapshots++;return snapshot();};
 const read=h.external.read.bind(h.external),seen:string[]=[];let first=true;
 h.external.read=async(id,context)=>{
  const decision=context.variables?.get('DEMO_CHOICE')??(await h.kit.variables.snapshot()).get('DEMO_CHOICE')!;seen.push(decision);
  if(id==='toy:story:4021')h.external.put(id,{bytes:Buffer.from('# DEMO '+await h.kit.variables.valueAt('DEMO_CHOICE',decision)),mediaType:'text/markdown'});
  const result=await read(id,context);
  if(first){first=false;await h.kit.variables.setVariable(h.admin,'DEMO_CHOICE','new-value','DEMO_CHANGE');}
  return result;
 };
 const start=()=>h.service.startRun(h.alice,{pack:'toy-review',product:'Meadow',inputs:{map:{external:'toy:mindmap:docq7'}}},h.call());
 const a=await start();assert.equal(a.call_result,'ok');assert.ok(seen.length>=2);assert.ok(seen.every(d=>d===old));assert.equal(snapshots,1);
 const detailA=await h.service.getRun(h.alice,a.run!.run);const sourceA=detailA!.run.sources.find(s=>s.external?.startsWith('toy:story:4021'))!;assert.ok(sourceA);
 const bytesA=await h.kit.objects.get(sourceA.reference.slice(4));assert.match(Buffer.from(bytesA!).toString(),/old-value/);
 seen.length=0;const b=await start();assert.equal(b.call_result,'ok');assert.ok(seen.every(d=>d!==old));assert.equal(snapshots,2);
 const detailB=await h.service.getRun(h.alice,b.run!.run);const sourceB=detailB!.run.sources.find(s=>s.external?.startsWith('toy:story:4021'))!;
 assert.match(Buffer.from((await h.kit.objects.get(sourceB.reference.slice(4)))!).toString(),/new-value/);
 assert.match(Buffer.from((await h.kit.objects.get(sourceA.reference.slice(4)))!).toString(),/old-value/);
 assert.ok(!JSON.stringify(detailA!.run).includes('DEMO_CHOICE'),'the process snapshot is not serialized into the run');
});
// Issue 194: what a run is started with is content of its member, not refused for looking like a credential. The test after
// this one turns the detectors on and covers the refusal they made.
test('a parameter that looks like a credential starts the run like any other parameter', {skip},async t=>{
 const h=await openHarness(pg,{review:{parameterSchema:{type:'string'}}});t.after(()=>h.close());
 const text='password=DEMO!Password42';
 const started=await h.service.startRun(h.alice,{pack:'toy-review',product:'Meadow',inputs:{map:{external:'toy:mindmap:docq7'}},parameters:{strict:text}},h.call());
 assert.equal(started.call_result,'ok');
 const detail=await h.service.getRun(h.alice,started.run!.run);assert.equal(detail!.run.parameters?.strict,text);
});
test('parameters are not scanned for credentials, a malformed argument is refused, and reference-looking parameters stay literal', {skip},async t=>{
 const h=await openHarness(pg,{review:{parameterSchema:{type:'string'}}});t.after(()=>h.close());
 const input={pack:'toy-review',product:'Meadow',inputs:{map:{external:'toy:mindmap:docq7'}}};
 // Decisions 154 and 161: a parameter that looks like a credential is taken as given.
 const kept=await h.service.startRun(h.alice,{...input,parameters:{strict:'password=DEMO!Password42'}},h.call());
 assert.equal(kept.call_result,'ok',JSON.stringify(kept.errors));
 const malformedArguments={...input,['password=DEMO!Password42']:'x'};
 const malformed=await h.service.startRun(h.alice,malformedArguments,h.call());
 assert.equal(malformed.call_result,'error');

 const literal='${var:DEMO_NOT_SET}';const accepted=await h.service.startRun(h.alice,{...input,parameters:{strict:literal}},h.call());assert.equal(accepted.call_result,'ok');
 const detail=await h.service.getRun(h.alice,accepted.run!.run);assert.equal(detail!.run.parameters?.strict,literal);
});

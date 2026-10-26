import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setup} from './testing/context.ts';
import {jobCommand,type JobCommandSession} from '../server/cli-job.ts';

test('release denial records private administrator conditions and logs while public reasons stay neutral',async t=>{
 const c=await setup();t.after(()=>c.close());const logs:unknown[]=[];c.service.options.adminLog=entry=>logs.push(entry);
 c.effectDocument.requirements.push({...c.effectDocument.requirements[0],key:'private_source_marker',required:false});c.effectDocument.effects[0].release.artifact='private_source_marker';
 const state=await c.service.dispatch(c.admin,c.run,c.executor.id);
 assert.equal(state.outcome,'not_dispatched');assert.equal(c.calls.length,0);
 assert.ok(state.admin_release?.some(check=>check.condition==='release.artifact'&&check.satisfied===false&&check.fields[0].field==='row.release.artifact'));
 assert.ok(logs.some(entry=>JSON.stringify(entry).includes('release.artifact')&&JSON.stringify(entry).includes(state.job)));
 assert.ok(!JSON.stringify(logs).includes('private_source_marker'));assert.ok(!JSON.stringify(state).includes('private_source_marker'));
 assert.ok(!state.reason?.includes('release.artifact'));assert.ok(!state.missing_fact?.includes('row.release'));
 const refused=(await c.service.journal.events(state.job)).find(event=>event.body.detail.phase==='boundary_refused')!;
 assert.equal(refused.body.error_code,'EFFECT_RELEASE_UNMET');assert.equal(refused.body.detail.admin_checks,undefined);
 const sha=String(refused.body.detail.admin_release_sha256);assert.equal(sha.length,64);
 assert.equal(await c.kit.artifacts.source(c.owner,sha),null);
 assert.ok(await c.kit.artifacts.source(c.admin,sha));
 assert.ok((await c.service.status(c.admin,state.job)).admin_release?.length);
 await assert.rejects(c.service.status(c.owner,state.job));
});
test('an administrator diagnostic storage or log failure cannot replace or authorize the neutral denial',async t=>{
 const c=await setup();t.after(()=>c.close());c.effectDocument.requirements.push({...c.effectDocument.requirements[0],key:'other_synthetic',required:false});c.effectDocument.effects[0].release.artifact='other_synthetic';
 c.service.options.adminLog=()=>{throw new Error('private-log-marker');};
 c.kit.artifacts.ingest=async()=>{throw new Error('private-note-marker');};
 const state=await c.service.dispatch(c.admin,c.run,c.executor.id);
 assert.equal(state.outcome,'not_dispatched');assert.equal(state.admin_release_missing,true);assert.equal(c.calls.length,0);
 assert.ok(!JSON.stringify(state).includes('private-'));
});
test('explain-release is an admin-only read with no storage writes, vault key, replay, RPC or job reservation',async t=>{
 const c=await setup();t.after(()=>c.close());const original=c.kit.store.put.bind(c.kit.store),objects=c.kit.objects.put.bind(c.kit.objects),ingest=c.kit.artifacts.ingest.bind(c.kit.artifacts);
 c.kit.store.put=async()=>{throw new Error('diagnostic attempted a record write');};
 c.kit.objects.put=async()=>{throw new Error('diagnostic attempted an object write');};
 c.kit.artifacts.ingest=async()=>{throw new Error('diagnostic attempted an artifact write');};
 c.service.options.recheckChecks=async()=>{throw new Error('diagnostic attempted policy replay');};
 c.service.registry.material=async()=>{throw new Error('diagnostic attempted secret access');};
 const output:string[]=[];const session:JobCommandSession={ctx:{io:{cwd:process.cwd()}},options:{},out:line=>output.push(line),err:line=>{throw new Error(line);},admin:async()=>c.admin,records:async()=>c.kit,hub:async requireKey=>{assert.equal(requireKey,false);return {dispatch:c.service,records:c.kit};}};
 try{
  assert.equal(await jobCommand(session,['explain-release','--run',c.run,'--executor',c.executor.id]),0);
  assert.ok(output.some(line=>line.includes('release.parameters.sha256')));assert.ok(output.some(line=>line.includes('release.artifact')));assert.ok(output.some(line=>line.includes('只读诊断')));
  assert.ok(!output.join('\n').includes('synthetic-bed'));assert.ok(!output.join('\n').includes(c.run));
  assert.equal(c.calls.length,0);
  await assert.rejects(c.service.explainRelease(c.owner,c.run,c.executor.id));
 }finally{c.kit.store.put=original;c.kit.objects.put=objects;c.kit.artifacts.ingest=ingest;}
});
test('explain-release returns a nonzero CLI result with field-only diagnostics for a release mismatch',async t=>{
 const c=await setup();t.after(()=>c.close());c.effectDocument.requirements.push({...c.effectDocument.requirements[0],key:'private_source_marker',required:false});c.effectDocument.effects[0].release.artifact='private_source_marker';const output:string[]=[];
 const session:JobCommandSession={ctx:{io:{cwd:process.cwd()}},options:{},out:line=>output.push(line),err:()=>{},admin:async()=>c.admin,records:async()=>c.kit,hub:async()=>({dispatch:c.service,records:c.kit})};
 assert.equal(await jobCommand(session,['explain-release','--run',c.run,'--executor',c.executor.id]),1);
 assert.ok(output.some(line=>line.includes('"condition":"release.artifact"')&&line.includes('"satisfied":false')));assert.ok(!output.join('\n').includes('private_source_marker'));
 assert.equal(c.calls.length,0);
 const reservations=await c.kit.store.findMany({kind:'action',key:'dispatch.phase',values:['reservation']});assert.equal(reservations.length,0);
});
test('explain-release names a missing result_ownership premise without a session and omits it once registered',async t=>{
 const c=await setup();t.after(()=>c.close());
 const absent=await c.service.explainRelease(c.admin,c.run,c.executor.id);
 assert.equal(absent.satisfied,true);assert.deepEqual(absent.no_verdict.map(gap=>gap.premise),['result_ownership']);assert.equal(c.calls.length,0);
 const output:string[]=[];
 const session:JobCommandSession={ctx:{io:{cwd:process.cwd()}},options:{},out:line=>output.push(line),err:line=>{throw new Error(line);},admin:async()=>c.admin,records:async()=>c.kit,hub:async requireKey=>{assert.equal(requireKey,false);return {dispatch:c.service,records:c.kit};}};
 assert.equal(await jobCommand(session,['explain-release','--run',c.run,'--executor',c.executor.id]),0);
 assert.ok(output.some(line=>line.startsWith('无判定前提 result_ownership；')));assert.equal(c.calls.length,0);
 const proof=await c.kit.artifacts.ingest({bytes:new TextEncoder().encode('synthetic attribution certification'),mediaType:'text/plain',origin:{upload:{session:'synthetic'}},author:{user:c.admin.id},provenanceType:'declared',visibility:{readers:[c.admin.id],admins:true,packs:[],shareable:false}});
 await c.registry.update(c.admin,c.executor.id,{...c.executor.definition,premises:{result_ownership:{version:'1',evidence:[`src:${proof.body.sha256}`]}}});
 const present=await c.service.explainRelease(c.admin,c.run,c.executor.id);
 assert.equal(present.satisfied,true);assert.deepEqual(present.no_verdict,[]);assert.equal(c.calls.length,0);
});
test('proof failures before release still reach private administrator notes without contacting the executor',async t=>{
 for(const missing of [false,true]){
  const c=await setup();t.after(()=>c.close());const logs:unknown[]=[];c.service.options.adminLog=entry=>logs.push(entry);
  const receipt=c.detail.latest!.result.partitions.delivered[0].requirements[0].claims[0];
  if(missing)delete (receipt.statement.data as any).generator;else receipt.warrant.id='synthetic_other@1';
  const state=await c.service.dispatch(c.admin,c.run,c.executor.id);
  assert.equal(state.outcome,'not_dispatched');assert.equal(c.calls.length,0);
  assert.ok(state.admin_release?.some(check=>check.condition===(missing?'proof.fields.generator':'proof.claims.warrant_id')&&check.satisfied===false));
  assert.ok(logs.length>0);
 }
});

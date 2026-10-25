import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setup} from './testing/context.ts';
import {inspectInput,verifyInput} from './proof.ts';
import {prepareEffectGate} from './effect-gate.ts';
import {ReleaseDiagnosticError} from './release-diagnostics.ts';
import {checkEffectBoundary} from './boundary.ts';
type C=Awaited<ReturnType<typeof setup>>;
const claim=(c:C)=>c.detail.latest!.result.partitions.delivered[0].requirements[0].claims[0];
const data=(c:C)=>claim(c).statement.data as any;
async function changeWorkflow(c:C,change:(value:any)=>void){const current=await c.workflows.byDigest();change(current);c.workflows.byDigest=async()=>current;}
const cases:Array<[string,(c:C,d:any)=>void|Promise<void>]>=[
 ['proof.warrant_id',(_c,d)=>{d.proof.warrant_id='';}],
 ['run.read',c=>{c.runs.getRun=async()=>{throw new Error('private-source-marker');};}],
 ['workflow.read',c=>{c.workflows.byDigest=async()=>{throw new Error('private-source-marker');};}],
 ['run.available',c=>{const read=c.runs.getRun;c.runs.getRun=async(by,id)=>id===c.run?null:read(by,id);}],
 ['run.management',c=>{(c.detail as any).management={disposition:'abandon'};}],
 ['run.runner',c=>{delete c.detail.run.runner;}],
 ['run.package',c=>{c.detail.run.pack='private-source-marker@1';}],
 ['result.acceptance',c=>{c.detail.latest!.result.acceptance='not_accepted';}],
 ['workflow.identity',c=>changeWorkflow(c,workflow=>{workflow.pack.version='2';})],
 ['result.run',c=>{c.detail.latest!.result.run='run_'+'1'.repeat(26);}],
 ['result.errors',c=>{c.detail.latest!.result.errors.push({code:'SOURCE_UNAVAILABLE',message:'private-source-marker'});}],
 ['result.partitions',c=>{c.detail.latest!.result.partitions.rejected.push({item:'private-source-marker'} as any);}],
 ['run.items',c=>{c.detail.run.items.push({...c.detail.run.items[0],id:'other-synthetic'});}],
 ['result.coverage',c=>{c.detail.latest!.result.partitions.delivered[0].item='other-synthetic';}],
 ['requirements.0',c=>{c.detail.latest!.result.partitions.delivered[0].requirements[0].status='pending';}],
 ['requirements.1',c=>changeWorkflow(c,workflow=>{workflow.requirements.push({...workflow.requirements[0],key:'synthetic-run',target:'run'});})],
 ['proof.requirement',c=>changeWorkflow(c,workflow=>{workflow.requirements[0].accepted_producer='judgment';})],
 ['proof.claims.nature',c=>{claim(c).qualifier.nature='judgment';}],
 ['proof.claims.producer',c=>{claim(c).warrant.producer='model';}],
 ['proof.claims.warrant_id',c=>{claim(c).warrant.id='private-source-marker@1';}],
 ['proof.claims.validity',c=>{claim(c).validity.expires_at=c.now().toISOString();}],
 ['proof.claims.consistency',c=>{const second=structuredClone(claim(c));(second.statement.data as any).bed.id='private-source-marker';c.detail.latest!.result.partitions.delivered[0].requirements[0].claims.push(second);}],
 ['proof.plan_run',c=>{data(c).plan_run='run_'+'1'.repeat(26);}],
 ['proof.fields.sha256',c=>{data(c).sha256='private-source-marker';}],
 ['proof.fields.items',c=>{data(c).autoids=[];}],
 ['proof.fields.target',c=>{data(c).bed.id=123;}],
 ['proof.fields.manifest_sha256',c=>{data(c).bed.manifest_sha256='private-source-marker';}],
 ['proof.fields.build',c=>{data(c).build='';}],
 ['proof.fields.generator',c=>{delete data(c).generator;}],
 ['proof.artifact_slot',(_c,d)=>{d.proof.slot='other-slot';}],
 ['proof.bound_sources',c=>{c.detail.run.sources=c.detail.run.sources.slice(0,1);}],
 ['proof.executor_identity',(_c,d)=>{d.target='private-source-marker';}],
 ['proof.build',c=>{c.detail.run.build='other-synthetic-build';}],
 ['runner.enabled',c=>{const get=c.kit.principals.get.bind(c.kit.principals);c.kit.principals.get=async id=>{const value=await get(id);return value&&id===c.owner.id?{...value,disabled:true}:value;};}],
 ['run.lineage',c=>{c.detail.run.predecessor=c.run;data(c).plan_run=c.run;}],
 ['run.build_basis',c=>{c.detail.run.build='synthetic-build';c.detail.run.target_basis=['a','b'].map(base=>({statement:{data:{field:'build',value:'synthetic-build',base}},validity:{status:'valid'}})) as any;}],
];
for(const [condition,change]of cases)test('release inspection identifies '+condition+' without original values',async t=>{
 const c=await setup();t.after(()=>c.close());const d=structuredClone(c.executor.definition);await change(c,d);
 const result=await inspectInput(c.admin,c.run,d,c.kit,c.runs,c.workflows,c.now());
 assert.equal(result.input,undefined);assert.ok(result.checks.some(check=>check.condition===condition&&check.satisfied!==true),JSON.stringify(result.checks));
 assert.ok(!JSON.stringify(result.checks).includes('private-source-marker'));
 for(const check of result.checks)if(check.satisfied===null)assert.ok(check.missing_fact&&check.next_action);
 for(const check of result.checks)for(const field of check.fields){assert.equal(field.expected_sha256.length,64);assert.equal(field.actual_sha256.length,64);}
 await assert.rejects(verifyInput(c.admin,c.run,d,c.kit,c.runs,c.workflows,c.now()),error=>error instanceof ReleaseDiagnosticError&&error.checks.some(check=>check.condition===condition&&check.satisfied!==true));
});
async function gate(c:C){return prepareEffectGate({records:c.kit,runs:c.runs,workflows:c.workflows,by:c.admin,run:c.run,executor:c.executor.id,definition:c.executor.definition,resolved_digest:c.executor.resolved_digest,now:c.now});}
test('each dispatch parameter mismatch and artifact requirement mismatch names its field',async t=>{
 const c=await setup();t.after(()=>c.close());const prepared=await gate(c),row=c.effectDocument.effects[0];
 for(const name of Object.keys(prepared.context.parameters)){
  const prior=prepared.context.parameters[name];prepared.context.parameters[name]='private-source-marker';
  const report=await prepared.inspectRelease(row);assert.ok(report.checks.some(check=>check.condition==='release.parameters.'+name&&check.satisfied===false&&check.fields[0].field==='parameters.'+name));
  prepared.context.parameters[name]=prior;
 }
 row.release.artifact='other-synthetic';const result=await prepared.inspectRelease(row);assert.ok(result.checks.some(check=>check.condition==='release.artifact'&&check.satisfied===false));
 assert.ok(!JSON.stringify(result.checks).includes('other-synthetic'));
});
test('release inspects missing latest results, undeclared requirements, item states and run-level validity',async t=>{
 const c=await setup();t.after(()=>c.close());const prepared=await gate(c),row=c.effectDocument.effects[0];
 row.release.requirements=['not-declared'];assert.ok((await prepared.inspectRelease(row)).checks.some(check=>check.condition==='release.requirements.0.declared'&&check.satisfied===false));
 row.release.requirements=['workbook_verified'];c.detail.latest!.result.partitions.delivered[0].requirements[0].status='pending';assert.ok((await prepared.inspectRelease(row)).checks.some(check=>check.condition==='release.requirements.0.satisfied'&&check.satisfied===false));
 c.detail.latest!.result.partitions.delivered[0].requirements[0].status='satisfied';
 const current=await c.workflows.byDigest();current.requirements[0].target='run';// gate froze its own declaration: new gate observes this controlled run-level definition.
 c.workflows.byDigest=async()=>current;const runGate=await gate(c);
 assert.ok((await runGate.inspectRelease(row)).checks.some(check=>check.condition==='release.requirements.0.satisfied'&&check.satisfied===false));
 c.detail.latest!.result.cross_item=[{...structuredClone(claim(c)),validity:{...claim(c).validity,expires_at:c.now().toISOString()}}];
 assert.ok((await runGate.inspectRelease(row)).checks.some(check=>check.condition==='release.requirements.0.satisfied'&&check.satisfied===false));
 const read=c.runs.getRun;let reads=0;c.runs.getRun=async(by,id)=>{if(id===c.run&&++reads>=2)return {...c.detail,latest:null};return read(by,id);};
 assert.ok((await prepared.inspectRelease(row)).checks.some(check=>check.condition==='release.latest.available'&&check.satisfied===false));
});
test('unexpected release exceptions are hashed and the public boundary message stays neutral',async t=>{
 const c=await setup();t.after(()=>c.close());const prepared=await gate(c);
 const result=await checkEffectBoundary({...prepared.context,release:async()=>{throw new Error('private-source-marker');},lease:async()=>({ok:true}),content:async()=>true,audience:async()=>true});
 assert.ok(!result.ok);assert.equal(result.code,'EFFECT_RELEASE_UNMET');assert.ok(!result.message.includes('private-source-marker'));assert.equal(result.admin_checks![0].condition,'release.execution');assert.ok(!JSON.stringify(result).includes('private-source-marker'));
});

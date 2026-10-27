// T02 / B04: publication tests and ownership, not a two-person approval workflow.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {startPostgres} from '../../hub/testing/postgres.ts';
import {openPackTestbed} from '../../hub/runs/packs/testing/setup.ts';
import {workflowPack,editJson} from '../../hub/runs/packs/testing/builder.ts';
import {AccessError} from '../../hub/records/api.ts';
import {DOCUMENTS} from '../fixtures/agile/index.ts';
import {openBed} from './support/hub.ts';
import {openConsole} from './support/console.ts';
import {draft,startReview} from './support/review.ts';

test('T7-4 positive and negative publish samples run before publication; only the owner releases a new version',async t=>{
 const postgres=await startPostgres();t.after(()=>postgres.stop());
 const bed=await openPackTestbed({postgres});t.after(()=>bed.close());
 const id='synthetic-t7-publication';
 for(const path of ['samples/positive/titles-good.json','samples/negative/titles-bad.json']){
  const bad=editJson<Record<string,any>>(workflowPack({id}),path,sample=>{if(path==='samples/positive/titles-good.json')sample.expect[0].item='missing';else sample.expect[0].code='core.structure.cardinality';});
  const refused=await bed.attempt(bed.alice,bad);
  assert.equal(refused.ok,false);if(refused.ok)throw Error('invalid publication');
  assert.ok(refused.problems.some(problem=>problem.rule==='publish.sample_failed'));
  assert.equal(await bed.registry.getPack(id),null);
  assert.equal(await bed.kit.authorizations.ownerOf(id),null);
 }
 const first=await bed.publish(bed.alice,workflowPack({id}));
 assert.equal(first.version.owner,bed.alice.id);assert.equal(first.report.samples.passed,4);
 assert.equal(await bed.kit.authorizations.isPublished(id+'@1.0.0',first.version.digest),true);
 const other=await bed.attempt(bed.bob,workflowPack({id,version:'1.0.1'}));assert.equal(other.ok,false);if(!other.ok)assert.ok(other.problems.some(problem=>problem.rule==='publish.not_owner'));
 await bed.kit.authorizations.grantPublishRight(bed.admin,bed.admin.id);
 const administrator=await bed.attempt(bed.admin,workflowPack({id,version:'1.0.1'}));assert.equal(administrator.ok,false);if(!administrator.ok)assert.ok(administrator.problems.some(problem=>problem.rule==='publish.not_owner'));
 const next=await bed.publish(bed.alice,workflowPack({id,version:'1.0.1'}));assert.equal(next.version.owner,bed.alice.id);
 await assert.rejects(bed.registry.assign(bed.alice,bed.carol.id,id),AccessError);
 await bed.registry.assign(bed.admin,bed.carol.id,id);assert.equal(await bed.kit.authorizations.canUse(bed.carol.id,id),true);
 await assert.rejects(bed.registry.retire(bed.alice,id,'1.0.0'),AccessError);
 await bed.registry.retire(bed.admin,id,'1.0.0');assert.equal(await bed.registry.resolve(id+'@1.0.0'),null);
 assert.equal((await bed.registry.byDigest(first.version.digest))?.withdrawn,true,'old bytes remain addressable after withdrawal');
});

test('T7-4 author-only sample marks and withdrawn-rule labels remain visible without changing historical receipts',async t=>{
 const postgres=await startPostgres();t.after(()=>postgres.stop());
 const bed=await openBed({postgres});t.after(()=>bed.close());
 const client=await bed.connect(bed.reviewer,'synthetic-t7-publication-read');
 const consoleClient=await openConsole(bed.hub,bed.reviewer.token);
 const subject=await client.upload(Buffer.from(JSON.stringify({root:{data:{id:'root',text:'合成发布规则'},children:[{data:{id:'case',text:'合成检查',priority:2,resource:['functional']},children:[{data:{id:'expected',text:'ready'}}]}]}})),'synthetic-publish.km.json');
 const run=await startReview(client,{product:bed.second.names[0],version:'2.1',inputs:{subject:{reference:subject}}});
 const submitted=await client.call('submit_result',draft(run));assert.equal(submitted.out.acceptance,'accepted');
 const claims=Object.values(submitted.out.result!.partitions).flat().flatMap(item=>item.requirements.flatMap(requirement=>requirement.claims));
 assert.ok(claims.some(claim=>claim.qualifier.nature==='fact'&&claim.qualifier.marks.includes('author_samples_only')));
 const detail=(await bed.hub.deps.runs.getRun(bed.reviewer.principal,run.run))!;
 assert.equal(detail.rule_withdrawn,undefined);
 const record=detail.latest!.record,before=JSON.stringify((await bed.hub.records.store.get(record))!.body);
 const page=await consoleClient.get('/console/runs/'+run.run);assert.equal(page.status,200);assert.ok(page.body.includes('仅作者样例'));
 const [id,version]=run.pack.split('@');
 await bed.hub.hub.registry.unassign(bed.hub.admin.principal,bed.reviewer.user.id,id);
 assert.equal((await bed.hub.deps.runs.getRun(bed.reviewer.principal,run.run))!.rule_withdrawn,undefined,'unassignment is not rule withdrawal');
 await bed.hub.hub.registry.assign(bed.hub.admin.principal,bed.reviewer.user.id,id);
await bed.hub.hub.registry.retire(bed.hub.admin.principal,id,version,'合成规则撤回');
 const refused=await client.call('start_run',{pack:run.pack,product:bed.second.names[0],version:'2.1',inputs:{subject:{reference:subject}}});
 assert.equal(refused.isError,true);assert.ok(refused.out.errors.some(error=>error.code==='SOURCE_UNAVAILABLE'));
 assert.equal(JSON.stringify((await bed.hub.records.store.get(record))!.body),before,'withdrawal never edits the stored conclusion');
 const reread=(await bed.hub.deps.runs.getRun(bed.reviewer.principal,run.run))!;
 assert.equal(reread.rule_withdrawn,true);assert.equal(reread.latest!.record,record);assert.equal(JSON.stringify(reread.latest!.result),before);
 const after=await consoleClient.get('/console/runs/'+run.run);assert.equal(after.status,200);
 assert.ok(after.body.includes('规则已撤回')&&after.body.includes('版本已下架'),'the read view discloses withdrawal without rewriting the historical receipt');
 const resultView=await bed.hub.hub.runs.getResult(bed.reviewer.principal,run.run);
 assert.equal(resultView!.rule_withdrawn,true);assert.equal(resultView!.record,record);assert.equal(JSON.stringify(resultView!.result),before);
 await bed.hub.assignPack(bed.reviewer.principal,'case-location');
 const production=await client.call('start_run',{pack:'case-location',product:bed.product.names[0],version:bed.site.LINE,inputs:{documents:[{external:'agile:mindmap:'+DOCUMENTS.review}]}});
 assert.equal(production.isError,false,production.text);
 const productionRun=production.out.run!;
 const produced=(await bed.hub.deps.runs.getRun(bed.reviewer.principal,productionRun.run))!;assert.ok(produced.production);
 const productionBytes=JSON.stringify(produced.production.result),productionRecord=produced.production.record;
 const [producer,producerVersion]=productionRun.pack.split('@');await bed.hub.hub.registry.retire(bed.hub.admin.principal,producer,producerVersion,'合成生产规则撤回');
 const projected=(await bed.hub.deps.runs.getRun(bed.reviewer.principal,productionRun.run))!;
 assert.equal(projected.rule_withdrawn,true);assert.equal(projected.production!.record,productionRecord);assert.equal(JSON.stringify(projected.production!.result),productionBytes);
 const productionPage=await consoleClient.get('/console/results/'+productionRun.run);assert.equal(productionPage.status,200);assert.ok(productionPage.body.includes('规则已撤回（版本已下架）'));
});

import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {osIsolationAvailable} from '../../../hub/rules/api.ts';
import {startPostgres} from '../../../hub/testing/postgres.ts';
import {call,openHub,sha} from './testing/hub.ts';
import {satisfiedRecipes} from './tools/generate-workbook.ts';
import {generateWorkbookSet} from './functions/generate.ts';
import {createTestParserRegistry} from '../../../hub/testing/parsers.ts';
import {recognize} from '../../../hub/refs/api.ts';
import {readWorkbookModel} from './functions/xlsx-model.ts';

const skip=await osIsolationAvailable()?false:'no OS network isolation';
const bytes=(name:string)=>readFileSync(new URL('./examples/'+name,import.meta.url));
const json=(name:string)=>JSON.parse(bytes(name).toString());

test('bundled example reaches satisfied workbook verification with exact source identity, quotations and first-row hierarchy',{skip,timeout:180_000},async t=>{
 const postgres=await startPostgres();t.after(()=>postgres.stop());const hub=await openHub(postgres);t.after(()=>hub.close());
 const documents={contract:bytes('runtime-contract-v2.json'),profile:bytes('runtime-profile-v2.json'),inventory:bytes('bed-topology.json')};
 const inputs:Record<string,{external:string}|{reference:string}>={};for(const [slot,document] of Object.entries(documents)){const external='doc:doc:bundled-'+slot;hub.external.put(external,{bytes:document,mediaType:'application/json'});inputs[slot]={external};}
 const source=await hub.kit.artifacts.ingest({bytes:bytes('case-mindmap.json'),mediaType:'application/json',origin:{read:{object:'synthetic:example:mindmap'}},author:{user:null},provenanceType:'observed',visibility:{readers:[hub.alice.id],admins:true,packs:[],shareable:false}});
 inputs.subject={reference:'src:'+source.body.sha256};const example=json('start-run.json').arguments;assert.deepEqual(inputs.subject,example.inputs.subject);
 const args={...example,product:'widget',build:'Fixture_Build_A',inputs};const first=await hub.service.startRunDetailed(hub.alice,args,call());assert.equal(first.answer.call_result,'ok',JSON.stringify(first.answer.errors));const plan=first.answer.run!;
 const submission={...json('submit-result.json'),run:plan.run};assert.deepEqual(submission.items.map((item:{item:string})=>item.item),plan.items.map(item=>item.id));
 const answered=await hub.service.submitResult(hub.alice,submission,call());assert.equal(answered.acceptance,'accepted',JSON.stringify(answered.errors));const rows=Object.values(answered.result!.partitions).flat();assert.equal(rows.length,1);
 for(const requirement of rows[0].requirements.filter(row=>row.requirement!=='workbook_verified'))assert.equal(requirement.status,'satisfied',JSON.stringify(requirement));assert.notEqual(rows[0].requirements.find(row=>row.requirement==='workbook_verified')?.status,'satisfied');
 const quotes=submission.items.flatMap((item:{slots:{plan:Array<{quotes:Array<{reference:string;text:string}>}>}})=>item.slots.plan.flatMap(claim=>claim.quotes));for(const quote of quotes){const resolved=await hub.service.resolveReference(hub.alice,{run:plan.run,text:quote.text,expect:'quotation'},call());assert.equal(resolved.resolution,'resolved',JSON.stringify(resolved));assert.ok(JSON.stringify(resolved).includes(quote.reference));}
 const recipes=satisfiedRecipes({run:first.answer,result:answered,submission,...documents});assert.equal(recipes.length,1);const workbook=generateWorkbookSet(recipes);
 const parsed=recognize(createTestParserRegistry(),workbook,'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');assert.ok(parsed);const model=readWorkbookModel(parsed.document.model);assert.ok(model);const firstRow=model.sheets[0].rows.find(row=>row.cells.some(cell=>cell.reference==='A4'));assert.ok(firstRow);assert.equal(firstRow.cells.find(cell=>cell.reference==='A4')?.text,example.parameters.autoid);assert.equal(firstRow.cells.find(cell=>cell.reference==='A4')?.type,'inlineStr');assert.equal(firstRow.cells.find(cell=>cell.reference==='D4')?.text,(plan.items[0].fields.path as string[]).join('>'));
 const artifact=await hub.kit.artifacts.ingest({bytes:workbook,mediaType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',origin:{read:{object:'synthetic:example:workbook'}},author:{user:null},provenanceType:'observed',visibility:{readers:[hub.alice.id],admins:true,packs:[],shareable:false}});
 const next=await hub.service.startRunDetailed(hub.alice,{...args,predecessor:plan.run,parameters:{...example.parameters,plan_run:plan.run},inputs:{...inputs,plan_result:{run:plan.run},workbook:{reference:'src:'+artifact.body.sha256}}},call());assert.equal(next.answer.call_result,'ok',JSON.stringify(next.answer.errors));const verified=await hub.service.submitResult(hub.alice,{...submission,run:next.answer.run!.run},call());assert.equal(verified.acceptance,'accepted',JSON.stringify(verified.errors));const verifiedRows=Object.values(verified.result!.partitions).flat();assert.equal(verifiedRows.length,1);for(const requirement of verifiedRows[0].requirements)assert.equal(requirement.status,'satisfied',JSON.stringify(requirement));const proofs=verifiedRows[0].requirements.filter(row=>row.requirement==='workbook_verified').flatMap(row=>row.claims).filter(claim=>claim.statement.data?.sha256);assert.ok(proofs.length);assert.ok(proofs.every(claim=>claim.statement.data!.sha256===artifact.body.sha256));
});

test('the previous richer example remains refused for its four undeclared commands and cannot generate a workbook',{skip,timeout:180_000},async t=>{
 const fixture=JSON.parse(readFileSync(new URL('./testing/undeclared-example.json',import.meta.url),'utf8')) as {subject:string;submission:string};
 const postgres=await startPostgres();t.after(()=>postgres.stop());const hub=await openHub(postgres);t.after(()=>hub.close());const documents={contract:bytes('runtime-contract-v2.json'),profile:bytes('runtime-profile-v2.json'),inventory:bytes('bed-topology.json')};const inputs:Record<string,{external:string}|{reference:string}>={};for(const [slot,document] of Object.entries(documents)){const external='doc:doc:rejected-'+slot;hub.external.put(external,{bytes:document,mediaType:'application/json'});inputs[slot]={external};}
 const source=await hub.kit.artifacts.ingest({bytes:Buffer.from(fixture.subject),mediaType:'application/json',origin:{read:{object:'synthetic:example:undeclared'}},author:{user:null},provenanceType:'observed',visibility:{readers:[hub.alice.id],admins:true,packs:[],shareable:false}});assert.equal(source.body.sha256,sha(fixture.subject));inputs.subject={reference:'src:'+source.body.sha256};
 const first=await hub.service.startRunDetailed(hub.alice,{pack:'case-compile',product:'widget',build:'Fixture_Build_A',inputs,parameters:json('start-run.json').arguments.parameters},call());assert.equal(first.answer.call_result,'ok',JSON.stringify(first.answer.errors));const submission={...JSON.parse(fixture.submission),run:first.answer.run!.run};assert.ok(submission.items[0].slots.plan[0].quotes.every((quote:{reference:string})=>quote.reference.startsWith('src:'+source.body.sha256+'/')));
 const answer=await hub.service.submitResult(hub.alice,submission,call());assert.equal(answer.acceptance,'accepted',JSON.stringify(answer.errors));const requirements=Object.values(answer.result!.partitions).flat()[0].requirements,contract=requirements.find(row=>row.requirement==='contract_methods');assert.ok(contract);assert.equal(contract.status,'unsatisfied');const problems=contract.claims.flatMap(claim=>(claim.statement.data?.problems??[]) as Array<{document:string;pointer:string}>);assert.deepEqual(problems.map(problem=>[problem.document,problem.pointer]),[0,2,3,4].map(index=>['catalog',`/steps/${index}/args/0`]));assert.throws(()=>satisfiedRecipes({run:first.answer,result:answer,submission,...documents}),/计划仍有工作簿缺输入以外的错误/);
});

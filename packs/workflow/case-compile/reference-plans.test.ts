// Reference plans as fixtures, offline and synthetic. One frozen run goes through the chain a real run takes before a bed is used:
// the local plan check (tools/check-plan.ts), the Hub's own check functions on the catalog selection the Hub makes
// (testing/offline-hub.ts), the recipes of the generator tool (tools/generate-workbook.ts) and the independent reading of the
// workbook it writes. Every plan of the chain must come out correct at every gate; the negative controls name the gate that refuses.
// Names and addresses are synthetic (192.0.2.0/24, 2001:db8::/32); nothing here reads a real run, a database or the network.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {checkPlanObject} from './tools/check-plan.ts';
import {frozenRun} from './testing/frozen-run.ts';
import {cellFixture,cellPlan,fixture,plan as blockPlan,call as blockCall,assertion,quote as blockQuote,EXPECTED,EXPECTED_REF,BLOCK_ROOT} from './testing/blocks.ts';
import {frozenTexts,offlineChecks,offlineProblems,offlineReadback,offlineValidation,offlineWorkbook,type OfflineCatalog} from './testing/offline-hub.ts';
import {CONTRACT_DOC,PROFILE_DOC,MANIFEST_DOC,COMMAND_CATALOG,COMMAND_IDENTITIES,QUOTE,AUTOID,goodData} from './functions/test-support.ts';
import {sha256} from './functions/generated/skills/run-tools/hub-client/index.ts';
import REQUIREMENTS from './requirements.json' with {type:'json'};

const LEASES={now:'2026-10-23T02:00:00.000Z',entries:[]};
const bytesOf=(value:unknown):Uint8Array=>Buffer.from(JSON.stringify(value));
interface Subject {contract:unknown;profile:unknown;inventory:unknown;manifest_sha256?:string;catalog:{root:string;policy?:unknown;entries:unknown[]};fields:Record<string,unknown>;item:string;location:string}

/** The frozen run of one synthetic case as the downloaded run.json holds it, with what the generator reads of it (sources, requirements, build). */
function runOf(subject:Subject,review?:unknown){
 const documents={contract:bytesOf(subject.contract),profile:bytesOf(subject.profile),inventory:bytesOf(subject.inventory)};
 const run=frozenRun({
  groups:[{kind:'case-compile',contract:subject.contract,profile:subject.profile,manifest:subject.inventory,...(subject.manifest_sha256?{manifest_sha256:subject.manifest_sha256}:{}),leases:LEASES,criteria_review:review??{result:null,run:null}}],
  items:[{id:subject.item,label:String(subject.fields.title),location:subject.location,fields:subject.fields}],
  root:subject.catalog.root,command_policy:subject.catalog.policy,run:'run_00000000000000000000000001',
  extra:{pack_digest:'b'.repeat(64),build:'SYN_BUILD_1',parameters:{},requirements:REQUIREMENTS.requirements.map(row=>({key:row.key,accepted_producer:row.accepted_producer})),sources:Object.entries(documents).map(([slot,bytes])=>({slot,role:'expected',reference:'src:'+sha256(bytes)}))},
 });
 return {run,documents};
}
const catalogOf=(catalog:{root:string;entries:unknown[]}):OfflineCatalog=>({root:catalog.root,complete:true,entries:catalog.entries as OfflineCatalog['entries']});

/** The whole chain for one plan, gate by gate; the workbook is written only when every gate came out correct. */
function chain(subject:Subject,data:unknown,quotes:unknown[],review?:unknown,extraTexts:Array<[string,string]>=[]){
 const {run,documents}=runOf(subject,review);
 const slots={plan:[{text:'合成参照计划',quotes,data}]};
 const local=checkPlanObject('plan.json',{item:subject.item,handling:'handled',slots},run,subject.catalog);
 const texts=frozenTexts(run);for(const [reference,text] of extraTexts)texts.set(reference,text);
 const catalog=catalogOf(subject.catalog),textOf=(reference:string)=>texts.get(reference);
 const rows=offlineChecks(run,subject.item,slots,catalog,textOf);
 const items=[{item:subject.item,handling:'handled' as const,slots}];
 return {run,slots,local,rows,problems:offlineProblems(rows),validation:offlineValidation(run,items,catalog,textOf),workbook:()=>offlineWorkbook(run,items,catalog,documents,textOf)};
}

// ---- a flat plan: ordinary steps, one expectation after a step, the form of the synchronisation reference plan
const flatSubject=():Subject=>({contract:CONTRACT_DOC,profile:PROFILE_DOC,inventory:MANIFEST_DOC,catalog:COMMAND_CATALOG as Subject['catalog'],item:'doc:case-1',location:QUOTE.reference,
 fields:{autoid:AUTOID,title:'合成用例',path:['合成文档','合成分组','合成用例'],priority:'2',steps:[{text:'widget health interval 60',expected:[QUOTE.text]}],expected:[QUOTE.text],command_identities:structuredClone(COMMAND_IDENTITIES)}});

test('a flat reference plan passes the local plan check and every Hub check, generates a workbook and reads back from it',()=>{
 const result=chain(flatSubject(),goodData(),[QUOTE],undefined,[[QUOTE.reference,QUOTE.text]]);
 assert.equal(result.local.ok,true,JSON.stringify(result.local.problems));
 assert.equal(result.local.authority_checked,true);
 assert.deepEqual(result.rows.filter(row=>row.ran).map(row=>row.check),['contract_shape','bed_addresses','commands_catalog','expected_sources','expected_quotes','scenario_fidelity']);
 assert.deepEqual(result.problems,[],'no Hub check refuses what the local check passes');
 const statuses=Object.fromEntries((result.validation.result.partitions.delivered[0].requirements as Array<{requirement:string;status:string}>).map(row=>[row.requirement,row.status]));
 assert.deepEqual(statuses,{plan:'satisfied',contract_methods:'satisfied',bed_addresses:'satisfied',commands_known:'satisfied',expected_grounded:'satisfied',scenario_kept:'satisfied',workbook_verified:'pending'});
 const built=result.workbook();
 assert.equal(built.recipes.length,1);assert.ok(built.bytes.length>1000);
 const read=offlineReadback(built.bytes,built.recipes);assert.ok(read.ok,JSON.stringify(read));
});

test('an expectation that is not in its quote is refused by the local check and by the Hub check alike, and no workbook follows',()=>{
 const data=goodData();data.expects[0].text='完全不同的文字';
 const result=chain(flatSubject(),data,[QUOTE],undefined,[[QUOTE.reference,QUOTE.text]]);
 assert.equal(result.local.ok,false);
 assert.ok(result.local.problems.some(problem=>problem.code==='case-compile.expect_not_in_quote'),JSON.stringify(result.local.problems));
 assert.ok(result.problems.some(outcome=>outcome.code==='case-compile.expect_not_in_quote'),'the Hub check names the same problem');
 assert.throws(()=>result.workbook(),/尚未全部核对正确/);
});

test('a quotation the offline run has no source text for is unknown, never passed',()=>{
 const subject=flatSubject(),{run}=runOf(subject);
 const rows=offlineChecks(run,subject.item,{plan:[{text:'合成计划',quotes:[QUOTE],data:goodData()}]},catalogOf(subject.catalog),()=>undefined);
 const quotes=rows.find(row=>row.check==='expected_quotes')!;
 assert.equal(quotes.ran,true);assert.ok(quotes.outcomes.length>0&&quotes.outcomes.every(outcome=>outcome.verdict==='unknown'&&outcome.reason==='missing_input'));
});

// ---- a block plan: capture, one cell out of the captured text, the cell as the input of a command, a cleanup; the form of the key-name reference plan
const blockSubject=(f:ReturnType<typeof cellFixture>,fields:Record<string,unknown>=f.fields):Subject=>({contract:f.contractDoc,profile:f.profileDoc,inventory:f.inventory,manifest_sha256:f.manifest_sha256,catalog:f.catalog as Subject['catalog'],item:'synthetic-case',location:EXPECTED_REF,fields});

test('a block reference plan with a cell selection and a cell input goes through the same chain and keeps its cell calls',()=>{
 const f=cellFixture(),result=chain(blockSubject(f),cellPlan(),[blockQuote()]);
 assert.equal(result.local.ok,true,JSON.stringify(result.local.problems));
 assert.deepEqual(result.problems,[],JSON.stringify(result.problems));
 const built=result.workbook(),read=offlineReadback(built.bytes,built.recipes);assert.ok(read.ok,JSON.stringify(read));
 const rows=(read as {executions:Array<{object:string;method:string;args:string[];keywords:Record<string,unknown>;h:string;i:string}>}).executions;
 const select=rows.find(row=>row.method==='table_cell')!;
 assert.deepEqual(select.args,['{}','where 1=zone.example.','where 6=2048.key'],'the where conditions are positional arguments, the first one is the saved text');
 assert.deepEqual({...select.keywords},{column:3,columns:6,format:'delimited',header:0,row:0,separator:'+'});
 assert.equal(select.i,'source_text');assert.equal(select.h,'selected');
 const used=rows.find(row=>row.i==='selected'&&row.method!=='table_cell')!;
 assert.deepEqual(used.args,['demo set {}'],'the selected cell is formatted into the first positional argument only');
});

// ---- the gate a descriptive expectation meets in a block plan
function descriptive(){
 const f=cellFixture(),data=cellPlan();
 const fields={...f.fields,expected_nodes:[{reference:EXPECTED_REF,text:EXPECTED}]};
 data.criteria=[{id:'c_literal',expectation:EXPECTED_REF,quote:blockQuote(),kind:'literal',operator:'abs_found',literal:EXPECTED,rationale:'合成判据：应答里出现该字面',scope_root:f.catalog.root}];
 for(const block of data.blocks)if(block.kind==='OBSERVE_ASSERT')block.assertions[0].criterion='c_literal';
 return {f,data,fields};
}
/** What the Hub freezes into the group once an account other than the author accepted the criterion (the shape review/review.test.ts builds). */
function acceptedReview(criterion:unknown,authorRun:string){
 const run={run:'run_00000000000000000000000002',predecessor:authorRun,runner:'synthetic-reviewer',pack:'case-compile-criterion-review@1.0.1',pack_digest:'c'.repeat(64),items:[{id:'criterion',fields:{criterion,author_run:authorRun}}]};
 const result={schema:'validation@1',run:run.run,acceptance:'accepted',locks:{pack:run.pack,pack_digest:run.pack_digest},partitions:{delivered:[{item:'criterion',requirements:[{requirement:'review',status:'satisfied',claims:[{statement:{code:'accept'},warrant:{producer:'model',id:'synthetic-model',independence:'human_non_author'},qualifier:{nature:'judgment'},validity:{status:'valid'}}]}]}]}};
 return {run:{external:null,meta:{kind:'run',record:'d'.repeat(64)},model:{kind:'run',body:run}},result:{external:null,meta:{kind:'validation_result',record:'e'.repeat(64)},model:{kind:'validation_result',body:result}}};
}

test('a descriptive expectation is grounded only by a criterion that an independent review accepted',()=>{
 const {f,data,fields}=descriptive(),subject=blockSubject(f,fields);
 // without the review: the local check and the Hub check both stop at the criterion, the requirement is unsatisfied and no workbook is written
 const without=chain(subject,data,[blockQuote()]);
 const missing=without.local.problems.filter(problem=>problem.code==='missing_input');
 assert.equal(missing.length,1,JSON.stringify(without.local.problems));
 assert.match(missing[0].pointer,/^\/blocks\/\d+\/assertions\/0\/criterion$/);assert.match(missing[0].message,/独立复核/);
 assert.equal(without.local.ok,false);
 assert.ok(without.problems.some(outcome=>outcome.reason==='missing_input'&&String(outcome.pointer).endsWith('/criterion')));
 const statuses=Object.fromEntries((without.validation.result.partitions.delivered[0].requirements as Array<{requirement:string;status:string}>).map(row=>[row.requirement,row.status]));
 assert.equal(statuses.expected_grounded,'unsatisfied');
 assert.throws(()=>without.workbook(),/尚未全部核对正确/);
 // with a review of this very criterion by another account, run from this plan run: every gate passes and the workbook reads back
 const review=acceptedReview(data.criteria![0],'run_00000000000000000000000001');
 const reviewed=chain(subject,data,[blockQuote()],review);
 assert.equal(reviewed.local.ok,true,JSON.stringify(reviewed.local.problems));
 assert.deepEqual(reviewed.problems,[],JSON.stringify(reviewed.problems));
 const built=reviewed.workbook();assert.ok(offlineReadback(built.bytes,built.recipes).ok);
 // a review of another criterion does not ground this one
 const other=acceptedReview({...data.criteria![0],literal:EXPECTED+'!'},'run_00000000000000000000000001');
 assert.equal(chain(subject,data,[blockQuote()],other).local.ok,false);
});

// ---- a switch and its inverse: the cleanup the product declares as the inverse is part of the plan
function switchSubject(){
 const f=fixture(),catalog=structuredClone(f.catalog) as {root:string;policy:Record<string,unknown>;entries:unknown[]};
 const native=(path:string)=>({words:path.split('/').slice(2),reference:'tree:'+BLOCK_ROOT+path,signatures:[{id:path,reference:'src:'+BLOCK_ROOT+'/xml@1/x'+path+'/arguments',params:[]}]});
 catalog.entries.push(native('/commands/demo/on'),native('/commands/demo/off'));catalog.policy.inverse_alternatives=[['on','off']];
 return {f,subject:{contract:f.contractDoc,profile:f.profileDoc,inventory:f.inventory,manifest_sha256:f.manifest_sha256,catalog,item:'synthetic-case',location:EXPECTED_REF,fields:f.fields} as Subject};
}
const switched=(cleanup:boolean)=>{
 const blocks:Array<Record<string,unknown>>=[{kind:'CONFIG',id:'turn_on',call:blockCall('demo on')},{kind:'OBSERVE_ASSERT',id:'observe',call:blockCall(),assertions:[assertion()]},...(cleanup?[{kind:'CONFIG',id:'turn_off',call:blockCall('demo off'),cleanup:true}]:[])];
 const data=blockPlan(blocks as Parameters<typeof blockPlan>[0]);data.block_context!.causal_links=[{from:'turn_on',to:'observe',quote:blockQuote()}];return data;
};

test('a switch turned on is turned off again in the plan: neither the local check nor the Hub checks pass it left on, and the paired plan generates',()=>{
 const {subject}=switchSubject();
 const paired=chain(subject,switched(true),[blockQuote()]);
 assert.equal(paired.local.ok,true,JSON.stringify(paired.local.problems));assert.deepEqual(paired.problems,[],JSON.stringify(paired.problems));
 const built=paired.workbook();assert.ok(offlineReadback(built.bytes,built.recipes).ok);
 const left=chain(subject,switched(false),[blockQuote()]);
 assert.equal(left.local.ok,false);assert.ok(left.local.problems.some(problem=>problem.message.includes('/commands/demo/on')),JSON.stringify(left.local.problems));
 assert.ok(left.problems.some(outcome=>outcome.statement.includes('/commands/demo/on')),'the Hub checks do not pass it either');
});

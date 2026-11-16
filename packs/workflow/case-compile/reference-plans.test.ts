// Reference plans as fixtures, offline and synthetic. One frozen run goes through the chain a real run takes before a bed is used:
// the local plan check (tools/check-plan.ts), the Hub's own check functions on the catalog selection the Hub makes
// (testing/offline-hub.ts), the recipes of the generator tool (tools/generate-workbook.ts) and the independent reading of the
// workbook it writes. Every plan of the chain must come out correct at every gate; the negative controls name the gate that refuses.
// The local check and the offline Hub are given one locked tree of the run and read one selection of it (functions/catalog-selection.ts).
// Names and addresses are synthetic (192.0.2.0/24, 2001:db8::/32); nothing here reads a real run, a database or the network.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {checkPlanObject} from './tools/check-plan.ts';
import {frozenRun} from './testing/frozen-run.ts';
import {lockedTreeOf,type FlatCatalog} from './testing/locked-tree.ts';
import {cellFixture,cellPlan,fixture,plan as blockPlan,call as blockCall,assertion,quote as blockQuote,EXPECTED_REF,BLOCK_ROOT} from './testing/blocks.ts';
import {frozenTexts,offlineChecks,offlineProblems,offlineReadback,offlineValidation,offlineWorkbook} from './testing/offline-hub.ts';
import {unique} from './testing/hub-answer.ts';
import {coreModel} from './testing/workbook-model.ts';
import {CONTRACT_DOC,PROFILE_DOC,MANIFEST_DOC,COMMAND_CATALOG,COMMAND_IDENTITIES,QUOTE,AUTOID,goodData} from './functions/test-support.ts';
import {problemsOf} from './functions/plan-boundary.ts';
import {modelCheckpointsOf} from './functions/delivery.ts';
import {labelOf,type ExpectationBasis} from './functions/generated/vocabulary.ts';
import {sha256} from './functions/generated/skills/run-tools/hub-client/index.ts';
import TABLE from './tables/blocks-format.json' with {type:'json'};
import REQUIREMENTS from './requirements.json' with {type:'json'};

const LEASES={now:'2026-10-23T02:00:00.000Z',entries:[]};
const bytesOf=(value:unknown):Uint8Array=>Buffer.from(JSON.stringify(value));
interface Subject {contract:unknown;profile:unknown;inventory:unknown;manifest_sha256?:string;catalog:FlatCatalog&{policy?:unknown};fields:Record<string,unknown>;item:string;location:string}

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

/** The whole chain for one plan, gate by gate; the workbook is written only when every gate came out correct. */
function chain(subject:Subject,data:unknown,quotes:unknown[],review?:unknown,extraTexts:Array<[string,string]>=[]){
 const {run,documents}=runOf(subject,review);
 const slots={plan:[{text:'合成参照计划',quotes,data}]};
 // The locked tree of the run as its download holds it: the local check and the offline Hub both read their catalog from this one tree.
 const tree=lockedTreeOf(subject.catalog,String(run.run));
 const local=checkPlanObject('plan.json',{item:subject.item,handling:'handled',slots},run,tree);
 const texts=frozenTexts(run);for(const [reference,text] of extraTexts)texts.set(reference,text);
 const textOf=(reference:string)=>texts.get(reference);
 const rows=offlineChecks(run,subject.item,slots,tree,textOf);
 // One selection of one tree: in the checks the local check runs, the offline Hub finds the problems the local check finds, no more and no fewer.
 const ran=new Set((local.hub_checks??[]).filter(row=>row.ran).map(row=>row.check));
 assert.ok(ran.size>0,'the local check ran the Hub checks it can run');
 assert.deepEqual(unique(local.problems),unique(rows.filter(row=>ran.has(row.check)).flatMap(row=>row.outcomes.filter(outcome=>outcome.verdict!=='support').flatMap(problemsOf))),'the local check and the offline Hub name the same problems');
 const items=[{item:subject.item,handling:'handled' as const,slots}];
 return {run,slots,local,rows,problems:offlineProblems(rows),validation:offlineValidation(run,items,tree,textOf),workbook:()=>offlineWorkbook(run,items,tree,documents,textOf)};
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
 const rows=offlineChecks(run,subject.item,{plan:[{text:'合成计划',quotes:[QUOTE],data:goodData()}]},lockedTreeOf(subject.catalog,String(run.run)),()=>undefined);
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

// ---- the key name of a 200-character host (round 36): the executor picks the generated segment of the name, never the whole name
// A key file name is `K<host>.+<algorithm>+<id>+<type>+<name>+<size>`; only the id is the device's. The key listing is cut at the
// name's own `+` into six columns, each known column is pinned by `where`, one column is picked, and the command that uses it
// carries the known segments around the placeholder. The picked cell is 5 characters; the name the device gets is 229.
const KEY_LABEL='abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz',KEY_HOST=[KEY_LABEL,KEY_LABEL,KEY_LABEL,'example.com'].join('.');
const KEY_PINS=[{column:1,value:`K${KEY_HOST}.`},{column:2,value:'005'},{column:4,value:'ksk'},{column:5,value:'RSASHA1'},{column:6,value:'1024.key'}];
function keyNamePlan(){
 const data=cellPlan(),select=data.blocks[1];
 select.table={format:'delimited',separator:'+',columns:6,header:false};select.column=3;select.select={where:structuredClone(KEY_PINS)};
 data.blocks[2].call.args=[`demo set "K${KEY_HOST}.+005+{}+ksk+RSASHA1+1024"`];
 return data;
}

test('a block reference plan picks the generated id of a key name of 200 characters and keeps the known segments in the command that uses it, through every gate',()=>{
 assert.equal(KEY_HOST.length,200);
 const f=cellFixture(),result=chain(blockSubject(f),keyNamePlan(),[blockQuote()]);
 assert.equal(result.local.ok,true,JSON.stringify(result.local.problems));
 assert.deepEqual(result.problems,[],JSON.stringify(result.problems));
 const built=result.workbook(),read=offlineReadback(built.bytes,built.recipes);assert.ok(read.ok,JSON.stringify(read));
 const rows=(read as {executions:Array<{object:string;method:string;args:string[];keywords:Record<string,unknown>;h:string;i:string}>}).executions;
 const select=rows.find(row=>row.method==='table_cell')!,used=rows.find(row=>row.i==='selected'&&row.method!=='table_cell')!;
 assert.deepEqual(select.args,['{}',`where 1=K${KEY_HOST}.`,'where 2=005','where 4=ksk','where 5=RSASHA1','where 6=1024.key'],'every known column is pinned by its own condition');
 assert.deepEqual({...select.keywords},{column:3,columns:6,format:'delimited',header:0,row:0,separator:'+'});
 assert.equal(used.args.length,1);
 // what the runner makes of it: the whole picked cell in place of the one placeholder, as the manual writes the name
 const command=used.args[0]!.replace('{}','51877'),name=/"(K[^"]+)"/.exec(command)![1]!;
 assert.equal(command,`demo set "K${KEY_HOST}.+005+51877+ksk+RSASHA1+1024"`);
 assert.equal(name.length,229,'the name is longer than one picked cell may be: the plan never asks for it as a cell');
});

test('the cell rules still refuse what the runner would cut or break in the pins of that plan, at the pin itself, locally and in the Hub checks alike',()=>{
 const f=cellFixture();
 for(const [label,value] of [['a trailing space','1024.key '],['a line break','1024.key\n'],['a control character','1024.\u0001key']] as const){
  const data=keyNamePlan();(data.blocks[1].select.where as Array<{column:number;value:string}>)[4]!.value=value;
  const result=chain(blockSubject(f),data,[blockQuote()]);
  assert.equal(result.local.ok,false,label);
  assert.ok(result.local.problems.some(problem=>problem.pointer.startsWith('/blocks/1/select/where/4')),label+': '+JSON.stringify(result.local.problems));
  assert.ok(result.problems.length>0,label+': the Hub checks refuse it too');
  assert.throws(()=>result.workbook(),/尚未全部核对正确/,label);
 }
 const data=keyNamePlan();data.blocks[1].table.separator=' ';
 const spaced=chain(blockSubject(f),data,[blockQuote()]);
 assert.equal(spaced.local.ok,false);assert.ok(spaced.local.problems.some(problem=>problem.pointer==='/blocks/1/table/separator'),JSON.stringify(spaced.local.problems));
});

test('a block reference plan whose blocks carry descriptions passes every gate of the chain and the descriptions reach column D',()=>{
 const f=cellFixture(),data=cellPlan(),words=data.blocks.map((_block,index)=>`第 ${index+1} 块：合成说明，不是作者步骤原文`);
 data.blocks.forEach((block,index)=>{block.description=words[index];});
 const result=chain(blockSubject(f),data,[blockQuote()]);
 assert.equal(result.local.ok,true,JSON.stringify(result.local.problems));
 assert.deepEqual(result.problems,[],JSON.stringify(result.problems));
 assert.equal(result.validation.result.partitions.delivered[0].requirements.every((row:{requirement:string;status:string})=>row.requirement==='workbook_verified'||row.status==='satisfied'),true);
 const built=result.workbook(),model=coreModel(built.bytes),read=offlineReadback(built.bytes,built.recipes);assert.ok(read.ok,JSON.stringify(read));if(!read.ok)return;
 const d=(row:number)=>model.sheets[0]!.rows.find(entry=>entry.number===row)?.cells.find(cell=>cell.reference==='D'+row)?.text??'';
 const calls=read.executions.filter(execution=>!execution.assertion).map(execution=>d(execution.row));
 assert.equal(calls.length,data.blocks.length);
 assert.ok(calls[0]!.endsWith('\n'+words[0]!),'the first row carries the path, then the description');
 assert.deepEqual(calls.slice(1),words.slice(1),'every other call row carries its block description');
});

// ---- the gate a descriptive expectation meets in a block plan
// Owner, 2026-11-16 (decision 178 of docs/hub-r4-progress.md): where the author wrote a sentence and no literal, the model writes the
// checkpoint itself as a typed criterion beside the verbatim quote and nothing is reviewed. That checkpoint is the model's judgment,
// status 未确认, and the device run decides it. A review that is bound is still verified: a refusal never falls back to the judgment.
const SENTENCE='合成应答带有签名记录',LITERAL='SYNTH-SIG',RATIONALE='合成判据：选应答里的签名记录名作为检查点',MODEL_BASIS:ExpectationBasis='model_judgment';
function descriptive(){
 const f=cellFixture(),data=cellPlan(),quote={reference:EXPECTED_REF,text:SENTENCE};
 // the author's expectation node is a sentence: it carries no literal declaration, so the literal below is the model's own choice
 const fields={...f.fields,expected_nodes:[{reference:EXPECTED_REF,text:SENTENCE}]};
 data.criteria=[{id:'c_literal',expectation:EXPECTED_REF,quote,kind:'literal',operator:'abs_found',literal:LITERAL,rationale:RATIONALE,scope_root:f.catalog.root}];
 for(const block of data.blocks)if(block.kind==='OBSERVE_ASSERT')Object.assign(block.assertions[0],{literal:LITERAL,quote,criterion:'c_literal'});
 data.block_context!.causal_links=[{from:'configure',to:'observe',quote}];
 return {f,data,fields,quote};
}
/**
 * What the Hub freezes into the group once an account other than the author answered the criterion (the shape review/review.test.ts
 * builds): the review run and its validation@1, which accepts the criterion unless `code` says otherwise.
 */
function reviewOf(criterion:unknown,authorRun:string,code='accept'){
 const run={run:'run_00000000000000000000000002',predecessor:authorRun,runner:'synthetic-reviewer',pack:TABLE.review_pack.id+'@'+TABLE.review_pack.version,pack_digest:'c'.repeat(64),items:[{id:'criterion',fields:{criterion,author_run:authorRun}}]};
 const result={schema:'validation@1',run:run.run,acceptance:'accepted',locks:{pack:run.pack,pack_digest:run.pack_digest},partitions:{delivered:[{item:'criterion',requirements:[{requirement:'review',status:'satisfied',claims:[{statement:{code},warrant:{producer:'model',id:'synthetic-model',independence:'human_non_author'},qualifier:{nature:'judgment'},validity:{status:'valid'}}]}]}]}};
 return {run:{external:null,meta:{kind:'run',record:'d'.repeat(64)},model:{kind:'run',body:run}},result:{external:null,meta:{kind:'validation_result',record:'e'.repeat(64)},model:{kind:'validation_result',body:result}}};
}
const statusesOf=(validation:ReturnType<typeof offlineValidation>)=>Object.fromEntries((validation.result.partitions.delivered[0].requirements as Array<{requirement:string;status:string}>).map(row=>[row.requirement,row.status]));
/** The record of the check that grounds the expectations (expected_sources): the one claim it makes, and what that claim carries. */
const groundingOf=(rows:ReturnType<typeof offlineChecks>)=>{
 const outcomes=rows.find(row=>row.check==='expected_sources')!.outcomes;
 assert.equal(outcomes.length,1,JSON.stringify(outcomes));
 return {outcome:outcomes[0],data:outcomes[0].data as {typed_criteria:Array<Record<string,unknown>>;model_criteria?:Array<Record<string,unknown>>}};
};

test('a descriptive expectation is grounded by the criterion the model wrote, as its unconfirmed judgment, with no review',()=>{
 const {f,data,fields,quote}=descriptive(),subject=blockSubject(f,fields);
 // the frozen run holds the empty review pair: nothing was bound, and every gate of the chain still passes
 const alone=chain(subject,data,[quote]);
 assert.equal(alone.local.ok,true,JSON.stringify(alone.local.problems));
 assert.deepEqual(alone.problems,[],JSON.stringify(alone.problems));
 assert.equal(statusesOf(alone.validation).expected_grounded,'satisfied');
 // what the Hub records is the model's own checkpoint: its judgment, status 未确认, decided by the model, never called reviewed
 const {outcome,data:grounded}=groundingOf(alone.rows);
 assert.equal(outcome.verdict,'support');assert.deepEqual(grounded.typed_criteria,[]);assert.equal(grounded.model_criteria!.length,1);
 const judged=grounded.model_criteria![0];
 assert.deepEqual({criterion:judged.criterion,expectation:judged.expectation,assertion:judged.assertion,basis:judged.basis,kind:judged.kind,operator:judged.operator,literal:judged.literal,rationale:judged.rationale,reviewed:judged.reviewed,status:judged.status,decided_by:judged.decided_by,conditional_on_judgment:judged.conditional_on_judgment},
  {criterion:'c_literal',expectation:EXPECTED_REF,assertion:'assertA',basis:MODEL_BASIS,kind:'literal',operator:'abs_found',literal:LITERAL,rationale:RATIONALE,reviewed:false,status:'未确认',decided_by:labelOf('producer_kind','model'),conditional_on_judgment:true});
 assert.deepEqual(judged.quote,quote);
 for(const word of [labelOf('expectation_basis',MODEL_BASIS),labelOf('qualifier_mark','conditional_on_judgment'),'未确认','上机验证'])assert.ok(outcome.statement.includes(word),`${word} / ${outcome.statement}`);
 assert.deepEqual(outcome.judgment_sources,['/plan/0']);
 // the delivery reads the very same record as the model's checkpoint, and the workbook generated from it reads back with that checkpoint
 assert.deepEqual(modelCheckpointsOf(alone.validation.result,subject.item),[{expectation:SENTENCE,literal:LITERAL,rationale:RATIONALE}]);
 const built=alone.workbook(),read=offlineReadback(built.bytes,built.recipes);assert.ok(read.ok,JSON.stringify(read));
 const executions=(read as {executions:Array<{object:string;method:string;args:string[]}>}).executions;
 assert.ok(executions.some(row=>row.object==='check'&&row.method==='abs_found'&&row.args.includes(LITERAL)),'the checkpoint row holds the literal the model chose');
});

test('a review of the criterion that is bound is still verified: accepted it grounds the criterion, otherwise it is refused and the judgment does not stand in',()=>{
 const {f,data,fields,quote}=descriptive(),subject=blockSubject(f,fields),authorRun='run_00000000000000000000000001';
 // a review of this very criterion by another account, run from this plan run: every gate passes, and the criterion counts as reviewed
 const reviewed=chain(subject,data,[quote],reviewOf(data.criteria![0],authorRun));
 assert.equal(reviewed.local.ok,true,JSON.stringify(reviewed.local.problems));
 assert.deepEqual(reviewed.problems,[],JSON.stringify(reviewed.problems));
 const {data:grounded}=groundingOf(reviewed.rows);
 assert.equal(grounded.typed_criteria.length,1);assert.equal(grounded.typed_criteria[0].reviewer,'synthetic-reviewer');assert.equal(grounded.model_criteria,undefined);
 assert.deepEqual(modelCheckpointsOf(reviewed.validation.result,subject.item),[],'a reviewed criterion is not the model\'s unconfirmed checkpoint');
 const built=reviewed.workbook();assert.ok(offlineReadback(built.bytes,built.recipes).ok);
 // a bound review that does not ground this criterion is refused by the local check and by the Hub check alike, with both ways out named, and no workbook follows
 const refused:Array<[string,ReturnType<typeof reviewOf>]>=[
  ['a review of another criterion',reviewOf({...data.criteria![0],literal:LITERAL+'!'},authorRun)],
  ['a review that rejects it',reviewOf(data.criteria![0],authorRun,'reject')],
 ];
 for(const [name,review] of refused){
  const result=chain(subject,data,[quote],review);
  assert.equal(result.local.ok,false,name);
  const missing=result.local.problems.filter(problem=>problem.code==='missing_input');
  assert.equal(missing.length,1,name+': '+JSON.stringify(result.local.problems));
  assert.match(missing[0].pointer,/^\/blocks\/\d+\/assertions\/0\/criterion$/,name);
  assert.ok(missing[0].message.includes('criteria_review')&&missing[0].message.includes(labelOf('expectation_basis',MODEL_BASIS)),name+': '+missing[0].message);
  assert.ok(result.problems.some(outcome=>outcome.reason==='missing_input'&&String(outcome.pointer).endsWith('/criterion')),name);
  assert.equal(statusesOf(result.validation).expected_grounded,'unsatisfied',name);
  assert.throws(()=>result.workbook(),/尚未全部核对正确/,name);
 }
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

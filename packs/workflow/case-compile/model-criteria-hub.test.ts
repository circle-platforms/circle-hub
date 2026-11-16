// Against a real Hub on a temporary PostgreSQL: a block plan whose typed criterion the model wrote itself, with no review bound,
// is accepted; the Hub records the checkpoint as the model's judgment (unconfirmed, conditional) and the workbook generates.
// Entirely synthetic resources. Needs the network isolation the pack functions run under, like the review stage's own test.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {startPostgres} from '../../../hub/testing/postgres.ts';
import {createCatalogView,osIsolationAvailable} from '../../../hub/rules/api.ts';
import {openHub,call,ROOT} from './testing/hub.ts';
import {fixture,positiveBlocks,EXPECTED,BLOCK_ROOT} from './testing/blocks.ts';
import {generateWorkbook} from './functions/generate.ts';
import {readWorkbook} from './functions/workbook.ts';
import {modelCheckpointsOf} from './functions/delivery.ts';
import {satisfiedRecipe} from './tools/generate-workbook.ts';
import {coreModel} from './testing/workbook-model.ts';

const skip = (await osIsolationAvailable()) ? false : 'no OS network isolation on this machine (sandbox-exec)';
const LITERAL='SYNTH-SIG',RATIONALE='合成理由：模型选择应答里的签名记录名作为检查点';
test('a typed criterion the model wrote itself is accepted without a review and recorded as the model\'s unconfirmed judgment',{skip},async()=>{
 const postgres=await startPostgres();let hub:Awaited<ReturnType<typeof openHub>>|undefined;
 try{
  hub=await openHub(postgres);
  const f=fixture(),raw=positiveBlocks().OBSERVE_ASSERT as any;
  const catalog=JSON.parse(JSON.stringify(f.catalog).split(BLOCK_ROOT).join(ROOT));f.fields.command_catalog=catalog;
  const oldInfo=await hub.knowledge.rootOfBuild('widget','Fixture_Build_A');assert.ok(oldInfo);const info={...oldInfo,command_policy:catalog.policy};hub.knowledge.rootOfBuild=async()=>info;hub.knowledge.currentRoot=async()=>info;hub.knowledge.rootInfo=async()=>[info];hub.knowledge.catalog=async()=>createCatalogView(catalog.entries,{reference:'tree:'+ROOT+'/commands',complete:true,caseSensitive:true});
  // the author's expectation is a sentence: the node carries no literal declaration
  const source=JSON.stringify({root:{data:{id:'root',text:'合成 ORBIT'},children:[{data:{id:'case',priority:2,autoid:'SYN-BLOCK-1',text:'合成用例'},children:[{data:{id:'step',text:'合成观察'},children:[{data:{id:'expected',text:EXPECTED}}]}]}]}});
  hub.external.put('agile:mindmap:model-criteria',{bytes:Buffer.from(source),mediaType:'application/json'});
  for(const [name,data]of Object.entries({contract:f.contractDoc,profile:f.profileDoc,inventory:f.inventory}))hub.external.put('doc:doc:model-'+name,{bytes:Buffer.from(JSON.stringify(data)),mediaType:'application/json'});
  // no criteria_review, no criteria_review_run: the model's own checkpoint is all there is
  const inputs={subject:{external:'agile:mindmap:model-criteria'},contract:{external:'doc:doc:model-contract'},profile:{external:'doc:doc:model-profile'},inventory:{external:'doc:doc:model-inventory'}};
  const started=await hub.service.startRunDetailed(hub.alice,{pack:'case-compile',product:'widget',build:'Fixture_Build_A',inputs,parameters:{autoid:'SYN-BLOCK-1'}},call());
  assert.equal(started.answer.call_result,'ok',JSON.stringify(started.answer.errors));const run=started.answer.run!;
  const location=run.items[0].location.replace('/n/case','/n/expected');
  const a=raw.blocks[0].assertions[0];a.quote={reference:location,text:EXPECTED};a.expectation=location;a.literal=LITERAL;a.criterion='criterion';raw.obligations[0].expectation=location;
  raw.criteria=[{id:'criterion',expectation:location,quote:a.quote,kind:'literal',operator:'abs_found',literal:LITERAL,rationale:RATIONALE,scope_root:ROOT}];
  const sent={run:run.run,model:'synthetic-author',items:[{item:run.items[0].id,handling:'handled' as const,slots:{plan:[{text:'合成块计划',quotes:[a.quote],data:raw}]}}]};
  const checked=await hub.service.submitResult(hub.alice,sent,call());assert.equal(checked.acceptance,'accepted',JSON.stringify(checked.errors));
  const requirements=Object.values(checked.result!.partitions).flat().flatMap(item=>item.requirements);
  for(const requirement of requirements.filter(row=>row.requirement!=='workbook_verified'))assert.equal(requirement.status,'satisfied',JSON.stringify(requirement));
  const grounded=requirements.find(row=>row.requirement==='expected_grounded')!;
  // what the Hub records: the mechanical check as a fact conditional on judgment, and the model's own claim as a judgment
  const fact=grounded.claims.find(claim=>claim.warrant.producer==='function'&&claim.statement.verdict==='support')!;
  assert.ok(fact,JSON.stringify(grounded));assert.ok(fact.qualifier.marks.includes('conditional_on_judgment'),JSON.stringify(fact.qualifier));
  const data=fact.statement.data as {typed_criteria:unknown[];model_criteria:Array<Record<string,unknown>>};
  assert.deepEqual(data.typed_criteria,[]);assert.equal(data.model_criteria.length,1);
  assert.deepEqual({reviewed:data.model_criteria[0].reviewed,status:data.model_criteria[0].status,decided_by:data.model_criteria[0].decided_by,literal:data.model_criteria[0].literal,rationale:data.model_criteria[0].rationale},{reviewed:false,status:'未确认',decided_by:'模型',literal:LITERAL,rationale:RATIONALE});
  const judgment=grounded.claims.find(claim=>claim.warrant.producer==='model');
  assert.ok(judgment,JSON.stringify(grounded));assert.equal(judgment.qualifier.nature,'judgment');assert.ok(judgment.qualifier.marks.includes('conditional_on_judgment'));assert.equal(judgment.warrant.id,'synthetic-author');
  assert.notEqual(judgment.warrant.independence,'human_non_author');
  // the delivery reads the same record
  assert.deepEqual(modelCheckpointsOf(checked.result,run.items[0].id),[{expectation:EXPECTED,literal:LITERAL,rationale:RATIONALE}]);
  // and the workbook generates from the accepted result and reads back
  const recipe=satisfiedRecipe({run:started.answer,result:checked,submission:sent,contract:Buffer.from(JSON.stringify(f.contractDoc)),profile:Buffer.from(JSON.stringify(f.profileDoc)),inventory:Buffer.from(JSON.stringify(f.inventory))});
  const bytes=generateWorkbook(recipe);assert.ok(readWorkbook(coreModel(bytes),recipe).ok);assert.deepEqual(generateWorkbook(recipe),bytes);
 }finally{await hub?.close();await postgres.stop();}
});

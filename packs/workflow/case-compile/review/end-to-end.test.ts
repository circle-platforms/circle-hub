// Real append-only run records and sandboxed review; entirely synthetic resources.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {join} from 'node:path';
import {cp,mkdir,readFile} from 'node:fs/promises';
import {startPostgres} from '../../../../hub/testing/postgres.ts';
import {INDEX} from '../../../../hub/runs/engine/store.ts';
import {temporaryDirectory} from '../../../../hub/runs/api.ts';
import {openHub,call,ROOT} from '../testing/hub.ts';
import {fixture,positiveBlocks,EXPECTED,BLOCK_ROOT} from '../testing/blocks.ts';
import {criterionReviewed} from '../functions/block-expected.ts';
import {checkExpectedSources} from '../functions/checks.ts';
import {generateWorkbook} from '../functions/generate.ts';
import {readWorkbook} from '../functions/workbook.ts';
import {satisfiedRecipe} from '../tools/generate-workbook.ts';
import {coreModel} from '../testing/workbook-model.ts';
import {createCatalogView,osIsolationAvailable} from '../../../../hub/rules/api.ts';
import {fileURLToPath} from 'node:url';

const skip = (await osIsolationAvailable()) ? false : 'no OS network isolation on this machine (sandbox-exec)';
test('a real independent review binds the original declaration and grounds a block workbook',{skip},async()=>{
 const postgres=await startPostgres(),temp=await temporaryDirectory('block-review-');let hub:Awaited<ReturnType<typeof openHub>>|undefined;
 try{
  hub=await openHub(postgres);
  const dir=join(temp.path,'review'),base=fileURLToPath(new URL('./',import.meta.url));await mkdir(dir,{recursive:true});const manifest=JSON.parse(await readFile(join(base,'pack.json'),'utf8'));for(const file of ['pack.json',...manifest.files.map((f:any)=>f.path)]){await mkdir(join(dir,file,'..'),{recursive:true});await cp(join(base,file),join(dir,file));}
  const published=await hub.registry.publish(hub.alice,dir);assert.equal(published.ok,true,JSON.stringify(published));
  await hub.registry.assign(hub.admin,hub.admin.id,'case-compile-criterion-review');
  // A genuine author run may be incomplete; the independent stage reads its immutable submitted declaration.
  const f=fixture(),raw=positiveBlocks().OBSERVE_ASSERT as any;
  const catalog=JSON.parse(JSON.stringify(f.catalog).split(BLOCK_ROOT).join(ROOT));f.fields.command_catalog=catalog;
  const oldInfo=await hub.knowledge.rootOfBuild('widget','Fixture_Build_A');assert.ok(oldInfo);const info={...oldInfo,command_policy:catalog.policy};hub.knowledge.rootOfBuild=async()=>info;hub.knowledge.currentRoot=async()=>info;hub.knowledge.rootInfo=async()=>[info];hub.knowledge.catalog=async()=>createCatalogView(catalog.entries,{reference:'tree:'+ROOT+'/commands',complete:true,caseSensitive:true});
  const source=JSON.stringify({root:{data:{id:'root',text:'合成 ORBIT'},children:[{data:{id:'case',priority:2,autoid:'SYN-BLOCK-1',text:'合成用例'},children:[{data:{id:'step',text:'合成观察'},children:[{data:{id:'expected',text:EXPECTED}}]}]}]}});
  const original=await hub.kit.artifacts.ingest({bytes:Buffer.from(source),mediaType:'application/json',origin:{read:{object:'fixture:document:block-source'}},author:{user:null},provenanceType:'observed',visibility:{readers:[hub.alice.id,hub.bob.id],admins:true,packs:[],shareable:false},name:'synthetic.json'});
  // Register the source through the same reader used by real workflow inputs.
  hub.external.put('agile:mindmap:block-review',{bytes:Buffer.from(source),mediaType:'application/json'});
  for(const [name,data]of Object.entries({contract:f.contractDoc,profile:f.profileDoc,inventory:f.inventory}))hub.external.put('doc:doc:block-'+name,{bytes:Buffer.from(JSON.stringify(data)),mediaType:'application/json'});
  const started=await hub.service.startRunDetailed(hub.alice,{pack:'case-compile',product:'widget',build:'Fixture_Build_A',inputs:{subject:{external:'agile:mindmap:block-review'},contract:{external:'doc:doc:block-contract'},profile:{external:'doc:doc:block-profile'},inventory:{external:'doc:doc:block-inventory'}},parameters:{autoid:'SYN-BLOCK-1'}},call());
  assert.equal(started.answer.call_result,'ok',JSON.stringify(started.answer.errors));const author=started.answer.run!;
  const location=author.items[0].location.replace('/n/case','/n/expected');
  const a=raw.blocks[0].assertions[0];a.quote={reference:location,text:EXPECTED};a.expectation=location;a.criterion='criterion';raw.obligations[0].expectation=location;
  const criterion={id:'criterion',expectation:location,quote:a.quote,kind:'literal',operator:'abs_found',literal:EXPECTED,rationale:'合成模型判据，交独立复核',scope_root:ROOT};raw.criteria=[criterion];
  const submitted=await hub.service.submitResult(hub.alice,{run:author.run,model:'synthetic-author',items:[{item:author.items[0].id,handling:'handled',slots:{plan:[{text:'合成块计划',quotes:[a.quote],data:raw}]}}]},call());
  assert.equal(submitted.acceptance,'accepted',JSON.stringify(submitted.errors));
  const records=await hub.kit.store.find({kind:'submission',key:INDEX.submissionRun,value:author.run});assert.equal(records.items.length,1);
  const review=await hub.service.startRunDetailed(hub.admin,{pack:'case-compile-criterion-review',predecessor:author.run,inputs:{declaration:{reference:'rec:'+records.items[0].digest},evidence:[{reference:'src:'+original.body.sha256}]}},call());
  assert.equal(review.answer.call_result,'ok',JSON.stringify(review.answer.errors));const run=review.answer.run!;
  const accepted=await hub.service.submitResult(hub.admin,{run:run.run,model:'synthetic-reviewer',items:run.items.map(item=>({item:item.id,handling:'handled',slots:{review:[{code:'accept',text:'合成独立接受判断',location:item.location,quotes:[a.quote],data:{reason:'按作者期望复核合成判据'}}]}}))},call());
  assert.equal(accepted.acceptance,'accepted',JSON.stringify(accepted.errors));
  const snapshot=(await hub.kit.store.find({kind:'run',key:INDEX.runId,value:run.run})).items[0];
  const evidence={run:{external:null,meta:{kind:'run',record:snapshot.digest},model:{kind:'run',body:snapshot.body}},result:{external:null,meta:{kind:'validation_result',record:'d'.repeat(64)},model:{kind:'validation_result',body:accepted.result}}};
  assert.ok(criterionReviewed(criterion,evidence).ok,JSON.stringify(accepted.result));
  await hub.kit.authorizations.share(hub.admin,run.run,[hub.alice.id]);
  const resultRecord=(await hub.kit.store.find({kind:'validation_result',key:INDEX.resultRun,value:run.run,newestFirst:true})).items[0];
  const revised=await hub.service.startRunDetailed(hub.alice,{pack:'case-compile',product:'widget',build:'Fixture_Build_A',predecessor:author.run,inputs:{subject:{external:'agile:mindmap:block-review'},contract:{external:'doc:doc:block-contract'},profile:{external:'doc:doc:block-profile'},inventory:{external:'doc:doc:block-inventory'},criteria_review:{reference:'rec:'+resultRecord.digest},criteria_review_run:{reference:'rec:'+snapshot.digest}},parameters:{autoid:'SYN-BLOCK-1'}},call());
  assert.equal(revised.answer.call_result,'ok',JSON.stringify(revised.answer.errors));
  const sent={run:revised.answer.run!.run,model:'synthetic-author',items:[{item:revised.answer.run!.items[0].id,handling:'handled' as const,slots:{plan:[{text:'合成块计划',quotes:[a.quote],data:raw}]}}]};
  const checked=await hub.service.submitResult(hub.alice,sent,call());assert.equal(checked.acceptance,'accepted',JSON.stringify(checked.errors));
  const requirements=Object.values(checked.result!.partitions).flat().flatMap(item=>item.requirements);for(const requirement of requirements.filter(row=>row.requirement!=='workbook_verified'))assert.equal(requirement.status,'satisfied',JSON.stringify(requirement));
  const subject=f.subject(raw,{command_catalog:catalog,expected_nodes:[{reference:location,text:EXPECTED}],criteria_review:evidence}).subject;
  assert.equal(checkExpectedSources({subject} as any)[0].verdict,'support');
  const recipe=satisfiedRecipe({run:revised.answer,result:checked,submission:sent,contract:Buffer.from(JSON.stringify(f.contractDoc)),profile:Buffer.from(JSON.stringify(f.profileDoc)),inventory:Buffer.from(JSON.stringify(f.inventory))});
  const bytes=generateWorkbook(recipe);assert.ok(readWorkbook(coreModel(bytes),recipe).ok);assert.deepEqual(generateWorkbook(recipe),bytes);
 }finally{await hub?.close();await temp.remove();await postgres.stop();}
});

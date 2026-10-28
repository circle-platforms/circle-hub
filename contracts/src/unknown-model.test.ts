// Synthetic contract regressions for the unknown-sweep changes; no Hub or product modules execute here.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {AjvJsonSchemaValidator} from '@modelcontextprotocol/sdk/validation/ajv';
import {RunRecord,RunSummary} from './run.ts';
import * as runContracts from './run.ts';
import {StartRunInput} from './tools.ts';
import {accepted,copy,runRecord,summary} from './fixtures.ts';
import * as pack from './pack.ts';
import {CheckEntry,ErrorHandlingRow,RequirementTemplate} from './pack.ts';
import {SkippedItem} from './submission.ts';
import * as resources from './resources.ts';
import {ReadProjectionOutput,RouteDeclaration} from './resources.ts';
import {CatalogParam} from './tables.ts';
import {RangeTable} from './tables.ts';
import {CheckOutcome} from './tables.ts';
import {LayerResult} from './validation.ts';
import * as validation from './validation.ts';
import {DISPOSITION,ENVIRONMENT,EXIT_ACTION,labelOf} from '../generated/vocabulary.ts';

test('item 4 preserves the disposition code while naming its time-bounded meaning',()=>{
  assert.ok(DISPOSITION.includes('keep_unknown'));
  assert.equal(labelOf('disposition','keep_unknown'),'带期限的暂缓');
  assert.ok(!EXIT_ACTION.some(action=>(action as string)==='keep_unknown'),'keeping unknown is never an exit action');
});


const due='2026-11-01T12:00:00.000Z';
const automatic={action:'reread',audience:{hub:true},due};
const gap={missing:'Temporary read result of a bound synthetic source',exit:automatic};
const unknown={verdict:'unknown',statement:'缺少合成原件',grounds:[],tier:'blocking',reason:'missing_input'};
test('item 3 refuses a check unknown without top-level missing but lets the Hub fill its exit',()=>{
  assert.equal(CheckOutcome.safeParse(unknown).success,false);
  assert.equal(CheckOutcome.safeParse({...unknown,data:{missing:['/source']}}).success,false);
  assert.ok(CheckOutcome.safeParse({...unknown,missing:gap.missing}).success);
  assert.ok(CheckOutcome.safeParse({...unknown,...gap}).success);
});
test('item 3 requires a complete recovery for every transitional new layer',()=>{
  for(const layer of [{layer:'static',terminal:'unchecked'},{layer:'static',terminal:'incomplete'},{layer:'dynamic',terminal:'not_run'},{layer:'dynamic',terminal:'no_verdict'},{layer:'dynamic',terminal:'incomplete'}]){
    const value={...layer,reason:'missing_input'};assert.equal(LayerResult.safeParse(value).success,false);
    assert.equal(LayerResult.safeParse({...value,missing:' '}).success,false);
    assert.equal(LayerResult.safeParse({...value,...gap,exit:{...automatic,due:'later'}}).success,false);
    assert.ok(LayerResult.safeParse({...value,...gap}).success);
  }
  assert.ok(LayerResult.safeParse({layer:'static',terminal:'pass'}).success);
});
test('item 3 binds request kind and a named audience only to request exits',()=>{
  const valid={...unknown,missing:gap.missing};
  for(const exit of [{action:'request',audience:{user:'usr_01m5h9zh07x7amhg4bwmye5yhw'},due},{...automatic,request_kind:'repair'},{action:'request',request_kind:'repair',audience:{hub:true},due}])assert.equal(CheckOutcome.safeParse({...valid,exit}).success,false);
  assert.ok(CheckOutcome.safeParse({...valid,exit:{action:'request',request_kind:'repair',audience:{user:'usr_01m5h9zh07x7amhg4bwmye5yhw'},due}}).success);
});


test('item 3 reads historical omissions without inventing facts, actors or deadlines',()=>{
  const legacy=validation.ValidationResult.parse(copy(accepted));const requirement=legacy.partitions.delivered[0].requirements[0];
  requirement.layers=[{layer:'static',terminal:'unchecked',reason:'timeout'}];requirement.status='pending';
  assert.equal(validation.ValidationResult.safeParse(legacy).success,false);
  const read=validation.readStoredValidationResult(legacy);assert.deepEqual(read.result,legacy);
  assert.ok(read.notices.some(note=>note.path.endsWith('/exit')&&note.message==='出口未写'));
  assert.ok(!Object.hasOwn(read.result.partitions.delivered[0].requirements[0].layers[0],'exit'));
  assert.deepEqual(legacy,read.result);
});
test('item 3 retains independent secondary reasons and their own recovery facts',()=>{
  const value={layer:'static',terminal:'unchecked',reason:'missing_input',...gap,gaps:[{reason:'budget_exhausted',missing:'Remaining synthetic batch',exit:{...automatic,action:'rerun'}}]};
  const parsed=LayerResult.parse(value);assert.equal(parsed.gaps?.length,1);assert.equal(parsed.gaps?.[0].reason,'budget_exhausted');
  assert.equal(LayerResult.safeParse({...value,gaps:[{reason:'budget_exhausted',missing:'batch'}]}).success,false);
});
test('item 3 publishes the same recovery admission constraints in JSON Schema',()=>{
  const ajv=new AjvJsonSchemaValidator();
  const check=ajv.getValidator(JSON.parse(readFileSync(new URL('../generated/schemas/check-outcome.v1.schema.json',import.meta.url),'utf8')));
  for(const value of [unknown,{...unknown,missing:gap.missing},{...unknown,...gap},{...unknown,...gap,exit:{action:'request',audience:{hub:true},due}}])assert.equal(check(value).valid,CheckOutcome.safeParse(value).success,JSON.stringify(value));
  const result=validation.ValidationResult.parse(copy(accepted));result.partitions.delivered[0].requirements[0].layers=[{layer:'static',terminal:'unchecked',reason:'timeout'}];
  const validate=ajv.getValidator(JSON.parse(readFileSync(new URL('../generated/schemas/validation.v1.schema.json',import.meta.url),'utf8')));
  assert.equal(validate(result).valid,false);Object.assign(result.partitions.delivered[0].requirements[0].layers[0],gap);assert.equal(validate(result).valid,true);
});


test('item 6 declares empty threshold behavior while omission means failure',()=>{
  const table={schema:'range@1',origin:'Synthetic threshold rule',checks:[{values:'$.items[*]',threshold:{measure:'min',minimum:1,empty:'support'}}]};
  assert.ok(RangeTable.safeParse({...table,checks:[{values:'$.items[*]',threshold:{measure:'min',minimum:1}}]}).success);
  assert.ok(RangeTable.safeParse(table).success);
  assert.ok(RangeTable.safeParse({...table,checks:[{values:'$.items[*]',threshold:{measure:'min',minimum:1,empty:'refute'}}]}).success);
  assert.equal(RangeTable.safeParse({...table,checks:[{values:'$.items[*]',threshold:{measure:'min',empty:'unknown'}}]}).success,false);
});


test('item 7 selects error handling by exactly one code or generated reason',()=>{
  assert.ok(ErrorHandlingRow.safeParse({reason:'declared_skip',action:'repair',max_rounds:2}).success);
  assert.ok(ErrorHandlingRow.safeParse({code:'core.structure.required_empty',action:'repair',max_rounds:2}).success);
  for(const value of [{action:'repair',max_rounds:2},{code:'*',reason:'timeout',action:'repair',max_rounds:2},{reason:'invented_reason',action:'unknown'}])assert.equal(ErrorHandlingRow.safeParse(value).success,false);
  const req={key:'test',name:'合成要求',description:'合成事实',target:'item',required:true,done_rule:'gating',layers:['static'],accepted_producer:'fact',checks:['check'],error_handling:[{reason:'timeout',action:'repair',max_rounds:1},{reason:'missing_input',action:'repair',max_rounds:2}]};
  assert.ok(RequirementTemplate.safeParse(req).success);assert.equal(RequirementTemplate.safeParse({...req,error_handling:[req.error_handling[0],req.error_handling[0]]}).success,false);
  assert.equal(SkippedItem.safeParse({item:'one',handling:'skipped',reason:'not completed',missing:'Synthetic remaining work'}).success,true);
});


test('item 5 gives fact publication a strict coverage boundary without hiding legacy omissions',()=>{
  const fact={key:'work',name:'合成要求',description:'合成事实',target:'item',required:true,done_rule:'gating',layers:['static'],accepted_producer:'fact',checks:[],error_handling:[]};
  const body={schema:'requirements@1',requirements:[fact]};assert.ok(pack.RequirementsFile.safeParse(body).success);
  assert.equal(pack.PublishableRequirementsFile.safeParse(body).success,false);
  assert.ok(pack.PublishableRequirementsFile.safeParse({...body,requirements:[{...fact,checks:['shape']}]}).success);
  assert.ok(pack.PublishableRequirementsFile.safeParse({...body,requirements:[{...fact,accepted_producer:'judgment'}]}).success);
  assert.equal(pack.PublishableRequirementsFile.safeParse({...body,requirements:[{...fact,layers:['dynamic']}]}).success,false);
  assert.ok(pack.PublishableRequirementsFile.safeParse({...body,requirements:[{...fact,layers:['dynamic'],observation:'synthetic.observe@1'}]}).success);
});
test('item 5 per-check work limits stay within the sandbox maxima and exclude effect budgets',()=>{
  const check={id:'test',function:{module:'functions/check.ts'},applies:'item',judges:'subject',limits:{outputBytes:64*1024*1024,timeoutMs:120000}};
  assert.ok(CheckEntry.safeParse(check).success);
  assert.equal(CheckEntry.safeParse({...check,limits:{outputBytes:64*1024*1024+1}}).success,false);
  assert.equal(CheckEntry.safeParse({...check,limits:{effects:3}}).success,false);
});

test('item 5 contract capacities match the independent sandbox protocol capacities',()=>{
  const text=readFileSync(new URL('../../hub/rules/sandbox/sandbox.ts',import.meta.url),'utf8');
  const body=/const MAX_LIMITS: SandboxLimits = \{([\s\S]*?)\};/.exec(text)?.[1];assert.ok(body);
  const values=Object.fromEntries([...body.matchAll(/([A-Za-z]+):\s*([0-9_* ]+)/g)].map(match=>[match[1],match[2].split('*').reduce((value,part)=>value*Number(part.replaceAll('_','').trim()),1)]));
  assert.deepEqual(pack.CHECK_LIMITS_MAX,values);
});


test('item 8 freezes an absolute submission deadline and declares a required predecessor',()=>{
  assert.ok(StartRunInput.safeParse({pack:'synthetic',inputs:{},submission_due:due}).success);
  assert.ok(RunSummary.safeParse({...summary,submission_due:due}).success);
  assert.ok(RunRecord.safeParse({...runRecord,submission_due:due}).success);
  assert.equal(runContracts.NewRunRecord.safeParse(runRecord).success,false);
  assert.ok(runContracts.NewRunRecord.safeParse({...runRecord,submission_due:due}).success);
  assert.equal(runContracts.NewRunRecord.safeParse({...runRecord,submission_due:'2026-01-01T00:00:00.000Z'}).success,false);
  const workflow={schema:'workflow@1',inputs:[{slot:'subject',role:'subject',description:'合成主体',accepts:['application/json'],required:true,many:false}],parameters:[],product:{catalogs:[]},subject:'subject',projection:{module:'functions/project.ts'},predecessor:'required'};
  assert.ok(pack.WorkflowFile.safeParse(workflow).success);assert.equal(pack.WorkflowFile.safeParse({...workflow,predecessor:'optional'}).success,false);
});
test('item 8 allows only fact-producing automatic successors with a named runner',()=>{
  const value={...runRecord,host:'hub',trigger:'event_or_schedule',configurer:'usr_01m5h9zh07x7amhg4bwmye5yhw',predecessor:'run_01m5h9zh07x7amhg4bwmye5yhw',submission_due:due};
  assert.ok(RunRecord.safeParse(value).success);
  assert.equal(RunRecord.safeParse({...value,predecessor:undefined}).success,false);
  assert.equal(RunRecord.safeParse({...value,runner:undefined}).success,false);
  assert.equal(RunRecord.safeParse({...value,requirements:value.requirements.map(requirement=>({...requirement,accepted_producer:'judgment'}))}).success,false);
});


test('item 9 represents a determinate absent observation separately from a read error',()=>{
  const absent={code:'SOURCE_ABSENT',system:'synthetic-system',object:'synthetic:record:one',observed_at:due};
  assert.ok(ReadProjectionOutput.safeParse({artifacts:[],absent}).success);
  assert.equal(ReadProjectionOutput.safeParse({artifacts:[],absent:{...absent,observed_at:undefined}}).success,false);
  assert.equal(ReadProjectionOutput.safeParse({error:{code:'SOURCE_UNAVAILABLE',message:'not available'},absent}).success,false);
  assert.equal(ReadProjectionOutput.safeParse({artifacts:[{name:'content',media_type:'text/plain',text:'found'}],absent}).success,false);
});
test('item 9 allows explicit finite pagination and same-origin redirects on read routes',()=>{
  const route={id:'read',role:'primary',method:'GET',path:'/records',response:'text',max_bytes:1024,read:true,pagination:{max_pages:4},redirects:{same_origin:true,max_hops:2}};
  assert.ok(RouteDeclaration.safeParse(route).success);
  assert.equal(RouteDeclaration.safeParse({...route,redirects:{same_origin:false,max_hops:2}}).success,false);
  assert.equal(RouteDeclaration.safeParse({...route,pagination:{max_pages:0}}).success,false);
  assert.ok(RouteDeclaration.safeParse({...route,media_types_by_extension:{'.adoc':'text/plain','.md':'text/markdown'}}).success);
  assert.equal(RouteDeclaration.safeParse({...route,media_types_by_extension:{'adoc':'text/plain'}}).success,false);
  assert.equal(RouteDeclaration.safeParse({...route,media_types_by_extension:{'.ADOC':'text/plain'}}).success,false);
  assert.equal(RouteDeclaration.safeParse({...route,media_types_by_extension:{'.adoc':'plain'}}).success,false);
  const oversized=Object.fromEntries(Array.from({length:33},(_,i)=>([`.ext${i}`,'text/plain'])));
  assert.equal(RouteDeclaration.safeParse({...route,media_types_by_extension:oversized}).success,false);
});


test('item 9 activates at most one provider of an external type in an environment',()=>{
  const first={resource:'res_'+'1'.repeat(26),environment:ENVIRONMENT[0],enabled:true,types:['synthetic:record']},second={...first,resource:'res_'+'2'.repeat(26)};
  assert.equal(resources.ReadResourceRoutingSet.safeParse([first,second]).success,false);
  assert.ok(resources.ReadResourceRoutingSet.safeParse([first,{...second,enabled:false}]).success);
  assert.ok(resources.ReadResourceRoutingSet.safeParse([first,{...second,types:['synthetic:other']}]).success);
  assert.ok(resources.ReadResourceRoutingSet.safeParse([first,{...second,environment:ENVIRONMENT[1]}]).success);
});


test('item 10 catalogs declare host unions and address roles with resolved scalar constraints',()=>{
  assert.ok(CatalogParam.safeParse({name:'peer',type:'ip_or_hostname',address_role:'synthetic_peer'}).success);
  assert.ok(CatalogParam.safeParse({name:'host',type:'hostname'}).success);
  assert.equal(CatalogParam.safeParse({name:'peer',type:'ip_or_hostname',address_role:' '}).success,false);
  assert.ok(CatalogParam.safeParse({name:'exact',type:'int',minimum:7,maximum:7}).success);
  assert.ok(CatalogParam.safeParse({name:'ceiling',type:'int',maximum:7}).success);
  assert.ok(CatalogParam.safeParse({name:'mode',type:'enum',values:['synthetic_one']}).success);
  assert.equal(CatalogParam.safeParse({name:'raw',type:'int',limit:7}).success,false,'the core must not guess a product-specific scalar limit mode');
});

test('reason selectors cannot reject an artifact and the generated boundary agrees',()=>{
  const invalid={reason:'check_error',action:'reject'};
  const result=ErrorHandlingRow.safeParse(invalid);
  assert.equal(result.success,false);
  if(!result.success)assert.ok(result.error.issues.some(issue=>issue.path.join('/')==='action'));
  assert.ok(ErrorHandlingRow.safeParse({code:'core.structure.required_empty',action:'reject'}).success);
  assert.ok(ErrorHandlingRow.safeParse({reason:'check_error',action:'repair',max_rounds:2}).success);
  const validate=new AjvJsonSchemaValidator().getValidator(JSON.parse(readFileSync(new URL('../generated/schemas/requirements.v1.schema.json',import.meta.url),'utf8')));
  const fact={key:'test',name:'合成要求',description:'合成事实',target:'item',required:true,done_rule:'gating',layers:['static'],accepted_producer:'fact',checks:['check']};
  for(const row of [invalid,{code:'core.structure.required_empty',action:'reject'},{reason:'check_error',action:'repair',max_rounds:2}]){
    const body={schema:'requirements@1',requirements:[{...fact,error_handling:[row]}]};
    assert.equal(validate(body).valid,pack.RequirementsFile.safeParse(body).success);
  }
});

test('contract minimum work limits match the sandbox protocol and reject values below it',()=>{
  const text=readFileSync(new URL('../../hub/rules/sandbox/sandbox.ts',import.meta.url),'utf8');
  const body=/const MIN_LIMITS: SandboxLimits = \{([\s\S]*?)\};/.exec(text)?.[1];assert.ok(body);
  const values=Object.fromEntries([...body.matchAll(/([A-Za-z]+):\s*([0-9_* ]+)/g)].map(match=>[match[1],match[2].split('*').reduce((value,part)=>value*Number(part.replaceAll('_','').trim()),1)]));
  assert.deepEqual(pack.CHECK_LIMITS_MIN,values);
  for(const [key,value] of Object.entries(values)){
    assert.ok(pack.CheckWorkLimits.safeParse({[key]:value}).success);
    assert.equal(pack.CheckWorkLimits.safeParse({[key]:value-1}).success,false,key);
  }
});

test('external exit identities report identity errors rather than missing-fact errors',()=>{
  const result=validation.ExitAudience.safeParse({external:{mapping:'rec:'+'a'.repeat(64),identity:' '}});
  assert.equal(result.success,false);
  if(!result.success){const errors=JSON.stringify(result.error.issues);assert.ok(errors.includes('name the mapped external identity'));assert.ok(!errors.includes('name the missing fact'));}
  assert.ok(validation.ExitAudience.safeParse({external:{mapping:'rec:'+'a'.repeat(64),identity:'synthetic-account'}}).success);
});

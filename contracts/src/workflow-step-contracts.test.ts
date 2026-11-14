import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {WorkflowFile, RequirementTemplate, RequirementsFile} from './pack.ts';
import {SubmitResultOutput} from './tools.ts';
import {accepted, acceptedCounts} from './fixtures.ts';

const workflow = {
  schema:'workflow@1',
  inputs:[{slot:'subject',role:'subject',description:'Synthetic source',accepts:['application/json'],required:true,many:false}],
  parameters:[],product:{catalogs:[]},subject:'subject',projection:{module:'functions/project.ts'},
};
const requirement = {key:'structure',name:'Synthetic requirement',description:'Synthetic check',target:'item',required:true,done_rule:'bookkeeping',layers:['static'],accepted_producer:'fact',checks:['structure'],error_handling:[]};
const output = {call_result:'ok',errors:[],trace:'b'.repeat(32),acceptance:'accepted',result:accepted,counts:acceptedCounts()};

test('legacy workflow, requirements and submit outputs need no step declarations or defaults', () => {
  assert.equal(WorkflowFile.parse(workflow).steps,undefined);
  assert.equal(RequirementTemplate.parse(requirement).step,undefined);
  assert.equal(SubmitResultOutput.parse(output).step_name,undefined);
});

test('workflow steps have exact local identities, nonempty names and no duplicate ids', () => {
  const value = {...workflow,steps:[{id:'author',name:'合成编写'},{id:'verify',name:'合成核对'}]};
  assert.deepEqual(WorkflowFile.parse(value).steps,value.steps);
  assert.equal(WorkflowFile.safeParse({...value,steps:[value.steps[0],value.steps[0]]}).success,false);
  assert.equal(WorkflowFile.safeParse({...workflow,steps:[{id:'author',name:''}]}).success,false);
  assert.equal(WorkflowFile.safeParse({...workflow,steps:[{id:'Invalid Identity',name:'合成编写'}]}).success,false);
  assert.equal(WorkflowFile.safeParse({...workflow,steps:[{id:'author',name:'合成编写',phase:'complete'}]}).success,false);
});

test('display names do not collapse distinct step ids or define an execution graph', () => {
  const steps = [{id:'author',name:'合成步骤'},{id:'verify',name:'合成步骤'}];
  assert.deepEqual(WorkflowFile.parse({...workflow,steps}).steps,steps);
  assert.deepEqual(WorkflowFile.parse({...workflow,steps:[]}).steps,[]);
});

test('requirement step is an explicit Key reference whose cross-file existence belongs to runs', () => {
  const value = {...requirement,step:'author'};
  assert.equal(RequirementTemplate.parse(value).step,'author');
  assert.equal(RequirementTemplate.safeParse({...value,step:''}).success,false);
  assert.equal(RequirementTemplate.safeParse({...value,step:'Author'}).success,false);
  assert.equal(RequirementsFile.parse({schema:'requirements@1',requirements:[value]}).requirements[0].step,'author','standalone file cannot claim cross-file resolution');
});

test('submit output admits only an optional nonempty source-selected name without classifying the step', () => {
  assert.equal(SubmitResultOutput.parse({...output,step_name:'合成核对'}).step_name,'合成核对');
  assert.equal(SubmitResultOutput.safeParse({...output,step_name:''}).success,false);
  assert.equal(SubmitResultOutput.safeParse({...output,step_name:1}).success,false);
});

test('model and public generated schemas register the optional declarations without a new vocabulary axis', () => {
  const model = JSON.parse(readFileSync(new URL('../model.json',import.meta.url),'utf8'));
  assert.ok(model.version >= 89);
  assert.ok(model.elements.find((row:{id:string})=>row.id==='W03').changes89);
  assert.equal(model.vocabulary.some((row:{axis:string})=>row.axis==='workflow_step'),false);
  const schema = (name:string)=>JSON.parse(readFileSync(new URL(`../generated/schemas/${name}.v1.schema.json`,import.meta.url),'utf8'));
  assert.equal(schema('workflow').properties.steps.items.properties.name.minLength,1);
  assert.equal(schema('workflow').required.includes('steps'),false);
  assert.equal(schema('requirements').properties.requirements.items.required.includes('step'),false);
  const tools = JSON.parse(readFileSync(new URL('../generated/tools.json',import.meta.url),'utf8'));
  const outputSchema = tools.find((row:{name:string})=>row.name==='submit_result').outputSchema;
  assert.equal(outputSchema.properties.step_name.minLength,1);
  assert.equal(outputSchema.required.includes('step_name'),false);
});

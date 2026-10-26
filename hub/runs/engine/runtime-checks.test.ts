import assert from 'node:assert/strict';
import {test} from 'node:test';
import {runtimeCheckProblems} from './submit.ts';
import type {LoadedWorkflow} from '../../ports.ts';
import type {Submission} from '../../../contracts/src/submission.ts';
const table={schema:'range@1',origin:'synthetic',checks:[{values:'$.fields.value',range:{minimum:1,maximum:3}}]};
const workflow={requirements:[{key:'r',run_table:true}],ledger:{schema:'ledger@1',shapes:[{requirement:'r',interpreter:'range@1',ruled_in:'10.6.0'}]}} as LoadedWorkflow;
const input={run:'run_01k00000000000000000000000',model:'synthetic',items:[],checks:[{requirement:'r',interpreter:'range@1',table,samples:[{item:'positive',expect:[{verdict:'support'}]},{item:'negative',expect:[{verdict:'refute'}]}]}]} as Submission;
const items=[{id:'positive'},{id:'negative'}];
test('runtime checks refuse disabled requirements, invalid ruled tables and nonexistent sample items at their pointers',()=>{
 assert.deepEqual(runtimeCheckProblems(workflow,items,input),[]);
 const denied=structuredClone(workflow);denied.requirements[0].run_table=false;
 assert.equal(runtimeCheckProblems(denied,items,input)[0].path,'/checks/0/requirement');
 const invalid=structuredClone(input);invalid.checks![0].table={};
 assert.equal(runtimeCheckProblems(workflow,items,invalid)[0].path,'/checks/0/table');
 assert.equal(runtimeCheckProblems(workflow,[],input)[0].path,'/checks/0/samples/0/item');
 const unruled=structuredClone(input);unruled.checks![0].interpreter='future@1';unruled.checks![0].table={};
 assert.deepEqual(runtimeCheckProblems(workflow,items,unruled),[]);
});

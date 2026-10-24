import assert from 'node:assert/strict';
import {test} from 'node:test';
import {requirementSummary} from './start.ts';
import {RequirementSummary} from '../../../contracts/src/run.ts';
import type {RequirementTemplate, LedgerFile, CheckEntry} from '../../../contracts/src/pack.ts';
const requirement:RequirementTemplate={key:'r',name:'合成要求',description:'合成',target:'item',required:true,done_rule:'bookkeeping',layers:['static'],accepted_producer:'fact',checks:['c'],error_handling:[],run_table:true};
const ledger:LedgerFile={schema:'ledger@1',shapes:[{requirement:'r',interpreter:'range@1',ruled_in:'10.6.0'}]};
const checks:CheckEntry[]=[{id:'c',interpreter:'structure@1',applies:'item',judges:'subject'}];
test('requirement summaries expose the locked rules and permitted runtime interpreters as required arrays',()=>{
 const summary=requirementSummary(requirement,ledger,checks,'synthetic@10.6.0');
 assert.deepEqual(summary.rules,['structure@1']);
 assert.deepEqual(summary.run_interpreters,['range@1']);
 assert.ok(RequirementSummary.safeParse(summary).success);
 const {rules, ...missing}=summary;
 assert.equal(RequirementSummary.safeParse(missing).success,false);
 assert.deepEqual(requirementSummary({...requirement,run_table:false},ledger,[]).run_interpreters,[]);
});

import {parseDeclarations} from '../packs/load.ts';
import {packSummary} from '../packs/ports.ts';
import {workflowPack,withFiles,editJson,bytesOf} from '../packs/testing/builder.ts';
import type {PackVersionInfo} from '../packs/types.ts';
test('list_task_packs and start_run derive identical ruling fields from loaded ledger bytes',()=>{
 const pack=withFiles(editJson<any>(workflowPack(),'requirements.json',f=>{f.requirements[0].run_table=true;}),{'ledger.json':{schema:'ledger@1',shapes:[{requirement:'titles',interpreter:'range@1',ruled_in:'10.6.0'}]}});
 const declarations=parseDeclarations('workflow',new Map(Object.entries(pack.files).map(([path,content])=>[path,bytesOf(content)])));
 assert.equal(declarations.kind,'workflow');if(declarations.kind!=='workflow')return;
 const info={id:'synthetic',version:'10.6.0',kind:'workflow',title:'合成',description:'合成'} as PackVersionInfo;
 const listed=packSummary(info,declarations,[]);
 const started=declarations.requirements.requirements.map(t=>requirementSummary(t,declarations.ledger,declarations.checks.checks,'synthetic@10.6.0'));
 assert.deepEqual(listed.requirements,started);
 assert.deepEqual(listed.requirements[0].run_interpreters,['range@1']);
});

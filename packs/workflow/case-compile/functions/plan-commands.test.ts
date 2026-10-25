import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {checkCommandsKnown,checkContractShape,checkAddresses,checkExpectedSources} from './checks.ts';
import {planSubject} from './subject.ts';
import {goodData,COMMAND_CATALOG,COMMAND_IDENTITIES,CONTRACT_DOC,PROFILE_DOC,MANIFEST_DOC,QUOTE,AUTOID} from './test-support.ts';
import {parseRuntimeContract} from './runtime-contract.ts';
import {parseManifest} from './manifest.ts';
import {parseProfile} from './profile.ts';
import {generateWorkbook,GENERATOR} from './generate.ts';
import checkWorkbook from './workbook.ts';
import {coreModel} from '../testing/workbook-model.ts';
const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const natural='开启合成服务，同时添加合成监听';
function input(){const data=goodData();delete data.command_identities;const fields={autoid:AUTOID,title:natural,priority:'2',steps:[{text:natural}],expected:[QUOTE.text]};const raw={item:{id:'doc-1:c-1',location:QUOTE.reference,fields},slots:{plan:[{data}]},catalog:COMMAND_CATALOG.entries,catalog_complete:true,context:{command_policy:COMMAND_CATALOG.policy,root:COMMAND_CATALOG.root,groups:[{kind:'case-compile',contract:CONTRACT_DOC,profile:PROFILE_DOC,manifest:MANIFEST_DOC}]}};return {raw,data,fields,subject:planSubject(raw)};}
test('natural-language case without authored or model command identities resolves the complete plan against the locked catalog',()=>{
 const value=input();assert.equal(value.subject.command_identities,undefined);const outcome=checkCommandsKnown({subject:value.subject});assert.equal(outcome[0].verdict,'support',JSON.stringify(outcome));assert.deepEqual((outcome[0].data as any).command_identities,[COMMAND_IDENTITIES[0]]);for(const check of [checkContractShape,checkAddresses,checkExpectedSources]){const results=check({subject:value.subject});assert.ok(results.every(row=>row.verdict==='support'),JSON.stringify(results));}
});
test('unknown, abbreviated, prefix-only, prose, and wrong-typed plan commands cannot be known merely because the case is unconstrained',()=>{
 for(const line of ['widget unknown 60','wid health interval 60','widget health','执行 widget health interval 60','widget health interval hostname.invalid']){const value=input();value.data.steps[0].args=[line];const outcomes=checkCommandsKnown({subject:planSubject(value.raw)});assert.ok(outcomes.some(row=>row.verdict==='refute'),line+' '+JSON.stringify(outcomes));}
});
test('an existing case identity remains an exact consistency requirement, and model identities cannot replace native parsing',()=>{
 const value=input();(value.raw.item.fields as any).command_identities=[{...COMMAND_IDENTITIES[1],path:'/commands/widget/other'}];assert.ok(checkCommandsKnown({subject:planSubject(value.raw)}).some(row=>row.verdict==='refute'&&row.statement.includes('用例明确声明')));
 const changed=input();changed.data.command_identities=[COMMAND_IDENTITIES[1]];assert.ok(checkCommandsKnown({subject:planSubject(changed.raw)}).some(row=>row.verdict==='refute'));
 const missing=input();delete (missing.raw as any).catalog;assert.ok(checkCommandsKnown({subject:planSubject(missing.raw)}).some(row=>row.verdict==='unknown'));
});
test('the satisfied plan grammar drives client generation and independent workbook verification without author command declarations',()=>{
 const value=input(),outcome=checkCommandsKnown({subject:value.subject})[0];assert.equal(outcome.verdict,'support');const catalog=(outcome.data as any).command_catalog;const contract=parseRuntimeContract(CONTRACT_DOC),inventory=parseManifest(MANIFEST_DOC);assert.ok(contract.ok&&inventory.ok);if(!contract.ok||!inventory.ok)return;const profile=parseProfile(PROFILE_DOC,contract.contract,inventory.beds);assert.ok(profile.ok);if(!profile.ok)return;
 const fields={...value.fields,command_catalog:catalog},generation={plan_run:'run_'+'0'.repeat(26),build:'Synthetic_zx-u_10_8_1',generator:GENERATOR};const bytes=generateWorkbook({slots:value.data,fields,contract:contract.contract,profile:profile.profile,...generation});const result=checkWorkbook({subject:{...value.subject,data:value.data,fields,generation,manifest_sha256:hash(JSON.stringify(MANIFEST_DOC)),workbook:{sha256:hash(bytes),model:coreModel(bytes)}}});assert.ok(result.every(row=>row.verdict==='support'),JSON.stringify(result));
});
test('a plan without device CLI still carries an empty locked grammar receipt for generation',()=>{
 const value=input();value.data.steps=value.data.steps.slice(1);value.data.expects[0].after=1;
 const outcome=checkCommandsKnown({subject:planSubject(value.raw)})[0];assert.equal(outcome.verdict,'support',JSON.stringify(outcome));
 assert.deepEqual((outcome.data as any).command_catalog,{root:COMMAND_CATALOG.root,complete:true,entries:[],covered_lines:[],policy:COMMAND_CATALOG.policy,authority_entries:COMMAND_CATALOG.entries});
});
test('native catalog selection budget failures stay unknown with a split-plan recovery',()=>{
 const value=input();(value.raw as any).catalog_missing='目录选择超出 128 条命令；拆分计划后重核';
 const outcomes=checkCommandsKnown({subject:planSubject(value.raw)});
 assert.ok(outcomes.some(row=>row.verdict==='unknown'&&row.missing?.includes('拆分计划')),JSON.stringify(outcomes));
 assert.ok(!outcomes.some(row=>row.verdict==='refute'));
});
test('optional model identity declarations are checked only by commands_known, not the contract, address or expectation prerequisites',()=>{
 for(const declaration of [null,'synthetic invalid declaration',[{raw:'synthetic malformed declaration'}],[],[COMMAND_IDENTITIES[1]],[...COMMAND_IDENTITIES]]){
  const value=input();value.data.command_identities=declaration;
  const subject=planSubject(value.raw);
  for(const check of [checkContractShape,checkAddresses,checkExpectedSources])assert.ok(check({subject}).every(row=>row.verdict==='support'),JSON.stringify(check({subject})));
  const result=checkCommandsKnown({subject});assert.ok(result.some(row=>row.verdict==='refute'&&row.pointer==='/data/command_identities'&&row.statement.includes('可选')),JSON.stringify(result));
 }
 const valid=input();valid.data.command_identities=[COMMAND_IDENTITIES[0]];assert.ok(checkCommandsKnown({subject:planSubject(valid.raw)}).every(row=>row.verdict==='support'));
});
test('a model declaration on a host-only plan is compared with the empty derived identity set',()=>{
 const value=input();value.data.steps=value.data.steps.slice(1);value.data.command_identities=[COMMAND_IDENTITIES[0]];value.data.expects[0].after=1;
 const result=checkCommandsKnown({subject:planSubject(value.raw)});assert.ok(result.some(row=>row.verdict==='refute'&&row.pointer==='/data/command_identities'));
});

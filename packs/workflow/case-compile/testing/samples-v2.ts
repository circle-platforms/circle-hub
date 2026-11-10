import {catalogFor} from './command-catalog.ts';
import {addressInput,signTypedRuntime} from './typed-fixtures.ts';
import {fidelityBrief} from '../functions/fidelity.ts';
// Synthetic runtime-contract@2 author samples; legacy samples remain byte-for-byte under testing/legacy-samples.
import {readFileSync,writeFileSync,readdirSync,mkdirSync,renameSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {goodData,MANIFEST_DOC,QUOTE,AUTOID} from '../functions/test-support.ts';
import {parseRuntimeContract} from '../functions/runtime-contract.ts';
import {parseManifest} from '../functions/manifest.ts';
import {parseProfile} from '../functions/profile.ts';
import {generateWorkbook,GENERATOR} from '../functions/generate.ts';
import {coreModel} from './workbook-model.ts';
import {templateDocument} from './template.ts';
const root=fileURLToPath(new URL('../',import.meta.url));
const read=(name:string)=>JSON.parse(readFileSync(join(root,'examples',name),'utf8'));
const contract=read('runtime-contract-v2.json'),profile=read('runtime-profile-v2.json'),identities=read('command-identities-v2.json').command_identities;
profile.workbook.template=templateDocument(profile.workbook,contract.runtime.minimum_version,contract.original?.contract_sha256??contract.contract_sha256);
const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
function subject(){const data=goodData();return {command_catalog:catalogFor(identities),item:'doc-1:c-1',location:QUOTE.reference,case_texts:[QUOTE.text,'widget health interval 60'],data,contract:structuredClone(contract),profile:structuredClone(profile),manifest:structuredClone(MANIFEST_DOC),command_identities:structuredClone(identities),leases:[],criteria:[],now:'2026-10-23T02:00:00.000Z'};}
for(const polarity of ['positive','negative'])for(const name of readdirSync(join(root,'samples',polarity))){const old=join(root,'samples',polarity,name),archive=join(root,'testing','legacy-samples',polarity);mkdirSync(archive,{recursive:true});if(name.startsWith('typed-')||name==='quote.json')unlinkSync(old);else if(name.endsWith('.json'))renameSync(old,join(archive,name));}
const save=(polarity:string,name:string,check:string,value:unknown,code?:string,extras={})=>writeFileSync(join(root,'samples',polarity,name+'.json'),JSON.stringify({id:name.replaceAll('-','_')+'_'+polarity,source:'author',check,note:'合成 runtime-contract@2 声明，旧合约不能作为已核对输入',subject:value,...extras,expect:[{verdict:code?'refute':'support',...(code?{code}:{}),item:'doc-1:c-1',tier:'blocking'}]},null,2)+'\n');
for(const check of ['contract_shape','bed_addresses','commands_catalog','expected_sources']){
 save('positive','typed-'+check,check,subject());const bad=subject();let code='case-compile.method_forbidden';
 if(check==='bed_addresses'){bad.data.bucket='absent-bed';code='case-compile.bed_unknown';}
 else if(check==='expected_sources'){bad.data.expects[0].text='合成改写文字';code='case-compile.expect_not_in_quote';}
 else bad.data.steps[0].method='undeclared-method';
 save('negative','typed-'+check,check,bad,code);
}
const modeled={...subject(),expected_nodes:[{reference:QUOTE.reference,text:QUOTE.text}]};modeled.data.expects[0]={text:'service enabled',quote:{...QUOTE},after:1,basis:'model_judgment',rationale:'模型选择合成设备可观察的状态文字；Hub 只机械核验，不判断选择是否正确'};
save('positive','typed-model-expected','expected_sources',modeled);const ungrounded=structuredClone(modeled);ungrounded.data.expects[0].quote.reference=QUOTE.reference+'/other_case';save('negative','typed-model-expected','expected_sources',ungrounded,'case-compile.expect_not_in_quote');
save('positive','typed-address-member','bed_addresses',addressInput('192.0.2.10').subject);
save('negative','typed-address-member','bed_addresses',addressInput('192.0.2.250').subject,'case-compile.address_off_bed');
// Access level: the level the locked tree declares on the signature against the refusal the contract declares for the step's
// method (functions/plan-commands.ts accessRefusal). Another level under the same declaration is not refused.
const levelled=(level:string)=>{const value:any=subject();for(const entry of value.command_catalog.entries)for(const signature of entry.signatures)signature.access={name:level,declaration:String(signature.reference).replace(/\/arguments$/,''),grammar:'famx-command-tree@2'};value.contract.refused_access={source:'synthetic-framework/lib/seat.py',sha256:'b'.repeat(64),rows:[{object:value.data.steps[0].object,method:value.data.steps[0].method,access:['DEMO_LEVEL_CONFIG']}]};value.contract=signTypedRuntime(value.contract);return value;};
save('positive','typed-access-level','commands_catalog',levelled('DEMO_LEVEL_USER'));
save('negative','typed-access-level','commands_catalog',levelled('DEMO_LEVEL_CONFIG'),'case-compile.method_forbidden');
// Scenario fidelity: the audit verdict answers this plan's brief and keeps the authored action (functions/fidelity.ts).
const record={schema:'recompose-record@1',contract:{intent:{text:'合成意图：配置组件健康检查间隔'}},atoms:[{id:'a1',kind:'intent',text:'合成意图：配置组件健康检查间隔'},{id:'a2',kind:'action',text:'配置组件健康检查间隔 60'},{id:'a3',kind:'expectation',text:QUOTE.text}],ledgers:{original:[{atom:'a2',text:'配置组件健康检查间隔 60'}],adapted:[],concretizations:[],rebindings:[]}};
const kept:any=subject();kept.recomposition={record};const brief=fidelityBrief('doc-1:c-1',record,kept.data)!;
kept.data.fidelity={brief_sha256:brief.brief_sha256,steps:[{n:'a2',verdict:'preserved',step_indices:[1],rationale:'合成理由：第 1 步配置了作者写的间隔'}],disclosure:'合成说明：作者的一步由计划第 1 步实现。'};
save('positive','typed-scenario_fidelity','scenario_fidelity',kept);
const changed=structuredClone(kept);changed.data.fidelity.steps[0].verdict='changed';save('negative','typed-scenario_fidelity','scenario_fidelity',changed,'case-compile.scenario_changed');
const budget=subject();save('positive','typed-effect-budget','contract_shape',budget);budget.contract.effects.effect_0.budget=0;budget.contract=signTypedRuntime(budget.contract);save('negative','typed-effect-budget','contract_shape',budget,'case-compile.method_forbidden');
for(const polarity of ['positive','negative'])save(polarity,'quote','expected_quotes',{item:'doc-1:c-1',quotes:[{reference:QUOTE.reference,text:polarity==='positive'?QUOTE.text:'合成捏造引文'}]},polarity==='negative'?'QUOTE_MISMATCH':undefined,{sources:{[QUOTE.reference]:QUOTE.text}});
const base=subject(),c=parseRuntimeContract(contract),m=parseManifest(MANIFEST_DOC);if(!c.ok||!m.ok)throw Error('invalid typed examples');const p=parseProfile(profile,c.contract,m.beds);if(!p.ok)throw Error('invalid typed profile');
const fields={command_catalog:{...catalogFor(identities),covered_lines:['widget health interval 60']},autoid:AUTOID,title:'合成用例',path:['合成文档','合成分组','合成用例'],priority:'2',steps:[{text:'原始配置步骤'}],command_identities:identities};
const generation={plan_run:'run_00000000000000000000000000',build:'Fixture_Build_A',generator:GENERATOR};
const bytes=generateWorkbook({slots:base.data,fields,contract:c.contract,profile:p.profile,...generation});
const workbook={...base,fields,generation,manifest_sha256:hash(JSON.stringify(MANIFEST_DOC)),workbook:{model:coreModel(bytes),sha256:hash(bytes)}};
for(const check of ['workbook_verified','dispatch_policy']){save('positive','typed-'+check,check,workbook);const bad=structuredClone(workbook);bad.workbook.sha256='f'.repeat(64);save('negative','typed-'+check,check,bad,'case-compile.workbook_invalid');}

await import('./authority-samples.ts');

await import('./block-samples.ts');

import assert from 'node:assert/strict';
import {test} from 'node:test';
import {cellFixture,cellPlan,fixture,positiveBlocks} from '../testing/blocks.ts';
import {readSlots} from './slots.ts';
import {generateWorkbook} from './generate.ts';
import {readWorkbook} from './workbook.ts';
import {coreModel} from '../testing/workbook-model.ts';
import {blockMeta} from './blocks.ts';
import {typedAuthorityGaps} from './typed-authority.ts';
import {planCommands} from './plan-commands.ts';
import {bindArguments} from './binding.ts';
import {runtimeMethod} from './runtime-contract.ts';
import {signTypedRuntime} from '../testing/typed-fixtures.ts';
import {checkContractShape,checkAddresses} from './checks.ts';
import {entry,profileDocument} from '../testing/runtime.ts';
import {createHash} from 'node:crypto';
import {encodeG,decodeG} from './generated/skills/runner-workbook/workbook-writer/g-syntax.ts';

function recipe(){const f=cellFixture();return {...f,slots:cellPlan(),plan_run:'run_00000000000000000000000000',build:'SYN-BUILD-A'};}
test('selection lowers readable multiple-equality arguments and roundtrips G H and I',()=>{
 const input=recipe(),parsed=readSlots(input.slots);assert.ok(parsed.ok,JSON.stringify(parsed));if(!parsed.ok)return;
 assert.deepEqual(typedAuthorityGaps(input.contract,input.profile,parsed.slots,undefined,input.catalog,[],input.manifest_sha256),[]);
 assert.ok(checkAddresses(input.subject(input.slots)).every(outcome=>outcome.verdict==='support'));
 const selected=parsed.slots.steps[1];assert.deepEqual(selected.args,['{}','where 1=node-a','where 2=ready']);assert.deepEqual(selected.keywords,{separator:'|',columns:3,column:3,format:'delimited',header:0,row:0});
 assert.equal(selected.input_register,'source_text');assert.equal(selected.save_as,'selected');assert.equal(selected.output,undefined);assert.equal(blockMeta(parsed.slots)!.registers.get('selected')!.cell,true);
 const read=readWorkbook(coreModel(generateWorkbook(input)),input);assert.ok(read.ok,JSON.stringify(read));if(!read.ok)return;
 const row=read.executions.find(value=>value.method==='table_cell')!;assert.deepEqual(row.args,selected.args);assert.equal(row.h,'selected');assert.equal(row.i,'source_text');
 const configured=read.executions.find(value=>value.args[0]==='demo set {}')!;assert.equal(configured.i,'selected');assert.equal(configured.h,'');
});
test('row selection and header handling use explicit scalar parameters',()=>{
 const input=recipe(),block=input.slots.blocks[1];block.table={format:'delimited',separator:'|',columns:3,header:true};block.column=2;block.select={row:2};
 const parsed=readSlots(input.slots);assert.ok(parsed.ok);if(!parsed.ok)return;
 assert.deepEqual(parsed.slots.steps[1].args,['{}']);assert.deepEqual(parsed.slots.steps[1].keywords,{separator:'|',columns:3,column:2,format:'delimited',header:1,row:2});
 const read=readWorkbook(coreModel(generateWorkbook(input)),input);assert.ok(read.ok,JSON.stringify(read));
});
test('condition constants retain leading zeros and commas through the existing G quoting',()=>{
 const input=recipe();input.slots.blocks[1].select={where:[{column:1,value:'00123'},{column:2,value:'a,b'}]};
 const read=readWorkbook(coreModel(generateWorkbook(input)),input);assert.ok(read.ok,JSON.stringify(read));if(read.ok)assert.deepEqual(read.executions.find(row=>row.method==='table_cell')!.args,['{}','where 1=00123','where 2=a,b']);
});
test('selection references only earlier raw captures and ordinary templates only earlier cells',()=>{
 for(const mutate of [(data:ReturnType<typeof cellPlan>)=>{data.blocks[1].from='absent';},(data:ReturnType<typeof cellPlan>)=>{data.blocks[1].from='selected';},(data:ReturnType<typeof cellPlan>)=>{data.blocks[2].input_register='source_text';},(data:ReturnType<typeof cellPlan>)=>{[data.blocks[0],data.blocks[1]]=[data.blocks[1],data.blocks[0]];}]){
  const data=cellPlan();mutate(data);assert.equal(readSlots(data).ok,false);
 }
 const duplicate=cellPlan();duplicate.blocks[1].register='source_text';assert.equal(readSlots(duplicate).ok,false);
});
test('selection alternatives and declared columns are structural requirements',()=>{
 for(const mutate of [(block:Record<string,any>)=>{block.select={row:1,where:[{column:1,value:'x'}]};},(block:Record<string,any>)=>{block.select={where:[]};},(block:Record<string,any>)=>{block.column=7;},(block:Record<string,any>)=>{block.select={where:[{column:7,value:'x'}]};},(block:Record<string,any>)=>{block.table.format='key_value';},(block:Record<string,any>)=>{block.call.args=['invented'];},(block:Record<string,any>)=>{block.table.start_line=2;}]){
  const data=cellPlan();mutate(data.blocks[1]);assert.equal(readSlots(data).ok,false);
 }
 const invalid=recipe();invalid.slots.blocks[1].select.where[0].value='bad\nvalue';const broken=readSlots(invalid.slots);assert.ok(broken.ok);if(broken.ok)assert.ok(typedAuthorityGaps(invalid.contract,invalid.profile,broken.slots,undefined,invalid.catalog).some(gap=>gap.pointer==='/blocks/1/select/where/0/value'));
 const data=cellPlan();data.blocks[1].table={format:'key_value',separator:':',columns:2,header:false};data.blocks[1].column=2;data.blocks[1].select={where:[{column:1,value:'Name'}]};assert.ok(readSlots(data).ok);
});
test('template input is explicit and cannot spill into another parameter or restore semantics',()=>{
 for(const change of [(data:ReturnType<typeof cellPlan>)=>{data.blocks[2].call.args=['demo set {} {}'];},(data:ReturnType<typeof cellPlan>)=>{data.blocks[2].call.args=['demo set {selected}'];},(data:ReturnType<typeof cellPlan>)=>{data.blocks[2].call.args=['demo set 1','{}'];},(data:ReturnType<typeof cellPlan>)=>{data.blocks[2].call.keywords={extra:'{}'};}]){const data=cellPlan();change(data);assert.equal(readSlots(data).ok,false);}
 const input=recipe(),parsed=readSlots(input.slots);assert.ok(parsed.ok);if(!parsed.ok)return;
 const step=parsed.slots.steps[2];assert.equal(step.restore_for,undefined);assert.deepEqual(bindArguments(runtimeMethod(input.contract,step.object,step.method)!,step,'/steps/2').problems,[]);
 const unbound={...step,cell_input:undefined};assert.ok(bindArguments(runtimeMethod(input.contract,step.object,step.method)!,unbound,'/steps/2').problems.length);
});
test('command templates preserve dynamic references without inventing concrete identities',()=>{
 const input=recipe(),parsed=readSlots(input.slots);assert.ok(parsed.ok);if(!parsed.ok)return;
 const resolved=planCommands(input.contract,input.profile,parsed.slots,input.catalog);assert.deepEqual(resolved.problems,[]);assert.equal(resolved.templates.length,1);
 const template=resolved.templates[0];assert.equal(template.path,'/commands/demo/set');assert.equal(template.parameters[0].parsed.kind,'runtime_cell');assert.equal('value'in template.parameters[0].parsed,false);assert.ok(!resolved.identities.some(identity=>identity.path===template.path));
 const staticSlot=structuredClone(input.slots);delete staticSlot.blocks[2].input_register;const missing=readSlots(staticSlot);assert.ok(missing.ok);if(missing.ok)assert.ok(typedAuthorityGaps(input.contract,input.profile,missing.slots,undefined,input.catalog).some(gap=>gap.verdict==='refute'));
});
test('template methods still require frozen cell capabilities and exact method registration',()=>{
 const input=recipe();for(const field of ['cell_inputs','cell_methods']){const doc=structuredClone(input.contractDoc) as any;delete doc.runtime.block_model[field];const contract=signTypedRuntime(doc);const subject=input.subject(input.slots,{contract,profile:{...input.profileDoc,runtime:{...input.profileDoc.runtime }}});assert.ok(checkContractShape(subject).some(outcome=>outcome.verdict==='unknown'));}
});
test('independent workbook reading rejects changed source result type scope and template',()=>{
 const input=recipe(),bytes=generateWorkbook(input);
 for(const corruption of ['source','result','template','condition','method']){
  const model=coreModel(bytes) as any,rows=model.sheets[0].rows,cell=(row:any,column:string)=>row.cells.find((value:any)=>value.reference.startsWith(column));
  const selection=rows.find((row:any)=>cell(row,'F')?.text==='table_cell'),configuration=rows.find((row:any)=>cell(row,'G')?.text==='demo set {}');
  if(corruption==='source')cell(selection,'I').text='selected';
  if(corruption==='result')cell(selection,'H').text='source_text';
  if(corruption==='template')cell(configuration,'I').text='source_text';
  if(corruption==='condition')cell(selection,'G').text=cell(selection,'G').text.replace('ready','different');
  if(corruption==='method')cell(selection,'F').text='command';
  assert.equal(readWorkbook(model,input).ok,false,corruption);
 }
});
test('static restoration retains its separate raw-output requirement',()=>{
 const f=fixture(),slots=readSlots(positiveBlocks().RESTORE_FROM);assert.ok(slots.ok);if(!slots.ok)return;const input={slots:slots.slots,contract:f.contract,profile:f.profile,fields:f.fields,plan_run:'run_00000000000000000000000000',build:'SYN-BUILD-A'};
 const read=readWorkbook(coreModel(generateWorkbook(input)),input);assert.ok(read.ok,JSON.stringify(read));
});

test('cleanup carries the same selected-cell reference rather than comparing placeholder text',()=>{
 const input=recipe(),catalog=input.catalog as any;
 catalog.entries[2].signatures[0].params=[structuredClone(catalog.entries[1].signatures[0].params[0])];for(const rule of catalog.policy.inverse_rules)rule.leading_parameters=1;
 input.slots.blocks.at(-1)!.call.args=['no demo set {}'];input.slots.blocks.at(-1)!.input_register='selected';
 const parsed=readSlots(input.slots);assert.ok(parsed.ok);if(!parsed.ok)return;
 assert.deepEqual(typedAuthorityGaps(input.contract,input.profile,parsed.slots,undefined,catalog,[],input.manifest_sha256),[]);
 const another=structuredClone(input.slots.blocks[1]);another.id='cell_other';another.register='selected_other';input.slots.blocks.splice(2,0,another);input.slots.blocks.at(-1)!.input_register='selected_other';
 const wrong=readSlots(input.slots);assert.ok(wrong.ok);if(wrong.ok)assert.ok(typedAuthorityGaps(input.contract,input.profile,wrong.slots,undefined,catalog,[],input.manifest_sha256).some(gap=>gap.verdict==='refute'));
});
test('the same template text retains each distinct input reference',()=>{
 const input=recipe(),another=structuredClone(input.slots.blocks[1]);another.id='cell_other';another.register='selected_other';input.slots.blocks.splice(2,0,another);
 const configured=structuredClone(input.slots.blocks[3]);configured.id='configure_other';configured.input_register='selected_other';input.slots.blocks.splice(4,0,configured);
 const parsed=readSlots(input.slots);assert.ok(parsed.ok);if(!parsed.ok)return;const resolved=planCommands(input.contract,input.profile,parsed.slots,input.catalog);assert.deepEqual(resolved.problems,[]);
 assert.deepEqual(new Set(resolved.templates.map(template=>'input_register'in template?template.input_register:null)),new Set(['selected','selected_other']));
});
test('runtime parameters cannot replace command words or consume extra literal arguments',()=>{
 for(const line of ['demo {} 5','demo set {} extra']){const input=recipe();input.slots.blocks[2].call.args=[line];const parsed=readSlots(input.slots);assert.ok(parsed.ok);if(parsed.ok)assert.ok(planCommands(input.contract,input.profile,parsed.slots,input.catalog).problems.some(problem=>problem.verdict==='refute'));}
});
test('a declared host program accepts the bound position while its other syntax rules remain',()=>{
 const input=recipe(),document=structuredClone(input.contractDoc) as any;document.effects.host.allowed_literals=[];document.effects.host.allowed_programs=[{program:'echo'}];const contract=signTypedRuntime(document),profile={...input.profileDoc,runtime:{...input.profileDoc.runtime }};
 input.slots.blocks[2]={kind:'STEP',id:'configure',input_register:'selected',call:{object:'client',method:'shell',args:['echo {}'],keywords:{}}};input.slots.blocks.pop();
 const subject=(data:unknown)=>input.subject(data,{contract,profile});assert.ok(checkContractShape(subject(input.slots)).every(outcome=>outcome.verdict==='support'));
 for(const line of ['another {}','echo {}; other']){const data=structuredClone(input.slots);data.blocks[2].call.args=[line];assert.ok(checkContractShape(subject(data)).some(outcome=>outcome.verdict==='refute'));}
});

function addressScenario(mode:'direct'|'command'|'host',member=true){
 const input=recipe(),document=structuredClone(input.contractDoc) as any,source='src:'+input.catalog.root+'/json@1/p';
 document.types.member_address={declaration:{name:'synthetic-member-address',catalog_type:'ipv4',declaration:source+'/types/member_address',grammar:'synthetic-types@1'},address_kind:'ipv4'};
 document.roles.member_address={source:source+'/roles/member_address',bed_member:member};
 document.effects.address_use={source:source+'/effects/address_use',roles:['member_address'],budget:256,allowed_literals:[],command_roles:[]};
 document.entries.push({...entry('device0','accept_address',[{name:'address',kind:'positional_only',required:true,default:null}]),typed_authority:{source:source+'/methods/accept_address',parameters:{address:{type:'member_address',role:'member_address'}},effects:['address_use']}});
 const signature='src:'+input.catalog.root+'/xml@1/x/commands/demo/target/arguments';
 input.catalog.entries.push({words:['demo','target'],reference:'tree:'+input.catalog.root+'/commands/demo/target',signatures:[{id:'/commands/demo/target',reference:signature,params:[{name:'address',type:'ipv4',native_type:{name:'synthetic-member-address',declaration:source+'/types/member_address',grammar:'synthetic-tree@1'}}]}]} as any);
 input.catalog.policy.read_only.push('/commands/demo/target');document.effects.command.roles.push('member_address');document.effects.command.command_roles.push({signature,position:0,role:'member_address'});
 if(mode==='host'){document.effects.host.allowed_literals=[];document.effects.host.allowed_programs=[{program:'probe',address_prefix:'--target='}];}
 const contract=signTypedRuntime(document),profile=structuredClone(input.profileDoc);profile.workbook.template=(profileDocument(contract) as any).workbook.template;profile.allowed.push({object:'device0',method:'accept_address',reviewed:true,parameters:{address:'member_address'}});
 input.slots.blocks[2]={kind:'STEP',id:'configure',input_register:'selected',call:mode==='host'?{object:'client',method:'shell',args:['probe --target={}'],keywords:{}}:{object:'device0',method:mode==='direct'?'accept_address':'command',args:[mode==='direct'?'{}':'demo target {}'],keywords:{}}};input.slots.blocks.pop();
 const subject=(data=input.slots,extra={})=>input.subject(data,{contract,profile,...extra});return {...input,subject,contract,profile};
}
for(const mode of ['direct','command','host'] as const)test('a declared member-address cell remains unknown for '+mode,()=>{
 const input=addressScenario(mode),out=checkAddresses(input.subject());assert.ok(out.some(row=>row.verdict==='unknown'),JSON.stringify(out));assert.ok(!out.some(row=>row.verdict==='support'));
});
test('static member addresses and authored off-environment addresses retain their existing results',()=>{
 const input=addressScenario('command'),inventory=structuredClone(input.inventory);for(const bed of inventory.beds)for(const device of bed.devices)device.ipv4=device.ipv4.map(value=>value.split('/')[0]+'/32');
 const data=structuredClone(input.slots);delete data.blocks[2].input_register;data.blocks[2].call.args=['demo target 192.0.2.99'];const manifest_sha256=createHash('sha256').update(JSON.stringify(inventory)).digest('hex');
 const out=checkAddresses(input.subject(data,{manifest:inventory,manifest_sha256}));assert.ok(out.some(row=>row.code==='case-compile.address_off_bed'),JSON.stringify(out));
 const authored=checkAddresses(input.subject(data,{manifest:inventory,manifest_sha256,case_texts:['demo target 192.0.2.99']}));assert.ok(authored.every(row=>row.verdict==='support'),JSON.stringify(authored));assert.deepEqual(authored[0].data?.author_kept,['192.0.2.99']);
 const mixed=addressScenario('host'),mixedData=structuredClone(mixed.slots);mixedData.blocks[2].call.args=['probe --target=192.0.2.99 --target={}'];const combined=checkAddresses(mixed.subject(mixedData,{manifest:inventory,manifest_sha256}));assert.ok(combined.some(row=>row.verdict==='unknown'));assert.ok(combined.some(row=>row.code==='case-compile.address_off_bed'));
});
test('a cell whose declared address use is outside the environment is not given a new member check',()=>{
 const input=addressScenario('direct',false),out=checkAddresses(input.subject());assert.ok(out.every(row=>row.verdict==='support'),JSON.stringify(out));
 const text=addressScenario('direct'),document=structuredClone(text.contract) as any;delete document.types.member_address.address_kind;document.types.member_address.declaration.catalog_type='string';const contract=signTypedRuntime(document),profile={...text.profile,runtime:{...text.profile.runtime }};assert.ok(checkAddresses(text.subject(text.slots,{contract,profile})).every(row=>row.verdict==='support'));
});

test('selection format belongs to the declared closed set',()=>{
 const data=cellPlan();data.blocks[1].table.format='unknown_shape';assert.equal(readSlots(data).ok,false);
});
test('selection arguments reject formatter braces outside the first input position',()=>{
 for(const mutate of [(block:Record<string,any>)=>{block.select.where[0].value='{field}';},(block:Record<string,any>)=>{block.table.separator='}';},(block:Record<string,any>)=>{block.table.separator='{separator}';}]){const data=cellPlan();mutate(data.blocks[1]);assert.equal(readSlots(data).ok,false);}
 const literal=recipe();literal.slots.blocks[1].select.where[0].value='{{field}}';assert.ok(checkContractShape(literal.subject(literal.slots)).every(outcome=>outcome.verdict==='support'));
 const input=recipe();input.slots.blocks[1].select.where[0].value=`a,'quoted',"value"`;assert.ok(checkContractShape(input.subject(input.slots)).some(outcome=>outcome.verdict==='refute'&&outcome.code==='case-compile.param_value'));
});
test('literal JSON without an input keeps its existing G representation',()=>{
 const input=recipe(),step={object:'device0',method:'command',args:['{"field":"value"}'],keywords:{}};
 assert.deepEqual(bindArguments(runtimeMethod(input.contract,step.object,step.method)!,step,'/steps/0').problems,[]);const decoded=decodeG(encodeG(step));assert.deepEqual(decoded.args,step.args);assert.deepEqual(Object.entries(decoded.keywords),[]);
});

test('observation or capture unknowns disclose frozen cell capabilities once per reply',()=>{
 const resign=(base:{contractDoc:Record<string,any>;profileDoc:Record<string,any>},mutate:(doc:Record<string,any>)=>void)=>{
  const doc=structuredClone(base.contractDoc) as Record<string,any>;mutate(doc);
  const contract=signTypedRuntime(doc),profile=structuredClone(base.profileDoc) as Record<string,any>;
  profile.workbook.template=(profileDocument(contract as Parameters<typeof profileDocument>[0]) as Record<string,any>).workbook.template;
  return {contract,profile};
 };
 const bare=fixture(),noCell=resign(bare,doc=>{doc.runtime.block_model.output_methods=[];doc.runtime.block_model.capture_registers=false;delete doc.runtime.block_model.cell_inputs;delete doc.runtime.block_model.cell_methods;});
 const [bareOutcome]=checkContractShape(bare.subject(positiveBlocks().CAPTURE,noCell));
 assert.equal(bareOutcome?.verdict,'unknown',JSON.stringify(bareOutcome));
 const bareProblems=(bareOutcome as any).data.problems as Array<{pointer:string;message:string;verdict:string}>;
 const unregisteredText='本次执行器规则未登记取格（无 cell_inputs / cell_methods）；不要改用 SELECT_CELL 或 input_register 绕过；要单格回填须等维护者发布取格入口后再开新运行';
 assert.equal(bareProblems.filter(p=>p.message===unregisteredText).length,1,JSON.stringify(bareProblems));
 assert.ok(bareProblems.some(p=>p.pointer==='/blocks'&&p.verdict==='unknown'&&p.message===unregisteredText));

 const cell=recipe(),partial=resign(cell,doc=>{doc.runtime.block_model.capture_registers=false;});
 const [partialOutcome]=checkContractShape(cell.subject(cell.slots,partial));
 assert.equal(partialOutcome?.verdict,'unknown',JSON.stringify(partialOutcome));
 const partialProblems=(partialOutcome as any).data.problems as Array<{pointer:string;message:string;verdict:string}>;
 assert.equal(partialProblems.filter(p=>p.message.includes('本次执行器规则取格登记')).length,1,JSON.stringify(partialProblems));
 assert.ok(partialProblems.some(p=>p.pointer==='/blocks'&&p.message==='本次执行器规则取格登记：cell_inputs=已声明；已登记 cell_methods：device0.table_cell'));
 assert.ok(!partialProblems.some(p=>p.message.includes('无 cell_inputs / cell_methods')));

 const noObs=resign(bare,doc=>{doc.runtime.found_times_supported=false;});
 const timesPlan=structuredClone(positiveBlocks().OBSERVE_ASSERT);
 (timesPlan.blocks[0] as Record<string,any>).assertions[0].op='found_times';
 (timesPlan.blocks[0] as Record<string,any>).assertions[0].count=2;
 const [noObsOutcome]=checkContractShape(bare.subject(timesPlan,noObs));
 assert.equal(noObsOutcome?.verdict,'unknown',JSON.stringify(noObsOutcome));
 const noObsProblems=(noObsOutcome as any).data.problems as Array<{message:string}>;
 assert.ok(!noObsProblems.some(p=>p.message.includes('取格')),JSON.stringify(noObsProblems));
});

test('checks separate unknown block gaps from downstream refutes instead of bundling them into method_forbidden',()=>{
 const bare=fixture(),doc=structuredClone(bare.contractDoc) as Record<string,any>;
 doc.runtime.block_model.capture_registers=false;
 const contract=signTypedRuntime(doc),profile=structuredClone(bare.profileDoc) as Record<string,any>;
 profile.workbook.template=(profileDocument(contract as Parameters<typeof profileDocument>[0]) as Record<string,any>).workbook.template;
 const mixed=structuredClone(positiveBlocks().CONFIG);
 mixed.blocks.unshift(structuredClone(positiveBlocks().CAPTURE.blocks[0]));
 mixed.blocks.pop();
 const outcomes=checkContractShape(bare.subject(mixed,{contract,profile}));
 assert.equal(outcomes.length,2,JSON.stringify(outcomes));
 const refused=outcomes.find(o=>o.verdict==='refute'),unknown=outcomes.find(o=>o.verdict==='unknown');
 assert.ok(refused&&refused.code==='case-compile.method_forbidden',JSON.stringify(outcomes));
 assert.ok(unknown&&unknown.reason==='missing_input',JSON.stringify(outcomes));
 const refuteProblems=(refused as any).data.problems as Array<{verdict:string}>;
 const unknownProblems=(unknown as any).data.problems as Array<{verdict:string;message:string}>;
 assert.ok(refuteProblems.length>=1&&refuteProblems.every(p=>p.verdict==='refute'),JSON.stringify(refuteProblems));
 assert.ok(unknownProblems.length>=1&&unknownProblems.every(p=>p.verdict!=='refute'),JSON.stringify(unknownProblems));
 assert.ok(unknownProblems.some(p=>p.message.includes('本次执行器规则未登记取格（无 cell_inputs / cell_methods）')),JSON.stringify(unknownProblems));

 const disabledProfile=structuredClone(profile);disabledProfile.block_model=false;
 const earlyOutcomes=checkContractShape(bare.subject(mixed,{contract,profile:disabledProfile}));
 assert.equal(earlyOutcomes.length,1,JSON.stringify(earlyOutcomes));
 assert.equal(earlyOutcomes[0]?.verdict,'unknown');
 assert.equal(earlyOutcomes[0]?.reason,'missing_input');
});

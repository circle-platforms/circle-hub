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

function recipe(){const f=cellFixture();return {...f,slots:cellPlan(),plan_run:'run_00000000000000000000000000',build:'SYN-BUILD-A'};}
test('selection lowers readable multiple-equality arguments and roundtrips G H and I',()=>{
 const input=recipe(),parsed=readSlots(input.slots);assert.ok(parsed.ok,JSON.stringify(parsed));if(!parsed.ok)return;
 assert.deepEqual(typedAuthorityGaps(input.contract,input.profile,parsed.slots,undefined,input.catalog,[],input.manifest_sha256),[]);
 assert.ok(checkAddresses(input.subject(input.slots)).every(outcome=>outcome.verdict==='support'));
 const selected=parsed.slots.steps[1];assert.deepEqual(selected.args,['{}','where 1=zone.example.','where 6=2048.key']);assert.deepEqual(selected.keywords,{separator:'+',columns:6,column:3,format:'delimited',header:0,row:0});
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
 const input=recipe();input.slots.blocks[1].select={where:[{column:1,value:'00123'},{column:6,value:'a,b'}]};
 const read=readWorkbook(coreModel(generateWorkbook(input)),input);assert.ok(read.ok,JSON.stringify(read));if(read.ok)assert.deepEqual(read.executions.find(row=>row.method==='table_cell')!.args,['{}','where 1=00123','where 6=a,b']);
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
 const input=recipe();for(const field of ['cell_inputs','cell_methods']){const doc=structuredClone(input.contractDoc) as any;delete doc.runtime.block_model[field];const contract=signTypedRuntime(doc);const subject=input.subject(input.slots,{contract,profile:{...input.profileDoc,runtime:{...input.profileDoc.runtime,contract_sha256:contract.original.contract_sha256}}});assert.ok(checkContractShape(subject).some(outcome=>outcome.verdict==='unknown'));}
});
test('independent workbook reading rejects changed source result type scope and template',()=>{
 const input=recipe(),bytes=generateWorkbook(input);
 for(const corruption of ['source','result','template','condition','method']){
  const model=coreModel(bytes) as any,rows=model.sheets[0].rows,cell=(row:any,column:string)=>row.cells.find((value:any)=>value.reference.startsWith(column));
  const selection=rows.find((row:any)=>cell(row,'F')?.text==='table_cell'),configuration=rows.find((row:any)=>cell(row,'G')?.text==='demo set {}');
  if(corruption==='source')cell(selection,'I').text='selected';
  if(corruption==='result')cell(selection,'H').text='source_text';
  if(corruption==='template')cell(configuration,'I').text='source_text';
  if(corruption==='condition')cell(selection,'G').text=cell(selection,'G').text.replace('2048.key','different');
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
 const input=recipe(),document=structuredClone(input.contractDoc) as any;document.effects.host.allowed_literals=[];document.effects.host.allowed_programs=[{program:'echo'}];const contract=signTypedRuntime(document),profile={...input.profileDoc,runtime:{...input.profileDoc.runtime,contract_sha256:contract.original.contract_sha256}};
 input.slots.blocks[2]={kind:'STEP',id:'configure',input_register:'selected',call:{object:'client',method:'shell',args:['echo {}'],keywords:{}}};input.slots.blocks.pop();
 const subject=(data:unknown)=>input.subject(data,{contract,profile});assert.ok(checkContractShape(subject(input.slots)).every(outcome=>outcome.verdict==='support'));
 for(const line of ['another {}','echo {}; other']){const data=structuredClone(input.slots);data.blocks[2].call.args=[line];assert.ok(checkContractShape(subject(data)).some(outcome=>outcome.verdict==='refute'));}
});

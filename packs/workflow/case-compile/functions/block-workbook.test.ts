import assert from 'node:assert/strict';
import {test} from 'node:test';
import {fixture,positiveBlocks,plan,call,assertion,quote,EXPECTED_REF} from '../testing/blocks.ts';
import {generateWorkbook} from './generate.ts';
import {readWorkbook} from './workbook.ts';
import {coreModel} from '../testing/workbook-model.ts';
import {checkContractShape} from './checks.ts';
import {signTypedRuntime} from '../testing/typed-fixtures.ts';
import type {PlanSlots} from './slots.ts';
function recipe(slots:PlanSlots){const f=fixture();return {slots,fields:f.fields,contract:f.contract,profile:f.profile,plan_run:'run_00000000000000000000000000',build:'SYN_ORBIT_10_8_1'};}
for(const corruption of ['expected-register','actual-register','captured-twice','operator','restore-target','unknown-input'])test('independent row reading rejects '+corruption,()=>{
 const input=recipe(corruption==='restore-target'?positiveBlocks().RESTORE_FROM:positiveBlocks().CAPTURE_COMPARE),model=coreModel(generateWorkbook(input));
 const rows=(model as any).sheets[0].rows;
 const has=(row:any,column:string)=>row.cells.find((cell:any)=>cell.reference.startsWith(column));
 const checkpoints=rows.filter((row:any)=>has(row,'E')?.text==='check');
 if(corruption==='operator')has(checkpoints[0],'F').text='not_found';
 else if(corruption==='expected-register')has(checkpoints[0],'H').text='absent';
 else if(corruption==='actual-register')has(checkpoints[0],'I').text='absent';
 else if(corruption==='captured-twice'){const captures=rows.filter((row:any)=>has(row,'E')?.text==='ORBIT_0'&&has(row,'H'));has(captures[1],'H').text=has(captures[0],'H').text;}
 else if(corruption==='restore-target'){const row=rows.find((row:any)=>has(row,'F')?.text==='restore_checked');has(row,'G').text=has(row,'G').text.replace('demo/set','demo/other');}
 else {const row=rows.find((row:any)=>has(row,'H')?.text==='baseline');row.cells.push({reference:'I'+row.number,type:'inlineStr',text:'absent',style:null,formula:null});}
 const read=readWorkbook(model,input);assert.equal(read.ok,false);if(!read.ok)assert.ok(read.problems.some(problem=>problem.rule!=='recipe'));
});
test('same is a pair of raw literal containments, not regex equality or one-way containment',()=>{
 const input=recipe(positiveBlocks().CAPTURE_COMPARE),read=readWorkbook(coreModel(generateWorkbook(input)),input);assert.ok(read.ok);if(!read.ok)return;
 const checks=read.executions.filter(row=>row.assertion);assert.equal(checks.length,2);assert.ok(checks.every(row=>row.method==='abs_found'&&row.h&&row.i));
 const left='a+b.[x]\\tail',right=left+' more';assert.equal(right.includes(left)&&left.includes(right),false);assert.equal(left.includes(left)&&left.includes(left),true);
});
test('differs chooses the declared exact text comparator and never regular-expression not_found',()=>{
 const data=positiveBlocks().CAPTURE_COMPARE;data.blocks[2].relation='differs';data.obligations![0].assertions=['comparison'];
 const input=recipe(data),read=readWorkbook(coreModel(generateWorkbook(input)),input);assert.ok(read.ok,JSON.stringify(read));if(read.ok)assert.deepEqual(read.executions.filter(row=>row.assertion).map(row=>row.method),['differs_literal']);
});
test('host observations require an actual declared responder, not a phrase in the author text',()=>{
 const f=fixture(),data=plan([{kind:'OBSERVE_ASSERT',id:'host',call:{object:'client',method:'shell',args:['echo SYNTHETIC_READY'],keywords:{}},assertions:[assertion('hostAssert','host')]}]);
 assert.ok(checkContractShape(f.subject(data)).some(row=>row.verdict==='unknown'&&row.missing?.includes('应答者')));
 data.block_context!.responders=[{output:'host',kind:'bed_service',ref:'server0',quote:quote()}];assert.ok(checkContractShape(f.subject(data)).every(row=>row.verdict==='support'));
 data.block_context!.responders[0].ref='absent';assert.ok(checkContractShape(f.subject(data)).some(row=>row.verdict==='refute'));
});
test('a second synthetic product uses the same block rules with independently declared names and grammar',()=>{
 const f=fixture(),raw=structuredClone(f.contractDoc) as any,profile=structuredClone(f.profileDoc),inventory=structuredClone(f.inventory),catalog=structuredClone(f.catalog);
 for(const object of raw.objects)if(object.e==='ORBIT_0')object.e='API_TARGET';for(const entry of raw.entries)if(entry.e==='ORBIT_0')entry.e='API_TARGET';
 for(const row of raw.runtime.block_model.output_methods)if(row.object==='ORBIT_0')row.object='API_TARGET';for(const row of raw.runtime.block_model.restore_methods)if(row.object==='ORBIT_0')row.object='API_TARGET';
 raw.effects.command.command_scope=['/commands/GET'];for(const row of profile.allowed)if(row.object==='ORBIT_0')row.object='API_TARGET';profile.seats[0].object='API_TARGET';for(const device of inventory.beds[0].devices)if(device.product)device.product='lumen-api';
 const contract=signTypedRuntime(raw);profile.runtime.contract_sha256=contract.original.contract_sha256;
 catalog.entries=[{...catalog.entries[0],words:['GET','/health'],reference:'tree:'+catalog.root+'/commands/GET/%2Fhealth'}];catalog.policy.read_only=['/commands/GET'];catalog.policy.inverse_rules=[];
 const data=positiveBlocks().OBSERVE_ASSERT;data.blocks[0].call={object:'API_TARGET',method:'command',args:['GET /health'],keywords:{}};
 assert.ok(checkContractShape(f.subject(data,{contract,profile,manifest:inventory,command_catalog:catalog})).every(row=>row.verdict==='support'));
});
test('one raw observation expands multiple literal assertion families without regular-expression meaning',()=>{
 const data=plan([{kind:'OBSERVE_ASSERT',id:'observe',call:call(),assertions:['found','not_found','abs_found','found_times'].map((op,index)=>({...assertion('assert'+index,'observe',op),literal:'a+b.[x]\\tail'}))}]);
 const input=recipe(data),result=readWorkbook(coreModel(generateWorkbook(input)),input);assert.ok(result.ok,JSON.stringify(result));if(!result.ok)return;
 const rows=result.executions.filter(row=>row.assertion);assert.equal(rows.length,4);assert.deepEqual(rows.map(row=>row.method),['found','not_found','abs_found','found_times']);
 assert.equal(rows[2].args[0],'a+b.[x]\\tail');assert.equal(new RegExp(rows[0].args[0]).test('a+b.[x]\\tail'),true);assert.equal(new RegExp(rows[0].args[0]).test('aaabZx'),false);assert.equal(rows[3].i,'2');
});

// PICK (decision 163): a word taken from a captured output fills one quoted "{}" of a later call, through the runner's match
// register (runtime.checkpoint_match_register). The pattern is built from an escaped literal and a fixed word class; no author
// regex runs. Synthetic ORBIT fixture only.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {fixture,plan,call,assertion,quote} from '../testing/blocks.ts';
import {signTypedRuntime} from '../testing/typed-fixtures.ts';
import {readSlots} from './slots.ts';
import {generateWorkbook} from './generate.ts';
import {readWorkbook} from './workbook.ts';
import {coreModel} from '../testing/workbook-model.ts';
import {blockRuntimeGaps} from './block-runtime.ts';
import {parseRuntimeContract} from './runtime-contract.ts';
import {parseManifest} from './manifest.ts';
import {parseProfile} from './profile.ts';

const capture={kind:'CAPTURE',id:'keys',call:call('demo show'),register:'keys'},observe={kind:'OBSERVE_ASSERT',id:'observe',call:call(),assertions:[assertion()]};
const pick=(extra:Record<string,unknown>={})=>({kind:'PICK',id:'publish',from:'keys',starts_with:'Kzone.',call:{object:'ORBIT_0',method:'command',args:['demo label "{}"'],keywords:{}},...extra});
const without=(block:Record<string,unknown>,key:string)=>Object.fromEntries(Object.entries(block).filter(([name])=>name!==key));
// A realistic PICK case: capture, pick into a configuration, observe it, clean it up; the configuration names its observation.
const cleanup={kind:'CONFIG',id:'cleanup',call:call('no demo label'),cleanup:true};
function picked(){const slots=plan([capture,pick(),observe,cleanup]);slots.block_context!.causal_links=[{from:'publish',to:'observe',quote:quote()}];return slots;}
const problems=(blocks:Array<Record<string,unknown>>)=>{const read=readSlots(plan(blocks));return read.ok?[]:read.problems.map(p=>p.pointer+' '+p.message);};
// The block fixture declares the match register; this one is the same contract without it.
function withoutRegister(){
 const f=fixture(),doc=structuredClone(f.contractDoc) as Record<string,any>;const {checkpoint_match_register:_dropped,...runtime}=doc.runtime;doc.runtime=runtime;
 const contract=parseRuntimeContract(signTypedRuntime(doc)),beds=parseManifest(f.inventory);if(!contract.ok||!beds.ok)throw new Error('fixture');
 const profile=parseProfile(f.profileDoc,contract.contract,beds.beds);if(!profile.ok)throw new Error(JSON.stringify(profile.problems));
 return {f,contract:contract.contract,profile:profile.profile};
}
const recipe=(slots:unknown,contract:any,profile:any,f:ReturnType<typeof fixture>)=>({slots,fields:f.fields,contract,profile,plan_run:'run_00000000000000000000000000',build:'SYN_ORBIT_10_8_1'}) as any;

test('PICK lowers to its call carrying the source register and a pattern built from the escaped literal', () => {
 const read=readSlots(plan([capture,observe,pick()]));assert.ok(read.ok,JSON.stringify(read));if(!read.ok)return;
 assert.deepEqual(read.slots.steps.at(-1)!.pick,{from:'keys',pattern:'(Kzone\\.[^\\s"\']*)'});
 const after=readSlots(plan([capture,observe,{...without(pick(),'starts_with'),after:'key file:'}]));assert.ok(after.ok);if(!after.ok)return;
 assert.equal(after.slots.steps.at(-1)!.pick!.pattern,'key file:\\s*["\']?([^\\s"\']+)');
});

test('PICK takes exactly one form, a register captured before it and one quoted placeholder in its first argument', () => {
 assert.ok(problems([capture,observe,pick({after:'key file:'})]).some(p=>p.includes('恰好写一个')));
 assert.ok(problems([capture,observe,without(pick(),'starts_with')]).some(p=>p.includes('恰好写一个')));
 assert.ok(problems([observe,pick({from:'nowhere'})]).some(p=>p.startsWith('/blocks/1/from')));
 for(const line of ['demo label {}','demo label "{}" "{}"','demo label "{0}"'])assert.ok(problems([capture,observe,pick({call:{object:'ORBIT_0',method:'command',args:[line],keywords:{}}})]).some(p=>p.startsWith('/blocks/2/call/args')),line);
});

test('the check point row goes right before the call, whose input names the match register, and the read-back accepts only that', () => {
 const f=fixture(),{contract,profile}=f,input=recipe(picked(),contract,profile,f),bytes=generateWorkbook(input),model=coreModel(bytes) as any;
 const rows=model.sheets[0].rows,cell=(row:any,column:string)=>row.cells.find((c:any)=>c.reference.startsWith(column))?.text??'';
 const at=rows.findIndex((row:any)=>cell(row,'E')==='check'&&cell(row,'F')==='found'&&cell(row,'I')==='keys');
 assert.ok(at>0,'a found check point reads the captured register');
 assert.equal(cell(rows[at],'G'),'(Kzone\\.[^\\s"\']*)');
 assert.deepEqual(['E','G','I'].map(c=>cell(rows[at+1],c)),['ORBIT_0','demo label "{}"','check.matched']);
 const read=readWorkbook(coreModel(bytes),input);assert.ok(read.ok,JSON.stringify(read));
 for(const [column,text] of [['G','(Kother\\.[^\\s"\']*)'],['I','keys']] as const){
  const broken=coreModel(bytes) as any,row=broken.sheets[0].rows[column==='G'?at:at+1];row.cells.find((c:any)=>c.reference.startsWith(column)).text=text;
  const bad=readWorkbook(broken,input);assert.equal(bad.ok,false,column);
 }
});

test('without the runner declaration PICK is not generated and the plan check names the missing declaration', () => {
 const {f,contract,profile}=withoutRegister(),slots=picked();
 assert.throws(()=>generateWorkbook(recipe(slots,contract,profile,f)),/取词需要|检查点命中寄存器/);
 const read=readSlots(slots);assert.ok(read.ok);if(!read.ok)return;
 const gaps=blockRuntimeGaps(contract,profile,read.slots);
 assert.ok(gaps.some(g=>g.verdict==='unknown'&&g.message.includes('runtime.checkpoint_match_register')),JSON.stringify(gaps));
});

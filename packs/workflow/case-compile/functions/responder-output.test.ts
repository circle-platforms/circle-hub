// block_context.responders[].output names an observation block by its id. The schema and the writer text say so, and a
// refusal names the value written, the closed set of this plan's observation ids and, when the value is the saved name of one
// observation block, that block's id. Nothing is rewritten for the model.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {assertion,call,fixture,plan,quote} from '../testing/blocks.ts';
import {readSlots} from './slots.ts';
import {typedAuthorityGaps,authorityRecovery,humanGapLocation} from './typed-authority.ts';
import {checkContractShape} from './checks.ts';
import {SUBAGENT_ROLES} from './subagent-roles.ts';

const host=()=>({object:'client',method:'shell',args:['echo SYNTHETIC_READY'],keywords:{} as Record<string,string>});
/** A saved device output, a configuration, a host observation and a second saved output: the shape of the round-33 plan. */
function scenario(responders:Array<Record<string,any>>){
 const f=fixture();
 const data=plan([
  {kind:'CAPTURE',id:'b_show',call:call(),register:'show_raw'},
  {kind:'CONFIG',id:'b_set',call:call('demo set 5')},
  {kind:'OBSERVE_ASSERT',id:'b_probe',call:host(),assertions:[assertion('a_ready','b_probe')]},
  {kind:'CONFIG',id:'b_undo',call:call('no demo set'),cleanup:true},
 ]);
 data.block_context!.causal_links=[{from:'b_set',to:'b_probe',quote:quote()}];
 data.block_context!.responders=responders;
 return {f,data};
}
const row=(output:string,ref='dut0',kind='device')=>({output,kind,ref,quote:quote()});
function gapsOf(data:ReturnType<typeof scenario>['data'],f:ReturnType<typeof fixture>){
 const parsed=readSlots(data);assert.ok(parsed.ok,JSON.stringify(parsed));if(!parsed.ok)return [];
 return typedAuthorityGaps(f.contract,f.profile,parsed.slots,undefined,f.catalog,[],f.manifest_sha256);
}
const OBSERVATIONS=['b_show','b_probe'];

test('a responder whose output is a saved name or an invented name is refused with the value, the observation ids and the exact block id when one block owns the name',()=>{
 const {f,data}=scenario([row('probe_out','b_probe'),row('show_raw','b_show')]);
 const before=JSON.stringify(data),gaps=gapsOf(data,f),first=gaps.find(gap=>gap.pointer==='/block_context/responders/0/output') as any,second=gaps.find(gap=>gap.pointer==='/block_context/responders/1/output') as any;
 assert.ok(first&&second,JSON.stringify(gaps));
 for(const gap of [first,second]){
  assert.equal(gap.verdict,'refute');assert.deepEqual(gap.allowed_output_ids,OBSERVATIONS);
  assert.ok(gap.message.includes('b_show')&&gap.message.includes('b_probe'),gap.message);assert.match(gap.message,/观察块/);
 }
 assert.equal(first.requested_output,'probe_out');assert.ok(first.message.includes('"probe_out"'));assert.equal(first.expected_output,undefined);assert.ok(!first.message.includes('应填块 id'),first.message);
 assert.equal(second.requested_output,'show_raw');assert.ok(second.message.includes('"show_raw"'));assert.equal(second.expected_output,'b_show');assert.ok(second.message.includes('应填块 id b_show'),second.message);
 assert.equal(JSON.stringify(data),before,'the plan the model wrote is never rewritten');
});

test('the refusal reads through the human location and the whole answer, and names the missing responder of the host observation',()=>{
 const {f,data}=scenario([row('probe_out','b_probe'),row('show_raw','b_show')]),gaps=gapsOf(data,f);
 assert.equal(humanGapLocation('blocks','/block_context/responders/1/output'),'应答者声明第 2 条（/block_context/responders/1/output）');
 const text=authorityRecovery(gaps.filter(gap=>gap.verdict==='refute'));assert.ok(text.includes('应答者声明第 2 条'),text);assert.ok(text.includes('应填块 id b_show'),text);
 const missing=gaps.find(gap=>gap.verdict==='unknown'&&gap.pointer==='/blocks/2/call')!;assert.ok(missing,JSON.stringify(gaps));
 assert.ok(missing.message.includes('b_probe'),missing.message);assert.ok(missing.message.includes('probe_out')&&missing.message.includes('show_raw'),'the rows that exist are shown: '+missing.message);
});

test('a device responder whose ref is not a frozen seat is told what ref holds, next to the output refusal',()=>{
 const {f,data}=scenario([row('probe_out','b_probe')]),gap=gapsOf(data,f).find(item=>item.pointer==='/block_context/responders/0/output')!;
 assert.ok(gap.message.includes('"b_probe"'),gap.message);assert.ok(gap.message.includes(f.profile.seats[0].device),gap.message);assert.match(gap.message,/ref/);
 const fixture_=scenario([{output:'probe_out',kind:'fixture',ref:'b_show',quote:quote()}]),other=gapsOf(fixture_.data,fixture_.f).find(item=>item.pointer==='/block_context/responders/0/output')!;
 assert.ok(!other.message.includes('冻结设备座位'),'only a device row is told about seats: '+other.message);
});

test('an output that is the id of a block which produces no device text, or the saved cell of one, is said to be so',()=>{
 const {f,data}=scenario([row('b_set'),row('b_probe')]),gaps=gapsOf(data,f),gap=gaps.find(item=>item.pointer==='/block_context/responders/0/output')!;
 assert.ok(gap.message.includes('b_set')&&gap.message.includes('CONFIG'),gap.message);assert.match(gap.message,/不是观察块/);
 assert.ok(!gaps.some(item=>item.pointer==='/block_context/responders/1/output'),'a row that names its observation block is accepted');
});

test('correct rows leave no responder finding and the plan passes every check',()=>{
 const {f,data}=scenario([row('b_probe')]);
 assert.deepEqual(gapsOf(data,f).filter(gap=>gap.pointer.includes('responders')||gap.message.includes('应答者')),[]);
 assert.ok(checkContractShape(f.subject(data)).every(outcome=>outcome.verdict==='support'));
});

test('a plan with a single capture offers it by id, and a plan with no observation block says so instead of listing an empty set as a fact',()=>{
 const f=fixture(),data=plan([{kind:'CAPTURE',id:'only',call:call(),register:'raw'}],[]);data.block_context!.responders=[row('raw','only')];
 const gap=gapsOf(data,f).find(item=>item.pointer==='/block_context/responders/0/output') as any;
 assert.ok(gap,JSON.stringify(gapsOf(data,f)));assert.deepEqual(gap.allowed_output_ids,['only']);assert.equal(gap.expected_output,'only');assert.ok(gap.message.includes('应填块 id only'),gap.message);
 const stripped=plan([{kind:'CONFIG',id:'cfg',call:call('demo set 5')}],[]);stripped.block_context!.responders=[row('cfg')];
 const none=gapsOf(stripped,f).find(item=>item.pointer==='/block_context/responders/0/output') as any;assert.ok(none,JSON.stringify(gapsOf(stripped,f)));assert.deepEqual(none.allowed_output_ids,[]);assert.match(none.message,/没有观察块/);
});

const READ=(path:string)=>JSON.parse(readFileSync(new URL('../'+path,import.meta.url),'utf8'));
function responderSchema(root:any):any{let node=root;for(const key of ['block_context','responders'])node=node.properties[key];return node.items.properties;}
test('every published schema says what output and ref hold',()=>{
 const sources:Record<string,any>={
  'tables/blocks-format.json':READ('tables/blocks-format.json').context_schema,
  'tables/block-plan.schema.json':READ('tables/block-plan.schema.json'),
  'slots.schema.json':READ('slots.schema.json').item.plan.data,
 };
 for(const [file,root] of Object.entries(sources)){
  const fields=responderSchema(file==='tables/block-plan.schema.json'||file==='slots.schema.json'?root:{properties:{block_context:root}});
  const output=String(fields.output.description??''),ref=String(fields.ref.description??''),kind=String(fields.kind.description??'');
  assert.match(output,/observation block/i,file);assert.match(output,/blocks\[\]\.id/,file);assert.match(output,/never a register name/i,file);
  for(const word of ['device','fixture','bed_service','undetermined'])assert.ok(ref.includes(word)&&kind.includes(word),`${file} ${word}`);
  assert.match(ref,/profile\.seats\[\]\.device/,file);
 }
});

test('the writer role text and its bundled definition say what output and ref hold',()=>{
 const writer=SUBAGENT_ROLES.find(role=>role.key==='plan')!;
 for(const text of [writer.body,readFileSync(new URL('../agents/compile-writer.md',import.meta.url),'utf8')]){
  assert.match(text,/responders\[\]\.output/);assert.match(text,/观察块 id/);assert.match(text,/不是 register 保存名/);
  assert.match(text,/profile\.seats\[\]\.device/);assert.match(text,/bed_service/);
 }
});

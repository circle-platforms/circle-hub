import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { LoggedTurn } from '../lib/accept.ts';
import type { Turn } from '../scripted-model.ts';
import { canonicalJson, type RunShowExport, type Submission } from '../gold/compile-check.ts';
import scenario, { type CaseCompileGold } from './case-compile.ts';
const id = 'run_'+'0'.repeat(25)+'1';
const rec = 'rec:'+'a'.repeat(64);
const note = '按合成合约核对；不证明在真实设备上跑得通';
function fixture(): CaseCompileGold {
  const submission: Submission = {run:id,model:'synthetic-model',items:[{item:'doc-1:c-1',handling:'handled',slots:{plan:[{text:'合成计划',quotes:[{reference:'src:synthetic',text:'保存成功'}],data:{bucket:'bed-a',blocks:[],steps:[{object:'dut',method:'save',params:{}}],expects:[{text:'保存成功',quote:{reference:'src:synthetic',text:'保存成功'}}]}}]}}]};
  const text = '{"bed":"bed-a","blocks":[],"case":"doc-1:c-1","expects":[{"source":"src:synthetic","text":"保存成功"}],"schema":"exec-plan@1","steps":[{"method":"save","n":1,"object":"dut","params":{}}]}';
  const run: RunShowExport = {run:{run:id,started_at:'2026-10-23T00:00:00Z',lease_context:[],items:[{id:'doc-1:c-1'}]},latest:{result:{run:id,submission:createHash('sha256').update(canonicalJson(submission)).digest('hex'),partitions:{delivered:[{item:'doc-1:c-1',requirements:['contract_methods','bed_addresses','commands_known','expected_grounded','plan_deterministic'].map(requirement => ({requirement,layers:[{layer:'static',terminal:'pass'}],status:'satisfied',claims:requirement === 'plan_deterministic' ? [{statement:{text:note,verdict:'support',data:{plan:text,sha256:createHash('sha256').update(text).digest('hex')}}}] : []}))}]}}}};
  return {caseDoc:'agile:mindmap:doc-1',submission,contract:{schema:'compile-contract@1',synthetic:true,objects:[{name:'dut',methods:[{name:'save',params:[]}]}],forbidden:[]},bed:{schema:'test-bed-manifest@1',beds:[{name:'bed-a',devices:[],services:[],reserved:[]}]},sources:new Map([['src:synthetic','预期：保存成功']]),runExport:run};
}
const turn = (index: number,text = '',isError = false): Turn => ({index,system:null,messages:[],tools:[],toolResults:text ? [{id:'r',text,isError}] : []});
const log = (text = note): LoggedTurn[] => [
  {index:0,tools:['hub_start_run'],toolResults:[]},
  {index:1,tools:['hub_submit_result'],toolResults:[{id:'s',isError:false,text:`运行 ${id}`} ]},
  {index:2,tools:['hub_get_nodes'],toolResults:[{id:'p',isError:false,text:`完整结果：${rec}`} ]},
  {index:3,tools:[],toolResults:[{id:'p',isError:false,text}]},
];
test('start request follows the published subject/contract/inventory inputs', async () => {
  const s = scenario(fixture());
  assert.deepEqual(await s.respond(turn(0)),[{tool:'hub_start_run',input:{pack:'case-compile',inputs:{subject:{external:'agile:mindmap:doc-1'},contract:{external:'doc:doc:compile-contract'},inventory:{external:'doc:doc:bed-topology'}},parameters:{}}}]);
});
test('submits the actual started run, then pages the submit result', async () => {
  const g = fixture(), s = scenario(g);
  await s.respond(turn(0));
  const actualId = 'run_'+'1'.repeat(26);
  assert.deepEqual(await s.respond(turn(1,`运行 ${actualId}`)),[{tool:'hub_submit_result',input:{...g.submission,run:actualId}}]);
  assert.deepEqual(await s.respond(turn(2,`完整结果：${rec}`)),[{tool:'hub_get_nodes',input:{reference:rec}}]);
  assert.deepEqual(await s.respond(turn(3,`下一页：get_nodes {"reference":"${rec}","cursor":"next"}`)),[{tool:'hub_get_nodes',input:{reference:rec,cursor:'next'}}]);
  assert.deepEqual(await s.respond(turn(4,note)),[{text:note+'。'}]);
});
test('without a run id or after a tool error no submission is invented', async () => {
  const s = scenario(fixture()); await s.respond(turn(0));
  assert.ok((await s.respond(turn(1,'没有结果'))).every(r => 'text' in r));
  await s.respond(turn(0)); assert.ok((await s.respond(turn(1,'出错',true))).every(r => 'text' in r));
});
test('complete structured export and matching client log pass', () => { const checks = scenario(fixture()).check(log()); assert.ok(checks.every(c => c.ok),JSON.stringify(checks)); });
test('missing export stays unverified even if prose says all passed', () => { const g = fixture(); delete g.runExport; assert.equal(scenario(g).check(log(note+'全部通过，编译核对通过')).find(c => c.name.includes('逐项'))?.ok,false); });
test('missing submit call fails', () => { const l = log(); l[1].tools = []; assert.equal(scenario(fixture()).check(l).find(c => c.name.includes('实际提交'))?.ok,false); });
test('export from another run fails binding', () => { const g = fixture(); g.runExport!.run.run = 'run_'+'2'.repeat(26); assert.equal(scenario(g).check(log()).find(c => c.name.includes('客户端运行'))?.ok,false); });
for (const missing of ['按合成合约核对','不证明在真实设备上跑得通']) test(`missing disclosure ${missing} fails`, () => { const checks = scenario(fixture()).check(log(note.replace(missing,''))); assert.ok(checks.some(c => !c.ok && c.name.includes(missing.startsWith('按') ? '合约属性' : '效力范围'))); });
test('Hub requirement disagreement fails the independent comparison', () => { const g = fixture(); g.runExport!.latest!.result!.partitions.delivered![0].requirements[0].layers[0].terminal = 'violation'; assert.equal(scenario(g).check(log()).find(c => c.name.includes('逐项'))?.ok,false); });
test('tampered digest fails even with an all-passed terminal', () => { const g = fixture(); g.runExport!.latest!.result!.partitions.delivered![0].requirements[4].claims[0].statement.data!.sha256 = '0'.repeat(64); assert.equal(scenario(g).check(log()).find(c => c.name.includes('sha256'))?.ok,false); });
test('truncated pagination and tool errors fail', () => {
  assert.equal(scenario(fixture()).check(log(`下一页：get_nodes {"reference":"${rec}","cursor":"next"}`)).find(c => c.name.includes('分页'))?.ok,false);
  const l = log(); l[3].toolResults[0].isError = true; assert.equal(scenario(fixture()).check(l).find(c => c.name.includes('分页'))?.ok,false);
});

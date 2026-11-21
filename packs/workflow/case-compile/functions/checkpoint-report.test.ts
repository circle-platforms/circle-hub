// A conclusion that rests on a checkpoint the model wrote itself is shown as the model's judgment, not reviewed, decided by
// the device run (owner, 2026-11-16), in words a reader of the delivery follows (owner, 2026-11-21). The checkpoints are read from the Hub's own record of the expected_grounded check.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {fixture,plan,call,assertion,EXPECTED_REF,BLOCK_ROOT} from '../testing/blocks.ts';
import {caseConclusion,deliveryReport,unsuccessfulReport,modelCheckpointsOf,type CaseOutcome,type ReportInput} from './delivery.ts';
import {checkExpectedSources} from './checks.ts';
import {replyText} from '../tools/assemble-delivery.ts';

const SENTENCE='合成应答带有签名记录',LITERAL='SYNTH-SIG',RATIONALE='模型选择应答里的签名记录名作为检查点；这是模型判断，由上机验证裁定';
const f=fixture();
/** The Hub's own check outcome for a block plan the model grounded itself, wrapped as the plan run's recorded result. */
function recordedResult(item:string,literal=LITERAL){
 const quote={reference:EXPECTED_REF,text:SENTENCE};
 const data=plan([{kind:'OBSERVE_ASSERT',id:'observe',call:call(),assertions:[{...assertion('a_sig','observe','abs_found'),literal,quote,expectation:EXPECTED_REF,criterion:'c_sig'}]}]);
 data.criteria=[{id:'c_sig',expectation:EXPECTED_REF,quote,kind:'literal',operator:'abs_found',literal,rationale:RATIONALE,scope_root:BLOCK_ROOT}];
 const outcome=checkExpectedSources(f.subject(data,{expected_nodes:[{reference:EXPECTED_REF,text:SENTENCE}]}))[0];
 assert.equal(outcome.verdict,'support',JSON.stringify(outcome));
 return {partitions:{delivered:[{item,requirements:[{requirement:'expected_grounded',status:'satisfied',claims:[{statement:{verdict:outcome.verdict,data:outcome.data}}]}]}]}};
}
const delivered:CaseOutcome={autoid:'a',status:'delivered',history:[{ordinal:1,run:'first',job:'first',terminal:'pass'}]};
const input=(over:Partial<ReportInput>={})=>({name:'synthetic',generatedAt:'synthetic',build:null,assembly:{cases:[delivered],totals:{cases:1},pass:{items:['a']},unsuccessful:null},notes:{cases:{}},originals:{a:{title:'合成用例',lines:[]}},excluded:[],files:{pass:{sha256:'a'.repeat(64)},unsuccessful:null},logs:{},...over}) as unknown as ReportInput;

test('the checkpoints a block plan stands on are read from the Hub record of its expectation check',()=>{
 const found=modelCheckpointsOf(recordedResult('item-1'),'item-1');
 assert.deepEqual(found,[{expectation:SENTENCE,literal:LITERAL,rationale:RATIONALE}]);
 assert.deepEqual(modelCheckpointsOf(recordedResult('item-1'),'item-2'),[]);
});

test('the checkpoints of a flat model_judgment expectation are read the same way, and only from a supporting expected_grounded record',()=>{
 const claim=(verdict:string,data:unknown)=>({statement:{verdict,data}});
 const flat={model_expectations:[{index:0,text:'service enabled',quote:{reference:'src:'+'a'.repeat(64)+'/x',text:'服务已启用'},after:1,basis:'model_judgment',rationale:'选设备明确输出的状态文字'}]};
 const result=(requirement:string,verdict:string)=>({partitions:{delivered:[{item:'i',requirements:[{requirement,claims:[claim(verdict,flat)]}]}]}});
 assert.deepEqual(modelCheckpointsOf(result('expected_grounded','support'),'i'),[{expectation:'服务已启用',literal:'service enabled',rationale:'选设备明确输出的状态文字'}]);
 assert.deepEqual(modelCheckpointsOf(result('contract_shape','support'),'i'),[]);
 assert.deepEqual(modelCheckpointsOf(result('expected_grounded','unknown'),'i'),[]);
 assert.deepEqual(modelCheckpointsOf({partitions:{delivered:[{item:'i',requirements:[{requirement:'expected_grounded',claims:[claim('support',{model_criteria:[{quote:{text:'x'},rationale:5}]})]}]}]}},'i'),[]);
 // an absence check that also declares a model basis keeps the author's own words and is not listed
 const absent={model_expectations:[{index:0,op:'not_found',text:'record-a',quote:{reference:'src:'+'a'.repeat(64)+'/x',text:'删除后查询不再包含记录'},after:3,basis:'model_judgment',rationale:'配置过的名字'}]};
 assert.deepEqual(modelCheckpointsOf({partitions:{delivered:[{item:'i',requirements:[{requirement:'expected_grounded',claims:[claim('support',absent)]}]}]}},'i'),[]);
 assert.deepEqual(modelCheckpointsOf(null,'i'),[]);assert.deepEqual(modelCheckpointsOf({partitions:[]},'i'),[]);
 // a count states how often the text has to appear
 const counted=modelCheckpointsOf({partitions:{delivered:[{item:'i',requirements:[{requirement:'expected_grounded',claims:[claim('support',{model_criteria:[{quote:{text:'记录出现两次'},literal:'row',count:2,rationale:'次数检查点'}]})]}]}]}},'i');
 assert.deepEqual(counted,[{expectation:'记录出现两次',literal:'row',count:2,rationale:'次数检查点'}]);
});

test('a delivered case with a model-written checkpoint says so: drafted by the model, not reviewed, and a device result only says whether it was hit',()=>{
 const checkpoints={a:modelCheckpointsOf(recordedResult('item-1'),'item-1')};
 const plain=caseConclusion(input(),delivered),text=caseConclusion(input({checkpoints}),delivered);
 assert.ok(text.startsWith(plain),'the sentence after the usual conclusion, which stays as it was');
 for(const word of ['1 项期望在原始用例中没有给出具体取值','检查点由模型拟定','未经独立复核','只说明这些检查点是否命中'])assert.ok(text.includes(word),word+' / '+text);
 assert.doesNotMatch(text.slice(plain.length),/已确认|已复核|通过|满足/);
 const report=deliveryReport(input({checkpoints}));
 assert.match(report,/模型拟定的检查点：原始用例的这些期望没有给出具体取值，检查点由模型拟定，是模型的判断，未经独立复核；上机验证的结果只说明这些检查点是否命中，不说明期望已被确认。/);
 assert.ok(report.includes(`- 期望「${SENTENCE}」：检查点「${LITERAL}」。模型的理由：${RATIONALE}`),report);
 // a case without such a checkpoint is reported exactly as before
 assert.equal(deliveryReport(input({checkpoints:{}})),deliveryReport(input()));assert.doesNotMatch(deliveryReport(input()),/模型拟定/);
});

test('the closing reply carries the sentence beside the case it belongs to',()=>{
 const checkpoints={a:modelCheckpointsOf(recordedResult('item-1'),'item-1')};
 const reply=replyText('/out',{cases:1},['case.xlsx'],[delivered],input({checkpoints}));
 assert.ok(reply.includes('检查点由模型拟定')&&reply.includes('未经独立复核'),reply);
 assert.ok(!replyText('/out',{cases:1},['case.xlsx'],[delivered],input()).includes('模型拟定'));
});

test('a case that failed on the bed lists its model-written checkpoints too, so the error is not read as the device\'s',()=>{
 const failed:CaseOutcome={autoid:'a',status:'failed',history:[{ordinal:1,run:'first',job:'first',terminal:'fail'}]};
 const checkpoints={a:modelCheckpointsOf(recordedResult('item-1'),'item-1')};
 const shared=input({assembly:{cases:[failed],totals:{cases:1},pass:null,unsuccessful:{items:['a'],sources:{a:{plan_run:'run_'+'a'.repeat(26),run:'first'}}}} as never,notes:{cases:{a:{judged:'合成说明',remedy:'合成下一步'}}},files:{pass:null,unsuccessful:{sha256:'b'.repeat(64)}},checkpoints});
 for(const text of [deliveryReport(shared),unsuccessfulReport(shared)]){
  assert.ok(text.includes('检查点由模型拟定'),text);assert.ok(text.includes(`检查点「${LITERAL}」`),text);assert.ok(text.includes('未经独立复核'));
 }
});

import assert from 'node:assert/strict';
import {test} from 'node:test';
import {expectedQuality} from './expected-quality.ts';
const H='a'.repeat(64),base=`src:${H}/kityminder@1/`,leaf=base+'n/e';
const input=(vague:boolean,text='操作成功')=>({subject:{item:'d:c',location:base+'n/c',fields:{expected:[text],expectedCount:1,expectedSelectors:['n/e']},slots:{expected_quality:[{code:'expected_quality',text:'脚本化模型的判断',quotes:[{reference:leaf,text}],data:{schema:'expected-quality@1',vague,source_sha256:H,expected_count:1,expected_references:[leaf]}}]}},sources:{[leaf]:text}});
test('semantic judgment can disagree with the retired word list in both directions',()=>{assert.equal(expectedQuality(input(false))[0].verdict,'support');assert.equal(expectedQuality(input(true,'该数值应符合业务要求'))[0].verdict,'support');});
test('quotes must exactly cover original expected leaves belonging to this case',()=>{for(const mutate of [(v:any)=>{v.subject.slots.expected_quality[0].quotes[0].text='操 作成功';},(v:any)=>{v.subject.slots.expected_quality[0].quotes[0].reference=base+'n/sibling';},(v:any)=>{v.subject.fields.expectedCount=2;},(v:any)=>{v.subject.slots.expected_quality[0].data.source_sha256='b'.repeat(64);},(v:any)=>{v.subject.slots.expected_quality[0].data.source_sha256='invalid-digest';}]){const v=input(true);mutate(v);assert.notEqual(expectedQuality(v)[0].verdict,'support');}});

test('an explicitly empty optional judgment stays unknown with a repair exit, including on reuse',()=>{const value=input(false);value.subject.slots.expected_quality=[];const [outcome]=expectedQuality(value);assert.equal(outcome.verdict,'unknown');assert.equal(outcome.reason,'missing_input');assert.match(outcome.missing??'',/expected_quality.*逐字引文/);assert.equal(outcome.code,undefined);});

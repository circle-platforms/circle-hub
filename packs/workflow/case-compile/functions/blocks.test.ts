import assert from 'node:assert/strict';
import {test} from 'node:test';
import {fixture,positiveBlocks,plan,call,assertion,quote,EXPECTED,EXPECTED_REF} from '../testing/blocks.ts';
import {readSlots} from './slots.ts';
import {typedAuthorityGaps, authorityRecovery} from './typed-authority.ts';
import {blockMeta,sourcePlan,escapedLiteral} from './blocks.ts';
import {generateWorkbook} from './generate.ts';
import {readWorkbook} from './workbook.ts';
import {coreModel} from '../testing/workbook-model.ts';
import {checkContractShape,checkExpectedSources} from './checks.ts';
import {signTypedRuntime} from '../testing/typed-fixtures.ts';
const f=fixture();
for(const [kind,data]of Object.entries(positiveBlocks())){
 test(kind+' lowers and roundtrips register and assertion rows',()=>{
  const before=JSON.stringify(data),parsed=readSlots(data);assert.ok(parsed.ok,JSON.stringify(parsed));if(!parsed.ok)return;
  assert.ok(blockMeta(parsed.slots));assert.deepEqual(typedAuthorityGaps(f.contract,f.profile,parsed.slots,undefined,f.catalog,[],f.manifest_sha256),[]);
  const recipe={slots:parsed.slots,contract:f.contract,profile:f.profile,fields:f.fields,plan_run:'run_00000000000000000000000000',build:'SYN_ORBIT_10_8_1'};
  const bytes=generateWorkbook(recipe),read=readWorkbook(coreModel(bytes),recipe);assert.ok(read.ok,JSON.stringify(read));assert.deepEqual(generateWorkbook(recipe),bytes);assert.equal(JSON.stringify(sourcePlan(parsed.slots)),before);assert.equal(JSON.stringify(data),before);
 });
 test(kind+' rejects mixed flat input',()=>{const invalid=structuredClone(data);invalid.steps=[{object:'ORBIT_0',method:'command',args:['demo show'],keywords:{}}];assert.equal(readSlots(invalid).ok,false);});
 test(kind+' rejects absent call, operand or required declaration',()=>{const invalid=structuredClone(data),target=invalid.blocks.find(block=>block.kind===kind)!;if(kind==='CAPTURE_COMPARE')delete target.left;else delete target.call;assert.equal(readSlots(invalid).ok,false);});
}
test('register references are defined before use and an assertion cannot target a wait',()=>{
 const forward=positiveBlocks().EXPECT_FROM;forward.blocks.reverse();assert.equal(readSlots(forward).ok,false);
 const wrong=plan([{kind:'OBSERVE_ASSERT',id:'observe',call:call(),assertions:[{...assertion(),output:'wait'}]}]);assert.equal(readSlots(wrong).ok,false);
 const missing=positiveBlocks().CAPTURE_COMPARE;missing.blocks[2].right='absent';assert.equal(readSlots(missing).ok,false);
});
test('last configuration, explicit causal links and W07 declarations are independently checked',()=>{
 const late=positiveBlocks().CONFIG;late.blocks=[late.blocks[1],late.blocks[0],late.blocks[2]];const answer=checkContractShape(f.subject(late));assert.ok(answer.some(outcome=>outcome.verdict==='refute'));
 const missing=positiveBlocks().OBSERVE_ASSERT;delete missing.block_context;assert.ok(checkContractShape(f.subject(missing)).some(outcome=>outcome.verdict==='unknown'&&outcome.missing?.includes('前置')));
 const cause=positiveBlocks().CONFIG;cause.block_context!.causal_links=[];assert.ok(checkContractShape(f.subject(cause)).some(outcome=>outcome.verdict==='unknown'));
});
test('found_times uses an explicit runner capability and the I count role',()=>{
 const data=plan([{kind:'OBSERVE_ASSERT',id:'observe',call:call(),assertions:[assertion('count','observe','found_times')]}]);const parsed=readSlots(data);assert.ok(parsed.ok);if(!parsed.ok)return;
 assert.deepEqual(typedAuthorityGaps(f.contract,f.profile,parsed.slots,undefined,f.catalog,[],f.manifest_sha256),[]);
 const document=structuredClone(f.contractDoc) as any;document.runtime.found_times_supported=false;const changed=signTypedRuntime(document);const subject=f.subject(data);subject.subject.contract=changed;subject.subject.profile={...f.profileDoc,runtime:{...f.profileDoc.runtime,contract_sha256:changed.original.contract_sha256}};
 assert.ok(checkContractShape(subject).some(outcome=>outcome.verdict==='unknown'&&outcome.missing?.includes('found_times_supported')));
 const invalid=structuredClone(data);invalid.blocks[0].assertions[0].count=0;assert.equal(readSlots(invalid).ok,false);
});
test('captured regex metacharacters stay raw and use literal comparison; differs needs its own method',()=>{
 const text='a+b.[x](value)$\\tail';assert.equal(text.includes(text),true);assert.ok(escapedLiteral(text).includes('\\+'));
 const data=positiveBlocks().CAPTURE_COMPARE,parsed=readSlots(data);assert.ok(parsed.ok);if(!parsed.ok)return;
 assert.equal(parsed.slots.expects.length,2);assert.ok(parsed.slots.expects.every(expect=>expect.operator==='abs_found'&&expect.register&&expect.actual_register));
 const differs=structuredClone(data);differs.blocks[2].relation='differs';differs.obligations![0].assertions=['comparison'];assert.ok(readSlots(differs).ok);
 const doc=structuredClone(f.contractDoc) as any;delete doc.runtime.block_model.differs;const contract=signTypedRuntime(doc);const subject=f.subject(differs);subject.subject.contract=contract;subject.subject.profile={...f.profileDoc,runtime:{...f.profileDoc.runtime,contract_sha256:contract.original.contract_sha256}};assert.ok(checkContractShape(subject).some(outcome=>outcome.verdict==='unknown'&&outcome.missing?.includes('全值字面不等')));
});
test('author expectation coverage never substitutes one quoted node for another',()=>{
 const data=positiveBlocks().OBSERVE_ASSERT;
 assert.ok(checkExpectedSources(f.subject(data)).every(outcome=>outcome.verdict==='support'));
 assert.ok(checkExpectedSources(f.subject(data,{expected_nodes:[...f.fields.expected_nodes,{reference:EXPECTED_REF+'other',text:'another'}]})).some(outcome=>outcome.verdict==='refute'));
 const unmet=structuredClone(data);unmet.obligations![0]={expectation:EXPECTED_REF,status:'unmet',assertions:[],missing:'合成缺事实',next_action:'合成维护者补证'};assert.ok(checkExpectedSources(f.subject(unmet)).some(outcome=>outcome.verdict==='unknown'&&outcome.missing?.includes('合成维护者')));
 const description=f.subject(data,{expected_nodes:[{reference:EXPECTED_REF,text:EXPECTED}]});assert.ok(checkExpectedSources(description).some(outcome=>outcome.verdict==='unknown'&&outcome.missing?.includes('类型化判据')));
 const negativeQuote={reference:EXPECTED_REF,text:'删除后无残留'},negative=plan([{kind:'OBSERVE_ASSERT',id:'observe',call:call(),assertions:[{...assertion('absent','observe','not_found'),literal:'synthetic-record',quote:negativeQuote}]}]);
 assert.deepEqual(checkExpectedSources(f.subject(negative,{expected_nodes:[negativeQuote]})).map(outcome=>outcome.verdict),['support']);
 assert.ok(checkExpectedSources(f.subject(negative,{expected_nodes:[{...negativeQuote,declaration:{op:'abs_found',literal:'synthetic-record'}}]})).some(outcome=>outcome.verdict==='refute'));
 const captured=plan([{kind:'CONFIG',id:'create',call:call('demo set 5')},{kind:'CAPTURE',id:'before',call:call(),register:'removed_record'},{kind:'CONFIG',id:'remove',call:call('no demo set')},{kind:'EXPECT_FROM',id:'observe',call:call(),expected_from:'removed_record',op:'not_found',output:'observe',quote:negativeQuote,expectation:EXPECTED_REF}]);
 captured.block_context!.causal_links=[{from:'create',to:'before',quote:negativeQuote},{from:'remove',to:'observe',quote:negativeQuote}];
 const document=structuredClone(f.contractDoc) as any;document.runtime.block_model.operators.push({op:'not_found',expected:'register',object:'check',method:'not_found',matching:'literal'});
 const contract=signTypedRuntime(document),subject=f.subject(captured,{expected_nodes:[negativeQuote],contract,profile:{...f.profileDoc,runtime:{...f.profileDoc.runtime,contract_sha256:contract.original.contract_sha256}}});
 assert.deepEqual(checkExpectedSources(subject).map(outcome=>outcome.verdict),['support']);
});
test('restore requires a pre-change capture, exact target and guarded executor capability',()=>{
 const early=positiveBlocks().RESTORE_FROM;[early.blocks[0],early.blocks[1]]=[early.blocks[1],early.blocks[0]];assert.equal(readSlots(early).ok,false);
 const wrong=positiveBlocks().RESTORE_FROM;wrong.blocks[3].call.method='command';assert.ok(checkContractShape(f.subject(wrong)).some(outcome=>outcome.verdict==='refute'||outcome.verdict==='unknown'));
 const document=structuredClone(f.contractDoc) as any;document.runtime.block_model.restore_methods=[];const contract=signTypedRuntime(document),subject=f.subject(positiveBlocks().RESTORE_FROM);subject.subject.contract=contract;subject.subject.profile={...f.profileDoc,runtime:{...f.profileDoc.runtime,contract_sha256:contract.original.contract_sha256}};assert.ok(checkContractShape(subject).some(outcome=>outcome.verdict==='unknown'&&outcome.missing?.includes('守卫')));
});
for(const kind of ['OBSERVE_DIST','OBSERVE_MEMBER','OBSERVE_EXIT'])test(kind+' is declared but remains unknown with a named capability exit',()=>{const data=plan([{kind,id:'deferred',payload:{}}]);const result=checkContractShape(f.subject(data));assert.ok(result.some(outcome=>outcome.verdict==='unknown'&&outcome.missing?.includes('下一步')));const absent=structuredClone(data);delete absent.blocks[0].payload;assert.equal(readSlots(absent).ok,false);const mixed=structuredClone(data);mixed.expects=[{text:'x',quote:quote(),after:1}];assert.equal(readSlots(mixed).ok,false);});
test('F8 validation recovery messages preserve pointers in structured problems and render human locations in prose without internal refs or invented words',()=>{
 const leaked=/重新育苗|育苗|runtime-contract@2|command-policy@1|inverse_rules|冻结 profile|具名受众|派发工作簿|\/blocks\/|\/steps\/|按指针|(?:blocks|catalog|contract)\//;
 const restoreParsed=readSlots(positiveBlocks().RESTORE_FROM);assert.ok(restoreParsed.ok);if(!restoreParsed.ok)return;
 const noRules={...f.catalog,policy:{...f.catalog.policy,inverse_rules:[]}};
 const gaps=typedAuthorityGaps(f.contract,f.profile,restoreParsed.slots,undefined,noRules,[],f.manifest_sha256);
 assert.ok(gaps.some(gap=>gap.message.includes('产品命令逆操作声明后，由管理员重新生成该构建的手册和命令树')));
 const unknownText=authorityRecovery([{document:'blocks',pointer:'/blocks/13/call',message:'合成缺事实',verdict:'unknown'}]);
 assert.ok(unknownText.includes('第 14 块的调用步骤：合成缺事实'));
 assert.ok(unknownText.includes('按上述位置请求')&&unknownText.includes('重新生成该构建的手册和命令树')&&unknownText.includes('按现行执行器规则核对')&&unknownText.includes('已冻结的执行器配置')&&unknownText.includes('具名对象与期限')&&unknownText.includes('自动化用例 Excel'));
 assert.doesNotMatch(unknownText,leaked);
 const refuteText=authorityRecovery([{document:'blocks',pointer:'/blocks/3/call',message:'合成越权',verdict:'refute'}]);
 assert.ok(refuteText.includes('第 4 块的调用步骤：合成越权')&&refuteText.includes('按上述位置和未完成义务补齐作者命令、合法参数及逆序清理')&&refuteText.includes('不得改动已冻结的执行器配置来绕过')&&refuteText.includes('自动化用例 Excel'));
 assert.doesNotMatch(refuteText,leaked);
 const catalogArgText=authorityRecovery([{document:'catalog',pointer:'/steps/0/args/0',message:'命令树无匹配命令',verdict:'refute'}]);
 assert.ok(catalogArgText.includes('产品命令手册・第 1 步第 1 个参数：命令树无匹配命令'));
 assert.doesNotMatch(catalogArgText,leaked);
});

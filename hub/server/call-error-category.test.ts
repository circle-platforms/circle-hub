import assert from 'node:assert/strict';
import test from 'node:test';
import { PROTOCOL_CODES, CALL_ERROR_CATEGORY_BY_CODE } from '../../contracts/generated/protocol.ts';
import { labelOf } from '../../contracts/generated/vocabulary.ts';
import { StartRunOutput, GetNodesOutput, SubmitResultOutput } from '../../contracts/src/tools.ts';
import { COMMAND_METADATA } from './command-registry.ts';
import { CALL_ERROR_CATEGORIES, callErrorCategory, callErrorFact, callErrorNext, renderCallError, notPermittedKindOf } from './call-error-category.ts';
import { circleHubNamesIn, fixByRole } from './fix-by-role.ts';
import { toolText } from './text.ts';
import { callErrorCategoryOf, errorPresentationOf } from './error-reasons.ts';
const TRACE='a'.repeat(32);
function assertCommandsRegistered(text:string):void {for(const name of circleHubNamesIn(text))assert.ok(COMMAND_METADATA.some(c=>c.name===name),name);}

test('call categories are exactly the generated model mapping, including unclassified leases',()=>{
  for(const [code,category]of Object.entries(CALL_ERROR_CATEGORY_BY_CODE))assert.equal(callErrorCategory(code),category===null?null:labelOf('call_error_category',category));
  assert.equal(callErrorCategory('LEASE_UNAVAILABLE'),null);assert.equal(callErrorCategory('SOURCE_UNAVAILABLE'),null);
  assert.ok(CALL_ERROR_CATEGORIES.includes('已被占用'));
});
test('generated categories keep explicit protocol codes and no duplicate presentation table',()=>{
  assert.equal(callErrorCategoryOf('SHARE_DUPLICATE'),'已被占用');assert.equal(callErrorCategoryOf('SOURCE_PENDING_REVIEW'),'暂时不可用');assert.equal(callErrorCategoryOf('EFFECT_UNKNOWN_DISPOSED'),null);
});
test('package invocation scope must be explicit rather than guessed from a namespaced code',()=>{
  assert.deepEqual(errorPresentationOf('case-compile.workbook_context'),{kind:'conclusion'});
  assert.deepEqual(errorPresentationOf('case-compile.workbook_context',true),{kind:'category',category:'参数无效'});
  assert.equal(callErrorCategoryOf('core.structure.type_mismatch',true),null);
});
test('producer facts are preserved without deriving objects from prose',()=>{
  for(const message of ['当前账户未获授权使用工作流「recompose」','运行 run_synthetic 存在，你没有读取权限','无权限：正文含知识树根、分享读取权限和 resource assign；不能据这些词推对象'])assert.equal(callErrorFact('SOURCE_NOT_PERMITTED',message),message);
});
test('pack next steps use the exact path and never extract the pack name from the sentence',()=>{
  const message='当前账户未获授权使用工作流「synthetic-hidden-name」';
  const member=renderCallError({code:'SOURCE_NOT_PERMITTED',message,path:'/pack'},'user',undefined)!;
  assert.match(member,/请联系管理员/);assert.match(member,/list_task_packs/);
  const admin=renderCallError({code:'SOURCE_NOT_PERMITTED',message,path:'/pack'},'admin',undefined)!;
  assert.match(admin,/控制台「团队」页/);assert.doesNotMatch(admin,/pack assign .*synthetic-hidden-name/);assertCommandsRegistered(admin);
});
test('root and unknown object kinds are determined by structured paths only',()=>{
  const poison='知识树根 分享读取权限 resource assign';
  assert.equal(notPermittedKindOf(poison,poison),'unknown');assert.equal(notPermittedKindOf(poison,poison,'/root'),'root');
  assert.equal(notPermittedKindOf(poison,poison,'/reference'),'unknown');assert.equal(notPermittedKindOf(poison,poison,'/resource'),'system');
  const fix='原生产者给出的具体下一步';assert.equal(callErrorNext('SOURCE_NOT_PERMITTED','user',fix,poison),fix);
  assert.match(callErrorNext('SOURCE_NOT_PERMITTED','user',fix,poison,undefined,'/root'),/绑定这条产品线/);
  const system=callErrorNext('SOURCE_NOT_PERMITTED','admin',undefined,poison,undefined,'/resource');assert.match(system,/resource assign/);assertCommandsRegistered(system);
  assert.equal(callErrorNext('SOURCE_NOT_PERMITTED','admin',fix,poison,undefined,'/pack_id'),fix);
});
test('unclassified lease errors do not infer a holder, key or clock from text',()=>{
  const message='键 bed/合成环境/client0 上有未到期的占用（持有运行 run_synthetic，取得于 2026-11-14T05:00:00.000Z）';
  assert.equal(callErrorFact('LEASE_UNAVAILABLE',message),message);assert.equal(renderCallError({code:'LEASE_UNAVAILABLE',message},'user',undefined),null);
  const action=callErrorNext('LEASE_UNAVAILABLE','admin',undefined,message);assert.match(action,/未取得结构化租约键/);assert.doesNotMatch(action,/lease release bed\//);
});
test('integrity recovery actions cite registered commands and preserve the producer fact',()=>{
  const fix=fixByRole('SOURCE_INTEGRITY_UNPROVEN','admin')!;const text=renderCallError({code:'SOURCE_INTEGRITY_UNPROVEN',message:'缺少经摘要核验的知识原件'},'admin',fix)!;
  assert.match(text,/^暂时不可用：缺少经摘要核验的知识原件。/);assert.match(text,/circle-hub restore /);assertCommandsRegistered(text);
});
test('tool text keeps generated categories and neutral unavailable source behavior',()=>{
  const denied=toolText('start_run',StartRunOutput.parse({call_result:'error',errors:[{code:'SOURCE_NOT_PERMITTED',message:'synthetic fact',path:'/pack',fix:'source next'}],trace:TRACE}),{caller:{role:'user'}});
  assert.match(denied,/^无权限：synthetic fact。/);assert.match(denied,/list_task_packs/);
  const integrity=toolText('get_nodes',GetNodesOutput.parse({call_result:'error',errors:[{code:'SOURCE_INTEGRITY_UNPROVEN',message:'synthetic integrity'}],trace:TRACE}),{caller:{role:'admin'}});assert.match(integrity,/^暂时不可用：synthetic integrity。/);
  const unknown=toolText('start_run',StartRunOutput.parse({call_result:'error',errors:[{code:'SOURCE_UNAVAILABLE',message:'对你不可用'}],trace:TRACE}));assert.match(unknown,/状态未知；原因缺资料/);assert.doesNotMatch(unknown,/判断错误|^无权限：/m);
});
test('superseded runs retain the exact throw-site fact and declared recovery',()=>{
  const fact='运行 run_old 已被新修订 run_new 取代';assert.equal(callErrorFact('RUN_SUPERSEDED',fact),fact);
  assert.match(renderCallError({code:'RUN_SUPERSEDED',message:fact},'user',undefined)!,/^不存在：运行 run_old 已被新修订 run_new 取代。要修改已交的内容/);
});
test('abandoned runs remain unclassified as the model declares rather than receiving a guessed category',()=>{
  assert.equal(callErrorCategoryOf('RUN_ABANDONED'),null);assert.equal(renderCallError({code:'RUN_ABANDONED',message:PROTOCOL_CODES.RUN_ABANDONED.when},'user',PROTOCOL_CODES.RUN_ABANDONED.fix),null);
});
test('disposed effects remain qualified conclusions rather than call categories',()=>{
  assert.equal(callErrorCategoryOf('EFFECT_UNKNOWN_DISPOSED'),null);
  const text=toolText('submit_result',SubmitResultOutput.parse({call_result:'error',acceptance:'not_accepted',errors:[{code:'EFFECT_UNKNOWN_DISPOSED',message:PROTOCOL_CODES.EFFECT_UNKNOWN_DISPOSED.when,fix:PROTOCOL_CODES.EFFECT_UNKNOWN_DISPOSED.fix}],trace:TRACE}));
  assert.match(text,/效果原结局仍未证明，运行者已具名选择标记失败处置/);assert.match(text,/原效果结局与冻结\/解除许可仍按原记录，不把处置当作已证明未执行/);assert.doesNotMatch(text,/状态已确认|判断错误|^不存在：|^参数无效：|^无权限：/m);
});
test('explicit caller identity fills action placeholders without reading an identity out of prose',()=>{
  const text=callErrorNext('SUBMISSION_SCHEMA_VIOLATION','admin','请 <当前账户的名字> 核对这个参数','poison prose','合成成员');assert.match(text,/合成成员/);assert.doesNotMatch(text,/<当前账户的名字>/);assertCommandsRegistered(text);
});

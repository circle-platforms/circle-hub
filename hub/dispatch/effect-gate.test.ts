// What the gate's replay of policy checks says when a check reached no conclusion (decision 116): which check, and the cause its own
// unknown outcomes name, read from closed fields only; and that a refutation decides first, at both clauses. The refusal leaves out
// whether a request went out (the caller that records it says so, refusalText). No database: the replay port and the effect rows are
// the only live parts.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {AllowedEffect} from '../../contracts/src/pack.ts';
import type {CheckOutcome} from '../../contracts/src/tables.ts';
import type {EffectCheckReplay} from '../ports.ts';
import {prepareEffectGate,EffectBoundaryError} from './effect-gate.ts';
import {refusalText} from './boundary.ts';
import {definition} from './testing/definition.ts';
import {effectsDocument} from './testing/effects.ts';
const document=effectsDocument({target:'synthetic-bed',manifest_sha256:'a'.repeat(64),build:'synthetic-build',sha256:'b'.repeat(64),items:['synthetic-case'],generator:'synthetic-workflow@1.0.0'});
const detail={run:{run:'run_synthetic',pack_digest:'c'.repeat(64),started_at:'2026-10-23T00:00:00.000Z'},latest:{result:{cross_item:[],partitions:{},submission:'d'.repeat(64),acceptance:'accepted'},record:'e'.repeat(64)}};
const gate=(recheck:EffectCheckReplay|undefined)=>prepareEffectGate({records:{} as never,runs:{getRun:async()=>detail} as never,workflows:{byDigest:async()=>({readJson:async()=>document})} as never,recheck,by:{} as never,run:detail.run.run,executor:'synthetic-executor',definition:definition('http://192.0.2.1') as never,resolved_digest:'f'.repeat(64),now:()=>new Date('2026-10-23T00:00:01.000Z')});
const row=(over:Partial<AllowedEffect>):AllowedEffect=>({...document.effects[0],...over}) as AllowedEffect;
const parameterRow=row({parameters:{policy:'policies/synthetic.json',check:'first'},policy_checks:['first']});
const support:CheckOutcome={verdict:'support',statement:'合成通过',grounds:[],tier:'blocking'};
const refute:CheckOutcome={verdict:'refute',code:'synthetic.denied',statement:'合成拒绝',grounds:[],tier:'blocking'};
const unknown=(extra:Partial<CheckOutcome>):CheckOutcome=>({verdict:'unknown',reason:'check_error',missing:'M',statement:'合成未知',grounds:[],tier:'blocking',...extra});
const refusal=async(attempt:Promise<unknown>)=>{try{await attempt;}catch(error){assert.ok(error instanceof EffectBoundaryError,String(error));return error.failure;}assert.fail('the gate must refuse');};

test('the policy rerun names the first check without a conclusion, with its reason and missing fact',async()=>{
 const g=await gate(async()=>({first:[support],second:[unknown({reason:'missing_input',missing:'M2'})],third:[unknown({reason:'timeout',missing:'M3'})]}));
 const failure=await refusal(g.context.policies(row({policy_checks:['first','second','third']})));
 assert.equal(failure.clause,7);assert.equal(failure.code,'PACK_POLICY_DENIED');assert.equal(failure.row,document.effects[0].id);assert.deepEqual(failure.requirements,document.effects[0].release.requirements);
 assert.match(failure.message,/^政策检查 second 没有给出政策结论：1\/1 条结果是未知（缺输入），缺 M2；/);assert.doesNotMatch(failure.message,/third|M3/);
 // The gate's refusal does not claim what became of the request: this boundary also runs before a resend. The caller that records it does.
 assert.match(failure.message,/不是计划、工作簿或包被驳回$/);assert.doesNotMatch(failure.message,/什么都没发出|提交已调用/);assert.equal(failure.no_conclusion,true);
 assert.match(refusalText(failure,false),/不是计划、工作簿或包被驳回；什么都没发出$/);
 assert.match(refusalText(failure,true),/不是计划、工作簿或包被驳回；提交已调用，原请求是否执行须对账$/);assert.doesNotMatch(refusalText(failure,true),/什么都没发出/);
});
test('a refutation of any policy check is a refusal of the policy, whatever else has no conclusion',async()=>{
 const g=await gate(async()=>({first:[unknown({})],second:[support,refute]}));
 assert.equal(await g.context.policies(row({policy_checks:['first','second']})),false);
});
test('a refutation decides the parameter gate as it decides the policy rerun, whatever else has no conclusion',async()=>{
 const sandbox=unknown({data:{sandbox:'SANDBOX_UNAVAILABLE'}});
 for(const outcomes of [[refute,sandbox],[sandbox,refute],[support,refute,unknown({})],[refute]]){
  const g=await gate(async()=>({first:outcomes}));
  const verdicts=outcomes.map(outcome=>outcome.verdict).join();
  assert.equal(await g.context.parameterPolicy(parameterRow),false,'clause 2: '+verdicts);assert.equal(await g.context.policies(row({policy_checks:['first']})),false,'clause 7: '+verdicts);
 }
 // With no refutation an unknown outcome is no conclusion at both clauses, each under its own number.
 for(const outcomes of [[support,sandbox],[sandbox],[unknown({})],[]]){
  const g=await gate(async()=>({first:outcomes}));
  const parameter=await refusal(g.context.parameterPolicy(parameterRow)),policy=await refusal(g.context.policies(row({policy_checks:['first']})));
  assert.deepEqual([parameter.clause,parameter.no_conclusion,policy.clause,policy.no_conclusion],[2,true,7,true],outcomes.map(outcome=>outcome.verdict).join());
 }
});
test('the refusal counts every unknown outcome of the check and reads its cause from the first of them',async()=>{
 const needsInput=unknown({reason:'missing_input',missing:'A'}),slow=unknown({reason:'timeout',missing:'B'}),sandbox=unknown({missing:'S',data:{sandbox:'SANDBOX_UNAVAILABLE'}});
 const cases:Array<[string,CheckOutcome[],RegExp[],RegExp[]]>=[
  ['a later sandbox failure does not make the first cause the sandbox\'s',[needsInput,support,sandbox],[/没有给出(参数范围|政策)结论：2\/3 条结果是未知（缺输入），缺 A；/],[/沙箱没能运行|缺 S|缺 B/]],
  ['the first of two unknown outcomes is read, not the last',[needsInput,slow],[/没有给出(参数范围|政策)结论：2\/2 条结果是未知（缺输入），缺 A；/],[/超时|缺 B/]],
  ['a first sandbox failure is the sandbox\'s, whatever follows it',[sandbox,needsInput],[/没有运行完：Hub 的沙箱没能运行它（2\/2 条结果是未知），未取得(参数范围|政策)结论；/],[/缺输入|缺 A/]],
  ['supported outcomes are counted in the total but not as unknown',[support,slow,needsInput],[/没有给出(参数范围|政策)结论：2\/3 条结果是未知（超时），缺 B；/],[/缺输入|缺 A/]],
 ];
 for(const [name,outcomes,present,absent] of cases){
  const g=await gate(async()=>({first:outcomes}));
  for(const failure of [await refusal(g.context.parameterPolicy(parameterRow)),await refusal(g.context.policies(row({policy_checks:['first']})))]){
   for(const pattern of present)assert.match(failure.message,pattern,name);
   for(const pattern of absent)assert.doesNotMatch(failure.message,pattern,name);
  }
 }
});
test('every policy check supporting is a pass, and a check absent from the replay is one without a conclusion',async()=>{
 const g=await gate(async({checks})=>Object.fromEntries(checks.filter(id=>id!=='gone').map(id=>[id,[support,support]])));
 assert.equal(await g.context.policies(row({policy_checks:['first','second']})),true);
 const failure=await refusal(g.context.policies(row({policy_checks:['first','gone']})));
 assert.match(failure.message,/^政策检查 gone 没有给出任何结果，未取得政策结论；/);
});
test('only a sandbox that could not run the check reads as the sandbox\'s failure: the closed code, nothing else',async()=>{
 const sandbox=(code:unknown,extra:Partial<CheckOutcome>={})=>gate(async()=>({first:[unknown({data:{sandbox:code},...extra})]}));
 const unavailable=await refusal((await sandbox('SANDBOX_UNAVAILABLE')).context.parameterPolicy(parameterRow));
 assert.equal(unavailable.clause,2);assert.match(unavailable.message,/^参数政策检查 first 没有运行完：Hub 的沙箱没能运行它（1\/1 条结果是未知），未取得参数范围结论；/);assert.doesNotMatch(unavailable.message,/缺 M|冻结来源/);assert.match(unavailable.fix,/^原样重核同一参数对象；/);
 for(const code of ['SANDBOX_TIMEOUT','FUNCTION_THREW','sandbox unavailable',['SANDBOX_UNAVAILABLE'],7]){
  const other=await refusal((await sandbox(code,{reason:'timeout'})).context.parameterPolicy(parameterRow));
  assert.match(other.message,/^参数政策检查 first 没有给出参数范围结论：1\/1 条结果是未知（超时），缺 M；/,String(code));assert.doesNotMatch(other.message,/沙箱没能运行/);assert.match(other.fix,/^补上“缺”的内容后重核同一参数对象；/);
 }
});
test('the parameter gate and the policy rerun refuse with their own clause and the same code, for a result that is not a list too',async()=>{
 for(const outcomes of [undefined,[],'not a list' as unknown as CheckOutcome[]]){
  const g=await gate(async()=>({first:outcomes as CheckOutcome[]}));
  const parameter=await refusal(g.context.parameterPolicy(parameterRow)),policy=await refusal(g.context.policies(row({policy_checks:['first']})));
  assert.deepEqual([parameter.clause,parameter.code,policy.clause,policy.code],[2,'PACK_POLICY_DENIED',7,'PACK_POLICY_DENIED']);
  assert.match(parameter.message,/^参数政策检查 first 没有给出任何结果，未取得参数范围结论；/);assert.match(policy.message,/^政策检查 first 没有给出任何结果，未取得政策结论；/);
  assert.match(parameter.fix,/核对冻结包里该检查的声明和输出/);
 }
});
test('an unknown outcome that names no reason or missing fact is worded without printing an absent value',async()=>{
 const bare={verdict:'unknown',statement:'合成未知',grounds:[],tier:'blocking'} as CheckOutcome;
 const g=await gate(async()=>({first:[bare]}));
 const failure=await refusal(g.context.parameterPolicy(parameterRow));
 assert.match(failure.message,/^参数政策检查 first 没有给出参数范围结论：1\/1 条结果是未知，缺 合成未知；/);assert.doesNotMatch(failure.message,/undefined/);
});
test('without the replay port the gate still says the interface is missing, not that a check had no conclusion',async()=>{
 const g=await gate(undefined);
 const failure=await refusal(g.context.parameterPolicy(parameterRow));
 assert.equal(failure.clause,2);assert.match(failure.message,/缺少冻结提交重核接口/);assert.equal(failure.no_conclusion,undefined);
});

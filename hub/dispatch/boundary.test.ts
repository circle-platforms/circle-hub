import assert from 'node:assert/strict';
import {test} from 'node:test';
import {checkEffectBoundary,deny,EffectBoundaryError,refusalText,unconcluded,type BoundaryContext} from './boundary.ts';
import type {AllowedEffect} from '../../contracts/src/pack.ts';
import type {VerifiedInput} from './proof.ts';
const row={id:'checked',resource_kind:'executor',action:'submit',effect_class:'job',trigger:'hub_template',parameters:{policy:'policies/synthetic.json',check:'checked'},release:{requirements:['verified'],artifact:'verified'},budget:{count:1,duration_ms:1000},deadline_ms:10000,optional:false,policy_checks:['checked']} as AllowedEffect;
function context(stop?:number){const order:number[]=[];const check=(n:number)=>{order.push(n);return stop!==n;};const ctx:BoundaryContext={effects:stop===1?[]:[row],write:{effect_class:'job',retry_safety:'unsafe',signing:'service_on_behalf'},trigger:'hub_template',parameters:{target:'synthetic'},started_at:'2026-10-24T00:00:00.000Z',now:()=>new Date('2026-10-24T00:00:01.000Z'),duration_ms:1000,parameterPolicy:async()=>check(2),release:async()=>{if(!check(3))throw new Error('synthetic release');return {} as VerifiedInput;},budget:async()=>({count:check(4)?0:1,duration_ms:0}),lease:async()=>({ok:check(5),code:'FENCING_STALE'}),global:async()=>check(6)||'policy',policies:async()=>check(7),content:async()=>check(8),audience:async()=>check(9)};return {ctx,order};}
for(let clause=1;clause<=9;clause++)test(`clause ${clause} refuses without running later checks or invoking a submit`,async()=>{const {ctx,order}=context(clause);let submissions=0;const result=await checkEffectBoundary(ctx);if(result.ok)submissions++;assert.equal(submissions,0);assert.ok(!result.ok && result.clause===clause,JSON.stringify(result));assert.deepEqual(order,Array.from({length:Math.max(0,clause-1)},(_,i)=>i+2));});
test('all boundaries pass once and own-credential signing requires the real runner trigger',async()=>{const {ctx,order}=context();assert.equal((await checkEffectBoundary(ctx)).ok,true);assert.deepEqual(order,[2,3,4,5,6,7,8,9]);ctx.write.signing='own_credential';assert.equal((await checkEffectBoundary(ctx)).ok,false);ctx.trigger='runner_session';ctx.effects=[{...row,trigger:'runner_session'}];assert.equal((await checkEffectBoundary(ctx)).ok,true);});
test('parameter sets are closed and overlapping effect rows cannot widen a budget',async()=>{const {ctx}=context();ctx.effects=[{...row,parameters:{values:{target:['synthetic']}}}];assert.equal((await checkEffectBoundary(ctx)).ok,true);ctx.parameters.extra=true;const extra=await checkEffectBoundary(ctx);assert.ok(!extra.ok && extra.clause===2);delete ctx.parameters.extra;ctx.effects=[...ctx.effects,{...ctx.effects[0],id:'other'}];const ambiguous=await checkEffectBoundary(ctx);assert.ok(!ambiguous.ok && ambiguous.clause===2);});
test('a failed parameter policy is not evidence of an out-of-range parameter',async()=>{
 const {ctx}=context();ctx.parameterPolicy=async()=>{throw new Error('SyntheticPrivatePolicyDetail84');};
 const result=await checkEffectBoundary(ctx);assert.ok(!result.ok);assert.equal(result.code,'PACK_POLICY_DENIED');assert.equal(result.row,row.id);assert.deepEqual(result.requirements,row.release.requirements);assert.match(result.message,/参数政策.*checked.*未取得.*范围结论/);assert.ok(!result.message.includes('SyntheticPrivatePolicyDetail84'));
});
test('one matching row cannot hide another unevaluated parameter policy',async()=>{
 const {ctx}=context();ctx.effects=[{...row,id:'unevaluated'},{...row,id:'matched'}];ctx.parameterPolicy=async candidate=>{if(candidate.id==='unevaluated')throw new Error('synthetic unavailable');return true;};
 const result=await checkEffectBoundary(ctx);assert.ok(!result.ok);assert.equal(result.code,'PACK_POLICY_DENIED');assert.equal(result.row,'unevaluated');
});
test('a unique rejected effect row is named at the action and parameter gates',async()=>{
 const {ctx}=context();ctx.write.signing='own_credential';const denied=await checkEffectBoundary(ctx);assert.ok(!denied.ok);assert.equal(denied.row,row.id);assert.deepEqual(denied.requirements,row.release.requirements);
 ctx.write.signing='service_on_behalf';ctx.parameterPolicy=async()=>false;const outside=await checkEffectBoundary(ctx);assert.ok(!outside.ok);assert.equal(outside.code,'EFFECT_PARAMETER_OUT_OF_RANGE');assert.equal(outside.row,row.id);
});
test('a policy recheck that reached no conclusion is not reported as a refusal of the plan or the pack (decision 116)',async()=>{
 const {ctx}=context();ctx.policies=async()=>'unknown';
 const result=await checkEffectBoundary(ctx);assert.ok(!result.ok);assert.equal(result.code,'PACK_POLICY_DENIED');
 assert.match(result.message,/有检查没出结论/);assert.match(result.message,/不是计划、工作簿或包被驳回/);assert.doesNotMatch(result.message,/请修正/);
 assert.equal(result.clause,7);assert.equal(result.no_conclusion,true);assert.doesNotMatch(result.message,/什么都没发出|原样重交/);assert.doesNotMatch(result.fix,/修正输入|原样重交/);
 assert.match(refusalText(result,false),/不是计划、工作簿或包被驳回；什么都没发出$/);assert.doesNotMatch(refusalText(result,true),/什么都没发出/);
 ctx.policies=async()=>false;const refused=await checkEffectBoundary(ctx);assert.ok(!refused.ok);assert.match(refused.message,/重核未通过；请修正后重核/);assert.equal(refused.no_conclusion,undefined);
});
test('a refusal without a conclusion says what became of the request only as its caller knows it: nothing before a send, the invoked submit before a resend',()=>{
 const none=unconcluded(7,'政策检查 synthetic 没有给出政策结论','synthetic fix',row);
 assert.equal(none.clause,7);assert.equal(none.code,'PACK_POLICY_DENIED');assert.equal(none.fix,'synthetic fix');assert.equal(none.row,row.id);assert.deepEqual(none.requirements,row.release.requirements);assert.equal(none.no_conclusion,true);
 assert.equal(none.message,'政策检查 synthetic 没有给出政策结论；不是计划、工作簿或包被驳回');
 assert.equal(refusalText(none,false),`${none.message}；什么都没发出`);
 assert.equal(refusalText(none,true),`${none.message}；提交已调用，原请求是否执行须对账`);
 const ordinary=deny(7,'PACK_POLICY_DENIED','synthetic refusal',row);
 assert.equal(refusalText(ordinary,false),'synthetic refusal');assert.equal(refusalText(ordinary,true),'synthetic refusal');
});
test('a policy recheck that throws a boundary refusal is returned as it is; any other exception stays private',async()=>{
 const {ctx}=context();ctx.policies=async()=>{throw new EffectBoundaryError({...deny(7,'PACK_POLICY_DENIED','synthetic cause',row),fix:'synthetic fix'});};
 const named=await checkEffectBoundary(ctx);assert.ok(!named.ok);assert.equal(named.clause,7);assert.equal(named.code,'PACK_POLICY_DENIED');assert.equal(named.message,'synthetic cause');assert.equal(named.fix,'synthetic fix');assert.equal(named.row,row.id);assert.deepEqual(named.requirements,row.release.requirements);
 ctx.policies=async()=>{throw new Error('SyntheticPrivatePolicyDetail84');};
 const other=await checkEffectBoundary(ctx);assert.ok(!other.ok);assert.equal(other.clause,7);assert.equal(other.code,'PACK_POLICY_DENIED');assert.match(other.message,/政策重核没有完整结论/);assert.ok(!other.message.includes('SyntheticPrivatePolicyDetail84'));
});
